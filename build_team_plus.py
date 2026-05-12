#!/usr/bin/env python3
"""
build_team_plus.py — End-to-end pipeline to produce team-level Stuff+/Location+/
Tunnel+/Pitch+ split by starter vs. reliever for a given season.

Pipeline:
  1. Fetch Statcast for the season (or load a cached parquet via --parquet).
  2. Score every pitch with the trained 3-stage models in ./models.
  3. Classify each pitcher's role per game (starter = threw the first pitch
     for his team in that game; everyone else is a reliever).
  4. Aggregate xRV_stuff / xRV_location / xRV_tunnel / xRV_final to the
     (team, role) level, then convert each to a "+" scale where
     100 = league avg across all team-role rows and +/-10 = 1 std (lower xRV
     is better, so higher + is better).
  5. Write public/team_plus_<year>.json.

Usage:
    # Full run (fetches Statcast via pybaseball — slow):
    python3 build_team_plus.py --year 2026

    # Skip the fetch step if you already have the parquet:
    python3 build_team_plus.py --year 2026 --parquet pitch_xrv_2026.parquet

Output schema (public/team_plus_<year>.json):
    {
      "season": 2026,
      "teams": {
        "NYY": {
          "starter":  {"stuff": 104.3, "location": 98.7, "tunnel": 101.1,
                       "pitch": 103.0, "n": 4321},
          "reliever": {"stuff":  99.1, "location": 105.2, "tunnel": 100.4,
                       "pitch": 102.6, "n": 1844}
        },
        ...
      }
    }
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

# Reuse the feature engineering + scoring from score_pitches.py
sys.path.insert(0, str(Path(__file__).parent))
from score_pitches import load_models, score_dataframe


def load_weights(config_path: Path) -> dict:
    with open(config_path) as f:
        return json.load(f)


REPO = Path(__file__).parent
MODELS_DIR = REPO / 'models'
CONFIG_PATH = MODELS_DIR / 'final_model_config.json'


def fetch_statcast(year: int, out_parquet: Path) -> Path:
    """Fetch a full season via pybaseball and save as parquet."""
    from pybaseball import statcast
    start = f'{year}-03-15'
    end = f'{year}-11-15'
    print(f'Fetching Statcast {start} → {end} ...')
    df = statcast(start_dt=start, end_dt=end)
    if df is None or len(df) == 0:
        raise RuntimeError(f'No Statcast rows returned for {year}. '
                           f'The season may not have started yet.')
    print(f'  {len(df):,} pitches')
    needed = ['release_speed', 'pfx_x', 'pfx_z', 'vy0', 'vz0', 'vx0',
              'ax', 'ay', 'az', 'release_pos_x', 'release_pos_z',
              'plate_x', 'plate_z', 'pitch_type', 'pitcher',
              'game_pk', 'at_bat_number', 'inning_topbot',
              'home_team', 'away_team']
    before = len(df)
    df = df.dropna(subset=[c for c in needed if c in df.columns])
    print(f'  dropped {before - len(df):,} rows missing core features')
    out_parquet.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out_parquet, index=False)
    print(f'  wrote {out_parquet}')
    return out_parquet


def classify_roles(df: pd.DataFrame) -> pd.DataFrame:
    """Return df with a 'role' column (starter | reliever) and 'pitching_team'.

    Starter = the pitcher who threw the lowest at_bat_number for his team in
    a given game. Top of inning => home team pitching. Bottom => away team.
    """
    df = df.copy()
    df['pitching_team'] = np.where(
        df['inning_topbot'].astype(str).str.lower().str.startswith('top'),
        df['home_team'], df['away_team']
    )

    # First-pitch pitcher per (game_pk, pitching_team) is the starter
    first = (df.sort_values('at_bat_number')
               .groupby(['game_pk', 'pitching_team'])['pitcher']
               .first()
               .reset_index()
               .rename(columns={'pitcher': 'starter_pitcher'}))
    df = df.merge(first, on=['game_pk', 'pitching_team'], how='left')
    df['role'] = np.where(df['pitcher'] == df['starter_pitcher'],
                          'starter', 'reliever')
    df = df.drop(columns=['starter_pitcher'])
    return df


def aggregate_team_role(df: pd.DataFrame) -> pd.DataFrame:
    """Mean xRV columns by (team, role)."""
    agg = (df.groupby(['pitching_team', 'role'])
             .agg(n=('xRV_final', 'count'),
                  xRV=('xRV_final', 'mean'),
                  stuff=('xRV_stuff', 'mean'),
                  loc=('xRV_location', 'mean'),
                  tun=('xRV_tunnel', 'mean'))
             .reset_index())
    # Scale to per-100 pitches for readability (matches build_pitch_plus.py)
    for c in ['xRV', 'stuff', 'loc', 'tun']:
        agg[c] = agg[c] * 100
    return agg


def to_plus(values: pd.Series) -> pd.Series:
    """Convert xRV → "+" scale where 100=mean and +/-10 = 1 std.
    Lower xRV is better for a pitcher, so we invert (subtract z)."""
    mean = values.mean()
    std = values.std()
    if std == 0 or pd.isna(std):
        return pd.Series([100.0] * len(values), index=values.index)
    z = (values - mean) / std
    return (100 - z * 10).round(1)


def build(parquet_path: Path, year: int, out_path: Path):
    print(f'Loading {parquet_path} ...')
    df = pd.read_parquet(parquet_path)
    print(f'  {len(df):,} pitches')

    print('Loading models ...')
    stuff, stuff_features, tunnel, location_models = load_models(MODELS_DIR)
    weights = load_weights(CONFIG_PATH)

    print('Scoring pitches ...')
    df = score_dataframe(df, stuff, stuff_features, tunnel, location_models, weights)

    print('Classifying roles ...')
    df = classify_roles(df)
    n_starter = (df['role'] == 'starter').sum()
    n_reliever = (df['role'] == 'reliever').sum()
    print(f'  starter pitches: {n_starter:,}   reliever pitches: {n_reliever:,}')

    print('Aggregating to team × role ...')
    agg = aggregate_team_role(df)
    # Drop tiny samples
    agg = agg[agg['n'] >= 50].reset_index(drop=True)

    # Convert each metric to + scale, computed across the full team-role
    # population so a 110 means "10% better than the average team-role group".
    agg['stuff_plus'] = to_plus(agg['stuff'])
    agg['loc_plus']   = to_plus(agg['loc'])
    agg['tun_plus']   = to_plus(agg['tun'])
    agg['pitch_plus'] = to_plus(agg['xRV'])

    teams = {}
    for _, row in agg.iterrows():
        tm = row['pitching_team']
        if tm not in teams:
            teams[tm] = {}
        teams[tm][row['role']] = {
            'stuff':    float(row['stuff_plus']),
            'location': float(row['loc_plus']),
            'tunnel':   float(row['tun_plus']),
            'pitch':    float(row['pitch_plus']),
            'n':        int(row['n']),
        }

    out = {'season': year, 'teams': teams}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, 'w') as f:
        json.dump(out, f, indent=2)
    print(f'Wrote {out_path}  ({len(teams)} teams)')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--year', type=int, required=True)
    p.add_argument('--parquet', type=Path, default=None,
                   help='Cached Statcast parquet. If omitted, fetches via pybaseball.')
    p.add_argument('--out', type=Path, default=None,
                   help='Output JSON (default: public/team_plus_<year>.json)')
    args = p.parse_args()

    parquet = args.parquet
    if parquet is None:
        parquet = REPO / f'pitch_xrv_{args.year}.parquet'
        if not parquet.exists():
            fetch_statcast(args.year, parquet)
        else:
            print(f'Reusing cached {parquet}')

    out = args.out or (REPO / 'public' / f'team_plus_{args.year}.json')
    build(parquet, args.year, out)


if __name__ == '__main__':
    main()
