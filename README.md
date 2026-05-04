# PastTheEyeTest.com — Developer Reference

Comprehensive reference for the project across both repos. Use this when starting fresh sessions to bring an assistant up to speed quickly.

---

## Repos

| Repo | Path | Hosted | Purpose |
|------|------|--------|---------|
| `charleswinburn-svg/PastTheEyeTest.com` | `~/project/` | Vercel | React + Vite frontend, MLB stats UI |
| `charleswinburn-svg/pitch-plus-api` | `~/pitch-plus-api/` | Render free tier | FastAPI Pitch+ scoring service |

**Live API:** `https://pitch-plus-api.onrender.com`
- `/health` returns model + baseline counts
- `/score` POST endpoint accepts `{pitches: [...], is_aaa: bool}`

---

## Frontend (`~/project/`)

### Tech stack
- React + Vite, Tailwind, Cloudscraper-bypassed FanGraphs API
- Dev server: `npm run dev` → `http://localhost:5173`

### Key files

| Path | Purpose |
|------|---------|
| `src/baseball/Summaries.jsx` | Main pitcher/hitter card component, fetches Pitch+ from API |
| `src/baseball/SummaryComponents.jsx` | PitchTable with Stuff+/Loc+/Tun+/Pitch+ columns |
| `src/baseball/BaseballApp.jsx` | Top-level routing |
| `src/baseball/HitterCard.jsx` | Hitter percentile bar charts |
| `src/baseball/PitcherCard.jsx` | Pitcher percentile bar charts |
| `src/baseball/SharedComponents.jsx` | Reusable UI primitives |
| `src/baseball/mlbApi.js` | All MLB Stats API + Savant + parsing helpers (~1100 lines) |
| `baseball_pipeline.py` | Generates `public/baseball_data_{year}.json` from FG + Savant |
| `fangraphs_cookies.txt` | Browser-exported cookies for FG Cloudflare bypass |

### Data files in `public/`

| File | Source | Refresh |
|------|--------|---------|
| `baseball_data_2026.json` | `baseball_pipeline.py` | After every game day |
| `baseball_trends.json` | Pipeline | Daily |
| `evla_2026.json`, `evla_st_2026.json` | Pipeline | Daily |
| `league_avgs_2026.json` | Pipeline | Daily |
| `race2k_2026.json` | Pipeline | Daily |
| `iswing.json` | Manual | Rare |

### Pitch+ integration in React

In `Summaries.jsx`:

```js
fetch("https://pitch-plus-api.onrender.com/score", {
  method: "POST",
  body: JSON.stringify({ pitches: payload, is_aaa: isAAA }),
})
```

Returns per-pitch grades. Aggregated by pitch type:

```js
{ FF: { stuffPlus: 105, locPlus: 98, tunnelPlus: 102, pitchPlus: 103 } }
```

Spread into PitchTable rows (in `SummaryComponents.jsx`):

```jsx
const ppData = pitchPlus?.[row.type] || {};
const rowExt = pitchPlus ? { ...row, ...ppData } : row;
```

`EFF_KEYS` includes `stuffPlus`, `locPlus`, `tunnelPlus`, `pitchPlus` — all use 100-centered red/green coloring.

### Two-way player handling (Ohtani)

Three places use **per-group** dedup sets so two-way players appear in both pitchers and hitters:

1. `mlbApi.js#fetchLeagueStatLeaders` — `seenPitchers` and `seenHitters` are independent
2. `Summaries.jsx` roster merge (line ~134) — separate sets when merging `fetchAllPlayers` + `fetchLeagueStatLeaders`
3. `Summaries.jsx` boxscore scan (line ~152) — separate sets when scanning game boxscores

`fetchGameLog(playerId, season, group, sportId)` accepts `sportId` so MLB tab pulls sportId=1 only and AAA tab pulls sportId=11 only. Two-way players see correct level on each tab.

### Player coverage

- `fetchAllPlayers()` — 40-man rosters via `/teams/{id}/roster?rosterType=fullRoster`
- `fetchLeagueStatLeaders()` — paginated `/stats?stats=season&playerPool=All`, returns ~4300 pitchers including DFA'd/released
- Boxscore scan as third tier of redundancy
- Result: ~4300 pitchers loaded, 3300 hitters

### FanGraphs Cloudflare bypass

Order of fallback in `baseball_pipeline.py#fetch_fangraphs_pitching`:

1. **Browser cookies** (most reliable) — uses `fangraphs_cookies.txt` from `Get cookies.txt LOCALLY` Chrome extension
2. **cloudscraper** — handles JS challenges
3. **Direct API** — plain `requests`
4. **Selenium** — chromedriver at `/usr/bin/chromedriver`, chromium at `/usr/bin/chromium`
5. **pybaseball** — last resort

Cookies expire every few hours — re-export when pipeline 403s.

---

## Backend (`~/pitch-plus-api/`)

### Tech stack
- FastAPI on Render free tier (cold starts ~30s)
- Python 3.11, LightGBM 4.x, pandas, numpy
- Push to `main` → Render auto-redeploys (~3 min)

### Pitch+ Modeling System

Four 100-centered grades per pitch:

```
Pitch+ = combined overall grade
├── Stuff+    →  Pitch quality in isolation (velo, movement, spin, release, slot)
├── Location+ →  Location quality given pitch type and batter side
└── Tunnel+   →  Sequencing/tunneling vs pitcher's fastball
```

**Combination formula** (`models/final_model_config.json`):
```
xRV_final = 0.827 × xRV_stuff + 0.867 × xRV_location + 0.211 × xRV_tunnel + 0.0049
```

Holdout R² ≈ 0.033 combined (pitch quality is genuinely noisy — most run value variance is sequencing/batter quality/randomness).

### Stuff Model (v4 — current)

`models/stuff_model_2025.txt` + `stuff_model_metadata.json` define 22 features:

| Group | Features |
|-------|----------|
| Velocity | `release_speed`, `fb_velo`, `delta_velo` |
| Movement | `arm_side_break` (handedness-corrected pfx_x), `pfx_z`, `total_movement` |
| Spin | `release_spin_rate`, `spin_axis_sin`, `spin_axis_cos`, `spin_efficiency` |
| Release | `release_extension`, `release_pos_x` |
| Drag | `ay`, `ay_residual` (actual − regression(velo,spin) per pitch type) |
| Arm slot | `arm_angle`, `arm_angle_std`, `arm_angle_dev`, `pfx_x_dev_from_slot`, `pfx_z_dev_from_slot` |
| Categorical | `p_throws_cat`, `stand_cat`, `same_side` |

**Monotone constraints** on 5 features force sensible directions: more velo/extension/lower drag/more ride → never worse Stuff. Holdout R² = 0.0021 (lower than v3 unconstrained but generalizes better to extreme values).

**Slot regression** (per `pitch_type, p_throws`) in `models/slot_regression.json`:
```
expected_arm_side_break = slope_x * arm_angle + intercept_x
expected_pfx_z          = slope_z * arm_angle + intercept_z
```
Pitchers without `arm_angle` baseline → all 5 AA features = NaN, LightGBM uses learned default branches (effectively neutralizing AA splits).

### Location Models

10 separate per-pitch-type LightGBM models (`location_model_FF_2025.txt` etc.). Features:
- `plate_x`, `plate_z` (raw)
- `plate_x_adj` (handedness-mirrored)
- `zone_center_dist` (Euclidean)
- `in_zone` (binary)
- `out_of_zone_dist` (Euclidean from nearest zone edge)
- `balls`, `strikes`, `count_state`
- `stand_cat`, `same_side`

Forkballs (FO) alias to splitter (FS) for scoring; "Forkball" still displays in UI.

### Tunnel Model

`models/tunnel_model_2025.txt` — uses Stuff features + fastball baselines from `pitcher_baselines.json`:
- `fb_tunnel_x/z` (FB at tunnel point ~25 ft from plate)
- `fb_plate_x/z` (FB plate location)
- `release_diff_x/z`, `tunnel_diff_x/z`, `late_break_x/z`

### Norm calibration (`pitch_plus_norm.json`)

`build_component_norms.py` supports three modes per component:

| Mode | Default for | Effect |
|------|-------------|--------|
| `per-type` | Loc+ | Each pitch type centered at 100. Hides cross-type quality differences. |
| `global` | (none) | One mean/std for all pitches. Sweepers center ~107, FFs ~97. |
| `hybrid` ⭐ | Stuff+, Tun+, Pitch+ | Global mean (cross-type comparable) + per-type std (within-type spread preserved). |

Why hybrid for Stuff+: sweepers genuinely have lower xRV than fastballs (-0.010 vs -0.001 mean). Per-type forces both to 100, hiding that fact. Hybrid lets sweepers correctly grade ~107.

```bash
python3 build_component_norms.py --parquet pitch_xrv_2025.parquet
# Defaults: stuff/tun/pitch=hybrid, loc=per-type
```

### Critical files

```
~/pitch-plus-api/
├── server.py                    # FastAPI scoring endpoint (~370 lines)
├── score_pitches.py             # Batch scoring used by leaderboard scripts
├── models/
│   ├── stuff_model_2025.txt              # v4 LightGBM Stuff model
│   ├── stuff_model_metadata.json
│   ├── tunnel_model_2025.txt             # Tunnel model
│   ├── location_model_{FF,SI,FC,SL,ST,CU,KC,CH,FS,SV}_2025.txt  # 10 location models
│   ├── final_model_config.json           # Weights + intercept
│   ├── pitch_plus_norm.json              # MLB norms (means/stds per type)
│   ├── pitch_plus_norm_aaa.json          # AAA norms (lower-bar opponents)
│   ├── pitcher_baselines.json            # Per-pitcher rolling FB metrics (~1000 pitchers)
│   ├── pitcher_arm_angles.json           # Per-pitcher rolling 3-start arm angle
│   └── slot_regression.json              # Per-(pitch_type, hand) slot coefs
├── statcast_mlb_2025.parquet             # 2025 Statcast w/ arm_angle (~700K pitches)
├── statcast_mlb_2026.parquet             # 2026 Statcast (current season)
├── pitch_xrv_2025.parquet                # 2025 with xRV computed
└── pitch_xrv_2026.parquet                # 2026 with xRV computed
```

### Build scripts

| Script | What |
|--------|------|
| `build_pitcher_baselines.py` | Rolling 60-day FB baselines for tunneling |
| `build_arm_angle_baselines.py` | Rolling 3-start arm angle stats |
| `build_slot_regression.py` | Per-(pitch_type, hand) slot + drag regression |
| `build_component_norms.py` | Calibrate Stuff+/Loc+/Tun+/Pitch+ norms (chunked, hybrid mode) |
| `build_aaa_norms.py` | AAA-specific norms |
| `fetch_statcast_chunked.py` | Pull Statcast → parquet (auto-detects opening day, preserves game_type/game_pk) |

### Diagnostic scripts

| Script | What |
|--------|------|
| `diff_scoring.py` | Compare live API output vs script output (catches sync drift) |
| `show_stdev.py` | Empirical stds at pitch / game / season level |
| `diag_stuff_by_pitch_type.py` | Per-type xRV distribution, per-type vs global Stuff+ |

### Leaderboard scripts

| Script | What |
|--------|------|
| `daily_stuff_plus.py` `<date>` | Top 10 starters/relievers by Stuff+ for date |
| `daily_location_plus.py` `<date>` | Same for Location+ |
| `daily_tunnel_plus.py` `<date>` | Same for Tunnel+ |
| `daily_pitch_plus.py` `<date>` | Same for Pitch+ |
| `daily_starter_pitchplus.py` `<date>` | Top 10 starters (≥50 pitches) |
| `daily_reliever_pitchplus.py` `<date>` | Top 10 relievers (≥10 pitches) |
| `season_starter_pitchplus.py` | ≥4 GS, ≥20 IP starters |
| `season_reliever_pitchplus.py` | ≥6 G, 0 GS pure relievers |
| `season_pitchtype_leaders.py` | Top 10 per pitch type (≥10 thrown) |
| `season_bottom10_pitchplus.py` | Worst starters + relievers combined |
| `pitch_plus_player.py` | Single player arsenal lookup by name |
| `pitch_plus_leaderboard.py` | Combined overall + per-type leaders |
| `pitch_plus_distribution.py` | Histograms across pitch types |
| `pitch_plus_bellcurves.py` | KDE bell curves |
| `pitch_plus_bellcurves_colab.py` | Colab-friendly version |

All season scripts use `reg_season_filter.py` to exclude spring training/postseason.

### server.py architecture

```
POST /score {pitches, is_aaa} →
  map_pitch()        — MLB API JSON → flat dict (pfxX/pfxZ from inches→feet via /12)
  engineer features  — Stuff (22) + Location (per-pitch-type) + Tunnel features
  predict()          — DataFrame to LightGBM (preserves categorical dtypes — critical bug fix)
  combine            — weighted xRV_stuff + xRV_loc + xRV_tunnel + intercept
  normalize          — z-score per type → 100-centered grade per component
  return per-pitch [stuff_plus, loc_plus, tunnel_plus, pitch_plus, xRV components]
```

Loaded on startup: stuff/tunnel/10×location models, pitcher_baselines, pitcher_arm_angles, slot_regression, MLB+AAA norms.

`/health` returns counts of all loaded resources for debugging.

---

## Critical bug fixes applied

These took significant debugging — preserve the fixes:

1. **pfx_x/pfx_z units** — MLB Stats API returns INCHES, models trained in FEET. React divides by 12 in `Summaries.jsx#payload` construction.
2. **Categorical encoding** — Server must pass `pd.Categorical(...)` directly, NOT `.codes`. And pass DataFrame (not `.values`/numpy) to `model.predict()` so categoricals survive.
3. **out_of_zone_dist** — Euclidean (sqrt of squares), not Manhattan (sum). Mismatched training-time formula caused location drift.
4. **Trailing-60-day baselines** — Both `score_pitches.py` and `server.py` read from same canonical `models/pitcher_baselines.json`, rebuilt daily.
5. **Two-way players** — Per-group `seen` sets (3 places: mlbApi, Summaries roster merge, Summaries boxscore scan) so Ohtani lands in both pitchers and hitters.
6. **fetchGameLog sportId** — Pass sportId so MLB tab gets MLB games only and AAA tab gets AAA games only.
7. **Sweepers being flattened** — Hybrid norm mode (global mean + per-type std) preserves cross-type quality differences.
8. **Memory in batch scoring** — `build_component_norms.py` uses 50K-row chunking to avoid OOM with v3+ feature set.

---

## Common workflows

### Daily refresh (could be a GitHub Action)
```bash
cd ~/pitch-plus-api
python3 fetch_statcast_chunked.py --year 2026
python3 build_pitcher_baselines.py --parquet pitch_xrv_2026.parquet
python3 build_arm_angle_baselines.py --year 2026
git add models/*.json
git commit -m "nightly baseline refresh"
git push   # Render auto-redeploys
```

### When models retrain
```bash
cd ~/pitch-plus-api
cp new_stuff_model.txt models/stuff_model_2025.txt
cp new_metadata.json models/stuff_model_metadata.json
python3 build_slot_regression.py --parquet statcast_mlb_2025.parquet
python3 build_component_norms.py --parquet pitch_xrv_2025.parquet
git add models/ && git commit -m "model retrain" && git push
```

### Daily leaderboards
```bash
python3 daily_pitch_plus.py 2026-04-25
python3 season_starter_pitchplus.py
python3 season_pitchtype_leaders.py
```

### Frontend dev
```bash
cd ~/project
# Refresh FanGraphs cookies if pipeline 403s:
#   1. Visit fangraphs.com in Chrome (logged in)
#   2. Use 'Get cookies.txt LOCALLY' extension
#   3. cp downloaded cookies.txt fangraphs_cookies.txt

python3 baseball_pipeline.py public 2026  # generates public/*.json
npm run dev
```

### Verify Render is alive
```bash
curl -s https://pitch-plus-api.onrender.com/health
# Should return: {"status":"ok", "models":10, "baselines":1000+, "arm_angles":850+, ...}
```

---

## Local environment

| Tool | Path/Version |
|------|-------------|
| Python | `/usr/bin/python3` (3.11) |
| Chromium | `/usr/bin/chromium` |
| Chromedriver | `/usr/bin/chromedriver` |
| Node | via NodeSource |
| Pip | Use `--break-system-packages` flag (Debian Bookworm) |

User runs Linux container on a Chromebook (`~` is `/home/charleswinburn`). Downloads come from `/mnt/chromeos/MyFiles/Downloads/`.

---

## Pending / nice-to-haves

- Move daily refresh into a GitHub Action so Render always has fresh baselines without manual push
- AAA per-pitch arm_angle (Savant's CSV API doesn't expose minor league level — currently NaN-falls-back for AAA-only pitchers)
- Investigate increasing combined model R² past 0.033 — likely needs better count-context features
- Explore adding pitch sequence (previous pitch type/location) as Tunnel input
- Bell curve dashboard in React using same data as `pitch_plus_bellcurves.py`

---

## Quick-start prompt for a fresh chat

> I'm working on PastTheEyeTest.com — a baseball stats web app with a Pitch+ scoring system. Two repos: `~/project/` (React/Vite frontend) and `~/pitch-plus-api/` (FastAPI on Render free tier providing live Pitch+ scoring). The Pitch+ system is a 3-stage LightGBM model (Stuff + Location + Tunnel) producing four 100-centered grades. I have a developer README I can paste with full details. What I need help with today: [TASK]
