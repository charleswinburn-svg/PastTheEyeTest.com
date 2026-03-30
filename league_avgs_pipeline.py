#!/usr/bin/env python3
"""
league_avgs_pipeline.py — Fetch actual league-wide averages per pitch type from Savant.
Outputs league_avgs.json with zone%, whiff%, velo, spin per pitch type.

Usage: python3 league_avgs_pipeline.py ./public [season]
"""
import requests, json, os, sys, time
from io import StringIO
import pandas as pd

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
}

def fetch_csv(url):
    time.sleep(1)
    r = requests.get(url, headers=HEADERS, timeout=60)
    if r.status_code != 200 or "<!DOCTYPE" in r.text[:200]:
        return None
    return pd.read_csv(StringIO(r.text)).dropna(how="all")

def run(output_dir, season=2025):
    os.makedirs(output_dir, exist_ok=True)
    print(f"Fetching {season} league averages from Savant...")

    # Statcast search: all pitches, regular season, grouped by pitch type
    # We'll fetch pitch-level data in chunks and aggregate ourselves
    gt = "R%7C"
    ranges = [
        (f"{season}-03-20", f"{season}-05-31"),
        (f"{season}-06-01", f"{season}-07-31"),
        (f"{season}-08-01", f"{season}-10-02"),
    ]

    all_rows = []
    for start, end in ranges:
        print(f"  Fetching {start} to {end}...")
        url = (
            f"https://baseballsavant.mlb.com/statcast_search/csv?all=true&type=detail"
            f"&player_type=pitcher&hfGT={gt}&hfSea={season}%7C"
            f"&game_date_gt={start}&game_date_lt={end}"
        )
        df = fetch_csv(url)
        if df is not None and len(df) > 0:
            print(f"    {len(df):,} pitches")
            all_rows.append(df)
        else:
            print(f"    No data")
        time.sleep(3)

    if not all_rows:
        print("No data fetched!")
        return

    df = pd.concat(all_rows, ignore_index=True)
    print(f"\n  Total pitches: {len(df):,}")

    # Ensure numeric
    for col in ["release_speed", "release_spin_rate", "plate_x", "plate_z",
                 "sz_top", "sz_bot", "release_extension"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    # Zone calculation
    def in_zone(row):
        px, pz = row.get("plate_x"), row.get("plate_z")
        szt, szb = row.get("sz_top", 3.5), row.get("sz_bot", 1.5)
        if pd.isna(px) or pd.isna(pz):
            return None
        if pd.isna(szt): szt = 3.5
        if pd.isna(szb): szb = 1.5
        # Standard Savant zone: plate width ±0.83 ft, sz_bot to sz_top (no buffer)
        return abs(px) <= 0.83 and pz >= szb and pz <= szt

    df["in_zone"] = df.apply(in_zone, axis=1)

    # Is swing / is whiff — use description field
    swing_descs = {"swinging_strike", "swinging_strike_blocked", "foul", "foul_tip",
                   "foul_bunt", "missed_bunt", "hit_into_play", "hit_into_play_no_out",
                   "hit_into_play_score", "foul_pitchout", "swinging_pitchout"}
    whiff_descs = {"swinging_strike", "swinging_strike_blocked", "foul_tip", "missed_bunt", "swinging_pitchout"}
    if "description" in df.columns:
        df["is_swing"] = df["description"].isin(swing_descs)
        df["is_whiff"] = df["description"].isin(whiff_descs)
    else:
        df["is_swing"] = False
        df["is_whiff"] = False

    # Group by pitch type
    result = {}
    for pt, grp in df.groupby("pitch_type"):
        if pd.isna(pt) or str(pt).strip() == "" or len(grp) < 500:
            continue
        pt = str(pt).strip()

        velos = grp["release_speed"].dropna()
        spins = grp["release_spin_rate"].dropna()
        exts = grp["release_extension"].dropna() if "release_extension" in grp.columns else pd.Series(dtype=float)
        zoned = grp[grp["in_zone"].notna()]
        in_z = zoned[zoned["in_zone"] == True]
        swings = grp[grp["is_swing"] == True]
        whiffs = grp[grp["is_whiff"] == True]

        result[pt] = {
            "count": len(grp),
            "velo": round(velos.mean(), 1) if len(velos) > 0 else None,
            "spin": round(spins.mean()) if len(spins) > 0 else None,
            "zone_pct": round(len(in_z) / len(zoned) * 100, 1) if len(zoned) > 0 else None,
            "whiff_pct": round(len(whiffs) / len(swings) * 100, 1) if len(swings) > 0 else None,
            "extension": round(exts.mean(), 2) if len(exts) > 0 else None,
        }
        print(f"  {pt}: {len(grp):,} pitches | Velo {result[pt]['velo']} | Zone% {result[pt]['zone_pct']} | Whiff% {result[pt]['whiff_pct']}")

    output = {
        "season": season,
        "pitch_types": result,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
    }

    fpath = os.path.join(output_dir, f"league_avgs_{season}.json")
    with open(fpath, "w") as f:
        json.dump(output, f, indent=2)
    print(f"\n  → Wrote {fpath}")

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "./public"
    yr = int(sys.argv[2]) if len(sys.argv) > 2 else 2025
    run(out, yr)
