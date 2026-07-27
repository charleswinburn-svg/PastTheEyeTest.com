#!/usr/bin/env python3
"""
league_avgs_pipeline.py — Fetch actual league-wide averages per pitch type from Savant.
Outputs league_avgs.json with zone%, whiff%, velo, spin per pitch type.

Usage: python3 league_avgs_pipeline.py ./public [season]

Fetches the full season through savant_fetch.fetch_savant_range (4-day chunks with
recursive splitting on Savant's 25,000-row cap), streaming ~2-week windows and
accumulating per-pitch-type running stats so the whole season never sits in memory
at once. The previous version pulled 60–72 day windows in a single request each, so
Savant silently truncated every window at 25k rows (~90% of pitches were dropped).
"""
import json, os, sys, time
from collections import defaultdict
from datetime import date, timedelta

import pandas as pd

from savant_fetch import fetch_savant_range  # robust chunked fetch (handles the 25k cap)

SWING_DESCS = {"swinging_strike", "swinging_strike_blocked", "foul", "foul_tip",
               "foul_bunt", "missed_bunt", "hit_into_play", "hit_into_play_no_out",
               "hit_into_play_score", "foul_pitchout", "swinging_pitchout"}
WHIFF_DESCS = {"swinging_strike", "swinging_strike_blocked", "foul_tip", "missed_bunt", "swinging_pitchout"}


def _biweekly(season):
    """~2-week windows across the regular season — small enough that each
    fetch_savant_range result stays light on a 2 GB box."""
    s, end = date(season, 3, 20), date(season, 10, 2)
    while s <= end:
        e = min(s + timedelta(days=13), end)
        yield s.isoformat(), e.isoformat()
        s = e + timedelta(days=1)


def _blank():
    return dict(count=0, velo_sum=0.0, velo_n=0, spin_sum=0.0, spin_n=0,
                ext_sum=0.0, ext_n=0, zoned=0, in_zone=0, swings=0, whiffs=0)


def _accumulate(df, acc):
    """Fold one window's pitches into the per-pitch-type running accumulators."""
    for col in ["release_speed", "release_spin_rate", "plate_x", "plate_z",
                "sz_top", "sz_bot", "release_extension"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    # In-zone (matches the old row-wise logic, vectorized): standard Savant zone,
    # plate width ±0.83 ft, sz_bot..sz_top, no buffer. Rows missing plate coords
    # don't count toward the zone denominator.
    px = df["plate_x"] if "plate_x" in df.columns else pd.Series(pd.NA, index=df.index)
    pz = df["plate_z"] if "plate_z" in df.columns else pd.Series(pd.NA, index=df.index)
    szt = df["sz_top"].fillna(3.5) if "sz_top" in df.columns else 3.5
    szb = df["sz_bot"].fillna(1.5) if "sz_bot" in df.columns else 1.5
    valid = px.notna() & pz.notna()
    in_zone = valid & (px.abs() <= 0.83) & (pz >= szb) & (pz <= szt)

    desc = df["description"] if "description" in df.columns else pd.Series("", index=df.index)
    ext = df["release_extension"] if "release_extension" in df.columns else pd.Series(float("nan"), index=df.index)

    g = pd.DataFrame({
        "pt": df["pitch_type"].astype("string").str.strip(),
        "velo": df.get("release_speed"),
        "spin": df.get("release_spin_rate"),
        "ext": ext,
        "valid": valid.astype("int64"),
        "in_zone": in_zone.astype("int64"),
        "swing": desc.isin(SWING_DESCS).astype("int64"),
        "whiff": desc.isin(WHIFF_DESCS).astype("int64"),
    })
    g = g[g["pt"].notna() & (g["pt"] != "")]
    if g.empty:
        return
    agg = g.groupby("pt").agg(
        count=("pt", "size"),
        velo_sum=("velo", "sum"), velo_n=("velo", "count"),
        spin_sum=("spin", "sum"), spin_n=("spin", "count"),
        ext_sum=("ext", "sum"), ext_n=("ext", "count"),
        zoned=("valid", "sum"), in_zone=("in_zone", "sum"),
        swings=("swing", "sum"), whiffs=("whiff", "sum"),
    )
    for pt, row in agg.iterrows():
        a = acc[str(pt)]
        a["count"] += int(row["count"])
        a["velo_sum"] += float(row["velo_sum"]); a["velo_n"] += int(row["velo_n"])
        a["spin_sum"] += float(row["spin_sum"]); a["spin_n"] += int(row["spin_n"])
        a["ext_sum"] += float(row["ext_sum"]);   a["ext_n"] += int(row["ext_n"])
        a["zoned"] += int(row["zoned"]);         a["in_zone"] += int(row["in_zone"])
        a["swings"] += int(row["swings"]);       a["whiffs"] += int(row["whiffs"])


def run(output_dir, season=2025):
    os.makedirs(output_dir, exist_ok=True)
    print(f"Fetching {season} league averages from Savant...")

    acc = defaultdict(_blank)
    total = 0
    for start, end in _biweekly(season):
        print(f"  Window {start} → {end} ...")
        df = fetch_savant_range(season, start, end, player_type="pitcher", game_type="R")
        if df is None or len(df) == 0:
            continue
        total += len(df)
        _accumulate(df, acc)
        del df

    print(f"\n  Total pitches: {total:,}")
    if total == 0:
        print("No data fetched!")
        return

    # Group by pitch type
    result = {}
    for pt, a in acc.items():
        if a["count"] < 500:
            continue
        result[pt] = {
            "count": a["count"],
            "velo": round(a["velo_sum"] / a["velo_n"], 1) if a["velo_n"] else None,
            "spin": round(a["spin_sum"] / a["spin_n"]) if a["spin_n"] else None,
            "zone_pct": round(a["in_zone"] / a["zoned"] * 100, 1) if a["zoned"] else None,
            "whiff_pct": round(a["whiffs"] / a["swings"] * 100, 1) if a["swings"] else None,
            "extension": round(a["ext_sum"] / a["ext_n"], 2) if a["ext_n"] else None,
        }
        print(f"  {pt}: {a['count']:,} pitches | Velo {result[pt]['velo']} | "
              f"Zone% {result[pt]['zone_pct']} | Whiff% {result[pt]['whiff_pct']}")

    output = {
        "season": season,
        "pitch_types": result,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
    }

    fpath = os.path.join(output_dir, f"league_avgs_{season}.json")
    with open(fpath, "w") as f:
        json.dump(output, f, indent=2)
    print(f"\n  → Wrote {fpath}")


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "./public"
    yr = int(sys.argv[2]) if len(sys.argv) > 2 else 2025
    run(out, yr)
