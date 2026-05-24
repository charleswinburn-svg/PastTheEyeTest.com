# `/score_aggregate` endpoint — drop-in spec for `pitchplusapi/server.py`

## Why

`/score` returns per-pitch `stuff_plus / loc_plus / tunnel_plus / pitch_plus`
values normalized against the **pitch-level** mu/sd (every MLB pitch). When a
client averages those per-pitch values over a subset (a single game, a date
range, etc.), the result is still on the pitch-level scale — σ ≈ 10 across
individual pitches.

The season summary cards and the `/leaderboard` endpoint instead present Plus
values on the **pitcher × pitch-type** scale, where σ is much smaller (the
spread across pitcher×type *means*, not individual pitches). Averaging
pitch-level Plus does **not** convert to the pitcher×type scale, so single-game
and season views end up on different scales and aren't directly comparable.

Example: Dylan Cease, 2026-05-24 vs PIT. 13 four-seamers averaged 97.1 mph,
producing a `/score`-averaged FF Stuff+ of 91. His season FF Stuff+ (from
`/leaderboard`, on the pitcher×type scale) is 104. Same scale would put that
game's FF at ~80-something.

`/score_aggregate` scores the same pitches, then aggregates the raw model
outputs into per-(pitcher, pitch_type) buckets using the same
`pitch_plus_norm.json` levels `score_pitches.py write_season_aggregates()`
uses for the season JSONs. The result matches the season-scale numbers
exactly when run on a full season of pitches, and stays on the same scale
for any subset.

## Request

Same payload shape as `/score`. The server only needs `pitcher_id`,
`details.type.code`, and the existing `pitchData.*` fields.

```
POST /score_aggregate
Content-Type: application/json

{
  "pitches": [
    {
      "pitcher_id": 656302,
      "_stand": "L",
      "_p_throws": "R",
      "details": { "type": { "code": "FF" } },
      "pitchData": { "startSpeed": 97.1, "extension": 6.4, ... }
    },
    ...
  ]
}
```

## Response

```json
{
  "by_pitch_type": {
    "FF": { "stuff": 91.4, "loc": 104.2, "tun": 103.1, "pitch": 102.0, "n": 13 },
    "SL": { "stuff": 119.3, "loc": 101.0, "tun": 100.2, "pitch": 104.5, "n": 15 },
    ...
  },
  "overall": { "stuff": 105.1, "loc": 101.4, "tun": 100.6, "pitch": 102.3, "n": 50 },
  "by_pitcher": {
    "656302": {
      "by_pitch_type": { "FF": {...}, "SL": {...} },
      "overall": {...}
    }
  }
}
```

- `by_pitch_type` aggregates **across all pitchers** in the payload — useful
  when the caller is a single-pitcher card (one pitcher_id throughout).
- `overall` is the usage-weighted average of `by_pitch_type`.
- `by_pitcher` keys by `pitcher_id` for multi-pitcher payloads (game-level
  views, multi-game scrapes). Optional — only included if the payload has more
  than one distinct `pitcher_id`.

## Implementation sketch

`score_pitches.py write_season_aggregates()` already does exactly the
aggregation we need. The endpoint can reuse the helper(s) it calls. Pseudocode:

```python
from collections import defaultdict
from flask import jsonify, request

# Reuse from score_pitches.py:
from score_pitches import (
    score_pitches,            # model.predict over the input pitches
    _per_type_plus,           # applies pitch_plus_norm at pitcher×type level
    _overall_plus,            # usage-weighted average of per-type Plus
    load_norms,               # loads pitch_plus_norm.json
)

@app.route("/score_aggregate", methods=["POST"])
def score_aggregate():
    body = request.get_json(silent=True) or {}
    pitches = body.get("pitches") or []
    if not pitches:
        return jsonify({"error": "no pitches"}), 400

    # 1. Score every pitch (same step /score does, but keep the raw
    #    model outputs instead of returning per-pitch *_plus).
    scored = score_pitches(pitches)   # list of dicts with raw xRV components

    # 2. Group by (pitcher_id, pitch_type).
    buckets = defaultdict(list)        # key: (pid, pt) -> list of scored rows
    for p, s in zip(pitches, scored):
        pid = p.get("pitcher_id")
        pt  = (p.get("details") or {}).get("type", {}).get("code")
        if pid is None or not pt:
            continue
        buckets[(pid, pt)].append(s)

    norms = load_norms()

    # 3. Per (pitcher, pitch_type): average raw xRV components, then z-score
    #    against the pitcher×type pool in pitch_plus_norm.json.
    per_pid_pt = {}    # {pid: {pt: {stuff, loc, tun, pitch, n}}}
    for (pid, pt), rows in buckets.items():
        agg = _per_type_plus(rows, norms, pitch_type=pt)
        per_pid_pt.setdefault(pid, {})[pt] = {
            "stuff": agg["stuff_plus"],
            "loc":   agg["loc_plus"],
            "tun":   agg["tun_plus"],
            "pitch": agg["pitch_plus"],
            "n":     len(rows),
        }

    # 4. Per pitcher: usage-weighted overall.
    per_pid_overall = {
        pid: _overall_plus(pt_map) for pid, pt_map in per_pid_pt.items()
    }

    # 5. Cross-pitcher aggregation for the simple single-pitcher case.
    cross_by_pt = {}
    for pt_map in per_pid_pt.values():
        for pt, g in pt_map.items():
            if pt not in cross_by_pt:
                cross_by_pt[pt] = {"stuff": 0, "loc": 0, "tun": 0, "pitch": 0, "n": 0}
            for k in ("stuff", "loc", "tun", "pitch"):
                if g.get(k) is not None:
                    cross_by_pt[pt][k] += g[k] * g["n"]
            cross_by_pt[pt]["n"] += g["n"]
    for pt, g in cross_by_pt.items():
        if g["n"]:
            for k in ("stuff", "loc", "tun", "pitch"):
                g[k] = round(g[k] / g["n"], 1)

    cross_overall = _overall_plus(cross_by_pt)

    resp = {"by_pitch_type": cross_by_pt, "overall": cross_overall}
    if len(per_pid_pt) > 1:
        resp["by_pitcher"] = {
            str(pid): {"by_pitch_type": pt_map, "overall": per_pid_overall[pid]}
            for pid, pt_map in per_pid_pt.items()
        }
    return jsonify(resp)
```

Key points:

- **Reuse `_per_type_plus`** from `score_pitches.py`. Don't reimplement the
  z-scoring against `pitch_plus_norm.json`. If the helper is private,
  refactor it to be importable; the contract must stay identical to what
  `write_season_aggregates()` uses.
- **Don't re-z-score against the pitcher pool** the way the buggy old
  `/leaderboard` did. The norm file already has the right mu/sd at every
  aggregation level.
- **`n` thresholds** (`MIN_N_PER_PITCH_TYPE`, `MIN_N_OVERALL`) that
  `/leaderboard` applies to season aggregates do **not** apply here — the
  caller may legitimately want a one-pitch breakdown for a single inning.
  Return whatever `n` the bucket has; let the client decide what to display.
- **No caching.** Unlike `/leaderboard`, this is request-specific.

## Verification

Once deployed, two things should match exactly:

```bash
# 1. A single pitcher's full regular season via /score_aggregate should match
#    /leaderboard for that pitcher.
curl -s -X POST https://pitch-plus-api.onrender.com/score_aggregate \
  -H 'Content-Type: application/json' \
  -d @cease_2026_R_pitches.json \
  | python3 -m json.tool

# Compare its by_pitch_type to:
curl -s 'https://pitch-plus-api.onrender.com/leaderboard?season=2026' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); p=[x for x in d['pitchers'] if x['player_id']==656302][0]; print(json.dumps(p['by_pitch_type'], indent=2))"
```

Values should agree to ±0.1 (rounding) per (pitch_type, metric). If they
don't, `_per_type_plus` is being called with a different `pitch_plus_norm.json`
level or the input filter (e.g. `n >= MIN_N_PER_PITCH_TYPE` in
`write_season_aggregates`) is dropping pitches that the endpoint keeps.

## Client integration

In `src/baseball/Summaries.jsx`, the existing in-game / non-Regular-Season /
AAA paths currently call `/score` and average client-side
(`Summaries.jsx:735-790`). Once `/score_aggregate` is live, replace that
averaging with a single `POST /score_aggregate` call using the same payload
the page already builds. The response slots directly into the existing
`pitchPlus` state shape with a tiny rename
(`stuff` → `stuffPlus`, `loc` → `locPlus`, `tun` → `tunnelPlus`,
`pitch` → `pitchPlus`).

For per-handedness Pitch+ used by `PlatoonUsageBars`, send two requests —
one with only `_stand === "L"` pitches, one with only `_stand === "R"`
pitches — and use the `overall.pitch` from each. (Or extend the endpoint to
accept a `group_by: ["pitch_type", "stand"]` parameter; out of scope for v1.)

After the swap, single-game and season Stuff+ numbers will be on the same
scale for the same pitcher.
