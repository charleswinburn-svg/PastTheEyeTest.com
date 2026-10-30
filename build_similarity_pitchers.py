#!/usr/bin/env python3
"""
build_similarity_pitchers.py — Build the pitcher player-similarity file for one
season: public/similarity_pitchers_{year}.json (see similarity_common.py for the
model and the file shape; src/baseball/similarity.js ranks comps from it).

Everything physical and every outcome rate comes from the season Statcast parquet
(pitch_xrv_{year}.parquet, built by fetch_statcast.py); Stuff+/Location+ come
from the season grade files written by score_pitches.py.

Per pitcher-season (regular season, ≥ MIN_PITCHES):
  arsenal  per pitch type (≥ MIN_TYPE_N and ≥ MIN_TYPE_USAGE): usage, velo, IVB,
           arm-side HB, spin, spin-axis sin/cos (mirrored for LHP), velo − primary
           fastball, extension
  release  arm angle (per-pitch Savant value, else the geometric estimate used by
           score_pitches.py), arm-side release x, release z, extension, primary-FB
           VAA / arm-side HAA
  whiff    Stuff+, K%, Whiff%, Chase%, CSW%
  command  Location+, BB%, Zone%, first-pitch strike %
  contact  xwOBAcon / xSLGcon allowed, avg EV, Barrel%, hard-hit %, GB%

Horizontal quantities are mirrored to an arm-side convention (positive = toward
the pitcher's arm side) so LHP and RHP compare directly.

Usage:
  python3 build_similarity_pitchers.py --year 2026 --parquet tmp/pitch_xrv_2026.parquet \
      --season-dir tmp/output/season
  # --season-dir defaults to the first of tmp/output/season, season, ../pitch-plus-api/season
"""
import argparse
import json
import os
from pathlib import Path

import numpy as np
import pandas as pd

from similarity_common import (
    ARSENAL_FEATURES, MISSING_PITCH_PENALTY, MIX_FAMILIES, PITCH_ALIAS, PITCH_FAMILY,
    PITCHER_COMPONENTS, PITCHER_FEATURES, SHAPE_WEIGHT, clean_value, component_meta,
    compute_stats, feature_meta, pairwise_calibration, write_similarity_json,
)

MIN_PITCHES = 200
MIN_TYPE_N = 25
MIN_TYPE_USAGE = 0.04
MIN_BIP = 20

SWING = {"swinging_strike", "swinging_strike_blocked", "foul", "foul_tip",
         "hit_into_play", "foul_bunt", "missed_bunt", "bunt_foul_tip", "swinging_pitchout"}
WHIFF = {"swinging_strike", "swinging_strike_blocked", "foul_tip", "swinging_pitchout", "missed_bunt"}
STRIKE_DESC = SWING | {"called_strike"}
K_EVENTS = {"strikeout", "strikeout_double_play"}
BB_EVENTS = {"walk"}
FB_TYPES = ["FF", "SI", "FC"]
DROP_TYPES = {"UN", "PO", "IN", "AB", "EP", "PS"}

PARQUET_COLS = [
    "pitcher", "player_name", "p_throws", "pitch_type", "game_type", "game_date",
    "home_team", "away_team", "inning_topbot",
    "release_speed", "pfx_x", "pfx_z", "release_spin_rate", "spin_axis",
    "release_extension", "release_pos_x", "release_pos_z", "arm_angle",
    "vx0", "vy0", "vz0", "ax", "ay", "az",
    "zone", "description", "events", "balls", "strikes",
    "launch_speed", "launch_speed_angle", "bb_type",
    "estimated_woba_using_speedangle", "estimated_slg_using_speedangle",
]


def _num(s):
    return pd.to_numeric(s, errors="coerce")


def _col(df, name):
    return df[name] if name in df.columns else pd.Series(np.nan, index=df.index)


def _mode(s):
    s = s.dropna()
    return s.mode().iloc[0] if len(s) else None


def _nice_name(n):
    if not isinstance(n, str):
        return None
    if "," in n:
        last, first = n.split(",", 1)
        return f"{first.strip()} {last.strip()}"
    return n.strip()


def load_parquet(path):
    try:
        import pyarrow.parquet as pq
        avail = set(pq.read_schema(path).names)
    except Exception:
        avail = set(pd.read_parquet(path).columns)
    cols = [c for c in PARQUET_COLS if c in avail]
    df = pd.read_parquet(path, columns=cols)
    missing = sorted(set(PARQUET_COLS) - avail)
    if missing:
        print(f"  parquet lacks {missing} — dependent features will be null")
    return df


def find_season_dir(explicit):
    cands = [explicit] if explicit else ["tmp/output/season", "season", "../pitch-plus-api/season"]
    for c in cands:
        if c and os.path.isdir(c):
            return c
    return None


def load_grades(season_dir, year):
    if not season_dir:
        return {}
    p = Path(season_dir) / f"pitcher_grades_{year}.json"
    if not p.exists():
        print(f"  no {p} — Stuff+/Location+ will be null")
        return {}
    with open(p) as f:
        return json.load(f)


def load_heights(path="models/pitcher_heights.json"):
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return {}


def prepare(df):
    """Filter to regular-season pitches with a usable pitch type, add derived columns."""
    if "game_type" in df.columns:
        gt = df["game_type"].astype(str)
        if (gt == "R").any():
            df = df[gt == "R"]
    df = df[df["pitch_type"].notna() & ~df["pitch_type"].isin(DROP_TYPES)].copy()
    df["pitcher"] = _num(df["pitcher"]).astype("Int64")
    df = df[df["pitcher"].notna()]
    df["pt"] = df["pitch_type"].replace(PITCH_ALIAS)
    df["pt"] = df["pt"].replace({"FA": "FF"})

    throws = df.groupby("pitcher")["p_throws"].agg(_mode) if "p_throws" in df.columns else pd.Series(dtype=object)
    df["throws"] = df["pitcher"].map(throws).fillna("R")
    sign = np.where(df["throws"].values == "L", 1.0, -1.0)   # arm-side positive

    df["velo"] = _num(_col(df, "release_speed"))
    df["ivb"] = _num(_col(df, "pfx_z")) * 12.0
    df["hb"] = _num(_col(df, "pfx_x")) * 12.0 * sign
    df["spin"] = _num(_col(df, "release_spin_rate"))
    axis = _num(_col(df, "spin_axis"))
    axis = np.where(df["throws"].values == "L", (360.0 - axis) % 360.0, axis)
    rad = np.radians(axis)
    df["axis_sin"], df["axis_cos"] = np.sin(rad), np.cos(rad)
    df["extension"] = _num(_col(df, "release_extension"))
    df["release_x"] = _num(_col(df, "release_pos_x")) * sign
    df["release_z"] = _num(_col(df, "release_pos_z"))

    if all(c in df.columns for c in ["vy0", "vz0", "az", "ay", "vx0", "ax"]):
        vy0, vz0, vx0 = _num(df["vy0"]).values, _num(df["vz0"]).values, _num(df["vx0"]).values
        ay, az, ax = _num(df["ay"]).values, _num(df["az"]).values, _num(df["ax"]).values
        with np.errstate(divide="ignore", invalid="ignore"):
            t = np.clip(50.0 / (-vy0), 0.35, 0.55)
            df["vaa"] = np.degrees(np.arctan2(vz0 + az * t, -(vy0 + ay * t)))
            df["haa"] = np.degrees(np.arctan2(vx0 + ax * t, -(vy0 + ay * t))) * sign
    else:
        df["vaa"] = np.nan
        df["haa"] = np.nan

    # Savant arm angle: make the convention "degrees above horizontal" for both
    # hands (older exports store LHP as negative).
    aa = _num(_col(df, "arm_angle"))
    if aa.notna().any():
        lhp = df["throws"].values == "L"
        if lhp.any() and np.nanmedian(aa.values[lhp]) < 0:
            aa = pd.Series(np.where(lhp, -aa.values, aa.values), index=df.index)
    df["arm_angle"] = aa

    desc = _col(df, "description").astype("string").fillna("")
    events = _col(df, "events").astype("string").fillna("").str.strip()
    zone = _num(_col(df, "zone"))
    df["_swing"] = desc.isin(SWING)
    df["_whiff"] = desc.isin(WHIFF)
    df["_strike"] = desc.isin(STRIKE_DESC)
    df["_called"] = desc == "called_strike"
    df["_zone"] = zone.between(1, 9)
    df["_oz"] = zone >= 10
    df["_oz_swing"] = df["_oz"] & df["_swing"]
    df["_pa"] = events != ""
    df["_k"] = events.isin(K_EVENTS)
    df["_bb"] = events.isin(BB_EVENTS)
    balls, strikes = _num(_col(df, "balls")), _num(_col(df, "strikes"))
    df["_first"] = (balls == 0) & (strikes == 0)
    df["_first_strike"] = df["_first"] & df["_strike"]
    bip = desc == "hit_into_play"
    df["_bip"] = bip
    ev = _num(_col(df, "launch_speed"))
    df["_ev"] = ev.where(bip)
    df["_hard"] = (ev >= 95).where(bip)
    lsa = _num(_col(df, "launch_speed_angle"))
    df["_barrel"] = (lsa == 6).where(bip & lsa.notna())
    bbt = _col(df, "bb_type").astype("string")
    df["_gb"] = (bbt == "ground_ball").where(bip & bbt.notna())
    df["_xwobacon"] = _num(_col(df, "estimated_woba_using_speedangle")).where(bip)
    df["_xslgcon"] = _num(_col(df, "estimated_slg_using_speedangle")).where(bip)

    if {"home_team", "away_team", "inning_topbot"} <= set(df.columns):
        top = df["inning_topbot"].astype(str).str.lower().str.startswith("top")
        df["team"] = np.where(top, df["home_team"], df["away_team"])
    else:
        df["team"] = None
    return df


def geometric_arm_angle(rel_x, rel_z, height_in, throws):
    """Same estimate score_pitches.py uses when Savant has no arm angle."""
    if not (np.isfinite(rel_x) and np.isfinite(rel_z)):
        return None
    shoulder_z = height_in * 0.70
    adj = rel_z * 12.0 - shoulder_z
    opp = abs(rel_x * 12.0)
    return float(np.degrees(np.arctan2(opp, adj)))


def build(df, grades, heights):
    df = prepare(df)
    players = {}

    type_agg = df.groupby(["pitcher", "pt"], observed=True).agg(
        n=("pt", "size"), velo=("velo", "mean"), ivb=("ivb", "mean"), hb=("hb", "mean"),
        spin=("spin", "mean"), axis_sin=("axis_sin", "mean"), axis_cos=("axis_cos", "mean"),
        extension=("extension", "mean"), vaa=("vaa", "mean"), haa=("haa", "mean"),
        rel_x=("release_x", "mean"), rel_z=("release_z", "mean"),
    ).reset_index()

    p_agg = df.groupby("pitcher", observed=True).agg(
        n=("pt", "size"), throws=("throws", "first"), name=("player_name", _mode), team=("team", _mode),
        release_x=("release_x", "mean"), release_z=("release_z", "mean"), extension=("extension", "mean"),
        arm_angle=("arm_angle", "mean"), arm_angle_n=("arm_angle", "count"),
        swings=("_swing", "sum"), whiffs=("_whiff", "sum"), called=("_called", "sum"),
        zone=("_zone", "sum"), oz=("_oz", "sum"), oz_swings=("_oz_swing", "sum"),
        pa=("_pa", "sum"), k=("_k", "sum"), bb=("_bb", "sum"),
        first=("_first", "sum"), first_strike=("_first_strike", "sum"),
        bip=("_bip", "sum"), ev=("_ev", "mean"), hard=("_hard", "mean"), barrel=("_barrel", "mean"),
        gb=("_gb", "mean"), xwobacon=("_xwobacon", "mean"), xslgcon=("_xslgcon", "mean"),
    )

    for pid, r in p_agg.iterrows():
        total = int(r["n"])
        if total < MIN_PITCHES:
            continue
        pid_s = str(int(pid))
        rows = type_agg[type_agg["pitcher"] == pid]
        rows = rows[(rows["n"] >= MIN_TYPE_N) & (rows["n"] / total >= MIN_TYPE_USAGE)]
        if rows.empty:
            continue
        fb = rows[rows["pt"].isin(FB_TYPES)].sort_values("n", ascending=False)
        fb_row = fb.iloc[0] if len(fb) else rows.sort_values("velo", ascending=False).iloc[0]
        fb_velo = float(fb_row["velo"]) if np.isfinite(fb_row["velo"]) else None

        arsenal = {}
        for _, tr in rows.iterrows():
            a = {"usage": round(float(tr["n"]) / total, 4), "n": int(tr["n"])}
            for key, *_ in ARSENAL_FEATURES:
                if key == "velo_minus_fb":
                    a[key] = clean_value(float(tr["velo"]) - fb_velo) if fb_velo is not None else None
                else:
                    a[key] = clean_value(tr[key])
            arsenal[tr["pt"]] = a

        fam = {f: 0.0 for f in MIX_FAMILIES}
        for _, tr in type_agg[type_agg["pitcher"] == pid].iterrows():
            f = PITCH_FAMILY.get(tr["pt"])
            if f in fam:
                fam[f] += float(tr["n"]) / total * 100.0

        g = grades.get(pid_s) or {}
        aa = float(r["arm_angle"]) if r["arm_angle_n"] >= 20 and np.isfinite(r["arm_angle"]) else None
        if aa is None:
            h = heights.get(pid_s, 74.0)
            aa = geometric_arm_angle(r["release_x"] * (1 if r["throws"] == "L" else -1), r["release_z"], h, r["throws"])

        def rate(a, b):
            return float(a) / float(b) * 100.0 if b else None

        v = {f"mix_{f}": fam[f] for f in MIX_FAMILIES}
        v.update({
            "arm_angle": aa,
            "release_x": r["release_x"], "release_z": r["release_z"], "extension": r["extension"],
            "fb_vaa": fb_row["vaa"], "fb_haa": fb_row["haa"],
            "stuff_plus": g.get("stuff_plus"),
            "k_pct": rate(r["k"], r["pa"]), "whiff_pct": rate(r["whiffs"], r["swings"]),
            "chase_pct": rate(r["oz_swings"], r["oz"]), "csw_pct": rate(r["called"] + r["whiffs"], total),
            "loc_plus": g.get("loc_plus"),
            "bb_pct": rate(r["bb"], r["pa"]), "zone_pct": rate(r["zone"], total),
            "fstrike_pct": rate(r["first_strike"], r["first"]),
            "xwobacon_allowed": r["xwobacon"] if r["bip"] >= MIN_BIP else None,
            "xslgcon_allowed": r["xslgcon"] if r["bip"] >= MIN_BIP else None,
            "avg_ev_allowed": r["ev"] if r["bip"] >= MIN_BIP else None,
            "barrel_pct": r["barrel"] * 100.0 if r["bip"] >= MIN_BIP and np.isfinite(r["barrel"]) else None,
            "hard_hit_pct": r["hard"] * 100.0 if r["bip"] >= MIN_BIP and np.isfinite(r["hard"]) else None,
            "gb_pct": r["gb"] * 100.0 if r["bip"] >= MIN_BIP and np.isfinite(r["gb"]) else None,
        })
        players[pid_s] = {
            "name": _nice_name(r["name"]),
            "team": r["team"],
            "hand": r["throws"],
            "n": total,
            "height": heights.get(pid_s),   # inches, for the release diagram
            "grades": {k: g.get(k) for k in ("stuff_plus", "loc_plus", "tun_plus", "pitch_plus") if g.get(k) is not None},
            "v": {k: clean_value(val) for k, val in v.items()},
            "arsenal": arsenal,
        }

    keys = [k for k, *_ in PITCHER_FEATURES]
    meta = {
        "components": component_meta(PITCHER_COMPONENTS, PITCHER_FEATURES),
        "features": feature_meta(PITCHER_FEATURES),
        "stats": compute_stats({pid: p["v"] for pid, p in players.items()}, keys),
        "arsenal_features": {k: {"label": lab, "weight": w, "fmt": fmt} for k, lab, w, fmt in ARSENAL_FEATURES},
    }
    akeys = [k for k, *_ in ARSENAL_FEATURES]
    by_type = {}   # {pitch type: {pid: shape values}} → per-(season, type) mean/sd
    for pid, p in players.items():
        for pt, a in p["arsenal"].items():
            by_type.setdefault(pt, {})[pid] = a
    meta["arsenal_stats"] = {pt: compute_stats(d, akeys) for pt, d in by_type.items()}
    for c in meta["components"].values():
        c["features"] = [k for k in c["features"] if k in meta["stats"]]
    calib = pairwise_calibration(players, meta, "pitcher")
    calib["missing_pitch_penalty"] = MISSING_PITCH_PENALTY
    calib["shape_weight"] = SHAPE_WEIGHT
    meta["calib"] = calib
    return players, meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, required=True)
    ap.add_argument("--parquet", required=True, help="season Statcast parquet (pitch_xrv_{year}.parquet)")
    ap.add_argument("--season-dir", default=None, help="dir with pitcher_grades_{year}.json")
    ap.add_argument("--heights", default="models/pitcher_heights.json")
    ap.add_argument("--public", default="public")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    print(f"Reading {args.parquet}…")
    df = load_parquet(args.parquet)
    print(f"  {len(df):,} pitches")
    season_dir = find_season_dir(args.season_dir)
    grades = load_grades(season_dir, args.year)
    print(f"  grades: {len(grades)} pitchers from {season_dir}")
    players, meta = build(df, grades, load_heights(args.heights))
    out = args.out or str(Path(args.public) / f"similarity_pitchers_{args.year}.json")
    write_similarity_json(out, season=args.year, kind="pitcher", players=players, meta=meta)
    present = {c: len(m["features"]) for c, m in meta["components"].items()}
    print(f"Wrote {out}: {len(players)} pitchers, features per component {present}, calib {meta['calib']}")


if __name__ == "__main__":
    main()
