#!/usr/bin/env python3
"""
Reprocess existing race2k JSON files with a new GS threshold.
No Savant fetching needed — just reads and rewrites.

Usage: python3 race2k_rethreshold.py ./public 2023,2024,2025
"""
import json, sys, os

GS_THRESHOLD = 10

output_dir = sys.argv[1] if len(sys.argv) > 1 else "./public"
seasons = sys.argv[2] if len(sys.argv) > 2 else "2023,2024,2025"

for season in seasons.split(","):
    fname = f"race2k_{season.strip()}.json"
    fpath = os.path.join(output_dir, fname)
    if not os.path.exists(fpath):
        print(f"  ✗ {fpath} not found, skipping")
        continue

    with open(fpath) as f:
        data = json.load(f)

    # Combine all players, re-split with new threshold
    all_players = data.get("starters", []) + data.get("relievers", [])
    sp = [p for p in all_players if p.get("gs", 0) >= GS_THRESHOLD]
    rp = [p for p in all_players if p.get("gs", 0) < GS_THRESHOLD]

    # Update is_sp flag
    for p in sp:
        p["is_sp"] = True
    for p in rp:
        p["is_sp"] = False

    # Re-sort each group
    sp.sort(key=lambda x: x["avg_pitches_to_2k"])
    rp.sort(key=lambda x: x["avg_pitches_to_2k"])

    data["starters"] = sp
    data["relievers"] = rp
    data["meta"]["gs_threshold"] = GS_THRESHOLD

    with open(fpath, "w") as f:
        json.dump(data, f, indent=2)

    print(f"  ✓ {fname}: {len(sp)} starters, {len(rp)} relievers (GS >= {GS_THRESHOLD})")
