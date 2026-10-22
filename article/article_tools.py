"""
article_tools.py — validations, tables and graphics for the projection-model article.

Every number comes from the real model code (build_projections.py), so what the
notebook shows is exactly what the site's 2027 projections use. Nothing here writes
projection files; it only refits, backtests and draws.

    import article_tools as at
    H = at.fit_side("hitters", history="history", public="private_out")
    at.table_model(H)                 # weights, k, aging per stat
    at.plot_backtest(H)               # learned model vs last season vs Marcel
    ...

Needs build_projections.py next to it (or on sys.path) and the history files from
the droplet: history/hitter_history.csv, history/pitcher_history.csv,
history/birthdates.json and, optionally, history/iswing_history.csv.
"""

from pathlib import Path
import json

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

import build_projections as bp

bp.log = lambda *a: None          # keep the notebook quiet; the tables say it all

# ── Pitcher card (same list and order as baseball_pipeline.PITCHER_METRICS) ──
PITCHER_CARD = [  # label, lower_better, sample-size preferences
    ("SIERA", True, ["ip"]), ("FIP", True, ["ip"]),
    ("Avg Exit Velo", True, ["bf", "ip"]), ("Barrel%", True, ["bf", "ip"]),
    ("xBA", True, ["bf", "ip"]), ("xSLG", True, ["bf", "ip"]), ("xwOBA", True, ["bf", "ip"]),
    ("Avg FB Velo", False, ["ip"]), ("Whiff%", False, ["bf", "ip"]),
    ("K%", False, ["bf", "ip"]), ("Chase%", False, ["bf", "ip"]), ("BB%", True, ["bf", "ip"]),
    ("K-BB%", False, ["bf", "ip"]), ("GB%", False, ["bf", "ip"]),
]
PITCHER_GRADES = ["stuff_plus", "loc_plus", "tun_plus", "pitch_plus"]
PITCHER_RESID_ELIGIBLE = {"xwOBA", "xBA", "xSLG", "FIP", "SIERA", "Barrel%", "Avg Exit Velo"}
PITCHER_AGE = (22, 37)

bp.MIN_TARGET.update({"bf": 100, "ip": 20, "pitches": 300})
bp.VARIANT_SIGNALS.update({"grades": PITCHER_GRADES, "stuff": ["stuff_plus"],
                           "model_resid": ["pitch_plus", "model_resid"]})

FAMILY = {lab: fam for lab, _f, _lb, _d, _p, fam in bp.CARD_STATS}
FAMILY.update({s: "xRV" for s in bp.XRV_STATS})
PITCHER_FAMILY = {"SIERA": "run prevention", "FIP": "run prevention", "xwOBA": "contact allowed",
                  "xBA": "contact allowed", "xSLG": "contact allowed", "Avg Exit Velo": "contact allowed",
                  "Barrel%": "contact allowed", "GB%": "contact allowed", "Avg FB Velo": "stuff",
                  "Whiff%": "stuff", "K%": "strikeouts & walks", "BB%": "strikeouts & walks",
                  "K-BB%": "strikeouts & walks", "Chase%": "strikeouts & walks"}

INK = "#0f172a"
PALETTE = ["#2563eb", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#0ea5e9", "#f97316", "#64748b"]
plt.rcParams.update({"figure.dpi": 110, "savefig.dpi": 200, "axes.spines.top": False,
                     "axes.spines.right": False, "axes.grid": True, "grid.alpha": 0.25,
                     "axes.titleweight": "bold", "axes.titlesize": 12, "font.size": 10})
FIG_DIR = Path("figures")
TAB_DIR = Path("tables")


def save(fig, name):
    FIG_DIR.mkdir(exist_ok=True)
    fig.savefig(FIG_DIR / f"{name}.png", bbox_inches="tight", facecolor="white")


def save_table(df, name):
    TAB_DIR.mkdir(exist_ok=True)
    df.to_csv(TAB_DIR / f"{name}.csv", index=False)
    return df


class PitcherProjector(bp.StatProjector):
    """Pitchers: same model, ages clamped to 22–37 so the quadratic can't run away."""
    def _age(self, keys):
        a = super()._age(keys)
        return np.where(np.isfinite(a), np.clip(a, *PITCHER_AGE), a)


# ═══════════════════════════════════════════════════════════════════════════
# FITTING — the same steps, in the same order, as build_projections.main()
# ═══════════════════════════════════════════════════════════════════════════
def walkforward(sp, seasons):
    """Each test season T: fit on seasons < T only, then score T. Like
    bp.walkforward_base, plus a league-average baseline and per-season detail."""
    per = []
    for T in seasons:
        train = {s for s in sp.s.seasons if s < T}
        learned = sp.fit_base(train)
        marcel = sp.fit_base(train, fixed_weights=[1, .8, .6, .4, .2])
        if learned is None or marcel is None:
            continue
        keys, y, w = bp.eval_rows(sp, T)
        if not keys:
            continue
        pl, has, _ = sp.predict(learned, None, keys)
        pm, _, _ = sp.predict(marcel, None, keys)
        _x, _n, lg = sp.s.design(keys, sp.J)
        last = np.array([sp.s.v.get((pid, T - 1), (np.nan, 0))[0] for pid, _ in keys])
        ok = has & np.isfinite(last)
        if ok.sum() < 30:
            continue
        per.append({"season": T, "n": int(ok.sum()), "w": w[ok], "y": y[ok],
                    "learned": pl[ok], "marcel": pm[ok], "last": last[ok], "league": lg[ok]})
    if not per:
        return None
    cat = lambda k: np.concatenate([p[k] for p in per])
    W, Y = cat("w"), cat("y")
    out = {"seasons": [p["season"] for p in per], "n": int(sum(p["n"] for p in per))}
    for m in ("league", "last", "marcel", "learned"):
        out[f"rmse_{m}"] = bp.wrmse(cat(m) - Y, W)
        out[f"r_{m}"] = float(np.corrcoef(cat(m), Y)[0, 1]) if m != "league" else np.nan
    out["per_season"] = [{"season": p["season"], "n": p["n"],
                          **{f"rmse_{m}": bp.wrmse(p[m] - p["y"], p["w"])
                             for m in ("league", "last", "marcel", "learned")}} for p in per]
    out["rows"] = {"y": Y, "w": W, "learned": cat("learned"), "last": cat("last")}
    return out


def fit_stat(label, df, den, lower_better, ages, signals, cls=bp.StatProjector, layers=False,
             eligible_layers=()):
    ser = bp.Series(df, label, den, bp.MIN_TARGET.get(den, 100))
    if len(ser.seasons) < 2:
        return None
    J = min(bp.MAX_LAGS, len(ser.seasons) - 1)
    sp = cls(label, ser, ages, signals, J)
    targets = [s for s in ser.seasons[1:] if s not in bp.SKIP_TARGET_SEASONS]
    wf = walkforward(sp, targets[-3:])
    bp.ci_backtest(sp, targets[-bp.CI_SEASONS:])
    raw_rows = {k: v.copy() for k, v in sp.ci_rows.items()} if sp.ci_rows else None
    lean = bp.fit_bias(sp)
    base = sp.fit_base(set(ser.seasons))
    if base is None:
        return None
    ci_fit = bp.fit_ci(sp.ci_rows) if sp.ci_rows is not None else None
    coverage = bp.ci_coverage(sp.ci_rows) if ci_fit else None

    layer_cmp, chosen = None, "base"
    variants = ["base"] + [v for v in eligible_layers
                           if all(s in signals for s in bp.VARIANT_SIGNALS[v])]
    if layers and len(variants) > 1:
        sig_seasons = sorted(set.intersection(*[set(signals[n].s.seasons)
                                                for v in variants[1:] for n in bp.VARIANT_SIGNALS[v]]))
        layer_targets = [s + 1 for s in sig_seasons if s + 1 in ser.seasons]
        loso = bp.compare_layers(sp, variants, layer_targets, "loso")
        layer_cmp = {"loso": loso, "variants": variants}
        if loso:
            best = min(variants, key=lambda v: loso[v])
            if best != "base" and loso[best] < loso["base"] * (1 - bp.LAYER_MIN_GAIN):
                chosen = best
    last = max(ser.seasons)
    return {"label": label, "sp": sp, "base": base, "desc": base.describe(), "den": den, "J": J,
            "lower_better": lower_better, "wf": wf, "lean": lean, "raw_rows": raw_rows,
            "ci_fit": ci_fit, "coverage": coverage, "layer_cmp": layer_cmp, "layer": chosen,
            "lg_last": ser.lg[last], "sd_last": ser.sd.get(last, np.nan), "last": last}


def fit_side(side, history="history", public="private_out", layers=False, only=None, progress=True):
    """Fit every stat for 'hitters' or 'pitchers'. layers=True also reruns the
    iSwing+/grades layer checks (slower). only = list of stat labels to limit to."""
    history, public = Path(history), Path(public)
    ages = bp.load_ages(history)
    signals, stats = {}, []
    if side == "hitters":
        h = bp.load_history(public, history)
        isw = bp.load_iswing(history)
        if isw is not None:
            specs = [("iswing", "n_swings", None)]
            if "swing_residual" in isw.columns:
                specs += [("xwobacon_swing", "n_bbe", None), ("swing_residual", "n_bbe", 0.0)]
            for col, den, center in specs:
                if col in isw.columns:
                    ser = bp.Series(isw, col, den, bp.MIN_TARGET[den], center=center)
                    signals[col] = bp.StatProjector(col, ser, ages, {}, min(bp.MAX_LAGS, max(1, len(ser.seasons) - 1)))
        for lab, _f, lb, _d, prefs, _fam in bp.CARD_STATS:
            lay = (["iswing"] if lab in bp.ISWING_ELIGIBLE else []) + (["swing_resid"] if lab in bp.RESIDUAL_ELIGIBLE else [])
            stats.append((lab, lb, prefs, lay))
        for lab in bp.XRV_STATS:
            stats.append((lab, False, ["pa_xrv"], ["iswing"] if lab in bp.ISWING_ELIGIBLE else []))
        cls, fam = bp.StatProjector, FAMILY
    else:
        h = pd.read_csv(history / "pitcher_history.csv")
        h["player_id"] = h["player_id"].astype(int)
        h["season"] = h["season"].astype(int)
        for c in [lab for lab, *_ in PITCHER_CARD] + PITCHER_GRADES + ["ip", "bf", "pitches", "model_resid"]:
            if c in h.columns:
                h[c] = pd.to_numeric(h[c], errors="coerce")
        for col, center in [(g, None) for g in PITCHER_GRADES] + [("model_resid", 0.0)]:
            if col in h.columns and h[col].notna().any():
                ser = bp.Series(h, col, "pitches", bp.MIN_TARGET["pitches"], center=center)
                if len(ser.seasons) >= 2:
                    signals[col] = PitcherProjector(col, ser, ages, {}, min(bp.MAX_LAGS, len(ser.seasons) - 1))
        for lab, lb, prefs in PITCHER_CARD:
            stats.append((lab, lb, prefs, ["grades", "stuff"] + (["model_resid"] if lab in PITCHER_RESID_ELIGIBLE else [])))
        cls, fam = PitcherProjector, PITCHER_FAMILY

    if ages is not None:
        recent = set(h.loc[h.season >= h.season.max() - 2, "player_id"])
        share = np.mean([pid in ages for pid in recent]) if recent else 0.0
        if share < 0.8:
            print(f"⚠ birthdates cover only {share:.0%} of recent {side} — aging curves fit on so few "
                  f"players can run away. Rebuild history/birthdates.json (backfill script) first.")
    res = {}
    for lab, lb, prefs, lay in stats:
        if only and lab not in only:
            continue
        if lab not in h.columns or h[lab].notna().sum() < bp.MIN_FIT_ROWS:
            continue
        den = bp.pick_denom(h, prefs, lab) if prefs != ["ip"] else "ip"
        if progress:
            print(f"  fitting {lab} …", end="\r", flush=True)
        r = fit_stat(lab, h, den, lb, ages, signals, cls, layers, lay)
        if r is not None:
            r["family"] = fam.get(lab, "")
            res[lab] = r
    # stats with a single backtest season get the drift widening the build applies
    metas = {lab: {**r["ci_fit"]} for lab, r in res.items() if r["ci_fit"]}
    widen = bp.drift_widen(metas)
    if progress:
        print(f"Fitted {len(res)} {side} stats on {h.season.min()}–{h.season.max()} "
              f"({len(h):,} player-seasons). Drift widening for one-season stats: ×{widen:.2f}")
    return {"side": side, "stats": res, "history": h, "ages": ages, "signals": signals, "widen": widen,
            "seasons": sorted(h.season.unique().tolist())}


# ═══════════════════════════════════════════════════════════════════════════
# TABLES
# ═══════════════════════════════════════════════════════════════════════════
def _visible(S):
    return {k: r for k, r in S["stats"].items() if not k.startswith("_")}


def table_data(S):
    h = S["history"]
    t = h.groupby("season").agg(players=("player_id", "nunique")).reset_index()
    return save_table(t, f"{S['side']}_data_by_season")


def table_model(S):
    """Fitted season weights, regression constant k, aging and the share of the
    projection that comes from his own stats after one full season."""
    rows = []
    for lab, r in _visible(S).items():
        d, full = r["desc"], _full_n(r)
        rows.append({"stat": lab, "family": r["family"], "sample": r["den"],
                     **{f"w{j+1}": d["weights"][j] if j < len(d["weights"]) else np.nan for j in range(bp.MAX_LAGS)},
                     "k": d["k"], "full_season": round(full),
                     "own_share_1_full_season": round(full / (full + d["k"]), 3),
                     "age_a1": d["age_a1"], "age_a2": d["age_a2"],
                     "peak_age": _peak(d), "fit_rows": r["base"].n_fit})
    return save_table(pd.DataFrame(rows), f"{S['side']}_model")


def table_backtest(S):
    rows = []
    for lab, r in _visible(S).items():
        wf = r["wf"]
        if not wf:
            continue
        rows.append({"stat": lab, "seasons": "/".join(map(str, wf["seasons"])), "rows": wf["n"],
                     "rmse_league_avg": wf["rmse_league"], "rmse_last_season": wf["rmse_last"],
                     "rmse_marcel_5_4_3": wf["rmse_marcel"], "rmse_learned": wf["rmse_learned"],
                     "gain_vs_last_season": 1 - wf["rmse_learned"] / wf["rmse_last"],
                     "gain_vs_marcel": 1 - wf["rmse_learned"] / wf["rmse_marcel"],
                     "r_last_season": wf["r_last"], "r_learned": wf["r_learned"]})
    return save_table(pd.DataFrame(rows), f"{S['side']}_backtest")


def table_lean(S):
    rows = []
    for lab, r in _visible(S).items():
        b = r["lean"]
        if not b:
            continue
        rows.append({"stat": lab, "beta": b.get("beta"), "applied": b.get("kept", False),
                     "wins": b.get("wins"), "tests": b.get("tests"),
                     "rmse_before": b.get("rmse_before"), "rmse_after": b.get("rmse_after"),
                     "note": b.get("why", "")})
    return save_table(pd.DataFrame(rows), f"{S['side']}_lean_correction")


def table_coverage(S):
    rows = []
    for lab, r in _visible(S).items():
        cov, f = r["coverage"], r["ci_fit"]
        if not f:
            continue
        row = {"stat": lab, "backtest_seasons": f["n_seasons"],
               "c0": f["c0"], "a": f["a"], "b": f["b"],
               "scale": "logit" if bp.prop_scale(r["sp"]) else "linear"}
        for L in bp.CI_LEVEL_LIST:
            vals = list((cov or {}).get(L, {}).values())
            row[f"cover_{L}"] = np.mean(vals) if vals else np.nan
        rows.append(row)
    return save_table(pd.DataFrame(rows), f"{S['side']}_interval_calibration")


def table_layers(S):
    rows = []
    for lab, r in _visible(S).items():
        lc = r["layer_cmp"]
        if not lc or not lc.get("loso"):
            continue
        lo = lc["loso"]
        rows.append({"stat": lab, "rows": lo["n"], **{f"rmse_{v}": lo[v] for v in lc["variants"]},
                     "chosen": r["layer"]})
    return save_table(pd.DataFrame(rows), f"{S['side']}_layer_check")


def table_stability(S):
    """How sticky each stat is year to year, next to what the fitted k implies.
    For one season of sample n, regression to the mean keeps n/(n+k) of a player's
    gap from average, so that share should track the Y→Y+1 correlation."""
    rows = []
    for lab, r in _visible(S).items():
        ser = r["sp"].s
        a, b, ns = [], [], []
        for (pid, s), (v, n) in ser.v.items():
            nxt = ser.v.get((pid, s + 1))
            if nxt and n >= ser.min_target and nxt[1] >= ser.min_target and s + 1 not in bp.SKIP_TARGET_SEASONS:
                a.append(v - ser.lg[s]); b.append(nxt[0] - ser.lg[s + 1]); ns.append(n)
        if len(a) < 30:
            continue
        nmed, k = float(np.median(ns)), r["desc"]["k"]
        rows.append({"stat": lab, "pairs": len(a), "r_year_to_year": float(np.corrcoef(a, b)[0, 1]),
                     "median_sample": round(nmed), "k": k, "implied_n_over_n_plus_k": nmed / (nmed + k)})
    return save_table(pd.DataFrame(rows), f"{S['side']}_stability")


def plot_stability(S):
    t = table_stability(S)
    fig, ax = plt.subplots(figsize=(6.5, 6))
    ax.scatter(t["implied_n_over_n_plus_k"], t["r_year_to_year"], color=PALETTE[0], zorder=3)
    placed = []
    for _, r in t.sort_values("r_year_to_year").iterrows():
        x, y = r["implied_n_over_n_plus_k"], r["r_year_to_year"]
        dy = 0.0
        while any(abs(x - px) < 0.12 and abs(y + dy - py) < 0.022 for px, py in placed):
            dy -= 0.022
        placed.append((x, y + dy))
        ax.annotate(r["stat"], (x, y), xytext=(x + 0.015, y + dy), fontsize=7, va="center",
                    arrowprops=dict(arrowstyle="-", color="#94a3b8", lw=0.5) if dy else None)
    ax.plot([0, 1], [0, 1], color=INK, lw=0.8)
    ax.set(xlim=(0, 1.15), ylim=(0, 1), xlabel="Model: n / (n + k) at the typical sample",
           ylabel="Data: year-to-year r", title=f"{S['side'].title()}: regression matches stickiness")
    save(fig, f"{S['side']}_stability")
    return fig


def _full_n(r):
    sp = r["sp"]
    last_n = [n for (_p, s), (_v, n) in sp.s.v.items() if s == r["last"] and n >= sp.s.min_target]
    return float(np.percentile(last_n, 90)) if last_n else float(sp.s.min_target)


def _peak(d):
    a1, a2 = d["age_a1"], d["age_a2"]
    if a2 >= 0 or not np.isfinite(a2):
        return np.nan
    return round(bp.AGE_CENTER - a1 / (2 * a2), 1)


# ═══════════════════════════════════════════════════════════════════════════
# GRAPHICS
# ═══════════════════════════════════════════════════════════════════════════
def _grid(n, ncols=4, w=3.6, h=2.8):
    nrows = int(np.ceil(n / ncols))
    fig, axes = plt.subplots(nrows, ncols, figsize=(w * ncols, h * nrows), squeeze=False)
    for ax in axes.flat[n:]:
        ax.set_visible(False)
    return fig, axes.flat


def plot_weights(S, stats=None, ncols=2):
    """How much each past season counts (last season = 1), one panel per stat family."""
    R = _visible(S)
    stats = stats or list(R)
    fams = list(dict.fromkeys(R[s]["family"] for s in stats))
    fig, axes = _grid(len(fams), ncols, 5.2, 3.6)
    for ax, fam in zip(axes, fams):
        mine = [s for s in stats if R[s]["family"] == fam]
        for i, s in enumerate(mine):
            w = R[s]["desc"]["weights"]
            ax.plot(range(1, len(w) + 1), w, "-o", color=PALETTE[i % len(PALETTE)] if len(mine) <= len(PALETTE)
                    else plt.cm.tab20(i % 20), lw=1.6, ms=4, label=s)
        ax.plot([1, 2, 3, 4, 5], [1, .8, .6, .4, .2], "--", color=INK, lw=1.2, label="Marcel 5/4/3/2/1")
        ax.set(title=fam, xticks=range(1, bp.MAX_LAGS + 1), ylim=(0, 1.05), xlabel="Seasons back (1 = last season)")
        ax.legend(fontsize=7, ncol=2 if len(mine) > 6 else 1)
    fig.suptitle(f"{S['side'].title()}: learned season weights (per unit of sample)", fontweight="bold")
    fig.tight_layout()
    save(fig, f"{S['side']}_weights")
    return fig


def plot_shrinkage(S, stats=None, max_n=None):
    """Share of the projection that is the player's own record, after one season of
    sample n: n / (n + k). The rest is league average."""
    R = _visible(S)
    stats = stats or list(R)
    fig, ax = plt.subplots(figsize=(9, 5))
    max_n = max_n or max(_full_n(R[s]) for s in stats) * 1.1
    n = np.linspace(0, max_n, 300)
    order = sorted(stats, key=lambda s: R[s]["desc"]["k"])
    for i, s in enumerate(order):
        k = R[s]["desc"]["k"]
        ax.plot(n, n / (n + k), color=plt.cm.viridis(i / max(1, len(order) - 1)), lw=1.5,
                label=f"{s} (k={k:.0f} {R[s]['den']})")
    ax.axhline(0.5, color=INK, lw=0.8, ls=":")
    ax.set(xlabel="One season of sample (PA / BIP / swings / BF / IP — the stat's own unit)",
           ylabel="Weight on his own stat", ylim=(0, 1), title=f"{S['side'].title()}: how fast each stat earns trust")
    ax.legend(fontsize=7, ncol=2, loc="lower right")
    save(fig, f"{S['side']}_shrinkage")
    return fig


def plot_composition(S, stats=None, seasons=3):
    """For a full-time player with `seasons` straight full seasons: the share of his
    projection that comes from each season and from the league average."""
    R = _visible(S)
    stats = stats or list(R)
    rows = []
    for s in stats:
        w, k, n = R[s]["desc"]["weights"], R[s]["desc"]["k"], _full_n(R[s])
        parts = [w[j] * n for j in range(min(seasons, len(w)))]
        tot = sum(parts) + k
        rows.append([p / tot for p in parts] + [k / tot])
    rows = np.array(rows)
    fig, ax = plt.subplots(figsize=(9, 0.32 * len(stats) + 1.4))
    left = np.zeros(len(stats))
    labels = [f"{j+1} season{'s' if j else ''} back" if j else "Last season" for j in range(rows.shape[1] - 1)] + ["League average"]
    colors = PALETTE[: rows.shape[1] - 1] + ["#cbd5e1"]
    for j in range(rows.shape[1]):
        ax.barh(stats, rows[:, j], left=left, color=colors[j], label=labels[j])
        left += rows[:, j]
    ax.invert_yaxis()
    ax.set(xlim=(0, 1), xlabel="Share of the projection",
           title=f"{S['side'].title()}: what a projection is made of (full-time player, {seasons} full seasons)")
    ax.legend(fontsize=8, ncol=rows.shape[1], loc="upper center", bbox_to_anchor=(0.5, -0.12 - 0.6 / len(stats)))
    save(fig, f"{S['side']}_composition")
    return fig


def plot_aging(S, stats=None, ncols=4):
    """Fitted aging curve per stat, in league standard deviations (up = better)."""
    R = _visible(S)
    stats = [s for s in (stats or list(R)) if np.isfinite(R[s]["sd_last"]) and R[s]["sd_last"] > 0]
    lo, hi = PITCHER_AGE if S["side"] == "pitchers" else (21, 38)
    ages = np.arange(lo, hi + 1)
    fig, axes = _grid(len(stats), ncols)
    for ax, s in zip(axes, stats):
        d = R[s]["desc"]
        a = ages - bp.AGE_CENTER
        z = (d["age_a1"] * a + d["age_a2"] * a * a) / R[s]["sd_last"] * (-1 if R[s]["lower_better"] else 1)
        ax.axhline(0, color=INK, lw=0.8)
        ax.plot(ages, z, color=PALETTE[0], lw=2)
        ax.fill_between(ages, z, 0, where=z >= 0, color="#10b981", alpha=0.15)
        ax.fill_between(ages, z, 0, where=z < 0, color="#ef4444", alpha=0.15)
        ax.set_title(s, fontsize=10)
        ax.set_xlabel("Age", fontsize=8)
        ax.set_xticks(range(lo + (lo % 2), hi + 1, 3))
    fig.suptitle(f"{S['side'].title()}: aging curves (league SDs vs age 28, up = better)", fontweight="bold")
    fig.tight_layout()
    save(fig, f"{S['side']}_aging")
    return fig


def plot_backtest(S):
    """Walk-forward error of each method, relative to 'just use last season'."""
    t = table_backtest(S)
    if t.empty:
        print("no walk-forward seasons")
        return None
    t = t.sort_values("gain_vs_last_season")
    y = np.arange(len(t))
    fig, ax = plt.subplots(figsize=(9, 0.32 * len(t) + 1.5))
    # (league average is in the table; it is so much worse it would flatten this chart)
    for col, lab, c, off in [("rmse_marcel_5_4_3", "Marcel 5/4/3 (k fitted)", PALETTE[1], -0.2),
                             ("rmse_learned", "Learned model", PALETTE[0], 0.2)]:
        ax.barh(y + off, 1 - t[col] / t["rmse_last_season"], height=0.38, color=c, label=lab)
    ax.axvline(0, color=INK, lw=1)
    ax.set_yticks(y, t["stat"])
    ax.set(xlabel="Error reduction vs last season's value (weighted RMSE; right = better)",
           title=f"{S['side'].title()}: walk-forward backtest ({t['seasons'].iloc[0].replace('/', ', ')})")
    ax.xaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v:+.0%}"))
    ax.legend(fontsize=8, loc="lower right")
    save(fig, f"{S['side']}_backtest")
    return fig


def plot_backtest_scatter(S, stats, ncols=4):
    """Projected vs actual in the walk-forward seasons, with last season for contrast."""
    R = _visible(S)
    stats = [s for s in stats if R.get(s, {}).get("wf")]
    fig, axes = _grid(len(stats), ncols, 3.4, 3.2)
    for ax, s in zip(axes, stats):
        rw = R[s]["wf"]["rows"]
        ax.scatter(rw["last"], rw["y"], s=5, color="#cbd5e1", label=f"last season r={R[s]['wf']['r_last']:.2f}")
        ax.scatter(rw["learned"], rw["y"], s=5, color=PALETTE[0], alpha=0.6,
                   label=f"projection r={R[s]['wf']['r_learned']:.2f}")
        lim = np.nanpercentile(np.r_[rw["y"], rw["last"]], [1, 99])
        ax.plot(lim, lim, color=INK, lw=0.8)
        ax.set(xlim=lim, ylim=lim, title=s, xlabel="predicted", ylabel="actual")
        ax.legend(fontsize=7, loc="upper left")
    fig.tight_layout()
    save(fig, f"{S['side']}_backtest_scatter")
    return fig


def lean_examples(S, n=3):
    """Stats to illustrate the lean correction: the applied ones with the biggest
    error cut, else (none applied) the largest |β| as a counter-example."""
    t = table_lean(S).dropna(subset=["beta"])
    app = t[t["applied"] == True].assign(cut=lambda d: d["rmse_before"] / d["rmse_after"]).sort_values("cut", ascending=False)
    if len(app):
        return app["stat"].head(n).tolist()
    return t.reindex(t["beta"].abs().sort_values(ascending=False).index)["stat"].head(1).tolist()


def plot_lean(S, stat, bins=8):
    """Miss (actual − projection) by how thin a player's history is, before and after
    the lean correction β·k/(H+k)."""
    r = _visible(S)[stat]
    rows = r["raw_rows"]
    if rows is None:
        return None
    x = rows["k"] / (rows["H"] + rows["k"])
    e = rows["y"] - rows["pl"]
    beta = (r["lean"] or {}).get("beta") or 0.0
    edges = np.quantile(x, np.linspace(0, 1, bins + 1))
    idx = np.clip(np.searchsorted(edges, x, side="right") - 1, 0, bins - 1)
    mx = [x[idx == i].mean() for i in range(bins)]
    m0 = [e[idx == i].mean() for i in range(bins)]
    m1 = [(e - beta * x)[idx == i].mean() for i in range(bins)]
    fig, ax = plt.subplots(figsize=(7, 4.2))
    ax.axhline(0, color=INK, lw=0.8)
    ax.plot(mx, m0, "-o", color=PALETTE[3], label="before (plain Marcel-style regression)")
    ax.plot(mx, m1, "-o", color=PALETTE[0], label=f"after (+β·k/(H+k), β={beta:+.4g})")
    applied = (r["lean"] or {}).get("kept")
    ax.set(xlabel="k / (H + k)   (0 = long full-time history, 1 = almost none)",
           ylabel=f"Average miss, actual − projected ({stat})",
           title=f"{S['side'].title()} {stat}: lean correction {'(applied)' if applied else '(not applied)'}")
    ax.legend(fontsize=8)
    save(fig, f"{S['side']}_lean_{_slug(stat)}")
    return fig


def plot_spread(S, stat, bins=10):
    """Does the spread formula σ² = c0 + a/(H+k) + b/n match the real misses?"""
    r = _visible(S)[stat]
    rows, f = r["sp"].ci_rows, r["ci_fit"]
    if not f:
        return None
    sig = bp.ci_sigma(f, rows["H"], rows["k"], rows["nt"])
    edges = np.quantile(sig, np.linspace(0, 1, bins + 1))
    idx = np.clip(np.searchsorted(edges, sig, side="right") - 1, 0, bins - 1)
    ps = [sig[idx == i].mean() for i in range(bins)]
    ob = [np.sqrt(np.mean(rows["err"][idx == i] ** 2)) for i in range(bins)]
    fig, ax = plt.subplots(figsize=(5.5, 5))
    ax.plot(ps, ob, "o", color=PALETTE[0], ms=7)
    lim = [0, max(max(ps), max(ob)) * 1.1]
    ax.plot(lim, lim, color=INK, lw=0.8)
    unit = "logit units" if bp.prop_scale(r["sp"]) else "stat units"
    ax.set(xlim=lim, ylim=lim, xlabel=f"Predicted spread σ ({unit})", ylabel="Observed RMS miss",
           title=f"{stat}: spread model check")
    save(fig, f"{S['side']}_spread_{_slug(stat)}")
    return fig


def plot_coverage(S):
    """Out-of-season calibration: share of actual outcomes inside each band vs the
    band's nominal level (each season scored with bands fit on the other seasons)."""
    t = table_coverage(S)
    t = t[t[[f"cover_{L}" for L in bp.CI_LEVEL_LIST]].notna().any(axis=1)]
    if t.empty:
        print("Every stat has a single backtest season here — calibration needs ≥2 (use the full 2015– history).")
        return None
    fig, ax = plt.subplots(figsize=(6, 5.5))
    for _, row in t.iterrows():
        ax.plot(bp.CI_LEVEL_LIST, [row[f"cover_{L}"] for L in bp.CI_LEVEL_LIST], "-o", color=PALETTE[0], alpha=0.35, ms=3, lw=1)
    avg = [t[f"cover_{L}"].mean() for L in bp.CI_LEVEL_LIST]
    ax.plot(bp.CI_LEVEL_LIST, avg, "-o", color=PALETTE[3], lw=2.5, ms=7, label="average over stats")
    ax.plot([0, 100], [0, 100], color=INK, lw=0.8, label="perfect calibration")
    ax.set(xlim=(15, 95), ylim=(15, 95), xlabel="Band's nominal level (%)",
           ylabel="Actual outcomes inside the band (%)",
           title=f"{S['side'].title()}: are the ranges honest?")
    ax.legend(fontsize=8, loc="upper left")
    save(fig, f"{S['side']}_coverage")
    return fig


def plot_coverage_heatmap(S, level=90):
    R = _visible(S)
    data = {s: r["coverage"][level] for s, r in R.items() if r["coverage"] and r["coverage"].get(level)}
    if not data:
        return None
    seasons = sorted({y for d in data.values() for y in d})
    M = np.array([[data[s].get(y, np.nan) for y in seasons] for s in data])
    fig, ax = plt.subplots(figsize=(1.0 * len(seasons) + 3, 0.3 * len(data) + 1.5))
    im = ax.imshow(M - level, cmap="RdBu", vmin=-12, vmax=12, aspect="auto")
    for i in range(M.shape[0]):
        for j in range(M.shape[1]):
            if np.isfinite(M[i, j]):
                ax.text(j, i, f"{M[i, j]:.0f}", ha="center", va="center", fontsize=7,
                        color="white" if abs(M[i, j] - level) > 7 else INK)
    ax.set_xticks(range(len(seasons)), seasons)
    ax.set_yticks(range(len(data)), list(data))
    ax.grid(False)
    fig.colorbar(im, ax=ax, label=f"coverage − {level}% (points)")
    ax.set_title(f"{S['side'].title()}: {level}% band coverage by season (fit on the other seasons)")
    save(fig, f"{S['side']}_coverage_{level}_by_season")
    return fig


def plot_miss_shape(S, stat):
    """Standardized misses z = err/σ against a bell curve: the edges use these
    empirical quantiles, so skew and fat tails are kept."""
    r = _visible(S)[stat]
    rows, f = r["sp"].ci_rows, r["ci_fit"]
    if not f:
        return None
    z = rows["err"] / bp.ci_sigma(f, rows["H"], rows["k"], rows["nt"])
    fig, ax = plt.subplots(figsize=(7, 4))
    ax.hist(z, bins=60, density=True, color=PALETTE[0], alpha=0.5, label="standardized misses")
    g = np.linspace(-4, 4, 200)
    ax.plot(g, np.exp(-g * g / 2) / np.sqrt(2 * np.pi), color=INK, lw=1, label="normal curve")
    for p, q in zip(bp.CI_PCTS, f["q"]):
        if p in (5, 95):
            ax.axvline(q, color=PALETTE[3], lw=1.2, ls="--")
    ax.set(xlim=(-4, 4), xlabel="z = miss / σ", title=f"{stat}: shape of the misses (dashed = 5th/95th edges)")
    ax.legend(fontsize=8)
    save(fig, f"{S['side']}_miss_shape_{_slug(stat)}")
    return fig


# ── Player fan chart (reads the published 2027P projection file) ──
LEVEL_SHADE = {90: 0.18, 75: 0.32, 50: 0.5, 25: 0.85}
PROJ_DOT = "#f59e0b"


def load_projection(public="private_out", target=2027):
    p = Path(public) / f"baseball_data_{target}P.json"
    d = json.load(open(p))
    xp = Path(public) / f"hitter_xrv_{target}P.json"
    d["_xrv"] = json.load(open(xp)) if xp.exists() else {}
    return d


def find_player(proj, name, side="hitters"):
    hits = [p for p in proj.get(side, []) if name.lower() in (p.get("name") or "").lower()]
    if not hits:
        raise KeyError(f"No {side[:-1]} matching {name!r}")
    return hits[0]


def plot_fan(proj, name, side="hitters", stats=None, xrv=False):
    """The Ranges-tab picture for one player: each stat on a common axis of league
    SDs from last season's average (right = better), with nested 90/75/50/25% bands,
    the projection (dot) and last season (ring)."""
    p = find_player(proj, name, side)
    meta = proj["meta"] if side == "hitters" else proj.get("pitcher_meta", {})
    lower = set(meta.get("lower_better", []))
    if xrv:
        cats = proj["_xrv"].get(str(p["player_id"]), {}).get("metrics", {})
        pools = proj["meta"].get("xrv_pools", {})
        lower = set()
    else:
        cats, pools = p["categories"], meta.get("pools", {})
    stats = [s for s in (stats or list(cats)) if (cats.get(s) or {}).get("ci") and s in pools]
    fig, ax = plt.subplots(figsize=(9, 0.5 * len(stats) + 1.4))
    ax.axvspan(-1, 1, color="#e2e8f0", alpha=0.6, lw=0)
    ax.axvline(0, color=INK, lw=0.8)
    for i, s in enumerate(stats):
        pool = np.asarray(pools[s], float)
        m, sd = pool.mean(), pool.std(ddof=1) or 1
        sign = -1 if s in lower else 1
        Z = lambda v: np.clip(sign * (v - m) / sd, -3.5, 3.5)
        ci = cats[s]["ci"]
        for L in sorted(bp.CI_LEVEL_LIST, reverse=True):
            a, b = (100 - L) / 2, 100 - (100 - L) / 2
            ka, kb = ("p" + f"{a:g}".replace(".", "_"), "p" + f"{b:g}".replace(".", "_"))
            za, zb = sorted([Z(ci[ka]), Z(ci[kb])])
            ax.barh(i, zb - za, left=za, height=0.5, color=PALETTE[0], alpha=LEVEL_SHADE[L], lw=0)
        ax.plot(Z(cats[s]["value"]), i, "o", color=PROJ_DOT, mec="white", mew=1.2, ms=8, zorder=3)
        if (cats[s].get("last") or {}).get("value") is not None:
            ax.plot(Z(cats[s]["last"]["value"]), i, "o", mfc="none", mec=INK, mew=1.6, ms=10, zorder=4)
    ax.set_yticks(range(len(stats)), stats)
    ax.invert_yaxis()
    ax.set_xlim(-3.5, 3.5)
    from matplotlib.patches import Patch
    from matplotlib.lines import Line2D
    handles = [Patch(color=PALETTE[0], alpha=LEVEL_SHADE[L], label=f"{L}% range") for L in sorted(bp.CI_LEVEL_LIST, reverse=True)]
    handles += [Line2D([], [], marker="o", ls="", color=PROJ_DOT, mec="white", ms=8, label="2027 projection"),
                Line2D([], [], marker="o", ls="", mfc="none", mec=INK, mew=1.6, ms=9, label="last season")]
    ax.legend(handles=handles, fontsize=8, ncol=6, loc="upper center", bbox_to_anchor=(0.5, -0.08 - 0.4 / max(1, len(stats))))
    ax.set(xlabel=f"League SDs from last season's average (right = better)",
           title=f"{p['name']}: 2027 ranges")
    save(fig, f"fan_{_slug(p['name'])}{'_xrv' if xrv else ''}")
    return fig


def _slug(s):
    return "".join(c if c.isalnum() else "_" for c in s).strip("_").lower()
