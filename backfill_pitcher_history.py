#!/usr/bin/env python3
"""
backfill_pitcher_history.py — build history/pitcher_history.csv (one row per
pitcher-season, 2015–2026) with every pitcher-card stat, its sample sizes and the
pitch-model grades, and add pitcher birthdates to history/birthdates.json.

Run it from the PastTheEyeTest.com project root: it calls baseball_pipeline's own
process_pitchers(), so every stat is pulled and scaled exactly like the live cards.

  Card values      2015–2022 from process_pitchers(year) (cached per season in
                   history/raw/pitchers_{yr}.json); 2023+ from the site's own
                   public/baseball_data_{yr}.json, so history == what the site shows.
  Sample sizes     ip (card) · bf (batters faced, Savant expected-stats `pa`) ·
                   pitches (pitch-model `n`, 2023+)
  Pitch model      stuff_plus, loc_plus, tun_plus, pitch_plus, xRV, rv from
                   {api}/season/pitcher_grades_{yr}.json, plus
                   model_resid = rv + xRV  (actual run value per 100 pitches minus the
                   model's expected, both from the pitcher's side; + = beats his stuff)
  Birthdates       Chadwick Bureau register (github), merged into the existing file

USAGE
  python3 backfill_pitcher_history.py
  python3 backfill_pitcher_history.py --start 2015 --end 2026 --api /var/www/pitch-plus-api
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path

import pandas as pd

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT))
try:
    import baseball_pipeline as bp
except ImportError:
    raise SystemExit("Run this from the PastTheEyeTest.com project root (needs baseball_pipeline.py).")

LABELS = [m["label"] for m in bp.PITCHER_METRICS]
CHADWICK = "https://raw.githubusercontent.com/chadwickbureau/register/master/data/people-{}.csv"


def log(*a):
    print(*a, flush=True)


def card_rows(entries, year):
    rows = []
    for p in entries:
        if p.get("player_id") is None:
            continue
        r = {"player_id": int(p["player_id"]), "season": int(year), "name": p.get("name"),
             "team": p.get("team"), "team_id": p.get("team_id"), "ip": p.get("ip")}
        for lab, c in (p.get("categories") or {}).items():
            r[lab] = c.get("value")
        rows.append(r)
    return rows


def season_cards(year, public, raw, refresh):
    """Card values for one season: the site's file if it exists, else the pipeline."""
    site = public / f"baseball_data_{year}.json"
    if site.exists():
        return card_rows(json.load(open(site)).get("pitchers", []), year), "site file"
    cache = raw / f"pitchers_{year}.json"
    if cache.exists() and not refresh:
        return card_rows(json.load(open(cache)), year), "cache"
    bp.fetch_player_teams = lambda ids: {}       # past seasons: skip the current-team lookups
    entries = bp.process_pitchers(year)
    json.dump(entries, open(cache, "w"))
    return card_rows(entries, year), "pipeline"


def season_bf(year, raw, refresh):
    """Batters faced per pitcher from Savant's expected-stats leaderboard (`pa`)."""
    cache = raw / f"pitcher_bf_{year}.csv"
    if cache.exists() and not refresh:
        return pd.read_csv(cache)
    df = bp.fetch_savant_expected(year, "pitcher")
    if df is None or not len(df):
        return None
    df = bp.normalize_savant_name(df)
    if "pa" not in df.columns:
        return None
    out = df[["player_id", "pa"]].rename(columns={"pa": "bf"}).dropna()
    out["player_id"] = out["player_id"].astype(int)
    out = out.drop_duplicates("player_id")
    out.to_csv(cache, index=False)
    time.sleep(bp.FETCH_DELAY)
    return out


def load_grades(api_season_dir):
    rows = []
    for f in sorted(Path(api_season_dir).glob("pitcher_grades_*.json")):
        mt = re.fullmatch(r"pitcher_grades_(\d{4})", f.stem)        # not the _aaa_ files
        if not mt:
            continue
        yr = int(mt.group(1))
        for pid, g in json.load(open(f)).items():
            rows.append({"player_id": int(pid), "season": yr, "pitches": g.get("n"),
                         "stuff_plus": g.get("stuff_plus"), "loc_plus": g.get("loc_plus"),
                         "tun_plus": g.get("tun_plus"), "pitch_plus": g.get("pitch_plus"),
                         "xRV": g.get("xRV"), "rv": g.get("rv")})
    if not rows:
        log(f"  ⚠ no pitcher_grades_*.json in {api_season_dir} — grade columns omitted")
        return None
    g = pd.DataFrame(rows)
    g["model_resid"] = g["rv"] + g["xRV"]
    log(f"  grade seasons: {sorted(g.season.unique().tolist())}")
    return g


def add_birthdates(pids, path):
    bd = json.load(open(path)) if path.exists() else {}
    need = {int(p) for p in pids if str(int(p)) not in bd}
    if not need:
        log(f"  birthdates: all {len(pids)} pitchers already in {path}")
        return
    try:
        for c in "0123456789abcdef":
            df = pd.read_csv(CHADWICK.format(c), usecols=["key_mlbam", "birth_year", "birth_month", "birth_day"],
                             dtype=str, low_memory=False).dropna()
            for m, y, mo, d in df.itertuples(index=False):
                pid = int(float(m))
                if pid in need:
                    bd[str(pid)] = f"{int(float(y)):04d}-{int(float(mo)):02d}-{int(float(d)):02d}"
    except Exception as e:
        log(f"  ⚠ Chadwick register unreachable ({e}) — aging will skip pitchers without a birthdate")
    json.dump(bd, open(path, "w"))
    have = sum(str(int(p)) in bd for p in pids)
    log(f"  birthdates: {have}/{len(pids)} pitchers → {path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=int, default=2015)
    ap.add_argument("--end", type=int, default=2026)
    ap.add_argument("--public", default="./public")
    ap.add_argument("--out", default="./history")
    ap.add_argument("--api", default="/var/www/pitch-plus-api", help="pitch-plus-api checkout (season/ grade files)")
    ap.add_argument("--refresh", action="store_true", help="refetch instead of using history/raw cache")
    args = ap.parse_args()

    out, public = Path(args.out), Path(args.public)
    raw = out / "raw"
    raw.mkdir(parents=True, exist_ok=True)

    parts = []
    for yr in range(args.start, args.end + 1):
        log(f"\n── {yr} ──")
        try:
            rows, src = season_cards(yr, public, raw, args.refresh)
        except Exception as e:
            log(f"  ✗ card stats failed for {yr}: {e}")
            continue
        df = pd.DataFrame(rows)
        if not len(df):
            log(f"  ✗ no pitchers for {yr}")
            continue
        try:
            bf = season_bf(yr, raw, args.refresh)
        except Exception as e:
            log(f"  ⚠ batters faced unavailable for {yr}: {e}")
            bf = None
        if bf is not None:
            df = df.merge(bf, on="player_id", how="left")
        log(f"  {len(df)} pitchers ({src})" + (f", bf for {df['bf'].notna().sum()}" if "bf" in df.columns else ""))
        parts.append(df)
    if not parts:
        raise SystemExit("Nothing fetched.")
    hist = pd.concat(parts, ignore_index=True)

    log("\nJoining pitch-model grades…")
    g = load_grades(Path(args.api) / "season")
    if g is not None:
        hist = hist.merge(g, on=["player_id", "season"], how="left")

    front = ["player_id", "name", "team", "team_id", "season", "ip", "bf", "pitches"]
    cols = [c for c in front if c in hist.columns] + [c for c in hist.columns if c not in front]
    hist = hist[cols].sort_values(["season", "player_id"])
    path = out / "pitcher_history.csv"
    hist.to_csv(path, index=False)
    log(f"\nWrote {path}: {len(hist):,} pitcher-seasons")
    cov = hist.groupby("season")[[c for c in LABELS + ["bf", "stuff_plus"] if c in hist.columns]].count()
    log("Non-blank values per season:\n" + cov.to_string())

    log("\nBirthdates…")
    add_birthdates(sorted(hist["player_id"].unique()), out / "birthdates.json")


if __name__ == "__main__":
    main()
