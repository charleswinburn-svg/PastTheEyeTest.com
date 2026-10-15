# 2027 projected hitter cards — run order

All scripts run from the PastTheEyeTest.com project root.

| Step | Command | Output |
|---|---|---|
| 1. History 2015–2026 | `python3 backfill_history.py --start 2015 --end 2026` | `history/hitter_history.csv`, `history/birthdates.json`, `history/raw/` cache |
| 1b. xRV 2015–2022 (optional, 3.12 venv) | `.venv-xrv/bin/python build_hitter_xrv.py --season 2015,2016,2017,2018,2019,2020,2021,2022` then rerun step 1 | `public/hitter_xrv_{yr}.json` |
| 2. Lean iSwing+ + swing residual | `python3 build_iswing_history.py --swings "competitive_swings_*.csv"` | `history/iswing_history.csv` |
| 3. Fit, backtest, project | `python3 build_projections.py` | `public/baseball_data_2027P.json`, `public/hitter_xrv_2027P.json`, `public/projection_report.json/.csv` |
| 4. Frontend | `git apply projected_card.patch` | "2027 Proj" in the season picker (hitter card + hitter leaderboards) |

Notes
- Step 2 needs every season's swings CSV (your gitignored `competitive_swings_{year}.csv` backfills plus `competitive_swings_2023_2026.csv`). The first season gets no row — it has nothing earlier to train on.
- Step 3 works without steps 1/2 (falls back to the site's 2023–26 files, PA-only samples, no layers/aging), but the learned year weights need step 1's longer history to mean much.
- Read the printed table in step 3: weights per stat, k, walk-forward RMSE vs last-year and vs 5/4/3, and which layer (base / iswing / swing_resid) each stat earned. The same numbers land in `projection_report.csv`.
- Percentiles rank each projection against 2026 actual qualified hitters.
- `swing_resid` is only used for xwOBACON, and only if it beats the other options on held-out seasons; the residual stickiness r is printed first.

## Pitchers

| Step | Command | Output |
|---|---|---|
| P1. History 2015–2026 | `python3 backfill_pitcher_history.py --start 2015 --end 2026` | `history/pitcher_history.csv`, pitcher birthdates added to `history/birthdates.json` |
| P2. Fit, backtest, project | `python3 build_pitcher_projections.py --public ./private_out --history ./history` | fills `pitchers` in `baseball_data_2027P.json`, `pitcher_projection_report.json/.csv` |
| Inspect | `python3 explain_projections.py weights --side pitchers` / `aging --side pitchers` | weights, k, layers, backtest; age curve per stat |

- Layers a stat can earn (held-out seasons decide): `grades` (projected Stuff+/Loc+/Tun+/Pitch+), `stuff` (Stuff+ only), `model_resid` (Pitch+ plus the regressed "beats his pitch model" residual, run-prevention stats only).
- Every stat, FB velo included, gets its own aging curve (ages clamped to 22–37).
- The projected pitcher card shows projected Stuff+/Location+/Tunnel+/Pitch+ bubbles from the file and hides the arsenal, distributions and rolling chart.
