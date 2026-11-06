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
  "catcher_metrics" / "infielder_metrics" / "outfielder_metrics" / "all_metrics":
      [{"key", "label", "lower_better", "section", "scope", "positions"?}, ...],
  "fielders": [
    {
      "name": "...", "player_id": 12345, "team": "NYY",
      "positions": {
        "C":  { "innings": 423.0,
                "categories": { "<key>": {"display": "4.2", "pctile": 71, "value": 4.2}, ... },
                "framing_zones": { "11": {"rate": 48.1, "lg": 45.0, "pctile": 80}, ... } },
        "1B": { ... }
      },
      "combined": {            # only for players with 2+ qualified positions
        "innings": 650.0, "primary": "C", "positions": {"C": 423.0, "1B": 227.0},
        "categories": { "<key>": {...} }
      }
    },
    ...
  ]
}

Players qualify at any position where they accumulated ≥ MIN_INN innings.
Each metric's scope (see METRIC DEFINITIONS) decides whether it lands on a
position tab or on the "All" tab; percentiles are always within the
player's own position. Every value is rounded to tenths.

BP's DRP and catcher defense come from exports committed under data/bp/
(bp_drp_<year>.csv, bp_catcher_<year>.csv). For an offline re-placement of
an existing JSON (no network), run:
    python3 fielding_pipeline.py --restructure ./public 2023 2024 2025 2026

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
import re
import time
from typing import Dict, List, Optional

import numpy as np
import pandas as pd
import requests


# ────────────────────────────────────────────────────────────────────────────
# CONFIG
# ────────────────────────────────────────────────────────────────────────────

MIN_INN = 50  # innings threshold per (player, position) for qualification

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


# ────────────────────────────────────────────────────────────────────────────
# METRIC DEFINITIONS
# ────────────────────────────────────────────────────────────────────────────
#
# Every metric has a `scope`, which decides which card(s) it lands on:
#   pos      — split by position (one value per player-position). Shown on
#              that position's tab, percentile within that position.
#   of_wide  — one value per player covering all of LF/CF/RF (Savant jump,
#              catch%, OF arm). Shown on the OF tab when the player qualified
#              at exactly one OF spot, otherwise on the "All" tab.
#   player   — one whole-player value (DRP, FRV when not split, overall arm).
#              Shown on the single card of a one-position player, otherwise
#              on the "All" tab.
#   sum      — "All" tab only: a pos metric summed across positions.
#
# Percentiles are always computed within the player's own position: the
# position's pool on a position tab, and players sharing the same primary
# position (most innings) on the "All" tab.
#
# `section` groups rows on the card; `positions` (optional) gates a metric to
# a subset of the group's positions. All values display to one decimal.

ALL_POS = set(POSITIONS)
NON_C = ALL_POS - CATCHER_POS

MIN_POOL = 5  # below this many peers a percentile is meaningless → N/A bar


def _m(key, label, src_col, section, scope="pos", lower_better=False,
       mult=None, positions=None, fallback_for=None):
    # fallback_for: src_col of a position-split metric this one only stands in
    # for — it is left off any card (or All tab) where that metric has a value.
    return {"key": key, "label": label, "src_col": src_col, "section": section,
            "scope": scope, "lower_better": lower_better, "mult": mult,
            "positions": set(positions) if positions else None,
            "fallback_for": fallback_for}


# Components from FanGraphs stats=fld (one row per player-position, so all
# position-split). Checked against the 2026 data:
#   DRS (SIS) = rPM + rGFP + rGDP + rARM + rSB + rSZ + rCERA. rTS is all zero;
#   FG ships no DRS receiving or bunt column.
#   FRP and its *FRP pieces are Statcast Fielding Run Value (FRV), not SIS —
#   they match Savant's own numbers at r = 0.95–1.00. FanGraphs is still the
#   better source because it splits them by position, which Savant's FRV
#   leaderboard does not. rFRP (range, = OAA runs), fFRP (framing) and bFRP
#   (blocking) duplicate Savant's own leaderboards and are skipped.
# Unmatched r* / *FRP columns are logged on each run.
#   (key, label, FG candidates, positions, section, include in "All" sums)
DRS_COMPONENTS = [
    ("drs_rpm",    "DRS Range/Positioning",   ["rPM"],   NON_C,        "Range",          True),
    ("drs_rgdp",   "DRS Double Plays",        ["rGDP"],  INFIELD_POS,  "Arm & Throwing", True),
    ("drs_rarm",   "DRS OF Arm",              ["rARM"],  OUTFIELD_POS, "Arm & Throwing", True),
    ("drs_rsb",    "DRS Stolen Bases",        ["rSB"],   CATCHER_POS,  "Arm & Throwing", False),
    ("drs_rsz",    "DRS Framing",             ["rSZ"],   CATCHER_POS,  "Framing",        False),
    ("drs_rcera",  "DRS Catcher ERA",         ["rCERA"], CATCHER_POS,  "Other DRS",      False),
    ("drs_rgfp",   "DRS Good Plays/Misplays", ["rGFP"],  ALL_POS,      "Other DRS",      True),
]
FG_FRV_COMPONENTS = [
    ("frv_receiving", "Savant 1B Receiving",     ["cFRP"], {"1B"},       "Receiving",      True),
    ("frv_arm",       "Savant Arm Runs",         ["aFRP"], NON_C,        "Arm & Throwing", True),
    ("frv_dp",        "Savant Double Play Runs", ["dFRP"], INFIELD_POS,  "Arm & Throwing", True),
    ("frv_throwing",  "Savant Throwing Runs",    ["tFRP"], CATCHER_POS,  "Arm & Throwing", False),
]
FG_FRV_DUPLICATES = {"rFRP", "fFRP", "bFRP"}   # = OAA range runs / Savant framing / Savant blocking
FG_COMPONENTS = DRS_COMPONENTS + FG_FRV_COMPONENTS

# Savant's own FRV leaderboard: one row per player (it ignores position
# filters). Its total is the fallback FRV when FanGraphs has none, and ABS
# challenge runs exist only here. Its 1B receiving column is also attached to
# the 1B cell as a fallback for FanGraphs' cFRP. Everything else in it is
# covered position-split elsewhere and skipped.
#   (key, label, Savant candidates, positions, section)
FRV_COMPONENTS = [
    ("frv_abs",      "Savant ABS Challenge Runs", ["abs_runs"],                       CATCHER_POS, "Framing"),
]
_FRV_SKIPPED = {"total_runs", "inf_of_runs", "catching_runs", "framing_runs", "blocking_runs", "range_runs",
                "arm_runs", "dp_runs", "throwing_runs"}

_OVERALL = [
    _m("def",       "Def",  "fg_def",  "Overall"),
    _m("drs",       "DRS",  "fg_drs",  "Overall"),
    _m("oaa",       "OAA",  "outs_above_average", "Overall", positions=NON_C),
    _m("frv",       "FRV",  "frv_pos", "Overall"),
    _m("frv_total", "FRV",  "frv",     "Overall", scope="player", fallback_for="frv_pos"),
    _m("drp",       "DRP (BP)",                    "bp_drp", "Overall", scope="player"),
    _m("bp_cda",    "BP Catcher Defense (CDA)",    "bp_cda", "Overall", positions=CATCHER_POS),
]


def _drs_defs(section):
    """DRS then (Statcast) FRV components for a card section, via FanGraphs."""
    return [_m(k, lbl, k, sec, positions=pos) for k, lbl, _c, pos, sec, _s in FG_COMPONENTS if sec == section]


def _frv_defs(section):
    return [_m(k, lbl, k, sec, scope="player", positions=pos)
            for k, lbl, _c, pos, sec in FRV_COMPONENTS if sec == section]


# Savant 1B receiving on the FRV leaderboard (fallback for FanGraphs' cFRP):
# per-player, but only ever earned at 1B, so it goes on the 1B cell.
_FRV_REC1B_COLS = ["fielding_runs_prevented_on_rec1b", "receiving_runs", "rec1b_runs"]

# Savant range runs: OAA converted to runs, from the per-position OAA pull.
_SAV_RANGE = _m("frv_range", "Savant Range Runs", "frv_range", "Range", positions=NON_C)


# BP's whole-player range and throwing pieces of DRP. BP gives catchers no
# range / throwing credit (always 0 / blank) — their defense is CDA, on the C
# tab — so these stay off the C card.
_BP_RDA = _m("rda", "BP Range Defense Added", "bp_rda", "Range",          scope="player", positions=NON_C)
_BP_THR = _m("thr", "BP Throwing Runs",       "bp_thr", "Arm & Throwing", scope="player", positions=NON_C)

CATCHER_METRICS = [m for m in _OVERALL if m["key"] != "oaa"] + [
    _m("framing",       "Savant Framing Runs", "framing_runs", "Framing"),
    _m("shadow_strike", "Shadow Strike%",      "shadow_zone_called_strike_rate", "Framing", mult=100),
    *_drs_defs("Framing"),
    *_frv_defs("Framing"),
    _m("bp_frm",        "BP Framing Runs",     "bp_frm", "Framing"),
    _m("arm_strength",  "Arm Strength",        "arm_strength_pos", "Arm & Throwing"),
    _m("pop_time",      "Pop Time",            "pop_time_2b_avg", "Arm & Throwing", lower_better=True),
    _m("csaa",          "Caught Stealing Above Average", "csaa", "Arm & Throwing"),
    *_frv_defs("Arm & Throwing"),
    *_drs_defs("Arm & Throwing"),
    _m("bp_tr",         "BP Takeoff Runs",     "bp_tr", "Arm & Throwing"),
    _m("bp_sr",         "BP Swipe Runs",       "bp_sr", "Arm & Throwing"),
    _m("blocks",        "Blocks Above Average", "blocks_above_average", "Blocking"),
    _m("bp_blk",        "BP Blocking Runs",    "bp_blk", "Blocking"),
    *_drs_defs("Blocking"),
    *_drs_defs("Other DRS"),
]
CATCHER_METRICS = [m for m in CATCHER_METRICS if not m["positions"] or "C" in m["positions"]]

INFIELDER_METRICS = [m for m in _OVERALL if m["key"] != "bp_cda"] + [
    _m("oaa_in",        "OAA In",    "oaa_in",    "Range"),
    _m("oaa_back",      "OAA Back",  "oaa_back",  "Range"),
    _m("oaa_left",      "OAA Left",  "oaa_left",  "Range"),
    _m("oaa_right",     "OAA Right", "oaa_right", "Range"),
    _m("oaa_success",   "OAA Success%",             "oaa_success_rate", "Range"),
    _m("esra",          "Estimated Success% Added", "estimated_success_rate_added", "Range"),
    _SAV_RANGE,
    *_drs_defs("Range"),
    _BP_RDA,
    *_drs_defs("Receiving"),
    _m("scoops",        "Scoops",    "fg_scp", "Receiving", positions={"1B"}),
    _m("arm_strength",  "Arm Strength", "arm_strength_pos", "Arm & Throwing"),
    _m("arm_overall",   "Arm Strength", "arm_strength_mph", "Arm & Throwing", scope="player",
       fallback_for="arm_strength_pos"),
    *_frv_defs("Arm & Throwing"),
    *_drs_defs("Arm & Throwing"),
    _BP_THR,
    *_drs_defs("Other DRS"),
]
INFIELDER_METRICS = [m for m in INFIELDER_METRICS if not m["positions"] or m["positions"] & INFIELD_POS]

OUTFIELDER_METRICS = [m for m in _OVERALL if m["key"] != "bp_cda"] + [
    _m("oaa_success",   "OAA Success%",             "oaa_success_rate", "Range"),
    _m("esra",          "Estimated Success% Added", "estimated_success_rate_added", "Range"),
    _m("jump",          "Jump Feet vs Average", "jump_feet_vs_avg",       "Range", scope="of_wide"),
    _m("five_star",     "5 Star Catch%",        "five_star_catch_rate",   "Range", scope="of_wide"),
    _m("four_star",     "4 Star Catch%",        "four_star_catch_rate",   "Range", scope="of_wide"),
    _m("three_star",    "3 Star Catch%",        "three_star_catch_rate",  "Range", scope="of_wide"),
    _SAV_RANGE,
    *_drs_defs("Range"),
    _BP_RDA,
    # Same number as FRV arm runs (r = 0.99) but not position-split: fallback only.
    _m("arm_value",     "Savant OF Arm Value",  "of_arm_value", "Arm & Throwing", scope="of_wide",
       fallback_for="frv_arm"),
    _m("arm_strength",  "Arm Strength",         "arm_strength_pos", "Arm & Throwing"),
    _m("arm_overall",   "Arm Strength", "arm_strength_mph", "Arm & Throwing", scope="player",
       fallback_for="arm_strength_pos"),
    *_frv_defs("Arm & Throwing"),
    *_drs_defs("Arm & Throwing"),
    _BP_THR,
    *_drs_defs("Other DRS"),
]
OUTFIELDER_METRICS = [m for m in OUTFIELDER_METRICS if not m["positions"] or m["positions"] & OUTFIELD_POS]


def _sum_def(m, label=None):
    d = dict(m)
    # `gate` keeps the base metric's positions: on the "All" tab the metric is
    # only ranked when the player's primary position is one it applies to.
    d.update(scope="sum", positions=None, gate=m["positions"], label=label or m["label"])
    return d


# "All" tab (players with 2+ qualified positions). Sums of position-split
# metrics plus the whole-player and OF-wide numbers. Catcher-only components
# (framing, pop time, BP catcher runs …) stay on the C tab.
_by_key = {m["key"]: m for m in CATCHER_METRICS + INFIELDER_METRICS + OUTFIELDER_METRICS}
ALL_METRICS = [
    _sum_def(_by_key["def"]),
    _sum_def(_by_key["drs"]),
    _sum_def(_by_key["oaa"]),
    _sum_def(_by_key["frv"]),
    _by_key["frv_total"],
    _by_key["drp"],
    _by_key["jump"], _by_key["five_star"], _by_key["four_star"], _by_key["three_star"],
    _sum_def(_by_key["frv_range"]),
    *[_sum_def(_by_key[k]) for k, _l, _c, _p, sec, s in FG_COMPONENTS if s and sec == "Range"],
    _by_key["rda"],
    *[_sum_def(_by_key[k]) for k, _l, _c, _p, sec, s in FG_COMPONENTS if s and sec == "Receiving"],
    _sum_def(_by_key["scoops"]),
    _by_key["arm_overall"],
    _by_key["arm_value"],
    *[_by_key[k] for k, *_r in FRV_COMPONENTS],
    *[_sum_def(_by_key[k]) for k, _l, _c, _p, sec, s in FG_COMPONENTS if s and sec == "Arm & Throwing"],
    _by_key["thr"],
    *[_sum_def(_by_key[k]) for k, _l, _c, _p, sec, s in FG_COMPONENTS if s and sec == "Other DRS"],
]

# Lower-case substring → canonical column name. Used as a fuzzy fallback if
# Savant has renamed a column between seasons.
COLUMN_ALIASES = {
    # OAA + directional splits
    "outs_above_average": ["outs_above_average", "oaa", "outs_above_avg"],
    "estimated_success_rate_added": ["estimated_success_rate_added", "est_success_rate_added",
                                       "estimated_success_added", "diff_success_rate",
                                       "estimated_success_rate_formatted_diff",
                                       "diff_success_rate_formatted",
                                       "success_rate_added_estimated", "success_rate_added"],
    # OAA leaderboard: actual catch/play success rate
    "oaa_success_rate": ["actual_success_rate_formatted", "actual_success_rate", "success_rate"],
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


def _oaa_numeric(df: Optional[pd.DataFrame]) -> Optional[pd.DataFrame]:
    """Savant's *_formatted columns on the OAA leaderboard are text ("85%",
    "+3%"). Turn them into numbers in percentage points, and map
    fielding_runs_prevented (OAA converted to runs) to Savant Range Runs —
    position-split for free, since OAA is fetched one position at a time."""
    if df is None:
        return df
    df = df.copy()
    for c in df.columns:
        if str(c).endswith("_formatted") and not pd.api.types.is_numeric_dtype(df[c]):
            num = pd.to_numeric(df[c].astype(str).str.replace("%", "", regex=False)
                                .str.replace("+", "", regex=False).str.strip(), errors="coerce")
            if num.notna().any():
                df[c] = num
    for c in ("actual_success_rate_formatted", "adj_estimated_success_rate_formatted",
              "diff_success_rate_formatted"):
        if c in df.columns:
            col = pd.to_numeric(df[c], errors="coerce")
            # Fractions (0.85) → percentage points (85.0) so every rate reads the same.
            if col.notna().any() and col.abs().max() <= 1.0:
                df[c] = col * 100
    if "fielding_runs_prevented" in df.columns and "frv_range" not in df.columns:
        df["frv_range"] = pd.to_numeric(df["fielding_runs_prevented"], errors="coerce")
    return df


def fetch_savant_oaa(year: int, fetch_url, csv_to_df) -> Optional[pd.DataFrame]:
    """Outs Above Average leaderboard. `split=yes` does NOT actually return
    per-position rows in the CSV — every player gets one row at their
    primary position — so multi-position players lose OAA on their
    secondary spots. Fetch once per Savant position code and tag the
    rows with that position, then concat."""
    if _env_url("SAVANT_OAA_URL", year):
        # Env override: assume the user has built a URL that returns
        # per-position rows already.
        url = _env_url("SAVANT_OAA_URL", year)
        df = _safe_fetch_csv(url, "Savant OAA", fetch_url, csv_to_df)
        return _apply_aliases(_ensure_id_name(_oaa_numeric(df)))

    frames = []
    for pos_name, pos_code in POS_CODE.items():
        url = (
            f"https://baseballsavant.mlb.com/leaderboard/outs_above_average"
            f"?type=Fielder&startYear={year}&endYear={year}&split=yes"
            f"&team=&range=year&min=1&pos={pos_code}&roles=&viz=show&csv=true"
        )
        df = _safe_fetch_csv(url, f"Savant OAA pos={pos_name}", fetch_url, csv_to_df)
        if df is None or df.empty:
            continue
        df = df.copy()
        # Force position to the queried slot so downstream merge_one(... "position", ...)
        # routes the row to the right (player, position) cell regardless of
        # what primary_pos_formatted says.
        df["position"] = pos_name
        frames.append(df)
    if not frames:
        return None
    combined = pd.concat(frames, ignore_index=True)
    print(f"    Savant OAA combined across positions: {len(combined)} rows")
    return _apply_aliases(_ensure_id_name(_oaa_numeric(combined)))


def _rename_frv_components(df: Optional[pd.DataFrame]) -> Optional[pd.DataFrame]:
    """Map Savant FRV component columns to our frv_* keys BEFORE the global
    alias pass (which would otherwise turn e.g. arm_runs into of_arm_value)."""
    if df is None:
        return df
    cols_lower = {c.lower(): c for c in df.columns}
    ren = {}
    for key, _lbl, cands, _pos, _sec in FRV_COMPONENTS:
        for cand in cands:
            real = cols_lower.get(cand.lower())
            if real is not None and real not in ren:
                ren[real] = key
                break
    for cand in _FRV_REC1B_COLS:
        real = cols_lower.get(cand)
        if real is not None:
            ren[real] = "frv_receiving"
            break
    known = set(ren)
    extra = [c for c in df.columns if c.lower().endswith("_runs") and c not in known
             and c.lower() not in _FRV_SKIPPED]
    print(f"    FRV components matched: {sorted(ren.values()) or 'none'}"
          f"{'  · unmatched *_runs columns: ' + str(extra) if extra else ''}")
    return df.rename(columns=ren)


def _frv_finish(df: Optional[pd.DataFrame], year: int) -> Optional[pd.DataFrame]:
    if df is None:
        return None
    if "year" in df.columns:
        df = df[pd.to_numeric(df["year"], errors="coerce") == year].reset_index(drop=True)
    df = _rename_frv_components(df)
    return _apply_aliases(_ensure_id_name(df))


def fetch_savant_frv(year: int, fetch_url, csv_to_df) -> Optional[pd.DataFrame]:
    """Fielding Run Value leaderboard, one row per player. Savant's CSV endpoint here is fragile —
    adding *any* extra query param (min=, type=, etc.) breaks it and returns
    the HTML page instead of CSV. Stick to the bare URL and live with the
    default ~qualified threshold; set SAVANT_FRV_URL to a UI-built URL
    (after adjusting filters on the page and copying the new CSV link) to
    broaden coverage for low-innings players."""
    url = _env_url("SAVANT_FRV_URL", year) or (
        "https://baseballsavant.mlb.com/leaderboard/fielding-run-value?csv=true"
    )
    df = _safe_fetch_csv(url, "Savant FRV", fetch_url, csv_to_df)
    df = _frv_finish(df, year)
    if df is not None:
        print(f"    Filtered FRV to year={year}: {len(df)} rows")
    return df


def fetch_savant_catcher_framing(year: int, fetch_url, csv_to_df) -> Optional[pd.DataFrame]:
    url = (
        f"https://baseballsavant.mlb.com/leaderboard/catcher-framing"
        f"?year={year}&team=&min=1&sort=4&sortDir=desc&csv=true"
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
        f"?year={year}&team=&min=1&pos=&csv=true"
    )
    df = _safe_fetch_csv(url, "Savant arm strength", fetch_url, csv_to_df)
    return _apply_aliases(_ensure_id_name(df))


def fetch_savant_csaa(year: int, fetch_url, csv_to_df) -> Optional[pd.DataFrame]:
    """Catcher caught-stealing above average. Lives under catcher-throwing."""
    url = (
        f"https://baseballsavant.mlb.com/leaderboard/catcher-throwing"
        f"?year={year}&team=&min=1&csv=true"
    )
    df = _safe_fetch_csv(url, "Savant catcher CSAA", fetch_url, csv_to_df)
    return _apply_aliases(_ensure_id_name(df))


def fetch_savant_catcher_blocks(year: int, fetch_url, csv_to_df) -> Optional[pd.DataFrame]:
    url = (
        f"https://baseballsavant.mlb.com/leaderboard/catcher-blocking"
        f"?year={year}&team=&min=1&csv=true"
    )
    df = _safe_fetch_csv(url, "Savant catcher blocking", fetch_url, csv_to_df)
    return _apply_aliases(_ensure_id_name(df))


def fetch_savant_of_jump(year: int, fetch_url, csv_to_df) -> Optional[pd.DataFrame]:
    # OF jump leaderboard uses `min` as opportunity (jump attempt) count,
    # not innings — a 50-innings outfielder typically only has a handful
    # of trackable jumps, so 50 returns header-only. Use the leaderboard's
    # qualified default instead.
    primary = (
        f"https://baseballsavant.mlb.com/leaderboard/outfield_jump"
        f"?year={year}&team=&min=1&csv=true"
    )
    fallbacks = [
        f"https://baseballsavant.mlb.com/leaderboard/of_jump?year={year}&min=1&csv=true",
        f"https://baseballsavant.mlb.com/leaderboard/jump?year={year}&min=1&csv=true",
        os.environ.get("SAVANT_OF_JUMP_URL", "").format(year=year) if os.environ.get("SAVANT_OF_JUMP_URL") else "",
    ]
    df = _safe_fetch_csv(primary, "Savant OF jump", fetch_url, csv_to_df, [u for u in fallbacks if u])
    return _apply_aliases(_ensure_id_name(df))


def fetch_savant_of_catch_prob(year: int, fetch_url, csv_to_df) -> Optional[pd.DataFrame]:
    """x-star catch% leaderboard."""
    url = (
        f"https://baseballsavant.mlb.com/leaderboard/catch_probability"
        f"?year={year}&team=&min=1&csv=true"
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

    # Standard fielding (type=0) carries 1B scoops (Scp).
    std_rows, _std_tc = _fetch_combo("fld", (0,))

    def _to_df(rows):
        return pd.DataFrame(rows) if rows else None

    df_def = _to_df(def_rows)
    df_drs = _to_df(drs_rows)
    df_std = _to_df(std_rows)

    # SIS (DRS + FRP) component columns present in this season's response.
    drs_comp_ren = {}
    if df_drs is not None:
        for key, _lbl, cands, _pos, _sec, _s in FG_COMPONENTS:
            real = next((c for c in cands if c in df_drs.columns), None)
            if real:
                drs_comp_ren[real] = key
        if "FRP" in df_drs.columns:
            drs_comp_ren["FRP"] = "frv_pos"     # Statcast FRV, by position
        r_cols = [c for c in df_drs.columns if c not in drs_comp_ren and c != "rTS"
                  and c not in FG_FRV_DUPLICATES
                  and ((len(c) > 1 and c[0] == "r" and c[1].isupper()) or c.endswith("FRP"))]
        print(f"    FG DRS / FRV components matched: {sorted(drs_comp_ren.values()) or 'none'}")
        if r_cols:
            print(f"    FG r* / *FRP columns not mapped: {r_cols}")

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
        # Keep Inn too — per-(player, position) innings used to gate qualification.
        # The MLB Stats API league endpoint now 406s, so FG's Inn is the source.
        keep = ["player_id", "player_name", "position"] + [c for c in list(value_cols) + ["Inn", "TeamName", "Team"] if c in df.columns]
        keep = [c for c in dict.fromkeys(keep) if c in df.columns]
        return df[keep]

    # FG ships the field-value column as "Defense" (not "Def").
    for d in (df_def, df_drs):
        if d is not None and "Defense" in d.columns and "Def" not in d.columns:
            d.rename(columns={"Defense": "Def"}, inplace=True)
    parts = [
        _slim(df_def, ["Def"]),
        _slim(df_drs, ["DRS"] + list(drs_comp_ren)),
        _slim(df_std, ["Scp"]),
    ]
    keys = ["player_id", "player_name", "position"]
    df = None
    for i, part in enumerate(parts):
        if part is None or part.empty:
            continue
        if df is None:
            df = part
            continue
        # Drop value columns the earlier frame already has (Inn / team / Def
        # can appear in several pulls) — then coalesce Inn and team.
        dup = [c for c in part.columns if c in df.columns and c not in keys]
        df = df.merge(part, on=keys, how="outer", suffixes=("", f"_p{i}"))
        for c in dup:
            sc = f"{c}_p{i}"
            if sc in df.columns:
                df[c] = df[c].where(df[c].notna(), df[sc])
                df = df.drop(columns=[sc])
    if df is None or df.empty:
        return None
    print(f"    → FG merged: {len(df)} rows  (Def from type={def_tc}, DRS from type={drs_tc})")
    ren = {}
    for canon, cands in {
        "fg_def":      ["Def"],
        "fg_drs":      ["DRS"],
        "fg_scp":      ["Scp"],
        "innings_pos": ["Inn"],
        "team_fg":     ["TeamName", "Team"],
    }.items():
        for c in cands:
            if c in df.columns and canon not in ren.values():
                ren[c] = canon
                break
    ren.update(drs_comp_ren)
    df = df.rename(columns=ren)
    if "player_id" in df.columns:
        df["player_id"] = pd.to_numeric(df["player_id"], errors="coerce").astype("Int64")
    print(f"    FG fielding columns: {list(df.columns)[:40]}")
    return df


# ────────────────────────────────────────────────────────────────────────────
# POSITION INNINGS  (from MLB Stats API — used to gate qualification)
# ────────────────────────────────────────────────────────────────────────────

def fetch_position_innings(year: int, http_headers: dict) -> Dict[int, Dict[str, float]]:
    """Return { player_id: { 'C': innings, '1B': innings, ... } }.

    Pulled from MLB Stats API's fielding stat endpoint paginated. Tries
    multiple URL variants because the `sportIds` / `sportId` param and the
    `group` vs `gameType` syntax have drifted across API versions.
    """
    base = "https://statsapi.mlb.com/api/v1/stats"
    LIMIT = 500
    templates = [
        f"{base}?stats=season&group=fielding&season={year}&sportIds=1&playerPool=All&limit={LIMIT}&offset={{offset}}",
        f"{base}?stats=season&group=fielding&season={year}&sportId=1&playerPool=All&limit={LIMIT}&offset={{offset}}",
        f"{base}?stats=season&group=fielding&season={year}&sportId=1&gameType=R&limit={LIMIT}&offset={{offset}}",
        f"{base}?stats=season&group=fielding&season={year}&sportId=1&limit={LIMIT}&offset={{offset}}",
    ]

    def _parse(sp):
        pid = (sp.get("player") or {}).get("id")
        pos = sp.get("position", {}).get("abbreviation")
        if not pid or pos not in POSITIONS:
            return
        inn = sp.get("stat", {}).get("innings")
        if inn is None:
            return
        try:
            whole, frac = str(inn).split(".") if "." in str(inn) else (str(inn), "0")
            innings = int(whole) + int(frac) / 3.0
        except Exception:
            innings = 0.0
        return int(pid), pos, innings

    for tmpl in templates:
        out: Dict[int, Dict[str, float]] = {}
        offset = 0
        got_any = False
        while True:
            url = tmpl.format(offset=offset)
            try:
                r = requests.get(url, headers=http_headers, timeout=30)
                r.raise_for_status()
            except Exception as e:
                print(f"  ⚠ MLB fielding fetch failed: {e}")
                break
            # Collect splits from ALL stat-group entries (the API sometimes
            # wraps multiple groups; taking only [0] misses data).
            all_splits = []
            for entry in (r.json().get("stats") or []):
                all_splits.extend(entry.get("splits") or [])
            if not all_splits:
                break
            got_any = True
            for sp in all_splits:
                parsed = _parse(sp)
                if parsed:
                    pid, pos, inn = parsed
                    out.setdefault(pid, {})[pos] = inn
            if len(all_splits) < LIMIT:
                break
            offset += LIMIT
        if out:
            print(f"  Position innings: {len(out)} players (URL variant: {tmpl[:80]}…)")
            return out
        if got_any:
            print(f"  ⚠ MLB API returned splits but no parseable innings ({tmpl[:80]}…)")

    print(f"  ⚠ All MLB innings API variants returned 0 — will fall back to OAA presence")
    return {}


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


def _coerce(x) -> Optional[float]:
    try:
        f = float(x)
        return f if f == f else None  # drop NaN
    except (TypeError, ValueError):
        return None


def _r1(x: float) -> float:
    """Round to tenths; `+ 0.0` turns -0.0 into 0.0."""
    return round(x, 1) + 0.0


# ────────────────────────────────────────────────────────────────────────────
# BASEBALL PROSPECTUS  (DRP + catcher defense, from exports in data/bp/)
# ────────────────────────────────────────────────────────────────────────────

BP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "bp")


def _read_bp(path: str) -> Optional[pd.DataFrame]:
    if not os.path.exists(path):
        print(f"  BP export not found: {path} — BP metrics skipped")
        return None
    df = pd.read_csv(path, encoding="utf-8-sig")
    # BP repeats a "+/-" (standard error) header after each stat; pandas
    # de-dupes them as "+/-", "+/-.1" … — name each after the stat before it.
    cols = list(df.columns)
    for i, c in enumerate(cols):
        if str(c).startswith("+/-") and i > 0:
            cols[i] = f"{cols[i - 1]}_sd"
    df.columns = cols
    df["player_id"] = pd.to_numeric(df.get("mlbid"), errors="coerce").astype("Int64")
    df = df[df["player_id"].notna()]
    print(f"  BP export {os.path.basename(path)}: {len(df)} rows")
    return df


def merge_bp(year: int, stamp, pvals: Dict[int, dict]) -> None:
    """DRP / RDA / THR are whole-player (BP doesn't split by position) →
    pvals. The catcher export is catching-only → the (pid, 'C') cell."""
    drp = _read_bp(os.path.join(BP_DIR, f"bp_drp_{year}.csv"))
    if drp is not None:
        for _, r in drp.iterrows():
            d = pvals.setdefault(int(r["player_id"]), {})
            for src, col in (("bp_drp", "DRP"), ("bp_rda", "RDA"), ("bp_thr", "THR")):
                v = _coerce(r.get(col))
                if v is not None:
                    d[src] = v
            if r.get("Name") and not d.get("_name"):
                d["_name"] = str(r["Name"])
    cat = _read_bp(os.path.join(BP_DIR, f"bp_catcher_{year}.csv"))
    if cat is not None:
        for _, r in cat.iterrows():
            cell = stamp(int(r["player_id"]), "C", name=str(r.get("Name") or "") or None)
            for src, col in (("bp_frm", "FrmR"), ("bp_blk", "BlkR"), ("bp_tr", "TR"),
                             ("bp_sr", "SR"), ("bp_cda", "CDA")):
                v = _coerce(r.get(col))
                if v is not None:
                    cell[src] = v


# ────────────────────────────────────────────────────────────────────────────
# FRAMING ZONES  (Savant catcher-framing shadow-zone strike rates)
# ────────────────────────────────────────────────────────────────────────────

_ZONE_RE = re.compile(r"^(?:pct|strike_rate|called_strike_rate|cs_rate)_?(1[1-46-9])$", re.I)
_ZONE_RV_RE = re.compile(r"^(?:rv|runs|runs_extra_strikes)_?(1[1-46-9])$", re.I)


def extract_framing_zones(framing: Optional[pd.DataFrame]) -> Dict[int, dict]:
    """{pid: {"11": {"rate": .., "rv": ..}, ...}} for the 8 shadow zones
    (Savant numbers them 11–19 around the heart, skipping 15)."""
    if framing is None or "player_id" not in framing.columns:
        return {}
    rate_cols = {m.group(1): c for c in framing.columns if (m := _ZONE_RE.match(str(c)))}
    rv_cols = {m.group(1): c for c in framing.columns if (m := _ZONE_RV_RE.match(str(c)))}
    print(f"  Framing zone columns: rate={sorted(rate_cols)} rv={sorted(rv_cols)}")
    if not rate_cols:
        return {}
    out: Dict[int, dict] = {}
    for _, r in framing.iterrows():
        pid = r.get("player_id")
        if pd.isna(pid):
            continue
        zones = {}
        for z, c in rate_cols.items():
            v = _coerce(r.get(c))
            if v is None:
                continue
            zones[z] = {"rate": v}
            if z in rv_cols:
                rv = _coerce(r.get(rv_cols[z]))
                if rv is not None:
                    zones[z]["rv"] = rv
        if zones:
            out[int(pid)] = zones
    return out


# ────────────────────────────────────────────────────────────────────────────
# ASSEMBLY  — gate, place metrics on tabs, percentiles, JSON
# ────────────────────────────────────────────────────────────────────────────

def _cat(v: float, pool: List[float], m: dict) -> dict:
    pct = _pct(v, pool, m["lower_better"]) if len(pool) >= MIN_POOL else None
    disp = v * m["mult"] if m.get("mult") else v
    disp = _r1(disp)
    return {"display": _fmt(disp, ".1f"), "pctile": pct, "value": disp}


def _metric_meta(ms: List[dict]) -> List[dict]:
    out = []
    for m in ms:
        d = {"key": m["key"], "label": m["label"], "lower_better": m["lower_better"],
             "section": m["section"], "scope": m["scope"]}
        if m.get("positions"):
            d["positions"] = [p for p in POSITIONS if p in m["positions"]]
        out.append(d)
    return out


def _assemble(year: int, cells: Dict[tuple, dict], pvals: Dict[int, dict],
              inn_map: Dict[int, Dict[str, float]], team_map: Optional[Dict[int, str]] = None,
              zones: Optional[Dict[int, dict]] = None, sources: Optional[List[str]] = None) -> dict:
    team_map = team_map or {}
    zones = zones or {}

    # 1. Qualification: ≥ MIN_INN innings at the position.
    qual: Dict[int, Dict[str, float]] = {}
    for (pid, pos) in cells:
        inn = inn_map.get(pid, {}).get(pos, 0.0)
        if inn >= MIN_INN:
            qual.setdefault(pid, {})[pos] = inn
    print(f"  Qualified (player, position) rows ≥ {MIN_INN} inn: {sum(len(q) for q in qual.values())}")
    primary = {pid: max(q, key=lambda p: (q[p], -POSITIONS.index(p))) for pid, q in qual.items()}
    of_spots = {pid: [p for p in q if p in OUTFIELD_POS] for pid, q in qual.items()}
    cells_by_pid: Dict[int, Dict[str, dict]] = {}
    for (pid, pos), c in cells.items():
        cells_by_pid.setdefault(pid, {})[pos] = c

    def pv(pid, src):
        return _coerce(pvals.get(pid, {}).get(src))

    def on_pos_card(m, pid, pos) -> bool:
        # A stand-in (overall arm strength, per-player FRV) never shows next to
        # the position-split value it stands in for.
        if m.get("fallback_for") and _coerce(cells[(pid, pos)].get(m["fallback_for"])) is not None:
            return False
        if m["scope"] == "player":
            return len(qual[pid]) == 1
        if m["scope"] == "of_wide":
            return pos in OUTFIELD_POS and len(of_spots[pid]) == 1
        return m["scope"] == "pos"

    # 2. Whole-player values for the "All" tab (computed for every player so
    #    single-position players still populate the primary-position pools).
    comb: Dict[int, dict] = {}
    for pid in qual:
        d = {}
        for m in ALL_METRICS:
            if m["scope"] == "sum":
                vals = [_coerce(c.get(m["src_col"])) for c in cells_by_pid.get(pid, {}).values()]
                vals = [v for v in vals if v is not None]
                d[m["key"]] = sum(vals) if vals else None
            else:
                d[m["key"]] = pv(pid, m["src_col"])
        comb[pid] = d

    def entry(pid):
        if pid not in fielders:
            c0 = next(iter(cells_by_pid.get(pid, {}).values()), {})
            name = c0.get("name") or pvals.get(pid, {}).get("_name")
            fielders[pid] = {
                "player_id": pid,
                "name": _flip_name(name) or "",
                "team": team_map.get(pid) or c0.get("team") or "",
                "positions": {},
            }
        return fielders[pid]

    # 3. Position tabs — percentiles within the position.
    fielders: Dict[int, dict] = {}
    by_pos: Dict[str, List[int]] = {}
    for pid, q in qual.items():
        for pos in q:
            by_pos.setdefault(pos, []).append(pid)
    for pos in POSITIONS:
        pids = by_pos.get(pos, [])
        if not pids:
            continue
        mlist = [m for m in _metrics_for(_grp(pos)) if not m["positions"] or pos in m["positions"]]
        pools = {}
        for m in mlist:
            if m["scope"] == "pos":
                raw = [_coerce(cells[(p, pos)].get(m["src_col"])) for p in pids]
            else:
                raw = [pv(p, m["src_col"]) for p in pids]
            pools[m["key"]] = [v for v in raw if v is not None]
        for pid in pids:
            cats = {}
            for m in mlist:
                if not on_pos_card(m, pid, pos):
                    continue
                v = (_coerce(cells[(pid, pos)].get(m["src_col"])) if m["scope"] == "pos"
                     else pv(pid, m["src_col"]))
                if v is None:
                    continue
                cats[m["key"]] = _cat(v, pools[m["key"]], m)
            entry(pid)["positions"][pos] = {"innings": _r1(qual[pid][pos]), "categories": cats}

        # Framing zones: rate per shadow zone, percentile within qualified C.
        if pos == "C" and zones:
            zpids = [p for p in pids if p in zones]
            zkeys = sorted({z for p in zpids for z in zones[p]})
            zpool = {z: [zones[p][z]["rate"] for p in zpids if z in zones[p]] for z in zkeys}
            allr = [v for vs in zpool.values() for v in vs]
            zmult = 100.0 if allr and max(allr) <= 1.0 else 1.0
            for p in zpids:
                zout = {}
                for z, zd in zones[p].items():
                    pool = zpool.get(z, [])
                    zo = {"rate": _r1(zd["rate"] * zmult),
                          "lg": _r1(float(np.mean(pool)) * zmult) if pool else None,
                          "pctile": _pct(zd["rate"], pool, False) if len(pool) >= MIN_POOL else None}
                    if "rv" in zd:
                        zo["rv"] = _r1(zd["rv"])
                    zout[z] = zo
                fielders[p]["positions"]["C"]["framing_zones"] = zout

    # 4. "All" tab for players with 2+ qualified positions — percentiles
    #    among players sharing the same primary position.
    by_primary: Dict[str, List[int]] = {}
    for pid, p in primary.items():
        by_primary.setdefault(p, []).append(pid)
    n_all = 0
    for pid, q in qual.items():
        if len(q) < 2:
            continue
        peers = by_primary[primary[pid]]
        cats = {}
        for m in ALL_METRICS:
            if m["scope"] == "of_wide" and len(of_spots[pid]) < 2:
                continue
            if m.get("fallback_for") and any(
                    s2["scope"] == "sum" and s2["src_col"] == m["fallback_for"] and comb[pid][s2["key"]] is not None
                    for s2 in ALL_METRICS):
                continue
            # Ranked against same-primary-position peers, so skip metrics that
            # don't apply at the primary position (e.g. OAA / BP RDA for a
            # primary catcher) — they're on the tab where they were earned.
            gate = m.get("gate", m["positions"])
            if gate and primary[pid] not in gate:
                continue
            v = comb[pid][m["key"]]
            if v is None:
                continue
            pool = [comb[p][m["key"]] for p in peers if comb[p][m["key"]] is not None]
            cats[m["key"]] = _cat(v, pool, m)
        total_inn = sum(inn for pos, inn in inn_map.get(pid, {}).items() if pos in POSITIONS)
        entry(pid)["combined"] = {
            "innings": _r1(max(total_inn, sum(q.values()))),
            "primary": primary[pid],
            "positions": {p: _r1(q[p]) for p in POSITIONS if p in q},
            "categories": cats,
        }
        n_all += 1

    out = {
        "season": year,
        "catcher_metrics":    _metric_meta(CATCHER_METRICS),
        "infielder_metrics":  _metric_meta(INFIELDER_METRICS),
        "outfielder_metrics": _metric_meta(OUTFIELDER_METRICS),
        "all_metrics":        _metric_meta(ALL_METRICS),
        "fielders": sorted(fielders.values(), key=lambda f: f["name"] or ""),
        "meta": {
            "min_innings": MIN_INN,
            "min_pool": MIN_POOL,
            "sources": sources or ["Savant", "FanGraphs", "BP"],
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
        },
    }
    print(f"  Fielders with ≥1 qualified position: {len(out['fielders'])}  ({n_all} with an All tab)")
    return out


def _put(cell_or_dict: dict, r, cols: List[str]):
    for c in cols:
        if c in r:
            v = _coerce(r[c])
            if v is not None:
                cell_or_dict[c] = v


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

    # Primary innings source: FanGraphs "Inn" per (player, position). The MLB
    # Stats API league stats endpoint now returns 406 (fetch_position_innings
    # comes back empty), but the FG fielding pull above already carries real
    # per-position innings — use them to gate qualification and to show on cards.
    if not inn_map and fg is not None and "innings_pos" in fg.columns:
        for _, r in fg.iterrows():
            pid = r.get("player_id")
            pos = _normalise_pos(r.get("position"))
            inn = _value(r, "innings_pos")
            if pd.isna(pid) or not pos or inn is None:
                continue
            inn_map.setdefault(int(pid), {})[pos] = float(inn)
        if inn_map:
            print(f"  Position innings from FanGraphs Inn: {len(inn_map)} players")

    # Fallback: if no innings source worked, build a synthetic inn_map from
    # OAA — fetched per position with min=1 — crediting MIN_INN innings to
    # each (player, position) pair so they pass the qualification gate.
    if not inn_map and oaa is not None:
        print(f"  Building synthetic inn_map from OAA position data (fallback)")
        for _, row in oaa.iterrows():
            pid = row.get("player_id")
            pos = row.get("position")
            try:
                pid = int(pid)
            except (TypeError, ValueError):
                continue
            if not pos:
                continue
            inn_map.setdefault(pid, {})[pos] = float(MIN_INN)
        print(f"  Synthetic inn_map: {len(inn_map)} players from OAA")

    # Savant OAA carries no catcher rows, so neither the Stats-API innings feed
    # (when it drops catchers) nor the OAA-based synthetic fallback ever lets a
    # catcher clear the innings gate. Backfill: credit MIN_INN at "C" to every
    # player who shows up in a catcher leaderboard and isn't already carrying
    # real C innings.
    n_catch = 0
    for cdf in (framing, poptime, csaa, blocks):
        if cdf is None or "player_id" not in cdf.columns:
            continue
        for pid in cdf["player_id"].dropna().tolist():
            try:
                pid = int(pid)
            except (TypeError, ValueError):
                continue
            pos_map = inn_map.setdefault(pid, {})
            if "C" not in pos_map:
                pos_map["C"] = float(MIN_INN)
                n_catch += 1
    if n_catch:
        print(f"  Credited synthetic C innings to {n_catch} catchers (catcher leaderboards)")

    # 2. Raw values: position-split cells keyed (pid, pos), whole-player /
    #    OF-wide values keyed pid.
    cells: Dict[tuple, dict] = {}
    pvals: Dict[int, dict] = {}

    def stamp(pid: int, pos: str, name: str = None, team: str = None):
        key = (pid, pos)
        if key not in cells:
            cells[key] = {"player_id": pid, "position": pos, "name": name, "team": team}
        else:
            if name and not cells[key].get("name"):    cells[key]["name"] = name
            if team and not cells[key].get("team"):    cells[key]["team"] = team
        return cells[key]

    def _nm(r):
        n = r.get("player_name")
        return str(n) if isinstance(n, str) else None

    def merge_one(df, pos_field: Optional[str], val_cols: List[str], default_pos: Optional[str] = None):
        if df is None:
            return
        for _, r in df.iterrows():
            pid = r.get("player_id")
            if pd.isna(pid):
                continue
            pos = _normalise_pos(r.get(pos_field)) if pos_field else default_pos
            if not pos:
                continue
            team = r.get("team_abbr") or r.get("team") or r.get("team_id")
            cell = stamp(int(pid), pos, name=_nm(r), team=str(team) if isinstance(team, str) else None)
            _put(cell, r, val_cols)

    def merge_player(df, val_cols: List[str]):
        if df is None:
            return
        for _, r in df.iterrows():
            pid = r.get("player_id")
            if pd.isna(pid):
                continue
            d = pvals.setdefault(int(pid), {})
            if _nm(r) and not d.get("_name"):
                d["_name"] = _nm(r)
            _put(d, r, val_cols)

    frv_comp_keys = [k for k, *_r in FRV_COMPONENTS]

    # OAA: per (player, position) row directly
    merge_one(oaa, "position", [
        "outs_above_average", "estimated_success_rate_added", "oaa_success_rate",
        "oaa_in", "oaa_back", "oaa_left", "oaa_right", "frv_range",
    ])
    # FRV: one row per player → whole-player total and components.
    merge_player(frv, ["frv"] + frv_comp_keys)
    if frv is not None and "frv_receiving" in frv.columns:
        n_rec = 0
        for _, r in frv.iterrows():
            pid = r.get("player_id")
            if pd.isna(pid) or _coerce(r.get("frv_receiving")) is None:
                continue
            if inn_map.get(int(pid), {}).get("1B", 0) > 0:
                _put(stamp(int(pid), "1B", name=_nm(r)), r, ["frv_receiving"])
                n_rec += 1
        print(f"  Savant 1B receiving attached to {n_rec} first basemen")

    # Catcher framing / pop / csaa / blocks → all default to C
    merge_one(framing, None, ["framing_runs", "shadow_zone_called_strike_rate"], default_pos="C")
    zones = extract_framing_zones(framing)
    # Pop time also carries the catcher's max-effort arm strength on caught
    # stealing throws — Savant's arm-strength leaderboard does NOT include
    # catchers, so this is the C arm strength.
    if poptime is not None and "maxeff_arm_2b_3b_sba" in poptime.columns:
        poptime = poptime.copy()
        poptime["arm_strength_pos"] = pd.to_numeric(poptime["maxeff_arm_2b_3b_sba"], errors="coerce")
    merge_one(poptime, None, ["pop_time_2b_avg", "arm_strength_pos"], default_pos="C")
    merge_one(csaa, None, ["csaa"], default_pos="C")
    merge_one(blocks, None, ["blocks_above_average"], default_pos="C")

    # OF jump / catch prob / arm value: one row per player covering all OF
    # spots → OF-wide values (placed by _assemble).
    merge_player(jump,   ["jump_feet_vs_avg"])
    merge_player(catchp, ["five_star_catch_rate", "four_star_catch_rate", "three_star_catch_rate"])
    merge_player(ofarm,  ["of_arm_value"])

    # Arm strength: overall (all throws) is whole-player; the leaderboard
    # also ships per-position columns (arm_1b, arm_ss, arm_cf …).
    if arms is not None:
        merge_player(arms, ["arm_strength_mph"])
        cols_lower = {c.lower(): c for c in arms.columns}
        pos_cols = {p: cols_lower[f"arm_{p.lower()}"] for p in NON_C if f"arm_{p.lower()}" in cols_lower}
        print(f"  Arm strength per-position columns: {sorted(pos_cols)}")
        for _, r in arms.iterrows():
            pid = r.get("player_id")
            if pd.isna(pid):
                continue
            for pos, col in pos_cols.items():
                v = _coerce(r.get(col))
                if v is None or inn_map.get(int(pid), {}).get(pos, 0) <= 0:
                    continue
                stamp(int(pid), pos, name=_nm(r))["arm_strength_pos"] = v

    # FG fielding: one row per (player, position) — Def, DRS + components, scoops
    fg_cols = ["fg_def", "fg_drs", "frv_pos", "fg_scp"] + [k for k, *_r in FG_COMPONENTS]
    if fg is not None and "position" in fg.columns:
        for _, r in fg.iterrows():
            pid = r.get("player_id")
            if pd.isna(pid):
                continue
            pos = _normalise_pos(r.get("position"))
            if not pos:
                continue
            cell = stamp(int(pid), pos, name=str(r.get("player_name") or ""),
                         team=str(r.get("team_fg") or ""))
            _put(cell, r, fg_cols)

    merge_bp(year, stamp, pvals)

    return _assemble(year, cells, pvals, inn_map, team_map, zones)


# ────────────────────────────────────────────────────────────────────────────
# OFFLINE RESTRUCTURE  — re-place / re-rank an already-built JSON
# ────────────────────────────────────────────────────────────────────────────

# Old (pre-"All" tab) labels → (src_col, scope, mult). In the old files FRV,
# OF jump / catch% / arm value and overall arm strength were copied onto every
# position; here they go back to a single per-player value.
_OLD_LABELS = {
    "Def":                           ("fg_def", "pos", None),
    "DRS":                           ("fg_drs", "pos", None),
    "OAA":                           ("outs_above_average", "pos", None),
    "OAA In":                        ("oaa_in", "pos", None),
    "OAA Back":                      ("oaa_back", "pos", None),
    "OAA Left":                      ("oaa_left", "pos", None),
    "OAA Right":                     ("oaa_right", "pos", None),
    "Estimated Success% Added":      ("estimated_success_rate_added", "pos", None),
    "FRV":                           ("frv", "player", None),
    "Pop Time":                      ("pop_time_2b_avg", "pos", None),
    "Caught Stealing Above Average": ("csaa", "pos", None),
    "Framing Runs":                  ("framing_runs", "pos", None),
    "Shadow Strike%":                ("shadow_zone_called_strike_rate", "pos", 100),
    "Blocks Above Average":          ("blocks_above_average", "pos", None),
    "5 Star Catch%":                 ("five_star_catch_rate", "player", None),
    "4 Star Catch%":                 ("four_star_catch_rate", "player", None),
    "3 Star Catch%":                 ("three_star_catch_rate", "player", None),
    "Jump Feet vs Average":          ("jump_feet_vs_avg", "player", None),
    "Arm Value":                     ("of_arm_value", "player", None),
    # At C this was the pop-time max-effort arm (position-specific); anywhere
    # else it was the overall arm copied to every position.
    "Arm Strength":                  (None, None, None),
}


def restructure_json(path: str, year: int) -> Optional[dict]:
    with open(path) as f:
        old = json.load(f)
    if old.get("all_metrics") is not None:
        # Values in the new layout are rounded to tenths; re-ranking them
        # would create ties and shift percentiles. Rebuild from source
        # (baseball_pipeline.py) instead.
        print(f"  {path} is already in the new layout — skipped")
        return None
    cells: Dict[tuple, dict] = {}
    pvals: Dict[int, dict] = {}
    inn_map: Dict[int, Dict[str, float]] = {}
    team_map: Dict[int, str] = {}

    for fd in old.get("fielders", []):
        pid = int(fd["player_id"])
        if fd.get("team"):
            team_map[pid] = fd["team"]
        for pos, pdata in (fd.get("positions") or {}).items():
            inn_map.setdefault(pid, {})[pos] = float(pdata.get("innings") or 0)
            cell = cells.setdefault((pid, pos), {"player_id": pid, "position": pos,
                                                 "name": fd.get("name"), "team": fd.get("team")})
            for lbl, cat in (pdata.get("categories") or {}).items():
                v = _coerce((cat or {}).get("value"))
                if v is None:
                    continue
                src, scope, mult = _OLD_LABELS.get(lbl, (None, None, None))
                if lbl == "Arm Strength":
                    src, scope = ("arm_strength_pos", "pos") if pos == "C" else ("arm_strength_mph", "player")
                if not src:
                    continue
                raw = v / mult if mult else v
                (cell if scope == "pos" else pvals.setdefault(pid, {}))[src] = raw

    def stamp(pid, pos, name=None, team=None):
        key = (pid, pos)
        if key not in cells:
            cells[key] = {"player_id": pid, "position": pos, "name": name, "team": team}
        elif name and not cells[key].get("name"):
            cells[key]["name"] = name
        return cells[key]

    merge_bp(year, stamp, pvals)
    # BP's catcher export lists catchers who never cleared the innings gate in
    # the old file; keep them out (no innings → not qualified), as before.
    return _assemble(year, cells, pvals, inn_map, team_map)


if __name__ == "__main__":
    import sys
    args = sys.argv[1:]
    if len(args) >= 2 and args[0] == "--restructure":
        out_dir, years = args[1], [int(y) for y in args[2:]]
        for y in years:
            p = os.path.join(out_dir, f"fielding_data_{y}.json")
            print(f"\n── Restructuring {p}")
            data = restructure_json(p, y)
            if data is None:
                continue
            with open(p, "w") as f:
                json.dump(data, f, indent=2, default=str)
            print(f"  → Wrote {p} ({len(data['fielders'])} fielders)")
    else:
        print("Usage: python3 fielding_pipeline.py --restructure <public_dir> <year> [<year> …]\n"
              "(The full fetch runs from baseball_pipeline.py.)")
