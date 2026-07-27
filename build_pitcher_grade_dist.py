#!/usr/bin/env python3
"""
build_pitcher_grade_dist.py — Precompute per-pitcher grade DISTRIBUTIONS for the
pitcher-card KDE panel: Stuff+ / Loc+ / Tun+ / Pitch+, each split by batter hand
(vs LHH / vs RHH), with one density curve per pitch type on a shared x-scale.

Reads pitch_xrv_{season}.parquet, scores every pitch through the production
3-stage model (score_pitches.score_dataframe), converts each pitch's raw xRV to a
+ grade (per-pitch-type z-score, plus the stored global rescale for whichever
metric has one — only Stuff+), then for each (pitcher, metric, stand, pitch_type)
fits a Gaussian KDE on a fixed x-grid so the frontend just plots the curve.

Output: public/pitcher_grade_dist_{season}.json
  { "meta": {"season", "xLo", "xHi", "nPts"},
    "<pitcherId>": { "stuff": {"L": {"FF":[d0..d63], ...}, "R": {...}},
                     "loc": {...}, "tun": {...}, "pitch": {...} } }

Env: same as score_pitches.py — pandas, pyarrow, numpy, lightgbm.
"""
import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

import score_pitches as sp   # production feature-engineering + models

ROOT = Path(__file__).resolve().parent
DEFAULT_SEASON = 2026

# All grades render on one shared x-scale (they're ~100-centered; compute_plus
# clips z to +-4 so Stuff+ spans ~[52,146], the others ~[60,140]).
X_LO, X_HI, N_PTS = 40.0, 160.0, 64
GRID = np.linspace(X_LO, X_HI, N_PTS)

MIN_PER_CURVE = 20        # min pitches for a (pitcher, metric, hand, type) curve
MIN_PITCHER_TOTAL = 100   # skip pitchers with too little data overall

# metric -> (raw xRV column, per-type mean key, per-type std key, global-rescale key)
PLUS_SPEC = {
    "stuff": ("xRV_stuff",    "stuff_mean", "stuff_std", "_stuff_plus_rescale"),
    "loc":   ("xRV_location", "loc_mean",   "loc_std",   "_loc_plus_rescale"),
    "tun":   ("xRV_tunnel",   "tun_mean",   "tun_std",   "_tun_plus_rescale"),
    "pitch": ("xRV_final",    "mean",       "std",       "_pitch_plus_rescale"),
}

SCORE_COLS = [
    "pitch_type", "pitcher", "stand", "p_throws",
    "plate_x", "plate_z", "sz_top", "sz_bot",
    "release_speed", "release_spin_rate", "release_extension",
    "pfx_x", "pfx_z", "spin_axis", "arm_angle",
    "release_pos_x", "release_pos_y", "release_pos_z",
    "vx0", "vy0", "vz0", "ax", "ay", "az",
    "game_pk", "at_bat_number", "pitch_number",
]


def compute_plus(df, norm, kind):
    """Per-pitch + grade from the model's raw xRV columns (mirrors the HR
    scripts / score_pitches._per_type_plus). NaN where the pitch type has no
    norm entry."""
    col, mkey, skey, rkey = PLUS_SPEC[kind]
    remapped = df["pitch_type"].map(lambda p: sp.PITCH_TYPE_REMAP.get(p, p))
    mean = pd.to_numeric(remapped.map(lambda p: (norm.get(p) or {}).get(mkey)), errors="coerce")
    std = pd.to_numeric(remapped.map(lambda p: (norm.get(p) or {}).get(skey)), errors="coerce")
    z = ((pd.to_numeric(df[col], errors="coerce") - mean) / std).clip(-4, 4)
    plus = 100 - z * 10
    rz = norm.get(rkey)
    if rz and rz.get("stdev"):
        plus = 100 + (plus - rz["mean"]) / rz["stdev"] * 10
    return plus.where(std > 0)


def kde_on_grid(samples):
    """Gaussian KDE density on GRID (numpy only — no scipy dependency).
    Silverman bandwidth. Returns a length-N_PTS list, or None if too few."""
    s = np.asarray(samples, dtype=float)
    s = s[np.isfinite(s)]
    n = s.size
    if n < MIN_PER_CURVE:
        return None
    std = s.std(ddof=1)
    if not np.isfinite(std) or std <= 0:
        std = 1.0
    h = 1.06 * std * n ** (-1 / 5)      # Silverman's rule of thumb
    if h <= 0:
        h = 1.0
    d = np.exp(-0.5 * ((GRID[:, None] - s[None, :]) / h) ** 2).sum(axis=1)
    d /= (n * h * np.sqrt(2 * np.pi))    # normalize to a density (area ~1)
    return [round(float(v), 5) for v in d]


def main():
    ap = argparse.ArgumentParser(description="Precompute pitcher grade distributions (KDE)")
    ap.add_argument("--season", type=int, default=DEFAULT_SEASON)
    ap.add_argument("--parquet", default=None, help="default: pitch_xrv_{season}.parquet")
    ap.add_argument("--models", default=None, help="default: ./models")
    ap.add_argument("--output-dir", default="./public")
    ap.add_argument("--chunk", type=int, default=150000)
    args = ap.parse_args()

    parquet = Path(args.parquet) if args.parquet else ROOT / f"pitch_xrv_{args.season}.parquet"
    models_dir = Path(args.models) if args.models else ROOT / "models"
    if not parquet.exists():
        raise SystemExit(f"ERROR: parquet not found: {parquet} (run fetch_statcast.py first)")

    stuff, tunnel, location_models = sp.load_models(models_dir)
    with open(models_dir / "final_model_config.json") as f:
        weights = json.load(f)
    with open(models_dir / "pitch_plus_norm.json") as f:
        norm = json.load(f)

    try:
        import pyarrow.parquet as pq
        have = set(pq.read_schema(str(parquet)).names)
        df = pd.read_parquet(parquet, columns=[c for c in SCORE_COLS if c in have])
    except Exception:
        df = pd.read_parquet(parquet)
    df = df.drop_duplicates(subset=["game_pk", "at_bat_number", "pitch_number"]).reset_index(drop=True)
    df = df[df["pitcher"].notna() & df["stand"].isin(["L", "R"]) & df["pitch_type"].notna()]
    print(f"  Scoring {len(df):,} pitches in chunks of {args.chunk:,} ...", file=sys.stderr)

    # samples[(pitcher, stand, pitch_type)][metric] -> list of + values
    samples = defaultdict(lambda: {m: [] for m in PLUS_SPEC})
    for start in range(0, len(df), args.chunk):
        chunk = sp._to_float64(df.iloc[start:start + args.chunk].copy())
        chunk = sp.score_dataframe(chunk, stuff, tunnel, location_models, weights)
        plus = {m: compute_plus(chunk, norm, m).to_numpy(float) for m in PLUS_SPEC}
        pit = pd.to_numeric(chunk["pitcher"], errors="coerce").to_numpy()
        std_ = chunk["stand"].to_numpy()
        pt = chunk["pitch_type"].to_numpy()
        ok = np.isfinite(plus["stuff"]) & np.isfinite(pit)   # loc/pitch/tun non-null on same rows
        for i in np.nonzero(ok)[0]:
            key = (int(pit[i]), std_[i], pt[i])
            for m in PLUS_SPEC:
                v = plus[m][i]
                if np.isfinite(v):
                    samples[key][m].append(v)
        print(f"    {min(start + args.chunk, len(df)):,}/{len(df):,}", file=sys.stderr)

    # Roll up per pitcher -> metric -> hand -> pitch_type -> KDE curve
    by_pitcher_total = defaultdict(int)
    for (pid, _, _), sd in samples.items():
        by_pitcher_total[pid] += len(sd["stuff"])

    out = {"meta": {"season": args.season, "xLo": X_LO, "xHi": X_HI, "nPts": N_PTS}}
    for (pid, hand, ptype), sd in samples.items():
        if by_pitcher_total[pid] < MIN_PITCHER_TOTAL:
            continue
        for m in PLUS_SPEC:
            curve = kde_on_grid(sd[m])
            if curve is None:
                continue
            entry = out.setdefault(str(pid), {})
            entry.setdefault(m, {}).setdefault(hand, {})[ptype] = curve

    n_pitchers = len(out) - 1
    Path(args.output_dir).mkdir(parents=True, exist_ok=True)
    outfile = Path(args.output_dir) / f"pitcher_grade_dist_{args.season}.json"
    with open(outfile, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"Wrote {outfile}: {n_pitchers:,} pitchers", file=sys.stderr)


if __name__ == "__main__":
    main()
