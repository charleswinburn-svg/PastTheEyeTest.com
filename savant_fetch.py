#!/usr/bin/env python3
"""
savant_fetch.py — Shared Baseball Savant statcast_search CSV fetcher.

Factors out the direct-Savant pull that the working pipelines (evla_pipeline.py,
race2k_pipeline.py, league_avgs_pipeline.py, fetch_aaa_xwoba.py) already use, so
the iSwing+ and hitter-xRV inputs stop depending on pybaseball.statcast().

pybaseball.statcast() hits this same endpoint but without browser headers, so on
the droplet it comes back empty / 403 — which is why the iSwing CSV and the xRV
parquet had been frozen.  This module sends the same headers + retry/403 backoff
the other pipelines use, and chunks the request into <=2-week windows (the range
race2k_pipeline notes as safe under Savant's row cap).

The CSV returned by `…/statcast_search/csv?type=detail` is exactly what
pybaseball.statcast() downloads, so the resulting DataFrame is column-for-column
compatible with every existing consumer (iswing_update.py, fetch_statcast.py,
score_pitches.py, build_hitter_xrv.py).
"""

import time
from datetime import date, datetime, timedelta
from io import StringIO

import pandas as pd
import requests

FETCH_DELAY = 3.0
MAX_RETRIES = 3
CHUNK_DAYS = 14  # race2k_pipeline: "~2-week chunks to avoid Savant row limits"

SAVANT_BASE = "https://baseballsavant.mlb.com"

HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/csv,text/plain,application/json,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://baseballsavant.mlb.com/statcast_search",
}


def fetch_url(url, retries=MAX_RETRIES, delay=FETCH_DELAY):
    """GET a Savant URL with rate limiting, retries, and 403 backoff.

    Returns the response text, or None if every attempt failed."""
    for attempt in range(1, retries + 1):
        try:
            time.sleep(delay if attempt > 1 else 0.5)
            r = requests.get(url, headers=HTTP_HEADERS, timeout=120)
            if r.status_code == 403:
                print(f"    ⚠ 403 Forbidden (attempt {attempt}/{retries})", flush=True)
                time.sleep(delay * attempt * 2)
                continue
            r.raise_for_status()
            return r.text
        except Exception as e:
            print(f"    ⚠ Error (attempt {attempt}/{retries}): {e}", flush=True)
            if attempt < retries:
                time.sleep(delay * attempt)
    return None


def csv_to_df(text):
    """Parse Savant CSV text into a DataFrame, or None on empty / HTML / parse error."""
    if text is None or not text.strip() or "<!DOCTYPE" in str(text)[:200]:
        return None
    try:
        return pd.read_csv(StringIO(text)).dropna(how="all")
    except Exception as e:
        print(f"    ✗ CSV parse: {e}", flush=True)
        return None


def _to_date(d):
    if isinstance(d, datetime):
        return d.date()
    if isinstance(d, date):
        return d
    return datetime.strptime(str(d), "%Y-%m-%d").date()


def iter_chunks(start, end, days=CHUNK_DAYS):
    """Yield contiguous, non-overlapping (start_str, end_str) windows of <= `days`
    covering [start, end] inclusive. Savant treats game_date_gt/lt as >=/<=, so
    contiguous inclusive windows give exact coverage with no gaps or duplicates."""
    s = _to_date(start)
    e = _to_date(end)
    while s <= e:
        chunk_end = min(s + timedelta(days=days - 1), e)
        yield s.isoformat(), chunk_end.isoformat()
        s = chunk_end + timedelta(days=1)


def fetch_savant_range(season, start, end, player_type="batter", game_type="R"):
    """Fetch every statcast_search detail row for [start, end], chunked.

    Returns a single concatenated DataFrame (empty DataFrame if nothing came back).
    `player_type` is "batter" or "pitcher" (row volume is identical either way; it
    only changes which player the row is keyed to). `game_type` "R" = regular
    season, "E" = exhibition / spring training.
    """
    gt = "R%7C" if game_type == "R" else "E%7C"
    frames = []
    for c_start, c_end in iter_chunks(start, end):
        url = (
            f"{SAVANT_BASE}/statcast_search/csv?all=true&type=detail"
            f"&player_type={player_type}&hfGT={gt}&hfSea={season}%7C"
            f"&game_date_gt={c_start}&game_date_lt={c_end}"
        )
        print(f"  Savant {player_type} {c_start} → {c_end} ...", flush=True)
        df = csv_to_df(fetch_url(url))
        if df is not None and len(df):
            frames.append(df)
            print(f"    {len(df):,} rows", flush=True)
        else:
            print("    (no rows)", flush=True)
    if not frames:
        return pd.DataFrame()
    return pd.concat(frames, ignore_index=True)
