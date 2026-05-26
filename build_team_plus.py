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
from pathlib import Path

import numpy as np
import pandas as pd

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


def pitcher_plus_table(df: pd.DataFrame, min_pitches: int = 50) -> pd.DataFrame:
    """Compute each individual pitcher's overall Stuff+/Loc+/Tun+/Pitch+ on
    the same convention used in the summary tables and build_pitch_plus.py:

        +value = 100 - 10 * (mean_xRV - μ) / σ

    where μ/σ are computed across all qualified individual pitchers. Lower
    xRV is better, so we subtract z.

    Splits a pitcher into (team, role) sub-rows when they pitched for
    multiple teams or in both starter and reliever roles, so traded /
    opener pitchers contribute proportionally to each bucket.
    """
    sub = (df.groupby(['pitcher', 'pitching_team', 'role'])
             .agg(n=('xRV_final', 'count'),
                  xRV=('xRV_final', 'mean'),
                  stuff=('xRV_stuff', 'mean'),
                  loc=('xRV_location', 'mean'),
                  tun=('xRV_tunnel', 'mean'))
             .reset_index())
    sub = sub[sub['n'] >= min_pitches].reset_index(drop=True)
    for c in ['xRV', 'stuff', 'loc', 'tun']:
        sub[c] = sub[c] * 100  # per-100 pitches, matches build_pitch_plus.py

    # Population (mean, std) across these per-pitcher rows
    pop = {c: (float(sub[c].mean()), float(sub[c].std()))
           for c in ['xRV', 'stuff', 'loc', 'tun']}

    def to_plus(col, mu, sd):
        if sd == 0 or pd.isna(sd):
            return 100.0
        return (100 - 10 * (sub[col] - mu) / sd).round(2)

    sub['stuff_plus'] = to_plus('stuff', *pop['stuff'])
    sub['loc_plus']   = to_plus('loc',   *pop['loc'])
    sub['tun_plus']   = to_plus('tun',   *pop['tun'])
    sub['pitch_plus'] = to_plus('xRV',   *pop['xRV'])
    return sub, pop


def aggregate_team_role(pitchers: pd.DataFrame) -> pd.DataFrame:
    """Simple mean of per-pitcher "+" values within each (team, role).
    Aggregating player-level plus matches what the summaries display."""
    agg = (pitchers.groupby(['pitching_team', 'role'])
                   .agg(n_pitchers=('pitcher', 'nunique'),
                        n=('n', 'sum'),
                        stuff_plus=('stuff_plus', 'mean'),
                        loc_plus=('loc_plus', 'mean'),
                        tun_plus=('tun_plus', 'mean'),
                        pitch_plus=('pitch_plus', 'mean'))
                   .reset_index())
    for c in ['stuff_plus', 'loc_plus', 'tun_plus', 'pitch_plus']:
        agg[c] = agg[c].round(1)
    return agg


def build_pitcher_baselines(df: pd.DataFrame) -> dict:
    """Compute per-pitcher fastball baselines (FF, falling back to SI/FC).
    Mirrors the fields score_pitches.engineer_stuff_features expects.
    """
    df = df.copy()
    # Trajectory math for tunnel & plate positions (mirrors engineer_tunnel_features)
    PLATE_Y = 17.0 / 12.0
    y_tun = PLATE_Y + 23.0
    y0 = 50.0
    a_ = 0.5 * df['ay'].values
    b_ = df['vy0'].values
    c_ = y0 - y_tun
    with np.errstate(invalid='ignore', divide='ignore'):
        disc = b_**2 - 4 * a_ * c_
        t_tun = np.where(disc >= 0,
                         (-b_ - np.sqrt(np.maximum(disc, 0))) / (2 * a_),
                         np.nan)
        t_tun = np.where((t_tun > 0) & (t_tun < 0.5), t_tun, np.nan)
    df['tunnel_x'] = (df['release_pos_x'].values + df['vx0'].values * t_tun
                      + 0.5 * df['ax'].values * t_tun**2)
    df['tunnel_z'] = (df['release_pos_z'].values + df['vz0'].values * t_tun
                      + 0.5 * df['az'].values * t_tun**2)

    # VAA at plate
    with np.errstate(invalid='ignore', divide='ignore'):
        tp = np.clip(50.0 / (-df['vy0'].values), 0.35, 0.55)
    df['vaa'] = np.degrees(np.arctan2(df['vz0'].values + df['az'].values * tp,
                                       -(df['vy0'].values + df['ay'].values * tp)))

    out = {}
    for pid, sub in df.groupby('pitcher'):
        fb = None
        for pt_pref in ('FF', 'SI', 'FC'):
            cand = sub[sub['pitch_type'] == pt_pref]
            if len(cand) >= 20:
                fb = cand
                break
        if fb is None:
            continue
        rec = {
            'fb_velo':      float(fb['release_speed'].mean()),
            'fb_pfx_x':     float(fb['pfx_x'].mean()),
            'fb_pfx_z':     float(fb['pfx_z'].mean()),
            'fb_spin':      float(fb['release_spin_rate'].mean()) if 'release_spin_rate' in fb else 0.0,
            'fb_extension': float(fb['release_extension'].mean()) if 'release_extension' in fb else 0.0,
            'fb_vaa':       float(fb['vaa'].mean()),
            'fb_release_x': float(fb['release_pos_x'].mean()),
            'fb_release_z': float(fb['release_pos_z'].mean()),
            'fb_tunnel_x':  float(fb['tunnel_x'].mean()),
            'fb_tunnel_z':  float(fb['tunnel_z'].mean()),
            'fb_plate_x':   float(fb['plate_x'].mean()),
            'fb_plate_z':   float(fb['plate_z'].mean()),
        }
        # Replace any NaN with 0.0 so json.dump succeeds
        rec = {k: (0.0 if (v != v) else v) for k, v in rec.items()}
        out[str(int(pid))] = rec
    return out


def ensure_baselines(parquet_path: Path):
    """Create models/pitcher_baselines.json from the parquet if missing."""
    target = MODELS_DIR / 'pitcher_baselines.json'
    if target.exists():
        return
    print(f'Building {target.name} from parquet (not present in models/) ...')
    df = pd.read_parquet(parquet_path)
    baselines = build_pitcher_baselines(df)
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, 'w') as f:
        json.dump(baselines, f)
    print(f'  wrote baselines for {len(baselines)} pitchers')


def build(parquet_path: Path, year: int, out_path: Path):
    ensure_baselines(parquet_path)

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

    print('Computing per-pitcher Stuff+/Loc+/Tun+/Pitch+ ...')
    pitchers, pop = pitcher_plus_table(df, min_pitches=50)
    for c, (m, s) in pop.items():
        print(f'  {c} per-pitcher: mean={m:+.3f}  std={s:.3f}')
    print(f'  {len(pitchers)} qualifying (pitcher, team, role) rows')

    print('Aggregating player-level "+" to team × role ...')
    agg = aggregate_team_role(pitchers)

    teams = {}
    for _, row in agg.iterrows():
        tm = row['pitching_team']
        if tm not in teams:
            teams[tm] = {}
        teams[tm][row['role']] = {
            'stuff':      float(row['stuff_plus']),
            'location':   float(row['loc_plus']),
            'tunnel':     float(row['tun_plus']),
            'pitch':      float(row['pitch_plus']),
            'n_pitchers': int(row['n_pitchers']),
            'n':          int(row['n']),
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
