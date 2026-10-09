#!/usr/bin/env python3
"""
iSwing+ daily update script (model v9.1).

Uses the pre-trained v9.1 model from notebooks/iSwing_Plus_v9_1.ipynb (one
XGBRegressor predicting xwOBAcon from 10 swing-mechanics, adjustability and
effort features) to incrementally fetch yesterday's Statcast data, re-score every
season in the swings CSV, and update:
    public/iswing.json                  per-year iSwing+ / percentile, keyed by name
    public/iswing_waterfall_{year}.json per-hitter feature decomposition (Summaries)
    public/iswing_games_{year}.json     per-hitter, per-date swing counts + raw sums, so the
                                        site computes exact iSwing+ over any window (rolling
                                        50 PA, by month, date range)
    public/iswing_meta.json             which seasons are scored by the current model
    public/iswing_dist_{year}.json, iswing_swings_{year}.json, intercept_{year}.json
                                        hitter-card files (current season only)

No leakage across seasons (v9.1): as in the notebook, a season's features use only
that season's swings — the speed-over-expected norms (fixed plate_x bins) are per
season and the 90th-percentile bat speed behind effort_level is per batter-season.
Each season is scored on its own (the daily CSV plus the competitive_swings_{year}.csv
backfill files), and every season is re-scored each run.

Run from the project root:
    python3 iswing_update.py

Add past seasons (one-time). Fetches each season from Savant into
competitive_swings_{year}.csv unless --csv points at a swings CSV that already
holds them (e.g. the notebook's competitive_swings_2023_2026.csv), then re-scores:
    python3 iswing_update.py --backfill 2023 2024 2025 [--csv PATH]

Cron (daily at 8 AM):
    0 8 * * * cd /path/to/PastTheEyeTest.com && python3 iswing_update.py >> logs/iswing_update.log 2>&1
"""

import os, sys, json, time, warnings, re, unicodedata, argparse, glob
warnings.filterwarnings('ignore')

import pandas as pd
import numpy as np
from datetime import date, datetime, timedelta


# Name normalization — MUST match the frontend's nameKey() (SharedComponents.jsx)
# so build_json writes/overwrites the exact keys fuzzyLookup resolves to. Recent
# pybaseball returns lowercase names; without this, fresh lowercase keys ("pete
# alonso") never overwrite legacy capitalized ones ("Pete Alonso"), freezing the
# card headline. _name_key collapses case/accents/punctuation/suffixes to one key.
_SUFFIX_RE = re.compile(r'\b(jr|sr|ii|iii|iv)\b')

def _name_key(s):
    s = unicodedata.normalize('NFD', str(s))
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')  # strip accents
    s = s.lower()
    s = re.sub(r'[.\-,]', '', s)
    s = _SUFFIX_RE.sub('', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s

# ── Paths ──
ROOT        = os.path.dirname(os.path.abspath(__file__))
SWINGS_CSV  = os.path.join(ROOT, 'competitive_swings_2023_2026.csv')
PUBLIC_JSON = os.path.join(ROOT, 'public', 'iswing.json')
META_JSON   = os.path.join(ROOT, 'public', 'iswing_meta.json')
MODEL_FILE  = os.path.join(ROOT, 'iswing_model.pkl')
SCALER_FILE = os.path.join(ROOT, 'iswing_scaler.pkl')
CONFIG_FILE = os.path.join(ROOT, 'iswing_config.json')
MODEL_VERSION = 'v9.1'

# Backfill fetch windows — same ranges the v9 notebook trained on (bat tracking
# starts mid-2023). Other seasons fall back to a full regular-season window.
BACKFILL_WINDOWS = {
    2023: ('2023-07-01', '2023-10-01'),
    2024: ('2024-03-28', '2024-10-01'),
    2025: ('2025-03-27', '2025-10-01'),
}

SWING_DESCRIPTIONS = [
    'hit_into_play', 'swinging_strike', 'swinging_strike_blocked',
    'foul', 'foul_tip', 'foul_bunt', 'missed_bunt', 'bunt_foul_tip',
    'hit_into_play_no_out', 'hit_into_play_score',
]
CORE_COLS = [
    'game_date', 'batter', 'pitcher', 'player_name', 'stand', 'p_throws',
    'pitch_type', 'release_speed', 'release_spin_rate', 'pfx_x', 'pfx_z',
    'plate_x', 'plate_z', 'balls', 'strikes', 'description', 'events',
    'launch_speed', 'launch_angle', 'estimated_woba_using_speedangle',
    'bat_speed', 'swing_length', 'attack_angle', 'attack_direction', 'swing_path_tilt',
    # Bat-tracking intercept point (contact location vs batter) — for the hitter-card
    # intercept heatmap. Exact Savant names confirmed on the droplet; fetch_new_swings
    # also broad-captures any column containing "intercept"/"contact" so a name drift
    # never silently drops them.
    'intercept_ball_minus_batter_pos_x_inches', 'intercept_ball_minus_batter_pos_y_inches',
    'sz_top', 'sz_bot',
]


def log(msg):
    print(f'[{datetime.now().strftime("%Y-%m-%d %H:%M:%S")}] {msg}', flush=True)


def check_models():
    missing = [p for p in [MODEL_FILE, SCALER_FILE, CONFIG_FILE] if not os.path.exists(p)]
    if missing:
        log(f'ERROR: Missing model files: {missing}')
        log('Run notebooks/iSwing_Plus_v9_1.ipynb (sections 1-5) first to train and save the model.')
        sys.exit(1)


def load_models():
    import joblib
    model  = joblib.load(MODEL_FILE)
    scaler = joblib.load(SCALER_FILE)
    with open(CONFIG_FILE) as f:
        config = json.load(f)
    return model, scaler, config


def fetch_new_swings(start_date: str, end_date: str) -> pd.DataFrame:
    """Fetch Statcast data for a date range (direct from Baseball Savant) and
    filter to competitive swings.

    Uses savant_fetch instead of pybaseball.statcast(): pybaseball hits the same
    endpoint without browser headers and was returning empty on the droplet,
    freezing the iSwing CSV. The Savant detail CSV carries the same columns,
    including the bat-tracking ones (bat_speed, attack_angle, ...)."""
    try:
        from savant_fetch import fetch_savant_range
    except ImportError as e:
        log(f'ERROR: cannot import savant_fetch ({e}). It must sit next to this script.')
        sys.exit(1)

    season = int(str(start_date)[:4])
    log(f'  Fetching Statcast {start_date} -> {end_date} (Savant)...')
    try:
        raw = fetch_savant_range(season, start_date, end_date, player_type='batter')
    except Exception as e:
        log(f'  Statcast fetch error: {e}')
        return pd.DataFrame()

    if raw is None or len(raw) == 0:
        log('  No data returned')
        return pd.DataFrame()

    log(f'  Raw rows: {len(raw):,}')
    swings = raw[raw['description'].isin(SWING_DESCRIPTIONS)].copy()

    if 'bat_speed' in swings.columns:
        swings['bat_speed'] = pd.to_numeric(swings['bat_speed'], errors='coerce')
        if 'launch_speed' in swings.columns:
            swings['launch_speed'] = pd.to_numeric(swings['launch_speed'], errors='coerce')
        swings = swings.dropna(subset=['bat_speed']).copy()
        if len(swings) == 0:
            return pd.DataFrame()
        thresholds = swings.groupby('batter')['bat_speed'].quantile(0.10).rename('p10')
        swings = swings.merge(thresholds, on='batter', how='left')
        mask = (swings['bat_speed'] >= swings['p10']) | (
            (swings['bat_speed'] >= 60) & (swings['launch_speed'] >= 90))
        swings = swings[mask].drop(columns=['p10']).copy()

    available = [c for c in CORE_COLS if c in swings.columns]
    # Broad-capture any bat-tracking intercept/contact columns even if their exact
    # Savant name isn't in CORE_COLS, so a name drift never silently drops them.
    extra = [c for c in swings.columns
             if ('intercept' in c.lower() or 'contact' in c.lower()) and c not in available]
    if extra:
        log(f'  Keeping bat-tracking columns: {extra}')
    return swings[available + extra].copy()


CONTACT = ['hit_into_play', 'foul', 'hit_into_play_no_out', 'hit_into_play_score', 'foul_bunt']

# Fixed plate_x bin edges for speed_over_expected (same every season, v9.1).
SOE_BINS = np.linspace(-2.0, 2.0, 21)


def enrich(df: pd.DataFrame) -> pd.DataFrame:
    """Build the v9.1 model features (ports notebook section 3). Every league norm
    and personal ceiling is computed per SEASON (`year`), so a season's features
    only use that season's swings: the speed-over-expected norm is the season's
    mean bat speed in each fixed plate_x bin, and effort_level divides by the
    hitter's own 90th-percentile bat speed that season. Context columns (location,
    height, handedness) only build features — they never enter the model."""
    # A full-season re-fetch (or a raw CSV load) can leave numeric Savant columns as
    # object dtype, which breaks np.sqrt / arithmetic below ("'float' object has no
    # attribute 'sqrt'"). Coerce every column the derived features touch up front.
    NUMERIC_COLS = [
        'batter', 'plate_x', 'plate_z', 'sz_top', 'sz_bot',
        'attack_direction', 'attack_angle', 'swing_path_tilt', 'swing_length',
        'bat_speed', 'release_speed', 'launch_speed', 'launch_angle',
        'estimated_woba_using_speedangle',
    ]
    for c in NUMERIC_COLS:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors='coerce')
    if 'year' not in df.columns:
        df['year'] = pd.to_datetime(df['game_date'], errors='coerce').dt.year

    df['made_contact'] = df['description'].isin(CONTACT).astype(int)

    # ── Context (feature inputs only) ──
    if all(c in df.columns for c in ['plate_x', 'plate_z']):
        df['location_difficulty'] = np.sqrt(df['plate_x']**2 + (df['plate_z'] - 2.5)**2)

    if all(c in df.columns for c in ['sz_top', 'sz_bot']):
        df['sz_height'] = df['sz_top'] - df['sz_bot']
        df['pitch_height_norm'] = (df['plate_z'] - df['sz_bot']) / df['sz_height'].replace(0, np.nan)
    else:
        df['sz_height'] = 1.85
        df['pitch_height_norm'] = (df['plate_z'] - 1.5) / 1.85

    # ── Speed context: bat speed over the season's mean in its fixed plate_x bin ──
    if all(c in df.columns for c in ['bat_speed', 'plate_x']):
        px_bin = pd.cut(df['plate_x'].clip(-1.999, 1.999), bins=SOE_BINS, labels=False)
        exp_speed = df.groupby([df['year'], px_bin])['bat_speed'].transform('mean')
        df['speed_over_expected'] = (df['bat_speed'] - exp_speed).fillna(0)

    if all(c in df.columns for c in ['bat_speed', 'location_difficulty']):
        df['speed_vs_location'] = df['bat_speed'] * (1 + 0.3 * df['location_difficulty'])

    # ── Swing adjustability: distance from empirical optimals ──
    # Attack angle optimal rises with pitch height (low≈10°, mid≈16°, high≈27°).
    if all(c in df.columns for c in ['attack_angle', 'plate_z']):
        pz = df['plate_z'].clip(1.0, 4.0)
        optimal_aa = (3 * (pz - 1.0)**2 + 7).clip(5, 30)
        df['aa_vs_optimal'] = -np.abs(df['attack_angle'] - optimal_aa)

    # Same optimum on the hitter's own zone height.
    if all(c in df.columns for c in ['attack_angle', 'pitch_height_norm']):
        phn = df['pitch_height_norm'].clip(0, 1.5)
        opt_aa_n = (3 * (phn * 1.85)**2 + 7).clip(5, 30)
        df['aa_adjustment'] = -np.abs(df['attack_angle'] - opt_aa_n)

    # Tilt optimal falls with pitch height (low≈47°, mid≈35°, high≈29°).
    if all(c in df.columns for c in ['swing_path_tilt', 'plate_z']):
        pz = df['plate_z'].clip(1.0, 4.0)
        opt_tilt = (58 - 10 * pz).clip(20, 48)
        df['tilt_for_height'] = -np.abs(df['swing_path_tilt'] - opt_tilt)

    # Handedness-aware: pull inside, oppo outside (optimal ≈ 20 × batter-side plate_x).
    if all(c in df.columns for c in ['attack_direction', 'plate_x', 'stand']):
        is_r = df['stand'] == 'R'
        batter_px = np.where(is_r, -df['plate_x'], df['plate_x'])
        batter_ad = np.where(is_r, -df['attack_direction'], df['attack_direction'])
        optimal_dir = np.clip(20 * batter_px, -18, 18)
        df['direction_from_optimal'] = -np.abs(batter_ad - optimal_dir)

    # Shorter swings outside, longer inside.
    if all(c in df.columns for c in ['swing_length', 'plate_x']):
        expected_len = 7.3 + 0.3 * df['plate_x']
        df['length_for_location'] = -(df['swing_length'] - expected_len)

    # ── Effort: bat speed vs the hitter's own 90th percentile that season ──
    if 'bat_speed' in df.columns:
        df['p90_speed'] = df.groupby(['batter', 'year'])['bat_speed'].transform('quantile', 0.90)
        df['effort_level'] = df['bat_speed'] / df['p90_speed'].replace(0, np.nan)

    # ── Target (validation only) ──
    if 'estimated_woba_using_speedangle' in df.columns:
        contact_mask = df['launch_speed'].notna() & df['launch_angle'].notna()
        df['xwOBAcon'] = np.where(contact_mask, df['estimated_woba_using_speedangle'], np.nan)

    return df


def _model_matrix(df: pd.DataFrame, scaler, config) -> pd.DataFrame:
    """Scaled model inputs: config features, gaps filled with training medians."""
    feats = config['features']
    meds  = config['feature_medians']
    X = pd.DataFrame(index=df.index)
    for f in feats:
        if f not in df.columns:
            log(f'  WARNING: feature {f} missing — filling with training median')
            X[f] = meds[f]
        else:
            X[f] = pd.to_numeric(df[f], errors='coerce').replace([np.inf, -np.inf], np.nan).fillna(meds[f])
    return pd.DataFrame(scaler.transform(X[feats]), columns=feats, index=df.index)


def score_swings(df: pd.DataFrame, model, scaler, config) -> pd.DataFrame:
    """Apply the v9 model: raw_value = predicted xwOBAcon per swing (floored)."""
    X_sc = _model_matrix(df, scaler, config)
    df['pred_wOBAcon'] = model.predict(X_sc)
    df['raw_value']    = df['pred_wOBAcon'].clip(lower=0.001)
    return df


def _fallback_names(years):
    """player_id -> name from public/baseball_data_{year}.json (site's own hitter
    list), used when the pybaseball lookup can't resolve an id."""
    out = {}
    for yr in years:
        path = os.path.join(ROOT, 'public', f'baseball_data_{int(yr)}.json')
        if not os.path.exists(path):
            continue
        try:
            with open(path) as f:
                data = json.load(f)
            for h in data.get('hitters', []):
                if h.get('player_id') is not None and h.get('name'):
                    out.setdefault(int(h['player_id']), h['name'])
        except Exception as e:
            log(f'  Could not read {path}: {e}')
    return out


def resolve_batter_names(df: pd.DataFrame) -> pd.DataFrame:
    """Fill batter_name via pybaseball reverse lookup, then the site's own hitter
    list for any id pybaseball couldn't resolve."""
    if 'player_name' in df.columns and 'batter_name' not in df.columns:
        df = df.rename(columns={'player_name': 'pitcher_name'})   # Savant player_name = pitcher
    if 'batter_name' not in df.columns:
        df['batter_name'] = None
    df['batter'] = pd.to_numeric(df['batter'], errors='coerce')
    df = df[df['batter'].notna()].copy()
    df['batter'] = df['batter'].astype(int)

    missing = df.loc[df['batter_name'].isna(), 'batter'].unique()
    if len(missing):
        log(f'  Resolving {len(missing)} batter IDs...')
        try:
            from pybaseball import playerid_reverse_lookup
            lookup = playerid_reverse_lookup(missing, key_type='mlbam')
            if len(lookup) > 0:
                names = lookup['name_last'] + ', ' + lookup['name_first']
                name_map = dict(zip(lookup['key_mlbam'].astype(int), names))
                df['batter_name'] = df['batter_name'].fillna(df['batter'].map(name_map))
        except Exception as e:
            log(f'  Name lookup failed: {e}')

    if df['batter_name'].isna().any():
        years = pd.to_datetime(df['game_date'], errors='coerce').dt.year.dropna().unique()
        fb = _fallback_names(years)
        if fb:
            df['batter_name'] = df['batter_name'].fillna(df['batter'].map(fb))
    log(f'  Resolved {df["batter_name"].notna().sum():,} / {len(df):,} names')
    return df


def score_season(swings: pd.DataFrame, model, scaler, config) -> pd.DataFrame:
    """Enrich + name + score one season's competitive swings. Features come from
    these swings only (per-season norms and ceilings), never other seasons."""
    df = swings.copy()
    df['bat_speed'] = pd.to_numeric(df['bat_speed'], errors='coerce')
    df['batter'] = pd.to_numeric(df['batter'], errors='coerce')
    df = df.dropna(subset=['bat_speed', 'batter']).reset_index(drop=True)
    df['batter'] = df['batter'].astype(int)
    df['year'] = pd.to_datetime(df['game_date'], errors='coerce').dt.year
    df = enrich(df)
    df = resolve_batter_names(df)
    df = score_swings(df, model, scaler, config)
    return df


def _title_name(name):
    """pybaseball "Last, First" (any case) -> "First Last" display. Only capitalizes
    all-lower/all-upper tokens so intentional mixed case (McCutchen, O'Neill) survives."""
    name = str(name)
    if ', ' in name:
        last, first = name.split(', ', 1)
    else:
        parts = name.split()
        first, last = (parts[0], ' '.join(parts[1:])) if len(parts) > 1 else (name, '')
    disp = f'{first} {last}'.strip()
    return ' '.join(w if any(c.isupper() for c in w[1:]) else w.capitalize()
                    for w in disp.split() if w)


def _canon_rank(k):
    """Sort key for choosing the canonical display key among case/format variants:
    prefer a capitalized First-Last (no comma) key — that's what the frontend's
    h.name lookup hits."""
    has_comma = ',' in k
    cap = bool(k) and k[:1].isupper()
    return (cap and not has_comma, cap, not has_comma, len(k))


def _dedupe_by_namekey(existing):
    """Collapse case/format-variant duplicate keys (e.g. the legacy 'Pete Alonso'
    and pybaseball's new lowercase 'pete alonso') into ONE canonical key per player,
    merging all years so history is preserved. Returns (out, canon_map) where
    canon_map maps _name_key(display) -> canonical key."""
    from collections import defaultdict
    groups = defaultdict(list)
    for k in existing:
        groups[_name_key(k)].append(k)
    out, canon_map = {}, {}
    for nk, keys in groups.items():
        canon = max(keys, key=_canon_rank)
        merged = {}
        for k in sorted(keys, key=_canon_rank):   # least→most preferred: canonical wins conflicts
            merged.update(existing[k])
        out[canon] = merged
        canon_map[nk] = canon
    return out, canon_map


def _drop_redundant_lf_keys(out, canon_map):
    """Remove leftover 'Last, First' duplicate keys whose data is already fully
    contained in the canonical 'First Last' entry (so nothing is lost)."""
    for k in [k for k in list(out) if ', ' in k]:
        last, first = k.split(', ', 1)
        canon = canon_map.get(_name_key(f'{first} {last}'))
        if canon and canon != k and canon in out and set(out[k]) <= set(out[canon]):
            del out[k]


def season_scores(scored_df: pd.DataFrame, yr: int) -> pd.DataFrame:
    """Per-hitter iSwing+ for one season, normalized within that season: log of the
    hitter's mean raw_value, z-scored across qualified hitters, on a 100 ± 15 scale.
    Grouped by batter id; returns batter, batter_name, mean, count, score, pct.
    Every hitter counts toward the season's scale whether or not their name
    resolved (the notebook resolves all of them), so a failed name lookup can't
    shift anyone else's number.
    25-swing minimum for every season, as in the v9.1 notebook."""
    mn = 25
    d = scored_df[scored_df['year'] == yr]
    g = d.groupby('batter')
    agg = pd.DataFrame({
        'batter_name': g['batter_name'].first(),
        'mean':  g['raw_value'].mean(),
        'count': g['raw_value'].count(),
    }).reset_index()
    agg = agg[agg['count'] >= mn].copy()
    if len(agg) == 0:
        log(f'  {yr}: no players met min {mn} swings')
        return agg
    agg['log_raw'] = np.log(agg['mean'].clip(lower=1e-10))
    agg['score'] = (100 + 15 * (agg['log_raw'] - agg['log_raw'].mean()) / agg['log_raw'].std()).round(0).astype(int)
    agg['pct']   = agg['score'].rank(pct=True).mul(100).round(0).astype(int)
    log(f'  {yr}: {len(agg)} players (min {mn} swings)  mean={agg["score"].mean():.1f}  sd={agg["score"].std():.1f}')
    return agg


def build_json(scores_by_year: dict, existing_json: dict) -> dict:
    """
    Merge per-year iSwing+ ({year: season_scores() frame}) into existing_json,
    writing each player under a canonical First-Last key (resolved via _name_key,
    matching the frontend's nameKey/fuzzyLookup) so fresh lowercase pybaseball
    names ("pete alonso") overwrite legacy capitalized ones ("Pete Alonso")
    instead of piling up beside them and freezing the card headline.

    Every rebuilt year is cleared from ALL entries first, so a hitter who drops out
    of that year's pool can't keep a value from an older model.
    """
    # Start from existing, collapsing case/format-variant duplicates into one key/player.
    out, canon_map = _dedupe_by_namekey(existing_json)
    for v in out.values():   # v7 'overall' (never displayed) — not reproduced by v9
        v.pop('overall', None)
        v.pop('overall_pct', None)

    for yr, agg in sorted(scores_by_year.items()):
        if agg is None or len(agg) == 0:
            continue   # nothing new for this year — keep what's there
        yr_key, pct_key = str(yr), f'{yr}_pct'
        for v in out.values():
            v.pop(yr_key, None)
            v.pop(pct_key, None)
        # Most swings last, so when two hitters share a name key (e.g. the two Max
        # Muncys) the everyday player's value is the one the name lookup finds.
        for _, row in agg.sort_values('count').iterrows():
            if pd.isna(row['batter_name']):
                continue                                # name-keyed file: needs a name
            # Canonical First-Last display key (what the frontend h.name lookup hits).
            ff_name = _title_name(row['batter_name'])   # "alonso, pete" -> "Pete Alonso"
            nk = _name_key(ff_name)
            canon = canon_map.get(nk)
            if canon is None:                           # brand-new player — register canonical
                canon = ff_name
                canon_map[nk] = canon
            out.setdefault(canon, {})[yr_key] = int(row['score'])
            out[canon][pct_key] = int(row['pct'])

    out = {k: v for k, v in out.items() if v}
    _drop_redundant_lf_keys(out, canon_map)
    return out


def _best_iteration_range(model):
    """Tree range model.predict() uses (the early-stopping best iteration)."""
    try:
        best = model.best_iteration
    except Exception:
        best = None
    return (0, int(best) + 1) if best is not None else (0, 0)


def write_waterfall(scored_df, season, agg, model, scaler, config):
    """public/iswing_waterfall_{season}.json — per hitter, how much each feature
    moved their iSwing+ away from the average qualified hitter (100), in points.

    Uses the model's own per-swing feature contributions (XGBoost's fast
    path-based attribution, which sums to each swing's prediction), so a bar's
    sign reflects what the model actually did with that feature. Per hitter:
    mean contribution per feature minus the average qualified hitter's, converted
    to points with the slope of the iSwing+ transform at the hitter's own mean
    (15 / (sd_log · mean)). The small leftover from the log transform and integer
    rounding is spread in proportion to bar size (never flips a bar's sign), then
    bars are rounded to 0.1 with the remainder folded into the largest, so the
    running total lands exactly on the published iSwing+. Keyed by batter id."""
    if agg is None or len(agg) == 0:
        log(f'  waterfall: no {season} scores — skipping')
        return
    import xgboost as xgb
    feats = config['features']
    d = scored_df[(scored_df['year'] == season) & scored_df['batter'].isin(agg['batter'])]
    X_sc = _model_matrix(d, scaler, config)
    contrib = model.get_booster().predict(
        xgb.DMatrix(X_sc), pred_contribs=True, approx_contribs=True,
        iteration_range=_best_iteration_range(model))[:, :len(feats)]   # last col = bias

    per_hitter = pd.DataFrame(contrib, columns=feats, index=d.index).groupby(d['batter']).mean()
    per_hitter = per_hitter.loc[agg['batter']]
    delta = per_hitter - per_hitter.mean()          # vs the average qualified hitter
    sd_log = float(agg['log_raw'].std())

    out = {'meta': {'season': int(season), 'model': MODEL_VERSION, 'features': feats,
                    'method': 'model contributions vs average qualified hitter'}}
    for _, row in agg.iterrows():
        bid = int(row['batter'])
        target = int(row['score'])
        shift = target - 100
        pts = delta.loc[bid] * (15.0 / (sd_log * float(row['mean'])))
        spread = pts.abs().sum()
        if spread > 1e-9:
            pts = pts + (shift - pts.sum()) * pts.abs() / spread
        else:
            pts = pd.Series(shift / len(feats), index=feats)
        c = {f: round(float(pts[f]), 1) for f in feats}
        resid = round(shift - sum(c.values()), 1)
        if resid:
            big = max(c, key=lambda f: abs(c[f]))
            c[big] = round(c[big] + resid, 1)
        out[str(bid)] = {'name': _title_name(row['batter_name']) if pd.notna(row['batter_name']) else '',
                         'iswing': target,
                         'pct': int(row['pct']), 'n': int(row['count']), 'c': c}
    path = os.path.join(ROOT, 'public', f'iswing_waterfall_{season}.json')
    with open(path, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    log(f'  Wrote {path}: {len(out) - 1} hitters')


def write_iswing_games(scored_df, season, agg):
    """public/iswing_games_{season}.json — per qualified hitter, per game date: the
    number of competitive swings and the sum of their raw_value, plus the season's
    mu/sd of log(mean raw_value) across qualified hitters. With these the site
    computes iSwing+ over any window with the season formula itself,
        100 + 15 * (ln(sum s / sum n) - mu) / sd,
    so a window covering the whole season lands exactly on the published number.
    Keyed by batter id; d = month*100+day."""
    if agg is None or len(agg) == 0:
        log(f'  games: no {season} scores — skipping')
        return
    mu, sd = float(agg['log_raw'].mean()), float(agg['log_raw'].std())
    d = scored_df[(scored_df['year'] == season) & scored_df['batter'].isin(agg['batter'])]
    dt = pd.to_datetime(d['game_date'], errors='coerce')
    g = (d.assign(_mmdd=dt.dt.month * 100 + dt.dt.day).dropna(subset=['_mmdd'])
          .groupby(['batter', '_mmdd'])['raw_value'].agg(['count', 'sum']))
    out = {'meta': {'season': int(season), 'model': MODEL_VERSION, 'mu': round(mu, 6),
                    'sd': round(sd, 6), 'minSwings': 25}}
    for bid, gg in g.groupby(level=0):
        out[str(int(bid))] = {
            'd': [int(m) for m in gg.index.get_level_values(1)],
            'n': [int(n) for n in gg['count']],
            's': [round(float(s), 5) for s in gg['sum']],
        }
    path = os.path.join(ROOT, 'public', f'iswing_games_{season}.json')
    with open(path, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    log(f'  Wrote {path}: {len(out) - 1} hitters')


def write_meta(seasons):
    """public/iswing_meta.json — which seasons are scored by the current model.
    The site shows its NEW label on iSwing+ only for these seasons."""
    seasons = {int(s) for s in seasons}
    if os.path.exists(META_JSON):
        try:
            with open(META_JSON) as f:
                prev = json.load(f)
            if prev.get('model') == MODEL_VERSION:
                seasons |= {int(s) for s in prev.get('seasons', [])}
        except Exception:
            pass
    with open(META_JSON, 'w') as f:
        json.dump({'model': MODEL_VERSION, 'seasons': sorted(seasons)}, f)
    log(f'  Wrote {META_JSON}: model {MODEL_VERSION}, seasons {sorted(seasons)}')


# ── Distribution / heatmap outputs for the hitter card ──────────────────────
KDE_LO, KDE_HI, KDE_N = 40.0, 160.0, 64


def _kde_curve(vals, lo=KDE_LO, hi=KDE_HI):
    """Gaussian KDE density on a fixed [lo,hi] grid (numpy, Silverman bw).
    Returns a length-KDE_N list of rounded densities (area ~1)."""
    s = np.asarray(vals, dtype=float)
    s = s[np.isfinite(s)]
    n = s.size
    if n < 2:
        return None
    std = s.std(ddof=1)
    if not np.isfinite(std) or std <= 0:
        std = 1.0
    h = 1.06 * std * n ** (-1 / 5)
    if h <= 0:
        h = 1.0
    grid = np.linspace(lo, hi, KDE_N)
    d = np.exp(-0.5 * ((grid[:, None] - s[None, :]) / h) ** 2).sum(axis=1)
    d /= (n * h * np.sqrt(2 * np.pi))
    return [round(float(v), 5) for v in d]


ISW_LO, ISW_HI = 40.0, 180.0


def write_iswing_dist(scored_df, season, updated_json=None, min_swings=25):
    """public/iswing_dist_{season}.json — per hitter, a KDE curve of their per-swing
    iSwing+ CENTERED on the hitter's PUBLISHED iSwing+ (the exact number the card's
    headline shows, read from updated_json), so the curve's average matches the card.
    The spread comes from the per-swing league scale; league line stays at 100.
    Keyed by batter id so the card can look it up by player_id."""
    df = scored_df.copy()
    df['year'] = pd.to_datetime(df['game_date'], errors='coerce').dt.year
    df = df[(df['year'] == season) & df['raw_value'].notna() & df['batter'].notna()]
    if len(df) == 0:
        log('  iswing_dist: no swings this season — skipping')
        return
    # Per-swing month*100+day, so the card can filter swings to a date window.
    _dt = pd.to_datetime(df['game_date'], errors='coerce')
    df = df.assign(_mmdd=(_dt.dt.month * 100 + _dt.dt.day))

    # Per-swing SHAPE: z-score each swing's log raw_value against the league
    # per-swing distribution -> a readable spread (~15 sd), on a 100 scale.
    lr = np.log(df['raw_value'].clip(lower=1e-10))
    m_sw, s_sw = float(lr.mean()), float(lr.std())
    if not np.isfinite(s_sw) or s_sw <= 0:
        s_sw = 1.0
    df = df.assign(_shape=100 + 15 * (lr - m_sw) / s_sw)

    # Fallback headline (only used when a hitter isn't in the published JSON): log of
    # the hitter's MEAN raw_value, normalized against qualified hitters' log-means —
    # the same math build_json uses. Preferred source is the published iSwing+ below.
    grp = df.groupby('batter')
    cnt = grp.size()
    log_mean = np.log(grp['raw_value'].mean().clip(lower=1e-10))
    pool = log_mean.loc[cnt[cnt >= min_swings].index]
    mu, sig = float(pool.mean()), float(pool.std())
    if not np.isfinite(sig) or sig <= 0:
        sig = 1.0
    fallback_headline = 100 + 15 * (log_mean - mu) / sig

    # Map each batter id -> the exact published iSwing+ from updated_json, resolving
    # names the SAME way the frontend does: match on _name_key (case/accent-insensitive)
    # and try the "First Last" reorder of the batter_name, so the curve centers on the
    # value the card headline actually shows regardless of key case/order.
    published = {}
    if updated_json:
        yr_key = str(season)
        nk_index = {}
        for k, v in updated_json.items():
            if isinstance(v, dict) and v.get(yr_key) is not None:
                nk_index.setdefault(_name_key(k), v[yr_key])
        names = df.dropna(subset=['batter_name']).groupby('batter')['batter_name'].first()
        for bid, nm in names.items():
            nm = str(nm)
            cand = [_name_key(nm)]
            if ', ' in nm:
                last, first = nm.split(', ', 1)
                cand.append(_name_key(f'{first} {last}'))
            for nk in cand:
                if nk in nk_index:
                    published[bid] = float(nk_index[nk])
                    break

    out = {'meta': {'season': season, 'xLo': ISW_LO, 'xHi': ISW_HI, 'nPts': KDE_N, 'leagueMean': 100}}
    # Per-swing published-scale iSwing+ + date (mmdd), so the card can recompute the
    # bubble (mean) and the distribution (KDE) for any date window client-side.
    swings = {'meta': {'season': season, 'xLo': ISW_LO, 'xHi': ISW_HI, 'leagueMean': 100}}
    for bid, g in df.groupby('batter'):
        if len(g) < min_swings:
            continue
        H = published.get(bid)
        if H is None:
            H = float(fallback_headline.loc[bid])   # not in published JSON — recompute
        vals = g['_shape'].to_numpy()
        vals = vals - vals.mean() + H          # recenter the per-swing shape on the headline
        swings[str(int(bid))] = {
            'v': [int(round(x)) for x in vals],
            'd': [int(m) if np.isfinite(m) else 0 for m in g['_mmdd'].to_numpy()],
        }
        curve = _kde_curve(vals, ISW_LO, ISW_HI)
        if curve is None:
            continue
        out[str(int(bid))] = {'curve': curve, 'mean': round(H, 0), 'n': int(len(g))}
    path = os.path.join(ROOT, 'public', f'iswing_dist_{season}.json')
    with open(path, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    log(f'  Wrote {path}: {len(out) - 1} hitters  ({len(published)} from published JSON)')
    spath = os.path.join(ROOT, 'public', f'iswing_swings_{season}.json')
    with open(spath, 'w') as f:
        json.dump(swings, f, separators=(',', ':'))
    log(f'  Wrote {spath}: {len(swings) - 1} hitters (per-swing iSwing+ + dates for date-range)')


# Intercept-point columns. Prefer "relative to home plate" (a true aerial view w.r.t.
# the plate → the plate sits at the origin) when Savant exposes it; otherwise fall back
# to the batter-relative fields. Exact plate-relative names confirmed via a live dump.
_INT_X_PLATE  = ['intercept_ball_minus_plate_pos_x_inches', 'intercept_ball_minus_homeplate_pos_x_inches', 'intercept_ball_minus_home_plate_pos_x_inches']
_INT_Y_PLATE  = ['intercept_ball_minus_plate_pos_y_inches', 'intercept_ball_minus_homeplate_pos_y_inches', 'intercept_ball_minus_home_plate_pos_y_inches']
_INT_X_BATTER = ['intercept_ball_minus_batter_pos_x_inches', 'intercept_ball_minus_batter_pos_x', 'contact_x']
_INT_Y_BATTER = ['intercept_ball_minus_batter_pos_y_inches', 'intercept_ball_minus_batter_pos_y', 'contact_y']
_INT_X = _INT_X_PLATE + _INT_X_BATTER
_INT_Y = _INT_Y_PLATE + _INT_Y_BATTER

# Balls in play only — the description values Statcast uses for a ball put in play.
_INPLAY = {'hit_into_play', 'hit_into_play_no_out', 'hit_into_play_score'}


def write_intercept(scored_df, season, min_pts=20):
    """public/intercept_{season}.json — per hitter, BALL-IN-PLAY contact points
    [x, y] (inches) for the top-down (aerial) intercept heatmap, SPLIT by batting
    hand (stand): {batterId: {"L": [[x,y],…], "R": [[x,y],…]}}. Switch hitters
    (>= min_pts from both sides) get both; everyone else gets one. meta.frame is
    'plate' when plate-relative columns are used (plate at origin) else 'batter'.
    Skips (with a diagnostic) if Savant's intercept columns aren't present."""
    xcol = next((c for c in _INT_X if c in scored_df.columns), None)
    ycol = next((c for c in _INT_Y if c in scored_df.columns), None)
    if not xcol or not ycol:
        cand = [c for c in scored_df.columns if 'intercept' in c.lower() or 'contact' in c.lower()]
        log(f'  intercept: no known intercept columns found; skipping. Present intercept/contact cols: {cand}')
        return
    frame = 'plate' if xcol in _INT_X_PLATE else 'batter'
    df = scored_df.copy()
    df['year'] = pd.to_datetime(df['game_date'], errors='coerce').dt.year
    df['_x'] = pd.to_numeric(df[xcol], errors='coerce')
    df['_y'] = pd.to_numeric(df[ycol], errors='coerce')
    _dt = pd.to_datetime(df['game_date'], errors='coerce')
    df['_mmdd'] = (_dt.dt.month * 100 + _dt.dt.day)   # per-point date for window filtering
    df['_stand'] = (df['stand'].astype(str).str.upper().str[0]
                    if 'stand' in df.columns else '?')
    df = df[(df['year'] == season) & df['_x'].notna() & df['_y'].notna() & df['batter'].notna()]
    # Balls in play only (drop fouls / swinging strikes / etc.).
    before = len(df)
    if 'description' in df.columns:
        df = df[df['description'].astype(str).isin(_INPLAY)]
    elif 'events' in df.columns:
        df = df[df['events'].notna() & df['events'].astype(str).str.strip().ne('')]
    log(f'  intercept: balls-in-play filter {before} -> {len(df)} rows (frame={frame}, x={xcol})')
    if len(df) == 0:
        log('  intercept: columns present but no valid in-play points this season — skipping')
        return

    # ── Exact home-plate position from Savant's batting-stance leaderboard ──
    # Contact points stay batter-relative (COM at origin). The stance leaderboard gives
    # exact geometry per (player, hand): plate FRONT is avg_batter_y_position in front of
    # the COM (depth), plate CENTER is (avg_batter_x_position + 8.5) to the contact side.
    # We emit plateX (lateral, COM frame), plateFrontDepth (COM frame) and avgIx (average
    # x-intercept, for the dashed line). If the fetch fails we fall back to a per-pitch
    # estimate of plateX (median intercept_x) so the pipeline never breaks.
    try:
        from batting_stance import fetch_batting_stance
        stance = fetch_batting_stance(season)
        log(f'  intercept: fetched batting-stance geometry for {len(stance)} (player,hand) rows')
    except Exception as e:
        stance = {}
        log(f'  intercept: batting-stance fetch failed ({e}); falling back to per-pitch estimate')

    out = {'meta': {'season': season, 'xField': xcol, 'yField': ycol, 'units': 'inches',
                    'splitByStand': True, 'frame': 'batter', 'ballsInPlay': True,
                    'exactPlate': bool(stance)}}
    n_hitters = n_switch = n_exact = 0
    for bid, g in df.groupby('batter'):
        stands = {}
        for st, gs in g.groupby('_stand'):
            gs = gs.dropna(subset=['_x', '_y'])
            if st not in ('L', 'R') or len(gs) < min_pts:
                continue
            med_ix = float(gs['_x'].median())
            side_sign = 1.0 if med_ix >= 0 else -1.0
            entry = {'pts': [[round(float(a), 1), round(float(b), 1), int(m) if pd.notna(m) else 0]
                             for a, b, m in zip(gs['_x'], gs['_y'], gs['_mmdd'])],
                     'avgIy': round(float(gs['_y'].median()), 1)}   # avg y-intercept (depth) → dashed line
            # The leaderboard gives ONE stance row per player (it doesn't split switch
            # hitters), so fall back to the other side's row — a switch hitter's two
            # stances are ~mirror images and side_sign already flips the lateral — so
            # both panels stay on the same exact geometry instead of one estimating.
            s = stance.get((int(bid), st)) or stance.get((int(bid), 'R' if st == 'L' else 'L'))
            if s:
                entry['plateX'] = round(side_sign * (s['avg_batter_x_position'] + 8.5), 1)
                entry['plateFrontDepth'] = round(s['avg_batter_y_position'], 1)
                n_exact += 1
            else:
                entry['plateX'] = round(med_ix, 1)   # fallback: plate ≈ contact median
            stands[st] = entry
        if not stands:
            continue
        out[str(int(bid))] = stands
        n_hitters += 1
        n_switch += (len(stands) > 1)
    path = os.path.join(ROOT, 'public', f'intercept_{season}.json')
    with open(path, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    log(f'  Wrote {path}: {n_hitters} hitters ({n_switch} switch, {n_exact} exact-plate) (x={xcol}, y={ycol})')


def _load_iswing_json():
    if not os.path.exists(PUBLIC_JSON):
        return {}
    with open(PUBLIC_JSON) as f:
        existing = json.load(f)
    log(f'Loaded existing iswing.json ({len(existing)} entries)')
    return existing


def _write_iswing_json(updated_json):
    os.makedirs(os.path.dirname(PUBLIC_JSON), exist_ok=True)
    with open(PUBLIC_JSON, 'w') as f:
        json.dump(updated_json, f)
    log(f'Wrote {len(updated_json)} entries -> {PUBLIC_JSON}')


def _season_cache(yr):
    return os.path.join(ROOT, f'competitive_swings_{yr}.csv')


def _cached_seasons(exclude):
    """{year: path} for the per-season swing files written by --backfill."""
    out = {}
    for path in glob.glob(os.path.join(ROOT, 'competitive_swings_20[0-9][0-9].csv')):
        yr = int(os.path.basename(path)[len('competitive_swings_'):-len('.csv')])
        if yr not in exclude:
            out[yr] = path
    return out


def rescore_all(main_df, model, scaler, config, season):
    """Score every season on hand — the daily CSV plus any per-season backfill
    files — each from its own swings only (v9.1: no cross-season features), then
    write iswing.json, the waterfalls, the per-game files, meta, and the current
    season's hitter-card files."""
    sources = {}
    if len(main_df) > 0:
        yrs = pd.to_datetime(main_df['game_date'], errors='coerce').dt.year
        for yr in sorted(yrs.dropna().astype(int).unique()):
            sources[int(yr)] = main_df[yrs == yr]
    for yr, path in _cached_seasons(set(sources)).items():
        sources[yr] = path                    # read when its turn comes (memory)
    log(f'Seasons on hand: {sorted(sources)}')

    scores, current = {}, None
    for yr, src in sorted(sources.items()):
        swings = pd.read_csv(src, low_memory=False) if isinstance(src, str) else src
        log(f'Scoring {yr} ({len(swings):,} swings)...')
        scored = score_season(swings, model, scaler, config)
        scores[yr] = season_scores(scored, yr)
        write_waterfall(scored, yr, scores[yr], model, scaler, config)
        write_iswing_games(scored, yr, scores[yr])
        if yr == season:
            current = scored

    updated_json = build_json(scores, _load_iswing_json())
    _write_iswing_json(updated_json)
    if current is not None:
        log('Building hitter-card distribution files...')
        write_iswing_dist(current, season, updated_json=updated_json)
        write_intercept(current, season)
    write_meta([yr for yr, agg in scores.items() if len(agg) > 0])
    return updated_json


def run_backfill(years, csv_path, model, scaler, config):
    """Make sure each requested past season has a swings file
    (competitive_swings_{year}.csv: from --csv, the existing file, or a Savant
    fetch), then re-score every season."""
    log(f'=== iSwing+ backfill ({MODEL_VERSION}): {sorted(set(years))} ===')
    src = None
    if csv_path:
        src = pd.read_csv(csv_path, low_memory=False)
        src['_year'] = pd.to_datetime(src['game_date'], errors='coerce').dt.year
        log(f'Loaded {len(src):,} swings from {csv_path}: {src["_year"].value_counts().sort_index().to_dict()}')

    for yr in sorted(set(years)):
        cache = _season_cache(yr)
        if src is not None:
            rows = src[src['_year'] == yr].drop(columns=['_year'])
            if len(rows) == 0:
                log(f'  {yr}: no rows in {csv_path} — skipping')
                continue
            rows.to_csv(cache, index=False)
            log(f'  {yr}: wrote {len(rows):,} swings -> {cache}')
        elif os.path.exists(cache):
            log(f'  {yr}: using {cache}')
        else:
            start, end = BACKFILL_WINDOWS.get(yr, (f'{yr}-03-15', f'{yr}-10-05'))
            swings = fetch_new_swings(start, end)
            if len(swings) == 0:
                log(f'  {yr}: no swings fetched — skipping')
                continue
            swings.to_csv(cache, index=False)
            log(f'  {yr}: cached {len(swings):,} swings -> {cache}')

    main_df = pd.read_csv(SWINGS_CSV, low_memory=False) if os.path.exists(SWINGS_CSV) else pd.DataFrame()
    rescore_all(main_df, model, scaler, config, date.today().year)
    log('Done.')


def main(argv=None):
    ap = argparse.ArgumentParser(description='iSwing+ daily update / backfill')
    ap.add_argument('--backfill', nargs='+', type=int, metavar='YEAR',
                    help='add these past seasons (competitive_swings_{year}.csv), then re-score all seasons')
    ap.add_argument('--csv', help='with --backfill: swings CSV to take those seasons from '
                                  '(default: existing competitive_swings_{year}.csv, else fetch from Savant)')
    args = ap.parse_args(argv)

    check_models()
    log('Loading model...')
    model, scaler, config = load_models()

    if args.backfill:
        run_backfill(args.backfill, args.csv, model, scaler, config)
        return

    log(f'=== iSwing+ daily update ({MODEL_VERSION}) ===')
    season = date.today().year

    # ── Determine fetch range (yesterday, or since last date in CSV) ──
    full = pd.read_csv(SWINGS_CSV, low_memory=False) if os.path.exists(SWINGS_CSV) else pd.DataFrame()
    last_date = date(season, 3, 1) - timedelta(days=1)
    if len(full) > 0:
        dates = pd.to_datetime(full['game_date'], errors='coerce')
        this_season = dates[dates.dt.year == season]
        if len(this_season) > 0:
            last_date = this_season.max().date()
            log(f'Existing data through {last_date} ({len(this_season):,} swings this season)')

    fetch_start = last_date + timedelta(days=1)
    fetch_end   = date.today() - timedelta(days=1)

    # ── Fetch new data ──
    if fetch_start <= fetch_end:
        log(f'Fetching new data: {fetch_start} -> {fetch_end}')
        new_swings = fetch_new_swings(str(fetch_start), str(fetch_end))
        if len(new_swings) > 0:
            log(f'  Got {len(new_swings):,} new competitive swings')
            full = pd.concat([full, new_swings], ignore_index=True).drop_duplicates() if len(full) else new_swings
            full.to_csv(SWINGS_CSV, index=False)
            log(f'  Updated {SWINGS_CSV} ({len(full):,} total rows)')
        else:
            log('  No new swings found (off-day or no data yet)')
    else:
        log(f'Already up to date through {last_date}')

    if len(full) == 0 or not (pd.to_datetime(full['game_date'], errors='coerce').dt.year == season).any():
        log(f'No {season} swings to score — nothing to update')
        return

    updated_json = rescore_all(full, model, scaler, config, season)
    with_season = sum(1 for v in updated_json.values() if str(season) in v)
    log(f'Players with {season} iSwing+: {with_season}')
    log('Done.')


if __name__ == '__main__':
    main()
