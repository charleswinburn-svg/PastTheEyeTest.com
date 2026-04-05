#!/usr/bin/env python3
"""
prospect_xwoba_pipeline.py — Convert AAA hitter summary CSVs into prospect_xwoba.json.

Reads CSV files with AAA hitter data (e.g. from Prospect Savant) and merges
xwOBA values into public/prospect_xwoba.json keyed by player name and season.

Usage:
  python3 prospect_xwoba_pipeline.py                          # default: 2026
  python3 prospect_xwoba_pipeline.py 2026
  python3 prospect_xwoba_pipeline.py 2025,2026
  python3 prospect_xwoba_pipeline.py 2026 --csv path/to/file.csv
  python3 prospect_xwoba_pipeline.py 2026 --output-dir ./public

Input CSV format:
  Must have columns: Name, xwOBA
  Default CSV path: ./public/aaa_hitter_summaries_{season}.csv

Output:
  {output_dir}/prospect_xwoba.json
"""

import csv
import json
import os
import sys
import argparse


def load_existing(path):
    """Load existing prospect_xwoba.json if it exists."""
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def parse_xwoba(val):
    """Parse xwOBA string (e.g. '.504', '0.504') to float, return None if invalid."""
    if not val or not val.strip():
        return None
    try:
        v = float(val)
        if v > 0:
            return round(v, 3)
    except (ValueError, TypeError):
        pass
    return None


def process_csv(csv_path, season):
    """Read a CSV and return dict of {name: xwoba} for the season."""
    players = {}
    with open(csv_path, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = row.get("Name", "").strip()
            xwoba = parse_xwoba(row.get("xwOBA", ""))
            if name and xwoba is not None:
                players[name] = xwoba
    return players


def run_pipeline(seasons, csv_paths, output_dir):
    os.makedirs(output_dir, exist_ok=True)
    out_path = os.path.join(output_dir, "prospect_xwoba.json")

    # Load existing data
    data = load_existing(out_path)
    print(f"Existing prospect_xwoba.json: {len(data)} players")

    for season, csv_path in zip(seasons, csv_paths):
        yr = str(season)
        print(f"\n{'='*50}")
        print(f"Processing season {yr}: {csv_path}")
        print(f"{'='*50}")

        if not os.path.exists(csv_path):
            print(f"  ✗ CSV not found: {csv_path}")
            continue

        players = process_csv(csv_path, season)
        print(f"  ✓ {len(players)} players with valid xwOBA")

        # Merge into existing data
        added = 0
        updated = 0
        for name, xwoba in players.items():
            if name not in data:
                data[name] = {}
                added += 1
            elif yr in data[name]:
                updated += 1
            else:
                added += 1
            data[name][yr] = xwoba

        print(f"  ✓ {added} new entries, {updated} updated")

    # Write output
    # Sort by name for consistency
    sorted_data = dict(sorted(data.items()))
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(sorted_data, f, indent=2, ensure_ascii=False)

    print(f"\n{'='*50}")
    print(f"Wrote {out_path}: {len(sorted_data)} total players")
    print(f"{'='*50}\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Prospect xwOBA Pipeline")
    parser.add_argument("season", nargs="?", default="2026",
                        help="Comma-separated seasons (default: 2026)")
    parser.add_argument("--csv", default=None,
                        help="Path to CSV file (default: ./public/aaa_hitter_summaries_{season}.csv)")
    parser.add_argument("--output-dir", default="./public",
                        help="Output directory (default: ./public)")
    args = parser.parse_args()

    seasons = [int(s.strip()) for s in args.season.split(",")]

    if args.csv:
        csv_paths = [args.csv] * len(seasons)
    else:
        csv_paths = [
            os.path.join(args.output_dir, f"aaa_hitter_summaries_{s}.csv")
            for s in seasons
        ]

    run_pipeline(seasons, csv_paths, args.output_dir)
