#!/usr/bin/env python3
"""
fetch_statcast_aaa.py — Pull AAA (Triple-A) Statcast pitch data from Baseball
Savant's minor-league search into pitch_aaa_{year}.parquet, the AAA counterpart
of pitch_xrv_{year}.parquet (fetch_statcast.py).

AAA data lives ONLY in this parquet; nothing MLB reads it. score_pitches.py
--level aaa, build_pitcher_arsenal.py --level aaa and build_pitcher_grade_dist.py
--level aaa turn it into the separate *_aaa_* season files.

Savant's minor-league search is a different endpoint from the MLB one, and the
plain MLB statcast_search ignores level filters (that's how evla_aaa_*.json ended
up identical to the MLB file). So every run first VALIDATES the source: a short
known-active window must come back with AAA home teams and game_pks that are on
the MLB Stats API AAA schedule (sportId=11). If no URL variant validates, the
script stops instead of writing MLB data into the AAA parquet.

Usage:
    python3 fetch_statcast_aaa.py --probe 2025                 # check the source, write nothing
    python3 fetch_statcast_aaa.py --year 2026                  # incremental (new days only)
    python3 fetch_statcast_aaa.py --year 2025 --full           # re-pull the whole season
        [--out pitch_aaa_2026.parquet]
"""
import argparse
import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import requests

from savant_fetch import HTTP_HEADERS, SAVANT_BASE, SAVANT_ROW_CAP, csv_to_df, fetch_url, iter_chunks

STATSAPI = "https://statsapi.mlb.com/api/v1"
CHUNK_DAYS = 4

# Savant team codes for the 30 MLB clubs (incl. renames). An AAA game's home team
# is never one of these.
MLB_TEAMS = {"AZ", "ARI", "ATL", "BAL", "BOS", "CHC", "CWS", "CHW", "CIN", "CLE", "COL", "DET",
             "HOU", "KC", "KCR", "LAA", "LAD", "MIA", "MIL", "MIN", "NYM", "NYY", "ATH", "OAK",
             "PHI", "PIT", "SD", "SDP", "SEA", "SF", "SFG", "STL", "TB", "TBR", "TEX", "TOR",
             "WSH", "WSN"}
# The 30 AAA clubs (International League + Pacific Coast League), Stats API codes.
# Columbus is "COL" like the Rockies, so it counts here rather than in the non-MLB share.
AAA_TEAMS = {"BUF", "CLT", "COL", "DUR", "GWN", "IND", "IOW", "JAX", "LHV", "LOU", "MEM", "NAS",
             "NOR", "OMA", "ROC", "SWB", "STP", "SYR", "TOL", "WOR",
             "ABQ", "ELP", "LV", "OKC", "RNO", "RR", "SAC", "SL", "SUG", "TAC"}

# Columns score_pitches.py requires, plus the ones the arsenal/distribution builders use.
NEEDED = ['release_speed', 'pfx_x', 'pfx_z', 'vy0', 'vz0', 'vx0', 'ax', 'ay', 'az',
          'release_pos_x', 'release_pos_z', 'plate_x', 'plate_z', 'pitch_type', 'pitcher']
SCORING_COLS = NEEDED + ['release_pos_y', 'release_spin_rate', 'release_extension', 'spin_axis',
                         'stand', 'p_throws', 'game_pk', 'at_bat_number', 'pitch_number', 'game_date']
OPTIONAL_COLS = ['estimated_woba_using_speedangle', 'estimated_ba_using_speedangle', 'zone',
                 'description', 'events', 'launch_speed', 'delta_run_exp', 'arm_angle']


def _variants(season, start, end):
    """Candidate minor-league query URLs, most likely first."""
    common = (f"all=true&type=details&player_type=pitcher&hfGT=R%7C&hfSea={season}%7C"
              f"&game_date_gt={start}&game_date_lt={end}&min_pitches=0&min_results=0&min_pas=0")
    return {
        'minors-endpoint+hfLevel+minors': f"{SAVANT_BASE}/statcast-search-minors/csv?{common}&hfLevel=AAA%7C&minors=true",
        'minors-endpoint+hfLevel':        f"{SAVANT_BASE}/statcast-search-minors/csv?{common}&hfLevel=AAA%7C",
        'mlb-endpoint+hfLevel+minors':    f"{SAVANT_BASE}/statcast_search/csv?{common}&hfLevel=AAA%7C&minors=true",
    }


def aaa_game_pks(start, end):
    """game_pks on the MLB Stats API AAA schedule (sportId=11) for [start, end],
    or None if the schedule couldn't be fetched. Browser headers like the other
    pipelines: the Stats API answers a bare python-requests client with 406."""
    for attempt in range(1, 4):
        try:
            r = requests.get(f"{STATSAPI}/schedule", params={"sportId": 11, "startDate": start, "endDate": end},
                             headers=HTTP_HEADERS, timeout=60)
            r.raise_for_status()
            return {g["gamePk"] for d in r.json().get("dates", []) for g in d.get("games", [])}
        except Exception as e:
            print(f"    ⚠ AAA schedule lookup failed (attempt {attempt}/3): {e}")
    return None


def validate(df, start, end, verbose=True):
    """True when df looks like genuine AAA pitches with the scoring columns.

    Home teams must be AAA clubs (MLB data would show MLB clubs). When the Stats API
    schedule is reachable, the game_pks must also be on the AAA schedule; when it
    isn't, the home-team check decides on its own."""
    if df is None or len(df) == 0:
        if verbose:
            print("    rows: 0")
        return False
    teams = df['home_team'].astype(str).str.upper() if 'home_team' in df.columns else pd.Series(dtype=str)
    aaa_share = float(teams.isin(AAA_TEAMS).mean()) if len(teams) else 0.0
    non_mlb = float((~teams.isin(MLB_TEAMS)).mean()) if len(teams) else 0.0
    sched = aaa_game_pks(start, end)
    pks = set(pd.to_numeric(df.get('game_pk'), errors='coerce').dropna().astype(int)) if 'game_pk' in df.columns else set()
    on_sched = None if sched is None else (len(pks & sched) / len(pks) if pks else 0.0)
    missing = [c for c in SCORING_COLS if c not in df.columns]
    if verbose:
        print(f"    rows: {len(df):,}   games: {len(pks)}   home teams: {sorted(teams.unique())}")
        print(f"    AAA-club home teams: {aaa_share:.0%}   non-MLB home teams: {non_mlb:.0%}")
        if sched is None:
            print("    game_pks on AAA schedule: n/a (schedule unavailable — deciding on home teams)")
        else:
            print(f"    game_pks on AAA schedule: {on_sched:.0%}   ({len(sched)} AAA games scheduled)")
        print(f"    missing scoring columns: {missing or 'none'}")
        opt = [c for c in OPTIONAL_COLS if c in df.columns]
        print(f"    optional columns present: {opt}")
        if 'estimated_woba_using_speedangle' in df.columns:
            print(f"    xwOBA populated on {df['estimated_woba_using_speedangle'].notna().mean():.0%} of rows")
    return aaa_share >= 0.8 and (on_sched is None or on_sched >= 0.5) and not missing


def pick_variant(season):
    """Return the name of the first URL variant that validates on a known-active window."""
    start, end = f"{season}-06-10", f"{season}-06-12"
    for name, url in _variants(season, start, end).items():
        print(f"  Trying {name} ({start}→{end})...", flush=True)
        df = csv_to_df(fetch_url(url))
        if validate(df, start, end):
            print(f"  ✓ {name} returns AAA data")
            return name
        print(f"  ✗ {name} is not AAA data")
    return None


def fetch_window(variant, season, s, e):
    """Fetch [s, e]; split on Savant's row cap. None if the fetch failed."""
    df = csv_to_df(fetch_url(_variants(season, s.isoformat(), e.isoformat())[variant]))
    if df is None:
        return None
    if len(df) >= SAVANT_ROW_CAP and s < e:
        mid = s + (e - s) // 2
        left = fetch_window(variant, season, s, mid)
        right = fetch_window(variant, season, mid + timedelta(days=1), e)
        return None if left is None or right is None else pd.concat([left, right], ignore_index=True)
    return df


def clean(df):
    for c in ['game_pk', 'at_bat_number', 'pitch_number', 'pitcher']:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors='coerce')
    before = len(df)
    df = df.dropna(subset=[c for c in NEEDED + ['game_pk', 'at_bat_number', 'pitch_number'] if c in df.columns])
    df = df.drop_duplicates(subset=['game_pk', 'at_bat_number', 'pitch_number'], keep='first')
    print(f"  {before - len(df):,} dropped (missing features / duplicates)")
    if 'game_date' in df.columns:
        df['game_date'] = df['game_date'].astype(str)
    df['level'] = 'AAA'
    return df.reset_index(drop=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--probe', type=int, metavar='YEAR', help='validate the Savant AAA source and exit')
    ap.add_argument('--year', type=int)
    ap.add_argument('--out', default=None, help='default: pitch_aaa_{year}.parquet')
    ap.add_argument('--full', action='store_true', help='re-pull the whole season')
    args = ap.parse_args()

    if args.probe:
        v = pick_variant(args.probe)
        print(f"\nRESULT: {'USE ' + v if v else 'NO VARIANT RETURNED AAA DATA — do not run the AAA pipeline'}")
        sys.exit(0 if v else 2)
    if not args.year:
        ap.error('--year or --probe is required')

    out = Path(args.out or f'pitch_aaa_{args.year}.parquet')
    if '_aaa_' not in out.name and not out.name.startswith('pitch_aaa'):
        sys.exit(f'Refusing to write AAA data to {out} — AAA output names must contain "aaa".')

    season_start, season_end = date(args.year, 3, 25), date(args.year, 9, 30)
    end = min(season_end, date.today() - timedelta(days=1))
    existing = None
    start = season_start
    if out.exists() and not args.full:
        existing = pd.read_parquet(out)
        last = pd.to_datetime(existing['game_date'], errors='coerce').max()
        if pd.notna(last):
            start = last.date() + timedelta(days=1)
    if start > end:
        print(f'{out} is up to date through {start - timedelta(days=1)} — nothing to fetch.')
        return

    variant = pick_variant(args.year)
    if not variant:
        sys.exit('ERROR: no Savant URL variant returned AAA data — nothing written. Run --probe for details.')

    print(f'Fetching AAA Statcast {start} → {end} ({variant})...')
    frames = []
    for s, e in iter_chunks(start, end, days=CHUNK_DAYS):
        df = fetch_window(variant, args.year, date.fromisoformat(s), date.fromisoformat(e))
        if df is None:
            sys.exit(f'ERROR: Savant fetch failed for {s}→{e} — nothing written (re-run to retry).')
        print(f'  {s} → {e}: {len(df):,} pitches', flush=True)
        if len(df):
            frames.append(df)
    if not frames:
        print('No AAA pitches in that window (off-day / off-season).')
        return
    new = clean(pd.concat(frames, ignore_index=True))
    if existing is not None:
        new = clean(pd.concat([existing, new], ignore_index=True))
    out.parent.mkdir(parents=True, exist_ok=True)
    new.to_parquet(out, index=False)
    print(f'Wrote {out}: {len(new):,} AAA pitches, {new["pitcher"].nunique():,} pitchers, '
          f'through {new["game_date"].max()}')


if __name__ == '__main__':
    main()
