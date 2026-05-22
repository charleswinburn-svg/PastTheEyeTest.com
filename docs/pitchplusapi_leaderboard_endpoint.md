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

Paste this into `pitchplusapi/server.py`. Adjust `SEASON_DIR` to point at the
directory where `score_pitches.py --output-dir` wrote the season aggregates.

```python
import json
import math
import statistics
from pathlib import Path
from functools import lru_cache
from flask import jsonify, request  # adapt to fastapi if needed

SEASON_DIR = Path("./output/season")   # ← where score_pitches.py writes
MIN_N_OVERALL = 200                    # pitches needed to appear in overall pool
MIN_N_PER_PITCH_TYPE = 30              # pitches needed to be ranked within a type


def _to_plus_pool(per100_values):
    """Return (mu, sd) for converting per-100 xRV to + scale.
    + value = 100 - z*10 (lower xRV is better, so invert)."""
    if len(per100_values) < 2:
        return 0.0, 1.0
    mu = statistics.mean(per100_values)
    sd = statistics.pstdev(per100_values)
    return mu, (sd if sd > 0 else 1.0)


def _z_to_plus(v, mu, sd):
    z = (v - mu) / sd if sd else 0
    return round(100 - z * 10, 1)


@lru_cache(maxsize=8)
def _build_leaderboard(season: int) -> dict:
    """Pure function; cached. Returns the JSON-serializable payload."""
    overall_path = SEASON_DIR / f"pitcher_grades_{season}.json"
    pt_path      = SEASON_DIR / f"pitcher_pitch_type_grades_{season}.json"
    if not overall_path.exists() or not pt_path.exists():
        return {"season": season, "pitchers": [], "error": "aggregates not found"}

    overall_raw = json.loads(overall_path.read_text())
    pt_raw      = json.loads(pt_path.read_text())

    # ── Overall + scale: pool across qualified pitchers, per metric.
    overall_qualified = {
        pid: g for pid, g in overall_raw.items() if g.get("n", 0) >= MIN_N_OVERALL
    }
    overall_pools = {}
    for metric in ("xRV", "stuff", "loc", "tun"):
        vals = [g[metric] for g in overall_qualified.values()]
        overall_pools[metric] = _to_plus_pool(vals)

    overall_plus = {}
    for pid, g in overall_qualified.items():
        overall_plus[pid] = {
            "stuff": _z_to_plus(g["stuff"], *overall_pools["stuff"]),
            "loc":   _z_to_plus(g["loc"],   *overall_pools["loc"]),
            "tun":   _z_to_plus(g["tun"],   *overall_pools["tun"]),
            "pitch": _z_to_plus(g["xRV"],   *overall_pools["xRV"]),
            "n":     int(g["n"]),
        }

    # ── Per-pitch-type + scale: separate pool for each pitch type.
    by_pt_groups = {}
    for pid, types in pt_raw.items():
        for pt, g in types.items():
            if g.get("n", 0) < MIN_N_PER_PITCH_TYPE:
                continue
            by_pt_groups.setdefault(pt, []).append((pid, g))

    by_pt_plus = {}      # {pid: {pt: { stuff, loc, tun, pitch, n }}}
    for pt, rows in by_pt_groups.items():
        pools = {}
        for metric in ("xRV", "stuff", "loc", "tun"):
            pools[metric] = _to_plus_pool([g[metric] for _, g in rows])
        for pid, g in rows:
            by_pt_plus.setdefault(pid, {})[pt] = {
                "stuff": _z_to_plus(g["stuff"], *pools["stuff"]),
                "loc":   _z_to_plus(g["loc"],   *pools["loc"]),
                "tun":   _z_to_plus(g["tun"],   *pools["tun"]),
                "pitch": _z_to_plus(g["xRV"],   *pools["xRV"]),
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

## CORS

If `pitchplusapi` doesn't already allow the React app's origin, add the React
dev origin (or `*`) to the existing CORS config. The other endpoints (`/score`,
`/pitcher_grades_distribution`) already work, so this is likely already set up.

## Refresh cadence

`_build_leaderboard` is `lru_cache`'d per season. If you rerun
`score_pitches.py`, restart the Render service (or clear the cache with a
sentinel admin endpoint).
