#!/usr/bin/env python3
"""
explain_projections.py — look inside the 2027 projections from the terminal.

  python3 explain_projections.py                    # weights, k, aging, layer, backtest per stat
  python3 explain_projections.py corr               # year-to-year stickiness + projection-vs-actual r
  python3 explain_projections.py player "Judge"     # how one hitter's projection was built, stat by stat
  python3 explain_projections.py spread             # is it regressing too much? (calibration slope, elite errors)
  python3 explain_projections.py aging              # age adjustment per stat at 23/26/28/31/34/37
  python3 explain_projections.py weights --side pitchers   # same tables for the pitcher projections

Reads the same inputs/outputs as build_projections.py (run it first). Use the same
--public / --history you gave build_projections.py, e.g.
  python3 explain_projections.py player "Soto" --public ./private_out --history ./history
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_projections as bp  # noqa: E402

bp.log = lambda *a, **k: None    # keep the loaders quiet

PCT_DEC = {lab for lab, _f, _lb, dec, _p, _fam in bp.CARD_STATS if dec}
LOWER_BETTER = {lab for lab, _f, lb, *_ in bp.CARD_STATS if lb}


def fmt(label, v):
    if v is None or not np.isfinite(v):
        return "—"
    return bp.fmt_value(label, v) if label in {s[0] for s in bp.CARD_STATS} else f"{v:+.1f}"


REPORT = {"hitters": "projection_report.json", "pitchers": "pitcher_projection_report.json"}
SIDE = "hitters"


def load_report(public):
    p = public / REPORT[SIDE]
    if not p.exists():
        raise SystemExit(f"{p} not found — run build_projections.py first (same --public).")
    return json.load(open(p))


def stat_series(h, label, report_row):
    den = report_row["denom"]
    return bp.Series(h, label, den, bp.MIN_TARGET.get(den, 100))


# ─────────────────────────────────────────────────────────────────────────────
def cmd_weights(args):
    rep = load_report(args.public)
    print(f"\nHOW EACH STAT IS PROJECTED FOR {rep['target']}")
    print("  projection = league avg + Σ wᵢ·nᵢ·(seasonᵢ − lg) / (Σ wᵢ·nᵢ + k)  + age curve  [+ layer]")
    print("  w = weight per season back (last season = 1.00) · n = sample (PA / BIP / swings)")
    print("  k = 'ghost' sample of league average added in — bigger k = more regression")
    print("  peak = age where the fitted aging curve tops out (— if aging off or no peak)\n")
    hdr = (f"{'stat':20s}{'denom':>7s}  {'w1':>5s}{'w2':>6s}{'w3':>6s}{'w4':>6s}{'w5':>6s}{'k':>7s}"
           f"{'peak':>6s}  {'RMSE last-yr':>12s}{'learned':>9s}{'gain':>7s}  layer")
    print(hdr); print("─" * len(hdr))
    for r in rep["stats"]:
        if r["stat"].startswith("_"):
            continue
        w = (r.get("weights") or []) + [None] * 5
        a1, a2 = r.get("age_a1") or 0.0, r.get("age_a2") or 0.0
        # "peak" = top of the curve; for pitchers several stats are lower-is-better,
        # so the top isn't the best age there — read the `aging` table instead.
        peak = (f"{bp.AGE_CENTER - a1 / (2 * a2):.0f}" if SIDE == "hitters" and a2 < 0
                and abs(a1 / (2 * a2)) < 15 else "—")
        wf = r.get("walkforward") or {}
        g = (1 - wf["rmse_learned"] / wf["rmse_last"]) if wf.get("rmse_last") else None
        ws = "".join(f"{x:>6.2f}" if x is not None else f"{'':>6s}" for x in w[:5])
        print(f"{r['stat']:20s}{r['denom']:>7s} {ws}{r['k']:>7.0f}{peak:>6s}  "
              + (f"{wf['rmse_last']:>12.4f}{wf['rmse_learned']:>9.4f}{g:>+7.1%}" if g is not None else f"{'':>28s}")
              + f"  {r.get('layer', 'base')}")
    print("\nRMSE columns: walk-forward error (lower = better) of 'same as last year' vs the learned projection;")
    print("gain = how much the projection cuts that error. Layer = extra signal the backtest approved.")
    print(f"Full detail (layer coefficients, LOSO checks): {args.public}/{REPORT[SIDE]}\n")


# ─────────────────────────────────────────────────────────────────────────────
def year_to_year(ser, lag):
    a, b = [], []
    for (pid, s), (v, n) in ser.v.items():
        nxt = ser.v.get((pid, s + lag))
        if nxt is None or n < ser.min_target or nxt[1] < ser.min_target:
            continue
        if s in bp.SKIP_TARGET_SEASONS or s + lag in bp.SKIP_TARGET_SEASONS:
            continue
        a.append(v - ser.lg[s]); b.append(nxt[0] - ser.lg[s + lag])
    if len(a) < 30:
        return None, len(a)
    return float(np.corrcoef(a, b)[0, 1]), len(a)


def cmd_corr(args):
    rep = load_report(args.public)
    h = bp.load_history(args.public, args.history)
    ages = bp.load_ages(args.history)
    last = rep["target"] - 1
    print(f"\nCORRELATIONS  (Pearson r; hitters meeting the stat's minimum sample in both seasons)")
    print("  Y→Y+1 / Y→Y+2 : how sticky the stat is one / two seasons later (all seasons pooled)")
    print(f"  {last} backtest: models fit on seasons before {last} only, then compared with {last} actuals —")
    print("                 'last yr' = just use the prior season, 'proj' = the learned projection\n")
    hdr = f"{'stat':20s}{'Y→Y+1':>8s}{'n':>6s}{'Y→Y+2':>8s}{'n':>6s}   {last} backtest: {'last yr':>8s}{'proj':>7s}{'n':>6s}"
    print(hdr); print("─" * len(hdr))
    for r in rep["stats"]:
        lab = r["stat"]
        if lab.startswith("_") or lab not in h.columns:
            continue
        ser = stat_series(h, lab, r)
        r1, n1 = year_to_year(ser, 1)
        r2, n2 = year_to_year(ser, 2)
        line = (f"{lab:20s}{(f'{r1:.2f}' if r1 is not None else '—'):>8s}{n1:>6d}"
                f"{(f'{r2:.2f}' if r2 is not None else '—'):>8s}{n2:>6d}   ")
        bt = ""
        if args.backtest:
            J = min(bp.MAX_LAGS, max(1, len([s for s in ser.seasons if s < last])))
            sp = bp.StatProjector(lab, ser, ages, {}, J)
            m = sp.fit_base({s for s in ser.seasons if s < last})
            keys, y, _w = ser.targets({last})
            if m is not None and keys:
                _x, _n, lg = ser.design(keys, J)
                y_abs = y + lg
                p, has, _ = sp.predict(m, None, keys)
                prev = np.array([ser.v.get((pid, last - 1), (np.nan, 0))[0] for pid, _ in keys])
                ok = has & np.isfinite(prev)
                if ok.sum() >= 30:
                    bt = (f"{' ' * 14}{np.corrcoef(prev[ok], y_abs[ok])[0, 1]:>8.2f}"
                          f"{np.corrcoef(p[ok], y_abs[ok])[0, 1]:>7.2f}{int(ok.sum()):>6d}")
        print(line + bt)
    if not args.backtest:
        print("\n(add --backtest for the projection-vs-actual columns; refits each stat, takes a minute)")
    print("\nRead it as: r near 1 = mostly skill (trust last season), near 0 = mostly noise (regress hard).")
    print("The fitted k in the weights table should be larger for the low-r stats.\n")


# ─────────────────────────────────────────────────────────────────────────────
def cmd_spread(args):
    """Is the projection over- or under-regressed? Walk-forward on the last 3 seasons."""
    rep = load_report(args.public)
    h = bp.load_history(args.public, args.history)
    ages = bp.load_ages(args.history)
    last = rep["target"] - 1
    tests = [last - 2, last - 1, last]
    print(f"\nSPREAD CHECK  (walk-forward: fit on seasons before T, project T, compare with T actuals; T = {tests})")
    print("  slope     actual ≈ lg + slope·(proj − lg). 1.00 = regressed the right amount;")
    print("            >1 = projections too compressed (elite players really do stay more elite);")
    print("            <1 = not regressed enough")
    print("  top/bot   avg (actual − proj) for hitters whose PRIOR season was top / bottom 10%")
    print("            (+ on top = the model undersells the elite; − on bottom = undersells the worst)")
    print("  sd ratio  spread of projections ÷ spread of actuals\n")
    hdr = f"{'stat':20s}{'slope':>7s}{'top 10%':>10s}{'bot 10%':>10s}{'sd ratio':>10s}{'n':>7s}"
    print(hdr); print("─" * len(hdr))
    for r in rep["stats"]:
        lab = r["stat"]
        if lab.startswith("_") or lab not in h.columns:
            continue
        ser = stat_series(h, lab, r)
        P, Y, L, W, PREV = [], [], [], [], []
        for T in tests:
            if T not in ser.seasons:
                continue
            J = min(bp.MAX_LAGS, max(1, len([x for x in ser.seasons if x < T])))
            sp = bp.StatProjector(lab, ser, ages, {}, J)
            m = sp.fit_base({x for x in ser.seasons if x < T})
            keys, y, w = ser.targets({T})
            if m is None or not keys:
                continue
            _x, _n, lg = ser.design(keys, J)
            p, has, _ = sp.predict(m, None, keys)
            prev = np.array([ser.v.get((pid, T - 1), (np.nan, 0))[0] for pid, _ in keys])
            ok = has & np.isfinite(prev)
            # rank prior season within that season so top/bottom 10% is per-season
            pr = pd.Series(prev[ok]).rank(pct=True).values
            P.append(p[ok]); Y.append((y + lg)[ok]); L.append(lg[ok]); W.append(w[ok]); PREV.append(pr)
        if not P:
            continue
        P, Y, L, W, PREV = map(np.concatenate, (P, Y, L, W, PREV))
        x, yy = P - L, Y - L
        slope = float(np.sum(W * x * yy) / np.sum(W * x * x))
        err = Y - P
        flip = -1 if lab in LOWER_BETTER else 1          # "top" = best, whatever the direction
        top = PREV >= 0.9 if flip == 1 else PREV <= 0.1
        bot = PREV <= 0.1 if flip == 1 else PREV >= 0.9
        sdr = float(np.std(P) / np.std(Y))
        print(f"{lab:20s}{slope:>7.2f}{np.average(err[top], weights=W[top]):>+10.3f}"
              f"{np.average(err[bot], weights=W[bot]):>+10.3f}{sdr:>10.2f}{len(P):>7d}")
    print("\nsd ratio well below 1 is expected (projections are averages, actuals include luck).")
    print("What matters is slope ≈ 1 and top/bottom errors ≈ 0. If slope is clearly > 1 across the")
    print("board, the projections should be stretched by that slope.\n")


# ─────────────────────────────────────────────────────────────────────────────
def cmd_player(args):
    rep = load_report(args.public)
    T = rep["target"]; key = f"{T}P"
    data = json.load(open(args.public / f"baseball_data_{key}.json"))
    xrv = {}
    xp = args.public / f"hitter_xrv_{key}.json"
    if xp.exists():
        xrv = json.load(open(xp))
    hits = [x for x in data["hitters"] if args.name.lower() in (x.get("name") or "").lower()]
    if not hits:
        raise SystemExit(f"No projected hitter matches '{args.name}'.")
    if len(hits) > 1 and not any((x.get("name") or "").lower() == args.name.lower() for x in hits):
        print("Several matches — be more specific:")
        for x in hits[:20]:
            print(f"  {x['name']}  ({x.get('team') or '?'}, id {x['player_id']})")
        return
    hit = next((x for x in hits if (x.get("name") or "").lower() == args.name.lower()), hits[0])
    pid = int(hit["player_id"])

    h = bp.load_history(args.public, args.history)
    ages = bp.load_ages(args.history)
    age = bp.season_age(ages.get(pid), T) if ages else np.nan
    pj = hit.get("proj") or {}
    print(f"\n{hit['name']}  ({hit.get('team') or '?'})  —  {T} projection"
          + (f"  ·  age {int(age)}" if np.isfinite(age) else "")
          + (f"  ·  {pj.get('pa_recent')} PA over the last 3 seasons" if pj.get("pa_recent") else ""))
    if pj.get("swing_residual"):
        print(f"Beats his swing by {pj['swing_residual']['display']} xwOBAcon (projected, regressed)")
    print("\nEach stat = weighted blend of his past seasons + league average, then aging and any layer.")
    print("Share % = how much of the projection each source carries (sample size × season weight vs k).\n")

    for r in rep["stats"]:
        lab = r["stat"]
        if lab.startswith("_") or lab not in h.columns:
            continue
        final = None
        if lab in (hit.get("categories") or {}):
            final = hit["categories"][lab].get("value")
        elif str(pid) in xrv and lab in xrv[str(pid)].get("metrics", {}):
            final = xrv[str(pid)]["metrics"][lab].get("value")
        if final is None:
            continue
        ser = stat_series(h, lab, r)
        w = r["weights"]; k = r["k"]
        rows, den = [], k
        for j, wj in enumerate(w, start=1):
            vn = ser.v.get((pid, T - j))
            if vn is not None:
                rows.append((T - j, vn[0], vn[1], wj, ser.lg[T - j]))
                den += wj * vn[1]
        prev = [s for s in ser.seasons if s < T]
        lg_last = ser.lg[prev[-1]]
        rel = sum(wj * n * (v - lg) for _s, v, n, wj, lg in rows) / den
        a = (age - bp.AGE_CENTER) if np.isfinite(age) else 0.0
        age_adj = (r.get("age_a1") or 0) * a + (r.get("age_a2") or 0) * a * a if np.isfinite(age) else 0.0
        base = lg_last + rel + age_adj
        unit = r["denom"]
        print(f"■ {lab}   →  {fmt(lab, final)}"
              + (f"   (layer: {r['layer']})" if r.get("layer", "base") != "base" else ""))
        for s, v, n, wj, lg in rows:
            print(f"    {s}: {fmt(lab, v):>7s}  over {n:>5.0f} {unit:<6s} × w {wj:.2f}  → {wj * n / den:>5.1%}")
        print(f"    league avg {fmt(lab, lg_last):>7s}  (k = {k:,.0f} {unit})       → {k / den:>5.1%}")
        extra = []
        if fmt(lab, abs(age_adj)).strip("+-.0"):
            extra.append(f"age {'+' if age_adj >= 0 else '−'}{fmt(lab, abs(age_adj)).lstrip('+')}")
        adj = final - base
        if fmt(lab, abs(adj)).strip("+-.0"):        # skip rounding noise below display precision
            what = "layer" if r.get("layer", "base") != "base" else "xRV reconcile" if r["denom"] == "pa_xrv" else "adj"
            extra.append(f"{what} {'+' if adj >= 0 else '−'}{fmt(lab, abs(adj)).lstrip('+')}")
        if extra:
            print(f"    blend {fmt(lab, lg_last + rel)}  ·  " + "  ·  ".join(extra))
        print()


def cmd_aging(args):
    """Age adjustment per stat at a few ages, vs a 28-year-old, in the stat's own units."""
    rep = load_report(args.public)
    ages = [23, 26, 28, 31, 34, 37]
    print(f"\nAGE CURVES — one-season adjustment vs a 28-year-old ({SIDE}), stat's own units")
    print("(on top of what the player's own past seasons already say)\n")
    hdr = f"{'stat':20s}" + "".join(f"{a:>8d}" for a in ages)
    print(hdr); print("─" * len(hdr))
    for r in rep["stats"]:
        if r["stat"].startswith("_"):
            continue
        a1, a2 = r.get("age_a1") or 0.0, r.get("age_a2") or 0.0
        print(f"{r['stat']:20s}" + "".join(f"{a1 * (a - 28) + a2 * (a - 28) ** 2:>+8.3f}" for a in ages))
    print("\nStats stored as fractions (K%, BB%, … on the pitcher side) read ×100: −0.010 = −1.0 point.\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", nargs="?", default="weights", choices=["weights", "corr", "player", "spread", "aging"])
    ap.add_argument("name", nargs="?", help="player name (or part of it) for 'player'")
    ap.add_argument("--public", default="./private_out")
    ap.add_argument("--history", default="./history")
    ap.add_argument("--backtest", action="store_true", help="corr: add projection-vs-actual r")
    ap.add_argument("--side", choices=["hitters", "pitchers"], default="hitters",
                    help="pitchers: weights and aging read pitcher_projection_report.json")
    args = ap.parse_args()
    args.public, args.history = Path(args.public), Path(args.history)
    pd.set_option("display.width", 200)
    global SIDE
    SIDE = args.side
    if SIDE == "pitchers" and args.mode not in ("weights", "aging"):
        raise SystemExit("For pitchers, use the 'weights' or 'aging' modes "
                         "(the per-player and correlation views are hitters-only for now).")
    if args.mode == "aging":
        cmd_aging(args)
    elif args.mode == "weights":
        cmd_weights(args)
    elif args.mode == "corr":
        cmd_corr(args)
    elif args.mode == "spread":
        cmd_spread(args)
    else:
        if not args.name:
            raise SystemExit('Usage: explain_projections.py player "Name"')
        cmd_player(args)


if __name__ == "__main__":
    main()
