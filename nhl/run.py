"""NHL pipeline driver: scrape -> xG -> ratings -> check -> export -> publish.

    python -m nhl.run nightly            everything, skipping the model stages when no new games finished
    python -m nhl.run scrape|xg|ratings|check|export|publish     one stage

The model code is not here. It is in the three notebooks in notebooks/nhl/, which this
driver executes with nhl/nbrun.py. Data lives in $NHL_DATA_DIR (default /var/lib/pte-nhl)
under the same file names the notebooks use on Drive, so a copy of the Drive folder is a
valid starting point. See nhl/README.md.
"""
import argparse
import ast
import json
import os
import subprocess
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from . import nbrun
from .nbrun import log

REPO = Path(__file__).resolve().parent.parent
NB = REPO / "notebooks" / "nhl"
DATA = Path(os.environ.get("NHL_DATA_DIR", "/var/lib/pte-nhl"))
SITE = Path(os.environ.get("NHL_SITE_DIR", REPO / "public" / "nhl"))
STATE = DATA / "state"
STAGES = ["scrape", "xg", "ratings", "check", "export", "publish"]

# Settings the ratings notebook chooses by search. Saved after every run so a change is visible in the log.
PICKS = ["W1", "W2", "LAM_1Y", "LAM_3Y", "QW1", "QW2", "SW1", "SW2", "LAM_ST_1Y", "LAM_ST_3Y", "SETUP_RATIO",
         "USE_SETUP", "USE_RESULTS", "LAM_SH_1Y", "LAM_SH_3Y", "HW1", "HW2", "RESULTS_USED", "GOALIE_USED",
         "G_RATIO", "GW1", "GW2"]
MEASURED = ["GPW", "PEN_VALUE", "SCALE", "SEASON_DONE", "LATEST"]


def season_now(today=None):
    """Start year of the season that is under way (or was last played): 2026 means 2026-27."""
    today = today or date.today()
    return today.year if today.month >= 10 else today.year - 1


def read_json(path, default=None):
    path = Path(path)
    return json.loads(path.read_text()) if path.exists() else default


def write_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o)))


# --------------------------------------------------------------------------- scrape
def merge_shifts(shifts):
    """Merge overlapping shift records for the same player and period.

    The NHL's shift charts sometimes list a shift twice or more. Counted as they come, a
    duplicate makes a second of 5v5 look like six skaters, so that second drops out of the
    ice-time file. Stints were never affected (they use an on/off grid). Shifts that only
    touch (one ends as the next starts) stay separate.
    """
    if not shifts:
        return shifts
    by = {}
    for pid, tid, per, st, en in shifts:
        by.setdefault((pid, tid, per), []).append((st, en))
    out = []
    for (pid, tid, per), spans in by.items():
        spans.sort()
        cs, ce = spans[0]
        for st, en in spans[1:]:
            if st < ce:
                ce = max(ce, en)
            else:
                out.append([pid, tid, per, cs, ce])
                cs, ce = st, en
        out.append([pid, tid, per, cs, ce])
    return out


def game_sets(y):
    """(games in the shots file, games in the ice-time file) for one season."""
    import pandas as pd
    out = []
    for name in ("shots", "toi"):
        f = DATA / f"{name}_{y}.csv"
        try:
            out.append(set(pd.read_csv(f, usecols=["game_id"]).game_id.unique().tolist()))
        except (FileNotFoundError, ValueError, pd.errors.EmptyDataError):
            out.append(set())
    return out


def stage_scrape(a):
    import pandas as pd
    DATA.mkdir(parents=True, exist_ok=True)
    ns = nbrun.run(NB / "nhl_xg_scraper.ipynb", [1, 2], DATA, overrides=a.set.get("scraper"))
    raw_fetch = ns["fetch_shifts"]
    ns["fetch_shifts"] = lambda gid: merge_shifts(raw_fetch(gid))
    cur, changed = season_now(), False

    def save(out, y):
        for name, table in out.items():
            table.to_csv(DATA / f"{name}_{y}.csv", index=False)
        log(f"saved {y}: {len(out['shots']):,} shots, {len(out['events']):,} events, "
            f"{len(out['toi']):,} player-games from {out['shots'].game_id.nunique()} games")

    # Finished seasons: scraped once, then left alone (as section 4 of the notebook).
    for y in range(a.first_season, cur):
        if all((DATA / f"{n}_{y}.csv").exists() for n in ("shots", "events", "toi")):
            continue
        log(f"=== {y}-{str(y + 1)[2:]}: not on disk, scraping the whole season")
        ids = ns["season_game_ids"](y, max_games=a.max_games) if a.max_games else ns["season_game_ids"](y)
        out = ns["scrape_games"](ids)
        if out["shots"].empty:
            raise SystemExit(f"No games came back for {y}. Is the NHL API reachable?")
        save(out, y)
        changed = True

    # The season under way: finished games only, from the schedule (as section 6 of the notebook).
    start, yday = f"{cur}-10-01", (date.today() - timedelta(days=1)).isoformat()
    ids = []
    if yday >= start:
        ids = [g for g in ns["game_ids_between"](start, yday, game_types=(2,)) if str(g).startswith(str(cur))]
    if a.max_games:
        ids = ids[:a.max_games]
    have, have_toi = game_sets(cur)
    if not ids:
        log(f"{cur}-{str(cur + 1)[2:]}: no finished games yet")
    elif set(ids) == have and have_toi == have:
        log(f"{cur}-{str(cur + 1)[2:]}: no new finished games ({len(have)} on disk)")
    else:
        log(f"=== {cur}-{str(cur + 1)[2:]}: {len(set(ids) - have)} new game(s), "
            f"{len(have - have_toi)} waiting on a shift chart; rebuilding the season from cache")
        out = ns["scrape_games"](ids, stop_after_misses=len(ids) + 1)
        if not out["shots"].empty:
            save(out, cur)
        changed |= game_sets(cur) != [have, have_toi]

    # Stints (section 7), for any season whose stints file is missing or older than what it is built from.
    for f in sorted(DATA.glob("toi_*.csv")):
        y = f.stem.split("_", 1)[1]
        dst, srcs = DATA / f"stints_{y}.csv", [DATA / f"{n}_{y}.csv" for n in ("toi", "shots", "events")]
        if dst.exists() and dst.stat().st_mtime >= max(s.stat().st_mtime for s in srcs):
            continue
        toi = pd.read_csv(srcs[0], usecols=["game_id", "player_id", "pos", "is_home"])
        shots = pd.read_csv(srcs[1], usecols=["game_id", "is_goal", "game_seconds", "is_home"])
        events = pd.read_csv(srcs[2], usecols=["game_id", "event", "game_seconds", "zone", "is_home"])
        log(f"=== stints {y}")
        st = ns["season_stints"](toi, shots, events)
        games, want = (st.game_id.nunique() if len(st) else 0), toi.game_id.nunique()
        if games < 0.9 * want:
            msg = (f"stints {y}: shift charts are cached for only {games} of {want} games")
            if dst.exists():
                log(f"WARNING {msg}; keeping the existing stints_{y}.csv")
                os.utime(dst)
                continue
            raise SystemExit(msg + f". Copy nhl_cache/ from Drive, or delete the {y} CSVs to re-scrape the season.")
        st.to_csv(dst, index=False)
        log(f"saved stints_{y}.csv: {len(st):,} stints from {games} games, "
            f"{st[st.state == '5v5'].seconds.sum() / 60 / games:.1f} min of 5v5 per game")
        changed = True

    # Player details (section 8). Cached per player, so only new players are looked up.
    ids = pd.concat([pd.read_csv(f, usecols=["player_id"]) for f in DATA.glob("toi_*.csv")]).player_id.unique()
    players = ns["fetch_bios"](ids)
    players.to_csv(DATA / "players.csv", index=False)
    log(f"saved players.csv: {len(players):,} players")

    have, have_toi = game_sets(cur)
    write_json(STATE / "scrape.json", {"season": cur, "games": len(have), "games_with_shifts": len(have_toi),
                                       "changed": bool(changed), "at": datetime.now(timezone.utc).isoformat()})
    log(f"scrape finished; new data: {'yes' if changed else 'no'}")


# --------------------------------------------------------------------------- xG
def stage_xg(a):
    import pandas as pd
    cfg_path, out = DATA / "xg_config.json", DATA / "xg_final.csv"
    cfg = read_json(cfg_path)
    tune = a.tune or cfg is None
    if tune:
        log("xG settings: " + ("re-tuning as asked" if cfg else "no xg_config.json yet, so tuning first (section 8). "
                               "This is the slow part and happens once."))
    prev = pd.read_csv(out) if out.exists() and not (tune or a.refresh_all) else None

    def save_cfg(ns):
        write_json(cfg_path, {"H": ns["H"], "hp": ns["hp"], "ntrees": {k: int(v) for k, v in ns["ntrees"].items()},
                              "features": list(ns["features"]), "n_trials": ns.get("N_TRIALS"),
                              "tuned_at": datetime.now(timezone.utc).isoformat()})
        log(f"saved {cfg_path}")

    def load_cfg(ns):
        if tune:
            return
        if list(cfg.get("features") or ns["features"]) != list(ns["features"]):
            log("WARNING the notebook's feature list differs from the one the settings were tuned on; "
                "run `python -m nhl.run xg --tune` when convenient")
        if cfg.get("H", ns["H"]) != ns["H"]:
            log(f"WARNING xg_config.json was tuned with H = {cfg['H']}, the notebook now has H = {ns['H']}")
        ns["hp"], ns["ntrees"] = cfg["hp"], {k: int(v) for k, v in cfg["ntrees"].items()}
        log(f"xG settings from {cfg_path.name} (tuned {str(cfg.get('tuned_at', 'in Colab'))[:10]}); trees {ns['ntrees']}")

    def freeze(ns):
        # Earlier seasons keep the xG they already had, so they do not shift from night to night.
        if prev is None:
            return
        cols, keys = ["game_id", "event_id", "xg_final", "xg_flurry"], ["game_id", "event_id"]
        new, latest = ns["df"][cols], int(ns["df"].season.max())
        old = prev[prev.game_id // 1_000_000 < latest].drop_duplicates(keys)
        m = new.merge(old, on=keys, how="left", suffixes=("", "_old"))
        kept = m.xg_final_old.notna()
        for c in ("xg_final", "xg_flurry"):
            m[c] = m[f"{c}_old"].where(kept, m[c])
        m[cols].to_csv(out, index=False)
        log(f"xg_final.csv: {int(kept.sum()):,} shots from earlier seasons kept as they were, "
            f"{int((~kept).sum()):,} shots scored fresh")

    nbrun.run(NB / "nhl_xg_modeling.ipynb", [1, 2, 3, 4, 5] + ([8] if tune else []) + [14, 15, 16, 17], DATA,
              overrides=a.set.get("xg"),
              hooks={("after", 8): save_cfg, ("before", 14): load_cfg, ("after", 17): freeze})


# --------------------------------------------------------------------------- ratings
def stage_ratings(a):
    def save_meta(ns):
        old = read_json(STATE / "ratings_meta.json", {})
        write_json(STATE / "ratings_meta.json", {**{k: ns[k] for k in PICKS + MEASURED if k in ns},
                                                 "at": datetime.now(timezone.utc).isoformat()})
        meta = read_json(STATE / "ratings_meta.json")
        moved = [f"{k}: {old[k]} -> {meta[k]}" for k in PICKS if k in old and k in meta and old[k] != meta[k]]
        if moved:
            log("NOTE settings the notebook chose differently from the last run: " + "; ".join(moved))

    want = list(range(1, 15)) + ([] if a.skip_diagnostics else [15]) + [16]
    nbrun.run(NB / "nhl_player_ratings.ipynb", want, DATA, overrides=a.set.get("ratings"),
              hooks={("after", 16): save_meta}, tolerant=(15,))


# --------------------------------------------------------------------------- check
def stage_check(a):
    """Refuse to publish numbers that look broken. Exits non-zero on any problem."""
    import pandas as pd
    problems, notes = [], []
    r = pd.read_csv(DATA / "player_ratings.csv", usecols=["season", "player_id", "team", "war_1y"])
    g = pd.read_csv(DATA / "goalie_ratings.csv", usecols=["season", "goalie_id", "team", "war_1y"])
    on_disk = sorted(int(f.stem.split("_", 1)[1]) for f in DATA.glob("stints_*.csv"))
    latest = int(r.season.max())
    if latest != on_disk[-1]:
        problems.append(f"ratings stop at {latest} but stints exist for {on_disk[-1]}")
    cur = r[(r.season == latest) & r.team.notna()]
    if cur.empty or cur.war_1y.notna().mean() < 0.5:
        problems.append(f"{latest}: fewer than half of the skaters have a WAR")
    if g[(g.season == latest) & g.war_1y.notna()].empty:
        problems.append(f"{latest}: no goalie has a WAR")

    st = pd.read_csv(DATA / f"stints_{latest}.csv", usecols=["game_id", "state", "seconds"])
    games = st.game_id.nunique()
    m5 = st[st.state == "5v5"].seconds.sum() / 60 / max(games, 1)
    notes.append(f"{latest}: {games} games, {m5:.1f} min of 5v5 per game")
    if not 44 <= m5 <= 52:
        problems.append(f"{latest}: {m5:.1f} min of 5v5 per game (expected 46 to 50)")

    sh = pd.read_csv(DATA / f"shots_{latest}.csv", usecols=["game_id", "event_id", "is_goal"])
    xg = pd.read_csv(DATA / "xg_final.csv")
    j = sh.merge(xg, on=["game_id", "event_id"])
    if len(j) >= 5000:
        ratio = j.xg_final.sum() / max(j.is_goal.sum(), 1)
        notes.append(f"{latest}: xG / goals = {ratio:.3f} on {len(j):,} shots")
        if not 0.85 <= ratio <= 1.15:
            problems.append(f"{latest}: xG / goals = {ratio:.3f} (expected close to 1)")
    elif j.empty:
        problems.append(f"{latest}: no shot has an xG value")

    live = read_json(SITE / f"skaters_{latest}.json")
    if live and len(cur) < 0.9 * len(live["rows"]):
        problems.append(f"{latest}: {len(cur)} skaters, down from {len(live['rows'])} on the site")

    for n in notes:
        log("check: " + n)
    if problems:
        for p in problems:
            log("CHECK FAILED: " + p)
        raise SystemExit(1)
    log("checks passed")


# --------------------------------------------------------------------------- export, publish
def stage_export(a):
    from .export_site import export
    export(DATA, SITE, every_season=a.all, picks=read_json(STATE / "ratings_meta.json", {}))


def stage_publish(a):
    """Commit the site folder and push it, the way the daily baseball update does."""
    rel = os.path.relpath(SITE, REPO)
    if rel.startswith(".."):
        log(f"{SITE} is outside the repository, so there is nothing to push")
        return

    def git(*args, check=True):
        return subprocess.run(["git", "-C", str(REPO), *args], check=check, capture_output=True, text=True)

    git("add", "--", rel)
    if git("diff", "--cached", "--quiet", "--", rel, check=False).returncode == 0:
        log("publish: no changes to commit")
        return
    who = [] if git("config", "user.email", check=False).stdout.strip() else \
        ["-c", "user.name=auto-update", "-c", "user.email=auto@pasttheeyetest.com"]
    git(*who, "commit", "-q", "-m", f"NHL data update {date.today().isoformat()}", "--", rel)
    branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    for attempt in range(4):
        git("pull", "--rebase", "--autostash", "origin", branch, check=False)
        push = git("push", "origin", f"HEAD:{branch}", check=False)
        if push.returncode == 0:
            log(f"publish: pushed {rel} to {branch}")
            return
        log(f"publish: push failed (attempt {attempt + 1}): {push.stderr.strip().splitlines()[-1] if push.stderr.strip() else ''}")
        time.sleep(2 ** attempt * 2)
    raise SystemExit("publish: could not push; the commit is local, run `git push` by hand")


# --------------------------------------------------------------------------- nightly
def stage_nightly(a):
    passed = sys.argv[2:]

    def sub(stage):
        keep, skip = [], False
        for i, tok in enumerate(passed):                      # drop --from X before handing the flags on
            if skip:
                skip = False
            elif tok == "--from":
                skip = True
            elif not tok.startswith("--from="):
                keep.append(tok)
        log(f"========== {stage}")
        t0 = time.time()
        code = subprocess.run([sys.executable, "-u", "-m", "nhl.run", stage, *keep], cwd=REPO).returncode
        log(f"========== {stage} {'finished' if code == 0 else 'FAILED'} in {(time.time() - t0) / 60:.1f} min")
        if code:
            raise SystemExit(f"nightly stopped at `{stage}`. Fix the cause, then: nhl/nightly.sh --from {stage}")

    todo = STAGES[STAGES.index(a.start):]
    if "scrape" in todo:
        sub("scrape")
        todo.remove("scrape")
        built = all((DATA / f).exists() for f in ("xg_final.csv", "player_ratings.csv", "goalie_ratings.csv")) \
            and (SITE / "meta.json").exists()
        if built and not a.force and not a.tune and not read_json(STATE / "scrape.json", {}).get("changed"):
            log("No new games since the last run, so the ratings are already current. Nothing to do. "
                "(--force runs everything anyway.)")
            return
    for stage in todo:
        if stage == "publish" and a.no_push:
            log("publish skipped (--no-push)")
            continue
        sub(stage)
    log("nightly finished")


def parse_sets(items):
    out = {}
    for item in items or []:
        try:
            left, value = item.split("=", 1)
            nb, name = left.split(".", 1)
            assert nb in ("scraper", "xg", "ratings")
        except (ValueError, AssertionError):
            raise SystemExit(f"--set {item}: write it as scraper.NAME=value, xg.NAME=value or ratings.NAME=value")
        try:
            value = ast.literal_eval(value)
        except (ValueError, SyntaxError):
            pass
        out.setdefault(nb, {})[name] = value
    return out


def main():
    p = argparse.ArgumentParser(prog="python -m nhl.run", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("stage", choices=["nightly"] + STAGES)
    p.add_argument("--from", dest="start", choices=STAGES, default="scrape", help="nightly: start at this stage")
    p.add_argument("--force", action="store_true", help="nightly: run every stage even with no new games")
    p.add_argument("--no-push", action="store_true", help="nightly: build the site files but do not commit or push")
    p.add_argument("--tune", action="store_true", help="xg: search for model settings again (hours)")
    p.add_argument("--refresh-all", action="store_true", help="xg: re-score earlier seasons too")
    p.add_argument("--all", action="store_true", help="export: rewrite earlier seasons' site files too")
    p.add_argument("--skip-diagnostics", action="store_true", help="ratings: skip section 15 (leaders, repeatability)")
    p.add_argument("--first-season", type=int, default=int(os.environ.get("NHL_FIRST_SEASON", 2019)))
    p.add_argument("--max-games", type=int, default=0, help="testing only: cap the games scraped per season")
    p.add_argument("--set", action="append", metavar="NOTEBOOK.NAME=VALUE",
                   help="override a notebook setting, e.g. --set xg.N_TRIALS=10 (notebook: scraper, xg, ratings)")
    a = p.parse_args()
    a.set = parse_sets(a.set)
    os.environ.setdefault("MPLBACKEND", "Agg")
    globals()[f"stage_{a.stage}"](a)


if __name__ == "__main__":
    main()
