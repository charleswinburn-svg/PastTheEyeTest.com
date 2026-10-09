#!/usr/bin/env python3
"""
iswing_verify.py — check the site's iSwing+ against the v9.1 notebook.

Re-derives every season with the notebook's own code (notebooks/iSwing_Plus_v9_1.ipynb
section 3 features + section 5 per-year scoring, copied verbatim below — deliberately
NOT the pipeline's enrich()), scores it with the same model, and compares hitter by
hitter, by MLBAM id, with what iswing_update.py published in
public/iswing_waterfall_{year}.json. Optionally also compares with the notebook's own
exported leaderboard (iSwing_leaderboard.csv, year columns).

Reads the same swings the daily run does: competitive_swings_2023_2026.csv plus any
competitive_swings_{year}.csv backfill files. Read-only; writes nothing.

    python3 iswing_verify.py
    python3 iswing_verify.py --leaderboard iSwing_leaderboard.csv

Exit code 0 = every hitter matches exactly, 1 = a mismatch (listed).
"""
import argparse, json, os, sys, warnings
warnings.filterwarnings('ignore')

import joblib
import numpy as np
import pandas as pd

import iswing_update as iu   # paths + the season sources only

# What notebooks/iSwing_Plus_v9_1.ipynb printed for its swing set (section 3):
# rows per season, contact swings with xwOBAcon, and each feature's non-null count
# and mean (4 dp). Identical numbers mean the site is scoring the same swings.
NOTEBOOK_FINGERPRINT = {
    'rows': {2023: 130706, 2024: 286844, 2025: 299168, 2026: 292513},
    'xwOBAcon_n': 382065,
    'features': {
        'bat_speed': (1009231, 71.7061), 'swing_length': (1009231, 7.3113),
        'speed_over_expected': (1009231, 0.0000), 'speed_vs_location': (1009156, 88.7327),
        'aa_vs_optimal': (1009156, -11.1523), 'aa_adjustment': (1009156, -9.7402),
        'tilt_for_height': (1009155, -5.3090), 'direction_from_optimal': (1009156, -16.6494),
        'length_for_location': (1009156, -0.0050), 'effort_level': (1009231, 0.9386),
    },
    'hitters': {2023: 515, 2024: 597, 2025: 612, 2026: 618},
}


def fingerprint(df, ref):
    """Compare this swing set with the notebook's printed one. True if identical."""
    fp, ok = NOTEBOOK_FINGERPRINT, True
    print('\nSwing set vs the notebook (section 3 printout):')
    rows = df['year'].value_counts().sort_index()
    for yr, want in fp['rows'].items():
        got = int(rows.get(yr, 0))
        same = got == want
        ok &= same
        print(f"  {yr} swings        {got:>11,}  notebook {want:>11,}  {'ok' if same else 'DIFFERENT'}")
    contact = df['launch_speed'].notna() & df['launch_angle'].notna() & df['estimated_woba_using_speedangle'].notna()
    same = int(contact.sum()) == fp['xwOBAcon_n']
    ok &= same
    print(f"  xwOBAcon swings     {int(contact.sum()):>11,}  notebook {fp['xwOBAcon_n']:>11,}  {'ok' if same else 'DIFFERENT'}")
    for f, (n, mean) in fp['features'].items():
        got_n, got_m = int(df[f].notna().sum()), round(float(df[f].mean()), 4)
        same = got_n == n and abs(got_m - mean) < 5e-5
        ok &= same
        print(f"  {f:22s} n={got_n:>9,} mean={got_m:+.4f}  notebook n={n:>9,} mean={mean:+.4f}  {'ok' if same else 'DIFFERENT'}")
    for yr, want in fp['hitters'].items():
        got = len(ref.get(yr, []))
        same = got == want
        ok &= same
        print(f"  {yr} hitters (25+)  {got:>11}  notebook {want:>11}  {'ok' if same else 'DIFFERENT'}")
    return ok


def notebook_features(df):
    """Notebook v9.1 section 3 (feature part), verbatim apart from the prints."""
    CONTACT = ['hit_into_play', 'foul', 'hit_into_play_no_out', 'hit_into_play_score', 'foul_bunt']
    df['made_contact'] = df['description'].isin(CONTACT).astype(int)
    df['year'] = pd.to_datetime(df['game_date']).dt.year
    df['batter'] = df['batter'].astype(int)

    if all(c in df.columns for c in ['plate_x', 'plate_z']):
        df['location_difficulty'] = np.sqrt(df['plate_x']**2 + (df['plate_z'] - 2.5)**2)
    if all(c in df.columns for c in ['sz_top', 'sz_bot']):
        df['sz_height'] = df['sz_top'] - df['sz_bot']
        df['pitch_height_norm'] = (df['plate_z'] - df['sz_bot']) / df['sz_height'].replace(0, np.nan)
    else:
        df['sz_height'] = 1.85
        df['pitch_height_norm'] = (df['plate_z'] - 1.5) / 1.85

    if all(c in df.columns for c in ['bat_speed', 'plate_x']):
        bins = np.linspace(-2.0, 2.0, 21)
        df['plate_x_bin'] = pd.cut(df['plate_x'].clip(-1.999, 1.999), bins=bins, labels=False)
        df['speed_over_expected'] = (df['bat_speed'] - df.groupby(['year', 'plate_x_bin'])['bat_speed'].transform('mean')).fillna(0)
        df.drop(columns=['plate_x_bin'], inplace=True)
    if all(c in df.columns for c in ['bat_speed', 'location_difficulty']):
        df['speed_vs_location'] = df['bat_speed'] * (1 + 0.3 * df['location_difficulty'])

    if all(c in df.columns for c in ['attack_angle', 'plate_z']):
        pz = df['plate_z'].clip(1.0, 4.0)
        df['optimal_aa'] = (3 * (pz - 1.0)**2 + 7).clip(5, 30)
        df['aa_vs_optimal'] = -np.abs(df['attack_angle'] - df['optimal_aa'])
        df.drop(columns=['optimal_aa'], inplace=True)
    if all(c in df.columns for c in ['attack_angle', 'pitch_height_norm']):
        phn = df['pitch_height_norm'].clip(0, 1.5)
        opt_aa_n = (3 * (phn * 1.85)**2 + 7).clip(5, 30)
        df['aa_adjustment'] = -np.abs(df['attack_angle'] - opt_aa_n)
    if all(c in df.columns for c in ['swing_path_tilt', 'plate_z']):
        pz = df['plate_z'].clip(1.0, 4.0)
        opt_tilt = (58 - 10 * pz).clip(20, 48)
        df['tilt_for_height'] = -np.abs(df['swing_path_tilt'] - opt_tilt)
    if all(c in df.columns for c in ['attack_direction', 'plate_x', 'stand']):
        batter_px = np.where(df['stand'] == 'R', -df['plate_x'], df['plate_x'])
        batter_ad = np.where(df['stand'] == 'R', -df['attack_direction'], df['attack_direction'])
        optimal_dir = (20 * batter_px).clip(-18, 18)
        df['direction_from_optimal'] = -np.abs(batter_ad - optimal_dir)
    if all(c in df.columns for c in ['swing_length', 'plate_x']):
        expected_len = 7.3 + 0.3 * df['plate_x']
        df['length_for_location'] = -(df['swing_length'] - expected_len)
    if 'bat_speed' in df.columns:
        df['p90_speed'] = df.groupby(['batter', 'year'])['bat_speed'].transform('quantile', 0.90)
        df['effort_level'] = df['bat_speed'] / df['p90_speed'].replace(0, np.nan)
    return df


def notebook_year_scores(df, model, scaler, config):
    """Notebook v9.1 section 5: predict, then per-year iSwing+ (min 25 swings)."""
    available, fill_medians = config['features'], config['feature_medians']
    all_df = df.dropna(subset=['bat_speed']).copy()
    X = all_df[available].fillna(fill_medians)
    all_df['pred_wOBAcon'] = model.predict(pd.DataFrame(scaler.transform(X), columns=available, index=X.index))
    all_df['raw_value'] = all_df['pred_wOBAcon'].clip(lower=0.001)
    out = {}
    for yr in sorted(all_df['year'].dropna().astype(int).unique()):
        ya = all_df[all_df['year'] == yr].groupby('batter')['raw_value'].agg(['mean', 'count']).reset_index()
        ya = ya[ya['count'] >= 25]
        if len(ya) > 0:
            ya['lr'] = np.log(ya['mean'].clip(lower=1e-10))
            ya['score'] = (100 + 15 * (ya['lr'] - ya['lr'].mean()) / ya['lr'].std()).round(0).astype(int)
            out[int(yr)] = ya.set_index('batter')
    return out


def load_swings():
    """Every season the daily run scores: the daily CSV plus the backfill files."""
    frames, seen = [], set()
    if os.path.exists(iu.SWINGS_CSV):
        main = pd.read_csv(iu.SWINGS_CSV, low_memory=False)
        frames.append(main)
        seen = set(pd.to_datetime(main['game_date'], errors='coerce').dt.year.dropna().astype(int))
    for yr, path in sorted(iu._cached_seasons(seen).items()):
        frames.append(pd.read_csv(path, low_memory=False))
    df = pd.concat(frames, ignore_index=True)
    # The pipeline's score_season drops rows without a bat speed / batter id first.
    df['bat_speed'] = pd.to_numeric(df['bat_speed'], errors='coerce')
    df['batter'] = pd.to_numeric(df['batter'], errors='coerce')
    return df.dropna(subset=['bat_speed', 'batter']).reset_index(drop=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--leaderboard', help="the notebook's iSwing_leaderboard.csv (optional)")
    args = ap.parse_args()

    model = joblib.load(iu.MODEL_FILE)
    scaler = joblib.load(iu.SCALER_FILE)
    with open(iu.CONFIG_FILE) as f:
        config = json.load(f)
    print(f"Model {config.get('version', '?')}: {len(config['features'])} features")

    df = notebook_features(load_swings())
    for c in ['launch_speed', 'launch_angle', 'estimated_woba_using_speedangle']:
        df[c] = pd.to_numeric(df[c], errors='coerce')
    ref = notebook_year_scores(df, model, scaler, config)
    swings = df['year'].value_counts().sort_index()
    same_swings = fingerprint(df, ref)

    lb = None
    if args.leaderboard and not os.path.exists(args.leaderboard):
        print(f'{args.leaderboard} not found — skipping the comparison with the notebook export.')
    elif args.leaderboard:
        lb = pd.read_csv(args.leaderboard)
        lb['batter'] = lb['batter'].astype(int)
        lb = lb.set_index('batter')

    bad, lb_bad = 0, 0
    print(f"\n{'season':>6} {'swings':>9} {'hitters':>8} {'site':>6} {'match':>6}  {'notebook csv':>12}")
    for yr, r in ref.items():
        path = os.path.join(iu.ROOT, 'public', f'iswing_waterfall_{yr}.json')
        site = {}
        if os.path.exists(path):
            with open(path) as f:
                site = {int(k): v for k, v in json.load(f).items() if k != 'meta'}
        miss = []
        for bid, row in r.iterrows():
            s = site.get(int(bid))
            if s is None or s['iswing'] != int(row['score']) or s['n'] != int(row['count']):
                miss.append((int(bid), int(row['score']), int(row['count']),
                             None if s is None else s['iswing'], None if s is None else s['n']))
        extra = sorted(set(site) - set(int(b) for b in r.index))
        ok = len(r) - len(miss)
        lb_txt = ''
        if lb is not None and str(yr) in lb.columns:
            col = lb[str(yr)].dropna().astype(int)
            both = col.index.intersection(r.index)
            diff = [(b, int(col[b]), int(r.loc[b, 'score'])) for b in both if int(col[b]) != int(r.loc[b, 'score'])]
            lb_txt = f'{len(both) - len(diff)}/{len(col)} equal'
            if diff or len(both) != len(col):
                lb_bad += 1
                lb_txt += f'  ({len(diff)} differ, {len(col) - len(both)} not in this data)'
                for b, nb_v, v in diff[:5]:
                    print(f'      notebook csv {yr} batter {b}: notebook {nb_v}, recomputed {v}')
        print(f'{yr:>6} {int(swings.get(yr, 0)):>9,} {len(r):>8} {len(site):>6} {ok:>6}  {lb_txt:>12}')
        if miss or extra:
            bad += 1
            for m in miss[:10]:
                print(f'      batter {m[0]}: notebook {m[1]} ({m[2]} swings)  site {m[3]} ({m[4]} swings)')
            if extra:
                print(f'      site has {len(extra)} hitters the notebook logic does not: {extra[:10]}')

    if bad:
        print('\nMISMATCH between the site and the notebook logic — see above.')
    elif not same_swings or lb_bad:
        print('\nThe site matches the notebook logic exactly on these swings. Any season whose swings '
              "differ from the notebook's (swing-set table) can differ from the notebook's export by "
              'a point here and there; the seasons whose swings are identical match it exactly.')
    else:
        print('\nAll seasons match the notebook exactly (same swings, same numbers).')
    sys.exit(1 if bad or lb_bad or not same_swings else 0)


if __name__ == '__main__':
    main()
