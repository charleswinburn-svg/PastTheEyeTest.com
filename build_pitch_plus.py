#!/usr/bin/env python3
"""
build_pitch_plus.py — Convert score_pitches.py season output into a compact
Pitch+ lookup the React app loads at /pitch_plus_{year}.json.

Pitch+ scale: 100 = league average for that pitch type, 110 = 1 std better
(lower xRV), 90 = 1 std worse. Higher = better pitch.

Usage:
    python build_pitch_plus.py \\
        --season-dir ./output/season \\
        --year 2025 \\
        --out ./public/pitch_plus_2025.json \\
        --min-pitches 50
"""
import argparse
import json
from pathlib import Path
import pandas as pd


def build(season_dir: Path, year: int, out_path: Path, min_pitches: int = 50):
    src = season_dir / f'pitcher_pitch_type_grades_{year}.json'
    with open(src) as f:
        data = json.load(f)

    rows = []
    for pid, types in data.items():
        for pt, g in types.items():
            if g.get('n', 0) >= min_pitches:
                rows.append({'pitcher_id': int(pid), 'pitch_type': pt,
                             'n': g['n'], 'xRV': g['xRV']})

    if not rows:
        print(f"No rows with >= {min_pitches} pitches")
        return

    df = pd.DataFrame(rows)
    out = {}
    for pt, sub in df.groupby('pitch_type'):
        mean = sub['xRV'].mean()
        std = sub['xRV'].std()
        if std == 0 or pd.isna(std):
            continue
        for _, row in sub.iterrows():
            z = (row['xRV'] - mean) / std
            # Lower xRV is better for the pitcher, so subtract z (invert)
            pitch_plus = float(round(100 - z * 10, 1))
            pid = str(row['pitcher_id'])
            out.setdefault(pid, {})[pt] = pitch_plus

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, 'w') as f:
        json.dump(out, f, separators=(',', ':'))

    print(f"Wrote {len(out)} pitchers to {out_path}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--season-dir', required=True)
    p.add_argument('--year', type=int, required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--min-pitches', type=int, default=50)
    args = p.parse_args()
    build(Path(args.season_dir), args.year, Path(args.out), args.min_pitches)


if __name__ == '__main__':
    main()
