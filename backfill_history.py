#!/usr/bin/env python3
"""
backfill_history.py — build history/hitter_history.csv (one row per hitter-season,
2015–2026) with every hitter-card stat plus its sample sizes, and
history/birthdates.json for aging.

Run it from the PastTheEyeTest.com project root: it imports the fetchers from
baseball_pipeline.py, so every stat is pulled and scaled exactly like the live cards.

  Sample sizes kept per row:  pa · bip (balls in play) · swings (competitive, 2023+)
  Card values:                for seasons that already have public/baseball_data_{yr}.json
                              the card's own values win, so history == what the site shows.
  xRV/600 columns:            read from public/hitter_xrv_{yr}.json for every season present.
                              To backfill 2015–2022, run once (Python 3.12 venv, see that file):
                                .venv-xrv/bin/python build_hitter_xrv.py --season 2015,2016,2017,2018,2019,2020,2021,2022
                              (writes hitter_xrv_{yr}.json; nothing on the site links to those seasons)

Notes
  • Bat tracking (bat speed, swing length, fast swing %, blasts) starts in 2023, so those
    columns are blank before then — build_projections.py handles that.
  • 90th % EV comes from FanGraphs and needs your fangraphs_cookies.txt like the pipeline;
    if FG refuses, the column is left blank for that season.
  • Raw downloads are cached in history/raw/ — rerun freely; --refresh refetches.

USAGE
  python3 backfill_history.py                       # 2015–2026
  python3 backfill_history.py --start 2017 --end 2026 --min-pa 50
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT))
try:
    import baseball_pipeline as bp
except ImportError:
    raise SystemExit("Run this from the PastTheEyeTest.com project root (needs baseball_pipeline.py).")

KEY_TO_LABEL = {m["key"]: m["label"] for m in bp.HITTER_METRICS}
BAT_TRACKING_FIRST = 2023


def log(*a):
    print(*a, flush=True)


def cached(path: Path, refresh: bool, fetch):
    if path.exists() and not refresh:
        return pd.read_csv(path)
    df = fetch()
    if df is not None and len(df):
        df.to_csv(path, index=False)
    return df


def fetch_season(year, raw_dir, refresh):
    """Pull one season with the pipeline's own fetchers; return per-player frame keyed by
    player_id with pipeline metric keys + pa, bip, swings."""
    exp = cached(raw_dir / f"{year}_expected.csv", refresh, lambda: bp.fetch_savant_expected(year, "batter"))
    time.sleep(bp.FETCH_DELAY)
    sc = cached(raw_dir / f"{year}_statcast.csv", refresh, lambda: bp.fetch_savant_statcast(year, "batter"))
    bt = None
    if year >= BAT_TRACKING_FIRST:
        time.sleep(bp.FETCH_DELAY)
        bt = cached(raw_dir / f"{year}_battracking.csv", refresh, lambda: bp.fetch_savant_bat_tracking(year))
    ev90 = cached(raw_dir / f"{year}_ev90.csv", refresh, lambda: bp.fetch_fangraphs_ev90(year))

    frames = []
    if exp is not None and len(exp):
        e = bp.normalize_savant_name(exp)
        e = e.rename(columns={"est_slg": "xslg"})
        keep = [c for c in ["player_id", "player_name", "pa", "bip", "xslg"] if c in e.columns]
        frames.append(e[keep])
    if sc is not None and len(sc):
        s = bp.normalize_savant_name(sc)
        keep = ["player_id"] + [c for c in ["xwobacon", "exit_velocity_avg", "barrel_batted_rate",
                                            "sweet_spot_percent", "k_percent", "bb_percent", "whiff_percent",
                                            "iz_contact_percent", "oz_swing_percent", "pa", "player_name"]
                                if c in s.columns]
        frames.append(s[keep])
    if bt is not None and len(bt):
        b = bt.copy()
        if "id" in b.columns:
            b["player_id"] = pd.to_numeric(b["id"], errors="coerce").astype("Int64")
        b = b.rename(columns={"avg_bat_speed": "avg_swing_speed", "swing_length": "avg_swing_length",
                              "blast_per_bat_contact": "blasts_contact", "hard_swing_rate": "fast_swing_rate"})
        swc = next((c for c in b.columns if "competitive" in c.lower() and "swing" in c.lower()
                    and "percent" not in c.lower() and "rate" not in c.lower()), None)
        if swc:
            b = b.rename(columns={swc: "swings"})
        keep = ["player_id"] + [c for c in ["avg_swing_speed", "avg_swing_length", "blasts_contact",
                                            "fast_swing_rate", "swings"] if c in b.columns]
        frames.append(b[keep])
    if ev90 is not None and len(ev90):
        v = ev90.copy()
        v["player_id"] = pd.to_numeric(v["player_id"], errors="coerce").astype("Int64")
        frames.append(v[["player_id", "ev_90p"]])

    if not frames:
        return None
    out = None
    for f in frames:
        f = f.dropna(subset=["player_id"]).drop_duplicates("player_id")
        if out is None:
            out = f
        else:
            new = [c for c in f.columns if c == "player_id" or c not in out.columns]
            out = out.merge(f[new], on="player_id", how="outer")
    out["season"] = year
    return out


def overlay_site_files(hist, public):
    """Where the site already has a season file, its card values (and team) win."""
    rows = []
    for f in sorted(public.glob("baseball_data_*.json")):
        mt = re.fullmatch(r"baseball_data_(\d{4})", f.stem)
        if not mt:
            continue
        yr = mt.group(1)
        for h in json.load(open(f)).get("hitters", []):
            if h.get("player_id") is None:
                continue
            r = {"player_id": int(h["player_id"]), "season": int(yr), "name": h.get("name"),
                 "team": h.get("team"), "team_id": h.get("team_id"), "pa_site": h.get("pa")}
            for lab, c in (h.get("categories") or {}).items():
                r[f"site::{lab}"] = c.get("value")
            rows.append(r)
    if not rows:
        return hist
    site = pd.DataFrame(rows)
    m = hist.merge(site, on=["player_id", "season"], how="outer")
    # Units check on overlapping seasons before overriding
    for lab in KEY_TO_LABEL.values():
        sc = f"site::{lab}"
        if sc not in m.columns or lab not in m.columns:
            continue
        both = m[[lab, sc]].dropna()
        if len(both) > 50:
            ratio = (both[lab].abs().median() + 1e-12) / (both[sc].abs().median() + 1e-12)
            if not 0.95 < ratio < 1.05:
                log(f"  ⚠ units differ for {lab}: fetched/site median ratio {ratio:.3f} — using site values")
        m[lab] = m[sc].combine_first(m[lab])
    m["pa"] = m["pa_site"].combine_first(m.get("pa"))
    if "name_x" in m.columns:
        m["name"] = m["name_y"].combine_first(m["name_x"])
    return m.drop(columns=[c for c in m.columns if c.startswith("site::") or c in ("pa_site", "name_x", "name_y")])


def add_xrv(hist, public):
    rows = []
    for f in sorted(public.glob("hitter_xrv_*.json")):
        mt = re.fullmatch(r"hitter_xrv_(\d{4})", f.stem)     # not hitter_xrv_games_*
        if not mt:
            continue
        yr = mt.group(1)
        for pid, v in json.load(open(f)).items():
            r = {"player_id": int(pid), "season": int(yr), "pa_xrv": v.get("pa")}
            r.update({lab: c.get("value") for lab, c in (v.get("metrics") or {}).items()})
            rows.append(r)
    if not rows:
        log("  (no hitter_xrv_*.json files — xRV columns omitted)")
        return hist
    x = pd.DataFrame(rows)
    log(f"  xRV seasons found: {sorted(x.season.unique().tolist())}")
    return hist.merge(x, on=["player_id", "season"], how="outer")


def fetch_birthdates(pids, seasons, out_path):
    """One /sports/1/players call per season covers almost everyone; single-id calls fill gaps."""
    bd = json.load(open(out_path)) if out_path.exists() else {}
    reached = False
    for yr in seasons:
        try:
            r = requests.get(f"https://statsapi.mlb.com/api/v1/sports/1/players?season={yr}&fields=people,id,birthDate",
                             timeout=60)
            for p in r.json().get("people", []):
                if p.get("birthDate"):
                    bd[str(p["id"])] = p["birthDate"]
            reached = True
        except Exception as e:
            log(f"  ⚠ birthdates {yr}: {e}")
    missing = [p for p in pids if str(p) not in bd] if reached else []
    if not reached:
        log("  ⚠ MLB Stats API unreachable — skipping birthdates (aging term will be off)")
    for pid in missing:
        try:
            r = requests.get(f"https://statsapi.mlb.com/api/v1/people/{pid}?fields=people,id,birthDate", timeout=30)
            p = (r.json().get("people") or [{}])[0]
            if p.get("birthDate"):
                bd[str(pid)] = p["birthDate"]
            time.sleep(0.05)
        except Exception:
            pass
    if bd:
        json.dump(bd, open(out_path, "w"))
    have = sum(str(p) in bd for p in pids)
    log(f"  birthdates: {have}/{len(pids)} hitters → {out_path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=int, default=2015)
    ap.add_argument("--end", type=int, default=2026)
    ap.add_argument("--min-pa", type=int, default=50, help="Savant leaderboard minimum PA for history rows")
    ap.add_argument("--public", default="./public")
    ap.add_argument("--out", default="./history")
    ap.add_argument("--refresh", action="store_true", help="refetch instead of using history/raw cache")
    args = ap.parse_args()

    out, public = Path(args.out), Path(args.public)
    raw = out / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    bp.MIN_PA = args.min_pa          # the fetchers read this module constant at call time
    bp.MIN_PA_EARLY = min(bp.MIN_PA_EARLY, args.min_pa)

    seasons = list(range(args.start, args.end + 1))
    parts = []
    for yr in seasons:
        log(f"\n── {yr} ──")
        df = fetch_season(yr, raw, args.refresh)
        if df is None:
            log(f"  ✗ nothing fetched for {yr}")
            continue
        log(f"  {len(df)} hitters")
        parts.append(df)
    if not parts:
        raise SystemExit("Nothing fetched.")
    hist = pd.concat(parts, ignore_index=True)
    hist = hist.rename(columns=KEY_TO_LABEL).rename(columns={"player_name": "name"})
    hist["player_id"] = hist["player_id"].astype(int)

    log("\nOverlaying site season files (card values win where present)…")
    hist = overlay_site_files(hist, public)
    hist = add_xrv(hist, public)
    hist = hist[hist["season"].between(args.start, args.end)]

    front = ["player_id", "name", "team", "team_id", "season", "pa", "bip", "swings", "pa_xrv"]
    cols = [c for c in front if c in hist.columns] + [c for c in hist.columns if c not in front]
    hist = hist[cols].sort_values(["season", "player_id"])
    path = out / "hitter_history.csv"
    hist.to_csv(path, index=False)

    log(f"\nWrote {path}: {len(hist):,} hitter-seasons")
    cov = hist.groupby("season")[[c for c in list(KEY_TO_LABEL.values()) + ["xRV/600", "bip", "swings"]
                                  if c in hist.columns]].count()
    log("Non-blank values per season:\n" + cov.to_string())

    log("\nFetching birthdates…")
    fetch_birthdates(sorted(hist["player_id"].unique()), seasons, out / "birthdates.json")


if __name__ == "__main__":
    main()
