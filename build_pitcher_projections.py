#!/usr/bin/env python3
"""
build_pitcher_projections.py — 2027 projected PITCHER cards, built the same way as
build_projections.py builds the hitter cards (it imports that file's machinery).

For every pitcher-card stat and for Stuff+/Loc+/Tun+/Pitch+ it learns from history:
  • season weights (last season = 1, older seasons never count more)
  • regression toward league average (k, in that stat's own sample units)
  • an aging curve per stat (quadratic in age, ages clamped to 22–37), fitted jointly
    with the weights — so FB velo, whiff, K%, … each get their own decline

Then, only where a held-out-season backtest says it helps, it stacks on:
  • grades       projected Stuff+, Loc+, Tun+, Pitch+ (any card stat)
  • stuff        projected Stuff+ alone (any card stat)
  • model_resid  projected Pitch+ + the pitcher's regressed "beats his pitch model"
                 residual (actual RV − model xRV per 100 pitches) — run-prevention
                 stats only

INPUTS   history/pitcher_history.csv   (backfill_pitcher_history.py)
         history/birthdates.json       (optional; enables aging)
OUTPUT   {public}/baseball_data_{T}P.json — fills "pitchers" + "pitcher_metrics" and
         keeps the hitters already there; each pitcher also gets "grades"
         {public}/pitcher_projection_report.json / .csv

USAGE
  python3 build_pitcher_projections.py --public ./private_out --history ./history
"""

import argparse
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd

import build_projections as bp
import baseball_pipeline as pipe

bp.log = print

LABEL_FMT = {m["label"]: m for m in pipe.PITCHER_METRICS}
# label → (sample-size preferences, lower_better)
RATE = ["bf", "ip"]
CARD = [(m["label"], RATE if m["key"] not in ("siera", "fip", "avg_fb_velo") else ["ip"], m["lower_better"])
        for m in pipe.PITCHER_METRICS]
GRADES = [("stuff_plus", "Stuff+"), ("loc_plus", "Location+"), ("tun_plus", "Tunnel+"), ("pitch_plus", "Pitch+")]
RESID_ELIGIBLE = {"xwOBA", "xBA", "xSLG", "FIP", "SIERA", "Barrel%", "Avg Exit Velo"}
AGE_LO, AGE_HI = 22, 37
GRADE_POOL_MIN = 200          # pitches — same pool as /pitcher_percentiles
CARD_POOL_MIN_IP = 10         # same pool as the live card (MIN_PITCHER_IP)

bp.MIN_TARGET.update({"bf": 100, "ip": 20, "pitches": 300})
bp.VARIANT_SIGNALS.clear()
bp.VARIANT_SIGNALS.update({
    "base": [],
    "grades": ["stuff_plus", "loc_plus", "tun_plus", "pitch_plus"],
    "stuff": ["stuff_plus"],
    "model_resid": ["pitch_plus", "model_resid"],
})


class PitcherProjector(bp.StatProjector):
    """Same model as the hitters', with ages clamped so the quadratic can't run away
    at the thinly populated ends."""
    def _age(self, keys):
        a = super()._age(keys)
        return np.where(np.isfinite(a), np.clip(a, AGE_LO, AGE_HI), a)


def fmt(label, v):
    if v is None or not np.isfinite(v):
        return "—"
    m = LABEL_FMT.get(label)
    if m is None:
        return f"{v:.1f}"
    shown = v * 100 if m.get("pct_stored_decimal") else v
    s = format(shown, m["fmt"])
    return s[1:] if m["fmt"] == ".3f" and s.startswith("0.") else s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--public", default="./private_out")
    ap.add_argument("--history", default="./history")
    ap.add_argument("--target", type=int, default=2027)
    ap.add_argument("--min-recent-ip", type=float, default=40,
                    help="project pitchers with at least this many IP over the last 3 seasons")
    args = ap.parse_args()
    public, hist_dir, T = Path(args.public), Path(args.history), args.target
    LAST = T - 1

    p = hist_dir / "pitcher_history.csv"
    if not p.exists():
        raise SystemExit(f"{p} not found — run backfill_pitcher_history.py first.")
    h = pd.read_csv(p)
    h["player_id"] = h["player_id"].astype(int)
    h["season"] = h["season"].astype(int)
    for c in [lab for lab, *_ in CARD] + [g for g, _ in GRADES] + ["ip", "bf", "pitches", "model_resid"]:
        if c in h.columns:
            h[c] = pd.to_numeric(h[c], errors="coerce")
    print(f"History: {p}  ({len(h):,} pitcher-seasons, {h.season.min()}–{h.season.max()})")
    ages = bp.load_ages(hist_dir)

    # ── Signals: the four grades and the model residual, each a learned-weight series ──
    signals = {}
    for col, center in [("stuff_plus", None), ("loc_plus", None), ("tun_plus", None),
                        ("pitch_plus", None), ("model_resid", 0.0)]:
        if col in h.columns and h[col].notna().any():
            ser = bp.Series(h, col, "pitches", bp.MIN_TARGET["pitches"], center=center)
            if len(ser.seasons) >= 2:
                signals[col] = PitcherProjector(col, ser, ages, {}, min(bp.MAX_LAGS, len(ser.seasons) - 1))
    if "model_resid" in h.columns:
        r = h[h["pitches"] >= 1000][["player_id", "season", "model_resid"]].dropna()
        nxt = r.copy(); nxt["season"] -= 1
        m = r.merge(nxt, on=["player_id", "season"], suffixes=("", "_next"))
        if len(m) >= 30:
            print(f"\nModel-residual stickiness (Y vs Y+1, ≥1000 pitches): r = "
                  f"{m['model_resid'].corr(m['model_resid_next']):+.3f}  (n={len(m)})")

    report, projectors = [], {}
    print("\n" + "═" * 112)
    print(f"{'stat':18s}{'denom':>8s}{'J':>3s}  {'weights (last→oldest)':28s}{'k':>8s}"
          f"{'  RMSE last-yr':>14s}{'5/4/3':>9s}{'learned':>9s}{'gain':>8s}  layer")
    print("─" * 112)
    for label, prefs, lower_better in CARD:
        if label not in h.columns or h[label].notna().sum() < bp.MIN_FIT_ROWS:
            print(f"{label:18s}  (not in history — skipped)")
            continue
        den = bp.pick_denom(h, prefs, label) if prefs != ["ip"] else "ip"
        ser = bp.Series(h, label, den, bp.MIN_TARGET.get(den, 100))
        if len(ser.seasons) < 2:
            continue
        J = min(bp.MAX_LAGS, len(ser.seasons) - 1)
        sp = PitcherProjector(label, ser, ages, signals, J)
        targets = [s for s in ser.seasons[1:] if s not in bp.SKIP_TARGET_SEASONS]
        wf = bp.walkforward_base(sp, targets[-3:])
        bp.ci_backtest(sp, targets[-bp.CI_SEASONS:])
        base_all = sp.fit_base(set(ser.seasons))
        if base_all is None:
            print(f"{label:18s}  (too few rows to fit — skipped)")
            continue

        variants = ["base"] + [v for v in ("grades", "stuff") if all(s in signals for s in bp.VARIANT_SIGNALS[v])]
        if label in RESID_ELIGIBLE and all(s in signals for s in bp.VARIANT_SIGNALS["model_resid"]):
            variants.append("model_resid")
        layer_cmp, chosen, layer = None, "base", None
        if len(variants) > 1:
            sig_seasons = sorted(set.intersection(*[set(signals[n].s.seasons)
                                                    for v in variants[1:] for n in bp.VARIANT_SIGNALS[v]]))
            layer_targets = [s + 1 for s in sig_seasons if s + 1 in ser.seasons]
            loso = bp.compare_layers(sp, variants, layer_targets, "loso")
            wfl = bp.compare_layers(sp, variants, layer_targets[1:], "walkforward")
            layer_cmp = {"loso": loso, "walkforward": wfl}
            if loso:
                best = min(variants, key=lambda v: loso[v])
                if best != "base" and loso[best] < loso["base"] * (1 - bp.LAYER_MIN_GAIN):
                    chosen = best
            if chosen != "base":
                layer = sp.fit_layer(chosen, base_all, set(ser.seasons))
                if layer is None:
                    chosen = "base"

        projectors[label] = (sp, base_all, layer, lower_better)
        d = base_all.describe()
        gain = (1 - wf["rmse_learned"] / wf["rmse_last"]) if wf else np.nan
        wtxt = " ".join(f"{x:.2f}" for x in d["weights"])
        print(f"{label:18s}{den:>8s}{J:>3d}  {wtxt:28s}{d['k']:>8.0f}"
              + (f"{wf['rmse_last']:>14.4f}{wf['rmse_marcel543']:>9.4f}{wf['rmse_learned']:>9.4f}{gain:>+8.1%}"
                 if wf else f"{'(no walk-forward seasons)':>40s}")
              + f"  {chosen}")
        if layer_cmp and layer_cmp["loso"]:
            lc = layer_cmp["loso"]
            print(f"{'':18s}  layer check, LOSO on {lc['n']} rows: "
                  + "  ".join(f"{v}={lc[v]:.4f}" for v in variants))
        rep = {"stat": label, "denom": den, "lags": J, **d, "n_fit": base_all.n_fit,
               "layer": chosen, "walkforward": wf, "layer_check": layer_cmp}
        if layer is not None:
            rep["layer_coef"] = [round(float(c), 5) for c in layer["coef"]]
        report.append(rep)
    print("═" * 112)

    # ── Who gets a card ──
    recent = h[h["season"].between(T - 3, LAST)]
    ip_recent = recent.groupby("player_id")["ip"].sum()
    active = set(h[h["season"] >= LAST - 1]["player_id"])
    pids = sorted(pid for pid in ip_recent.index if ip_recent[pid] >= args.min_recent_ip and pid in active)
    keys = [(pid, T) for pid in pids]
    print(f"\nProjecting {T} for {len(pids)} pitchers (≥{args.min_recent_ip:g} IP over {T-3}–{LAST}, "
          f"active {LAST-1}–{LAST})")

    proj = pd.DataFrame({"player_id": pids})
    layer_used = {}
    for label, (sp, base, layer, _lb) in projectors.items():
        pv, has, used = sp.predict(base, layer, keys)
        proj[label] = np.where(has, pv, np.nan)
        layer_used[label] = int(used.sum())
        proj[f"__hist__{label}"], proj[f"__age__{label}"] = bp.decompose(sp, base, keys)
    # K-BB% has to agree with the K% and BB% shown next to it (and so do its parts)
    if {"K%", "BB%", "K-BB%"} <= set(proj.columns):
        proj["K-BB%"] = proj["K%"] - proj["BB%"]
        for part in ("__hist__", "__age__"):
            proj[f"{part}K-BB%"] = proj[f"{part}K%"] - proj[f"{part}BB%"]
    grade_models = {}
    for col, _lab in GRADES:
        if col in signals:
            sp = signals[col]
            m = sp.fit_base(set(sp.s.seasons))
            if m is not None:
                pv, has, _ = sp.predict(m, None, keys)
                proj[col] = np.where(has, pv, np.nan)
                bp.ci_backtest(sp, [x for x in sp.s.seasons[1:] if x not in bp.SKIP_TARGET_SEASONS][-bp.CI_SEASONS:])
                grade_models[col] = (sp, m)
                proj[f"__hist__{col}"], proj[f"__age__{col}"] = bp.decompose(sp, m, keys)
                report.append({"stat": col, "denom": "pitches", "lags": sp.J, **m.describe(),
                               "n_fit": m.n_fit, "layer": "base"})

    # ── 90% confidence intervals around the final projections ──
    ci, ci_meta = {}, {}
    for label, (sp, base, _layer, _lb) in projectors.items():
        r = bp.ci_bounds(sp, base, keys, proj[label].values, LAST)
        if r is not None:
            ci[label], ci_meta[label] = r
    for col, (sp, m) in grade_models.items():
        r = bp.ci_bounds(sp, m, keys, proj[col].values, LAST)
        if r is not None:
            ci[col], ci_meta[col] = r
    print("\nConfidence intervals (band fit on the other backtest seasons, scored on each):")
    for label, m in ci_meta.items():
        print(f"  {label:18s} {bp.coverage_text(m)}   (full season = {m['full_n']:.0f} {m['denom']})")

    # ── Card JSON ──
    last = h[h["season"] == LAST].drop_duplicates("player_id").set_index("player_id")
    latest = h.sort_values("season").groupby("player_id").last()
    pool = h[(h["season"] == LAST) & (h["ip"] >= CARD_POOL_MIN_IP)]
    gpool = h[(h["season"] == LAST) & (h["pitches"] >= GRADE_POOL_MIN)] if "pitches" in h.columns else h.iloc[:0]
    nn = lambda x: None if x is None or (isinstance(x, float) and not np.isfinite(x)) or pd.isna(x) else x

    pitchers = []
    for i, r in proj.iterrows():
        pid = int(r["player_id"])
        info = latest.loc[pid]
        cats = {}
        for label, _prefs, lb in CARD:
            v = r.get(label, np.nan)
            if label not in proj.columns or not np.isfinite(v):
                cats[label] = {"pctile": None, "value": None, "display": "—"}
                continue
            cats[label] = {"value": round(float(v), 6), "display": fmt(label, v),
                           "parts": bp.parts_of(v, r.get(f"__hist__{label}", np.nan), r.get(f"__age__{label}", np.nan), 6),
                           "pctile": bp.ecdf_pct(pool[label].values, v, lb),
                           "ci": bp.ci_entry(ci.get(label), i, 6)}
            if pid in last.index and np.isfinite(last.at[pid, label]):
                lv = float(last.at[pid, label])
                cats[label]["last"] = {"value": round(lv, 6), "display": fmt(label, lv)}
        grades = {}
        for col, _lab in GRADES:
            v = r.get(col, np.nan)
            if col not in proj.columns or not np.isfinite(v):
                continue
            g = {"value": round(float(v), 1), "percentile": bp.ecdf_pct(gpool[col].values, v, False),
                 "parts": bp.parts_of(v, r.get(f"__hist__{col}", np.nan), r.get(f"__age__{col}", np.nan), 2),
                 "ci": bp.ci_entry(ci.get(col), i, 1)}
            if pid in last.index and col in last.columns and np.isfinite(last.at[pid, col]):
                g["last"] = round(float(last.at[pid, col]), 1)
            grades[col] = g
        pitchers.append({
            "name": nn(info.get("name")), "player_id": pid,
            "team": nn(info.get("team")),
            "team_id": int(info["team_id"]) if pd.notna(info.get("team_id")) else None,
            "ip": float(last.at[pid, "ip"]) if pid in last.index and pd.notna(last.at[pid, "ip"]) else None,
            "categories": cats,
            "grades": grades,
            "proj": {
                "season": T,
                "age": (int(bp.season_age(ages.get(pid), T)) if ages and ages.get(pid) else None),
                "based_on": sorted(int(s) for s in h[(h.player_id == pid) & (h.season >= T - bp.MAX_LAGS)]["season"]),
                "ip_recent": round(float(ip_recent.get(pid, 0)), 1),
            },
        })

    key = f"{T}P"
    out_path = public / f"baseball_data_{key}.json"
    if out_path.exists():
        out = json.load(open(out_path))
        print(f"\nUpdating {out_path} (keeping its {len(out.get('hitters', []))} hitters)")
    else:
        out = {"season": key, "hitters": [], "hitter_metrics": [], "meta": {"projection": True, "target_season": T}}
        print(f"\n{out_path} not found — writing pitchers only")
    out["pitchers"] = pitchers
    out["pitcher_metrics"] = [{"key": lab, "label": lab, "lower_better": lb} for lab, _p, lb in CARD]
    out["pitcher_meta"] = {"percentiles_vs": f"{LAST} actual (min {CARD_POOL_MIN_IP} IP; grades min {GRADE_POOL_MIN} pitches)",
                           "min_recent_ip": args.min_recent_ip,
                           "generated_at": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
                           "pools": bp.pool_lists(pool, [lab for lab, *_ in CARD]),
                           "grade_pools": bp.pool_lists(gpool, [c for c, _ in GRADES]),
                           "lower_better": [lab for lab, _p, lb in CARD if lb],
                           "ci": {"level": 90, "core": 50, "stats": ci_meta}}

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

    public.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(_clean(out), f, indent=1, default=str, allow_nan=False)
    with open(public / "pitcher_projection_report.json", "w") as f:
        json.dump(_clean({"target": T, "stats": report, "layer_rows_used": layer_used}), f, indent=1, allow_nan=False)
    flat = []
    for r in report:
        wf = r.get("walkforward") or {}
        flat.append({"stat": r["stat"], "denom": r["denom"], "lags": r["lags"],
                     **{f"w{i+1}": w for i, w in enumerate(r["weights"])}, "k": r["k"],
                     "age_a1": r["age_a1"], "age_a2": r["age_a2"], "layer": r.get("layer"),
                     "rmse_last_year": wf.get("rmse_last"), "rmse_learned": wf.get("rmse_learned")})
    pd.DataFrame(flat).to_csv(public / "pitcher_projection_report.csv", index=False)

    print(f"Wrote {out_path}  ({len(pitchers)} pitchers)")
    print(f"Wrote {public}/pitcher_projection_report.json / .csv")
    lu = {k: v for k, v in layer_used.items() if v}
    if lu:
        print(f"Layer applied to: {lu}")


if __name__ == "__main__":
    main()
