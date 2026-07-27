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
MAX_RETRIES = 5         # transient 403 / rate-limit needs a few tries under load
CHUNK_DAYS = 4          # small enough that a window rarely hits the row cap
SAVANT_ROW_CAP = 25000  # statcast_search/csv silently truncates at 25k rows/query
INTER_WINDOW_DELAY = 1.0  # pause between windows to stay under Savant's rate limiter

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


def _fetch_one(season, start, end, player_type, game_type):
    gt = "R%7C" if game_type == "R" else "E%7C"
    url = (
        f"{SAVANT_BASE}/statcast_search/csv?all=true&type=detail"
        f"&player_type={player_type}&hfGT={gt}&hfSea={season}%7C"
        f"&game_date_gt={start}&game_date_lt={end}"
    )
    return csv_to_df(fetch_url(url))


def _fetch_window(season, s, e, player_type, game_type):
    """Fetch [s, e] (date objects).

    Returns a DataFrame on success — possibly EMPTY for a genuinely game-less
    window (Savant still returns the CSV header, so csv_to_df yields an empty
    frame). Returns None if the fetch itself FAILED (HTTP error / HTML / parse
    after retries), so the caller can tell 'no games' apart from 'Savant didn't
    answer' and never treats a failed window as empty.

    Savant truncates a single query at SAVANT_ROW_CAP rows, so if we come back at
    the cap we split the window in half and recurse — no pitches silently dropped
    on busy stretches. If either half fails, the whole window fails (None) rather
    than return a partial window."""
    df = _fetch_one(season, s.isoformat(), e.isoformat(), player_type, game_type)
    if df is None:
        return None                       # fetch/parse failed — propagate the failure
    if len(df) >= SAVANT_ROW_CAP and s < e:
        mid = s + (e - s) // 2
        print(f"    ↳ {s}→{e} hit the {SAVANT_ROW_CAP:,}-row cap; splitting", flush=True)
        left = _fetch_window(season, s, mid, player_type, game_type)
        right = _fetch_window(season, mid + timedelta(days=1), e, player_type, game_type)
        if left is None or right is None:
            return None                   # a half failed — don't return a partial window
        return pd.concat([left, right], ignore_index=True)
    if len(df) >= SAVANT_ROW_CAP:  # single day already at the cap — can't split further
        print(f"    ⚠ {s} alone returned {len(df):,} rows (at cap) — may be truncated", flush=True)
    return df


def fetch_savant_range(season, start, end, player_type="batter", game_type="R"):
    """Fetch every statcast_search detail row for [start, end], chunked.

    Windows that hit Savant's 25k-row cap are split and refetched, so the result
    is complete even mid-season. `end` is clamped to today (no future data exists,
    and it avoids a long tail of empty requests on an in-season run).

    Returns one concatenated, de-duplicated DataFrame (empty if nothing came back).
    `player_type` is "batter" or "pitcher" (same row set either way; it only
    changes the keyed player). `game_type` "R" = regular season, "E" = spring.
    """
    end_d = min(_to_date(end), date.today())
    frames = []
    failed = []
    for c_start, c_end in iter_chunks(start, end_d):
        print(f"  Savant {player_type} {c_start} → {c_end} ...", flush=True)
        df = _fetch_window(season, _to_date(c_start), _to_date(c_end), player_type, game_type)
        if df is None:                      # fetch failed (not merely empty)
            print("    ✗ fetch failed — will retry", flush=True)
            failed.append((c_start, c_end))
        elif len(df):
            frames.append(df)
            print(f"    {len(df):,} rows", flush=True)
        else:
            print("    (no games)", flush=True)
        time.sleep(INTER_WINDOW_DELAY)

    # Second pass: retry the windows that FAILED (transient 403 / timeout), with
    # extra backoff. Genuinely game-less windows returned an empty frame above, so
    # they're not retried. Anything still failing raises — we never hand back a
    # silently-partial season.
    if failed:
        print(f"  Retrying {len(failed)} failed window(s) …", flush=True)
        still_failed = []
        for c_start, c_end in failed:
            time.sleep(FETCH_DELAY * 2)
            df = _fetch_window(season, _to_date(c_start), _to_date(c_end), player_type, game_type)
            if df is None:
                still_failed.append((c_start, c_end))
            elif len(df):
                frames.append(df)
                print(f"    ✓ {c_start}→{c_end}: {len(df):,} rows on retry", flush=True)
        if still_failed:
            raise RuntimeError(
                f"Savant fetch incomplete: {len(still_failed)} window(s) failed after retries "
                f"({', '.join(f'{a}→{b}' for a, b in still_failed)}). Aborting so a partial "
                "season is not written."
            )

    if not frames:
        return pd.DataFrame()
    out = pd.concat(frames, ignore_index=True)
    # Safety net: a unique pitch is (game_pk, at_bat_number, pitch_number); drop
    # any exact dupes in case a split landed on a boundary.
    keys = [c for c in ("game_pk", "at_bat_number", "pitch_number") if c in out.columns]
    if len(keys) == 3:
        out = out.drop_duplicates(subset=keys).reset_index(drop=True)
    n_games = out["game_pk"].nunique() if "game_pk" in out.columns else 0
    n_dates = out["game_date"].nunique() if "game_date" in out.columns else 0
    print(f"  Savant {player_type} complete: {len(out):,} pitches / {n_games:,} games / {n_dates} dates",
          flush=True)
    return out
