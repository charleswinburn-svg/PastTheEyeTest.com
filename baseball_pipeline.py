#!/usr/bin/env python3
"""
Baseball Player Scoring Pipeline
Fetches data from Baseball Savant + FanGraphs, computes percentile scores, outputs JSON.
Mirrors the hockey_pipeline.py architecture.

Usage:
  python baseball_pipeline.py [output_dir] [seasons]

  output_dir: where to write JSON files (default: ./public)
  seasons:    comma-separated years (default: 2023,2024,2025)

Examples:
  python baseball_pipeline.py ./public
  python baseball_pipeline.py ./public 2024,2025
  python baseball_pipeline.py ./public 2025

Output files:
  baseball_data_2025.json  — hitters + pitchers with percentile scores
  baseball_data_2024.json
  baseball_data_2023.json
"""

import pandas as pd
import numpy as np
import requests
import json
import os
import sys
import time
import math
from io import StringIO

try:
    from pybaseball import pitching_stats, batting_stats, cache
    cache.enable()
    HAS_PYBASEBALL = True
    print("✓ pybaseball available — FanGraphs data enabled")
except ImportError:
    HAS_PYBASEBALL = False
    print("⚠ pybaseball not installed — Stuff+ and Location+ will be unavailable")
    print("  Install with: pip install pybaseball")

import unicodedata

# ============================================================
# CONFIG
# ============================================================

DEFAULT_SEASONS = [2023, 2024, 2025]
MIN_PA = 100          # minimum plate appearances for hitters (full season)
MIN_PA_EARLY = 25    # early-season threshold (before June 1)
MIN_PITCHER_IP = 20   # minimum innings pitched for pitchers
FETCH_DELAY = 2.0     # seconds between API calls (rate limiting)
MAX_RETRIES = 3

# Headers to avoid bot detection
HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/csv,text/plain,application/json,*/*",
    "Accept-Language": "en-US,en;q=0.9",
}

# ============================================================
# HITTER METRICS (from R app's `metrics` tibble)
# ============================================================

HITTER_METRICS = [
    {"key": "xslg",              "label": "xSLG",                "lower_better": False, "fmt": ".3f"},
    {"key": "xwobacon",          "label": "xwOBACON",            "lower_better": False, "fmt": ".3f"},
    {"key": "exit_velocity_avg", "label": "Avg Exit Velocity",   "lower_better": False, "fmt": ".1f"},
    {"key": "barrel_batted_rate","label": "Barrel %",            "lower_better": False, "fmt": ".1f"},
    {"key": "blasts_contact",    "label": "Blasts/Contact",      "lower_better": False, "fmt": ".1f", "pct_stored_decimal": True},
    {"key": "sweet_spot_percent","label": "LA+SwtSpt%",          "lower_better": False, "fmt": ".1f"},
    {"key": "avg_swing_speed",   "label": "Avg Bat Speed",       "lower_better": False, "fmt": ".1f"},
    {"key": "fast_swing_rate",   "label": "Fast Swing %",        "lower_better": False, "fmt": ".1f", "pct_stored_decimal": True},
    {"key": "avg_swing_length",  "label": "Avg Swing Length",    "lower_better": True,  "fmt": ".1f"},
    {"key": "attack_angle",      "label": "Avg. Attack Angle",   "lower_better": False, "fmt": ".1f"},
    {"key": "ideal_angle_rate",  "label": "Ideal Attack Angle %","lower_better": False, "fmt": ".1f"},
    {"key": "oz_swing_percent",  "label": "Chase %",             "lower_better": True,  "fmt": ".1f"},
    {"key": "k_percent",         "label": "K%",                  "lower_better": True,  "fmt": ".1f"},
    {"key": "whiff_percent",     "label": "Whiff %",             "lower_better": True,  "fmt": ".1f"},
    {"key": "bb_percent",        "label": "BB%",                 "lower_better": False, "fmt": ".1f"},
]

# ============================================================
# PITCHER METRICS (from R app's `pitcher_metrics` tibble)
# ============================================================

PITCHER_METRICS = [
    {"key": "stuff_plus",     "label": "Stuff+ (FG)",    "lower_better": False, "fmt": ".0f",  "src": "fg"},
    {"key": "location_plus",  "label": "Location+ (FG)", "lower_better": False, "fmt": ".0f",  "src": "fg"},
    {"key": "fip",            "label": "FIP",             "lower_better": True,  "fmt": ".2f",  "src": "fg"},
    {"key": "avg_ev",         "label": "Avg Exit Velo",   "lower_better": True,  "fmt": ".1f",  "src": "savant"},
    {"key": "barrel_pct",     "label": "Barrel%",         "lower_better": True,  "fmt": ".1f",  "src": "savant"},
    {"key": "xba",            "label": "xBA",             "lower_better": True,  "fmt": ".3f",  "src": "savant"},
    {"key": "xslg",           "label": "xSLG",            "lower_better": True,  "fmt": ".3f",  "src": "savant"},
    {"key": "xwoba",          "label": "xwOBA",           "lower_better": True,  "fmt": ".3f",  "src": "savant"},
    {"key": "avg_fb_velo",    "label": "Avg FB Velo",     "lower_better": False, "fmt": ".1f",  "src": "savant"},
    {"key": "whiff_percent",  "label": "Whiff%",          "lower_better": False, "fmt": ".1f",  "src": "savant"},
    {"key": "k_pct",          "label": "K%",              "lower_better": False, "fmt": ".1f",  "src": "fg",     "pct_stored_decimal": True},
    {"key": "chase_pct",      "label": "Chase%",          "lower_better": False, "fmt": ".1f",  "src": "fg",     "pct_stored_decimal": True},
    {"key": "bb_pct",         "label": "BB%",             "lower_better": True,  "fmt": ".1f",  "src": "fg",     "pct_stored_decimal": True},
    {"key": "k_bb_pct",       "label": "K-BB%",           "lower_better": False, "fmt": ".1f",  "src": "fg",     "pct_stored_decimal": True},
    {"key": "gb_pct",         "label": "GB%",             "lower_better": False, "fmt": ".1f",  "src": "fg",     "pct_stored_decimal": True},
]


# ============================================================
# FETCH HELPERS
# ============================================================

def fetch_url(url, retries=MAX_RETRIES, delay=FETCH_DELAY, expect="csv"):
    """Fetch URL with retry logic and rate limiting. Returns str (csv) or dict (json)."""
    for attempt in range(1, retries + 1):
        try:
            time.sleep(delay if attempt > 1 else 0.5)
            r = requests.get(url, headers=HTTP_HEADERS, timeout=60)
            if r.status_code == 403:
                print(f"    ⚠ 403 Forbidden (attempt {attempt}/{retries}): {url[:80]}...")
                time.sleep(delay * attempt * 2)
                continue
            r.raise_for_status()
            if expect == "json":
                return r.json()
            return r.text
        except requests.exceptions.RequestException as e:
            print(f"    ⚠ Fetch error (attempt {attempt}/{retries}): {e}")
            if attempt < retries:
                time.sleep(delay * attempt)
    print(f"    ✗ Failed after {retries} attempts: {url[:100]}")
    return None


def csv_to_df(text):
    """Parse CSV text to DataFrame, handling common Savant quirks."""
    if text is None or not text.strip():
        return None
    try:
        df = pd.read_csv(StringIO(text))
        # Drop empty rows
        df = df.dropna(how="all")
        return df
    except Exception as e:
        print(f"    ✗ CSV parse error: {e}")
        return None


# ============================================================
# SAVANT DATA SOURCES
# ============================================================

def fetch_savant_expected(year, player_type="batter"):
    """Fetch expected statistics (xSLG, xBA, xwOBA, etc.)"""
    from datetime import date
    today = date.today()
    batter_min = MIN_PA_EARLY if (today.year == year and today.month < 6) else MIN_PA
    min_val = str(batter_min) if player_type == 'batter' else '1'
    url = (
        f"https://baseballsavant.mlb.com/leaderboard/expected_statistics"
        f"?type={player_type}&year={year}&position=&team="
        f"&min={min_val}&csv=true"
    )
    print(f"  Fetching Savant expected stats ({player_type}, {year})...")
    text = fetch_url(url)
    df = csv_to_df(text)
    if df is not None:
        print(f"    ✓ {len(df)} rows, columns: {list(df.columns)}")
        # Savant uses est_slg, est_ba, est_woba — rename to our keys
        rename_map = {
            "est_slg": "xslg",
            "est_ba": "xba",
            "est_woba": "xwoba",
        }
        df = df.rename(columns={k: v for k, v in rename_map.items() if k in df.columns})
    return df


def fetch_savant_statcast(year, player_type="batter"):
    """Fetch standard statcast metrics (EV, barrel%, sweet spot, K%, BB%, etc.)"""
    if player_type == "batter":
        selections = "xwobacon,exit_velocity_avg,barrel_batted_rate,sweet_spot_percent,k_percent,bb_percent,whiff_percent,oz_swing_percent"
    else:
        selections = "exit_velocity_avg,barrel_batted_rate,whiff_percent,k_percent,bb_percent,p_oSwing_percent,release_extension"
    from datetime import date
    today = date.today()
    batter_min = MIN_PA_EARLY if (today.year == year and today.month < 6) else MIN_PA
    min_val = str(batter_min) if player_type == 'batter' else '1'
    url = (
        f"https://baseballsavant.mlb.com/leaderboard/custom"
        f"?year={year}&type={player_type}&filter=&sort=4&sortDir=desc"
        f"&min={min_val}"
        f"&selections={selections}"
        f"&chart=false&x=xba&y=xba&r=no&chartType=beeswarm&csv=true"
    )
    print(f"  Fetching Savant statcast ({player_type}, {year})...")
    text = fetch_url(url)
    df = csv_to_df(text)
    if df is not None:
        print(f"    ✓ {len(df)} rows")
    return df


def fetch_savant_bat_tracking(year):
    """Fetch bat tracking leaderboard (swing speed, length, attack angle, blasts)."""
    url = (
        f"https://baseballsavant.mlb.com/leaderboard/bat-tracking"
        f"?attackZone=&batSide=&contactType=&count=&dateStart=&dateEnd="
        f"&gameType=&isHardHit=&minSwings=q&month=&opposingTeam=&pitchHand="
        f"&pitchType=&playerPool=All&season={year}&team=&type=batter&csv=true"
    )
    print(f"  Fetching Savant bat tracking ({year})...")
    text = fetch_url(url)
    df = csv_to_df(text)
    if df is not None:
        print(f"    ✓ {len(df)} rows")
    return df


def fetch_savant_pitch_movement(year, pitch_type="FF"):
    """Fetch pitch movement leaderboard (velo, release height, extension for VAA calc)."""
    url = (
        f"https://baseballsavant.mlb.com/leaderboard/pitch-movement"
        f"?year={year}&team=&pitchType={pitch_type}&min=q"
        f"&sort=7&sortDir=asc&csv=true"
    )
    print(f"  Fetching Savant pitch movement ({pitch_type}, {year})...")
    text = fetch_url(url)
    df = csv_to_df(text)
    if df is not None:
        print(f"    ✓ {len(df)} rows")
    return df


# ============================================================
# FANGRAPHS DATA SOURCES (via pybaseball)
# ============================================================

def fetch_fangraphs_pitching(year):
    """
    Fetch FanGraphs pitching leaders. Tries in order:
    1. Browser cookies + API (most reliable — bypasses Cloudflare with your session)
    2. cloudscraper (handles JS challenges without browser)
    3. Direct API (works when FG isn't blocking)
    4. Selenium with system chromedriver
    5. pybaseball fallback
    """
    print(f"  Fetching FanGraphs pitching stats ({year})...")
    api_url = ("https://www.fangraphs.com/api/leaders/major-league/data"
               f"?pos=all&stats=pit&lg=all&qual=20&type=36"
               f"&season={year}&month=0&season1={year}&ind=0"
               f"&team=0&rost=0&age=0&filter=&players=0"
               f"&startdate=&enddate=&page=1_2000")

    # --- Attempt 1: Cookie-authenticated session ---
    cookie_paths = [
        "fangraphs_cookies.txt",
        os.path.join(os.path.dirname(__file__), "fangraphs_cookies.txt"),
        os.path.expanduser("~/project/fangraphs_cookies.txt"),
        "www.fangraphs.com_cookies.txt",
    ]
    for cp in cookie_paths:
        if not os.path.exists(cp):
            continue
        try:
            from http.cookiejar import MozillaCookieJar
            jar = MozillaCookieJar(cp)
            jar.load(ignore_discard=True, ignore_expires=True)
            s = requests.Session()
            s.cookies = jar
            s.headers.update(HTTP_HEADERS)
            r = s.get(api_url, timeout=30)
            if r.status_code == 200:
                data = r.json()
                rows = data.get("data", [])
                if rows:
                    df = _normalize_fg_api_columns(pd.DataFrame(rows))
                    print(f"    ✓ {len(df)} rows via cookies ({os.path.basename(cp)})")
                    return df
            print(f"    Cookies ({os.path.basename(cp)}) returned {r.status_code}")
        except Exception as e:
            print(f"    Cookies failed ({os.path.basename(cp)}): {e}")

    # --- Attempt 2: cloudscraper ---
    try:
        import cloudscraper
        scraper = cloudscraper.create_scraper()
        r = scraper.get(api_url, timeout=30)
        if r.status_code == 200:
            data = r.json()
            rows = data.get("data", [])
            if rows:
                df = _normalize_fg_api_columns(pd.DataFrame(rows))
                print(f"    ✓ {len(df)} rows via cloudscraper")
                return df
        print(f"    cloudscraper returned {r.status_code}")
    except Exception as e:
        print(f"    cloudscraper failed: {e}")

    # --- Attempt 3: Direct requests ---
    try:
        r = requests.get(api_url, headers=HTTP_HEADERS, timeout=30)
        if r.status_code == 200:
            data = r.json()
            rows = data.get("data", [])
            if rows:
                df = _normalize_fg_api_columns(pd.DataFrame(rows))
                print(f"    ✓ {len(df)} rows via direct API")
                return df
    except Exception as e:
        print(f"    Direct API failed: {e}")

    # --- Attempt 4: Selenium ---
    print(f"    Trying Selenium...")
    try:
        df = _fetch_fg_selenium(year)
        if df is not None and len(df) > 0:
            print(f"    ✓ {len(df)} rows via Selenium")
            return df
    except Exception as e:
        print(f"    Selenium failed: {e}")

    # --- Attempt 5: pybaseball ---
    if HAS_PYBASEBALL:
        print(f"    Trying pybaseball...")
        try:
            df = pitching_stats(year, year, qual=20)
            print(f"    ✓ {len(df)} rows via pybaseball")
            return df
        except Exception as e:
            print(f"    pybaseball failed: {e}")

    print(f"    ✗ All FanGraphs methods failed for {year}")
    return None

    print(f"    ✗ All FanGraphs fetch methods failed for {year}")
    return None


def _normalize_fg_api_columns(df):
    """Map FanGraphs API column names to pybaseball-style names."""
    fg_api_map = {
        "playerid": "IDfg", "xMLBAMID": "xMLBAMID",
        "TeamName": "Team", "IP": "IP", "FIP": "FIP",
        "Stuff": "Stuff+", "Location": "Location+",
        "StuffPlus": "Stuff+", "LocationPlus": "Location+",
        "K%": "K%", "BB%": "BB%", "K-BB%": "K-BB%",
        "GB%": "GB%", "O-Swing%": "O-Swing%", "SwStr%": "SwStr%",
        "FBv": "FBv", "mlbamid": "xMLBAMID", "MLBAMID": "xMLBAMID",
    }
    # Don't rename PlayerName→Name here — normalize_fg_name handles it
    # and the API may already have a 'Name' column causing duplicates
    df = df.rename(columns={k: v for k, v in fg_api_map.items() if k in df.columns})
    # Ensure no duplicate column names
    df = df.loc[:, ~df.columns.duplicated()]
    return df


def _fetch_fg_selenium(year):
    """Use Selenium with system chromium/chromedriver to scrape FanGraphs."""
    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.service import Service
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
    except ImportError:
        print("    selenium not installed")
        return None

    options = Options()
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-gpu")
    options.binary_location = "/usr/bin/chromium"

    driver = None
    try:
        service = Service("/usr/bin/chromedriver")
        driver = webdriver.Chrome(service=service, options=options)

        url = (f"https://www.fangraphs.com/leaders/major-league"
               f"?pos=all&stats=pit&lg=all&qual=20&type=36"
               f"&season={year}&month=0&season1={year}&ind=0"
               f"&team=0&rost=0&age=0&filter=&players=0"
               f"&startdate=&enddate=&page=1_2000")
        driver.get(url)

        WebDriverWait(driver, 30).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, ".leaders-major__table, .table-scroll, .fg-data-grid"))
        )
        time.sleep(2)

        html = driver.page_source
        tables = pd.read_html(html)
        if tables:
            df = max(tables, key=len)
            print(f"    Parsed {len(df)} rows from HTML table")
            return df
    except Exception as e:
        print(f"    Selenium error: {e}")
        return None
    finally:
        if driver:
            try: driver.quit()
            except: pass
    return None

    return None


# ============================================================
# NAME / ID UTILITIES
# ============================================================

def norm_name(s):
    """Normalize a player name: strip accents, periods, hyphens, Jr/Sr, lowercase."""
    if not isinstance(s, str) or not s:
        return ""
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")  # strip accents
    s = s.lower().replace(".", "").replace("-", " ").replace(",", "")
    # Remove Jr/Sr suffixes
    for suffix in [" jr", " sr", " ii", " iii", " iv"]:
        if s.endswith(suffix):
            s = s[:-len(suffix)]
    return " ".join(s.split())  # collapse whitespace


def dedup_merged(df):
    """Consolidate rows with matching normalized names or player_ids.
    When two rows represent the same player (one from FG, one from Savant),
    merge their columns so no data is lost."""
    if df is None or len(df) == 0:
        return df

    df = df.copy()
    df["_nname"] = df["player_name"].apply(norm_name) if "player_name" in df.columns else ""

    # Group by player_id first (if available), then by normalized name
    groups = {}
    for idx, row in df.iterrows():
        pid = row.get("player_id")
        nname = row.get("_nname", "")

        # Find existing group
        key = None
        if pd.notna(pid):
            pid = int(pid)
            for k, g in groups.items():
                if g["pid"] == pid or (g["pid"] is None and g["nname"] == nname):
                    key = k
                    if g["pid"] is None:
                        g["pid"] = pid
                    break
        if key is None and nname:
            for k, g in groups.items():
                if g["nname"] == nname:
                    key = k
                    if pd.notna(pid) and g["pid"] is None:
                        g["pid"] = int(pid)
                    break

        if key is None:
            key = idx
            groups[key] = {"pid": int(pid) if pd.notna(pid) else None, "nname": nname, "rows": []}
        groups[key]["rows"].append(idx)

    # Merge grouped rows
    keep_indices = []
    for g in groups.values():
        if len(g["rows"]) == 1:
            keep_indices.append(g["rows"][0])
            continue
        # Consolidate: first row is base, fill NaN from subsequent rows
        base_idx = g["rows"][0]
        for other_idx in g["rows"][1:]:
            for col in df.columns:
                base_val = df.at[base_idx, col]
                other_val = df.at[other_idx, col]
                try:
                    if (base_val is None or (isinstance(base_val, float) and pd.isna(base_val))) and pd.notna(other_val):
                        df.at[base_idx, col] = other_val
                except (ValueError, TypeError):
                    pass
        # Prefer accented name
        for other_idx in g["rows"][1:]:
            other_name = df.at[other_idx, "player_name"] if "player_name" in df.columns else ""
            base_name = df.at[base_idx, "player_name"] if "player_name" in df.columns else ""
            if isinstance(other_name, str) and isinstance(base_name, str):
                if other_name != norm_name(other_name) or len(other_name) > len(base_name):
                    df.at[base_idx, "player_name"] = other_name
        keep_indices.append(base_idx)

    result = df.loc[keep_indices].drop(columns=["_nname"], errors="ignore").reset_index(drop=True)
    deduped = len(df) - len(result)
    if deduped > 0:
        print(f"  Deduplication: {len(df)} → {len(result)} rows ({deduped} merged)")
    return result


def normalize_savant_name(df):
    """Standardize player name column from various Savant CSV formats."""
    # Savant uses different name formats across endpoints
    name_col = None
    for c in ["last_name, first_name", "player_name", "pitcher_name",
              "last_name_first_name", "name"]:
        if c in df.columns:
            name_col = c
            break

    if name_col and name_col != "player_name":
        if name_col == "last_name, first_name" or name_col == "last_name_first_name":
            # "Judge, Aaron" -> "Aaron Judge"
            df["player_name"] = df[name_col].apply(
                lambda x: " ".join(reversed(str(x).split(", "))) if ", " in str(x) else str(x)
            )
        else:
            df["player_name"] = df[name_col].astype(str)

    # Also try first_name + last_name columns
    if "player_name" not in df.columns and "first_name" in df.columns and "last_name" in df.columns:
        df["player_name"] = df["first_name"].astype(str) + " " + df["last_name"].astype(str)

    # Ensure player_id is int
    if "player_id" in df.columns:
        df["player_id"] = pd.to_numeric(df["player_id"], errors="coerce").astype("Int64")
    elif "pitcher_id" in df.columns:
        df["player_id"] = pd.to_numeric(df["pitcher_id"], errors="coerce").astype("Int64")

    return df


def normalize_fg_name(df):
    """Standardize FanGraphs / pybaseball name columns."""
    if "PlayerName" in df.columns:
        df["player_name"] = df["PlayerName"].astype(str)
    elif "Name" in df.columns:
        df["player_name"] = df["Name"].astype(str)
    # pybaseball uses xMLBAMID for the MLB AM player ID
    for id_col in ["xMLBAMID", "mlbamid", "MLBAMID", "key_mlbam"]:
        if id_col in df.columns:
            df["player_id"] = pd.to_numeric(df[id_col], errors="coerce").astype("Int64")
            break
    # Fallback to IDfg if no MLB ID
    if "player_id" not in df.columns and "IDfg" in df.columns:
        df["fg_id"] = df["IDfg"]
    return df


# ============================================================
# PERCENTILE COMPUTATION
# ============================================================

def pct_rank(series):
    """Percentile rank (0-100) using ECDF, matching R's ecdf() behavior."""
    valid = series.dropna()
    if len(valid) == 0:
        return pd.Series(np.nan, index=series.index)
    ranks = series.rank(method="average", na_option="keep")
    n = valid.count()
    return (ranks - 1) / max(n - 1, 1) * 100


def compute_percentile(pool, value, lower_better=False):
    """
    Compute percentile of a single value against a pool.
    Matches R's: ecdf(pool)(value) * 100, inverted if lower_better.
    """
    pool = pool.dropna()
    if len(pool) == 0 or not np.isfinite(value):
        return None
    pct = (pool < value).sum() / len(pool) * 100
    if lower_better:
        pct = 100 - pct
    return round(pct, 1)


def format_value(value, metric):
    """Format a raw value for display, matching R app formatting."""
    if value is None or not np.isfinite(value):
        return "—"
    # If stored as decimal and should display as percentage
    display_val = value
    if metric.get("scale"):
        display_val = value * metric["scale"]
    elif metric.get("pct_stored_decimal"):
        display_val = value * 100
    fmt = metric.get("fmt", ".1f")
    return f"{display_val:{fmt}}"


# ============================================================
# MLB API TEAM LOOKUP
# ============================================================

_TEAM_MAP_CACHE = None

def fetch_mlb_team_map():
    """Fetch all MLB rosters and build player_id → team abbreviation map."""
    global _TEAM_MAP_CACHE
    if _TEAM_MAP_CACHE is not None:
        return _TEAM_MAP_CACHE

    print("  Fetching MLB team rosters for team lookup...")

    # Step 1: Get all teams with abbreviations
    teams_url = "https://statsapi.mlb.com/api/v1/teams?sportId=1"
    try:
        r = requests.get(teams_url, headers=HTTP_HEADERS, timeout=30)
        r.raise_for_status()
        teams = r.json().get("teams", [])
    except Exception as e:
        print(f"    ✗ Failed to fetch teams: {e}")
        _TEAM_MAP_CACHE = {}
        return {}

    team_abbrs = {}  # team_id → abbreviation
    for t in teams:
        team_abbrs[t["id"]] = t.get("abbreviation", "")

    # Step 2: Fetch each team's active roster
    player_team = {}  # player_id → abbreviation
    for tid, abbr in team_abbrs.items():
        try:
            r = requests.get(f"https://statsapi.mlb.com/api/v1/teams/{tid}/roster", headers=HTTP_HEADERS, timeout=15)
            r.raise_for_status()
            roster = r.json().get("roster", [])
            for p in roster:
                pid = p.get("person", {}).get("id")
                if pid:
                    player_team[pid] = abbr
        except Exception:
            pass  # Skip failed teams silently
        time.sleep(0.1)  # Light rate limiting

    print(f"    ✓ {len(player_team)} players mapped to teams")
    _TEAM_MAP_CACHE = player_team
    return player_team


# ============================================================
# HITTER PIPELINE
# ============================================================

def process_hitters(year):
    """Fetch, merge, and score all hitter data for a season."""
    print(f"\n{'='*50}")
    print(f"HITTERS — {year}")
    print(f"{'='*50}")

    # --- Fetch all data sources ---
    df_expected = fetch_savant_expected(year, "batter")
    time.sleep(FETCH_DELAY)
    df_statcast = fetch_savant_statcast(year, "batter")
    time.sleep(FETCH_DELAY)
    df_batting = fetch_savant_bat_tracking(year)

    # --- Load supplemental bat tracking CSV (more complete than API) ---
    df_bat_csv = None
    for bat_csv_path in ["./public/merged_stats.csv", "./merged_stats.csv", os.path.join(os.path.dirname(__file__), "public", "merged_stats.csv")]:
        try:
            _df = pd.read_csv(bat_csv_path, encoding="utf-8-sig")
            _df = _df[pd.to_numeric(_df.get("year", pd.Series()), errors="coerce") == year].copy()
            if len(_df) > 0:
                _df = normalize_savant_name(_df)
                if "player_id" not in _df.columns and "player_id" in _df.columns:
                    pass
                _df["player_id"] = pd.to_numeric(_df.get("player_id", pd.Series()), errors="coerce").astype("Int64")
                # Columns already match pipeline keys
                df_bat_csv = _df
                print(f"  Supplemental bat tracking CSV: {len(df_bat_csv)} rows for {year}")
                break
        except Exception:
            continue

    # --- Fetch team info from MLB API ---
    team_map = fetch_mlb_team_map()

    if df_expected is None and df_statcast is None:
        print("  ✗ No hitter data available — skipping")
        return []

    # --- Normalize names/IDs ---
    dfs_to_merge = []
    if df_expected is not None:
        df_expected = normalize_savant_name(df_expected)
        dfs_to_merge.append(("expected", df_expected))
    if df_statcast is not None:
        df_statcast = normalize_savant_name(df_statcast)
        dfs_to_merge.append(("statcast", df_statcast))
    if df_batting is not None:
        # Bat tracking uses 'id' and 'name' instead of 'player_id' and 'player_name'
        if "id" in df_batting.columns:
            df_batting["player_id"] = pd.to_numeric(df_batting["id"], errors="coerce").astype("Int64")
        if "name" in df_batting.columns and "player_name" not in df_batting.columns:
            df_batting["player_name"] = df_batting["name"].astype(str)

        # Actual Savant bat tracking column names → our pipeline keys
        col_renames = {
            "avg_bat_speed": "avg_swing_speed",
            "swing_length": "avg_swing_length",
            "blast_per_bat_contact": "blasts_contact",
            "hard_swing_rate": "fast_swing_rate",
            "squared_up_per_bat_contact": "squared_up_contact",
        }
        df_batting = df_batting.rename(columns={k: v for k, v in col_renames.items() if k in df_batting.columns})
        print(f"  Bat tracking columns after rename: {[c for c in df_batting.columns if c in ['player_id','player_name','avg_swing_speed','avg_swing_length','blasts_contact','fast_swing_rate']]}")
        dfs_to_merge.append(("bat_tracking", df_batting))

    # --- Merge on player_id (preferred) or player_name ---
    merged = None
    for label, df in dfs_to_merge:
        if merged is None:
            merged = df.copy()
            continue
        # Determine merge key
        if "player_id" in merged.columns and "player_id" in df.columns:
            key = "player_id"
        elif "player_name" in merged.columns and "player_name" in df.columns:
            key = "player_name"
        else:
            print(f"    ⚠ Cannot merge {label} — no common key")
            continue

        # Get new columns only (avoid duplication)
        existing_cols = set(merged.columns)
        new_cols = [c for c in df.columns if c not in existing_cols or c == key]
        if len(new_cols) <= 1:
            continue
        merged = merged.merge(df[new_cols], on=key, how="left", suffixes=("", f"_{label}"))
        print(f"  Merged {label}: {len(merged)} rows")

    if merged is None or len(merged) == 0:
        print("  ✗ No merged hitter data")
        return []

    # --- Fill gaps from supplemental CSV ---
    # Build set of columns that need decimal conversion (stored as 0.xx, CSV has xx.x)
    pct_decimal_keys = {m["key"] for m in HITTER_METRICS if m.get("pct_stored_decimal")}
    print(f"  pct_decimal_keys (will divide by 100): {pct_decimal_keys}")
    fill_cols = ["avg_swing_speed", "fast_swing_rate", "blasts_contact", "avg_swing_length",
                 "attack_angle", "ideal_angle_rate", "exit_velocity_avg", "sweet_spot_percent",
                 "barrel_batted_rate", "oz_swing_percent", "whiff_percent", "xslg", "xwobacon"]
    if df_bat_csv is not None and "player_id" in merged.columns and "player_id" in df_bat_csv.columns:
        csv_lookup = {}
        for _, row in df_bat_csv.iterrows():
            pid = row.get("player_id")
            if pd.notna(pid):
                csv_lookup[int(pid)] = row
        print(f"  CSV lookup: {len(csv_lookup)} players available")
        filled_counts = {c: 0 for c in fill_cols}
        converted_samples = {}  # track sample conversions for debug
        for idx, row in merged.iterrows():
            pid = row.get("player_id")
            if pd.isna(pid):
                continue
            csv_row = csv_lookup.get(int(pid))
            if csv_row is None:
                continue
            for col in fill_cols:
                if col not in merged.columns:
                    merged[col] = None
                cur = row.get(col)
                try:
                    cur_missing = cur is None or pd.isna(cur)
                except (ValueError, TypeError):
                    cur_missing = True
                csv_val = csv_row.get(col)
                if cur_missing and pd.notna(csv_val):
                    val = float(csv_val)
                    # CSV stores percentages as xx.x, but pipeline expects 0.xx for pct_stored_decimal cols
                    if col in pct_decimal_keys and val > 1:
                        if col not in converted_samples:
                            converted_samples[col] = f"{val} → {val/100.0}"
                        val = val / 100.0
                    merged.at[idx, col] = val
                    filled_counts[col] += 1
        filled_any = {k: v for k, v in filled_counts.items() if v > 0}
        if filled_any:
            print(f"  Stats filled from CSV: {filled_any}")
        if converted_samples:
            print(f"  Pct conversion samples: {converted_samples}")
    else:
        if df_bat_csv is None:
            print("  ⚠ No supplemental CSV found (looking for ./public/merged_stats.csv)")
        else:
            print("  ⚠ Cannot merge CSV — missing player_id column")

    # --- Merge team info ---
    if team_map and "player_id" in merged.columns:
        merged["team"] = merged["player_id"].apply(lambda pid: team_map.get(int(pid)) if pd.notna(pid) else None)
        team_count = merged["team"].notna().sum()
        print(f"  Team info: {team_count}/{len(merged)} hitters have team")

    # --- Filter to minimum PA (dynamic: lower threshold early in the season) ---
    from datetime import date
    today = date.today()
    is_early = (today.year == year and today.month < 6) or (today.year > year)  # if running for current year before June
    effective_min_pa = MIN_PA_EARLY if (today.year == year and today.month < 6) else MIN_PA
    if "pa" in merged.columns:
        merged["pa"] = pd.to_numeric(merged["pa"], errors="coerce")
        merged = merged[merged["pa"] >= effective_min_pa].copy()
    print(f"  After min PA filter ({effective_min_pa}): {len(merged)} hitters")

    # --- Debug: show which metric columns are available ---
    available = [m["key"] for m in HITTER_METRICS if m["key"] in merged.columns]
    missing = [m["key"] for m in HITTER_METRICS if m["key"] not in merged.columns]
    print(f"  Metric columns found: {available}")
    if missing:
        print(f"  Metric columns MISSING: {missing}")
    # Show sample of all columns
    print(f"  All merged columns: {sorted(merged.columns.tolist())}")

    # --- Ensure numeric columns ---
    for m in HITTER_METRICS:
        if m["key"] in merged.columns:
            merged[m["key"]] = pd.to_numeric(merged[m["key"]], errors="coerce")

    # --- Compute percentiles ---
    results = []
    for _, row in merged.iterrows():
        cats = {}
        for m in HITTER_METRICS:
            key = m["key"]
            raw_val = row.get(key)
            if raw_val is None or (isinstance(raw_val, float) and not np.isfinite(raw_val)):
                cats[m["label"]] = {"pctile": None, "value": None, "display": "—"}
                continue
            raw_val = float(raw_val)
            pool = merged[key].dropna()
            pctile = compute_percentile(pool, raw_val, m["lower_better"])
            cats[m["label"]] = {
                "pctile": pctile,
                "value": round(raw_val, 4),
                "display": format_value(raw_val, m),
            }

        player_name = row.get("player_name", "")
        player_id = row.get("player_id")
        if pd.isna(player_id):
            player_id = None
        else:
            player_id = int(player_id)

        # Attempt to get team
        team = None
        for tcol in ["team", "team_name", "Team", "player_team"]:
            if tcol in row.index and pd.notna(row.get(tcol)):
                team = str(row[tcol])
                break

        results.append({
            "name": player_name,
            "player_id": player_id,
            "team": team,
            "pa": int(row.get("pa", 0)) if pd.notna(row.get("pa")) else None,
            "categories": cats,
        })

    print(f"  ✓ {len(results)} hitters scored")
    return results


# ============================================================
# PITCHER PIPELINE
# ============================================================

def compute_vaa(release_z, extension, plate_z_est=2.5):
    """
    Approximate VAA from release height and extension.
    VAA = arctan((plate_z - release_z) / (60.5 - extension)) in degrees.
    Uses estimated average plate_z for fastballs ≈ 2.5 ft.
    """
    if any(not np.isfinite(v) for v in [release_z, extension]):
        return None
    dist = 60.5 - extension
    if dist <= 0:
        return None
    vaa = math.atan((plate_z_est - release_z) / dist) * (180 / math.pi)
    return round(vaa, 2)


def process_pitchers(year):
    """Fetch, merge, and score all pitcher data for a season."""
    print(f"\n{'='*50}")
    print(f"PITCHERS — {year}")
    print(f"{'='*50}")

    # --- Fetch FanGraphs data (single call via pybaseball) ---
    fg_data = fetch_fangraphs_pitching(year)
    time.sleep(FETCH_DELAY)

    # --- Fetch Savant data ---
    sv_expected = fetch_savant_expected(year, "pitcher")
    time.sleep(FETCH_DELAY)
    sv_statcast = fetch_savant_statcast(year, "pitcher")
    time.sleep(FETCH_DELAY)

    # --- Fetch pitch movement for FB velo + VAA ---
    sv_movement_ff = fetch_savant_pitch_movement(year, "FF")
    time.sleep(FETCH_DELAY)
    sv_movement_si = fetch_savant_pitch_movement(year, "SI")
    time.sleep(FETCH_DELAY)
    sv_movement_fc = fetch_savant_pitch_movement(year, "FC")

    # --- Build FanGraphs base ---
    fg_merged = None
    if fg_data is not None and len(fg_data) > 0:
        fg_merged = fg_data.copy()
        fg_merged = normalize_fg_name(fg_merged)
        print(f"  FanGraphs columns available: {', '.join(c for c in fg_merged.columns if c in ['Stuff+','Location+','FIP','K%','BB%','GB%','K-BB%','O-Swing%','SwStr%','IP','Team','Name','xMLBAMID','mlbamid'])}")
    else:
        print("  ⚠ No FanGraphs data — Stuff+, Location+, FIP from FG will be missing")

    # --- Normalize FanGraphs column names to our pipeline keys ---
    if fg_merged is not None:
        fg_col_map = {
            # pybaseball pitching_stats column names
            "FIP": "fip", "IP": "ip", "Team": "team",
            "K%": "k_pct", "BB%": "bb_pct", "K-BB%": "k_bb_pct", "GB%": "gb_pct",
            "O-Swing%": "chase_pct", "SwStr%": "whiff_pct",
            "Stuff+": "stuff_plus", "Location+": "location_plus",
            "StuffPlus": "stuff_plus", "LocationPlus": "location_plus",
            # Velo and extension from FanGraphs
            "FBv": "avg_fb_velo", "vFA (pi)": "avg_fb_velo",
            "Ext": "extension", "Extension": "extension",
        }
        fg_merged = fg_merged.rename(columns={k: v for k, v in fg_col_map.items() if k in fg_merged.columns})
    else:
        fg_merged = pd.DataFrame()

    # --- Build Savant base ---
    sv_dfs = []
    if sv_expected is not None:
        sv_expected = normalize_savant_name(sv_expected)
        sv_dfs.append(sv_expected)
    if sv_statcast is not None:
        sv_statcast = normalize_savant_name(sv_statcast)
        # Rename Savant pitcher columns
        sv_rename = {
            "exit_velocity_avg": "avg_ev",
            "barrel_batted_rate": "barrel_pct",
            "p_oSwing_percent": "chase_pct_sv",
            "release_extension": "extension",
            "fastball_avg_speed": "avg_fb_velo",
        }
        sv_statcast = sv_statcast.rename(columns={k: v for k, v in sv_rename.items() if k in sv_statcast.columns})
        sv_dfs.append(sv_statcast)

    sv_merged = None
    for df in sv_dfs:
        if sv_merged is None:
            sv_merged = df.copy()
            continue
        key = "player_id" if ("player_id" in sv_merged.columns and "player_id" in df.columns) else "player_name"
        existing = set(sv_merged.columns)
        new_cols = [c for c in df.columns if c not in existing or c == key]
        if len(new_cols) > 1:
            sv_merged = sv_merged.merge(df[new_cols], on=key, how="outer", suffixes=("", "_dup"))

    # --- Build FB velo / VAA from pitch movement data ---
    fb_data = {}  # player_id -> {velo, vaa, pitch_type}
    for pt, df in [("FF", sv_movement_ff), ("SI", sv_movement_si), ("FC", sv_movement_fc)]:
        if df is None:
            continue
        df = normalize_savant_name(df)
        print(f"  Pitch movement ({pt}) columns: {list(df.columns)[:15]}")
        for col in ["avg_speed", "release_speed", "pitch_speed", "velocity"]:
            if col in df.columns:
                df["_velo"] = pd.to_numeric(df[col], errors="coerce")
                print(f"    → Using '{col}' for velo")
                break
        else:
            print(f"    ⚠ No velo column found in: {list(df.columns)}")
        for col in ["release_pos_z", "rel_z", "release_height"]:
            if col in df.columns:
                df["_rel_z"] = pd.to_numeric(df[col], errors="coerce")
                break
        for col in ["release_extension", "extension", "rel_extension"]:
            if col in df.columns:
                df["_ext"] = pd.to_numeric(df[col], errors="coerce")
                break
        for col in ["pitches_thrown", "pitch_count", "n"]:
            if col in df.columns:
                df["_n"] = pd.to_numeric(df[col], errors="coerce")
                break

        for _, row in df.iterrows():
            pid = row.get("player_id")
            if pd.isna(pid):
                continue
            pid = int(pid)
            velo = row.get("_velo")
            n = row.get("_n", 0)
            if pd.isna(velo) or pd.isna(n):
                continue
            # Prefer FF > SI > FC; skip if we already have FF
            if pid in fb_data and fb_data[pid]["pitch_type"] == "FF":
                continue
            # Compute VAA from release data
            rel_z = row.get("_rel_z")
            ext = row.get("_ext")
            vaa = None
            if pd.notna(rel_z) and pd.notna(ext):
                vaa = compute_vaa(float(rel_z), float(ext))
            fb_data[pid] = {
                "avg_fb_velo": float(velo),
                "avg_fb_vaa": vaa,
                "pitch_type": pt,
                "vaa_pitch_type": pt,
            }

    # --- Merge FanGraphs + Savant ---
    if len(fg_merged) > 0 and sv_merged is not None and len(sv_merged) > 0:
        # Add normalized name columns for fallback matching
        if "player_name" in fg_merged.columns:
            fg_merged["_nname"] = fg_merged["player_name"].apply(norm_name)
        if "player_name" in sv_merged.columns:
            sv_merged["_nname"] = sv_merged["player_name"].apply(norm_name)

        if "player_id" in fg_merged.columns and "player_id" in sv_merged.columns:
            existing = set(fg_merged.columns)
            new_cols = [c for c in sv_merged.columns if c not in existing or c == "player_id"]
            # First: merge rows that have matching player_id
            merged = fg_merged.merge(sv_merged[new_cols], on="player_id", how="outer", suffixes=("", "_sv"))
        elif "_nname" in fg_merged.columns and "_nname" in sv_merged.columns:
            existing = set(fg_merged.columns)
            new_cols = [c for c in sv_merged.columns if c not in existing or c == "_nname"]
            merged = fg_merged.merge(sv_merged[new_cols], on="_nname", how="outer", suffixes=("", "_sv"))
        else:
            merged = fg_merged.copy()

        # Clean up temp column
        merged = merged.drop(columns=["_nname"], errors="ignore")
        fg_merged = fg_merged.drop(columns=["_nname"], errors="ignore")
        sv_merged = sv_merged.drop(columns=["_nname"], errors="ignore")
    elif len(fg_merged) > 0:
        merged = fg_merged.copy()
    elif sv_merged is not None:
        merged = sv_merged.copy()
    else:
        print("  ✗ No pitcher data available")
        return []

    # --- Deduplicate merged rows (fixes accent/period name mismatches) ---
    merged = dedup_merged(merged)

    # --- Add FB velo / VAA ---
    print(f"  FB data from pitch movement: {len(fb_data)} pitchers")
    # Deduplicate columns first (can happen from multiple merges)
    merged = merged.loc[:, ~merged.columns.duplicated()]
    if "player_id" in merged.columns:
        for col in ["avg_fb_velo", "avg_fb_vaa", "vaa_pitch_type"]:
            if col not in merged.columns:
                merged[col] = None
        filled = 0
        for idx, row in merged.iterrows():
            pid = row.get("player_id")
            try:
                pid_valid = pd.notna(pid)
            except ValueError:
                continue
            if pid_valid and int(pid) in fb_data:
                fb = fb_data[int(pid)]
                for col in ["avg_fb_velo", "avg_fb_vaa", "vaa_pitch_type"]:
                    val = row.get(col)
                    try:
                        val_missing = val is None or pd.isna(val)
                    except (ValueError, TypeError):
                        val_missing = True
                    if val_missing and fb.get(col) is not None:
                        merged.at[idx, col] = fb[col]
                        if col == "avg_fb_velo":
                            filled += 1
        print(f"  FB velo filled from pitch movement: {filled}")
        if "avg_fb_velo" in merged.columns:
            velo_count = merged["avg_fb_velo"].notna().sum()
            print(f"  Total pitchers with FB velo: {velo_count}/{len(merged)}")

    # --- Debug: show available pitcher metric columns ---
    available = [m["key"] for m in PITCHER_METRICS if m["key"] in merged.columns]
    missing = [m["key"] for m in PITCHER_METRICS if m["key"] not in merged.columns]
    print(f"  Pitcher metric columns found: {available}")
    if missing:
        print(f"  Pitcher metric columns MISSING: {missing}")

    # --- Use Savant chase% if FG chase% missing ---
    if "chase_pct" not in merged.columns and "chase_pct_sv" in merged.columns:
        merged["chase_pct"] = merged["chase_pct_sv"]
    elif "chase_pct" in merged.columns and "chase_pct_sv" in merged.columns:
        merged["chase_pct"] = merged["chase_pct"].fillna(merged["chase_pct_sv"])

    # --- Filter to minimum IP ---
    if "ip" in merged.columns:
        merged["ip"] = pd.to_numeric(merged["ip"], errors="coerce")
        before = len(merged)
        merged = merged[merged["ip"] >= MIN_PITCHER_IP].copy()
        print(f"  After min IP filter: {len(merged)} pitchers (removed {before - len(merged)})")

    # --- Ensure numeric columns ---
    # Deduplicate columns (can happen from multiple merges)
    merged = merged.loc[:, ~merged.columns.duplicated()]
    for m in PITCHER_METRICS:
        if m["key"] in merged.columns:
            merged[m["key"]] = pd.to_numeric(merged[m["key"]], errors="coerce")

    # --- Compute percentiles ---
    results = []
    for _, row in merged.iterrows():
        cats = {}
        for m in PITCHER_METRICS:
            key = m["key"]
            raw_val = row.get(key)
            if raw_val is None or (isinstance(raw_val, float) and not np.isfinite(raw_val)):
                cats[m["label"]] = {"pctile": None, "value": None, "display": "—"}
                continue
            raw_val = float(raw_val)
            pool = merged[key].dropna()
            pctile = compute_percentile(pool, raw_val, m["lower_better"])
            cats[m["label"]] = {
                "pctile": pctile,
                "value": round(raw_val, 6),
                "display": format_value(raw_val, m),
            }

        player_name = row.get("player_name", "")
        player_id = row.get("player_id")
        if pd.isna(player_id):
            player_id = None
        else:
            player_id = int(player_id)

        team = None
        for tcol in ["team", "Team", "team_name"]:
            if tcol in row.index and pd.notna(row.get(tcol)):
                team = str(row[tcol])
                break
        # Fallback to MLB API roster lookup
        if team is None and player_id is not None:
            tm = fetch_mlb_team_map()
            team = tm.get(player_id)

        vaa_pt = row.get("vaa_pitch_type")
        if pd.isna(vaa_pt) if isinstance(vaa_pt, float) else vaa_pt is None:
            vaa_pt = None

        results.append({
            "name": player_name,
            "player_id": player_id,
            "team": team,
            "ip": round(float(row.get("ip", 0)), 1) if pd.notna(row.get("ip")) else None,
            "vaa_pitch_type": vaa_pt,
            "categories": cats,
        })

    print(f"  ✓ {len(results)} pitchers scored")
    return results


# ============================================================
# JSON OUTPUT
# ============================================================

def build_output(year, hitters, pitchers):
    """Build the output JSON structure for a single season."""
    return {
        "season": year,
        "hitters": hitters,
        "pitchers": pitchers,
        "hitter_metrics": [
            {"key": m["label"], "label": m["label"], "lower_better": m["lower_better"]}
            for m in HITTER_METRICS
        ],
        "pitcher_metrics": [
            {"key": m["label"], "label": m["label"], "lower_better": m["lower_better"]}
            for m in PITCHER_METRICS
        ],
        "meta": {
            "min_pa": MIN_PA,
            "min_ip": MIN_PITCHER_IP,
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
        },
    }


# ============================================================
# MAIN PIPELINE
# ============================================================

def run_pipeline(seasons, output_dir):
    """Run the full pipeline for all specified seasons."""
    os.makedirs(output_dir, exist_ok=True)
    print(f"\n{'#'*60}")
    print(f"# Baseball Pipeline")
    print(f"# Seasons: {', '.join(str(s) for s in seasons)}")
    print(f"# Output:  {output_dir}")
    print(f"{'#'*60}")

    all_season_data = {}

    for year in seasons:
        print(f"\n\n{'*'*60}")
        print(f"* SEASON {year}")
        print(f"{'*'*60}")

        hitters = process_hitters(year)
        time.sleep(FETCH_DELAY)
        pitchers = process_pitchers(year)

        output = build_output(year, hitters, pitchers)
        all_season_data[year] = output

        fname = f"baseball_data_{year}.json"
        fpath = os.path.join(output_dir, fname)
        with open(fpath, "w") as f:
            json.dump(output, f, indent=2, default=str)
        print(f"\n  → Wrote {fpath} ({len(hitters)} hitters, {len(pitchers)} pitchers)")

    # --- Build trend data across seasons ---
    hitter_trends = {}
    pitcher_trends = {}

    for year, data in all_season_data.items():
        for h in data["hitters"]:
            name = h["name"]
            entry = {"season": year}
            for m in HITTER_METRICS:
                cat = h["categories"].get(m["label"], {})
                entry[m["label"]] = cat.get("value")
            hitter_trends.setdefault(name, []).append(entry)

        for p in data["pitchers"]:
            name = p["name"]
            entry = {"season": year}
            for m in PITCHER_METRICS:
                cat = p["categories"].get(m["label"], {})
                entry[m["label"]] = cat.get("value")
            pitcher_trends.setdefault(name, []).append(entry)

    trends = {
        "hitter_trends": hitter_trends,
        "pitcher_trends": pitcher_trends,
    }
    trends_path = os.path.join(output_dir, "baseball_trends.json")
    with open(trends_path, "w") as f:
        json.dump(trends, f, indent=2, default=str)
    print(f"\n  → Wrote {trends_path} ({len(hitter_trends)} hitters, {len(pitcher_trends)} pitchers)")

    print(f"\n{'#'*60}")
    print(f"# Pipeline complete!")
    print(f"{'#'*60}\n")


# ============================================================
# CLI
# ============================================================

if __name__ == "__main__":
    output = sys.argv[1] if len(sys.argv) > 1 else "./public"
    seasons_arg = sys.argv[2] if len(sys.argv) > 2 else ",".join(str(s) for s in DEFAULT_SEASONS)
    seasons = [int(s.strip()) for s in seasons_arg.split(",")]
    run_pipeline(seasons, output)
