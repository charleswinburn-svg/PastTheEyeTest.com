#!/usr/bin/env python3
"""
build_projections.py — PastTheEyeTest 2027 projected hitter cards.

For every stat on the hitter card this script LEARNS, from your own history:
  • how much weight each prior season gets   (w1 = 1 for last season, w2..wJ fitted,
                                               never increasing with age)
  • how hard to pull toward league average    (k, in that stat's own sample units)
  • an aging curve                            (quadratic in age, fitted jointly so the
                                               year weights don't soak up aging)

  projection_rel = Σ_j w_j·n_j·(x_j − lg_j) / (Σ_j w_j·n_j + k)  +  a1·(age−28) + a2·(age−28)²
  projection     = lg_last + projection_rel

Then, only where a backtest says it helps, it layers on:
  • iSwing+        (contact-quality stats) — a learned-weight projection of lean,
                   walk-forward iSwing+, stacked onto the base projection
  • swing residual (xwOBACON only) — xwOBAcon is split into "what the swing predicts"
                   + "how much he beats/trails his swing"; each part gets its own
                   weights and shrinkage, so a hitter who consistently outperforms his
                   iSwing+ keeps (a regressed version of) that edge.

Every choice is validated two ways and printed:
  • walk-forward: project season T using only data from before T
  • leave-one-season-out (LOSO) for the iSwing+/residual layers, which only have 2024+

xRV/600 components are reconciled so each breakdown sums to the projected total,
exactly like the actual cards. Percentiles rank each projection against 2026 ACTUAL
qualified hitters, so a 95 means the same thing on both cards.

INPUTS
  history/hitter_history.csv     from backfill_history.py (2015–2026). If missing, the
                                 script falls back to public/baseball_data_{yr}.json +
                                 public/hitter_xrv_{yr}.json (2023–2026, PA-only samples).
  history/iswing_history.csv     from build_iswing_history.py (optional; enables layers)
  history/birthdates.json        {player_id: "YYYY-MM-DD"} (optional; enables aging)

OUTPUTS (public/)
  baseball_data_2027P.json       same shape as baseball_data_2026.json (+ "last" per stat)
  hitter_xrv_2027P.json          same shape as hitter_xrv_2026.json
  projection_report.json / .csv  fitted weights, k, age curve, layer choice, backtests

USAGE
  python3 build_projections.py
  python3 build_projections.py --public ./public --history ./history --target 2027
"""

import argparse
import json
import re
import os
import time
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import least_squares, nnls

warnings.filterwarnings("ignore")

# ═══════════════════════════════════════════════════════════════════════════
# STAT DEFINITIONS  (labels match the card exactly)
# denom: preferred sample-size column(s), first available wins; 'pa' is the fallback
# ═══════════════════════════════════════════════════════════════════════════
CARD_STATS = [
    # label                 fmt     lower_better  pct_decimal  denom prefs          family
    ("xSLG",               ".3f",  False, False, ["pa"],                 "contact"),
    ("xwOBACON",           ".3f",  False, False, ["bip", "pa"],          "contact"),
    ("Avg Exit Velocity",  ".1f",  False, False, ["bip", "pa"],          "contact"),
    ("90th % EV",          ".1f",  False, False, ["bip", "pa"],          "contact"),
    ("Barrel %",           ".1f",  False, False, ["bip", "pa"],          "contact"),
    ("Blasts/Contact",     ".1f",  False, True,  ["swings", "pa"],       "contact"),
    ("LA+SwtSpt%",         ".1f",  False, False, ["bip", "pa"],          "contact"),
    ("Avg Bat Speed",      ".1f",  False, False, ["swings", "pa"],       "swing"),
    ("Fast Swing %",       ".1f",  False, True,  ["swings", "pa"],       "swing"),
    ("Avg Swing Length",   ".1f",  True,  False, ["swings", "pa"],       "swing"),
    ("Chase %",            ".1f",  True,  False, ["pa"],                 "discipline"),
    ("K%",                 ".1f",  True,  False, ["pa"],                 "discipline"),
    ("Z-Contact%",         ".1f",  False, False, ["swings", "pa"],       "discipline"),
    ("Whiff %",            ".1f",  True,  False, ["swings", "pa"],       "discipline"),
    ("BB%",                ".1f",  False, False, ["pa"],                 "discipline"),
]
XRV_STATS = [
    "xRV/600", "Contact Quality", "Whiff", "Decision",
    "Fastball", "Breaking", "Offspeed",
    "Inner", "Middle (vertical)", "Outer",
    "Upper", "Middle (horizontal)", "Lower", "Chase",
]
XRV_OTHER = "_xrv_other_pitch"   # total − (FB+BRK+OFF): pitches outside the 3 families
XRV_GROUPS = [  # (components, what they must sum to)
    (["Contact Quality", "Whiff", "Decision"], "total"),
    (["Fastball", "Breaking", "Offspeed"], "total_minus_other"),
    (["Inner", "Middle (vertical)", "Outer"], "total_minus_chase"),
    (["Upper", "Middle (horizontal)", "Lower"], "total_minus_chase"),
]
# Stats allowed to use the iSwing+ layer (the backtest still has to approve it)
ISWING_ELIGIBLE = {"xSLG", "xwOBACON", "Avg Exit Velocity", "90th % EV", "Barrel %",
                   "Blasts/Contact", "LA+SwtSpt%", "Contact Quality", "xRV/600"}
RESIDUAL_ELIGIBLE = {"xwOBACON"}

MAX_LAGS = 5             # let the data decide whether seasons 4-5 back matter
MIN_TARGET = {"pa": 100, "bip": 60, "swings": 150, "pa_xrv": 100, "n_swings": 150, "n_bbe": 60}
MIN_FIT_ROWS = 150
AGE_CENTER = 28.0
SKIP_TARGET_SEASONS = {2020}   # 60-game season: fine as an input, not as a target
LAYER_MIN_GAIN = 0.002   # a layer must cut error by ≥0.2% to be used
CI_LEVEL_LIST = (90, 75, 50, 25)   # nested central bands (%); lo/hi = the widest (90%)
CI_Q = tuple(sorted([(1 - L / 100) / 2 for L in CI_LEVEL_LIST] + [1 - (1 - L / 100) / 2 for L in CI_LEVEL_LIST]))
CI_NAMES = tuple([("lo" if L == 90 else f"lo{L}") for L in CI_LEVEL_LIST]
                 + [("hi" if L == 90 else f"hi{L}") for L in reversed(CI_LEVEL_LIST)])
CI_LEVELS = {L: (i, len(CI_Q) - 1 - i) for i, L in enumerate(CI_LEVEL_LIST)}   # level → (low, high) q index
CI_MIN_ROWS = 100        # backtest rows needed to fit a stat's interval


def log(*a):
    print(*a, flush=True)


# ═══════════════════════════════════════════════════════════════════════════
# LOADING
# ═══════════════════════════════════════════════════════════════════════════
def history_from_public(public_dir: Path) -> pd.DataFrame:
    """Build the history table from the site's own season files (2023+)."""
    rows = {}
    for f in sorted(public_dir.glob("baseball_data_*.json")):
        mt = re.fullmatch(r"baseball_data_(\d{4})", f.stem)
        if not mt:
            continue
        yr = mt.group(1)
        d = json.load(open(f))
        for h in d.get("hitters", []):
            pid = h.get("player_id")
            if pid is None:
                continue
            r = rows.setdefault((int(pid), int(yr)), {"player_id": int(pid), "season": int(yr)})
            r.update(name=h.get("name"), team=h.get("team"), team_id=h.get("team_id"), pa=h.get("pa"))
            for lab, c in (h.get("categories") or {}).items():
                r[lab] = c.get("value")
    for f in sorted(public_dir.glob("hitter_xrv_*.json")):
        mt = re.fullmatch(r"hitter_xrv_(\d{4})", f.stem)     # not hitter_xrv_games_*
        if not mt:
            continue
        yr = mt.group(1)
        for pid, v in json.load(open(f)).items():
            r = rows.setdefault((int(pid), int(yr)), {"player_id": int(pid), "season": int(yr)})
            r["pa_xrv"] = v.get("pa")
            for lab, c in (v.get("metrics") or {}).items():
                r[lab] = c.get("value")
    return pd.DataFrame(list(rows.values()))


def load_history(public_dir: Path, history_dir: Path) -> pd.DataFrame:
    p = history_dir / "hitter_history.csv"
    if p.exists():
        h = pd.read_csv(p)
        log(f"History: {p}  ({len(h):,} hitter-seasons, {h.season.min()}–{h.season.max()})")
    else:
        h = history_from_public(public_dir)
        log(f"History: {p} not found — built from {public_dir}/baseball_data_*.json + hitter_xrv_*.json "
            f"({len(h):,} hitter-seasons, {h.season.min()}–{h.season.max()}; PA is the only sample size)")
    h["player_id"] = h["player_id"].astype(int)
    h["season"] = h["season"].astype(int)
    for c in [s[0] for s in CARD_STATS] + XRV_STATS + ["pa", "bip", "swings", "pa_xrv"]:
        if c in h.columns:
            h[c] = pd.to_numeric(h[c], errors="coerce")
    if all(c in h.columns for c in ["xRV/600", "Fastball", "Breaking", "Offspeed"]):
        h[XRV_OTHER] = h["xRV/600"] - h["Fastball"] - h["Breaking"] - h["Offspeed"]
    return h


def load_iswing(history_dir: Path):
    p = history_dir / "iswing_history.csv"
    if not p.exists():
        log(f"iSwing history: {p} not found — iSwing+/residual layers disabled")
        return None
    s = pd.read_csv(p)
    s["player_id"] = s["player_id"].astype(int)
    s["season"] = s["season"].astype(int)
    log(f"iSwing history: {p}  ({len(s):,} batter-seasons, {sorted(s.season.unique())}, "
        f"residual {'yes' if 'swing_residual' in s.columns else 'no'})")
    return s


def load_ages(history_dir: Path):
    p = history_dir / "birthdates.json"
    if not p.exists():
        log(f"Birthdates: {p} not found — aging term disabled")
        return None
    bd = json.load(open(p))
    out = {}
    for pid, d in bd.items():
        try:
            y, m, dd = (int(x) for x in str(d)[:10].split("-"))
            out[int(pid)] = (y, m, dd)
        except Exception:
            pass
    if not out:
        log("Birthdates: file is empty — aging term disabled")
        return None
    log(f"Birthdates: {len(out):,} players")
    return out


def season_age(birth, season):
    """Baseball season age: age on June 30 of that season."""
    if birth is None:
        return np.nan
    y, m, d = birth
    return season - y - (1 if (m, d) > (6, 30) else 0)


# ═══════════════════════════════════════════════════════════════════════════
# THE LEARNED-WEIGHT MODEL
# ═══════════════════════════════════════════════════════════════════════════
class Series:
    """One stat's history in long form: value + sample size per (player, season)."""

    def __init__(self, df, value_col, denom_col, min_target, center=None):
        d = df[["player_id", "season", value_col, denom_col]].dropna()
        d = d[d[denom_col] > 0]
        self.v = {(int(a), int(b)): (float(c), float(n))
                  for a, b, c, n in d.itertuples(index=False, name=None)}
        self.seasons = sorted(d["season"].unique().tolist())
        # League mean per season (sample-weighted), or a fixed center (e.g. 0 for residuals)
        if center is None:
            self.lg = (d.groupby("season").apply(lambda g: np.average(g[value_col], weights=g[denom_col]))
                       .to_dict())
        else:
            self.lg = {s: center for s in self.seasons}
        self.sd = d.groupby("season")[value_col].std().to_dict()
        self.min_target = min_target
        self.value_col, self.denom_col = value_col, denom_col

    def design(self, keys, J):
        """keys: list of (player_id, target_season). Returns X (rel values), N, lg_ref."""
        X = np.full((len(keys), J), np.nan)
        N = np.zeros((len(keys), J))
        lg_ref = np.full(len(keys), np.nan)
        for i, (pid, T) in enumerate(keys):
            for j in range(1, J + 1):
                s = T - j
                vn = self.v.get((pid, s))
                if vn is not None:
                    X[i, j - 1] = vn[0] - self.lg[s]
                    N[i, j - 1] = vn[1]
            prev = [s for s in self.seasons if s < T]
            lg_ref[i] = self.lg[prev[-1]] if prev else np.nan
        return X, N, lg_ref

    def targets(self, seasons=None):
        """(player, season) rows usable as fit targets, with relative target value + weight."""
        keys, y, w = [], [], []
        for (pid, s), (val, n) in self.v.items():
            if s in SKIP_TARGET_SEASONS or n < self.min_target:
                continue
            if seasons is not None and s not in seasons:
                continue
            prev = [p for p in self.seasons if p < s]
            if not prev:
                continue
            keys.append((pid, s))
            y.append(val - self.lg[prev[-1]])
            w.append(n)
        return keys, np.array(y), np.array(w)


class LearnedMarcel:
    """Fits w2..wJ, k and a quadratic age curve by weighted nonlinear least squares."""

    def __init__(self, J, use_age, fixed_weights=None):
        self.J, self.use_age, self.fixed_weights = J, use_age, fixed_weights

    def _unpack(self, p):
        if self.fixed_weights is not None:
            w, i = np.asarray(self.fixed_weights[: self.J], float), 0
        else:
            # w_j = w_{j-1} · d_j with d_j ∈ [0, 1]: an older season never counts more than a newer one
            w, i = np.r_[1.0, np.cumprod(p[: self.J - 1])], self.J - 1
        k = np.exp(p[i])
        a1 = a2 = 0.0
        if self.use_age:
            a1, a2 = p[i + 1], p[i + 2]
        return w, k, a1, a2

    def _pred(self, p, X, N, A):
        w, k, a1, a2 = self._unpack(p)
        Xz = np.nan_to_num(X)
        num = (Xz * N * w).sum(1)
        den = (N * w).sum(1) + k
        out = num / den
        if self.use_age:
            a = np.nan_to_num(A - AGE_CENTER)
            out = out + a1 * a + a2 * a * a
        return out

    def fit(self, X, N, A, y, wt, k0):
        ok = (N.sum(1) > 0)
        X, N, A, y, wt = X[ok], N[ok], A[ok], y[ok], wt[ok]
        sw = np.sqrt(wt / wt.mean())
        p0, lo, hi = [], [], []
        if self.fixed_weights is None:
            prior = [0.8, 0.75, 0.67, 0.5][: self.J - 1]          # = Marcel-ish 1/.8/.6/.4/.2 decay
            p0 += prior; lo += [0.0] * len(prior); hi += [1.0] * len(prior)
            # lags seen in few rows get a firmer pull toward the prior decay
            seen = np.maximum((N[:, 1:] > 0).mean(0), 0.02)
        p0 += [np.log(k0)]; lo += [np.log(1e-3)]; hi += [np.log(1e6)]
        if self.use_age:
            p0 += [0.0, 0.0]; lo += [-np.inf, -np.inf]; hi += [np.inf, np.inf]
        lam = 0.02 * np.sqrt(len(y))  # weak pull of w toward Marcel-ish decay (stabilises rarely-seen lags)

        def resid(p):
            r = sw * (self._pred(p, X, N, A) - y)
            if self.fixed_weights is None:
                r = np.r_[r, lam / np.sqrt(seen) * (np.asarray(p[: self.J - 1]) - prior) * (np.std(y) + 1e-12)]
            return r

        res = least_squares(resid, p0, bounds=(lo, hi), method="trf", max_nfev=4000)
        self.p = res.x
        self.n_fit = len(y)
        return self

    def predict(self, X, N, A):
        return self._pred(self.p, X, N, A)

    def describe(self):
        w, k, a1, a2 = self._unpack(self.p)
        return {"weights": [round(float(x), 3) for x in w], "k": round(float(k), 1),
                "age_a1": round(float(a1), 5), "age_a2": round(float(a2), 6)}


def decompose(sp, base, keys):
    """Split the base projection into (history blend, age term) per key, in the stat's
    units: history = league avg + the regressed blend of his own seasons; age = the
    fitted age adjustment. Whatever the final projection adds on top (iSwing+/Stuff+
    layers, xRV reconciliation) is the 'model' part."""
    rel, lg, _has = sp.base_predict(base, keys)
    _w, _k, a1, a2 = base._unpack(base.p)
    if sp.use_age:
        a = np.nan_to_num(sp._age(keys) - AGE_CENTER)
        age = a1 * a + a2 * a * a
    else:
        age = np.zeros(len(keys))
    return lg + rel - age, age


def parts_of(final, hist, age, ndigits):
    """{"history", "age", "model"} for one projected value, or None."""
    if not all(np.isfinite(x) for x in (final, hist, age)):
        return None
    return {"history": round(float(hist), ndigits), "age": round(float(age), ndigits),
            "model": round(float(final - hist - age), ndigits)}


def pool_lists(df, labels):
    """Sorted last-season values per stat — the percentile pool, so the card can
    rank a projection built from only some of its parts (stats only, + age, + model)."""
    out = {}
    for lab in labels:
        if lab in df.columns:
            v = pd.to_numeric(df[lab], errors="coerce").dropna().values
            if len(v):
                out[lab] = [round(float(x), 5) for x in np.sort(v)]
    return out


def wrmse(err, w):
    return float(np.sqrt(np.average(err ** 2, weights=w)))


# ═══════════════════════════════════════════════════════════════════════════
# ONE STAT: base model + optional layers, with fit/predict on arbitrary target sets
# ═══════════════════════════════════════════════════════════════════════════
class StatProjector:
    def __init__(self, label, series, ages, signals, J):
        self.label, self.s, self.ages, self.signals, self.J = label, series, ages, signals, J
        self.use_age = ages is not None

    def _age(self, keys):
        if self.ages is None:
            return np.full(len(keys), np.nan)
        return np.array([season_age(self.ages.get(pid), T) for pid, T in keys], float)

    def _k0(self):
        n = np.array([v[1] for v in self.s.v.values()])
        return float(np.median(n))

    def fit_base(self, target_seasons, fixed_weights=None):
        keys, y, w = self.s.targets(target_seasons)
        X, N, _ = self.s.design(keys, self.J)
        m = LearnedMarcel(self.J, self.use_age, fixed_weights)
        if len(y) < MIN_FIT_ROWS:
            return None
        return m.fit(X, N, self._age(keys), y, w, self._k0())

    def base_predict(self, model, keys):
        X, N, lg = self.s.design(keys, self.J)
        has = N.sum(1) > 0
        rel = model.predict(X, N, self._age(keys))
        return rel, lg, has

    # ── layers ──
    def _signal_features(self, sig_models, keys):
        """Projected signal values (relative) for keys; NaN where no signal history."""
        cols = []
        for name, (proj, mdl) in sig_models.items():
            X, N, _ = proj.s.design(keys, proj.J)
            v = proj.base_predict(mdl, keys)[0] if mdl is not None else np.full(len(keys), np.nan)
            v = np.where(N.sum(1) > 0, v, np.nan)
            cols.append(v)
        return np.column_stack(cols) if cols else np.zeros((len(keys), 0))

    def fit_layer(self, variant, base_model, target_seasons):
        """Stack: y_rel = c1·base_rel + Σ c·signal_rel, fit on rows that have the signals.
        No intercept: the base model already centers on league average, and with only a
        season or two of signal history a free intercept just memorises one season's
        league-wide drift (which then hurts every other season)."""
        names = VARIANT_SIGNALS[variant]
        sig_models = {}
        for nm in names:
            proj = self.signals.get(nm)
            if proj is None:
                return None
            sig_models[nm] = (proj, proj.fit_base(target_seasons))
            if sig_models[nm][1] is None:
                return None
        keys, y, w = self.s.targets(target_seasons)
        if not keys:
            return None
        base_rel, _, has = self.base_predict(base_model, keys)
        S = self._signal_features(sig_models, keys)
        ok = has & np.all(np.isfinite(S), axis=1)
        if ok.sum() < MIN_FIT_ROWS:
            return None
        Z = np.column_stack([base_rel[ok], S[ok]])
        sw = np.sqrt(w[ok])
        coef, *_ = np.linalg.lstsq(Z * sw[:, None], y[ok] * sw, rcond=None)
        return {"variant": variant, "coef": coef, "sig_models": sig_models, "n": int(ok.sum())}

    def predict(self, base_model, layer, keys):
        rel, lg, has = self.base_predict(base_model, keys)
        used_layer = np.zeros(len(keys), bool)
        if layer is not None:
            S = self._signal_features(layer["sig_models"], keys)
            ok = has & np.all(np.isfinite(S), axis=1)
            if ok.any():
                Z = np.column_stack([rel[ok], S[ok]])
                rel = rel.copy()
                rel[ok] = Z @ layer["coef"]
                used_layer = ok
        return lg + rel, has, used_layer


VARIANT_SIGNALS = {
    "base": [],
    "iswing": ["iswing"],
    "swing_resid": ["xwobacon_swing", "swing_residual"],
}


# ═══════════════════════════════════════════════════════════════════════════
# CONFIDENCE INTERVALS — learned from the walk-forward backtest's own misses.
#   spread:  err² ≈ c0 + a/(H + k) + b/n
#     H = Σ w_j·n_j (his weighted history), k = the stat's regression constant, so the
#     talent term shrinks with a longer/fuller track record; b/n is one season's luck at
#     sample n. Fit by non-negative least squares.
#   edges:   empirical 5/25/75/95th percentiles of err/σ (skewed, fat-tailed misses
#            are kept as they are, no normal assumption).
# ═══════════════════════════════════════════════════════════════════════════
def hist_weight(sp, model, keys):
    """H = Σ w_j·n_j over his past seasons, with the model's learned weights; and its k."""
    _X, N, _ = sp.s.design(keys, sp.J)
    w, k, _a1, _a2 = model._unpack(model.p)
    return (N * w).sum(1), float(k)


CI_SEASONS = 6           # backtest seasons the intervals learn from (walk-forward)
CI_MIN_TRAIN_SEASONS = 2 # ...each trained on at least this many target seasons


def prop_scale(sp):
    """Rates (labels with %, and Blasts/Contact) get their bands on the logit scale, so a
    5% K-rate's range is proportional to its level and stays inside 0–100%. Returns the
    stat's full scale (1 for decimals, 100 for percents) or None for other stats."""
    if "%" not in sp.label and sp.label != "Blasts/Contact":
        return None
    vals = np.array([v for v, _n in sp.s.v.values()])
    if vals.min() < 0:
        return None
    return 1.0 if vals.max() <= 1 else (100.0 if vals.max() <= 100 else None)


def _link(scale):
    if scale is None:
        return (lambda v: v), (lambda u: u)
    eps = 1e-4
    g = lambda v: np.log(np.clip(v / scale, eps, 1 - eps) / (1 - np.clip(v / scale, eps, 1 - eps)))
    return g, (lambda u: scale / (1 + np.exp(-u)))


def ci_backtest(sp, seasons):
    """Walk-forward misses for the intervals: each season T projected from seasons < T
    only, every projectable row kept (not just those with last season). err = actual −
    projection, on the logit scale for rates (see prop_scale)."""
    g, _ = _link(prop_scale(sp))
    rows = []
    for T in seasons:
        train = {s for s in sp.s.seasons if s < T}
        # A fit on a single target season can run away (e.g. a wild age curve) and isn't
        # what the real projection, trained on every season, looks like — skip it.
        if len({s for _p, s in sp.s.targets(train)[0]}) < CI_MIN_TRAIN_SEASONS:
            continue
        learned = sp.fit_base(train)
        if learned is None:
            continue
        keys, y, w = eval_rows(sp, T)
        if not keys:
            continue
        pl, has, _ = sp.predict(learned, None, keys)
        H, k = hist_weight(sp, learned, keys)
        rows.append({"err": (g(y) - g(pl))[has], "H": H[has], "k": np.full(has.sum(), k),
                     "nt": w[has], "season": np.full(has.sum(), T), "y": y[has], "pl": pl[has]})
    sp.ci_rows = {key: np.concatenate([r[key] for r in rows]) for key in rows[0]} if rows else None
    return sp.ci_rows


BIAS_MIN_SEASONS = 3      # backtest seasons needed before a lean correction can be validated


def fit_bias(sp):
    """Marcel regresses everyone toward the playing-time-weighted league average — mostly
    regulars — so thin-history players (who are worse on average) get projected too high.
    Correction: + β·k/(H+k), largest for the thinnest history, ~0 for long full-time careers.
    β is fit on the backtest misses and kept only if, walk-forward (β fit on earlier backtest
    seasons, scored on each later one), it lowers the error in at least 2/3 of the tests.
    When kept, the interval misses are re-centred on the corrected projection."""
    sp.bias = None
    rows = getattr(sp, "ci_rows", None)
    if rows is None:
        return None
    x = rows["k"] / (rows["H"] + rows["k"])
    e = rows["y"] - rows["pl"]
    seasons = sorted(np.unique(rows["season"]).tolist())
    if len(seasons) < BIAS_MIN_SEASONS:
        return {"kept": False, "why": f"{len(seasons)} backtest season(s)"}
    wins, tests, before, after = 0, 0, [], []
    for T in seasons[2:]:
        tr, te = rows["season"] < T, rows["season"] == T
        b = float(x[tr] @ e[tr] / (x[tr] @ x[tr]))
        r0 = float(np.sqrt(np.mean(e[te] ** 2))); r1 = float(np.sqrt(np.mean((e[te] - b * x[te]) ** 2)))
        tests += 1; wins += r1 < r0; before.append(r0); after.append(r1)
    beta = float(x @ e / (x @ x))
    kept = wins >= max(2, int(np.ceil(2 * tests / 3)))
    out = {"beta": round(beta, 6), "kept": bool(kept), "wins": int(wins), "tests": int(tests),
           "rmse_before": round(float(np.mean(before)), 6), "rmse_after": round(float(np.mean(after)), 6)}
    if kept:
        sp.bias = beta
        g, _ = _link(prop_scale(sp))
        rows["err"] = g(rows["y"]) - g(rows["pl"] + beta * x)
    return out


def bias_adjust(sp, model, keys):
    """The kept lean correction for target keys (0 where none)."""
    if getattr(sp, "bias", None) is None:
        return np.zeros(len(keys))
    H, k = hist_weight(sp, model, keys)
    return sp.bias * k / (H + k)


def bias_text(b):
    if not b:
        return ""
    if "why" in b:
        return f"lean fix: n/a ({b['why']})"
    return (f"lean fix β={b['beta']:+.4g}: walk-forward RMSE {b['rmse_before']:.4g}→{b['rmse_after']:.4g}, "
            f"better in {b['wins']}/{b['tests']} → {'APPLIED' if b['kept'] else 'not applied'}")


def _spread(rows, m):
    A = np.column_stack([np.ones(m.sum()), 1.0 / (rows["H"][m] + rows["k"][m]), 1.0 / rows["nt"][m]])
    coef, _ = nnls(A, rows["err"][m] ** 2)
    return {"c0": float(coef[0]), "a": float(coef[1]), "b": float(coef[2])}


def _oos_z(rows, m):
    """Each season's misses standardized by a spread fit on the OTHER seasons, so the
    edges include season-to-season drift (in-sample z would understate it)."""
    seasons = np.unique(rows["season"][m])
    if len(seasons) < 2:
        sp_ = _spread(rows, m)
        return rows["err"][m] / ci_sigma(sp_, rows["H"][m], rows["k"][m], rows["nt"][m])
    zs = []
    for T in seasons:
        other = m & (rows["season"] != T)
        if other.sum() < CI_MIN_ROWS // 2:
            continue
        sp_ = _spread(rows, other)
        t = m & (rows["season"] == T)
        zs.append(rows["err"][t] / ci_sigma(sp_, rows["H"][t], rows["k"][t], rows["nt"][t]))
    return np.concatenate(zs) if zs else np.array([])


def fit_ci(rows, mask=None):
    m = np.ones(len(rows["err"]), bool) if mask is None else mask
    if m.sum() < CI_MIN_ROWS:
        return None
    z = _oos_z(rows, m)
    if len(z) < CI_MIN_ROWS // 2:
        return None
    spread = _spread(rows, m)
    z_in = rows["err"][m] / ci_sigma(spread, rows["H"][m], rows["k"][m], rows["nt"][m])
    return {**spread, "q": [float(x) for x in np.quantile(z, CI_Q)],
            "q_in": [float(x) for x in np.quantile(z_in, CI_Q)],
            "n_seasons": int(len(np.unique(rows["season"][m])))}


def drift_widen(metas):
    """How much wider the honest (out-of-season) 90% band is than an in-sample one, across
    the stats with ≥3 backtest seasons — applied to stats with a single backtest season,
    whose bands can't see season-to-season drift on their own."""
    a, b = CI_LEVELS[90]
    r = [(m["q"][b] - m["q"][a]) / (m["q_in"][b] - m["q_in"][a])
         for m in metas.values() if m.get("n_seasons", 0) >= 3 and m["q_in"][b] > m["q_in"][a]]
    return max(1.0, float(np.median(r))) if r else 1.0


def ci_sigma(fit, H, k, n):
    return np.sqrt(np.maximum(fit["c0"] + fit["a"] / (H + k) + fit["b"] / n, 1e-12))


def ci_coverage(rows):
    """Honest check: each backtest season scored with bands (spread AND edges) fit only on
    the other seasons — the share of actual outcomes inside each band (≈ its level if
    calibrated). Returns {level: {season: pct}}."""
    out = {lv: {} for lv in CI_LEVELS}
    for T in np.unique(rows["season"]):
        fit = fit_ci(rows, rows["season"] != T)
        if fit is None:
            continue
        m = rows["season"] == T
        z = rows["err"][m] / ci_sigma(fit, rows["H"][m], rows["k"][m], rows["nt"][m])
        for lv, (a, b) in CI_LEVELS.items():
            out[lv][int(T)] = round(float(np.mean((z >= fit["q"][a]) & (z <= fit["q"][b])) * 100), 1)
    return out


def ci_bounds(sp, model, keys, center, last_season, widen=1.0):
    """90%/50% bands around the final projections `center` for keys (target season).
    The luck term assumes his recent playing time: the learned-weight average of his last
    two seasons' samples, clamped between the stat's minimum and a full season (90th
    percentile of last season's qualified samples). Returns (dict of arrays, meta) or None."""
    rows = getattr(sp, "ci_rows", None)
    fit = fit_ci(rows) if rows is not None else None
    if fit is None:
        return None
    widened = fit["n_seasons"] < 2 and widen > 1.0
    if widened:
        fit = {**fit, "q": [x * widen for x in fit["q"]]}
    H, k = hist_weight(sp, model, keys)
    w, *_ = model._unpack(model.p)
    recent = np.full(len(keys), np.nan)
    for i, (pid, T) in enumerate(keys):
        num = den = 0.0
        for j in range(1, min(2, len(w)) + 1):
            vn = sp.s.v.get((pid, T - j))
            if vn is not None:
                num += w[j - 1] * vn[1]; den += w[j - 1]
        if den:
            recent[i] = num / den
    last_n = np.array([n for (_p, s), (_v, n) in sp.s.v.items() if s == last_season and n >= sp.s.min_target])
    full = float(np.percentile(last_n, 90)) if len(last_n) else float(sp.s.min_target)
    floor = float(sp.s.min_target)
    n = np.clip(np.nan_to_num(recent, nan=floor), floor, max(full, floor))
    sig = ci_sigma(fit, H, k, n)
    scale = prop_scale(sp)
    g, ginv = _link(scale)
    vals = np.array([v for v, _n in sp.s.v.values()])
    lo_clip = 0.0 if vals.min() >= 0 else -np.inf
    c = np.asarray(center, float)
    # actual = projection + err (on the stat's own scale, or logit for rates)
    b = {name: np.maximum(ginv(g(c) + sig * q), lo_clip) for name, q in zip(CI_NAMES, fit["q"])}
    b["n"] = n
    cov = ci_coverage(rows)
    meta = {**{key: round(fit[key], 8) for key in ("c0", "a", "b")}, "q": [round(x, 4) for x in fit["q"]],
            "q_in": [round(x, 4) for x in fit["q_in"]], "n_seasons": fit["n_seasons"],
            "widened": round(widen, 3) if widened else None,
            "coverage": cov, "full_n": round(full, 1), "floor_n": floor, "denom": sp.s.denom_col,
            "scale": "logit" if scale else "linear",
            "rows": int(len(rows["err"]))}
    return b, meta


def ci_entry(b, i, ndigits):
    if b is None or not np.isfinite(b["lo"][i]):
        return None
    return {**{name: round(float(b[name][i]), ndigits) for name in CI_NAMES}, "n": int(round(float(b["n"][i])))}


def coverage_text(meta):
    if not meta:
        return "(no interval)"
    cov = meta.get("coverage") or {}
    if not cov.get(90):
        w = (f", widened ×{meta['widened']:.2f} for season drift" if (meta.get("widened") or 1) >= 1.02
             else "; long-history stats show no extra season drift to add")
        return f"estimated from 1 backtest season ({meta['rows']} rows{w})"
    avg = lambda lv: np.mean(list(cov[lv].values())) if cov.get(lv) else float("nan")
    return ("90% band: " + " · ".join(f"{s} {v:.1f}%" for s, v in cov[90].items())
            + "  | avg " + " · ".join(f"{L}% {avg(L):.1f}" for L in CI_LEVEL_LIST))


# ═══════════════════════════════════════════════════════════════════════════
# BACKTESTS
# ═══════════════════════════════════════════════════════════════════════════
def eval_rows(sp, T):
    keys, y, w = sp.s.targets({T})
    _, _, lg = sp.s.design(keys, sp.J)
    return keys, y + lg, w   # absolute targets


def walkforward_base(sp, test_seasons):
    """Learned weights vs Marcel 5/4/3 (k fitted) vs last season, each test season T
    fit only on targets < T. Scored on rows that have last season (so all 3 are comparable)."""
    out = []
    for T in test_seasons:
        train = {s for s in sp.s.seasons if s < T}
        learned = sp.fit_base(train)
        marcel = sp.fit_base(train, fixed_weights=[1, .8, .6, .4, .2])
        if learned is None or marcel is None:
            continue
        keys, y, w = eval_rows(sp, T)
        if not keys:
            continue
        pl, has, _ = sp.predict(learned, None, keys)
        pm, _, _ = sp.predict(marcel, None, keys)
        last = np.array([sp.s.v.get((pid, T - 1), (np.nan, 0))[0] for pid, _ in keys])
        ok = has & np.isfinite(last)
        if ok.sum() < 30:
            continue
        out.append({"season": T, "n": int(ok.sum()),
                    "err_learned": (pl - y)[ok], "err_marcel": (pm - y)[ok],
                    "err_last": (last - y)[ok], "w": w[ok]})
    if not out:
        return None
    cat = lambda k: np.concatenate([o[k] for o in out])
    W = cat("w")
    return {"seasons": [o["season"] for o in out], "n": int(sum(o["n"] for o in out)),
            "rmse_last": wrmse(cat("err_last"), W), "rmse_marcel543": wrmse(cat("err_marcel"), W),
            "rmse_learned": wrmse(cat("err_learned"), W)}


def compare_layers(sp, variants, layer_seasons, scheme):
    """Score each variant on the SAME rows (those with every signal), test seasons in
    layer_seasons. scheme='walkforward' trains on seasons < T; 'loso' on all other seasons."""
    errs = {v: [] for v in variants}
    weights, n_rows = [], 0
    for T in layer_seasons:
        train = ({s for s in sp.s.seasons if s < T} if scheme == "walkforward"
                 else {s for s in sp.s.seasons if s != T})
        base = sp.fit_base(train)
        if base is None:
            continue
        layers = {}
        for v in variants:
            layers[v] = None if v == "base" else sp.fit_layer(v, base, train)
        if any(v != "base" and layers[v] is None for v in variants):
            continue
        keys, y, w = eval_rows(sp, T)
        if not keys:
            continue
        preds, masks = {}, []
        for v in variants:
            p, has, used = sp.predict(base, layers[v], keys)
            preds[v] = p
            masks.append(has if v == "base" else used)
        common = np.logical_and.reduce(masks)
        if common.sum() < 30:
            continue
        for v in variants:
            errs[v].append((preds[v] - y)[common])
        weights.append(w[common]); n_rows += int(common.sum())
    if not weights:
        return None
    W = np.concatenate(weights)
    return {"n": n_rows, **{v: wrmse(np.concatenate(errs[v]), W) for v in variants}}


# ═══════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════
def pick_denom(h, prefs, label):
    """First preferred sample-size column that is filled on ≥90% of the rows where this stat exists."""
    rows = h[h[label].notna()]
    for c in prefs:
        if c in rows.columns and rows[c].notna().mean() > 0.9:
            return c
    return "pa"


def fmt_value(label, v):
    for lab, fmt, _lb, dec, _d, _f in CARD_STATS:
        if lab == label:
            return format(v * 100 if dec else v, fmt)
    return f"{v:+.1f}"


def ecdf_pct(pool, v, lower_better):
    pool = np.asarray(pool, float)
    pool = pool[np.isfinite(pool)]
    if len(pool) == 0 or not np.isfinite(v):
        return None
    p = (pool < v).mean() * 100
    return round(100 - p if lower_better else p, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--public", default="./public")
    ap.add_argument("--history", default="./history")
    ap.add_argument("--target", type=int, default=2027)
    ap.add_argument("--min-recent-pa", type=int, default=200,
                    help="project hitters with at least this many PA over the last 3 seasons")
    args = ap.parse_args()
    public, hist_dir, TARGET = Path(args.public), Path(args.history), args.target
    LAST = TARGET - 1

    h = load_history(public, hist_dir)
    isw = load_iswing(hist_dir)
    ages = load_ages(hist_dir)

    # ── Signals from the swing model (each is itself a learned-weight series) ──
    signals = {}
    if isw is not None:
        sig_specs = [("iswing", "iswing", "n_swings", None)]
        if "swing_residual" in isw.columns:
            sig_specs += [("xwobacon_swing", "xwobacon_swing", "n_bbe", None),
                          ("swing_residual", "swing_residual", "n_bbe", 0.0)]
        for name, col, den, center in sig_specs:
            if col in isw.columns:
                ser = Series(isw, col, den, MIN_TARGET[den], center=center)
                Jsig = min(MAX_LAGS, max(1, len(ser.seasons) - 1))
                signals[name] = StatProjector(name, ser, ages, {}, Jsig)

        # Is beating your swing a repeatable skill?
        if "swing_residual" in isw.columns:
            r = isw[isw["n_bbe"] >= 60][["player_id", "season", "swing_residual"]]
            nxt = r.copy(); nxt["season"] -= 1
            m = r.merge(nxt, on=["player_id", "season"], suffixes=("", "_next"))
            if len(m) >= 30:
                log(f"\nSwing-residual stickiness (Y vs Y+1, ≥60 BBE): r = "
                    f"{m['swing_residual'].corr(m['swing_residual_next']):+.3f}  (n={len(m)})")

    all_stats = [(lab, lb, prefs) for lab, _f, lb, _dec, prefs, _fam in CARD_STATS] + \
                [(lab, False, ["pa_xrv"]) for lab in XRV_STATS] + [(XRV_OTHER, False, ["pa_xrv"])]

    report, projectors = [], {}
    log("\n" + "═" * 112)
    log(f"{'stat':22s}{'denom':>7s}{'J':>3s}  {'weights (last→oldest)':28s}{'k':>8s}"
        f"{'  RMSE last-yr':>14s}{'5/4/3':>9s}{'learned':>9s}{'gain':>8s}  layer")
    log("─" * 112)
    for label, lower_better, prefs in all_stats:
        if label not in h.columns:
            log(f"{label:22s}  (not in history — skipped)")
            continue
        den = pick_denom(h, prefs, label)
        ser = Series(h, label, den, MIN_TARGET.get(den, 100))
        if len(ser.seasons) < 2:
            continue
        J = min(MAX_LAGS, len(ser.seasons) - 1)
        sp = StatProjector(label, ser, ages, signals, J)

        target_seasons = [s for s in ser.seasons[1:] if s not in SKIP_TARGET_SEASONS]
        wf = walkforward_base(sp, target_seasons[-3:])
        ci_backtest(sp, target_seasons[-CI_SEASONS:])
        sp.bias_info = fit_bias(sp)
        base_all = sp.fit_base(set(ser.seasons))
        if base_all is None:
            log(f"{label:22s}  (too few rows to fit — skipped)")
            continue

        # Candidate layers, chosen on held-out error
        variants = ["base"]
        if label in ISWING_ELIGIBLE and "iswing" in signals:
            variants.append("iswing")
        if label in RESIDUAL_ELIGIBLE and "swing_residual" in signals:
            variants.append("swing_resid")
        layer_cmp, chosen, layer = None, "base", None
        if len(variants) > 1:
            sig_seasons = sorted(set.intersection(*[set(signals[n].s.seasons)
                                                    for v in variants[1:] for n in VARIANT_SIGNALS[v]]))
            layer_targets = [s + 1 for s in sig_seasons if s + 1 in ser.seasons]
            loso = compare_layers(sp, variants, layer_targets, "loso")
            wfl = compare_layers(sp, variants, layer_targets[1:], "walkforward")
            layer_cmp = {"loso": loso, "walkforward": wfl}
            if loso:
                best = min(variants, key=lambda v: loso[v])
                if best != "base" and loso[best] < loso["base"] * (1 - LAYER_MIN_GAIN):
                    chosen = best
            if chosen != "base":
                layer = sp.fit_layer(chosen, base_all, set(ser.seasons))
                if layer is None:
                    chosen = "base"

        projectors[label] = (sp, base_all, layer, lower_better)
        d = base_all.describe()
        gain = (1 - wf["rmse_learned"] / wf["rmse_last"]) if wf else np.nan
        wtxt = " ".join(f"{x:.2f}" for x in d["weights"])
        log(f"{label:22s}{den:>7s}{J:>3d}  {wtxt:28s}{d['k']:>8.0f}"
            + (f"{wf['rmse_last']:>14.4f}{wf['rmse_marcel543']:>9.4f}{wf['rmse_learned']:>9.4f}{gain:>+8.1%}"
               if wf else f"{'(no walk-forward seasons)':>40s}")
            + f"  {chosen}")
        if layer_cmp and layer_cmp["loso"]:
            lc = layer_cmp["loso"]
            log(f"{'':22s}  layer check, LOSO on {lc['n']} rows: "
                + "  ".join(f"{v}={lc[v]:.4f}" for v in variants)
                + (f"  | walk-forward: " + "  ".join(f"{v}={layer_cmp['walkforward'][v]:.4f}" for v in variants)
                   if layer_cmp["walkforward"] else ""))
        if sp.bias_info and "why" not in sp.bias_info:
            log(f"{'':22s}  {bias_text(sp.bias_info)}")
        rep = {"stat": label, "denom": den, "lags": J, **d, "n_fit": base_all.n_fit,
               "layer": chosen, "walkforward": wf, "layer_check": layer_cmp, "lean_fix": sp.bias_info}
        if layer is not None:
            rep["layer_coef"] = [round(float(c), 5) for c in layer["coef"]]
            rep["layer_signal_models"] = {nm: m.describe() for nm, (_p, m) in layer["sig_models"].items()}
        report.append(rep)
    log("═" * 112)

    # ═══════════════════════════════════════════════════════════════════════
    # PROJECT TARGET SEASON
    # ═══════════════════════════════════════════════════════════════════════
    recent = h[h["season"].between(TARGET - 3, LAST)]
    pa_recent = recent.groupby("player_id")["pa"].sum()
    in_recent = set(h[h["season"] >= LAST - 1]["player_id"])
    pids = sorted(p for p in pa_recent.index if pa_recent[p] >= args.min_recent_pa and p in in_recent)
    keys = [(p, TARGET) for p in pids]
    log(f"\nProjecting {TARGET} for {len(pids)} hitters (≥{args.min_recent_pa} PA over "
        f"{TARGET-3}–{LAST}, active {LAST-1}–{LAST})")

    proj = pd.DataFrame({"player_id": pids})
    layer_used = {}
    for label, (sp, base, layer, _lb) in projectors.items():
        p, has, used = sp.predict(base, layer, keys)
        fix = bias_adjust(sp, base, keys)          # regression toward "players like him"
        proj[label] = np.where(has, p + fix, np.nan)
        layer_used[label] = int(used.sum())
        hist_part, age_part = decompose(sp, base, keys)
        proj[f"__hist__{label}"] = hist_part + fix
        proj[f"__age__{label}"] = age_part

    # ── iSwing+ itself (its own learned weights) ──
    if "iswing" in signals:
        sp = signals["iswing"]
        m = sp.fit_base(set(sp.s.seasons))
        if m is not None:
            p, has, _ = sp.predict(m, None, keys)
            proj["iSwing+"] = np.where(has, p, np.nan)

            proj["__hist__iSwing+"], proj["__age__iSwing+"] = decompose(sp, m, keys)
            report.append({"stat": "iSwing+", "denom": "n_swings", "lags": sp.J, **m.describe(),
                           "n_fit": m.n_fit, "layer": "base"})
    if "swing_residual" in signals:
        sp = signals["swing_residual"]
        m = sp.fit_base(set(sp.s.seasons))
        if m is not None:
            p, has, _ = sp.predict(m, None, keys)
            proj["_swing_residual"] = np.where(has, p, np.nan)

    # ── xRV reconciliation: every breakdown sums to the projected total ──
    if all(c in proj.columns for c in XRV_STATS):
        var = {c: float(np.nanvar(h.loc[h.season == LAST, c])) for c in XRV_STATS + [XRV_OTHER] if c in h.columns}
        for i in proj.index:
            T = proj.at[i, "xRV/600"]
            if not np.isfinite(T):
                continue
            chase = proj.at[i, "Chase"]
            other = proj.at[i, XRV_OTHER] if XRV_OTHER in proj.columns and np.isfinite(proj.at[i, XRV_OTHER]) else 0.0
            for comps, kind in XRV_GROUPS:
                goal = T if kind == "total" else T - other if kind == "total_minus_other" else T - chase
                vals = proj.loc[i, comps].astype(float)
                if vals.isna().any():
                    continue
                gap = goal - vals.sum()
                v = np.array([var.get(c, 1.0) for c in comps])
                proj.loc[i, comps] = vals.values + gap * v / v.sum()

        # Same reconciliation for the history and age parts, so the breakdown adds up
        # to the total in every "Show" view (stats only, + age, + model), not just the
        # full projection. The model part (final − history − age) then adds up too.
        for part in ("__hist__", "__age__"):
            col = lambda c: f"{part}{c}"
            if not all(col(c) in proj.columns for c in XRV_STATS):
                continue
            T = proj[col("xRV/600")]
            chase = proj[col("Chase")]
            other = proj[col(XRV_OTHER)].fillna(0.0) if col(XRV_OTHER) in proj.columns else 0.0
            for comps, kind in XRV_GROUPS:
                goal = T if kind == "total" else T - other if kind == "total_minus_other" else T - chase
                vals = proj[[col(c) for c in comps]].astype(float)
                ok = goal.notna() & vals.notna().all(axis=1)
                gap = (goal - vals.sum(axis=1))[ok]
                v = np.array([var.get(c, 1.0) for c in comps])
                for c, wi in zip(comps, v / v.sum()):
                    proj.loc[ok, col(c)] = proj.loc[ok, col(c)] + gap * wi

    # ── 90% confidence intervals around the final projections ──
    ci, ci_meta = {}, {}
    for label, (sp, base, _layer, _lb) in projectors.items():
        r = ci_bounds(sp, base, keys, proj[label].values, LAST)
        if r is not None:
            ci[label], ci_meta[label] = r
    widen = drift_widen(ci_meta)          # for stats with only one backtest season
    for label, (sp, base, _layer, _lb) in projectors.items():
        if label in ci_meta and ci_meta[label]["n_seasons"] < 2:
            ci[label], ci_meta[label] = ci_bounds(sp, base, keys, proj[label].values, LAST, widen)
    log("\nConfidence intervals (band fit on the other backtest seasons, scored on each):")
    for label in ci_meta:
        if not label.startswith("_"):
            m = ci_meta[label]
            log(f"  {label:22s} {coverage_text(m)}   (full season = {m['full_n']:.0f} {m['denom']})")

    # ═══════════════════════════════════════════════════════════════════════
    # WRITE CARD FILES
    # ═══════════════════════════════════════════════════════════════════════
    last = h[h["season"] == LAST].set_index("player_id")
    latest = h.sort_values("season").groupby("player_id").last()
    pool = h[(h["season"] == LAST) & (h["pa"] >= 100)]
    xpool = h[(h["season"] == LAST) & (h.get("pa_xrv", h["pa"]) >= 100)]
    isw_pool = (isw[(isw.season == LAST) & (isw.n_swings >= 100)]["iswing"].values
                if isw is not None else np.array([]))

    hitters, xrv_out = [], {}
    for i, r in proj.iterrows():
        pid = int(r["player_id"])
        info = latest.loc[pid]
        cats = {}
        if "iSwing+" in proj.columns and np.isfinite(r.get("iSwing+", np.nan)):
            v = float(r["iSwing+"])
            cats["iSwing+"] = {"value": round(v, 1), "display": str(int(round(v))),
                               "pctile": ecdf_pct(isw_pool, v, False),
                               "parts": parts_of(v, r.get("__hist__iSwing+", np.nan), r.get("__age__iSwing+", np.nan), 3)}
            if isw is not None:
                lv = isw[(isw.player_id == pid) & (isw.season == LAST)]["iswing"]
                if len(lv):
                    cats["iSwing+"]["last"] = {"value": round(float(lv.iloc[0]), 1),
                                               "display": str(int(round(lv.iloc[0])))}
        for lab, _fmt, lb, _dec, _p, _fam in CARD_STATS:
            v = r.get(lab, np.nan)
            if lab not in proj.columns or not np.isfinite(v):
                cats[lab] = {"pctile": None, "value": None, "display": "—"}
                continue
            cats[lab] = {"value": round(float(v), 4), "display": fmt_value(lab, v),
                         "parts": parts_of(v, r.get(f"__hist__{lab}", np.nan), r.get(f"__age__{lab}", np.nan), 4),
                         "pctile": ecdf_pct(pool[lab].values, v, lb),
                         "ci": ci_entry(ci.get(lab), i, 4)}
            if pid in last.index and np.isfinite(last.at[pid, lab]):
                lv = float(last.at[pid, lab])
                cats[lab]["last"] = {"value": round(lv, 4), "display": fmt_value(lab, lv)}
        nn = lambda x: None if x is None or (isinstance(x, float) and not np.isfinite(x)) or pd.isna(x) else x
        entry = {
            "name": nn(info.get("name")), "player_id": pid,
            "team": nn(info.get("team")), "team_id": (int(info["team_id"]) if pd.notna(info.get("team_id")) else None),
            "pa": int(last.at[pid, "pa"]) if pid in last.index and pd.notna(last.at[pid, "pa"]) else None,
            "categories": cats,
            "proj": {
                "season": TARGET,
                "age": (int(season_age(ages.get(pid), TARGET)) if ages and ages.get(pid) else None),
                "based_on": sorted(int(s) for s in h[(h.player_id == pid) & (h.season >= TARGET - MAX_LAGS)]["season"]),
                "pa_recent": int(pa_recent.get(pid, 0)),
            },
        }
        if np.isfinite(r.get("_swing_residual", np.nan)):
            entry["proj"]["swing_residual"] = {"value": round(float(r["_swing_residual"]), 4),
                                               "display": f"{r['_swing_residual']:+.3f}".replace("0.", ".")}
        hitters.append(entry)

        if all(c in proj.columns for c in XRV_STATS) and np.isfinite(r["xRV/600"]):
            metrics = {}
            for lab in XRV_STATS:
                v = float(r[lab])
                metrics[lab] = {"value": round(v, 2), "display": f"{v:+.1f}",
                                "parts": parts_of(v, r.get(f"__hist__{lab}", np.nan), r.get(f"__age__{lab}", np.nan), 3),
                                "pctile": ecdf_pct(xpool[lab].values, v, False),
                                "ci": ci_entry(ci.get(lab), i, 2)}
                if pid in last.index and np.isfinite(last.at[pid, lab]):
                    lv = float(last.at[pid, lab])
                    metrics[lab]["last"] = {"value": round(lv, 2), "display": f"{lv:+.1f}"}
            xrv_out[str(pid)] = {"pa": entry["pa"], "metrics": metrics}

    season_key = f"{TARGET}P"
    out = {
        "season": season_key,
        "hitters": hitters,
        "pitchers": [],
        "hitter_metrics": [{"key": lab, "label": lab, "lower_better": lb} for lab, _f, lb, *_ in CARD_STATS],
        "pitcher_metrics": [],
        "meta": {"projection": True, "target_season": TARGET, "percentiles_vs": f"{LAST} actual (min 100 PA)",
                 "min_recent_pa": args.min_recent_pa,
                 "generated_at": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
                 "pools": {**pool_lists(pool, [lab for lab, *_ in CARD_STATS]),
                           **({"iSwing+": [round(float(x), 5) for x in np.sort(isw_pool[np.isfinite(isw_pool)])]}
                              if len(isw_pool) else {})},
                 "xrv_pools": pool_lists(xpool, XRV_STATS),
                 "lower_better": [lab for lab, _f, lb, *_ in CARD_STATS if lb],
                 "ci": {"levels": list(CI_LEVEL_LIST), "method": "walk-forward backtest misses; spread c0 + a/(H+k) + b/n; "
                        "empirical 5/25/75/95th percentile edges; luck term at recent playing time "
                        "(clamped to [minimum, full season]); base-model backtest, so slightly conservative "
                        "where a model layer is used",
                        "stats": {k: v for k, v in ci_meta.items() if not k.startswith("_")}}},
    }
    def _clean(o):
        if isinstance(o, dict):
            return {k: _clean(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)):
            return [_clean(v) for v in o]
        if isinstance(o, (np.floating, float)):
            return None if not np.isfinite(o) else round(float(o), 6)
        if isinstance(o, np.integer):
            return int(o)
        return o
    # Browsers reject NaN in JSON, so clean everything and write strict JSON
    public.mkdir(parents=True, exist_ok=True)
    with open(public / f"baseball_data_{season_key}.json", "w") as f:
        json.dump(_clean(out), f, indent=1, default=str, allow_nan=False)
    with open(public / f"hitter_xrv_{season_key}.json", "w") as f:
        json.dump(_clean(xrv_out), f, default=str, allow_nan=False)
    with open(public / "projection_report.json", "w") as f:
        json.dump(_clean({"target": TARGET, "stats": report, "layer_rows_used": layer_used}), f, indent=1,
                  allow_nan=False)
    flat = []
    for r in report:
        wf = r.get("walkforward") or {}
        flat.append({"stat": r["stat"], "denom": r["denom"], "lags": r["lags"],
                     **{f"w{i+1}": w for i, w in enumerate(r["weights"])}, "k": r["k"],
                     "age_a1": r["age_a1"], "age_a2": r["age_a2"], "layer": r.get("layer"),
                     "rmse_last_year": wf.get("rmse_last"), "rmse_marcel543": wf.get("rmse_marcel543"),
                     "rmse_learned": wf.get("rmse_learned"), "walkforward_seasons": wf.get("seasons")})
    pd.DataFrame(flat).to_csv(public / "projection_report.csv", index=False)

    log(f"\nWrote {public}/baseball_data_{season_key}.json  ({len(hitters)} hitters)")
    log(f"Wrote {public}/hitter_xrv_{season_key}.json  ({len(xrv_out)} hitters)")
    log(f"Wrote {public}/projection_report.json / .csv")
    lu = {k: v for k, v in layer_used.items() if v}
    if lu:
        log(f"Layer applied to: {lu}")


if __name__ == "__main__":
    main()
