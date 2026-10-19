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

## Confidence intervals (2027 RANGES → Hitter / Pitcher Confidence Intervals)

Every projected stat line (hitter card stats and xRV, pitcher card stats — not iSwing+ or the
pitch-modeling grades) gets a 90% range
and a 50% core, written into the projection files as `ci = {lo, lo50, hi50, hi, n}` with the
fitted parameters in `meta.ci` / `pitcher_meta.ci`.

How they're built (`build_projections.py`: `ci_backtest`, `fit_ci`, `ci_bounds`):

1. **Backtest misses.** For up to the last 6 seasons, each season is projected only from the
   seasons before it (seasons trained on fewer than 2 target seasons are skipped), and every
   miss is kept: actual − projection, on the logit scale for rates (K%, BB%, Barrel %, …) so
   a 5% K-rate's range is proportional to its level and stays inside 0–100%.
2. **Spread per player.** `miss² ≈ c0 + a/(H + k) + b/n`, fit by non-negative least squares.
   `H` = his weighted history (Σ weight × sample), `k` = the stat's regression constant, so a
   long full-time track record narrows the talent part; `b/n` is one season of luck at sample `n`.
3. **Edges.** The 5th/25th/75th/95th percentiles of the misses divided by their spread, each
   season standardized by a spread fit on the *other* seasons — so year-to-year league drift
   is in the band, and skewed misses stay skewed (no bell-curve assumption).
4. **Playing time.** No playing-time projection exists, so `n` = his recent playing time
   (learned-weight average of the last two seasons), between the stat's minimum and a full
   season (90th percentile of last season's qualified samples).

The build prints a calibration check per stat, e.g.

    K%    90% band coverage: 2022 89.4% · 2023 90.8% · …

Each season is scored with a band fit only on the other seasons; ~90% everywhere means the
bands are honest. Stats with only one usable backtest season (bat tracking and pitch-model xRV,
whose data starts in 2023–24) can't see season drift, so their edges are widened by the median
ratio of out-of-season to in-sample band width across the long-history stats, and they're marked
with * in the tab. Bands come from the base model's backtest, so where an iSwing+/Stuff+ layer
is used they're slightly conservative.

The tab draws each range on one axis — standard deviations from the last season's league
average, better to the right — so ranges compare across stats and elite players' ranges
aren't squashed at the 100th percentile. Dots keep the cards' percentile colors. "Floors &
Ceilings" ranks players by ceiling (95th), floor (5th) or range width for one stat.
