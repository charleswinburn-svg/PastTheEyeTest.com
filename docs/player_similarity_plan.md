# Player Similarity Score — design and implementation plan

## Context

PastTheEyeTest.com has rich per-player data (Statcast categories, iSwing+, hitter xRV, Pitch+/Stuff+/Loc+ grades, arsenals) but no way to answer "who does this player look like?". The feature: for any MLB hitter or pitcher, rank the most similar player-seasons (2023–2026), show an overall similarity % plus a % per component (hitters: swing traits, contact quality, whiff, discipline; pitchers: arsenal, release, whiff, command, contact quality allowed), and let the user re-weight the components. Panel sits below the rolling chart on `HitterCard.jsx` / `PitcherCard.jsx`. MLB only for v1 (AAA lacks bat tracking, arm angle, xRV).

Decisions already made with the user: cross-season pool (player-seasons, z-scored within each season), panel on the existing cards below RollingChart, MLB only.

---

## 1. Method (what "similarity" means)

**Unit of comparison:** a *player-season* (MLBAM id × season). Pool = qualified MLB player-seasons 2023–2026 (hitters: same PA gate as `hitter_xrv` / `baseball_pipeline` → 100 PA, 25 before June 1; pitchers: ≥200 pitches, same as `/pitcher_percentiles` `min_n`).

**Standardize within season.** For each feature, z = (x − μ_season) / σ_season over that season's qualified pool, clipped to ±3. This removes year-to-year league drift (velo creep, bat-speed data changes) so a 2024 season is comparable to a 2026 one. Store raw values + per-season μ/σ in the JSON; the browser computes z so it can also display raw values side by side.

**Handedness mirroring** so LHP/RHP and LHH/RHH are comparable:
- Pitchers: horizontal break → arm-side break (`-pfx_x*12` for RHP, `+pfx_x*12` for LHP, same convention as `arm_side_break` in `score_pitches.py`); `release_pos_x` and HAA mirrored the same way. Vertical quantities untouched.
- Hitters: checked `competitive_swings_2023_2026.csv` — `attack_direction` and intercept‑x already have the same sign for both sides (league mean −1.7 L / −2.5 R), so no mirroring needed.
- UI toggle "same hand only" (default on for pitchers, off for hitters).

**Per-component distance.** For component c with feature set F_c and within-component weights w_f (default 1):
`d_c = sqrt( Σ_f w_f (z_a,f − z_b,f)² / Σ_f w_f )` over features present for *both* players. If fewer than half of F_c is shared, the component is null and is dropped from the overall (weights renormalized). This handles 2023 hitters without tilt/direction, pitchers with no arm angle, etc.

**Component similarity %.** `sim_c = 100 · max(0, 1 − d_c / D_c)` where `D_c` is the 95th‑percentile pairwise `d_c` in the pool (computed once in Python from a random sample of ~200k pairs, stored in `meta.calib`). Because `d_c` is an RMS in z‑units, `D_c` stays valid when the user changes *component* weights. "100%" = identical, "0%" = as far apart as the 5% most dissimilar pairs.

**Overall similarity %** = weighted mean of component sims, `Σ W_c sim_c / Σ W_c`, default W_c = 1, user-adjustable (0 / 1 / 2 chips per component). Transparent: the overall reads as the average of the parts shown next to it.

**Pitcher arsenal component (the hard one).** Pitchers throw different mixes, so compare pitch‑type by pitch‑type:
- Per pitcher-season, per pitch type with ≥30 pitches and ≥5% usage: `velo`, `ivb`, `hb_armside`, `spin`, `spin_axis` (as sin/cos), `velo_minus_fb` (delta to primary fastball), `usage_share`. Alias KC→CU, FO→FS (same aliasing as the scoring models); keep SL / ST / SV distinct.
- `d_arsenal` = usage-weighted mean over the *union* of the two pitch types: shared type → RMS z‑distance of its shape features (z per season × pitch type); type thrown by only one → fixed penalty distance (`meta.calib.missing_pitch_penalty`, start at 1.5 z) weighted by that pitcher's usage share. Plus a small "mix" term: Euclidean distance between family usage vectors (FB / SI / FC / SL‑ST‑SV / CU / CH‑FS).
- Calibrated with the same 95th-percentile `D_c` rule.

**Sample size.** Hard gates above; show PA / pitches on every comp row. Shrinkage toward league mean for low-n seasons is a v2 item.

**Correlated features** (bat speed ↔ EV90 ↔ swing length; velo ↔ Stuff+): v1 controls this with the curated feature lists and per-feature weights below; v2 can PCA‑whiten each component.

**Self seasons.** A player's own other seasons are included and labelled (e.g. "2024 · self"); toggle "exclude self".

---

## 2. Feature inventory and sources

All sources confirmed in the repo. **New** = must be computed by the builder (all from the full-season Statcast detail parquet that `score-pitches.yml` already fetches via `fetch_statcast.py`).

### Hitters (`public/similarity_hitters_{yr}.json`)

| Component | Feature | Source |
|---|---|---|
| Swing traits | bat_speed, swing_length, attack_angle, attack_direction, swing_path_tilt, intercept_x | mean per batter-season from per-swing rows: `competitive_swings_{yr}.csv` / `competitive_swings_2023_2026.csv` (columns exist; 2023–25 backfill CSVs are gitignored — see §5), fallback to the parquet's `bat_speed/swing_length/attack_angle/attack_direction/swing_path_tilt` columns |
| | fast_swing_pct | `baseball_data` category `"Fast Swing %"` (value is a 0–1 decimal) |
| | iswing_plus; adjustability/effort contributions `speed_vs_location`, `aa_adjustment`, `length_for_location`, `effort_level` | `iswing.json` (by name, via `fuzzyLookup` logic → use `iswing_waterfall_{yr}.json[pid].iswing` instead, keyed by id); contributions from `iswing_waterfall_{yr}.json[pid].c` |
| Contact quality | xwobacon, ev90, avg_ev, barrel_pct, blasts_per_contact, la_sweetspot | `baseball_data` categories `"xwOBACON"`, `"90th % EV"`, `"Avg Exit Velocity"`, `"Barrel %"`, `"Blasts/Contact"` (decimal), `"LA+SwtSpt%"` |
| | xslgcon | **New**: mean `estimated_slg_using_speedangle` over `description=="hit_into_play"` by batter (drop feature if column absent) |
| | contact_xrv | `hitter_xrv_{yr}.json[pid].metrics["Contact Quality"].value` |
| Whiff | z_contact, k_pct, whiff_pct | `baseball_data` `"Z-Contact%"`, `"K%"`, `"Whiff %"` (note the space) |
| | whiff_xrv | `hitter_xrv` `"Whiff"` |
| Discipline | chase_pct, bb_pct | `baseball_data` `"Chase %"`, `"BB%"` |
| | chase_xrv, decision_xrv | `hitter_xrv` `"Chase"`, `"Decision"` |

### Pitchers (`public/similarity_pitchers_{yr}.json`)

| Component | Feature | Source |
|---|---|---|
| Arsenal (per pitch type) | velo, ivb, hb_armside, spin, spin_axis sin/cos, velo_minus_fb, usage_share | **New**: groupby (pitcher, pitch_type) on the parquet, pattern of `build_pitcher_arsenal.py#build` |
| Release | arm_angle | **New**: mean per-pitch `arm_angle` column when present; else geometric fallback used in `score_pitches.py` (`pitcher_heights.json`) |
| | release_x_armside, release_z, extension | **New**: pitcher-season means of `release_pos_x` (mirrored), `release_pos_z`, `release_extension` |
| | fb_vaa, fb_haa (primary fastball), all-pitch mean VAA | **New**: reuse the VAA/HAA kinematic formulas at `score_pitches.py:91-97` (factor into a small helper) |
| Whiff / stuff | stuff_plus | `season/pitcher_grades_{yr}.json[pid].stuff_plus` (in CI: `tmp/output/season/`) |
| | k_pct, whiff_pct, chase_pct | `baseball_data` pitcher categories `"K%"` (decimal!), `"Whiff%"`, `"Chase%"` |
| Command | loc_plus | `pitcher_grades` `loc_plus` |
| | bb_pct | `baseball_data` `"BB%"` |
| | zone_pct | **New**: share of pitches with `zone` 1–9 (same `_zone` logic as `build_pitcher_arsenal.py`) |
| Contact allowed | xwobacon_allowed, xslgcon_allowed | **New**: means of `estimated_woba_using_speedangle` / `estimated_slg_using_speedangle` over `hit_into_play` by pitcher |
| | avg_ev_allowed, barrel_pct, gb_pct | `baseball_data` `"Avg Exit Velo"`, `"Barrel%"`, `"GB%"` |

Record `hand` (`stand` / `p_throws`) from the parquet.

---

## 3. Architecture

**Python builders** (in `PastTheEyeTest.com`, next to `build_pitcher_arsenal.py`; this repo's CI already has the parquet, `models/`, and `score_pitches.py`):

- `build_similarity_hitters.py --year 2026 [--parquet tmp/pitch_xrv_2026.parquet] [--swings competitive_swings_2026.csv] --out public/similarity_hitters_2026.json`
- `build_similarity_pitchers.py --year 2026 --parquet tmp/pitch_xrv_2026.parquet --season-dir tmp/output/season --out public/similarity_pitchers_2026.json`
- Shared module `similarity_common.py`: feature spec (key, label, component, weight, mirror flag), qualified-pool gate, per-season μ/σ, pairwise-sample calibration (`D_c`), JSON writer. Reuse `_num/_col/_round` helpers from `build_pitcher_arsenal.py` and the PA gate from `build_hitter_xrv.py` (`MIN_PA`, `MIN_PA_EARLY`).

Output shape (both files):
```json
{"season":2026,"level":"MLB","generated_at":"...",
 "meta":{"components":{"swing":{"label":"Swing traits","features":["bat_speed",...]}, ...},
         "features":{"bat_speed":{"label":"Bat speed","weight":1,"fmt":".1f"}, ...},
         "stats":{"bat_speed":{"mean":71.2,"sd":2.9}, ...},           // per-season μ/σ
         "arsenal_stats":{"FF":{"velo":{"mean":..,"sd":..},...}, ...}, // pitchers only
         "calib":{"swing":1.84,"contact":1.71,...,"missing_pitch_penalty":1.5}},
 "players":{"691718":{"name":"Pete Crow-Armstrong","team":"CHC","hand":"L","n":726,
                      "v":{"bat_speed":74.1,"swing_length":7.6,...},
                      "arsenal":{"FF":{"usage":0.42,"velo":95.1,"ivb":16.2,...}}}}}   // pitchers only
```
Size estimate: hitters ~60 KB, pitchers ~250 KB per season. Four seasons load lazily when the panel mounts.

**Frontend** (`src/baseball/`):

- `similarity.js` (pure functions, unit-testable): `loadSimilarityPool(type, seasons)` with module cache; `zscore(v, stats)`; `componentDistance(a, b, comp, meta)`; `arsenalDistance(a, b, meta)`; `rankComps(target, pool, {weights, sameHand, excludeSelf, currentSeasonOnly})` → `[{pid, season, name, team, hand, n, overall, comps:{swing:{sim,d,nShared}}...}]`.
- `SimilarPlayers.jsx`: props `{player, season, type, onSelect}`. Layout: title row "Similar Players"; controls (component weight chips 0/1/2, "same hand" toggle, "current season only" toggle, "exclude self"); top‑10 rows: headshot (`getHeadshotUrl`), name + season + team, big overall % coloured with `pctToBin`/`binColor` from `SharedComponents.jsx`, one mini bar per component with its %; expandable row showing per-feature side-by-side (raw values from `v`, formatted with `meta.features[k].fmt`). Clicking a row calls `onSelect({playerId, season, name})`. Uses `useTheme()` like the cards.
- Placement: `HitterCard.jsx` right after `<RollingChart …/>` (~line 293), `PitcherCard.jsx` after `<RollingChart …/>` (~line 341), guarded `!isAAA && !isProjection`.
- `BaseballApp.jsx`: pass `onSelectPlayer` to both cards → `setSeason(season)` then `setSelectedHitter/Pitcher(displayName)` (resolve displayName by `player_id` from `hittersFull`/`pitchersFull` once that season's data loads; if the name isn't in the loaded list yet, hold it in a pending ref and apply in the existing data `useEffect`).
- Check the card's html2canvas "Save as PNG" region: include the panel or exclude it consistently (match how RollingChart is treated).

**CI / refresh:**
- `.github/workflows/score-pitches.yml`: add two steps after "Score pitches" that run both builders for 2026 and add `public/similarity_*.json` to the commit step. (It already has the parquet, `tmp/output/season`, pandas, pyarrow.)
- Backfill 2023–2025 once locally: `python3 fetch_statcast.py --year YYYY --out tmp/pitch_xrv_YYYY.parquet`, `score_pitches.py` for that year (or point `--season-dir` at the committed `pitch-plus-api/season/`), then both builders. Hitter swing columns for 2023–2025 come from the user's gitignored `competitive_swings_{yr}.csv` or the parquet (tilt/direction may be absent in older seasons → features dropped per the shared-feature rule).
- Add the two files to the `public/` table in `README.md`.

---

## 4. Implementation steps

1. `similarity_common.py`: feature spec tables (from §2), gates, μ/σ, clipping, calibration sampler, writer.
2. `build_similarity_hitters.py`: merge `baseball_data`, `hitter_xrv`, `iswing_waterfall`, per-swing means, parquet xSLGcon → one row per hitter → JSON. Run for 2026, eyeball a few players.
3. `build_similarity_pitchers.py`: parquet groupbys (arsenal shapes, release, VAA/HAA, zone%, contact allowed) + `pitcher_grades` + `baseball_data` → JSON. Run for 2026.
4. `similarity.js` + a small Vitest/Node test (`npm test` if present, else a node script) covering: identical player → 100% every component; symmetry; missing-feature handling; LHP/RHP mirroring (a mirrored copy of a pitcher ranks #1).
5. `SimilarPlayers.jsx`, wire into both cards and `BaseballApp.jsx` selection callback.
6. CI steps + README table rows. Backfill 2023–2025 files.

---

## 5. Open items / assumptions

- 2023–2025 per-swing CSVs aren't in the repo (gitignored); backfill needs them from the user's machine or the parquet's swing columns. Older seasons may lack tilt/direction → those features are simply absent for that season.
- `estimated_slg_using_speedangle` is expected in the Savant detail CSV; if absent for a year the xSLGcon features are dropped (not fabricated).
- Arm angle per pitch exists in the parquet for 2025+; earlier seasons fall back to the geometric estimate (same as scoring).
- Pitcher `K%` in `baseball_data` is a 0–1 decimal while `Whiff%` is 0–100; the builder must normalise before storing (z-scoring makes units irrelevant for distance, but the displayed raw value should be consistent).

---

## 6. Verification

- Builders: run for 2026, assert player counts match `hitter_xrv_2026.json` (465) and `/leaderboard` n≥200 (~600–870), no NaN μ/σ, calibration `D_c` in a sane 1–3 z range; spot-check known profiles (e.g. a sweeper-heavy RHP reliever's top comps are sweeper-heavy relievers; a high-bat-speed/high-K hitter's comps are too).
- JS unit tests from step 4.
- `npm run build` clean; `npm run dev`, open hitter and pitcher cards, confirm panel renders below the rolling chart, weights/toggles re-rank live, clicking a comp switches season + player, PNG export unaffected.
- Run the modified `score-pitches.yml` via `workflow_dispatch` once and confirm the two JSON files commit.

---

## Status (implemented on branch `claude/brave-euler-ny3eic`)

- `similarity_common.py`, `build_similarity_hitters.py`, `build_similarity_pitchers.py` — builders.
- `public/similarity_hitters_{2023..2026}.json` — built from committed data (no xSLGcon; 2023–25 lack
  attack direction / intercept until the per-swing CSVs are supplied with `--swings`).
- `public/similarity_pitchers_{year}.json` — **not committed**: needs the season Statcast parquet.
  Run the pitcher builder locally (see README "Player similarity").
- `src/baseball/similarity.js`, `src/baseball/SimilarPlayers.jsx` — ranking + panel, wired into
  `HitterCard.jsx` / `PitcherCard.jsx` below the rolling chart; `BaseballApp.jsx` handles comp clicks.
- `scripts/test_similarity.mjs` (`npm run test:similarity`) — sanity checks.
- CI workflow deliberately untouched (local-only for now).
