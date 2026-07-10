#!/usr/bin/env python3
"""
build_pitcher_arsenal.py — Precompute the pitcher-card arsenal panel for every
pitcher from the season Statcast parquet, so the cards load instantly instead of
live-fetching Baseball Savant per pitcher.

Reads pitch_xrv_{season}.parquet (built by fetch_statcast.py — it already holds
every pitch of the season) and writes public/pitcher_arsenal_{season}.json keyed
by pitcher MLBAM id. Each entry has:
  movement : [[pitch_type, hBreak_in, iVB_in], …]   (sampled points for the plot)
  usage    : {"L": {pitch_type: n, …}, "R": {…}}      (pitch usage by batter hand)
  arsenal  : [{type, n, xwoba, ev, xba, whiffPct, zonePct, kPct}, …]

The aggregation mirrors src/baseball/PitcherArsenal.jsx exactly (pitcher's-
perspective movement = -pfx_x*12 / pfx_z*12; Zone% via the gameday zone 1-9;
Avg EV over balls in play only; xwOBA/xBA over all PA outcomes). AAA is not in
this parquet, so AAA cards keep live-fetching via play-by-play.

Usage:
  python3 build_pitcher_arsenal.py --season 2026 \
      --parquet pitch_xrv_2026.parquet --output-dir ./public
"""
import argparse
import json
import os
from pathlib import Path

import numpy as np
import pandas as pd

SWING = {"swinging_strike", "swinging_strike_blocked", "foul", "foul_tip",
         "hit_into_play", "foul_bunt", "missed_bunt", "bunt_foul_tip", "swinging_pitchout"}
WHIFF = {"swinging_strike", "swinging_strike_blocked", "foul_tip", "swinging_pitchout"}
K_EVENTS = {"strikeout", "strikeout_double_play"}

MIN_PITCHES = 100        # skip pitchers with too little data (card falls back to live fetch)
MOVEMENT_SAMPLE = 160    # points per pitcher stored for the movement plot


def _num(s):
    return pd.to_numeric(s, errors="coerce")


def _round(v, nd):
    return None if v is None or (isinstance(v, float) and not np.isfinite(v)) else round(float(v), nd)


def _col(df, name):
    """Column `name` if present, else an all-NA Series — so a Savant schema drift
    that drops an optional outcome column degrades that metric to null instead of
    crashing the daily job."""
    if name in df.columns:
        return df[name]
    print(f"  WARNING: column '{name}' missing — its metric will be null")
    return pd.Series(pd.NA, index=df.index)


def build(df: pd.DataFrame) -> dict:
    df = df[df["pitch_type"].notna() & ~df["pitch_type"].isin(["UN", "PO"])].copy()
    df["pitcher"] = _num(df["pitcher"]).astype("Int64")
    df = df[df["pitcher"].notna()]

    desc = _col(df, "description").astype("string").fillna("")
    events = _col(df, "events").astype("string").fillna("").str.strip()
    zone = _num(_col(df, "zone"))
    est_woba = _num(_col(df, "estimated_woba_using_speedangle"))
    est_ba = _num(_col(df, "estimated_ba_using_speedangle"))
    wv, wd = _num(_col(df, "woba_value")), _num(_col(df, "woba_denom"))

    df["_swing"] = desc.isin(SWING)
    df["_whiff"] = desc.isin(WHIFF)
    df["_zone"] = zone.between(1, 9)
    df["_term"] = events != ""
    df["_k"] = events.isin(K_EVENTS)
    # Avg EV: balls in play only (excludes fouls, which also carry a launch_speed)
    df["_ev"] = _num(_col(df, "launch_speed")).where(desc == "hit_into_play")
    # xwOBA over PA outcomes: estimated_woba for batted balls, else the actual
    # woba_value (K=0, BB≈.69, …); only rows that count toward wOBA (denom>=1).
    woba_num = est_woba.where(est_woba.notna(), wv)
    df["_woba"] = woba_num.where(df["_term"] & (wd >= 1) & woba_num.notna())
    # xBA over at-bats: estimated_ba for batted balls, 0 for strikeouts.
    ab = df["_term"] & (est_ba.notna() | df["_k"])
    df["_ba"] = est_ba.where(est_ba.notna(), 0.0).where(ab)
    # Movement (pitcher's perspective, inches)
    df["_hb"] = (-_num(df["pfx_x"]) * 12)
    df["_vb"] = (_num(df["pfx_z"]) * 12)

    grp = df.groupby(["pitcher", "pitch_type"], observed=True)
    agg = grp.agg(
        n=("pitch_type", "size"),
        swings=("_swing", "sum"),
        whiffs=("_whiff", "sum"),
        zone=("_zone", "sum"),
        ev_sum=("_ev", "sum"), ev_cnt=("_ev", "count"),
        pa=("_term", "sum"),
        k=("_k", "sum"),
        woba_sum=("_woba", "sum"), woba_cnt=("_woba", "count"),
        ba_sum=("_ba", "sum"), ba_cnt=("_ba", "count"),
    ).reset_index()

    def pct(a, b):
        return _round(a / b * 100, 1) if b else None

    # Usage by batter hand
    df["_stand"] = _col(df, "stand")
    usage_grp = (df[df["_stand"].isin(["L", "R"])]
                 .groupby(["pitcher", "_stand", "pitch_type"], observed=True).size())

    out = {}
    for pid, rows in agg.groupby("pitcher", observed=True):
        total = int(rows["n"].sum())
        if total < MIN_PITCHES:
            continue
        arsenal = []
        for _, r in rows.sort_values("n", ascending=False).iterrows():
            arsenal.append({
                "type": r["pitch_type"],
                "n": int(r["n"]),
                "xwoba": _round(r["woba_sum"] / r["woba_cnt"], 3) if r["woba_cnt"] else None,
                "ev": _round(r["ev_sum"] / r["ev_cnt"], 1) if r["ev_cnt"] else None,
                "xba": _round(r["ba_sum"] / r["ba_cnt"], 3) if r["ba_cnt"] else None,
                "whiffPct": pct(r["whiffs"], r["swings"]),
                "zonePct": pct(r["zone"], r["n"]),
                "kPct": pct(r["k"], r["pa"]),
            })

        usage = {"L": {}, "R": {}}
        if pid in usage_grp.index.get_level_values(0):
            for (hand, pt), cnt in usage_grp.loc[pid].items():
                usage[hand][pt] = int(cnt)

        pdf = df[(df["pitcher"] == pid) & df["_hb"].notna() & df["_vb"].notna()]
        if len(pdf) > MOVEMENT_SAMPLE:
            pdf = pdf.sample(MOVEMENT_SAMPLE, random_state=0)
        movement = [[pt, int(round(h)), int(round(v))]
                    for pt, h, v in zip(pdf["pitch_type"], pdf["_hb"], pdf["_vb"])]

        out[str(int(pid))] = {"movement": movement, "usage": usage, "arsenal": arsenal}
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--season", type=int, required=True)
    p.add_argument("--parquet", default=None, help="default: pitch_xrv_{season}.parquet")
    p.add_argument("--output-dir", default="./public")
    args = p.parse_args()

    parquet = Path(args.parquet or f"pitch_xrv_{args.season}.parquet")
    if not parquet.exists():
        raise SystemExit(f"ERROR: parquet not found: {parquet} (run fetch_statcast.py first)")
    print(f"Reading {parquet} …")
    df = pd.read_parquet(parquet)
    print(f"  {len(df):,} pitches")

    data = build(df)
    os.makedirs(args.output_dir, exist_ok=True)
    out = Path(args.output_dir) / f"pitcher_arsenal_{args.season}.json"
    with open(out, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    print(f"Wrote {out}: {len(data):,} pitchers")


if __name__ == "__main__":
    main()
