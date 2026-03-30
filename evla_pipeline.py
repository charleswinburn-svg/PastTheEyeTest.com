#!/usr/bin/env python3
"""
evla_pipeline.py — Pre-compute EV/Launch Angle fan chart data from Baseball Savant.

Groups batted ball events into 5-degree LA buckets, computes avg EV and Hard Hit%
per bucket per batter, plus league-wide averages. Supports Regular Season + Spring Training.

Usage:
  python3 evla_pipeline.py [output_dir] [seasons]
  python3 evla_pipeline.py ./public 2025
  python3 evla_pipeline.py ./public 2023,2024,2025
  python3 evla_pipeline.py ./public 2025 --aaa

Output:
  {output_dir}/evla_{season}.json         (MLB regular season)
  {output_dir}/evla_st_{season}.json      (MLB spring training)
  {output_dir}/evla_aaa_{season}.json     (AAA regular season, if --aaa)
"""

import pandas as pd
import numpy as np
import requests
import json
import os
import sys
import time
import unicodedata
from io import StringIO

# ============================================================
# CONFIG
# ============================================================

MIN_BBE = 30             # minimum batted ball events to include player
FETCH_DELAY = 3.0
MAX_RETRIES = 3

HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "text/csv,text/plain,application/json,*/*",
}

SAVANT_BASE = "https://baseballsavant.mlb.com"
MLB_API = "https://statsapi.mlb.com/api/v1"

# LA bucket edges: ≤-10, (-10,-5], (-5,0], (0,5], ... (35,40], >40
BUCKET_EDGES = [-10, -5, 0, 5, 10, 15, 20, 25, 30, 35, 40]
BUCKET_LABELS = [
    "\u2264 -10", "-10 to -5", "-5 to 0", "0 to 5", "5 to 10",
    "10 to 15", "15 to 20", "20 to 25", "25 to 30",
    "30 to 35", "35 to 40", "> 40"
]

def la_bucket_idx(la):
    for i, edge in enumerate(BUCKET_EDGES):
        if la <= edge:
            return i
    return len(BUCKET_EDGES)

def norm_name(s):
    if not isinstance(s, str) or not s:
        return ""
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.lower().replace(".", "").replace("-", " ").replace(",", "")
    for suffix in [" jr", " sr", " ii", " iii", " iv"]:
        if s.endswith(suffix):
            s = s[:-len(suffix)]
    return " ".join(s.split())


# ============================================================
# FETCH HELPERS
# ============================================================

def fetch_url(url, retries=MAX_RETRIES, delay=FETCH_DELAY):
    for attempt in range(1, retries + 1):
        try:
            time.sleep(delay if attempt > 1 else 0.5)
            r = requests.get(url, headers=HTTP_HEADERS, timeout=90)
            if r.status_code == 403:
                print(f"    \u26a0 403 (attempt {attempt}/{retries})")
                time.sleep(delay * attempt * 2)
                continue
            r.raise_for_status()
            return r.text
        except Exception as e:
            print(f"    \u26a0 Error (attempt {attempt}/{retries}): {e}")
            if attempt < retries:
                time.sleep(delay * attempt)
    return None

def csv_to_df(text):
    if text is None or not text.strip() or "<!DOCTYPE" in str(text)[:200]:
        return None
    try:
        return pd.read_csv(StringIO(text)).dropna(how="all")
    except Exception as e:
        print(f"    \u2717 CSV parse: {e}")
        return None


# ============================================================
# DATE RANGES
# ============================================================

def get_date_ranges(season, season_type="R"):
    if season_type == "S":
        return [
            (f"{season}-02-20", f"{season}-03-10"),
            (f"{season}-03-11", f"{season}-03-28"),
        ]
    else:
        return [
            (f"{season}-03-20", f"{season}-04-15"),
            (f"{season}-04-16", f"{season}-04-30"),
            (f"{season}-05-01", f"{season}-05-15"),
            (f"{season}-05-16", f"{season}-05-31"),
            (f"{season}-06-01", f"{season}-06-15"),
            (f"{season}-06-16", f"{season}-06-30"),
            (f"{season}-07-01", f"{season}-07-15"),
            (f"{season}-07-16", f"{season}-07-31"),
            (f"{season}-08-01", f"{season}-08-15"),
            (f"{season}-08-16", f"{season}-08-31"),
            (f"{season}-09-01", f"{season}-09-15"),
            (f"{season}-09-16", f"{season}-10-02"),
        ]


def fetch_savant_chunk(season, start, end, game_type="R"):
    gt = "R%7C" if game_type == "R" else "E%7C"
    url = (
        f"{SAVANT_BASE}/statcast_search/csv?all=true&type=detail"
        f"&player_type=batter&hfGT={gt}&hfSea={season}%7C"
        f"&game_date_gt={start}&game_date_lt={end}"
    )
    return csv_to_df(fetch_url(url))


# ============================================================
# PROCESS BATTED BALLS
# ============================================================

def process_chunk(df, acc_players, acc_league):
    if df is None or len(df) == 0:
        return 0

    for col in ["launch_speed", "launch_angle", "batter"]:
        if col not in df.columns:
            return 0
        df[col] = pd.to_numeric(df[col], errors="coerce")

    bbe = df[df["launch_speed"].notna() & df["launch_angle"].notna()].copy()
    if len(bbe) == 0:
        return 0

    for _, row in bbe.iterrows():
        bid = int(row["batter"])
        la = float(row["launch_angle"])
        ev = float(row["launch_speed"])
        bucket = la_bucket_idx(la)
        hard = 1 if ev >= 95 else 0

        if bid not in acc_players:
            pname = ""
            if "player_name" in row.index:
                pname = str(row["player_name"])
                if ", " in pname:
                    parts = pname.split(", ", 1)
                    pname = parts[1] + " " + parts[0]
            team = ""
            topbot = str(row.get("inning_topbot", "")).strip()
            if topbot == "Top":
                team = str(row.get("away_team", "")).strip()
            elif topbot == "Bot":
                team = str(row.get("home_team", "")).strip()
            acc_players[bid] = {
                "name": pname, "team": team,
                "buckets": [{"ev_sum": 0, "count": 0, "hard": 0} for _ in range(12)],
                "total_bbe": 0,
            }

        p = acc_players[bid]
        p["buckets"][bucket]["ev_sum"] += ev
        p["buckets"][bucket]["count"] += 1
        p["buckets"][bucket]["hard"] += hard
        p["total_bbe"] += 1

        # Update team to latest
        topbot = str(row.get("inning_topbot", "")).strip()
        if topbot == "Top":
            t = str(row.get("away_team", "")).strip()
        elif topbot == "Bot":
            t = str(row.get("home_team", "")).strip()
        else:
            t = ""
        if t:
            p["team"] = t

        acc_league[bucket]["ev_sum"] += ev
        acc_league[bucket]["count"] += 1
        acc_league[bucket]["hard"] += hard

    return len(bbe)


# ============================================================
# ROSTER LOOKUP
# ============================================================

def fetch_batter_roster(season, sport_id=1):
    batters = {}
    try:
        teams = requests.get(
            f"{MLB_API}/teams?sportId={sport_id}&season={season}",
            headers=HTTP_HEADERS, timeout=30
        ).json().get("teams", [])
        for team in teams:
            try:
                r = requests.get(
                    f"{MLB_API}/teams/{team['id']}/roster?season={season}",
                    headers=HTTP_HEADERS, timeout=15
                )
                if r.status_code != 200:
                    continue
                for p in r.json().get("roster", []):
                    if p.get("position", {}).get("type") != "Pitcher":
                        pid = p["person"]["id"]
                        batters[pid] = {
                            "name": p["person"]["fullName"],
                            "team": team.get("abbreviation", ""),
                        }
                time.sleep(0.05)
            except Exception:
                pass
    except Exception as e:
        print(f"    \u26a0 Roster failed: {e}")
    print(f"    \u2713 {len(batters)} batters from rosters")
    return batters


# ============================================================
# BUILD A SINGLE DATASET (RS or ST, MLB or AAA)
# ============================================================

def build_dataset(season, season_type, sport_id, roster):
    gt_label = "Spring Training" if season_type == "S" else "Regular Season"
    league = "AAA" if sport_id == 11 else "MLB"
    print(f"\n{'='*50}")
    print(f"SAVANT BBE — {season} {league} {gt_label}")
    print(f"{'='*50}")

    acc_players = {}
    acc_league = [{"ev_sum": 0, "count": 0, "hard": 0} for _ in range(12)]
    total_bbe = 0

    ranges = get_date_ranges(season, season_type)
    for i, (start, end) in enumerate(ranges):
        print(f"\n  Chunk {i+1}/{len(ranges)}: {start} \u2192 {end}")
        df = fetch_savant_chunk(season, start, end, season_type)
        if df is not None and len(df) > 0:
            n = process_chunk(df, acc_players, acc_league)
            total_bbe += n
            print(f"    \u2713 {n:,} BBE")
        else:
            print(f"    \u2014 No data")
        time.sleep(FETCH_DELAY)

    print(f"\n  Total BBE: {total_bbe:,}")
    print(f"  Batters with data: {len(acc_players)}")

    # League averages
    league_avg = []
    for i in range(12):
        b = acc_league[i]
        league_avg.append({
            "label": BUCKET_LABELS[i],
            "avg_ev": round(b["ev_sum"] / b["count"], 1) if b["count"] > 0 else None,
            "hard_hit_pct": round(b["hard"] / b["count"] * 100, 1) if b["count"] > 0 else None,
            "count": b["count"],
        })

    # Per-player
    players = []
    for bid, p in acc_players.items():
        if p["total_bbe"] < MIN_BBE:
            continue

        info = roster.get(bid, {})
        name = info.get("name") or p["name"] or ""
        team = p["team"] or info.get("team", "")

        buckets = []
        for i in range(12):
            b = p["buckets"][i]
            buckets.append({
                "label": BUCKET_LABELS[i],
                "avg_ev": round(b["ev_sum"] / b["count"], 1) if b["count"] > 0 else None,
                "hard_hit_pct": round(b["hard"] / b["count"] * 100, 1) if b["count"] > 0 else None,
                "count": b["count"],
            })

        players.append({
            "player_id": bid,
            "name": name,
            "team": team,
            "total_bbe": p["total_bbe"],
            "buckets": buckets,
        })

    players.sort(key=lambda x: x["name"])
    min_bbe_used = MIN_BBE if season_type == "R" else max(10, MIN_BBE // 3)
    # Re-filter for ST with lower threshold
    if season_type == "S":
        players = [p for p in players if p["total_bbe"] >= min_bbe_used]

    print(f"  \u2713 {len(players)} batters qualified (min {min_bbe_used} BBE)")

    return {
        "season": season,
        "season_type": "spring" if season_type == "S" else "regular",
        "league": league,
        "league_avg": league_avg,
        "players": players,
        "meta": {
            "min_bbe": min_bbe_used,
            "total_bbe": total_bbe,
            "bucket_labels": BUCKET_LABELS,
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
        },
    }


# ============================================================
# MAIN
# ============================================================

def run_pipeline(season, output_dir, sport_id=1):
    os.makedirs(output_dir, exist_ok=True)
    suffix = "_aaa" if sport_id == 11 else ""
    league = "AAA" if sport_id == 11 else "MLB"

    print(f"\n{'#'*60}")
    print(f"# EV/LA Distribution Pipeline")
    print(f"# Season: {season} | League: {league}")
    print(f"# Output: {output_dir}")
    print(f"{'#'*60}")

    roster = fetch_batter_roster(season, sport_id)

    # Regular Season
    rs_data = build_dataset(season, "R", sport_id, roster)
    fname = f"evla{suffix}_{season}.json"
    fpath = os.path.join(output_dir, fname)
    with open(fpath, "w") as f:
        json.dump(rs_data, f, indent=2)
    print(f"\n  \u2192 Wrote {fpath} ({len(rs_data['players'])} batters)")

    # Spring Training (MLB only — AAA ST data rarely available on Savant)
    if sport_id == 1:
        st_data = build_dataset(season, "S", sport_id, roster)
        fname_st = f"evla_st_{season}.json"
        fpath_st = os.path.join(output_dir, fname_st)
        with open(fpath_st, "w") as f:
            json.dump(st_data, f, indent=2)
        print(f"  \u2192 Wrote {fpath_st} ({len(st_data['players'])} batters)")

    print(f"\n{'#'*60}")
    print(f"# Pipeline complete!")
    print(f"{'#'*60}\n")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="EV/LA Distribution Pipeline")
    parser.add_argument("output_dir", nargs="?", default="./public")
    parser.add_argument("season", nargs="?", default="2025", help="Comma-separated seasons")
    parser.add_argument("--aaa", action="store_true")
    args = parser.parse_args()

    sport_id = 11 if args.aaa else 1
    for s in args.season.split(","):
        run_pipeline(int(s.strip()), args.output_dir, sport_id)
