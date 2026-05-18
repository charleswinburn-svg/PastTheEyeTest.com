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
    {"key": "oz_swing_percent",  "label": "Chase %",             "lower_better": True,  "fmt": ".1f"},
    {"key": "k_percent",         "label": "K%",                  "lower_better": True,  "fmt": ".1f"},
    {"key": "iz_contact_percent","label": "Z-Contact%",          "lower_better": False, "fmt": ".1f"},
    {"key": "whiff_percent",     "label": "Whiff %",             "lower_better": True,  "fmt": ".1f"},
    {"key": "bb_percent",        "label": "BB%",                 "lower_better": False, "fmt": ".1f"},
]

# AAA pitcher metric set is a subset of MLB — FIP and GB% aren't on the
# Prospect Savant payload, so we drop them. Avg FB Velo is replaced with
# Avg Velo (overall pitch velocity) since per-pitch-type velos aren't on
# the leaderboard either.
AAA_PITCHER_METRICS_LABELS = [
    "Avg Velo", "Avg Exit Velo", "Barrel%", "xBA", "xSLG", "xwOBA",
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
PROSPECT_MIN_PITCHES = 100  # broad bar so part-time players show up
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
    """No-op (Savant pitch movement page doesn't expose AAA cleanly). Avg FB
    Velo comes from the Prospect Savant pitcher payload's avg_fb_velo field
    when it exists; otherwise the bubble stays blank."""
    return None


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
            hitter_rows.append({
                "name": str(name),
                "player_id": pid,
                "team": (team_map or {}).get(pid),
                "pa": int(r["pa"]) if "pa" in r and pd.notna(r.get("pa")) else None,
                "categories": cats,
            })

    # 4. Build pitcher percentiles (mirror MLB metric set; values come from
    # AAA pools so percentile rank is within AAA only)
    pitcher_rows = []
    # Map AAA pitcher label → canonical column key (already renamed by
    # _coerce_cols from Prospect Savant field names).
    p_label_to_col = {
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
        p_lower = {"Avg Exit Velo", "Barrel%", "xBA", "xSLG", "xwOBA", "BB%"}

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
            pitcher_rows.append({
                "name": str(name),
                "player_id": pid,
                "team": (team_map or {}).get(pid),
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
             {"Avg Exit Velo", "Barrel%", "xBA", "xSLG", "xwOBA", "BB%"}}
            for lbl in AAA_PITCHER_METRICS_LABELS
        ],
        "meta": {
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
        },
    }
