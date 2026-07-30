#!/usr/bin/env python3
"""
iSwing+ daily update script.

Uses pre-trained models from the notebook to incrementally fetch yesterday's
2026 Statcast data, re-score all 2026 swings, and update public/iswing.json.

Run from the project root:
    python3 iswing_update.py

Cron (daily at 8 AM):
    0 8 * * * cd /path/to/PastTheEyeTest.com && python3 iswing_update.py >> logs/iswing_update.log 2>&1
"""

import os, sys, json, time, warnings, re, unicodedata
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
ENRICHED    = os.path.join(ROOT, 'competitive_swings_enriched.csv')
PUBLIC_JSON = os.path.join(ROOT, 'public', 'iswing.json')
MODEL_A     = os.path.join(ROOT, 'iswing_model_a.pkl')
MODEL_B     = os.path.join(ROOT, 'iswing_model_b.pkl')
SCALER_A    = os.path.join(ROOT, 'iswing_scaler_a.pkl')
SCALER_B    = os.path.join(ROOT, 'iswing_scaler_b.pkl')
CONFIG_FILE = os.path.join(ROOT, 'iswing_config.json')

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
    missing = [p for p in [MODEL_A, MODEL_B, SCALER_A, SCALER_B, CONFIG_FILE] if not os.path.exists(p)]
    if missing:
        log(f'ERROR: Missing model files: {missing}')
        log('Run the iSwing_Plus_v7.ipynb notebook (cells 1-6) first to train and save models.')
        sys.exit(1)


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


def enrich(df: pd.DataFrame) -> pd.DataFrame:
    """Add derived features needed by the model."""
    # A full-season re-fetch (or a raw CSV load) can leave numeric Savant columns as
    # object dtype, which breaks np.sqrt / arithmetic below ("'float' object has no
    # attribute 'sqrt'"). Coerce every column the derived features touch up front.
    NUMERIC_COLS = [
        'plate_x', 'plate_z', 'sz_top', 'sz_bot', 'pfx_x', 'pfx_z',
        'balls', 'strikes', 'attack_direction', 'attack_angle',
        'bat_speed', 'release_speed', 'launch_speed', 'launch_angle',
        'estimated_woba_using_speedangle',
    ]
    for c in NUMERIC_COLS:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors='coerce')

    if 'attack_angle' in df.columns:
        df['ideal_attack_angle'] = df['attack_angle'].between(5, 20).fillna(False).astype(int)

    CONTACT = ['hit_into_play', 'foul', 'hit_into_play_no_out', 'hit_into_play_score', 'foul_bunt']
    df['made_contact'] = df['description'].isin(CONTACT).astype(int)

    if all(c in df.columns for c in ['plate_x', 'plate_z', 'sz_top', 'sz_bot']):
        df['in_zone'] = ((df['plate_x'].abs() <= 0.83) &
                         (df['plate_z'] >= df['sz_bot']) &
                         (df['plate_z'] <= df['sz_top'])).fillna(False).astype(int)
    elif all(c in df.columns for c in ['plate_x', 'plate_z']):
        df['in_zone'] = ((df['plate_x'].abs() <= 0.83) &
                         (df['plate_z'].between(1.5, 3.5))).fillna(False).astype(int)

    if all(c in df.columns for c in ['plate_x', 'plate_z']):
        df['location_difficulty'] = np.sqrt(df['plate_x']**2 + (df['plate_z'] - 2.5)**2)

    pitch_families = {
        'FF':'fastball','SI':'fastball','FC':'fastball','FA':'fastball',
        'SL':'breaking','CU':'breaking','KC':'breaking','SV':'breaking','CS':'breaking','ST':'breaking',
        'CH':'offspeed','FS':'offspeed','FO':'offspeed','SC':'offspeed','KN':'offspeed','EP':'offspeed',
    }
    if 'pitch_type' in df.columns:
        pf = df['pitch_type'].map(pitch_families).fillna('other')
        df['is_fastball'] = (pf == 'fastball').astype(int)
        df['is_breaking'] = (pf == 'breaking').astype(int)
        df['is_offspeed'] = (pf == 'offspeed').astype(int)

    if all(c in df.columns for c in ['pfx_x', 'pfx_z']):
        df['total_movement'] = np.sqrt(df['pfx_x']**2 + df['pfx_z']**2)

    if all(c in df.columns for c in ['balls', 'strikes']):
        df['count_leverage'] = df['balls'] - df['strikes']

    if all(c in df.columns for c in ['attack_direction', 'plate_x']):
        df['directional_match'] = -df['attack_direction'] * df['plate_x']

    if all(c in df.columns for c in ['bat_speed', 'release_speed']):
        df['speed_differential'] = df['bat_speed'] - (df['release_speed'] * 0.7)

    if all(c in df.columns for c in ['bat_speed', 'plate_x']):
        df['plate_x_bin'] = pd.cut(df['plate_x'], bins=20, labels=False)
        exp_speed = df.groupby('plate_x_bin')['bat_speed'].transform('mean')
        df['speed_over_expected'] = (df['bat_speed'] - exp_speed).fillna(0)
        df.drop(columns=['plate_x_bin'], inplace=True)

    if all(c in df.columns for c in ['bat_speed', 'location_difficulty']):
        df['speed_vs_location'] = df['bat_speed'] * (1 + 0.3 * df['location_difficulty'])

    if all(c in df.columns for c in ['launch_speed', 'bat_speed', 'release_speed']):
        df['theoretical_max_ev'] = 1.23 * df['bat_speed'] + 0.23 * df['release_speed']
        df['squared_up_rate'] = df['launch_speed'] / df['theoretical_max_ev'].replace(0, np.nan)

    if 'estimated_woba_using_speedangle' in df.columns:
        contact_mask = df['launch_speed'].notna() & df['launch_angle'].notna()
        df['xwOBAcon'] = np.where(contact_mask, df['estimated_woba_using_speedangle'], np.nan)

    return df


def score_swings(df: pd.DataFrame, model_a, model_b, scaler_a, scaler_b, config) -> pd.DataFrame:
    """Apply trained models to produce raw_value per swing."""
    feat_a = config['features_a']
    feat_b = config['features_b']
    meds_a = config['feature_medians_a']
    meds_b = config['feature_medians_b']

    avail_a = [f for f in feat_a if f in df.columns]
    avail_b = [f for f in feat_b if f in df.columns]

    Xa = df[avail_a].copy()
    Xb = df[avail_b].copy()
    for c in Xa.columns: Xa[c] = Xa[c].fillna(meds_a.get(c, Xa[c].median()))
    for c in Xb.columns: Xb[c] = Xb[c].fillna(meds_b.get(c, Xb[c].median()))

    Xa_sc = pd.DataFrame(scaler_a.transform(Xa), columns=avail_a, index=df.index)
    Xb_sc = pd.DataFrame(scaler_b.transform(Xb), columns=avail_b, index=df.index)

    q_exp = config.get('quality_exponent', 1.5)
    c_exp = config.get('contact_exponent', 0.3)

    df['pred_quality']  = np.maximum(model_a.predict(Xa_sc), 0.001)
    df['contact_prob']  = np.maximum(model_b.predict_proba(Xb_sc)[:, 1], 0.001)
    df['raw_value']     = df['pred_quality']**q_exp * df['contact_prob']**c_exp
    return df


def resolve_batter_names(df: pd.DataFrame) -> pd.DataFrame:
    """Add batter_name column via pybaseball reverse lookup."""
    if 'batter_name' in df.columns:
        return df

    if 'player_name' in df.columns:
        df = df.rename(columns={'player_name': 'pitcher_name'})

    batter_ids = df['batter'].dropna().unique().astype(int)
    log(f'  Resolving {len(batter_ids)} batter IDs...')
    try:
        from pybaseball import playerid_reverse_lookup
        lookup = playerid_reverse_lookup(batter_ids, key_type='mlbam')
        if len(lookup) > 0:
            lookup['batter_name'] = lookup['name_last'] + ', ' + lookup['name_first']
            name_map = dict(zip(lookup['key_mlbam'].astype(int), lookup['batter_name']))
            df['batter_name'] = df['batter'].astype(int).map(name_map)
            log(f'  Resolved {df["batter_name"].notna().sum():,} / {len(df):,} names')
    except Exception as e:
        log(f'  Name lookup failed: {e}')
        df['batter_name'] = None
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


def build_json(scored_df: pd.DataFrame, existing_json: dict) -> dict:
    """
    Compute per-year iSwing+ (within-year normalized) for all years present in
    scored_df, then merge into existing_json — OVERWRITING each player's entry in
    place under a canonical First-Last key (resolved via _name_key, matching the
    frontend's nameKey/fuzzyLookup). This replaces stale values instead of letting
    fresh lowercase pybaseball names ("pete alonso") pile up beside legacy
    capitalized ones ("Pete Alonso") and freeze the card headline.
    """
    name_col = 'batter_name'
    scored_df = scored_df[scored_df[name_col].notna()].copy()
    scored_df['year'] = pd.to_datetime(scored_df['game_date'], errors='coerce').dt.year

    current_year = date.today().year
    # Start from existing, collapsing case/format-variant duplicates into one key/player.
    out, canon_map = _dedupe_by_namekey(existing_json)

    years = sorted(scored_df['year'].dropna().unique())
    for yr in years:
        yr = int(yr)
        # Lower min swings for current season (early season has fewer games)
        mn = 25 if yr == current_year else 75
        yr_data = scored_df[scored_df['year'] == yr]
        yr_agg = yr_data.groupby(name_col)['raw_value'].agg(['mean', 'count']).reset_index()
        yr_agg = yr_agg[yr_agg['count'] >= mn].copy()
        if len(yr_agg) == 0:
            log(f'  {yr}: no players met min {mn} swings')
            continue

        yr_agg['log_raw'] = np.log(yr_agg['mean'].clip(lower=1e-10))
        yr_log_mean = yr_agg['log_raw'].mean()
        yr_log_std  = yr_agg['log_raw'].std()
        yr_agg['score'] = (100 + 15 * (yr_agg['log_raw'] - yr_log_mean) / yr_log_std).round(0).astype(int)
        yr_agg['pct']   = yr_agg['score'].rank(pct=True).mul(100).round(0).astype(int)
        log(f'  {yr}: {len(yr_agg)} players (min {mn} swings)  mean={yr_agg["score"].mean():.1f}')

        yr_key  = str(yr)
        pct_key = f'{yr}_pct'
        for _, row in yr_agg.iterrows():
            name  = row[name_col]                 # pybaseball, e.g. "alonso, pete" (lowercase)
            score = int(row['score'])
            pct   = int(row['pct'])

            # Canonical First-Last display key (what the frontend h.name lookup hits).
            ff_name = _title_name(name)           # "Pete Alonso"
            nk = _name_key(ff_name)
            canon = canon_map.get(nk)
            if canon is None:                     # brand-new player — register canonical
                canon = ff_name
                canon_map[nk] = canon
            out.setdefault(canon, {})[yr_key]  = score
            out[canon][pct_key] = pct

    _drop_redundant_lf_keys(out, canon_map)
    return out


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


def main():
    log('=== iSwing+ daily update ===')
    check_models()

    # ── Load models ──
    import joblib
    log('Loading models...')
    model_a  = joblib.load(MODEL_A)
    model_b  = joblib.load(MODEL_B)
    scaler_a = joblib.load(SCALER_A)
    scaler_b = joblib.load(SCALER_B)
    with open(CONFIG_FILE) as f:
        config = json.load(f)

    # ── Determine fetch range (yesterday, or since last date in CSV) ──
    yesterday = date.today() - timedelta(days=1)
    season_start = date(date.today().year, 3, 1)

    last_date = season_start - timedelta(days=1)
    if os.path.exists(SWINGS_CSV):
        existing = pd.read_csv(SWINGS_CSV, usecols=['game_date'])
        existing_2026 = existing[pd.to_datetime(existing['game_date']).dt.year == date.today().year]
        if len(existing_2026) > 0:
            last_date = pd.to_datetime(existing_2026['game_date']).max().date()
            log(f'Existing data through {last_date} ({len(existing_2026):,} swings this season)')

    fetch_start = last_date + timedelta(days=1)
    fetch_end   = yesterday

    # ── Load all existing enriched 2026 swings ──
    all_2026 = pd.DataFrame()
    if os.path.exists(SWINGS_CSV):
        full = pd.read_csv(SWINGS_CSV)
        all_2026 = full[pd.to_datetime(full['game_date']).dt.year == date.today().year].copy()
        log(f'Loaded {len(all_2026):,} existing {date.today().year} swings from CSV')

    # ── Fetch new data ──
    if fetch_start <= fetch_end:
        log(f'Fetching new data: {fetch_start} -> {fetch_end}')
        new_swings = fetch_new_swings(str(fetch_start), str(fetch_end))
        if len(new_swings) > 0:
            log(f'  Got {len(new_swings):,} new competitive swings')
            # Append to main CSV
            if os.path.exists(SWINGS_CSV):
                combined = pd.concat([pd.read_csv(SWINGS_CSV), new_swings], ignore_index=True).drop_duplicates()
            else:
                combined = new_swings
            combined.to_csv(SWINGS_CSV, index=False)
            log(f'  Updated {SWINGS_CSV} ({len(combined):,} total rows)')
            # Reload 2026 slice
            all_2026 = combined[pd.to_datetime(combined['game_date']).dt.year == date.today().year].copy()
        else:
            log('  No new swings found (off-day or no data yet)')
    else:
        log(f'Already up to date through {last_date}')

    if len(all_2026) == 0:
        log('No 2026 swings to score — nothing to update')
        return

    # ── Enrich + score 2026 swings ──
    log(f'Enriching {len(all_2026):,} swings...')
    all_2026 = enrich(all_2026)
    all_2026 = all_2026.dropna(subset=['bat_speed'])
    all_2026 = resolve_batter_names(all_2026)
    log(f'Scoring...')
    all_2026 = score_swings(all_2026, model_a, model_b, scaler_a, scaler_b, config)

    # ── Load existing JSON ──
    existing_json = {}
    if os.path.exists(PUBLIC_JSON):
        with open(PUBLIC_JSON) as f:
            existing_json = json.load(f)
        log(f'Loaded existing iswing.json ({len(existing_json)} entries)')

    # ── Build updated JSON ──
    # Score all years present in the full CSV so normalization uses the full pool
    full_scored = pd.DataFrame()
    if os.path.exists(SWINGS_CSV):
        log('Loading full CSV for multi-year scoring...')
        full_raw = pd.read_csv(SWINGS_CSV)
        full_raw = enrich(full_raw)
        full_raw = full_raw.dropna(subset=['bat_speed'])
        full_raw = resolve_batter_names(full_raw)
        full_scored = score_swings(full_raw, model_a, model_b, scaler_a, scaler_b, config)

    source = full_scored if len(full_scored) > 0 else all_2026
    updated_json = build_json(source, existing_json)

    # ── Write JSON ──
    os.makedirs(os.path.dirname(PUBLIC_JSON), exist_ok=True)
    with open(PUBLIC_JSON, 'w') as f:
        json.dump(updated_json, f)
    log(f'Wrote {len(updated_json)} entries -> {PUBLIC_JSON}')

    # ── Hitter-card distribution + intercept-heatmap files (current season) ──
    season = date.today().year
    log('Building hitter-card distribution files...')
    write_iswing_dist(all_2026, season, updated_json=updated_json)
    write_intercept(all_2026, season)

    # ── Summary ──
    current_year = str(date.today().year)
    with_2026 = sum(1 for v in updated_json.values() if current_year in v)
    log(f'Players with {current_year} iSwing+: {with_2026}')
    log('Done.')


if __name__ == '__main__':
    main()
