#!/usr/bin/env python3
"""
AAA pipeline — pulls Triple-A hitter and pitcher data from Savant's minor
league endpoints and writes public/aaa_data_<year>.json in the same shape
as baseball_data_<year>.json so the React card components can swap data
sources via a level dropdown.

Imported and invoked from baseball_pipeline.py; not a standalone script.

Metric set differences from MLB:
  HITTERS — no iSwing+, no bat-tracking metrics (Avg Bat Speed, Fast
    Swing %, Avg Swing Length), no Blasts/Contact, no LA+SwtSpt%.
    LD% (line drive rate) replaces those, computed from Savant
    batted-ball events (bb_type == "line_drive" / BBE).
  PITCHERS — same metric set as MLB. Avg FB Velo aggregates 4-Seam (FF)
    if available, else Sinker (SI), else Cutter (FC).

Percentiles are computed within the AAA pool only — a player's AAA bubble
is independent from their MLB bubble.

The Savant URLs / column names here are educated guesses based on the
public minor-league leaderboards. Each fetch logs the column list it
got back so any name drift can be aliased without source changes.
"""
from __future__ import annotations

import json
import os
import time
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

# These imports come from baseball_pipeline at runtime; we accept them as
# arguments to keep this module dependency-light.


# ────────────────────────────────────────────────────────────────────────────
# METRIC DEFINITIONS
# ────────────────────────────────────────────────────────────────────────────

AAA_HITTER_METRICS = [
    {"key": "xslg",              "label": "xSLG",                "lower_better": False, "fmt": ".3f"},
    {"key": "xwoba",             "label": "xwOBA",               "lower_better": False, "fmt": ".3f"},
    {"key": "exit_velocity_avg", "label": "Avg Exit Velocity",   "lower_better": False, "fmt": ".1f"},
    {"key": "ev_90p",            "label": "90th % EV",           "lower_better": False, "fmt": ".1f"},
    {"key": "barrel_batted_rate","label": "Barrel %",            "lower_better": False, "fmt": ".1f"},
    {"key": "ld_pct",            "label": "LD%",                 "lower_better": False, "fmt": ".1f"},
    {"key": "oz_swing_percent",  "label": "Chase %",             "lower_better": True,  "fmt": ".1f"},
    {"key": "k_percent",         "label": "K%",                  "lower_better": True,  "fmt": ".1f"},
    {"key": "iz_contact_percent","label": "Z-Contact%",          "lower_better": False, "fmt": ".1f"},
    {"key": "whiff_percent",     "label": "Whiff %",             "lower_better": True,  "fmt": ".1f"},
    {"key": "bb_percent",        "label": "BB%",                 "lower_better": False, "fmt": ".1f"},
]

# AAA pitcher metric set — FIP comes from FG MiLB. Avg Velo replaces Avg FB
# Velo since Prospect Savant doesn't expose per-pitch-type velo. GB% isn't
# in the payload either, so it's dropped.
AAA_PITCHER_METRICS_LABELS = [
    "FIP", "Avg Velo", "Avg Exit Velo", "Barrel%", "xBA", "xSLG", "xwOBA",
    "Whiff%", "K%", "Chase%", "BB%", "K-BB%",
]


# ────────────────────────────────────────────────────────────────────────────
# PROSPECT SAVANT JSON API
# ────────────────────────────────────────────────────────────────────────────
# Public endpoint behind prospectsavant.com — no auth needed. Pattern:
#   /leaders/{hitters|pitchers}/{level}/{year}/{min_pitches}/{age_min}/{age_max}
# Returns a JSON list of rows, one per qualified player at the level.
import json as _json
import requests as _requests

PROSPECT_SAVANT_API = "https://oriolebird.pythonanywhere.com"
PROSPECT_MIN_PITCHES = 1   # pull everyone — we filter for usable rates downstream
PROSPECT_AGE_MIN = 18
PROSPECT_AGE_MAX = 45


def _fetch_prospect_savant(player_kind, year, level="AAA"):
    """Returns a DataFrame of rows from Prospect Savant (or None)."""
    url = (f"{PROSPECT_SAVANT_API}/leaders/{player_kind}/{level}/"
           f"{year}/{PROSPECT_MIN_PITCHES}/{PROSPECT_AGE_MIN}/{PROSPECT_AGE_MAX}")
    print(f"  Fetching Prospect Savant ({player_kind}, {level} {year})...")
    try:
        r = _requests.get(url, timeout=60)
        r.raise_for_status()
    except Exception as e:
        print(f"    ⚠ HTTP error: {e}")
        return None
    try:
        data = r.json()
    except Exception as e:
        print(f"    ⚠ JSON parse error: {e}; first 200 chars: {r.text[:200]!r}")
        return None
    rows = data if isinstance(data, list) else (
        data.get("data") or data.get("leaders") or data.get("hitters") or
        data.get("pitchers") or data.get("players") or data.get("rows") or []
    )
    if not rows:
        print(f"    ⚠ empty rows in response (top-level keys: "
              f"{list(data.keys()) if isinstance(data, dict) else type(data).__name__})")
        return None
    df = pd.DataFrame(rows)
    print(f"    ✓ {len(df)} rows; total columns: {len(df.columns)}")
    print(f"    ALL columns: {sorted(df.columns)}")

    # Canonical id / name
    for c in ("player_id", "id", "mlbam_id", "MLBAMID", "playerid"):
        if c in df.columns:
            df["player_id"] = pd.to_numeric(df[c], errors="coerce").astype("Int64")
            break
    if "player_name" not in df.columns:
        for c in ("name", "Name", "full_name", "player"):
            if c in df.columns:
                df["player_name"] = df[c].astype(str)
                break
    return df


# ── Hitters / pitchers each get one fetch; we extract the metrics we need
# from the returned columns. Names below are best-guesses based on the
# Prospect Savant payload — _safe column lookups handle drift.

def _coerce_cols(df, mapping):
    """Rename / coerce columns. `mapping` is canonical -> list of candidate
    column names. First match wins."""
    if df is None:
        return df
    out = df.copy()
    for canon, cands in mapping.items():
        if canon in out.columns:
            continue
        for c in cands:
            if c in out.columns:
                out[canon] = pd.to_numeric(out[c], errors="coerce") if canon != "player_name" else out[c]
                break
    return out


# Prospect Savant ships rates as percentages already (e.g. krate=25.4),
# so no *100 needed. Field names below are the literal columns from the
# 2026 Prospect Savant JSON payload.
HITTER_FIELD_MAP = {
    "xslg":               ["xslg"],
    "xwoba":              ["xwoba"],
    "exit_velocity_avg":  ["ev"],
    "ev_90p":             ["ev90"],
    "barrel_batted_rate": ["barrelbbe"],   # barrels per BBE
    "oz_swing_percent":   ["chaserate"],
    "k_percent":          ["krate"],
    "iz_contact_percent": ["zcontact"],
    "whiff_percent":      ["whiffrate"],
    "bb_percent":         ["bbrate"],
    "pa":                 ["pa"],
    "player_name":        ["player_name", "name", "MLB_FullName"],
}

PITCHER_FIELD_MAP = {
    "avg_velo":           ["velocity"],     # overall avg pitch velo (no per-type breakdown)
    "exit_velocity_avg":  ["ev"],
    "barrel_batted_rate": ["barrelbbe"],
    "xba":                ["xba"],
    "xslg":               ["xslg"],
    "xwoba":              ["xwoba"],
    "whiff_percent":      ["whiffrate"],
    "k_percent":          ["krate"],
    "p_oSwing_percent":   ["chaserate"],
    "bb_percent":         ["bbrate"],
    "k_bb_percent":       ["kbb_rate"],
    "player_name":        ["player_name", "name", "MLB_FullName"],
}


def fetch_aaa_hitters(year, fetch_url, csv_to_df):
    df = _fetch_prospect_savant("hitters", year)
    return _coerce_cols(df, HITTER_FIELD_MAP)


def fetch_aaa_pitchers(year, fetch_url, csv_to_df):
    df = _fetch_prospect_savant("pitchers", year)
    return _coerce_cols(df, PITCHER_FIELD_MAP)


def fetch_aaa_pitch_movement(year, fetch_url, csv_to_df, pitch_type="FF"):
    """No-op — overall pitch velocity comes from Prospect Savant."""
    return None


# ────────────────────────────────────────────────────────────────────────────
# FANGRAPHS MiLB FETCHERS  (cookie-jar path; reuses fangraphs_cookies.txt)
# ────────────────────────────────────────────────────────────────────────────

def _fg_milb_session():
    """Return an authenticated requests.Session for FG MiLB, or None."""
    cookie_paths = [
        "fangraphs_cookies.txt",
        os.path.join(os.path.dirname(__file__), "fangraphs_cookies.txt"),
        os.path.expanduser("~/project/fangraphs_cookies.txt"),
        "www.fangraphs.com_cookies.txt",
    ]
    cp = next((p for p in cookie_paths if os.path.exists(p)), None)
    if not cp:
        print("    ⚠ No FG cookies file found")
        return None
    try:
        from http.cookiejar import MozillaCookieJar
        jar = MozillaCookieJar(cp)
        jar.load(ignore_discard=True, ignore_expires=True)
        s = _requests.Session()
        s.cookies = jar
        s.headers.update({"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) "
                                          "AppleWebKit/537.36 (KHTML, like Gecko) "
                                          "Chrome/120.0.0.0 Safari/537.36"})
        return s
    except Exception as e:
        print(f"    ⚠ FG cookie load failed: {e}")
        return None


def _fg_milb_try(session, paths_and_lgs, stats, type_, year, label):
    """Deprecated chain-based JSON fetcher — kept for ref, but FG MiLB
    renders server-side, so we scrape HTML in fetch_fg_milb_* below."""
    return None, None


def _fg_milb_html_to_rows(html, expected_col):
    """Best-effort parse of an FG MiLB leaderboard HTML page. Returns a
    list of dicts. Two strategies:
      1. Next.js __NEXT_DATA__ script tag (modern FG pages embed the full
         row payload as JSON there).
      2. Fall back to <table> scraping with BeautifulSoup.
    """
    if not html:
        return None
    # Strategy 1: Next.js JSON blob
    import re as _re
    m = _re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, _re.S)
    if m:
        try:
            blob = _json.loads(m.group(1))
            # Walk to find any list whose first element has the expected column
            def _walk(obj):
                if isinstance(obj, list) and obj and isinstance(obj[0], dict):
                    if expected_col in obj[0] or any(expected_col in k for k in obj[0].keys()):
                        return obj
                    for item in obj:
                        r = _walk(item)
                        if r: return r
                elif isinstance(obj, dict):
                    for v in obj.values():
                        r = _walk(v)
                        if r: return r
                return None
            rows = _walk(blob)
            if rows:
                print(f"    ✓ parsed {len(rows)} rows from __NEXT_DATA__")
                return rows
        except Exception as e:
            print(f"    __NEXT_DATA__ parse failed: {e}")

    # Strategy 2: HTML table
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        print("    ⚠ BeautifulSoup not available")
        return None
    soup = BeautifulSoup(html, "html.parser")
    # FG legacy page wraps the leaderboard in a <table class="rgMasterTable">.
    # Find the largest table on the page if specific id isn't present.
    table = soup.find("table", {"class": "rgMasterTable"}) or soup.find("table")
    if not table:
        print("    ⚠ no <table> found in HTML")
        return None
    # Header row: prefer the first <tr> with <th> cells
    header_tr = None
    for tr in table.find_all("tr"):
        if tr.find_all("th"):
            header_tr = tr
            break
    if not header_tr:
        print("    ⚠ no header <tr> with <th> cells")
        return None
    headers = [th.get_text(strip=True) for th in header_tr.find_all("th")]
    out = []
    for tr in table.find_all("tr"):
        cells = tr.find_all("td")
        if not cells:
            continue
        row = {}
        for i, td in enumerate(cells):
            h = headers[i] if i < len(headers) else f"col_{i}"
            row[h] = td.get_text(strip=True)
            a = td.find("a", href=True)
            if a:
                pid_match = _re.search(r"playerid=(\d+)", a["href"])
                if pid_match:
                    row["_fg_playerid"] = pid_match.group(1)
                mlb_match = _re.search(r"mlbamid=(\d+)", a["href"])
                if mlb_match:
                    row["xMLBAMID"] = mlb_match.group(1)
        # Only keep rows that look like real player rows (have a Name column)
        if any(row.get(k) for k in ("Name", "Player", "PlayerName")):
            out.append(row)
    print(f"    ✓ parsed {len(out)} rows from HTML <table>")
    return out


def _fg_milb_scrape(session, year, stats, type_, lg="14,11"):
    """Hit the FG MiLB leaderboard. Modern /leaders/minor-league is JS-
    rendered (no <table> in initial HTML), so prefer the legacy aspx page
    that ships a server-rendered table. Falls back to the modern URL."""
    candidates = [
        # Legacy server-rendered table — what we actually want to scrape
        ("https://www.fangraphs.com/leaders-legacy.aspx"
         f"?pos=all&stats={stats}&lg={lg}&qual=0&type={type_}&season={year}"
         f"&month=0&season1={year}&ind=0&team=0,ts&rost=0&age=0&filter=&players=0&page=1_4000"),
        # Modern Next.js page (mostly empty before hydration; kept for completeness)
        ("https://www.fangraphs.com/leaders/minor-league"
         f"?type={type_}&lg={lg}&stats={stats}&season={year}"
         f"&qual=0&pageitems=4000"),
    ]
    for url in candidates:
        print(f"    GET {url}")
        try:
            r = session.get(url, timeout=45)
        except Exception as e:
            print(f"    ⚠ HTTP error: {e}")
            continue
        if r.status_code != 200:
            print(f"    ⚠ HTTP {r.status_code}")
            continue
        # Heuristic: legacy page returns 100KB+ with <table> markup; if the
        # response is small (<10KB), it's the empty Next.js shell.
        if "<table" not in r.text.lower():
            print(f"    ⚠ no <table> in response ({len(r.text)} chars)")
            continue
        return r.text
    return None


def _fg_milb_json(session, year, stats, type_, lg="14,11"):
    """Try the FG /api/leaders/minor-league/data JSON endpoint (mirrors the
    working MLB call). Returns parsed DF or None."""
    url = ("https://www.fangraphs.com/api/leaders/minor-league/data"
           f"?pos=all&stats={stats}&lg={lg}&qual=0&type={type_}"
           f"&season={year}&month=0&season1={year}&ind=0"
           f"&team=0&rost=0&age=0&filter=&players=0"
           f"&startdate=&enddate=&pageitems=4000&page=1")
    print(f"    JSON GET {url}")
    try:
        r = session.get(url, timeout=30)
    except Exception as e:
        print(f"    JSON ⚠ HTTP error: {e}")
        return None
    if r.status_code != 200:
        print(f"    JSON ⚠ HTTP {r.status_code}")
        return None
    try:
        rows = r.json().get("data", [])
    except Exception as e:
        print(f"    JSON ⚠ parse: {e}; first 200: {r.text[:200]!r}")
        return None
    if not rows:
        print("    JSON ⚠ 0 rows")
        return None
    df = pd.DataFrame(rows)
    print(f"    JSON ✓ {len(df)} rows; cols: {list(df.columns)[:25]}")
    return df


def _fg_milb_html(session, year, stats, type_, lg="14,11"):
    """HTML fallback — scrape the legacy aspx page (server-rendered table).
    Paginate until empty so all qualifying players are returned (the page
    default is 30 rows)."""
    all_rows = []
    seen_keys = set()
    page = 1
    while page < 50:  # hard cap
        base = ("https://www.fangraphs.com/leaders-legacy.aspx"
                f"?pos=all&stats={stats}&lg={lg}&qual=0&type={type_}&season={year}"
                f"&month=0&season1={year}&ind=0&team=0&rost=0&age=0&filter=&players=0"
                f"&page={page}_50")
        print(f"    HTML GET {base}")
        try:
            r = session.get(base, timeout=45)
        except Exception as e:
            print(f"    HTML ⚠ {e}")
            break
        if r.status_code != 200:
            print(f"    HTML ⚠ HTTP {r.status_code}")
            break
        body = r.text
        if "<table" not in body.lower():
            print(f"    HTML ⚠ no <table> ({len(body)} chars). First 300: {body[:300]!r}")
            break
        rows = _fg_milb_html_to_rows(body, expected_col=None)
        if not rows:
            print(f"    HTML page {page}: 0 rows — end of pagination")
            break
        # De-dup by (Name, _fg_playerid) — FG repeats the last page if the
        # requested page is past the end.
        new = []
        for r_ in rows:
            key = (r_.get("Name"), r_.get("_fg_playerid"))
            if key in seen_keys:
                continue
            seen_keys.add(key)
            new.append(r_)
        if not new:
            print(f"    HTML page {page}: all duplicates — end of pagination")
            break
        all_rows.extend(new)
        print(f"    HTML page {page}: +{len(new)} (total {len(all_rows)})")
        if len(new) < 30:
            break
        page += 1

    if not all_rows:
        return None
    df = pd.DataFrame(all_rows)
    print(f"    HTML ✓ {len(df)} rows total; cols: {list(df.columns)[:25]}")
    return df


# Name → MLBAMId map built from Prospect Savant (the only source where AAA
# players have their MLBAMId attached). FG legacy table only has FG playerid
# in the link, so we merge FG rows back onto Prospect Savant by name.
_NAME_TO_MLBAMID_CACHE = {}


def _norm_name(s):
    """Lowercase, strip diacritics/punctuation, flip 'Last, First' → 'First Last',
    drop common suffixes. Used as the join key when matching FG rows back to
    Prospect Savant MLBAMIds by name."""
    if not isinstance(s, str):
        return ""
    import unicodedata as _u
    s = _u.normalize("NFD", s)
    s = "".join(c for c in s if not _u.combining(c))
    s = s.strip()
    # "Doe, John" → "John Doe"
    if "," in s:
        parts = [p.strip() for p in s.split(",", 1)]
        if len(parts) == 2 and parts[0] and parts[1]:
            s = f"{parts[1]} {parts[0]}"
    s = s.lower().replace(".", "").replace(",", "").replace("'", "").replace("-", " ")
    for suf in (" jr", " sr", " ii", " iii", " iv"):
        if s.endswith(suf):
            s = s[: -len(suf)]
    return " ".join(s.split())


def _build_name_to_mlbamid(prospect_savant_df):
    """Build name → MLBAMId map from a Prospect Savant DataFrame.
    Prefers `name` / `player_name` (the player) over `MLB_*` columns
    (those are the player's *team*, not the player)."""
    if prospect_savant_df is None or prospect_savant_df.empty:
        return {}
    out = {}
    samples_logged = 0
    for _, r in prospect_savant_df.iterrows():
        raw_name = (r.get("name") or r.get("player_name") or
                    r.get("name_age") or "")
        if not raw_name:
            continue
        # name_age is "Last, First (Age)" — strip parenthetical
        if "(" in str(raw_name):
            raw_name = str(raw_name).split("(")[0].strip()
        mlbamid = r.get("MLBAMId") or r.get("MLBAMID") or r.get("mlbam_id")
        # Fall back to player_id only if it's clearly an MLBAMID (6-digit int)
        if (mlbamid is None or pd.isna(mlbamid)) and r.get("player_id"):
            mlbamid = r.get("player_id")
        if mlbamid is None or pd.isna(mlbamid):
            continue
        try:
            mlbamid = int(mlbamid)
        except (TypeError, ValueError):
            continue
        norm = _norm_name(str(raw_name))
        if not norm:
            continue
        out[norm] = mlbamid
        if samples_logged < 3:
            print(f"    name-map sample: {raw_name!r} → {norm!r} → {mlbamid}")
            samples_logged += 1
    print(f"    name-map built: {len(out)} unique names from {len(prospect_savant_df)} rows")
    return out


def _fg_milb_fetch(session, year, stats, type_, lg="14,11"):
    """Try JSON API first, then fall back to the legacy HTML page."""
    df = _fg_milb_json(session, year, stats, type_, lg)
    if df is None or df.empty:
        df = _fg_milb_html(session, year, stats, type_, lg)
    return df


def _norm_fg_player_id(df):
    if df is None or df.empty:
        return df
    for c in ("xMLBAMID", "MLBAMID", "playerid"):
        if c in df.columns:
            df["player_id"] = pd.to_numeric(df[c], errors="coerce").astype("Int64")
            break
    return df


def _attach_player_id(df, name_to_mlbamid):
    """Add a player_id column to df using either xMLBAMID directly or by
    name-matching against the Prospect Savant map."""
    if df is None or df.empty:
        return df
    df = df.copy()
    if "xMLBAMID" in df.columns:
        df["player_id"] = pd.to_numeric(df["xMLBAMID"], errors="coerce").astype("Int64")
    if "player_id" not in df.columns or df["player_id"].isna().all():
        if name_to_mlbamid:
            name_col = next((c for c in ("Name", "Player", "PlayerName", "player_name") if c in df.columns), None)
            if name_col:
                # Log a few FG names + their normalized forms so any
                # remaining mismatch is debuggable.
                for raw in df[name_col].dropna().head(3).tolist():
                    norm = _norm_name(str(raw))
                    hit = name_to_mlbamid.get(norm)
                    print(f"    fg-name sample: {raw!r} → {norm!r} → "
                          f"{'MATCH ' + str(hit) if hit else 'no match'}")
                df["player_id"] = df[name_col].map(
                    lambda s: name_to_mlbamid.get(_norm_name(str(s)))
                ).astype("Int64")
                hits = df["player_id"].notna().sum()
                print(f"    name-matched {hits}/{len(df)} rows to Prospect Savant MLBAMId")
    return df


def fetch_fg_milb_batting_ld(year, name_to_mlbamid=None):
    """FG MiLB advanced batting → LD%. Name-matches FG rows back to
    Prospect Savant MLBAMIds when FG doesn't expose them directly."""
    s = _fg_milb_session()
    if s is None:
        return None
    print(f"  Fetching FanGraphs MiLB batting LD% ({year})...")
    df = _fg_milb_fetch(s, year, stats="bat", type_=2)
    df = _attach_player_id(df, name_to_mlbamid)
    if df is None or "player_id" not in df.columns or df["player_id"].isna().all():
        print("    ⚠ couldn't attach player_id to any FG row")
        return None
    ld_col = next((c for c in ("LD%", "LDpct", "LD", "ld_pct") if c in df.columns), None)
    if ld_col is None:
        print(f"    ⚠ no LD% column; cols: {list(df.columns)[:40]}")
        return None
    df["ld_pct"] = pd.to_numeric(df[ld_col].astype(str).str.rstrip("%"),
                                  errors="coerce")
    out = df[["player_id", "ld_pct"]].dropna(subset=["player_id"])
    print(f"    ✓ LD% for {len(out)} AAA hitters")
    return out


def fetch_fg_milb_pitching_fip(year, name_to_mlbamid=None):
    """FG MiLB pitching → FIP."""
    s = _fg_milb_session()
    if s is None:
        return None
    print(f"  Fetching FanGraphs MiLB pitching FIP ({year})...")
    df = _fg_milb_fetch(s, year, stats="pit", type_=1)
    df = _attach_player_id(df, name_to_mlbamid)
    if df is None or "player_id" not in df.columns or df["player_id"].isna().all():
        print("    ⚠ couldn't attach player_id to any FG row")
        return None
    if "FIP" not in df.columns:
        print(f"    ⚠ no FIP column; cols: {list(df.columns)[:40]}")
        return None
    df["fip"] = pd.to_numeric(df["FIP"], errors="coerce")
    out = df[["player_id", "fip"]].dropna(subset=["player_id"])
    print(f"    ✓ FIP for {len(out)} AAA pitchers")
    return out


# ────────────────────────────────────────────────────────────────────────────
# DERIVATIONS
# ────────────────────────────────────────────────────────────────────────────

def compute_ev90_and_ld_pct(bip_df):
    """Group AAA batted-ball events by batter; return ev_90p and ld_pct."""
    if bip_df is None or bip_df.empty:
        return None
    bid_col = "batter" if "batter" in bip_df.columns else (
        "batter_id" if "batter_id" in bip_df.columns else None)
    if bid_col is None:
        return None
    bip_df = bip_df.copy()
    bip_df[bid_col] = pd.to_numeric(bip_df[bid_col], errors="coerce").astype("Int64")
    if "launch_speed" in bip_df.columns:
        bip_df["launch_speed"] = pd.to_numeric(bip_df["launch_speed"], errors="coerce")

    out_rows = []
    for pid, grp in bip_df.dropna(subset=[bid_col]).groupby(bid_col):
        evs = grp.get("launch_speed", pd.Series()).dropna()
        bbe = len(grp)
        ld_n = int((grp.get("bb_type", pd.Series()) == "line_drive").sum())
        out_rows.append({
            "player_id": int(pid),
            "ev_90p": float(evs.quantile(0.9)) if len(evs) else None,
            "ld_pct": (ld_n / bbe * 100) if bbe else None,
            "_bbe": bbe,
        })
    df = pd.DataFrame(out_rows)
    print(f"    Derived ev_90p and ld_pct for {len(df)} AAA batters")
    return df


def aggregate_fb_velo(year, fetch_url, csv_to_df):
    """Per-pitcher FB velo with fallback FF → SI → FC."""
    out = {}
    for pt in ("FF", "SI", "FC"):
        df = fetch_aaa_pitch_movement(year, fetch_url, csv_to_df, pt)
        if df is None or df.empty:
            continue
        # Find pitcher_id and velo columns
        pid_col = next((c for c in ("pitcher_id", "player_id", "id") if c in df.columns), None)
        velo_col = "avg_speed" if "avg_speed" in df.columns else (
            "release_speed" if "release_speed" in df.columns else None)
        if pid_col is None or velo_col is None:
            print(f"    ⚠ {pt}: missing id/velo cols (have: {list(df.columns)[:14]})")
            continue
        for _, r in df.iterrows():
            pid = pd.to_numeric(r[pid_col], errors="coerce")
            v = pd.to_numeric(r[velo_col], errors="coerce")
            if pd.isna(pid) or pd.isna(v):
                continue
            pid = int(pid)
            if pid not in out:  # FF wins, then SI, then FC
                out[pid] = float(v)
    print(f"  AAA FB velo (FF→SI→FC fallback): {len(out)} pitchers")
    return out


# ────────────────────────────────────────────────────────────────────────────
# AGGREGATION + PERCENTILES
# ────────────────────────────────────────────────────────────────────────────

def _percentile(pool, value, lower_better):
    if value is None or pool is None or len(pool) == 0:
        return None
    p = [v for v in pool if v is not None and not (isinstance(v, float) and np.isnan(v))]
    if not p:
        return None
    rank = sum(1 for v in p if v < value) + 0.5 * sum(1 for v in p if v == value)
    pct = rank / len(p)
    if lower_better:
        pct = 1.0 - pct
    return int(round(pct * 100))


def _fmt(value, fmt):
    if value is None or (isinstance(value, float) and not np.isfinite(value)):
        return "—"
    try:
        return f"{value:{fmt}}"
    except Exception:
        return str(value)


def build_aaa(year, fetch_url, csv_to_df, http_headers, team_map=None):
    """End-to-end AAA pipeline; returns the JSON-serializable dict."""
    print(f"\n  ─── AAA pipeline ({year}) ───")

    # 1. Hitters — Prospect Savant JSON API
    hitters_df = fetch_aaa_hitters(year, fetch_url, csv_to_df)

    # 2. Pitchers — Prospect Savant JSON API
    pitchers_df = fetch_aaa_pitchers(year, fetch_url, csv_to_df)

    # Build a name → MLBAMId map from Prospect Savant for FG name-matching.
    name_to_mlbamid = {}
    name_to_mlbamid.update(_build_name_to_mlbamid(hitters_df))
    name_to_mlbamid.update(_build_name_to_mlbamid(pitchers_df))

    # 1b. LD% from FanGraphs MiLB batting (cookie-jar auth, name-matched)
    fg_ld = fetch_fg_milb_batting_ld(year, name_to_mlbamid=name_to_mlbamid)
    if fg_ld is not None and hitters_df is not None and "player_id" in hitters_df.columns:
        hitters_df = hitters_df.merge(fg_ld, on="player_id", how="left", suffixes=("", "_fg"))
        if "ld_pct_fg" in hitters_df.columns:
            hitters_df["ld_pct"] = hitters_df["ld_pct_fg"].combine_first(hitters_df.get("ld_pct"))
            hitters_df = hitters_df.drop(columns=["ld_pct_fg"])

    # 2b. FIP from FanGraphs MiLB pitching
    fg_fip = fetch_fg_milb_pitching_fip(year, name_to_mlbamid=name_to_mlbamid)
    if fg_fip is not None and pitchers_df is not None and "player_id" in pitchers_df.columns:
        pitchers_df = pitchers_df.merge(fg_fip, on="player_id", how="left")

    if pitchers_df is None:
        pass
    elif "avg_fb_velo" in pitchers_df.columns:
        print(f"  Avg FB Velo (from Prospect Savant): "
              f"{pitchers_df['avg_fb_velo'].notna().sum()} pitchers")
    else:
        print("  Avg FB Velo not in Prospect Savant payload — bubble will be blank")
    fb_velo = {}  # legacy hook, no longer used

    # 3. Build hitter percentiles
    hitter_rows = []
    if hitters_df is not None and not hitters_df.empty:
        pools = {}
        for m in AAA_HITTER_METRICS:
            k = m["key"]
            if k in hitters_df.columns:
                hitters_df[k] = pd.to_numeric(hitters_df[k], errors="coerce")
                pools[k] = hitters_df[k].dropna().tolist()
            else:
                pools[k] = []
        for _, r in hitters_df.iterrows():
            cats = {}
            for m in AAA_HITTER_METRICS:
                v = r.get(m["key"])
                v = float(v) if pd.notna(v) else None
                cats[m["label"]] = {
                    "pctile": _percentile(pools.get(m["key"], []), v, m["lower_better"]),
                    "value":  round(v, 4) if v is not None else None,
                    "display": _fmt(v, m["fmt"]),
                }
            pid = r.get("player_id")
            pid = int(pid) if pd.notna(pid) else None
            name = r.get("player_name") or r.get("name") or r.get("last_name, first_name") or ""
            if "," in str(name):
                parts = [p.strip() for p in str(name).split(",", 1)]
                if len(parts) == 2 and parts[0] and parts[1]:
                    name = f"{parts[1]} {parts[0]}"
            # Prospect Savant carries the player's MLB parent org in
            # MLB_AbbName / MLB_FullName. team_info (when present) is a dict
            # with the AAA affiliate.
            parent_abbr = r.get("MLB_AbbName") if "MLB_AbbName" in r else None
            parent_name = r.get("MLB_FullName") if "MLB_FullName" in r else None
            aaa_team_info = r.get("team_info") if "team_info" in r else None
            aaa_team_name = None
            aaa_team_id = None
            if isinstance(aaa_team_info, dict):
                aaa_team_name = aaa_team_info.get("abbreviation") or aaa_team_info.get("name")
                aaa_team_id = aaa_team_info.get("id")
            hitter_rows.append({
                "name": str(name),
                "player_id": pid,
                # Keep MLB parent abbr as `team` so the React header lookups
                # (logo + color) hit known MLB values until we ship an AAA
                # team color table.
                "team": str(parent_abbr) if isinstance(parent_abbr, str) else (team_map or {}).get(pid),
                "aaa_team": str(aaa_team_name) if isinstance(aaa_team_name, str) else None,
                "aaa_team_id": int(aaa_team_id) if aaa_team_id else None,
                "parent_org_abbr": str(parent_abbr) if isinstance(parent_abbr, str) else None,
                "parent_org_name": str(parent_name) if isinstance(parent_name, str) else None,
                "pa": int(r["pa"]) if "pa" in r and pd.notna(r.get("pa")) else None,
                "categories": cats,
            })

    # 4. Build pitcher percentiles (mirror MLB metric set; values come from
    # AAA pools so percentile rank is within AAA only)
    pitcher_rows = []
    # Map AAA pitcher label → canonical column key (already renamed by
    # _coerce_cols from Prospect Savant field names).
    p_label_to_col = {
        "FIP":           "fip",
        "Avg Velo":      "avg_velo",
        "Avg Exit Velo": "exit_velocity_avg",
        "Barrel%":       "barrel_batted_rate",
        "xBA":           "xba",
        "xSLG":          "xslg",
        "xwOBA":         "xwoba",
        "Whiff%":        "whiff_percent",
        "K%":            "k_percent",
        "Chase%":        "p_oSwing_percent",
        "BB%":           "bb_percent",
        "K-BB%":         "k_bb_percent",
    }
    if pitchers_df is not None and not pitchers_df.empty:
        # lower_better mirrors MLB conventions
        p_lower = {"FIP", "Avg Exit Velo", "Barrel%", "xBA", "xSLG", "xwOBA", "BB%"}

        pools = {}
        for label, col in p_label_to_col.items():
            if col and col in pitchers_df.columns:
                pitchers_df[col] = pd.to_numeric(pitchers_df[col], errors="coerce")
                pools[label] = pitchers_df[col].dropna().tolist()
            else:
                pools[label] = []
        for _, r in pitchers_df.iterrows():
            cats = {}
            for label in AAA_PITCHER_METRICS_LABELS:
                col = p_label_to_col.get(label)
                v = pd.to_numeric(r.get(col), errors="coerce") if col else None
                v = float(v) if v is not None and pd.notna(v) else None
                fmt = ".2f" if label == "FIP" else (".3f" if label in {"xBA", "xSLG", "xwOBA"} else ".1f")
                cats[label] = {
                    "pctile": _percentile(pools.get(label, []), v, label in p_lower),
                    "value":  round(v, 4) if v is not None else None,
                    "display": _fmt(v, fmt),
                }
            pid = r.get("player_id")
            pid = int(pid) if pd.notna(pid) else None
            name = r.get("player_name") or r.get("name") or r.get("last_name, first_name") or ""
            if "," in str(name):
                parts = [p.strip() for p in str(name).split(",", 1)]
                if len(parts) == 2 and parts[0] and parts[1]:
                    name = f"{parts[1]} {parts[0]}"
            parent_abbr = r.get("MLB_AbbName") if "MLB_AbbName" in r else None
            parent_name = r.get("MLB_FullName") if "MLB_FullName" in r else None
            aaa_team_info = r.get("team_info") if "team_info" in r else None
            aaa_team_name = None
            aaa_team_id = None
            if isinstance(aaa_team_info, dict):
                aaa_team_name = aaa_team_info.get("abbreviation") or aaa_team_info.get("name")
                aaa_team_id = aaa_team_info.get("id")
            pitcher_rows.append({
                "name": str(name),
                "player_id": pid,
                "team": str(parent_abbr) if isinstance(parent_abbr, str) else (team_map or {}).get(pid),
                "aaa_team": str(aaa_team_name) if isinstance(aaa_team_name, str) else None,
                "aaa_team_id": int(aaa_team_id) if aaa_team_id else None,
                "parent_org_abbr": str(parent_abbr) if isinstance(parent_abbr, str) else None,
                "parent_org_name": str(parent_name) if isinstance(parent_name, str) else None,
                "categories": cats,
            })

    return {
        "season": year,
        "level": "AAA",
        "hitters": hitter_rows,
        "pitchers": pitcher_rows,
        "hitter_metrics": [
            {"key": m["label"], "label": m["label"], "lower_better": m["lower_better"]}
            for m in AAA_HITTER_METRICS
        ],
        "pitcher_metrics": [
            {"key": lbl, "label": lbl, "lower_better": lbl in
             {"FIP", "Avg Exit Velo", "Barrel%", "xBA", "xSLG", "xwOBA", "BB%"}}
            for lbl in AAA_PITCHER_METRICS_LABELS
        ],
        "meta": {
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
        },
    }
