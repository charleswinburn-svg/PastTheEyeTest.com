#!/usr/bin/env python3
"""
fetch_aaa_xwoba.py — Fetch AAA hitter xwOBA and update public/prospect_xwoba.json.

Strategy (in order):
  1. Prospect Savant API (level-adjusted xwOBA, the preferred source).
  2. Savant minor-league expected-statistics leaderboard.
  3. Compute xwOBA from raw Savant pitch-by-pitch statcast data.

Usage:
  python3 fetch_aaa_xwoba.py                   # default: current year
  python3 fetch_aaa_xwoba.py 2026
  python3 fetch_aaa_xwoba.py 2025,2026
  python3 fetch_aaa_xwoba.py 2026 --min-pitches 100
  python3 fetch_aaa_xwoba.py 2026 --output-dir ./public

Output:
  {output_dir}/prospect_xwoba.json  (merged, all seasons)
"""

import argparse
import json
import os
import sys
import time
import unicodedata
from datetime import date
from io import StringIO

import requests
import pandas as pd

# ── config ────────────────────────────────────────────────────────────────────

SAVANT_BASE = "https://baseballsavant.mlb.com"
PROSPECT_SAVANT_API = "https://oriolebird.pythonanywhere.com"
FETCH_DELAY = 3.0
MAX_RETRIES = 4
DEFAULT_MIN_PA = 10
DEFAULT_MIN_PITCHES = 100
DEFAULT_AGE_MIN = 16
DEFAULT_AGE_MAX = 40

HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/csv,text/plain,application/json,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://baseballsavant.mlb.com/",
}

# Events that complete a plate appearance and have non-batted-ball xwOBA
NON_CONTACT_PA_EVENTS = {
    "strikeout", "strikeout_double_play",
    "walk", "intent_walk",
    "hit_by_pitch",
    "catcher_interf",
}
# Events that complete a PA (used to filter rows to one row per PA)
PA_EVENTS = NON_CONTACT_PA_EVENTS | {
    "single", "double", "triple", "home_run",
    "field_out", "grounded_into_double_play", "double_play",
    "field_error", "fielders_choice", "fielders_choice_out",
    "force_out", "other_out", "sac_fly", "sac_fly_double_play",
    "sac_bunt", "sac_bunt_double_play",
}

# Savant date ranges (split into chunks to avoid timeouts)
SEASON_CHUNKS = [
    ("03-20", "04-15"),
    ("04-16", "04-30"),
    ("05-01", "05-15"),
    ("05-16", "05-31"),
    ("06-01", "06-15"),
    ("06-16", "06-30"),
    ("07-01", "07-15"),
    ("07-16", "07-31"),
    ("08-01", "08-15"),
    ("08-16", "08-31"),
    ("09-01", "09-15"),
    ("09-16", "10-02"),
]


# ── helpers ───────────────────────────────────────────────────────────────────

def norm_name(s):
    if not isinstance(s, str) or not s:
        return ""
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.lower().replace(".", "").replace("-", " ").replace(",", "")
    for suffix in [" jr", " sr", " ii", " iii", " iv"]:
        if s.endswith(suffix):
            s = s[:-len(suffix)]
    return " ".join(s.split())


def fetch_url(url, retries=MAX_RETRIES, delay=FETCH_DELAY):
    for attempt in range(1, retries + 1):
        try:
            time.sleep(delay if attempt > 1 else 0.5)
            r = requests.get(url, headers=HTTP_HEADERS, timeout=120)
            if r.status_code == 403:
                print(f"    ⚠ 403 on attempt {attempt}/{retries}, backing off")
                time.sleep(delay * attempt * 2)
                continue
            r.raise_for_status()
            return r.text
        except Exception as e:
            print(f"    ⚠ Error (attempt {attempt}/{retries}): {e}")
            if attempt < retries:
                time.sleep(delay * attempt)
    return None


def parse_csv(text):
    if not text or "<!DOCTYPE" in text[:200]:
        return None
    try:
        df = pd.read_csv(StringIO(text))
        return df.dropna(how="all") if len(df) > 0 else None
    except Exception as e:
        print(f"    ✗ CSV parse error: {e}")
        return None


# ── strategy 1: Prospect Savant API ──────────────────────────────────────────

# Possible field names for player name and xwOBA across API versions
NAME_FIELDS = ("Name", "name", "player_name", "playerName", "player", "full_name", "fullName")
XWOBA_FIELDS = ("xwOBA", "xwoba", "xWOBA", "expected_woba", "est_woba", "x_woba")


def _extract_name_xwoba(row):
    """Pull (name, xwoba) from a row dict, trying multiple field name variants."""
    name = None
    for f in NAME_FIELDS:
        v = row.get(f)
        if v and isinstance(v, str) and v.strip():
            name = v.strip()
            # Handle "Last, First" → "First Last"
            if "," in name and name.count(",") == 1:
                last, first = name.split(",", 1)
                name = f"{first.strip()} {last.strip()}"
            break

    xw = None
    for f in XWOBA_FIELDS:
        v = row.get(f)
        if v is None or v == "":
            continue
        try:
            xw = float(v)
            break
        except (ValueError, TypeError):
            continue

    return name, xw


def fetch_prospect_savant(year, min_pitches=DEFAULT_MIN_PITCHES,
                           age_min=DEFAULT_AGE_MIN, age_max=DEFAULT_AGE_MAX):
    """
    Fetch AAA hitter xwOBA from Prospect Savant's API
    (oriolebird.pythonanywhere.com — the backend behind prospectsavant.com).

    URL pattern: /leaders/hitters/AAA/{year}/{min_pitches}/{age_min}/{age_max}
    """
    url = f"{PROSPECT_SAVANT_API}/leaders/hitters/AAA/{year}/{min_pitches}/{age_min}/{age_max}"
    print(f"  → Prospect Savant: {url}")
    text = fetch_url(url)
    if not text:
        print(f"    ✗ No response")
        return None

    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        print(f"    ✗ JSON parse error: {e}")
        print(f"    First 200 chars: {text[:200]}")
        return None

    # API may return a list directly, or {"data": [...]} / {"leaders": [...]}
    rows = None
    if isinstance(data, list):
        rows = data
    elif isinstance(data, dict):
        for key in ("data", "leaders", "hitters", "players", "results", "rows"):
            if key in data and isinstance(data[key], list):
                rows = data[key]
                break

    if not rows:
        print(f"    ✗ No rows found in response (keys: {list(data.keys()) if isinstance(data, dict) else type(data).__name__})")
        return None

    print(f"    Got {len(rows)} rows; sample keys: {list(rows[0].keys())[:15] if rows else 'none'}")

    result = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        name, xw = _extract_name_xwoba(row)
        if name and xw is not None and xw > 0:
            result[name] = round(xw, 3)

    if len(result) < 5:
        print(f"    ✗ Too few players parsed ({len(result)})")
        return None

    print(f"    ✓ Prospect Savant: {len(result)} hitters with xwOBA")
    return result


# ── strategy 2: Savant minor-league leaderboard ──────────────────────────────

def fetch_leaderboard(year, min_pa=DEFAULT_MIN_PA):
    """
    Try the Savant minor-league expected-statistics leaderboard.
    Returns dict {canonical_name: xwoba} or None if unavailable.
    """
    # Savant minor-league leaderboard endpoint (may vary; we try both known forms)
    urls = [
        (
            f"{SAVANT_BASE}/leaderboard/minor-league"
            f"?typ=expected_statistics&lvl=aaa&year={year}&min={min_pa}&csv=true"
        ),
        (
            f"{SAVANT_BASE}/leaderboard/minor-league"
            f"?typ=hitting&lvl=aaa&year={year}&min={min_pa}&csv=true"
        ),
    ]

    for url in urls:
        print(f"  → Leaderboard: {url}")
        text = fetch_url(url)
        if not text:
            continue
        df = parse_csv(text)
        if df is None or len(df) < 5:
            continue

        print(f"    Columns: {list(df.columns[:10])}")

        # Normalise expected-wOBA column name across Savant versions
        col_map = {}
        for col in df.columns:
            cl = col.lower().strip()
            if cl in ("est_woba", "xwoba", "xwoba_avg", "est_woba_avg", "expected_woba"):
                col_map["xwoba"] = col
            if cl in ("last_name, first_name", "player_name", "name", "last_name"):
                col_map["name_raw"] = col
            if cl in ("first_name",):
                col_map["first_name"] = col
            if cl in ("last_name",):
                col_map["last_name"] = col
            if cl in ("pa", "total_pa", "plate_appearances"):
                col_map["pa"] = col

        if "xwoba" not in col_map:
            print(f"    ✗ No xwOBA column found")
            continue

        # Build name
        def get_name(row):
            if "name_raw" in col_map:
                raw = str(row[col_map["name_raw"]])
                # Savant "Last, First" → "First Last"
                if "," in raw:
                    parts = raw.split(",", 1)
                    return f"{parts[1].strip()} {parts[0].strip()}"
                return raw.strip()
            if "first_name" in col_map and "last_name" in col_map:
                return f"{row[col_map['first_name']].strip()} {row[col_map['last_name']].strip()}"
            return ""

        result = {}
        for _, row in df.iterrows():
            name = get_name(row)
            if not name:
                continue
            try:
                xw = float(row[col_map["xwoba"]])
                if xw > 0:
                    result[name] = round(xw, 3)
            except (ValueError, TypeError):
                pass

        if len(result) >= 10:
            print(f"    ✓ Leaderboard: {len(result)} players with xwOBA")
            return result

        print(f"    ✗ Too few players ({len(result)}), trying next")

    return None


# ── strategy 2: compute from raw pitch-by-pitch data ─────────────────────────

def fetch_raw_chunk(year, start, end):
    url = (
        f"{SAVANT_BASE}/statcast_search/csv?all=true&type=detail"
        f"&player_type=batter&hfGT=R%7C&hfSea={year}%7C"
        f"&game_date_gt={start}&game_date_lt={end}"
        f"&min_pitches=0&min_results=0&min_pas=0"
    )
    text = fetch_url(url)
    if not text:
        return None
    df = parse_csv(text)
    return df


def get_aaa_player_ids(year):
    """Fetch AAA roster player IDs from MLB Stats API (sport_id=11)."""
    try:
        import requests as _r
        url = f"https://statsapi.mlb.com/api/v1/teams?sportId=11&season={year}"
        teams = _r.get(url, timeout=30).json().get("teams", [])
        ids = set()
        for t in teams:
            tid = t["id"]
            rurl = (
                f"https://statsapi.mlb.com/api/v1/teams/{tid}/roster"
                f"?rosterType=fullSeason&season={year}&sportId=11"
            )
            try:
                roster = _r.get(rurl, timeout=30).json().get("roster", [])
                for p in roster:
                    ids.add(p["person"]["id"])
            except Exception:
                pass
            time.sleep(0.2)
        print(f"  ✓ AAA roster: {len(ids)} player IDs")
        return ids
    except Exception as e:
        print(f"  ⚠ Could not fetch AAA roster: {e}")
        return set()


def compute_xwoba_from_raw(year, aaa_ids, min_pa=DEFAULT_MIN_PA):
    """
    Fetch raw Savant data for the full season, keep only AAA-rostered batters,
    and compute xwOBA per batter.

    xwOBA = (sum of xwOBA contributions per PA) / PA
      - batted balls: estimated_woba_using_speedangle
      - K/BB/HBP:     woba_value (these are non-contact and not EV-adjusted)
    """
    today = date.today()
    end_year = f"{year}-10-02"
    today_str = today.strftime("%Y-%m-%d")
    eff_end = today_str if today_str < end_year else end_year

    # accumulator: {batter_id: {"xw_sum": float, "pa": int, "name": str}}
    acc = {}

    for i, (m0, m1) in enumerate(SEASON_CHUNKS):
        start = f"{year}-{m0}"
        end = f"{year}-{m1}"
        if start > eff_end:
            break
        if end > eff_end:
            end = eff_end

        print(f"  Chunk {i+1}/{len(SEASON_CHUNKS)}: {start} → {end}")
        df = fetch_raw_chunk(year, start, end)
        if df is None or len(df) == 0:
            print(f"    — No data")
            time.sleep(FETCH_DELAY)
            continue

        # Filter to PA-completing events only
        if "events" not in df.columns:
            print(f"    — Missing 'events' column")
            time.sleep(FETCH_DELAY)
            continue

        pa_rows = df[df["events"].isin(PA_EVENTS)].copy()
        if len(pa_rows) == 0:
            time.sleep(FETCH_DELAY)
            continue

        # Ensure numeric
        for col in ["batter", "estimated_woba_using_speedangle", "woba_value"]:
            if col in pa_rows.columns:
                pa_rows[col] = pd.to_numeric(pa_rows[col], errors="coerce")

        count = 0
        for _, row in pa_rows.iterrows():
            bid = row.get("batter")
            if pd.isna(bid):
                continue
            bid = int(bid)
            if aaa_ids and bid not in aaa_ids:
                continue

            events = str(row.get("events", "")).strip()
            if events in NON_CONTACT_PA_EVENTS:
                # K/BB/HBP: use actual woba_value (0 for K, ~0.69 for BB, etc.)
                xw = row.get("woba_value")
                if pd.isna(xw):
                    xw = 0.0
            else:
                # Batted ball: use expected wOBA from speed/angle
                xw = row.get("estimated_woba_using_speedangle")
                if pd.isna(xw):
                    # Fall back to actual woba_value if Savant didn't compute xwOBA
                    xw = row.get("woba_value")
                    if pd.isna(xw):
                        xw = 0.0

            if bid not in acc:
                # Try to get name from player_name or batter_name column
                name = ""
                for nc in ["player_name", "batter_name", "batter"]:
                    v = row.get(nc)
                    if v and str(v).strip() and not str(v).isdigit():
                        raw = str(v).strip()
                        # Savant uses "Last, First" in some endpoints
                        if "," in raw:
                            parts = raw.split(",", 1)
                            name = f"{parts[1].strip()} {parts[0].strip()}"
                        else:
                            name = raw
                        break
                acc[bid] = {"xw_sum": 0.0, "pa": 0, "name": name}

            acc[bid]["xw_sum"] += float(xw)
            acc[bid]["pa"] += 1
            count += 1

        print(f"    ✓ {count:,} PA rows processed")
        time.sleep(FETCH_DELAY)

    # Compute final xwOBA per player
    result = {}
    for bid, p in acc.items():
        if p["pa"] < min_pa or not p["name"]:
            continue
        xw = round(p["xw_sum"] / p["pa"], 3)
        if xw >= 0:
            result[p["name"]] = xw

    print(f"  ✓ Computed xwOBA for {len(result)} AAA batters (min {min_pa} PA)")
    return result


# ── merge into prospect_xwoba.json ────────────────────────────────────────────

def load_existing(path):
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def merge_and_save(data, new_players, year, path):
    yr = str(year)
    added = updated = 0

    for name, xw in new_players.items():
        if name not in data:
            data[name] = {}
            added += 1
        elif yr in data[name]:
            updated += 1
        else:
            added += 1
        data[name][yr] = xw

    sorted_data = dict(sorted(data.items()))
    with open(path, "w", encoding="utf-8") as f:
        json.dump(sorted_data, f, indent=2, ensure_ascii=False)

    print(f"  ✓ {added} new entries, {updated} updated → {path}")
    return sorted_data


# ── main ──────────────────────────────────────────────────────────────────────

def run(year, output_dir, min_pa, min_pitches, age_min, age_max):
    os.makedirs(output_dir, exist_ok=True)
    out_path = os.path.join(output_dir, "prospect_xwoba.json")

    print(f"\n{'='*60}")
    print(f"  AAA xwOBA fetch — {year}")
    print(f"{'='*60}")

    # 1. Try Prospect Savant first (level-adjusted, preferred)
    players = fetch_prospect_savant(year, min_pitches, age_min, age_max)

    # 2. Try Savant minor-league leaderboard
    if not players:
        print(f"\n  Prospect Savant unavailable — trying Savant leaderboard...")
        players = fetch_leaderboard(year, min_pa)

    # 3. Fall back to computing from raw Statcast data
    if not players:
        print(f"\n  Leaderboard unavailable — computing from raw Statcast data...")
        aaa_ids = get_aaa_player_ids(year)
        players = compute_xwoba_from_raw(year, aaa_ids, min_pa)

    if not players:
        print(f"  ✗ Could not fetch AAA xwOBA for {year} — skipping")
        return

    data = load_existing(out_path)
    print(f"  Existing prospect_xwoba.json: {len(data)} players")
    merge_and_save(data, players, year, out_path)


def main():
    parser = argparse.ArgumentParser(description="Fetch AAA xwOBA from Prospect Savant / Savant")
    parser.add_argument(
        "season", nargs="?", default=str(date.today().year),
        help="Comma-separated seasons (default: current year)",
    )
    parser.add_argument("--min-pa", type=int, default=DEFAULT_MIN_PA,
                        help="Min PA for Savant fallback paths")
    parser.add_argument("--min-pitches", type=int, default=DEFAULT_MIN_PITCHES,
                        help="Min pitches seen for Prospect Savant API")
    parser.add_argument("--age-min", type=int, default=DEFAULT_AGE_MIN)
    parser.add_argument("--age-max", type=int, default=DEFAULT_AGE_MAX)
    parser.add_argument("--output-dir", default="./public")
    args = parser.parse_args()

    seasons = [int(s.strip()) for s in args.season.split(",")]
    for yr in seasons:
        run(yr, args.output_dir, args.min_pa, args.min_pitches, args.age_min, args.age_max)


if __name__ == "__main__":
    main()
