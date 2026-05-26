#!/usr/bin/env python3
"""
build_pitcher_heights.py — Cache pitcher heights from the MLB Stats API.

Reads pitcher IDs from models/pitcher_arm_angles.json (and optionally a
Statcast parquet), queries the MLB Stats API in batches, parses height
strings ("6' 2\"") to decimal inches, and writes models/pitcher_heights.json.

Re-running is safe: existing entries are preserved and only unknowns are
fetched.

Pass --sport-ids to also pull full rosters from other leagues so their
heights are cached before they appear in a parquet:
  1  = MLB
  11 = AAA (Triple-A)
  51 = WBC / international tournaments

Usage:
    python3 build_pitcher_heights.py
    python3 build_pitcher_heights.py --parquet tmp/pitch_xrv_2026.parquet
    python3 build_pitcher_heights.py --sport-ids 1 11 51
    python3 build_pitcher_heights.py --parquet tmp/pitch_xrv_2026.parquet --sport-ids 1 11 51
"""
import argparse
import json
import re
import time
from pathlib import Path

import requests

REPO = Path(__file__).parent
MODELS_DIR = REPO / 'models'
DEFAULT_OUT = MODELS_DIR / 'pitcher_heights.json'
MLB_API = 'https://statsapi.mlb.com/api/v1'
BATCH_SIZE = 500
REQUEST_DELAY = 0.3

SPORT_LABELS = {1: 'MLB', 11: 'AAA', 12: 'AA', 51: 'WBC/International'}


def parse_height(s: str) -> float | None:
    """Convert MLB API height string like "6' 2\"" or "6-2" to decimal inches."""
    if not s:
        return None
    m = re.match(r"(\d+)['\-]\s*(\d+)", str(s))
    if m:
        return int(m.group(1)) * 12 + int(m.group(2))
    m2 = re.match(r"(\d+\.?\d*)", str(s))
    if m2:
        return float(m2.group(1))
    return None


def fetch_roster_pitcher_ids(sport_id: int, season: int) -> set[int]:
    """Return all pitcher IDs on active rosters for a given sport/season."""
    label = SPORT_LABELS.get(sport_id, f'sportId={sport_id}')
    pids: set[int] = set()
    try:
        teams_url = f'{MLB_API}/teams?sportId={sport_id}&season={season}'
        teams = requests.get(teams_url, timeout=30).json().get('teams', [])
        print(f'  {label}: {len(teams)} teams')
        for team in teams:
            tid = team.get('id')
            if not tid:
                continue
            try:
                roster_url = (f'{MLB_API}/teams/{tid}/roster'
                              f'?season={season}&rosterType=fullRoster')
                roster = requests.get(roster_url, timeout=20).json().get('roster', [])
                for p in roster:
                    pos_type = p.get('position', {}).get('type', '')
                    if pos_type == 'Pitcher':
                        pid = p.get('person', {}).get('id')
                        if pid:
                            pids.add(int(pid))
                time.sleep(0.05)
            except Exception:
                pass
    except Exception as e:
        print(f'  Warning: roster fetch for {label} failed: {e}')
    print(f'  {label}: {len(pids)} pitchers')
    return pids


def fetch_heights(pids: list[int]) -> dict[str, float]:
    """Query MLB Stats API for heights of the given pitcher IDs."""
    results = {}
    for i in range(0, len(pids), BATCH_SIZE):
        batch = pids[i:i + BATCH_SIZE]
        id_str = ','.join(str(p) for p in batch)
        url = f'{MLB_API}/people?personIds={id_str}&fields=people,id,height'
        try:
            r = requests.get(url, timeout=30)
            r.raise_for_status()
            for person in r.json().get('people', []):
                pid = str(person.get('id', ''))
                h = parse_height(person.get('height', ''))
                if pid and h is not None:
                    results[pid] = h
        except Exception as e:
            print(f'  Warning: batch {i//BATCH_SIZE + 1} failed: {e}')
        if i + BATCH_SIZE < len(pids):
            time.sleep(REQUEST_DELAY)
    return results


def collect_pitcher_ids(arm_angles_path: Path, parquet_path: Path | None,
                        sport_ids: list[int], season: int) -> set[int]:
    pids: set[int] = set()

    if arm_angles_path.exists():
        with open(arm_angles_path) as f:
            pids.update(int(k) for k in json.load(f))
        print(f'  {len(pids)} IDs from pitcher_arm_angles.json')

    if parquet_path and parquet_path.exists():
        import pandas as pd
        df = pd.read_parquet(parquet_path, columns=['pitcher'])
        parquet_pids = set(df['pitcher'].dropna().astype(int).unique())
        before = len(pids)
        pids.update(parquet_pids)
        print(f'  {len(pids) - before} additional IDs from parquet')

    if sport_ids:
        print(f'Fetching rosters for sport IDs {sport_ids} (season {season})...')
        for sid in sport_ids:
            before = len(pids)
            roster_pids = fetch_roster_pitcher_ids(sid, season)
            pids.update(roster_pids)
            print(f'  +{len(pids) - before} new IDs from roster')

    return pids


def main():
    import datetime
    current_year = datetime.date.today().year

    ap = argparse.ArgumentParser()
    ap.add_argument('--parquet', type=Path, default=None)
    ap.add_argument('--out', type=Path, default=DEFAULT_OUT)
    ap.add_argument('--sport-ids', type=int, nargs='+', default=[],
                    metavar='SPORT_ID',
                    help='Pull full pitcher rosters from these MLB Stats API sport IDs '
                         '(1=MLB, 11=AAA, 51=WBC/international). Heights are cached '
                         'for all pitchers on those rosters regardless of parquet content.')
    ap.add_argument('--season', type=int, default=current_year)
    args = ap.parse_args()

    out_path: Path = args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)

    existing: dict[str, float] = {}
    if out_path.exists():
        with open(out_path) as f:
            existing = json.load(f)
        print(f'Loaded {len(existing)} existing entries from {out_path.name}')

    print('Collecting pitcher IDs...')
    all_pids = collect_pitcher_ids(
        MODELS_DIR / 'pitcher_arm_angles.json',
        args.parquet,
        args.sport_ids,
        args.season,
    )
    missing = [p for p in sorted(all_pids) if str(p) not in existing]
    print(f'{len(all_pids)} total IDs, {len(missing)} missing from cache')

    if missing:
        print(f'Fetching {len(missing)} heights from MLB Stats API...')
        fetched = fetch_heights(missing)
        print(f'  Resolved {len(fetched)} / {len(missing)} heights')
        existing.update(fetched)

    with open(out_path, 'w') as f:
        json.dump(existing, f, indent=2)
    print(f'Wrote {len(existing)} entries -> {out_path}')


if __name__ == '__main__':
    main()
