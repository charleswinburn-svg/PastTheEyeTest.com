#!/usr/bin/env python3
"""
fetch_statcast.py — Pull a full season of Statcast pitch data directly from
Baseball Savant and save as the parquet format score_pitches.py expects.

Uses savant_fetch instead of pybaseball.statcast(): pybaseball hits the same
endpoint without browser headers and was returning empty on the droplet, so the
xRV parquet (pitch_xrv_{year}.parquet) was never being rebuilt. The Savant detail
CSV is column-for-column what pybaseball returned, so the parquet is unchanged.

Usage:
    python fetch_statcast.py --year 2025 --out pitch_xrv_2025.parquet
"""
import argparse
from pathlib import Path
import pandas as pd
from savant_fetch import fetch_savant_range


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--year', type=int, required=True)
    p.add_argument('--out', required=True)
    args = p.parse_args()

    start = f'{args.year}-03-15'
    end = f'{args.year}-11-15'
    print(f"Fetching Statcast {start} to {end} (Savant)...")
    df = fetch_savant_range(args.year, start, end, player_type='pitcher')
    if df is None or len(df) == 0:
        raise SystemExit("ERROR: no Statcast rows returned from Savant.")
    print(f"  {len(df):,} pitches")

    # Drop rows missing core trajectory features
    needed = ['release_speed', 'pfx_x', 'pfx_z', 'vy0', 'vz0', 'vx0',
              'ax', 'ay', 'az', 'release_pos_x', 'release_pos_z',
              'plate_x', 'plate_z', 'pitch_type', 'pitcher']
    before = len(df)
    df = df.dropna(subset=needed)
    print(f"  {before - len(df):,} dropped (missing features)")

    # game_date comes from the Savant CSV as 'YYYY-MM-DD' strings; keep it string
    # so pyarrow can't choke on mixed Timestamp objects. (The pybaseball path
    # failed here: ArrowTypeError "Expected bytes, got a 'Timestamp' object".)
    if 'game_date' in df.columns:
        df['game_date'] = df['game_date'].astype(str)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out, index=False)
    print(f"Wrote {out}")


if __name__ == '__main__':
    main()
