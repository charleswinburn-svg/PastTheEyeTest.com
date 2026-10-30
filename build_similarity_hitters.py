#!/usr/bin/env python3
"""
build_similarity_hitters.py — Build the hitter player-similarity file for one
season: public/similarity_hitters_{year}.json (see similarity_common.py for the
model and the file shape; src/baseball/similarity.js ranks comps from it).

Sources (all committed, except the optional per-swing / parquet inputs):
  public/baseball_data_{year}.json     — Statcast categories (bat speed, EV90, K%, ...)
  public/hitter_xrv_{year}.json        — xRV/600 components (Contact Quality, Whiff, Chase, Decision)
  public/iswing_waterfall_{year}.json  — iSwing+ and its adjustability/effort contributions
  public/merged_stats.csv              — attack angle + swing tilt for 2023-2025 (Savant leaderboard)
  competitive_swings_*.csv             — per-swing attack angle / direction / tilt / intercept
                                         (batter-season means, min 25 swings) and batter side
  --parquet pitch_xrv_{year}.parquet   — optional: xSLGcon from estimated_slg_using_speedangle

A feature with no source for a season is simply absent (null) for every player;
the distance only uses features both players have.

Usage:
  python3 build_similarity_hitters.py --year 2026
  python3 build_similarity_hitters.py --year 2024 --swings competitive_swings_2024.csv
  python3 build_similarity_hitters.py --year 2026 --parquet tmp/pitch_xrv_2026.parquet
"""
import argparse
import glob
import json
import os
from pathlib import Path

import pandas as pd

from similarity_common import (
    HITTER_COMPONENTS, HITTER_FEATURES, clean_value, component_meta, compute_stats,
    feature_meta, pairwise_calibration, write_similarity_json,
)

MIN_SWINGS = 25

# baseball_data category label → (feature key, multiplier)
CATEGORY_MAP = {
    "Avg Bat Speed":    ("bat_speed", 1),
    "Avg Swing Length": ("swing_length", 1),
    "Fast Swing %":     ("fast_swing_pct", 100),   # stored as a 0-1 decimal
    "xwOBACON":         ("xwobacon", 1),
    "90th % EV":        ("ev90", 1),
    "Avg Exit Velocity":("avg_ev", 1),
    "Barrel %":         ("barrel_pct", 1),
    "Blasts/Contact":   ("blasts_per_contact", 100),   # stored as a 0-1 decimal
    "LA+SwtSpt%":       ("la_sweetspot", 1),
    "Z-Contact%":       ("z_contact", 1),
    "K%":               ("k_pct", 1),
    "Whiff %":          ("whiff_pct", 1),
    "Chase %":          ("chase_pct", 1),
    "BB%":              ("bb_pct", 1),
}
XRV_MAP = {
    "Contact Quality": "contact_xrv",
    "Whiff":           "whiff_xrv",
    "Chase":           "chase_xrv",
    "Decision":        "decision_xrv",
}
ISWING_CONTRIB = ["speed_vs_location", "aa_adjustment", "length_for_location", "effort_level"]


def _load(path):
    with open(path) as f:
        return json.load(f)


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None


def load_swings(paths, year):
    """Per-batter means of the swing-path columns for `year`, plus batter side.
    Returns ({pid: {...}}, {pid: hand}) — hand is 'L', 'R' or 'S' (switch)."""
    cols = ["game_date", "batter", "stand", "attack_angle", "attack_direction",
            "swing_path_tilt", "intercept_ball_minus_batter_pos_x_inches"]
    frames = []
    for p in paths:
        if not os.path.exists(p):
            continue
        head = pd.read_csv(p, nrows=0).columns
        use = [c for c in cols if c in head]
        if "batter" not in use:
            continue
        df = pd.read_csv(p, usecols=use, low_memory=False)
        frames.append(df)
    if not frames:
        return {}, {}
    df = pd.concat(frames, ignore_index=True)
    hands = {}
    if "stand" in df.columns:
        side = df.groupby("batter")["stand"].value_counts(normalize=True).unstack(fill_value=0)
        for pid, row in side.iterrows():
            l, r = row.get("L", 0), row.get("R", 0)
            hands[str(int(pid))] = "S" if min(l, r) >= 0.2 else ("L" if l >= r else "R")
    if "game_date" in df.columns:
        df = df[df["game_date"].astype(str).str[:4] == str(year)]
    df["batter"] = pd.to_numeric(df["batter"], errors="coerce")
    df = df[df["batter"].notna()]
    out = {}
    if len(df):
        agg = {"n": ("batter", "size")}
        for src, key in [("attack_angle", "attack_angle"), ("attack_direction", "attack_direction"),
                         ("swing_path_tilt", "swing_path_tilt"),
                         ("intercept_ball_minus_batter_pos_x_inches", "intercept_x")]:
            if src in df.columns:
                agg[key] = (src, "mean")
        g = df.groupby("batter").agg(**agg)
        g = g[g["n"] >= MIN_SWINGS]
        for pid, row in g.iterrows():
            out[str(int(pid))] = {k: _num(row[k]) for k in g.columns if k != "n"}
    return out, hands


def load_merged(path, year):
    """attack angle + tilt from the Savant swing-path leaderboard export (2023-2025)."""
    if not path or not os.path.exists(path):
        return {}
    m = pd.read_csv(path)
    if "year" not in m.columns:
        return {}
    m = m[m["year"] == year]
    out = {}
    for _, r in m.iterrows():
        pid = _num(r.get("player_id"))
        if pid is None:
            continue
        out[str(int(pid))] = {
            "attack_angle": _num(r.get("attack_angle")),
            "swing_path_tilt": _num(r.get("vertical_swing_path")),
        }
    return out


def load_xslgcon(parquet):
    """Mean xSLG on contact per batter from the season Statcast parquet."""
    if not parquet or not os.path.exists(parquet):
        return {}
    cols = ["batter", "description", "estimated_slg_using_speedangle"]
    try:
        df = pd.read_parquet(parquet, columns=cols)
    except Exception as e:  # column missing → feature dropped
        print(f"  xSLGcon unavailable from {parquet}: {e}")
        return {}
    df = df[df["description"] == "hit_into_play"]
    df["x"] = pd.to_numeric(df["estimated_slg_using_speedangle"], errors="coerce")
    g = df.groupby("batter")["x"].agg(["mean", "count"])
    g = g[g["count"] >= 25]
    return {str(int(pid)): _num(r["mean"]) for pid, r in g.iterrows()}


def build(year, public, swings_paths, merged_path, parquet):
    data = _load(Path(public) / f"baseball_data_{year}.json")
    xrv = {}
    p = Path(public) / f"hitter_xrv_{year}.json"
    if p.exists():
        xrv = _load(p)
    waterfall = {}
    p = Path(public) / f"iswing_waterfall_{year}.json"
    if p.exists():
        waterfall = {k: v for k, v in _load(p).items() if k != "meta"}
    swings, hands = load_swings(swings_paths, year)
    merged = load_merged(merged_path, year)
    xslgcon = load_xslgcon(parquet)

    players = {}
    for h in data.get("hitters", []):
        pid = h.get("player_id")
        if pid is None:
            continue
        pid = str(int(pid))
        v = {}
        for label, (key, mult) in CATEGORY_MAP.items():
            cat = (h.get("categories") or {}).get(label)
            val = _num(cat.get("value")) if cat else None
            v[key] = val * mult if val is not None else None
        for label, key in XRV_MAP.items():
            m = ((xrv.get(pid) or {}).get("metrics") or {}).get(label)
            v[key] = _num(m.get("value")) if m else None
        w = waterfall.get(pid)
        v["iswing_plus"] = _num(w.get("iswing")) if w else None
        for key in ISWING_CONTRIB:
            v[key] = _num((w.get("c") or {}).get(key)) if w else None
        sw = swings.get(pid, {})
        mg = merged.get(pid, {})
        for key in ("attack_angle", "swing_path_tilt"):
            v[key] = sw.get(key) if sw.get(key) is not None else mg.get(key)
        v["attack_direction"] = sw.get("attack_direction")
        v["intercept_x"] = sw.get("intercept_x")
        v["xslgcon"] = xslgcon.get(pid)
        players[pid] = {
            "name": h.get("name"),
            "team": h.get("team"),
            "team_id": h.get("team_id"),
            "hand": hands.get(pid),
            "n": h.get("pa"),
            "v": {k: clean_value(val) for k, val in v.items()},
        }

    keys = [k for k, *_ in HITTER_FEATURES]
    meta = {
        "components": component_meta(HITTER_COMPONENTS, HITTER_FEATURES),
        "features": feature_meta(HITTER_FEATURES),
        "stats": compute_stats({pid: p["v"] for pid, p in players.items()}, keys),
    }
    # Features with no values this season are dropped from the component lists so
    # the "half the features shared" rule only counts features that exist.
    for c in meta["components"].values():
        c["features"] = [k for k in c["features"] if k in meta["stats"]]
    meta["calib"] = pairwise_calibration(players, meta, "hitter")
    return players, meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, required=True)
    ap.add_argument("--public", default="public")
    ap.add_argument("--swings", nargs="*", default=None,
                    help="per-swing CSV(s); default: competitive_swings_{year}.csv + competitive_swings_2023_2026.csv")
    ap.add_argument("--merged", default="public/merged_stats.csv")
    ap.add_argument("--parquet", default=None, help="season Statcast parquet (adds xSLGcon)")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    swings = args.swings
    if swings is None:
        swings = [f"competitive_swings_{args.year}.csv"] + sorted(glob.glob("competitive_swings_20*_20*.csv"))
    players, meta = build(args.year, args.public, swings, args.merged, args.parquet)
    out = args.out or str(Path(args.public) / f"similarity_hitters_{args.year}.json")
    write_similarity_json(out, season=args.year, kind="hitter", players=players, meta=meta)
    present = {c: len(m["features"]) for c, m in meta["components"].items()}
    print(f"Wrote {out}: {len(players)} hitters, features per component {present}, calib {meta['calib']}")


if __name__ == "__main__":
    main()
