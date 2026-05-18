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
    {"key": "xwobacon",          "label": "xwOBACON",            "lower_better": False, "fmt": ".3f"},
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

# Same pitcher metric set as MLB. Keys must match baseball_pipeline.PITCHER_METRICS
# so the React card renders uniformly across levels.
AAA_PITCHER_METRICS_LABELS = [
    "FIP", "Avg Exit Velo", "Barrel%", "xBA", "xSLG", "xwOBA", "Avg FB Velo",
    "Whiff%", "K%", "Chase%", "BB%", "K-BB%", "GB%",
]


# ────────────────────────────────────────────────────────────────────────────
# SAVANT MiLB FETCHERS
# ────────────────────────────────────────────────────────────────────────────
# Savant's minor-league leaderboards live at
#   /leaderboard/minor-league?typ=<view>&lvl=aaa&year=<y>&csv=true
# `sportId=11` is NOT how AAA is selected — it's `lvl=aaa`. `typ` selects the
# stat view; each view returns a different column set. We pull a few views
# and merge by player_id.

MILB_BASE = "https://baseballsavant.mlb.com/leaderboard/minor-league"


def _milb_url(typ, lvl, year, **extras):
    parts = [f"typ={typ}", f"lvl={lvl}", f"year={year}", "csv=true"]
    parts += [f"{k}={v}" for k, v in extras.items()]
    return f"{MILB_BASE}?{'&'.join(parts)}"


def _safe_milb(typ, year, fetch_url, csv_to_df, lvl="aaa", **extras):
    url = _milb_url(typ, lvl, year, **extras)
    print(f"  Fetching MiLB {typ} ({lvl} {year})...")
    text = fetch_url(url)
    df = csv_to_df(text)
    if df is None or df.empty:
        print(f"    ⚠ {typ} returned no rows")
        return None
    print(f"    ✓ {len(df)} rows, columns: {list(df.columns)[:14]}{' …' if len(df.columns) > 14 else ''}")
    # Normalize player_id
    for c in ("player_id", "id", "playerid", "MLBAMID"):
        if c in df.columns:
            df["player_id"] = pd.to_numeric(df[c], errors="coerce").astype("Int64")
            break
    return df


def fetch_savant_expected_aaa(year, fetch_url, csv_to_df, player_type="batter"):
    typ = "expected_statistics_batter" if player_type == "batter" else "expected_statistics_pitcher"
    # Some Savant deployments use plain `expected_statistics` with a player_type
    # filter, others use the suffixed form. Try the canonical first, then the
    # suffixed name.
    for t in ("expected_statistics", typ):
        df = _safe_milb(t, year, fetch_url, csv_to_df, player_type=player_type)
        if df is not None:
            ren = {"est_slg": "xslg", "est_ba": "xba", "est_woba": "xwoba"}
            df = df.rename(columns={k: v for k, v in ren.items() if k in df.columns})
            return df
    return None


def fetch_savant_ev_barrels_aaa(year, fetch_url, csv_to_df, player_type="batter"):
    return _safe_milb("exit_velocity_barrels", year, fetch_url, csv_to_df, player_type=player_type)


def fetch_savant_batted_ball_aaa(year, fetch_url, csv_to_df, player_type="batter"):
    """Batted-ball profile: LD% / FB% / GB% etc."""
    return _safe_milb("batted_ball", year, fetch_url, csv_to_df, player_type=player_type)


def fetch_savant_plate_discipline_aaa(year, fetch_url, csv_to_df, player_type="batter"):
    return _safe_milb("plate_discipline", year, fetch_url, csv_to_df, player_type=player_type)


def fetch_savant_standard_aaa(year, fetch_url, csv_to_df, player_type="batter"):
    """Standard hitting/pitching stats — includes FIP for pitchers, AB/H/BB
    for batters."""
    typ = "hitting" if player_type == "batter" else "pitching"
    return _safe_milb(typ, year, fetch_url, csv_to_df, player_type=player_type)


def fetch_aaa_pitch_movement(year, fetch_url, csv_to_df, pitch_type="FF"):
    """AAA pitch movement leaderboard for FB velo. Same MLB URL but with
    lvl=aaa appended; if Savant rejects, we'll fall back to no data."""
    url = (
        f"https://baseballsavant.mlb.com/leaderboard/pitch-movement"
        f"?year={year}&team=&pitchType={pitch_type}&min=q&sort=7&sortDir=asc&lvl=aaa&csv=true"
    )
    print(f"  Fetching MiLB pitch movement ({pitch_type}, AAA {year})...")
    text = fetch_url(url)
    df = csv_to_df(text)
    if df is None or df.empty:
        print(f"    ⚠ no rows for {pitch_type}")
        return None
    print(f"    ✓ {len(df)} rows")
    return df


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

    # 1. Hitters — pull each MiLB leaderboard view and merge on player_id
    expected_h = fetch_savant_expected_aaa(year, fetch_url, csv_to_df, "batter")
    time.sleep(1.0)
    ev_h = fetch_savant_ev_barrels_aaa(year, fetch_url, csv_to_df, "batter")
    time.sleep(1.0)
    bb_h = fetch_savant_batted_ball_aaa(year, fetch_url, csv_to_df, "batter")
    time.sleep(1.0)
    pd_h = fetch_savant_plate_discipline_aaa(year, fetch_url, csv_to_df, "batter")
    time.sleep(1.0)

    # Normalize LD column from the batted-ball view if present.
    if bb_h is not None:
        for cand in ("ld_percent", "line_drive_percent", "ld_rate", "ld_pct"):
            if cand in bb_h.columns:
                bb_h = bb_h.rename(columns={cand: "ld_pct"})
                break

    h_frames = []
    for d in (expected_h, ev_h, bb_h, pd_h):
        if d is None or d.empty:
            continue
        if "player_id" in d.columns:
            d = d.copy()
            d["player_id"] = pd.to_numeric(d["player_id"], errors="coerce").astype("Int64")
        h_frames.append(d)
    hitters_df = None
    for d in h_frames:
        if hitters_df is None:
            hitters_df = d
        else:
            hitters_df = hitters_df.merge(d, on="player_id", how="outer", suffixes=("", "_drop"))
            hitters_df = hitters_df.loc[:, ~hitters_df.columns.str.endswith("_drop")]

    # 2. Pitchers — same MiLB views, pitcher side
    expected_p = fetch_savant_expected_aaa(year, fetch_url, csv_to_df, "pitcher")
    time.sleep(1.0)
    ev_p = fetch_savant_ev_barrels_aaa(year, fetch_url, csv_to_df, "pitcher")
    time.sleep(1.0)
    pd_p = fetch_savant_plate_discipline_aaa(year, fetch_url, csv_to_df, "pitcher")
    time.sleep(1.0)
    std_p = fetch_savant_standard_aaa(year, fetch_url, csv_to_df, "pitcher")
    time.sleep(1.0)
    fb_velo = aggregate_fb_velo(year, fetch_url, csv_to_df)

    p_frames = []
    for d in (expected_p, ev_p, pd_p, std_p):
        if d is None or d.empty:
            continue
        d = d.copy()
        if "player_id" in d.columns:
            d["player_id"] = pd.to_numeric(d["player_id"], errors="coerce").astype("Int64")
        p_frames.append(d)
    pitchers_df = None
    for d in p_frames:
        if pitchers_df is None:
            pitchers_df = d
        else:
            pitchers_df = pitchers_df.merge(d, on="player_id", how="outer", suffixes=("", "_drop"))
            pitchers_df = pitchers_df.loc[:, ~pitchers_df.columns.str.endswith("_drop")]
    if pitchers_df is not None:
        pitchers_df["avg_fb_velo"] = pitchers_df["player_id"].map(fb_velo)

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
    # Map MLB label → AAA column key
    p_label_to_col = {
        "FIP":          "fip",            # may not be available — leave blank if so
        "Avg Exit Velo": "exit_velocity_avg",
        "Barrel%":      "barrel_batted_rate",
        "xBA":          "xba",
        "xSLG":         "xslg",
        "xwOBA":        "xwoba",
        "Avg FB Velo":  "avg_fb_velo",
        "Whiff%":       "whiff_percent",
        "K%":           "k_percent",
        "Chase%":       "p_oSwing_percent",
        "BB%":          "bb_percent",
        "K-BB%":        None,  # derived below
        "GB%":          None,  # not in this fetch set; leave blank
    }
    if pitchers_df is not None and not pitchers_df.empty:
        # Derive K-BB%
        if "k_percent" in pitchers_df.columns and "bb_percent" in pitchers_df.columns:
            pitchers_df["k_bb_percent"] = (
                pd.to_numeric(pitchers_df["k_percent"], errors="coerce") -
                pd.to_numeric(pitchers_df["bb_percent"], errors="coerce")
            )
            p_label_to_col["K-BB%"] = "k_bb_percent"

        # lower_better mirrors MLB defaults
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
             {"FIP", "Avg Exit Velo", "Barrel%", "xBA", "xSLG", "xwOBA", "BB%"}}
            for lbl in AAA_PITCHER_METRICS_LABELS
        ],
        "meta": {
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
        },
    }
