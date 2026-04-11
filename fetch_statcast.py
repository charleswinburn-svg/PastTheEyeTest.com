#!/usr/bin/env python3
"""
fetch_statcast.py — Pull a full season of Statcast pitch data via pybaseball
and save as the parquet format score_pitches.py expects.

Usage:
    python fetch_statcast.py --year 2025 --out pitch_xrv_2025.parquet
"""
import argparse
from pathlib import Path
import pandas as pd
from pybaseball import statcast


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--year', type=int, required=True)
    p.add_argument('--out', required=True)
    args = p.parse_args()

    start = f'{args.year}-03-15'
    end = f'{args.year}-11-15'
    print(f"Fetching Statcast {start} to {end}...")
    df = statcast(start_dt=start, end_dt=end)
    print(f"  {len(df):,} pitches")

    # Drop rows missing core trajectory features
    needed = ['release_speed', 'pfx_x', 'pfx_z', 'vy0', 'vz0', 'vx0',
              'ax', 'ay', 'az', 'release_pos_x', 'release_pos_z',
              'plate_x', 'plate_z', 'pitch_type', 'pitcher']
    before = len(df)
    df = df.dropna(subset=needed)
    print(f"  {before - len(df):,} dropped (missing features)")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out, index=False)
    print(f"Wrote {out}")


if __name__ == '__main__':
    main()
