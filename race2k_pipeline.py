#!/usr/bin/env python3
"""
race2k_pipeline.py — Pre-compute "Race to 2 Strikes" metrics from Baseball Savant.

Fetches pitch-by-pitch data from Savant statcast_search, computes the average
number of pitches to reach a 2-strike count per pitcher, and outputs JSON.

Usage:
  python3 race2k_pipeline.py [output_dir] [seasons]

Examples:
  python3 race2k_pipeline.py ./public 2025
  python3 race2k_pipeline.py ./public 2023,2024,2025
  python3 race2k_pipeline.py ./public 2025 --aaa

Output:
  {output_dir}/race2k_{season}.json
  {output_dir}/race2k_aaa_{season}.json   (if --aaa)
"""

import pandas as pd
import numpy as np
import requests
import json
import os
import sys
import time
from io import StringIO
from collections import defaultdict

try:
    from pybaseball import pitching_stats, cache
    cache.enable()
    HAS_PYBASEBALL = True
    print("✓ pybaseball available — FanGraphs IP/GS data enabled")
except ImportError:
    HAS_PYBASEBALL = False
    print("⚠ pybaseball not installed — will estimate IP from Savant data")
    print("  Install with: pip install pybaseball")

# ============================================================
# CONFIG
# ============================================================

MIN_IP = 20              # minimum innings pitched
FETCH_DELAY = 3.0        # seconds between Savant requests
MAX_RETRIES = 3
GS_THRESHOLD = 10        # games started threshold for SP classification

HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/csv,text/plain,application/json,*/*",
    "Accept-Language": "en-US,en;q=0.9",
}

SAVANT_BASE = "https://baseballsavant.mlb.com"
MLB_API = "https://statsapi.mlb.com/api/v1"

import unicodedata

def norm_name(s):
    """Normalize a player name: strip accents, periods, hyphens, Jr/Sr, lowercase."""
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

def fetch_url(url, retries=MAX_RETRIES, delay=FETCH_DELAY, expect="csv"):
    """Fetch URL with retry logic and rate limiting."""
    for attempt in range(1, retries + 1):
        try:
            time.sleep(delay if attempt > 1 else 0.5)
            r = requests.get(url, headers=HTTP_HEADERS, timeout=90)
            if r.status_code == 403:
                print(f"    ⚠ 403 Forbidden (attempt {attempt}/{retries})")
                time.sleep(delay * attempt * 2)
                continue
            r.raise_for_status()
            if expect == "json":
                return r.json()
            return r.text
        except requests.exceptions.RequestException as e:
            print(f"    ⚠ Fetch error (attempt {attempt}/{retries}): {e}")
            if attempt < retries:
                time.sleep(delay * attempt)
    print(f"    ✗ Failed after {retries} attempts: {url[:100]}")
    return None


def csv_to_df(text):
    """Parse CSV text to DataFrame."""
    if text is None or not text.strip() or "<!DOCTYPE" in str(text)[:200]:
        return None
    try:
        df = pd.read_csv(StringIO(text))
        df = df.dropna(how="all")
        return df
    except Exception as e:
        print(f"    ✗ CSV parse error: {e}")
        return None


# ============================================================
# SAVANT PITCH-BY-PITCH FETCH
# ============================================================

def fetch_savant_pitches(season, start_date, end_date, game_type="R"):
    """Fetch pitch-by-pitch data from Savant statcast_search for a date range."""
    gt = "R%7C" if game_type == "R" else "E%7C"
    url = (
        f"{SAVANT_BASE}/statcast_search/csv?all=true&type=detail"
        f"&player_type=pitcher"
        f"&hfGT={gt}"
        f"&hfSea={season}%7C"
        f"&game_date_gt={start_date}"
        f"&game_date_lt={end_date}"
    )
    text = fetch_url(url)
    return csv_to_df(text)


def get_date_ranges(season, game_type="R"):
    """Break the season into ~2-week chunks to avoid Savant row limits."""
    if game_type == "R":
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
    else:  # Spring Training
        return [
            (f"{season}-02-20", f"{season}-03-10"),
            (f"{season}-03-11", f"{season}-03-28"),
        ]


# ============================================================
# CORE METRIC COMPUTATION
# ============================================================

def compute_race2k_and_starts(all_pitches_df):
    """
    Compute avg pitches to reach 2 strikes per pitcher AND detect game starters.
    
    Game starter detection: for each game_pk, the pitcher who threw the pitch
    with the lowest pitch_number is the starter for that half-inning's team.
    We count how many games each pitcher started.
    
    Returns:
      race2k_results: dict pitcher_id -> {pitches_to_2k_sum, qualifying_pas, total_pas, name}
      game_starts: dict pitcher_id -> int (number of games started)
      outs_by_pitcher: dict pitcher_id -> int (total outs recorded, for IP estimation)
      teams_by_pitcher: dict pitcher_id -> str (team abbreviation from Savant)
    """
    if all_pitches_df is None or len(all_pitches_df) == 0:
        return {}, {}, {}, {}

    df = all_pitches_df.copy()

    # Ensure numeric types
    for col in ["pitcher", "game_pk", "at_bat_number", "inning", "pitch_number", "strikes"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    # ── Detect game starters ──
    # For each game, the pitcher who threw the pitch with the lowest pitch_number
    # (i.e. the very first pitch of each half of the 1st inning) is the starter.
    game_starts = defaultdict(int)
    if "pitch_number" in df.columns and "inning" in df.columns:
        first_inning = df[df["inning"] == 1].copy()
        if len(first_inning) > 0:
            # Group by game_pk and inning_topbot (or just game_pk if no topbot)
            group_cols = ["game_pk"]
            if "inning_topbot" in first_inning.columns:
                group_cols.append("inning_topbot")

            for _, grp in first_inning.groupby(group_cols):
                # The pitcher of the first pitch in this half-inning
                first_pitch = grp.loc[grp["pitch_number"].idxmin()]
                pid = first_pitch["pitcher"]
                if not pd.isna(pid):
                    game_starts[int(pid)] += 1

    # ── Compute outs per pitcher (for IP estimation) ──
    outs_by_pitcher = defaultdict(int)
    if "events" in df.columns:
        # Count PA-ending events that result in outs
        event_rows = df[df["events"].notna() & (df["events"] != "")].copy()
        out_events = {"strikeout", "field_out", "grounded_into_double_play",
                      "force_out", "fielders_choice", "fielders_choice_out",
                      "sac_fly", "sac_bunt", "double_play", "triple_play",
                      "strikeout_double_play", "sac_fly_double_play",
                      "field_error", "caught_stealing_2b", "caught_stealing_3b",
                      "caught_stealing_home", "pickoff_1b", "pickoff_2b",
                      "pickoff_3b", "other_out", "batter_interference",
                      "catcher_interf"}
        for _, row in event_rows.iterrows():
            ev = str(row["events"]).strip().lower()
            pid = row["pitcher"]
            if pd.isna(pid):
                continue
            pid = int(pid)
            if ev in out_events:
                outs_by_pitcher[pid] += 1
                if "double_play" in ev:
                    outs_by_pitcher[pid] += 1
                elif "triple_play" in ev:
                    outs_by_pitcher[pid] += 2

    # ── Compute race to 2K metric ──
    df["pa_key"] = (
        df["pitcher"].astype(str) + "-" +
        df["game_pk"].astype(str) + "-" +
        df["at_bat_number"].astype(str) + "-" +
        df["inning"].astype(str)
    )
    df = df.sort_values(["pa_key", "pitch_number"])

    results = {}
    for pa_key, pa_df in df.groupby("pa_key"):
        pid = pa_df["pitcher"].iloc[0]
        if pd.isna(pid):
            continue
        pid = int(pid)

        # Get pitcher name
        pname = ""
        if "player_name" in pa_df.columns:
            pname = str(pa_df["player_name"].iloc[0])
            if ", " in pname:
                parts = pname.split(", ", 1)
                pname = f"{parts[1]} {parts[0]}"

        if pid not in results:
            results[pid] = {
                "name": pname,
                "pitches_to_2k_sum": 0,
                "qualifying_pas": 0,
                "total_pas": 0,
            }
        results[pid]["total_pas"] += 1
        if pname and not results[pid]["name"]:
            results[pid]["name"] = pname

        pitches = pa_df.to_dict("records")
        for i, pitch in enumerate(pitches):
            strike_count_before = pitch.get("strikes", 0)
            if pd.isna(strike_count_before):
                strike_count_before = 0
            strike_count_before = int(strike_count_before)

            if strike_count_before >= 2:
                results[pid]["pitches_to_2k_sum"] += i
                results[pid]["qualifying_pas"] += 1
                break
        else:
            if len(pitches) > 0:
                last = pitches[-1]
                last_strikes = int(last.get("strikes", 0)) if not pd.isna(last.get("strikes")) else 0
                desc = str(last.get("description", "")).lower()
                events = str(last.get("events", "")).lower()
                is_strike_call = ("strike" in desc or "foul" in desc or "swinging" in desc)
                if last_strikes == 1 and (is_strike_call or "strikeout" in events):
                    results[pid]["pitches_to_2k_sum"] += len(pitches)
                    results[pid]["qualifying_pas"] += 1

    # ── Extract team per pitcher from Savant columns ──
    # Pitchers: if inning_topbot == "Top", pitcher is home team; "Bot" = away team
    teams_by_pitcher = {}
    has_team_cols = "home_team" in df.columns and "away_team" in df.columns
    has_topbot = "inning_topbot" in df.columns
    if has_team_cols and has_topbot:
        # Get most recent game's team for each pitcher
        for pid_val, grp in df.groupby("pitcher"):
            if pd.isna(pid_val):
                continue
            pid_int = int(pid_val)
            last_row = grp.iloc[-1]  # most recent pitch
            topbot = str(last_row.get("inning_topbot", "")).strip()
            if topbot == "Top":
                team = str(last_row.get("home_team", "")).strip()
            elif topbot == "Bot":
                team = str(last_row.get("away_team", "")).strip()
            else:
                team = ""
            if team:
                teams_by_pitcher[pid_int] = team

    return results, dict(game_starts), dict(outs_by_pitcher), teams_by_pitcher


def merge_results(acc_r2k, acc_gs, acc_outs, acc_teams, partial_r2k, partial_gs, partial_outs, partial_teams):
    """Merge partial chunk results into accumulators."""
    for pid, data in partial_r2k.items():
        if pid not in acc_r2k:
            acc_r2k[pid] = {"name": data["name"], "pitches_to_2k_sum": 0, "qualifying_pas": 0, "total_pas": 0}
        acc_r2k[pid]["pitches_to_2k_sum"] += data["pitches_to_2k_sum"]
        acc_r2k[pid]["qualifying_pas"] += data["qualifying_pas"]
        acc_r2k[pid]["total_pas"] += data["total_pas"]
        if data["name"]:
            acc_r2k[pid]["name"] = data["name"]

    for pid, gs in partial_gs.items():
        acc_gs[pid] = acc_gs.get(pid, 0) + gs

    for pid, outs in partial_outs.items():
        acc_outs[pid] = acc_outs.get(pid, 0) + outs

    # Teams: always overwrite with latest (most recent chunk = most current team)
    for pid, team in partial_teams.items():
        acc_teams[pid] = team


# ============================================================
# MLB API: ROSTER (team info) + IP
# ============================================================

def fetch_pitcher_info(season, sport_id=1):
    """
    Fetch pitcher IP, GS, team via pybaseball (FanGraphs).
    Falls back to MLB API roster hydration if pybaseball unavailable.
    
    Returns TWO dicts:
      by_id:   mlbam_id -> {name, team, ip, gs}  (from MLB API roster)
      by_name: normalized_name -> {ip, gs, team}  (from FanGraphs)
    """
    by_id = {}
    by_name = {}

    # ── pybaseball (FanGraphs) — keyed by name since FG uses IDfg not MLBAM ──
    if HAS_PYBASEBALL and sport_id == 1:
        print(f"  Fetching FanGraphs pitching stats ({season}) via pybaseball...")
        try:
            df = pitching_stats(season, season, qual=0)
            print(f"    ✓ {len(df)} pitchers from FanGraphs")
            print(f"    Columns: {list(df.columns)[:20]}...")

            name_col = "Name" if "Name" in df.columns else "PlayerName" if "PlayerName" in df.columns else None
            ip_col = "IP" if "IP" in df.columns else None
            gs_col = "GS" if "GS" in df.columns else None
            team_col = "Team" if "Team" in df.columns else None

            if name_col and ip_col:
                for _, row in df.iterrows():
                    name = str(row.get(name_col, "")).strip()
                    if not name:
                        continue
                    ip = float(row.get(ip_col, 0)) if pd.notna(row.get(ip_col)) else 0
                    gs = int(row.get(gs_col, 0)) if gs_col and pd.notna(row.get(gs_col)) else 0
                    team = str(row.get(team_col, "")).strip() if team_col and pd.notna(row.get(team_col)) else ""
                    nname = norm_name(name)
                    # Keep the entry with more IP if name collision
                    if nname not in by_name or ip > by_name[nname]["ip"]:
                        by_name[nname] = {"ip": ip, "gs": gs, "team": team, "name": name}

                ip_count = sum(1 for p in by_name.values() if p["ip"] >= MIN_IP)
                gs_count = sum(1 for p in by_name.values() if p["gs"] >= GS_THRESHOLD)
                print(f"    ✓ {ip_count} with {MIN_IP}+ IP, {gs_count} starters ({GS_THRESHOLD}+ GS)")
            else:
                print(f"    ⚠ Missing columns. name={name_col} ip={ip_col}")
        except Exception as e:
            print(f"    ⚠ pybaseball failed: {e}")

    # ── MLB API rosters — for MLBAM ID → name/team mapping ──
    print("  Fetching MLB API rosters for ID mapping...")
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
                        continue
                    pid = p["person"]["id"]
                    name = p["person"]["fullName"]
                    abbr = team.get("abbreviation", "")

                    # Try to find FG stats by name
                    nname = norm_name(name)
                    fg = by_name.get(nname, {})

                    by_id[pid] = {
                        "name": name,
                        "team": fg.get("team", abbr) or abbr,
                        "ip": fg.get("ip", 0),
                        "gs": fg.get("gs", 0),
                    }
                time.sleep(0.05)
            except Exception:
                pass
    except Exception as e:
        print(f"    ⚠ Roster fetch failed: {e}")

    ip_count = sum(1 for p in by_id.values() if p["ip"] >= MIN_IP)
    gs_count = sum(1 for p in by_id.values() if p["gs"] >= GS_THRESHOLD)
    print(f"    ✓ {len(by_id)} pitchers mapped (ID→name→FG stats)")
    print(f"    ✓ {ip_count} with {MIN_IP}+ IP, {gs_count} starters ({GS_THRESHOLD}+ GS)")
    return by_id, by_name


# ============================================================
# PERCENTILE COMPUTATION
# ============================================================

def compute_percentile(pool, value, lower_better=False):
    """Compute percentile of a value vs a pool."""
    pool = pool.dropna()
    if len(pool) == 0 or not np.isfinite(value):
        return None
    pct = (pool < value).sum() / len(pool) * 100
    if lower_better:
        pct = 100 - pct
    return round(pct, 1)


# ============================================================
# MAIN PIPELINE
# ============================================================

def run_pipeline(season, output_dir, sport_id=1):
    """Run the race2k pipeline for a single season."""
    os.makedirs(output_dir, exist_ok=True)
    suffix = "_aaa" if sport_id == 11 else ""
    league = "AAA" if sport_id == 11 else "MLB"

    print(f"\n{'#'*60}")
    print(f"# Race to 2 Strikes Pipeline")
    print(f"# Season: {season} | League: {league}")
    print(f"# Output: {output_dir}")
    print(f"{'#'*60}")

    # 1. Fetch pitcher info (team + IP from MLB API)
    print(f"\n{'='*50}")
    print(f"PITCHER INFO — {season} {league}")
    print(f"{'='*50}")
    pitcher_info, fg_by_name = fetch_pitcher_info(season, sport_id)

    # 2. Fetch pitch-by-pitch data in chunks
    print(f"\n{'='*50}")
    print(f"SAVANT PITCH DATA — {season} {league}")
    print(f"{'='*50}")

    date_ranges = get_date_ranges(season, "R")
    acc_r2k = {}
    acc_gs = {}
    acc_outs = {}
    acc_teams = {}
    total_pitches = 0

    for i, (start, end) in enumerate(date_ranges):
        print(f"\n  Chunk {i+1}/{len(date_ranges)}: {start} → {end}")
        df = fetch_savant_pitches(season, start, end, "R")
        if df is not None and len(df) > 0:
            print(f"    ✓ {len(df):,} pitches")
            total_pitches += len(df)
            partial_r2k, partial_gs, partial_outs, partial_teams = compute_race2k_and_starts(df)
            merge_results(acc_r2k, acc_gs, acc_outs, acc_teams, partial_r2k, partial_gs, partial_outs, partial_teams)
        else:
            print(f"    — No data")
        time.sleep(FETCH_DELAY)

    print(f"\n  Total pitches processed: {total_pitches:,}")
    print(f"  Pitchers with data: {len(acc_r2k)}")

    # Game start summary
    gs_counts = sorted(acc_gs.values(), reverse=True)
    sp_from_savant = sum(1 for gs in gs_counts if gs >= GS_THRESHOLD)
    print(f"  Game starts detected from Savant data: {sum(gs_counts)} total across {len(acc_gs)} pitchers")
    print(f"  Starters (>= {GS_THRESHOLD} GS): {sp_from_savant}")

    # 3. Build final leaderboard
    print(f"\n{'='*50}")
    print(f"BUILDING LEADERBOARD")
    print(f"{'='*50}")

    entries = []
    for pid, metrics in acc_r2k.items():
        if metrics["qualifying_pas"] < 10:
            continue

        info = pitcher_info.get(pid, {})
        ip = info.get("ip", 0)
        gs = info.get("gs", 0)
        team = info.get("team", "")
        name = info.get("name") or metrics["name"] or ""

        # If MLB API roster didn't have FG stats for this pitcher, try name match
        if ip == 0 and metrics["name"]:
            nname = norm_name(metrics["name"])
            fg = fg_by_name.get(nname, {})
            if fg.get("ip", 0) > 0:
                ip = fg["ip"]
                gs = fg.get("gs", gs)
                team = fg.get("team", team) or team
                name = fg.get("name", name) or name

        # Fallback team from Savant pitch data (most recent game)
        if not team and pid in acc_teams:
            team = acc_teams[pid]

        # Fallback IP from Savant outs if no FG/API data
        if ip == 0 and pid in acc_outs:
            outs = acc_outs[pid]
            ip = round(outs / 3 + (outs % 3) * 0.1, 1)

        if not name:
            name = "Player %d" % pid

        if ip < MIN_IP:
            continue

        # SP/RP: prefer FG GS, fallback to Savant game start detection
        if gs == 0:
            gs = acc_gs.get(pid, 0)
        is_sp = gs >= GS_THRESHOLD

        avg = metrics["pitches_to_2k_sum"] / metrics["qualifying_pas"]
        reach_pct = round(metrics["qualifying_pas"] / metrics["total_pas"] * 100, 1) if metrics["total_pas"] > 0 else 0

        entries.append({
            "player_id": pid,
            "name": name,
            "team": team,
            "ip": round(ip, 1),
            "gs": gs,
            "is_sp": is_sp,
            "avg_pitches_to_2k": round(avg, 3),
            "qualifying_pas": metrics["qualifying_pas"],
            "total_pas": metrics["total_pas"],
            "reach_pct": reach_pct,
        })

    # Sort by avg (ascending = fewer pitches = better)
    entries.sort(key=lambda x: x["avg_pitches_to_2k"])

    sp_list = [e for e in entries if e["is_sp"]]
    rp_list = [e for e in entries if not e["is_sp"]]

    # Compute percentiles within each group
    sp_avgs = pd.Series([e["avg_pitches_to_2k"] for e in sp_list])
    rp_avgs = pd.Series([e["avg_pitches_to_2k"] for e in rp_list])

    for e in sp_list:
        e["pctile"] = compute_percentile(sp_avgs, e["avg_pitches_to_2k"], lower_better=True)
    for e in rp_list:
        e["pctile"] = compute_percentile(rp_avgs, e["avg_pitches_to_2k"], lower_better=True)

    print(f"  ✓ {len(sp_list)} starters, {len(rp_list)} relievers qualified")
    if sp_list:
        print(f"  SP range: {sp_list[0]['avg_pitches_to_2k']:.2f} — {sp_list[-1]['avg_pitches_to_2k']:.2f}")
        top5 = ", ".join(e["name"] + " (%.2f, %dgs)" % (e["avg_pitches_to_2k"], e["gs"]) for e in sp_list[:5])
        print(f"  SP top 5: {top5}")
    if rp_list:
        print(f"  RP range: {rp_list[0]['avg_pitches_to_2k']:.2f} — {rp_list[-1]['avg_pitches_to_2k']:.2f}")

    # 4. Write output
    output = {
        "season": season,
        "league": league,
        "starters": sp_list,
        "relievers": rp_list,
        "meta": {
            "min_ip": MIN_IP,
            "gs_threshold": GS_THRESHOLD,
            "total_pitches_analyzed": total_pitches,
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
        },
    }

    fname = f"race2k{suffix}_{season}.json"
    fpath = os.path.join(output_dir, fname)
    with open(fpath, "w") as f:
        json.dump(output, f, indent=2)
    print(f"\n  → Wrote {fpath}")
    print(f"    {len(sp_list)} starters + {len(rp_list)} relievers")

    print(f"\n{'#'*60}")
    print(f"# Pipeline complete!")
    print(f"{'#'*60}\n")


# ============================================================
# CLI
# ============================================================

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Race to 2 Strikes Pipeline")
    parser.add_argument("output_dir", nargs="?", default="./public", help="Output directory")
    parser.add_argument("season", nargs="?", default="2025", help="Comma-separated seasons (e.g. 2023,2024,2025)")
    parser.add_argument("--aaa", action="store_true", help="Fetch AAA data (sportId=11)")
    args = parser.parse_args()

    sport_id = 11 if args.aaa else 1
    seasons = [int(s.strip()) for s in args.season.split(",")]
    for season in seasons:
        run_pipeline(season, args.output_dir, sport_id)
