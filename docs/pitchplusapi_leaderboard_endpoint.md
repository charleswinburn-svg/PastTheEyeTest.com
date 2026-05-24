# `/leaderboard` endpoint — drop-in for `pitchplusapi/server.py`

The new **Pitch Modeling** sub-tab under LEADERBOARD in the React app
(`src/baseball/PitchModelingLeaderboard.jsx`) fetches one URL:

```
GET https://pitch-plus-api.onrender.com/leaderboard?season=2026
```

The endpoint reads the two season-aggregate JSON files that `score_pitches.py`
already writes (`pitcher_grades_<season>.json` and
`pitcher_pitch_type_grades_<season>.json`), converts the per-100 `xRV` values
to **+ scale** (100 = league mean, ±10 ≈ 1σ, lower xRV is better → higher +),
and returns one record per pitcher with overall + per-pitch-type values.

## Response shape

```json
{
  "season": 2026,
  "pitchers": [
    {
      "player_id": 663423,
      "overall":  { "stuff": 108.2, "loc": 96.4, "tun": 103.1, "pitch": 105.7, "n": 1843 },
      "by_pitch_type": {
        "FF": { "stuff": 112.1, "loc": 98.0, "tun": 104.2, "pitch": 108.5, "n": 980 },
        "SL": { "stuff": 105.4, "loc": 94.0, "tun": 101.8, "pitch": 102.7, "n": 510 },
        "CH": { "stuff": 102.1, "loc": 97.0, "tun": 99.4,  "pitch": 100.2, "n": 353 }
      }
    },
    ...
  ]
}
```

## Drop-in handler

`score_pitches.py write_season_aggregates()` already computes
`stuff_plus / loc_plus / tun_plus / pitch_plus` per pitcher AND per
(pitcher, pitch_type) using `pitch_plus_norm.json` — the same norms the
summary cards use. The endpoint just reads those fields directly. Do NOT
re-z-score against a pitcher-level pool — that produces different stds
and the leaderboard numbers won't match the summary cards.

```python
import json
from pathlib import Path
from functools import lru_cache
from flask import jsonify, request  # adapt to fastapi if needed

SEASON_DIR = Path("./output/season")   # ← where score_pitches.py writes
MIN_N_OVERALL = 200                    # pitches needed to appear in overall pool
MIN_N_PER_PITCH_TYPE = 30              # pitches needed to be ranked within a type


@lru_cache(maxsize=8)
def _build_leaderboard(season: int) -> dict:
    """Pure function; cached. Returns the JSON-serializable payload."""
    overall_path = SEASON_DIR / f"pitcher_grades_{season}.json"
    pt_path      = SEASON_DIR / f"pitcher_pitch_type_grades_{season}.json"
    if not overall_path.exists() or not pt_path.exists():
        return {"season": season, "pitchers": [], "error": "aggregates not found"}

    overall_raw = json.loads(overall_path.read_text())
    pt_raw      = json.loads(pt_path.read_text())

    # ── Overall: read pre-computed *_plus fields straight from the JSON.
    overall_plus = {}
    for pid, g in overall_raw.items():
        if g.get("n", 0) < MIN_N_OVERALL:
            continue
        overall_plus[pid] = {
            "stuff": g.get("stuff_plus"),
            "loc":   g.get("loc_plus"),
            "tun":   g.get("tun_plus"),
            "pitch": g.get("pitch_plus"),
            "n":     int(g["n"]),
        }

    # ── Per-pitch-type: same — read pre-computed *_plus per (pitcher, pt).
    by_pt_plus = {}      # {pid: {pt: { stuff, loc, tun, pitch, n }}}
    for pid, types in pt_raw.items():
        for pt, g in types.items():
            if g.get("n", 0) < MIN_N_PER_PITCH_TYPE:
                continue
            by_pt_plus.setdefault(pid, {})[pt] = {
                "stuff": g.get("stuff_plus"),
                "loc":   g.get("loc_plus"),
                "tun":   g.get("tun_plus"),
                "pitch": g.get("pitch_plus"),
                "n":     int(g["n"]),
            }

    result = []
    for pid, overall in overall_plus.items():
        result.append({
            "player_id":    int(pid),
            "overall":      overall,
            "by_pitch_type": by_pt_plus.get(pid, {}),
        })

    return {"season": season, "pitchers": result}


@app.route("/leaderboard")
def leaderboard():
    try:
        season = int(request.args.get("season", "0"))
    except ValueError:
        return jsonify({"error": "season must be an integer"}), 400
    if season < 2015 or season > 2100:
        return jsonify({"error": f"season out of range: {season}"}), 400
    return jsonify(_build_leaderboard(season))
```

## Debugging blank pitch-type cells

If `Overall` is populated but FF/SL/CH/etc. are all blanks:

1. `curl 'https://pitch-plus-api.onrender.com/leaderboard?season=2026' | python3 -m json.tool | head -50` — confirm `by_pitch_type` is empty `{}` for every pitcher (server-side bug) vs. populated with values the React app fails to render (client-side bug).
2. If `by_pitch_type` is empty: open `pitcher_pitch_type_grades_2026.json` and confirm each entry has `stuff_plus / loc_plus / tun_plus / pitch_plus`. If they're missing, the file was written by an older `score_pitches.py` that didn't compute per-type plus values — rerun the pipeline.
3. If the file has the fields but the endpoint still returns `{}`: the server is still using the old `_to_plus_pool`/`_z_to_plus` path with a `MIN_N_PER_PITCH_TYPE` that filtered everything out, OR the pid keys in `pt_raw` don't match `overall_raw` (string vs. int). Use the version above which reads directly and matches pids as strings.

## CORS

If `pitchplusapi` doesn't already allow the React app's origin, add the React
dev origin (or `*`) to the existing CORS config. The other endpoints (`/score`,
`/pitcher_grades_distribution`) already work, so this is likely already set up.

## Refresh cadence

`_build_leaderboard` is `lru_cache`'d per season. If you rerun
`score_pitches.py`, restart the Render service (or clear the cache with a
sentinel admin endpoint).
