#!/usr/bin/env python3
"""
Fielding pipeline — fetches per-position defensive metrics from Baseball
Savant + FanGraphs, computes within-position percentiles, and emits
public/fielding_data_<year>.json consumed by FielderCard.jsx.

Imported and invoked from baseball_pipeline.py; not a standalone script.

OUTPUT SCHEMA
─────────────
{
  "season": 2026,
  "catcher_metrics":  [{"key":..., "label":..., "lower_better":bool}, ...],
  "infielder_metrics":[...],
  "outfielder_metrics":[...],
  "fielders": [
    {
      "name": "...", "player_id": 12345, "team": "NYY",
      "positions": {
        "C":  { "innings": 423, "categories": { "<label>": {"display":"...", "pctile":71, "value":4.2}, ... } },
        "1B": { ... }
      }
    },
    ...
  ]
}

Players qualify at any position where they accumulated ≥ MIN_INN innings.
Multiple positions per player are allowed — the React card renders one
position at a time via an internal selector.

Notes
─────
Several Savant URLs / column names are educated guesses based on the
publicly-visible leaderboards. On first run each fetch logs the raw
columns it received — if a metric reports "missing" in the merge step,
inspect that log line and add an alias in COLUMN_ALIASES.
"""
from __future__ import annotations

import io
import json
import os
import time
from typing import Dict, List, Optional

import numpy as np
import pandas as pd
import requests


# ────────────────────────────────────────────────────────────────────────────
# CONFIG
# ────────────────────────────────────────────────────────────────────────────

MIN_INN = 100  # innings threshold per (player, position) for qualification

POSITIONS = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"]
POS_CODE = {"C": 2, "1B": 3, "2B": 4, "3B": 5, "SS": 6, "LF": 7, "CF": 8, "RF": 9}
CATCHER_POS = {"C"}
INFIELD_POS = {"1B", "2B", "3B", "SS"}
OUTFIELD_POS = {"LF", "CF", "RF"}


def _flip_name(s: Optional[str]) -> Optional[str]:
    """Savant ships names as 'Last, First'. Flip to 'First Last' for display."""
    if not s or not isinstance(s, str):
        return s
    s = s.strip()
    if "," in s:
        parts = [p.strip() for p in s.split(",", 1)]
        if len(parts) == 2 and parts[0] and parts[1]:
            return f"{parts[1]} {parts[0]}"
    return s


def _grp(pos: str) -> str:
    if pos in CATCHER_POS: return "catcher"
    if pos in INFIELD_POS: return "infielder"
    if pos in OUTFIELD_POS: return "outfielder"
    return "other"


# Metric definitions — same shape used by HITTER_METRICS / PITCHER_METRICS in
# baseball_pipeline.py. The `src_col` field is the column we expect after the
# merge; lookups also fall back through COLUMN_ALIASES.
CATCHER_METRICS = [
    {"key": "def",          "label": "Def",                          "lower_better": False, "fmt": ".1f", "src_col": "fg_def"},
    {"key": "drs",          "label": "DRS",                          "lower_better": False, "fmt": ".0f", "src_col": "fg_drs"},
    {"key": "frv",          "label": "FRV",                          "lower_better": False, "fmt": ".0f", "src_col": "frv"},
    {"key": "arm_strength", "label": "Arm Strength",                 "lower_better": False, "fmt": ".1f", "src_col": "arm_strength_mph"},
    {"key": "pop_time",     "label": "Pop Time",                     "lower_better": True,  "fmt": ".2f", "src_col": "pop_time_2b_avg"},
    {"key": "csaa",         "label": "Caught Stealing Above Average","lower_better": False, "fmt": ".1f", "src_col": "csaa"},
    {"key": "framing",      "label": "Framing Runs",                 "lower_better": False, "fmt": ".1f", "src_col": "framing_runs"},
    {"key": "shadow_strike","label": "Shadow Strike%",               "lower_better": False, "fmt": ".1f", "src_col": "shadow_zone_called_strike_rate"},
    {"key": "blocks",       "label": "Blocks Above Average",         "lower_better": False, "fmt": ".1f", "src_col": "blocks_above_average"},
]

INFIELDER_METRICS = [
    {"key": "def",          "label": "Def",                       "lower_better": False, "fmt": ".1f", "src_col": "fg_def"},
    {"key": "drs",          "label": "DRS",                       "lower_better": False, "fmt": ".0f", "src_col": "fg_drs"},
    {"key": "oaa",          "label": "OAA",                       "lower_better": False, "fmt": ".0f", "src_col": "outs_above_average"},
    {"key": "oaa_in",       "label": "OAA In",                    "lower_better": False, "fmt": ".0f", "src_col": "oaa_in"},
    {"key": "oaa_back",     "label": "OAA Back",                  "lower_better": False, "fmt": ".0f", "src_col": "oaa_back"},
    {"key": "oaa_left",     "label": "OAA Left",                  "lower_better": False, "fmt": ".0f", "src_col": "oaa_left"},
    {"key": "oaa_right",    "label": "OAA Right",                 "lower_better": False, "fmt": ".0f", "src_col": "oaa_right"},
    {"key": "frv",          "label": "FRV",                       "lower_better": False, "fmt": ".0f", "src_col": "frv"},
    {"key": "esra",         "label": "Estimated Success% Added",  "lower_better": False, "fmt": ".1f", "src_col": "estimated_success_rate_added"},
    {"key": "arm_strength", "label": "Arm Strength",              "lower_better": False, "fmt": ".1f", "src_col": "arm_strength_mph"},
]

OUTFIELDER_METRICS = [
    {"key": "def",          "label": "Def",                       "lower_better": False, "fmt": ".1f", "src_col": "fg_def"},
    {"key": "drs",          "label": "DRS",                       "lower_better": False, "fmt": ".0f", "src_col": "fg_drs"},
    {"key": "oaa",          "label": "OAA",                       "lower_better": False, "fmt": ".0f", "src_col": "outs_above_average"},
    {"key": "frv",          "label": "FRV",                       "lower_better": False, "fmt": ".0f", "src_col": "frv"},
    {"key": "esra",         "label": "Estimated Success% Added",  "lower_better": False, "fmt": ".1f", "src_col": "estimated_success_rate_added"},
    {"key": "five_star",    "label": "5 Star Catch%",             "lower_better": False, "fmt": ".1f", "src_col": "five_star_catch_rate"},
    {"key": "four_star",    "label": "4 Star Catch%",             "lower_better": False, "fmt": ".1f", "src_col": "four_star_catch_rate"},
    {"key": "three_star",   "label": "3 Star Catch%",             "lower_better": False, "fmt": ".1f", "src_col": "three_star_catch_rate"},
    {"key": "jump",         "label": "Jump Feet vs Average",      "lower_better": False, "fmt": ".1f", "src_col": "jump_feet_vs_avg"},
    {"key": "arm_value",    "label": "Arm Value",                 "lower_better": False, "fmt": ".1f", "src_col": "of_arm_value"},
    {"key": "arm_strength", "label": "Arm Strength",              "lower_better": False, "fmt": ".1f", "src_col": "arm_strength_mph"},
]

# Lower-case substring → canonical column name. Used as a fuzzy fallback if
# Savant has renamed a column between seasons.
COLUMN_ALIASES = {
    # OAA + directional splits
    "outs_above_average": ["outs_above_average", "oaa", "outs_above_avg"],
    "estimated_success_rate_added": ["estimated_success_rate_added", "est_success_rate_added",
                                       "estimated_success_added", "diff_success_rate",
                                       "estimated_success_rate_formatted_diff",
                                       "success_rate_added_estimated", "success_rate_added"],
    "oaa_in":    ["outs_above_average_infront", "outs_above_average_in",   "oaa_in"],
    "oaa_back":  ["outs_above_average_behind",  "outs_above_average_back",  "oaa_back"],
    "oaa_left":  ["outs_above_average_lateral_toward3bline", "outs_above_average_left",  "oaa_left"],
    "oaa_right": ["outs_above_average_lateral_toward1bline", "outs_above_average_right", "oaa_right"],

    # FRV — the leaderboard ships per-player totals; total_runs is the FRV.
    "frv": ["total_runs", "fielding_run_value", "run_value", "frv", "rv", "rv_tot"],

    # Arm strength leaderboard — overall + per-position mph
    "arm_strength_mph": ["arm_overall", "avg_arm_strength_mph", "avg_arm_strength",
                          "arm_strength_mph", "arm_strength", "max_throw_mph",
                          "avg_max_throw_mph", "throw_mph_avg"],

    # Catcher pop time
    "pop_time_2b_avg": ["pop_2b_sba", "pop_2b_sba_avg", "pop_time_2b_avg", "avg_pop_time_2b", "pop_time_2b_3b_avg"],

    # Catcher CSAA
    "csaa": ["caught_stealing_above_average", "cs_aa", "rcs", "csaa"],

    # Catcher framing — Savant ships rv_tot (total framing runs) + pct_tot
    # (overall shadow-zone called strike rate)
    "framing_runs": ["runs_extra_strikes", "framing", "framing_runs", "rv_tot"],
    "shadow_zone_called_strike_rate": ["shadow_zone_called_strike_rate", "csaa_shadow",
                                        "shadow_zone_strike_rate", "strike_rate_shadow",
                                        "pct_tot", "shadow_strike_pct"],

    # Catcher blocking
    "blocks_above_average": ["blocks_above_average", "block_runs", "blocking_runs",
                              "catcher_blocking_runs", "passed_balls_above_average"],

    # OF catch probability — Savant uses n_5star_percent style
    "five_star_catch_rate":  ["n_5star_percent", "five_star_catch_rate", "5_star_catch_rate", "catch_pct_five"],
    "four_star_catch_rate":  ["n_4star_percent", "four_star_catch_rate", "4_star_catch_rate", "catch_pct_four"],
    "three_star_catch_rate": ["n_3star_percent", "three_star_catch_rate", "3_star_catch_rate", "catch_pct_three"],

    # OF jump + arm value
    # OF jump: Savant's headline "Jump Feet vs Avg" is the burst distance
    # relative to league average over the first segment of the jump.
    "jump_feet_vs_avg": ["jump_feet_vs_avg", "feet_vs_avg", "jump_vs_avg", "ft_above_avg",
                          "feet_covered_vs_avg", "feet_covered_above_avg",
                          "rel_league_burst_distance"],
    "of_arm_value": ["fielder_runs", "of_arm_value", "arm_value", "rERAA", "arm_runs", "rerd_total", "outfielder_arm_runs"],

    # FG
    "fg_def": ["Def", "Def_relative", "Defensive"],
    "fg_drs": ["DRS"],

    # ID / name / position
    "innings": ["innings_played", "inn", "inn_pos", "innings"],
    "position": ["pos", "position", "primary_pos_formatted", "primary_position", "primary_position_name"],
    "player_id": ["player_id", "entity_id", "resp_fielder_id", "id", "playerid", "mlbamid"],
    "player_name": ["player_name", "entity_name", "fielder_name", "name", "Name", "last_name, first_name"],
}


# ────────────────────────────────────────────────────────────────────────────
# FETCH HELPERS  (use baseball_pipeline.fetch_url / csv_to_df if available)
# ────────────────────────────────────────────────────────────────────────────

def _strip_html_preamble(text: str) -> str:
    """Some Savant endpoints prepend HTML / JSON before the actual CSV. Skip
    to the first line that looks like a CSV header — many commas, no `<`."""
    if not text:
        return text
    lines = text.splitlines()
    for i, ln in enumerate(lines):
        stripped = ln.strip()
        if not stripped or stripped.startswith("<"):
            continue
        # Plausible CSV header row: has at least 3 commas and no HTML tag chars
        if stripped.count(",") >= 3 and "<" not in stripped and ">" not in stripped:
            return "\n".join(lines[i:])
    return text


def _safe_fetch_csv(url: str, label: str, fetch_url, csv_to_df,
                    fallback_urls: Optional[List[str]] = None) -> Optional[pd.DataFrame]:
    candidates = [url] + (fallback_urls or [])
    for u in candidates:
        print(f"  Fetching {label}: {u[:140]}")
        try:
            text = fetch_url(u)
        except Exception as e:
            print(f"    ⚠ {label} fetch failed: {e}")
            continue
        if not text:
            continue
        cleaned = _strip_html_preamble(text)
        df = csv_to_df(cleaned)
        if df is None or df.empty:
            print(f"    ⚠ {label} returned no usable rows (raw start: {text[:120]!r})")
            continue
        print(f"    ✓ {label}: {len(df)} rows  columns: {list(df.columns)[:14]}{' …' if len(df.columns) > 14 else ''}")
        return df
    return None


def _apply_aliases(df: pd.DataFrame) -> pd.DataFrame:
    """Rename incoming Savant columns to our canonical names where possible."""
    if df is None:
        return df
    cols_lower = {c.lower(): c for c in df.columns}
    renames = {}
    for canon, candidates in COLUMN_ALIASES.items():
        if canon in df.columns:
            continue
        for cand in candidates:
            real = cols_lower.get(cand.lower())
            if real is not None:
                renames[real] = canon
                break
    if renames:
        df = df.rename(columns=renames)
    return df


def _ensure_id_name(df: pd.DataFrame) -> pd.DataFrame:
    if df is None:
        return df
    if "player_id" not in df.columns:
        for c in ("id", "playerid", "mlbamid", "MLBAMID"):
            if c in df.columns:
                df["player_id"] = pd.to_numeric(df[c], errors="coerce").astype("Int64")
                break
    else:
        df["player_id"] = pd.to_numeric(df["player_id"], errors="coerce").astype("Int64")
    if "player_name" not in df.columns:
        for c in ("name", "Name", "last_name, first_name", "full_name"):
            if c in df.columns:
                df["player_name"] = df[c].astype(str)
                break
    return df


# ────────────────────────────────────────────────────────────────────────────
# SAVANT FETCHERS  (one CSV per leaderboard)
# ────────────────────────────────────────────────────────────────────────────

def _env_url(env_key: str, year: int) -> Optional[str]:
    raw = os.environ.get(env_key, "").strip()
    if not raw:
        return None
    return raw.format(year=year) if "{year}" in raw else raw


def fetch_savant_oaa(year: int, fetch_url, csv_to_df) -> Optional[pd.DataFrame]:
    """Outs Above Average leaderboard, split per position. The CSV URL uses
    startYear/endYear (not year=) and split=yes for per-position rows."""
    url = _env_url("SAVANT_OAA_URL", year) or (
        f"https://baseballsavant.mlb.com/leaderboard/outs_above_average"
        f"?type=Fielder&startYear={year}&endYear={year}&split=yes"
        f"&team=&range=year&min=q&pos=&roles=&viz=show&csv=true"
    )
    df = _safe_fetch_csv(url, "Savant OAA", fetch_url, csv_to_df)
    return _apply_aliases(_ensure_id_name(df))


def fetch_savant_frv(year: int, fetch_url, csv_to_df) -> Optional[pd.DataFrame]:
    """Fielding Run Value leaderboard. Savant's CSV ignores year= here and
    returns all years; filter to the requested year by the 'year' column."""
    url = _env_url("SAVANT_FRV_URL", year) or (
        "https://baseballsavant.mlb.com/leaderboard/fielding-run-value?csv=true"
    )
    df = _safe_fetch_csv(url, "Savant FRV", fetch_url, csv_to_df)
    if df is not None and "year" in df.columns:
        df = df[pd.to_numeric(df["year"], errors="coerce") == year].reset_index(drop=True)
        print(f"    Filtered FRV to year={year}: {len(df)} rows")
    return _apply_aliases(_ensure_id_name(df))


def fetch_savant_catcher_framing(year: int, fetch_url, csv_to_df) -> Optional[pd.DataFrame]:
    url = (
        f"https://baseballsavant.mlb.com/leaderboard/catcher-framing"
        f"?year={year}&team=&min=q&sort=4&sortDir=desc&csv=true"
    )
    df = _safe_fetch_csv(url, "Savant catcher framing", fetch_url, csv_to_df)
    return _apply_aliases(_ensure_id_name(df))


def fetch_savant_pop_time(year: int, fetch_url, csv_to_df) -> Optional[pd.DataFrame]:
    url = (
        f"https://baseballsavant.mlb.com/leaderboard/poptime"
        f"?year={year}&team=&minThrows=5&min2BAttempts=5&min3BAttempts=0&csv=true"
    )
    df = _safe_fetch_csv(url, "Savant pop time", fetch_url, csv_to_df)
    return _apply_aliases(_ensure_id_name(df))


def fetch_savant_arm_strength(year: int, fetch_url, csv_to_df) -> Optional[pd.DataFrame]:
    """Throws across all positions; columns include avg arm strength + max."""
    url = (
        f"https://baseballsavant.mlb.com/leaderboard/arm-strength"
        f"?year={year}&team=&min=100&pos=&csv=true"
    )
    df = _safe_fetch_csv(url, "Savant arm strength", fetch_url, csv_to_df)
    return _apply_aliases(_ensure_id_name(df))


def fetch_savant_csaa(year: int, fetch_url, csv_to_df) -> Optional[pd.DataFrame]:
    """Catcher caught-stealing above average. Lives under catcher-throwing."""
    url = (
        f"https://baseballsavant.mlb.com/leaderboard/catcher-throwing"
        f"?year={year}&team=&min=q&csv=true"
    )
    df = _safe_fetch_csv(url, "Savant catcher CSAA", fetch_url, csv_to_df)
    return _apply_aliases(_ensure_id_name(df))


def fetch_savant_catcher_blocks(year: int, fetch_url, csv_to_df) -> Optional[pd.DataFrame]:
    url = (
        f"https://baseballsavant.mlb.com/leaderboard/catcher-blocking"
        f"?year={year}&team=&min=q&csv=true"
    )
    df = _safe_fetch_csv(url, "Savant catcher blocking", fetch_url, csv_to_df)
    return _apply_aliases(_ensure_id_name(df))


def fetch_savant_of_jump(year: int, fetch_url, csv_to_df) -> Optional[pd.DataFrame]:
    primary = (
        f"https://baseballsavant.mlb.com/leaderboard/outfield_jump"
        f"?year={year}&team=&min=q&csv=true"
    )
    fallbacks = [
        f"https://baseballsavant.mlb.com/leaderboard/of_jump?year={year}&min=q&csv=true",
        f"https://baseballsavant.mlb.com/leaderboard/jump?year={year}&min=q&csv=true",
        os.environ.get("SAVANT_OF_JUMP_URL", "").format(year=year) if os.environ.get("SAVANT_OF_JUMP_URL") else "",
    ]
    df = _safe_fetch_csv(primary, "Savant OF jump", fetch_url, csv_to_df, [u for u in fallbacks if u])
    return _apply_aliases(_ensure_id_name(df))


def fetch_savant_of_catch_prob(year: int, fetch_url, csv_to_df) -> Optional[pd.DataFrame]:
    """x-star catch% leaderboard."""
    url = (
        f"https://baseballsavant.mlb.com/leaderboard/catch_probability"
        f"?year={year}&team=&min=q&csv=true"
    )
    df = _safe_fetch_csv(url, "Savant OF catch prob", fetch_url, csv_to_df)
    return _apply_aliases(_ensure_id_name(df))


def fetch_savant_of_arm(year: int, fetch_url, csv_to_df) -> Optional[pd.DataFrame]:
    """Outfielder arm value lives on Savant's baserunning leaderboard with
    type=Fld (the fielder-side view of baserunning: arm kills, holds, etc.)."""
    url = _env_url("SAVANT_OF_ARM_URL", year) or (
        f"https://baseballsavant.mlb.com/leaderboard/baserunning"
        f"?type=Fld&year={year}&csv=true"
    )
    df = _safe_fetch_csv(url, "Savant OF arm value", fetch_url, csv_to_df)
    return _apply_aliases(_ensure_id_name(df))


# ────────────────────────────────────────────────────────────────────────────
# FANGRAPHS FIELDING  (cookie-jar path mirroring fetch_fangraphs_pitching)
# ────────────────────────────────────────────────────────────────────────────

def fetch_fangraphs_fielding(year: int, http_headers: dict) -> Optional[pd.DataFrame]:
    """FanGraphs fielding leaders. Tries several `type` values to find one
    that ships Def + DRS in the response (the API filters columns by type
    and the right code drifts across seasons). Cookies path only."""
    print(f"  Fetching FanGraphs fielding ({year})...")
    cookie_paths = [
        "fangraphs_cookies.txt",
        os.path.join(os.path.dirname(__file__), "fangraphs_cookies.txt"),
        os.path.expanduser("~/project/fangraphs_cookies.txt"),
        "www.fangraphs.com_cookies.txt",
    ]
    cookie_path = next((cp for cp in cookie_paths if os.path.exists(cp)), None)
    if not cookie_path:
        print("    ⚠ No FG cookies file found — Def/DRS will be blank")
        return None

    try:
        from http.cookiejar import MozillaCookieJar
        jar = MozillaCookieJar(cookie_path)
        jar.load(ignore_discard=True, ignore_expires=True)
        s = requests.Session()
        s.cookies = jar
        s.headers.update(http_headers)
    except Exception as e:
        print(f"    ⚠ Failed to load FG cookies ({cookie_path}): {e}")
        return None

    def _try(stats_code, type_code):
        url = ("https://www.fangraphs.com/api/leaders/major-league/data"
               f"?pos=all&stats={stats_code}&lg=all&qual=0&type={type_code}"
               f"&season={year}&month=0&season1={year}&ind=0"
               f"&team=0&rost=0&age=0&filter=&players=0"
               f"&startdate=&enddate=&pageitems=4000&page=1")
        try:
            r = s.get(url, timeout=30)
        except Exception as e:
            print(f"    FG stats={stats_code} type={type_code}: request failed: {e}")
            return None
        if r.status_code != 200:
            print(f"    FG stats={stats_code} type={type_code}: HTTP {r.status_code}")
            return None
        try:
            rows = r.json().get("data", [])
        except Exception:
            print(f"    FG stats={stats_code} type={type_code}: JSON parse failed")
            return None
        return rows or None

    # FG splits Def vs DRS across two leaderboards: stats=def has Def,
    # stats=fld type=1 has DRS. Fetch both and merge on player_id+position.
    def _fetch_combo(stats_code, type_codes):
        for tc in type_codes:
            rows = _try(stats_code, tc)
            if not rows:
                print(f"    FG stats={stats_code} type={tc}: 0 rows")
                continue
            cols = sorted(rows[0].keys())
            print(f"    FG stats={stats_code} type={tc}: {len(rows)} rows  "
                  f"hasDef={'Defense' in cols or 'Def' in cols} hasDRS={'DRS' in cols}")
            print(f"    FG stats={stats_code} all columns: {cols}")
            return rows, tc
        return None, None

    def_rows, def_tc = _fetch_combo("def", (2, 1, 8, 0))
    drs_rows, drs_tc = _fetch_combo("fld", (1, 2, 8, 0))

    if not def_rows and not drs_rows:
        print("    ⚠ FG returned nothing usable — Def/DRS will be blank")
        return None

    def _to_df(rows):
        return pd.DataFrame(rows) if rows else None

    df_def = _to_df(def_rows)
    df_drs = _to_df(drs_rows)

    # Merge on (player_id, position). FG's `position`/`Pos` column keys
    # per-row. We rename only the columns we need.
    def _slim(df, value_cols):
        if df is None:
            return None
        ren = {}
        for canon, cands in {
            "player_id":   ["xMLBAMID", "MLBAMID", "playerid"],
            "player_name": ["PlayerName", "Name"],
            "position":    ["Pos", "position"],
        }.items():
            for c in cands:
                if c in df.columns and canon not in ren.values():
                    ren[c] = canon
                    break
        df = df.rename(columns=ren)
        keep = ["player_id", "player_name", "position"] + [c for c in value_cols if c in df.columns]
        return df[keep]

    # FG ships the field-value column as "Defense" (not "Def").
    if df_def is not None and "Defense" in df_def.columns and "Def" not in df_def.columns:
        df_def = df_def.rename(columns={"Defense": "Def"})
    if df_drs is not None and "Defense" in df_drs.columns and "Def" not in df_drs.columns:
        df_drs = df_drs.rename(columns={"Defense": "Def"})
    df_def_slim = _slim(df_def, ["Def"])
    df_drs_slim = _slim(df_drs, ["DRS"])
    if df_def_slim is not None and df_drs_slim is not None:
        df = df_def_slim.merge(df_drs_slim, on=["player_id", "player_name", "position"], how="outer")
    else:
        df = df_def_slim if df_def_slim is not None else df_drs_slim
    if df is None or df.empty:
        return None
    print(f"    → FG merged: {len(df)} rows  (Def from type={def_tc}, DRS from type={drs_tc})")
    ren = {}
    for canon, cands in {
        "player_id":   ["xMLBAMID", "MLBAMID", "playerid"],
        "player_name": ["PlayerName", "Name"],
        "position":    ["Pos", "position"],
        "fg_def":      ["Def"],
        "fg_drs":      ["DRS"],
        "innings_pos": ["Inn"],
        "team_fg":     ["TeamName", "Team"],
    }.items():
        for c in cands:
            if c in df.columns and canon not in ren.values():
                ren[c] = canon
                break
    df = df.rename(columns=ren)
    if "player_id" in df.columns:
        df["player_id"] = pd.to_numeric(df["player_id"], errors="coerce").astype("Int64")
    print(f"    FG fielding columns: {list(df.columns)[:30]}")
    return df


# ────────────────────────────────────────────────────────────────────────────
# POSITION INNINGS  (from MLB Stats API — used to gate qualification)
# ────────────────────────────────────────────────────────────────────────────

def fetch_position_innings(year: int, http_headers: dict) -> Dict[int, Dict[str, float]]:
    """Return { player_id: { 'C': innings, '1B': innings, ... } }.

    Pulled from MLB Stats API's fielding stat endpoint paginated. Each split
    has positionAbbreviation and innings string ("123.1" = 123 + 1/3).
    """
    out: Dict[int, Dict[str, float]] = {}
    base = "https://statsapi.mlb.com/api/v1/stats"
    offset = 0
    LIMIT = 500
    while True:
        url = (f"{base}?stats=season&group=fielding&season={year}"
               f"&sportIds=1&playerPool=All&limit={LIMIT}&offset={offset}")
        try:
            r = requests.get(url, headers=http_headers, timeout=30)
            r.raise_for_status()
        except Exception as e:
            print(f"  ⚠ MLB fielding fetch failed at offset {offset}: {e}")
            break
        splits = (r.json().get("stats") or [{}])[0].get("splits") or []
        if not splits:
            break
        for sp in splits:
            pid = (sp.get("player") or {}).get("id")
            pos = sp.get("position", {}).get("abbreviation")
            if not pid or pos not in POSITIONS:
                continue
            inn = sp.get("stat", {}).get("innings")
            if inn is None:
                continue
            try:
                whole, frac = str(inn).split(".") if "." in str(inn) else (str(inn), "0")
                innings = int(whole) + int(frac) / 3.0
            except Exception:
                innings = 0.0
            out.setdefault(int(pid), {})[pos] = innings
        if len(splits) < LIMIT:
            break
        offset += LIMIT
    print(f"  Position innings: {len(out)} players with fielding splits")
    return out


# ────────────────────────────────────────────────────────────────────────────
# AGGREGATION  + PERCENTILES
# ────────────────────────────────────────────────────────────────────────────

def _value(row: pd.Series, col: str):
    if col not in row:
        return None
    v = row[col]
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return None
    try:
        return float(v)
    except Exception:
        return None


def _normalise_pos(p) -> Optional[str]:
    if p is None:
        return None
    s = str(p).strip().upper()
    if s in POSITIONS:
        return s
    # FG sometimes returns "2B/SS" or "OF" — split / map best-effort
    if s == "OF":
        return None  # OF without subdivision: skip
    if "/" in s:
        for tok in s.split("/"):
            n = _normalise_pos(tok)
            if n:
                return n
    return None


def _pct(value: Optional[float], pool: List[float], lower_better: bool) -> Optional[int]:
    if value is None or not pool:
        return None
    pool = [p for p in pool if p is not None and not np.isnan(p)]
    if not pool:
        return None
    n = len(pool)
    rank = sum(1 for p in pool if p < value)
    eq = sum(1 for p in pool if p == value)
    pct = (rank + eq * 0.5) / n
    if lower_better:
        pct = 1.0 - pct
    return int(round(pct * 100))


def _fmt(value: Optional[float], fmt: str) -> str:
    if value is None:
        return "—"
    try:
        return f"{value:{fmt}}"
    except Exception:
        return str(value)


def _metrics_for(pos_group: str):
    return {"catcher": CATCHER_METRICS, "infielder": INFIELDER_METRICS,
            "outfielder": OUTFIELDER_METRICS}.get(pos_group, [])


def build_fielding(year: int, fetch_url, csv_to_df, http_headers: dict,
                    team_map: Optional[Dict[int, str]] = None) -> dict:
    """End-to-end build. Returns the JSON-serializable dict."""
    print(f"\n  ─── Fielding pipeline ({year}) ───")

    # 1. Fetch all sources
    oaa     = fetch_savant_oaa(year, fetch_url, csv_to_df)
    frv     = fetch_savant_frv(year, fetch_url, csv_to_df)
    framing = fetch_savant_catcher_framing(year, fetch_url, csv_to_df)
    poptime = fetch_savant_pop_time(year, fetch_url, csv_to_df)
    arms    = fetch_savant_arm_strength(year, fetch_url, csv_to_df)
    csaa    = fetch_savant_csaa(year, fetch_url, csv_to_df)
    blocks  = fetch_savant_catcher_blocks(year, fetch_url, csv_to_df)
    jump    = fetch_savant_of_jump(year, fetch_url, csv_to_df)
    catchp  = fetch_savant_of_catch_prob(year, fetch_url, csv_to_df)
    ofarm   = fetch_savant_of_arm(year, fetch_url, csv_to_df)
    fg      = fetch_fangraphs_fielding(year, http_headers)
    inn_map = fetch_position_innings(year, http_headers)

    # 2. Build per-(player, position) row dict, keyed by (pid, pos)
    rows: Dict[tuple, dict] = {}

    def stamp(pid: int, pos: str, name: str = None, team: str = None):
        key = (pid, pos)
        if key not in rows:
            rows[key] = {"player_id": pid, "position": pos, "name": name, "team": team}
        else:
            if name and not rows[key].get("name"):    rows[key]["name"] = name
            if team and not rows[key].get("team"):    rows[key]["team"] = team
        return rows[key]

    def merge_one(df, pos_field: Optional[str], val_cols: List[str], default_pos: Optional[str] = None):
        if df is None:
            return
        for _, r in df.iterrows():
            pid = r.get("player_id")
            if pd.isna(pid):
                continue
            pid = int(pid)
            pos = _normalise_pos(r.get(pos_field)) if pos_field else default_pos
            if not pos:
                continue
            name = r.get("player_name")
            team = r.get("team_abbr") or r.get("team") or r.get("team_id")
            cell = stamp(pid, pos, name=str(name) if isinstance(name, str) else None,
                         team=str(team) if isinstance(team, str) else None)
            for c in val_cols:
                if c in r and r[c] is not None and not (isinstance(r[c], float) and np.isnan(r[c])):
                    cell[c] = r[c]

    # OAA: per (player, position) row directly
    merge_one(oaa, "position", [
        "outs_above_average", "estimated_success_rate_added",
        "oaa_in", "oaa_back", "oaa_left", "oaa_right",
    ])
    # FRV: per-player totals (no position column on the leaderboard).
    # Fan out to every position the player qualifies at — FRV is a season
    # total, attributed to each position they actually played.
    def fan_out_all_pos(df, val_cols):
        if df is None:
            return
        for _, r in df.iterrows():
            pid = r.get("player_id")
            if pd.isna(pid):
                continue
            pid = int(pid)
            qualified_positions = [p for p, inn in inn_map.get(pid, {}).items()
                                   if inn >= MIN_INN]
            if not qualified_positions:
                continue
            name = r.get("player_name")
            for pos in qualified_positions:
                cell = stamp(pid, pos, name=str(name) if isinstance(name, str) else None)
                for c in val_cols:
                    if c in r and r[c] is not None and not (isinstance(r[c], float) and np.isnan(r[c])):
                        cell[c] = r[c]
    fan_out_all_pos(frv, ["frv"])
    # Catcher framing / pop / csaa / blocks → all default to C
    merge_one(framing, None, ["framing_runs", "shadow_zone_called_strike_rate"], default_pos="C")
    # Pop time also carries the catcher's max-effort arm strength on caught
    # stealing throws — Savant's arm-strength leaderboard does NOT include
    # catchers, so use this column as the C arm_strength_mph.
    if poptime is not None and "maxeff_arm_2b_3b_sba" in poptime.columns:
        poptime = poptime.copy()
        poptime["arm_strength_mph"] = pd.to_numeric(poptime["maxeff_arm_2b_3b_sba"], errors="coerce")
    merge_one(poptime, None, ["pop_time_2b_avg", "arm_strength_mph"], default_pos="C")
    merge_one(csaa, None, ["csaa"], default_pos="C")
    merge_one(blocks, None, ["blocks_above_average"], default_pos="C")
    # OF jump / catch / arm → fan out to LF/CF/RF (we don't know the player's
    # primary OF spot from the leaderboard alone; attach to every OF pos
    # where the player has innings)
    def fan_out_of(df, val_cols):
        if df is None:
            return
        for _, r in df.iterrows():
            pid = r.get("player_id")
            if pd.isna(pid):
                continue
            pid = int(pid)
            of_positions = [p for p, inn in inn_map.get(pid, {}).items()
                            if p in OUTFIELD_POS and inn >= MIN_INN]
            if not of_positions:
                continue
            name = r.get("player_name")
            for pos in of_positions:
                cell = stamp(pid, pos, name=str(name) if isinstance(name, str) else None)
                for c in val_cols:
                    if c in r and r[c] is not None and not (isinstance(r[c], float) and np.isnan(r[c])):
                        cell[c] = r[c]
    fan_out_of(jump,   ["jump_feet_vs_avg"])
    fan_out_of(catchp, ["five_star_catch_rate", "four_star_catch_rate", "three_star_catch_rate"])
    fan_out_of(ofarm,  ["of_arm_value"])

    # Arm strength: applies to whichever positions the player accumulated
    # innings at (each position pool is its own z-score group later).
    if arms is not None:
        for _, r in arms.iterrows():
            pid = r.get("player_id")
            if pd.isna(pid):
                continue
            pid = int(pid)
            name = r.get("player_name")
            ams = r.get("arm_strength_mph")
            if ams is None or (isinstance(ams, float) and np.isnan(ams)):
                continue
            for pos, inn in inn_map.get(pid, {}).items():
                if inn < MIN_INN:
                    continue
                cell = stamp(pid, pos, name=str(name) if isinstance(name, str) else None)
                cell["arm_strength_mph"] = float(ams)

    # FG fielding: one row per (player, position)
    if fg is not None and "position" in fg.columns:
        for _, r in fg.iterrows():
            pid = r.get("player_id")
            if pd.isna(pid):
                continue
            pid = int(pid)
            pos = _normalise_pos(r.get("position"))
            if not pos:
                continue
            cell = stamp(pid, pos, name=str(r.get("player_name") or ""),
                         team=str(r.get("team_fg") or ""))
            for c in ("fg_def", "fg_drs"):
                if c in r and r[c] is not None and not (isinstance(r[c], float) and np.isnan(r[c])):
                    cell[c] = r[c]

    # 3. Gate by innings ≥ MIN_INN at the position
    qualified = []
    for (pid, pos), cell in rows.items():
        innings = inn_map.get(pid, {}).get(pos, 0.0)
        if innings < MIN_INN:
            continue
        cell["innings"] = innings
        qualified.append(cell)
    print(f"  Qualified (player, position) rows ≥ {MIN_INN} inn: {len(qualified)}")

    # 4. Compute percentiles within each position
    by_pos: Dict[str, List[dict]] = {}
    for cell in qualified:
        by_pos.setdefault(cell["position"], []).append(cell)

    fielders: Dict[int, dict] = {}
    for pos, cells in by_pos.items():
        metric_list = _metrics_for(_grp(pos))
        # Build pools per source column
        pools = {m["src_col"]: [c.get(m["src_col"]) for c in cells if c.get(m["src_col"]) is not None]
                 for m in metric_list}
        for c in cells:
            pid = c["player_id"]
            cats = {}
            for m in metric_list:
                v = c.get(m["src_col"])
                try:
                    val_f = float(v) if v is not None else None
                except Exception:
                    val_f = None
                cats[m["label"]] = {
                    "display": _fmt(val_f, m["fmt"]),
                    "pctile":  _pct(val_f, pools[m["src_col"]], m["lower_better"]),
                    "value":   val_f,
                }
            fielders.setdefault(pid, {
                "player_id": pid,
                "name": _flip_name(c.get("name")) or "",
                "team": (team_map or {}).get(pid) or c.get("team") or "",
                "positions": {},
            })
            fielders[pid]["positions"][pos] = {
                "innings": round(c.get("innings") or 0, 1),
                "categories": cats,
            }

    out = {
        "season": year,
        "catcher_metrics":   [{"key": m["key"], "label": m["label"], "lower_better": m["lower_better"]} for m in CATCHER_METRICS],
        "infielder_metrics": [{"key": m["key"], "label": m["label"], "lower_better": m["lower_better"]} for m in INFIELDER_METRICS],
        "outfielder_metrics":[{"key": m["key"], "label": m["label"], "lower_better": m["lower_better"]} for m in OUTFIELDER_METRICS],
        "fielders": sorted(fielders.values(), key=lambda f: f["name"] or ""),
        "meta": {
            "min_innings": MIN_INN,
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
        },
    }
    print(f"  Fielders with ≥1 qualified position: {len(out['fielders'])}")
    return out
