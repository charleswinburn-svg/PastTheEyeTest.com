# NHL pipeline

Runs the three notebooks in `notebooks/nhl/` on the droplet and pushes the results to GitHub:

```
NHL API ─▶ scrape ─▶ xG ─▶ ratings ─▶ check ─▶ export ─▶ push
           scraper    modeling  ratings            public/nhl/*.json
           notebook   notebook  notebook
```

One command does all of it: `nhl/nightly.sh`. Cron runs the same command every morning.

**The notebooks are the model code.** Nothing was re-typed into `.py` files. `nhl/nbrun.py`
executes their code cells as they are, with the Drive folder swapped for the droplet's data
folder and the Colab-only lines (Drive mount, `!pip`) dropped. To change the model, change the
notebook in Colab, download it, and replace the file in `notebooks/nhl/` (keep the file name).

## What goes where

| Where | What |
|---|---|
| GitHub, `public/nhl/` | The site files: every column of the skater and goalie ratings per season, players with flags, WAR history and tiers, team WAR, and `meta.json`. Pushed by the nightly run. |
| Droplet only, `/var/lib/pte-nhl/` | Everything the notebooks write to Drive today, under the same names: `shots_/events_/toi_/stints_YYYY.csv`, `players.csv`, `xg_final.csv`, `player_ratings.csv`, `goalie_ratings.csv`, `team_war.csv`, and `nhl_cache/`. |

The raw tables stay off GitHub because of their size: a season of shots is close to GitHub's
100 MB file limit and the play-by-play cache is several GB.

## One-time setup on the droplet

```bash
cd /var/www/pasttheeyetest.com && git pull
```

```bash
sudo mkdir -p /var/lib/pte-nhl && sudo chown "$USER" /var/lib/pte-nhl
```

Optional, and it saves hours on the first night: copy what you already have on Drive into
`/var/lib/pte-nhl/` (the season CSVs, `xg_final.csv`, `players.csv`, the `nhl_cache/` folder, and
`xg_config.json` if you saved one from Colab). Anything that is there is used; anything missing is built.

## Before bed: the first run

```bash
cd /var/www/pasttheeyetest.com && nohup nhl/nightly.sh > /dev/null 2>&1 &
```

```bash
tail -f /var/lib/pte-nhl/logs/latest.log
```

`nohup` keeps it running after you close the terminal. What the first run has to do:

| Step | From nothing | With the Drive files copied over |
|---|---|---|
| Scrape 2019-20 to now, plus details for about 2,500 players | 6–7 hours | minutes (current season only) |
| Tune the xG model (once; skipped when `xg_config.json` exists) | 1–2 hours | 1–2 hours, or none |
| Score xG, fit ratings, export, push | about 1–1.5 hours | about 1–1.5 hours |

If a stage fails, the log's last line says which one. Fix the cause and pick up from there:

```bash
nhl/nightly.sh --from ratings
```

## Every night: cron

```bash
crontab -e
```

Add this line (10:00 UTC, after the West Coast games and well before the 16:30 UTC baseball update):

```
0 10 * * * /var/www/pasttheeyetest.com/nhl/nightly.sh > /dev/null 2>&1
```

A normal night scrapes the new games, re-scores the current season's xG, refits the ratings,
checks the numbers and pushes `public/nhl/`. When no new games finished it stops after the
scrape. A second copy never starts while one is running.

The push goes to whatever branch the droplet's checkout is on, with the same pull-rebase-push
the baseball update uses, and commits only `public/nhl/`.

## What the run decides for you

- **Finished seasons are scraped once.** The current season is rebuilt from the cache each night
  from the schedule's finished games; games whose shift chart was missing are retried.
- **Duplicate shift records are merged** before anything is built (`merge_shifts` in `run.py`).
  The NHL's charts sometimes list a shift twice, which made the ice-time file undercount 5v5.
- **xG settings** (`xg_config.json`: `hp`, `ntrees`, `H`) come from section 8 of the modeling
  notebook. They are searched for once and reused; `--tune` searches again.
- **Earlier seasons' xG is kept** as it was; only the current season is re-scored each night.
  `python -m nhl.run xg --refresh-all` re-scores everything.
- **Earlier seasons' site files are kept** too, so a finished season's published numbers do not
  drift. `python -m nhl.run export --all` rewrites them; do that after changing a notebook and
  once when a season ends.
- **Checks before publishing.** If the current season's 5v5 minutes per game, xG-to-goals ratio
  or player counts look wrong, nothing is exported or pushed and yesterday's files stay live.
- **The ratings notebook still chooses its own shrinkage and weights each run**, as it does in
  Colab. When a choice differs from the previous run the log says so (`NOTE settings ...`).

## Flags

`players.json` and every ratings row carry a two-letter `flag` code, from the NHL's country of
birth for each player. For a player who should show a different flag, add his id to
`nhl/flag_overrides.json`.

## Handy commands

Run from the repository root with the pipeline's Python (`/var/lib/pte-nhl/venv/bin/python`).

| Command | What it does |
|---|---|
| `python -m nhl.run scrape` | Only fetch and build the tables |
| `python -m nhl.run xg --tune` | Search for xG settings again, then score |
| `python -m nhl.run ratings --skip-diagnostics` | Fit the ratings without section 15's leader and repeatability tables |
| `python -m nhl.run check` | The pre-publish checks on what is on disk |
| `python -m nhl.run export --all` | Rewrite every season's site files |
| `python -m nhl.run xg --set xg.N_TRIALS=10` | Override a notebook setting for one run (`scraper.`, `xg.` or `ratings.` then the setting's name) |

Environment variables: `NHL_DATA_DIR` (default `/var/lib/pte-nhl`), `NHL_SITE_DIR` (default
`public/nhl` in this repository), `NHL_VENV`, `NHL_FIRST_SEASON` (default 2019).

## If a notebook's layout changes

`run.py` picks cells by the notebook's numbered headings (`## 8. Hyperparameter tuning`). It
runs scraper sections 1–2 (the functions; `run.py` itself decides which seasons to fetch),
modeling sections 1–5, 8 (only when tuning), 14–17, and ratings sections 1–16. If you renumber
or remove one of those, the run stops with a message naming the section, and the lists in
`run.py` need the new numbers.
