# NHL overhaul: run the scraper → xG → ratings pipeline on the droplet and rebuild the NHL tab on it

> **Update, 2026-11-15: what was built first, and where it differs from this plan.**
> The pipeline is in `nhl/` (see `nhl/README.md`) and runs with one command, `nhl/nightly.sh`.
> Two things differ from the steps below:
>
> - **The notebooks are run as they are** (`nhl/nbrun.py`), not re-written as Python modules.
>   Replacing a file in `notebooks/nhl/` updates the model. The ratings notebook therefore still
>   chooses its own shrinkage and weights each run; pinning those choices (step 3) is not done yet.
> - **The site files go to GitHub** in `public/nhl/`, pushed by the nightly run like the baseball
>   update, instead of being served from `api.pasttheeyetest.com/nhl`. The front end reads `/nhl/*.json`.
>
> **Update, 2026-11-16:** the React tab is built (`src/hockey/`), reading `/nhl/*.json`. It differs
> from step 5 in what was asked for afterwards: everything under the card header is in Pliant, no
> plus signs on positive numbers, a larger two-column card with the impact chart under the
> percentiles, tier bands in four colours for forwards and three for defensemen and goalies, and a
> colour on/off switch on the leaderboards. The saved PNG is the card as shown, not a fixed square.
> Games the shift API is missing are filled from the NHL's printed shift reports (`nhl/shift_reports.py`).
>
> Still to do: the cut-over (step 6: remove `hockey_pipeline.py`, the NST/EH CSVs and `hockey_data_*.json`)
> and pinning the ratings notebook's choices (step 3).

## Context

The NHL tab today (`src/hockey/HockeyApp.jsx`) shows composite percentile cards built by
`hockey_pipeline.py` from hand-downloaded Natural Stat Trick and Evolving Hockey CSVs (`data/*.csv`).
It covers three seasons, needs manual downloads, and the numbers are other people's models.

You now have your own stack in three Colab notebooks:

| Notebook | Reads | Writes |
|---|---|---|
| `nhl_xg_scraper` | NHL API (play-by-play, shift charts, player landing) | `shots_/events_/toi_/stints_YYYY.csv`, `players.csv`, `nhl_cache/` |
| `nhl_xg_modeling` | `shots_*.csv` | `xg_final.csv` (`xg_final`, `xg_flurry` per shot) |
| `nhl_player_ratings` | stints, shots, events, toi, `xg_final.csv` | `player_ratings.csv`, `goalie_ratings.csv`, `team_war.csv`, `scoring_weights.csv`, plus a Streamlit dashboard |

Goal: the droplet runs that stack every night with no Colab or Drive in the loop, serves the results,
and the NHL tab is rebuilt in React around WAR, Impact and the component ratings (the Streamlit
dashboard is the design reference). The NST/EH pipeline is removed once the new tab is live.

Decisions already made: rebuild the React tab · droplet has 8 GB+ RAM, so all fitting runs there ·
nightly updates · old cards replaced entirely · every Streamlit feature kept but in the site's own
look · all numbers in Pliant · impact-by-season chart blue-to-red and smooth · a flag for every player.

## Architecture

```
NHL API ──▶ scrape ──▶ stints ──▶ xG ──▶ ratings ──▶ export ──▶ gate ──▶ publish
            (cache)                                              │
 droplet: /var/lib/pte-nhl/{cache,tables,models,site}            ▼
                                   api.pasttheeyetest.com/nhl/*.json  ◀── React NHL tab (Vercel)
```

- **Code** lives in `PastTheEyeTest.com/nhl/` (a Python package, next to the other pipelines).
- **Data** lives on the droplet in `/var/lib/pte-nhl/`, outside git. Hockey data is **not** committed:
  `public/` is already 196 MB and a nightly commit of ratings JSON would keep growing the repo and
  trigger a Vercel build every night.
- **Serving**: the existing FastAPI app (`pitch-plus-api/server.py`, already at
  `api.pasttheeyetest.com` with CORS open) gets one `StaticFiles` mount at `/nhl` pointing at
  `/var/lib/pte-nhl/site`. Files are read from disk per request, so a nightly publish needs no restart.
- **Schedule**: a systemd timer on the droplet, same pattern as `pitch-plus-api.service`.

Assumption to confirm in step 0: the site itself stays on Vercel (`vercel.json`) and the droplet
serves data only. If nginx fronts the API, an `alias` location is an equivalent swap for the mount.

## Step 0: survey the droplet and bring the data over (read-only, then one copy)

1. Record `nproc`, `free -g`, `df -h /var`, how `api.pasttheeyetest.com` is proxied, and how the
   16:30 UTC "Daily data update" job is launched (it is not in either repo).
2. Copy from Drive to `/var/lib/pte-nhl/` with `rclone`: `nhl_cache/`, the season CSVs, `xg_final.csv`,
   `player_ratings.csv`, `goalie_ratings.csv`, `team_war.csv`. This saves the 4–5 hour scrape and
   gives a baseline to test the port against. Fallback: re-scrape from the NHL API.
3. Create a venv at `/var/lib/pte-nhl/venv` (pandas, numpy, scipy, scikit-learn, xgboost, pyarrow,
   requests). Pin versions in `nhl/requirements.txt`.

## Step 1: port the scraper (`nhl/scrape.py`, `nhl/stints.py`, `nhl/players.py`)

Lift the functions as they are from scraper cells 5–7: `get_json`, `fetch_pbp`, `fetch_shifts`,
`parse_game`, `game_toi`, `game_stints`, `season_stints`, `fetch_bios`, `game_ids_between`,
`scrape_games`. Change only the I/O:

- Paths come from `NHL_DATA_DIR`; cached play-by-play is stored gzipped; season tables are parquet.
- Completed seasons are built once and frozen. The current season is rebuilt from cache each night
  using `game_ids_between` (finished games only), with the season derived from the date instead of
  the hard-coded `CURRENT, SEASON_START = 2026, "2026-10-01"`.
- Games whose shift chart was missing are retried each night (the notebook already skips caching
  empty charts). 2024-25 has shift data for 1,255 of 1,312 games; report the count nightly.
- `fetch_bios` also keeps the `headshot` URL, so headshots key on player id instead of name.

**Bug to fix in the port: duplicate shift records.** The last two cells of the scraper notebook show
it: game 2023020500 has 302 overlapping shift records, and 37% of 2023-24 games have different 5v5
seconds in `stints` and `toi`. `game_toi` adds 1 per record, so a duplicated shift makes a second of
5v5 look like 6 skaters and drops it; `game_stints` uses a true/false grid and is unaffected. Fix by
merging overlapping intervals per player and period when shifts are loaded (so the cache does not
need refetching), then re-run that gap check and expect about zero. The ratings take ice time from
stints, so ratings barely move; `toi_*` and its 5v5 check become correct.

Check: rebuilt 2023 and 2024 tables match the Drive CSVs row for row on shots, events and stints.

## Step 2: port the xG model (`nhl/xg.py`)

Lift sections 2, 4, 5, 14, 16 and 17 (load and filter, features, helpers, game-grouped 5-fold
backfill with season as a feature, EV calibration for 2023 on, flurry adjustment).

- **Settings file.** The uploaded notebook has no saved outputs, so the tuned settings (`hp` per
  state, `ntrees`, `H`) are not recoverable from it. `python -m nhl xg tune` ports sections 8 and 10
  and writes `models/xg_config.json`. It runs once on the droplet (several hours, niced, overnight),
  then again only when you choose to retune. Sections 9, 11–13, 15, 18, 19 stay as research
  commands, not part of the nightly run.
- **Nightly.** Run the backfill with the saved settings (the notebook's own estimate is 10–20 min),
  but write only the current season's rows. Completed seasons keep the xG from the last season
  rollover, so past seasons do not shift from night to night.
- Section 13's live model with an in-season shift is the alternative if you later want strictly
  out-of-sample numbers for the current season; not in this plan.

Check: with the Drive shot files and the same settings, xG/goals by season and state, log loss and
AUC match the notebook; per-shot values agree with `xg_final.csv` to within model noise.

## Step 3: port the ratings (`nhl/ratings/`)

Lift sections 1–14 and 16, one module per group of sections, sharing the `fit`, `sse`, `window`
helpers from section 4: `load.py` (2), `ev.py` (3–7), `scoring.py` (8), `context.py` (9),
`special.py` (10), `results.py` (11), `skaters.py` (12), `goalies.py` (13), `war.py` (14), `save.py` (16).

**Pin the choices.** The notebook picks many settings by search each run: shrinkage and season
weights (sections 5, 10, 11), the Finishing/Playmaking weights (8), whether setup is included and how
hard it is shrunk (11), which results component goes into WAR (12), the goalie options (13), and the
calibration multipliers (14). Because the in-progress season is one of the test seasons, those picks
can flip from one night to the next and move every WAR number. So:

- `python -m nhl ratings select` runs the searches and writes `models/ratings_config.json`.
- The nightly fit reads that file and searches nothing. Calibration multipliers and goals per win
  are recomputed nightly (they are measurements, not choices).
- Re-select by hand, and at each season rollover. Any changed pick is listed in the run report.

Per-season matrices for completed seasons are cached on disk so the nightly run only rebuilds the
current season's.

Check: with the Drive inputs, `player_ratings.csv` and `goalie_ratings.csv` reproduce the Drive
copies (same picks, WAR within rounding); the section 15 team check (summed WAR against goal
difference) matches.

## Step 4: export, gate, publish, schedule

`nhl/export.py` writes to a staging folder, then swaps it into `site/` in one rename:

| File | Contents |
|---|---|
| `meta.json` | updated time, seasons, share of season played, goals per win, calibration multipliers, picks in use |
| `index.json` | every player: id, name, position, team, headshot, flag, seasons played |
| `skaters_{season}.json`, `goalies_{season}.json` | one row per player, 1-year and 3-year: every column the dashboard's `leaderboard_columns`, percentile rows, WAR parts and z-score rows use, plus tier |
| `history.json` | per player per season: WAR, GAR, GAA, tier, team; and the tier cut lines per season and position (for the impact-by-season chart) |
| `teams_{season}.json` | `team_war.csv` rows |

Tiers and z-scores are computed here (port `with_tiers` and `z_table` from the dashboard cell) so the
browser only draws.

**Gate before publishing.** If any check fails, yesterday's files stay live and the run exits
non-zero: 5v5 minutes per game in 46–50; penalties and faceoffs per game in range; xG/goals per
season within a band; team WAR against goal difference correlation above a floor; player counts not
falling; no NaN in headline columns; every player has a flag.

`nhl/__main__.py`: `nightly`, `backfill`, `xg tune`, `ratings select`, `export`, `check`. `nightly`
takes a lock and exits early when no new games finished.

`deploy/nhl/pte-nhl.service` and `pte-nhl.timer`: daily at 10:00 UTC (after West Coast games and
before the baseball job), `Nice=10`, logs to the journal. `deploy/nhl/README.md` has the install steps.

`pitch-plus-api/server.py`: mount `/nhl` from `NHL_SITE_DIR` when the folder exists, with a
5-minute `Cache-Control`.

## Step 5: rebuild the NHL tab

Every feature of the Streamlit dashboard is kept, redrawn in the site's own look. Nothing on the
page should read as Streamlit.

### Feature checklist (all carried over from `pte_dashboard.py`)

Controls
- [ ] View: Player or Leaderboard
- [ ] Show: Skaters or Goalies
- [ ] Season (2019-20 on; the current one marked "in progress")
- [ ] Ratings: 3-year (current value) or 1-year (this season only)
- [ ] Team filter
- [ ] Player search (type to search)
- [ ] Percentile style: Spectrum or Bars
- [ ] Saved image: Dark or Light

Player page, skaters and goalies
- [ ] Name, caption line (team · position · season · GP · 5v5 minutes or shots faced · tier)
- [ ] Four headline tiles (WAR this season, 3-year WAR, Impact percentile, Impact per 60 or GSAx)
- [ ] "Not ranked" notices (under the minutes or shots cutoff)
- [ ] Percentile rows with the raw value beside each and hover text: 11 skater rows, 11 goalie rows
- [ ] Where his WAR comes from: signed bars per component, summing to WAR; setup and rebound rows
      hidden when they are switched off in the ratings
- [ ] Impact by season with the WAR / GAR / GAA switch and hover details
- [ ] Against the league average: z-score bars, plus the average z-score tile
- [ ] "Show the numbers": the tables behind every graphic, plus the goalie season totals
- [ ] Save as PNG: the whole page as one square 2160 × 2160 image

Leaderboard
- [ ] Ranked by WAR with the tier column; click any header to sort
- [ ] Position filter (skaters), minimum-games slider, team filter
- [ ] Column groups on and off: WAR and Impact · Season totals · Ratings · Percentiles
      (every column in `leaderboard_columns`, both skaters and goalies)

### Look: PastTheEyeTest, not Streamlit

- Site palette and layout: the navy background, amber and blue accents, the existing tab bar and
  mobile layout from the current `HockeyApp.jsx`.
- Player header in the team's primary colour with team logo, headshot and flag (the current
  `PlayerHeader`), then the tiles and panels as site-style cards.
- Footer wordmark "PastTheEyeTest" on every graphic; the "NST + EH" credit goes away.
- The saved PNG is the same site-styled card, captured with html2canvas (as the MLB cards are),
  square 2160 × 2160, in the Dark or Light theme. It waits for `document.fonts.ready` so the
  numbers render in Pliant in the image too.

### Type: the same as the baseball cards, from the header down

The hockey pages copy the MLB cards' type styles exactly, taken from
`src/baseball/SharedComponents.jsx` (`PlayerHeader`, `BubblePercentileBar`, `TrendChart`) and the
card footers in `HitterCard.jsx` / `PitcherCard.jsx`:

| Element | Style (as on the baseball cards) |
|---|---|
| Player name | Inter, 20px, weight 800, letter-spacing −0.02em, on the team's primary colour |
| Subtitle line | Inter, 11px, weight 600, italic, uppercase, letter-spacing 0.06em |
| Row labels, section titles | Inter (the site font), same sizes and weights as the card rows |
| Every number | Pliant, weight 700 (`NUM_FONT` / `NUM_WEIGHT`); percentile bubbles 10px / 800, raw values 11px |
| Chart ticks and point labels | Pliant, weight 700, 10–11px |
| Footer | 10px, muted; italic "PastTheEyeTest | …" wordmark on the right |

- Colours come from the same `ThemeContext` tokens the MLB cards use, so dark and light match.
- The "Bars" percentile style is the baseball `BubblePercentileBar` itself. The "Spectrum" style
  keeps the dashboard's 100-cell row but with the same label and number type.
- Numbers covered: tiles, percentile squares, raw values, WAR bars, z-scores, chart ticks and
  labels, every leaderboard cell, and the saved PNG. One shared `Num` component in the hockey
  folder so no number is styled by hand.
- The Streamlit fonts and the matplotlib PNG renderer are not carried over.

### Impact by season: blue to red, flowing

- **Colour.** The tier backdrop runs on the same blue → grey → red scale as the percentiles (blue =
  Depth or Backup, red = 1st line, 1st pair or Starter) instead of five shades of blue with an
  orange line.
- **Flow.** The tier boundaries are drawn as smooth curves across seasons, not a separate block per
  season, and the colour between them is a continuous vertical gradient, not hard-edged bands. Tier
  names sit at the right edge of their zone.
- **The player's line** is a smooth curve (monotone, so it never overshoots a real value), coloured
  along its length by where it sits on that same scale, with white-ringed points and value labels.
- Drawn as a custom SVG component so the gradient and curves are exact and the PNG capture matches
  the page. Hover details (season, team, value, tier) are kept.

### Flags for every player

- Source: `birth_country` from the NHL player endpoint, which `fetch_bios` already stores for all
  ~1,900 players (three-letter codes: CAN, USA, SWE, RUS, FIN, CZE, SVK, CHE …).
- The export step converts each to the two-letter code the flag images use and writes `flag` on
  every player row. The nightly gate fails on any player with no flag and prints the unmapped code.
- Caveat: this is country of birth, which is not always the country a player represents. A small
  `nhl/flag_overrides.json` (player id → country) handles those; seed it from the Olympic roster
  list in `hockey_pipeline.py` before that file is deleted.
- Shown in: the player header, the player search list, every leaderboard row, and the saved PNG.
  Images come through the existing `/flag-assets` proxy.

### Files

- `nhlData.js`: fetch from `import.meta.env.VITE_NHL_DATA_BASE ?? "https://api.pasttheeyetest.com/nhl"`.
- `rows.js`: labels, columns and hover text ported from the dashboard cell (`ROWS`, `PARTS`,
  `ZROWS`, `leaderboard_columns`, `TIER_SLOTS`), for skaters and goalies.
- `PlayerPage.jsx`, `PercentileRows.jsx` (Spectrum and Bars), `WarBreakdown.jsx`, `ZScores.jsx`,
  `ImpactBySeason.jsx`, `NumbersTables.jsx`, `Leaderboard.jsx`, `Num.jsx`, `Flag.jsx`.
- `Methodology.jsx`: plain-language notes per rating, including setup results.

Reuse rather than rewrite:
- `SearchableSelect`, `exportCanvasAsPng`, `NUM_FONT`, `NUM_WEIGHT` from `src/baseball/SharedComponents.jsx`
- `src/FitToWidth.jsx`, and `src/baseball/CapturePanel.jsx` for Save as PNG (html2canvas)
- from the current `HockeyApp.jsx`: `PlayerHeader`, `useLogos`, `NHL_TEAM_PRIMARY`, `FLAG`, the tab
  bar and mobile layout
- the `/nhl-assets` and `/flag-assets` proxies already in `vercel.json` and `vite.config.js`

## Step 6: cut over and clean up

After the new tab has run on nightly data for a week: delete `hockey_pipeline.py`, the NST/EH files
in `data/`, `hockey_data_*.json` (root and `public/`), and the name-keyed `headshots.json` if nothing
else reads it. Add an NHL section to `README.md`. Keep the three notebooks in `notebooks/nhl/` as the
research reference, with a note that `nhl/` must be kept in step with them.

## Files

New: `nhl/` (package above), `nhl/requirements.txt`, `nhl/flag_overrides.json`, `deploy/nhl/*`,
`notebooks/nhl/*.ipynb`, and the `src/hockey/` files listed in step 5.
Changed: `src/hockey/HockeyApp.jsx`, `README.md`, `.gitignore`, `pitch-plus-api/server.py`.
Removed in step 6: `hockey_pipeline.py`, `data/20*.csv`, `data/*goalies.csv`, `hockey_data_*.json`.

Work goes on branch `claude/keen-davinci-gb90jn` in both repos; no pull request unless you ask.

## Verification

1. **Parity, stage by stage**, against the Drive files (checks listed under steps 1–3). This is the
   main proof the port is faithful.
2. **Shift fix**: the stints-vs-toi 5v5 gap check from the scraper notebook reports about zero.
3. **Nightly dry run** on the droplet: run `python -m nhl nightly` twice. The second run exits early.
   Break one gate on purpose and confirm the published files do not change.
4. **Serving**: `curl https://api.pasttheeyetest.com/nhl/meta.json` returns today's timestamp;
   `systemctl list-timers` shows the timer.
5. **Front end**: `npm run dev` with `VITE_NHL_DATA_BASE` pointed at a local copy of `site/`; drive it
   with Playwright at desktop and phone widths: player page for a forward, a defenseman and a goalie
   in both versions, leaderboard sort and filters, Save as PNG. Compare three players' numbers with
   the Streamlit dashboard on the same data. Tick off every line of the step 5 feature checklist.
   Confirm from the screenshots and the saved PNG: numbers are in Pliant, the impact chart is
   blue-to-red with smooth boundaries, and a flag shows for every player in the header, search list
   and leaderboard.
6. **Leaders look right**: the top of the current-season WAR lists is recognizable (section 15's test).

## Risks and things to know

- The NHL API is unofficial: keep the 0.5 s pause and retries, and expect occasional missing shift charts.
- Regular season only, as in the notebooks. Playoffs are not scraped.
- The first `xg tune` takes hours; everything else waits on its settings file unless you export
  `hp`, `ntrees` and `H` from a finished Colab session instead.
- Play-by-play cache is a few GB uncompressed; gzip keeps it small. Check `df` in step 0.
