#!/usr/bin/env python3
"""
build_hitter_xrv.py — Score a season of Statcast with the hitter xRV model and
write two files:

  public/hitter_xrv_{season}.json       per-batter xRV/600 PA broken into 14
                                        metrics (overall, the three swing/take
                                        skills, by pitch family, by zone), each
                                        with a league percentile among qualified
                                        hitters. Powers the season card column.

  public/hitter_xrv_games_{season}.json per-(batter, game) raw metric SUMS + PA
                                        for qualified hitters, so the frontend can
                                        aggregate any date range client-side and
                                        rank it against the season distribution.

────────────────────────────────────────────────────────────────────────────
⚠ RUNTIME REQUIREMENT — read before running
────────────────────────────────────────────────────────────────────────────
models/xrv_model_2022_2025.pkl is a cloudpickled custom XRVModel whose code
objects are Python 3.12 bytecode and which embeds scikit-learn 1.6.1 estimators.
It LOADS but SEGFAULTS under Python 3.11. Run it from a dedicated venv:

    uv venv --python 3.12 .venv-xrv
    .venv-xrv/bin/python -m pip install \
        scikit-learn==1.6.1 cloudpickle "numpy>=2,<3" "pandas>=2,<3" pyarrow pybaseball

Usage (from the project root):
    .venv-xrv/bin/python build_hitter_xrv.py --season 2025
    .venv-xrv/bin/python build_hitter_xrv.py --season 2023,2024,2025,2026
    .venv-xrv/bin/python build_hitter_xrv.py --season 2026 --parquet pitch_xrv_2026.parquet

If --parquet is omitted it looks for pitch_xrv_{season}.parquet in the project
root (the same file the pitcher pipeline produces); if that is missing it fetches
the full season from Statcast via pybaseball.
"""

import argparse
import json
import os
import sys
import warnings
from datetime import date
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent
MODEL_PATH = ROOT / "models" / "xrv_model_2022_2025.pkl"

# Qualification thresholds (mirror baseball_pipeline.py)
MIN_PA = 100
MIN_PA_EARLY = 25  # current season, before June 1

# Columns the model's _features() reads. A full Statcast parquet has them all;
# any that are missing are created as NaN (delta_run_exp falls back to 0.0 inside
# the model, the rest are coerced numerically).
MODEL_INPUT_COLS = [
    "pitch_type", "stand", "description", "plate_x", "plate_z", "sz_top", "sz_bot",
    "hc_x", "hc_y", "launch_speed", "launch_angle", "delta_run_exp", "balls", "strikes",
    "batter", "player_name", "game_pk", "at_bat_number", "pitch_number",
]

# (card label, source kind, key)
#   kind "col"   → sum the named per-pitch component column
#   kind "group" → sum `total` where pitch_group == key
#   kind "zh"    → sum `total` where zone_horiz == key   (inner/middle/outer/chase)
#   kind "zv"    → sum `total` where zone_vert  == key   (up/middle/low)
METRICS = [
    ("xRV/600",             "col",   "total"),
    ("Contact Quality",     "col",   "contact_spray"),
    ("Whiff",               "col",   "whiff"),
    ("Decision",            "col",   "decision"),
    ("Fastball",            "group", "fastball"),
    ("Breaking",            "group", "breaking"),
    ("Offspeed",            "group", "offspeed"),
    ("Inner",               "zh",    "inner"),
    ("Middle (vertical)",   "zh",    "middle"),
    ("Outer",               "zh",    "outer"),
    ("Upper",               "zv",    "up"),
    ("Middle (horizontal)", "zv",    "middle"),
    ("Lower",               "zv",    "low"),
    ("Chase",               "zh",    "chase"),
]


def log(msg):
    print(msg, flush=True)


def load_model():
    if not MODEL_PATH.exists():
        log(f"ERROR: model not found at {MODEL_PATH}")
        sys.exit(1)
    if sys.version_info[:2] != (3, 12):
        log(f"WARNING: running Python {sys.version_info.major}.{sys.version_info.minor}; "
            "the model expects 3.12 and may segfault. See header.")
    import pickle
    try:
        import cloudpickle  # noqa: F401  (registers reducers needed to unpickle)
    except ImportError:
        log("ERROR: cloudpickle not installed. pip install cloudpickle")
        sys.exit(1)
    with open(MODEL_PATH, "rb") as f:
        return pickle.load(f)


def load_season_df(season: int, parquet: str | None) -> pd.DataFrame:
    """Return a Statcast pitch-level DataFrame for the season."""
    path = Path(parquet) if parquet else (ROOT / f"pitch_xrv_{season}.parquet")
    if path.exists():
        log(f"  Loading {path} ...")
        df = pd.read_parquet(path)
    else:
        log(f"  {path} not found — fetching {season} from Baseball Savant ...")
        try:
            from savant_fetch import fetch_savant_range
        except ImportError as e:
            log(f"ERROR: cannot import savant_fetch ({e}) and no parquet present.")
            sys.exit(1)
        df = fetch_savant_range(season, f"{season}-03-15", f"{season}-11-15", player_type="batter")
        if df is None or len(df) == 0:
            log(f"ERROR: no Statcast data returned for {season}.")
            sys.exit(1)
    log(f"  {len(df):,} pitches")
    # Ensure every column the model reads exists.
    for c in MODEL_INPUT_COLS:
        if c not in df.columns:
            df[c] = np.nan
    df["season"] = season
    return df


def qualify_threshold(season: int) -> int:
    today = date.today()
    if season == today.year and today < date(today.year, 6, 1):
        return MIN_PA_EARLY
    return MIN_PA


def add_contrib_cols(scored: pd.DataFrame) -> list:
    """Add one per-pitch contribution column per metric so the season and the
    per-game aggregations are both a single groupby-sum. Returns the column names
    in METRICS order."""
    for c in ("total", "decision", "whiff", "contact_spray"):
        if c in scored.columns:
            scored[c] = pd.to_numeric(scored[c], errors="coerce").fillna(0.0)
    cols = []
    for i, (_label, kind, key) in enumerate(METRICS):
        cname = f"_c{i}"
        if kind == "col":
            scored[cname] = pd.to_numeric(scored[key], errors="coerce").fillna(0.0)
        elif kind == "group":
            scored[cname] = np.where(scored["pitch_group"] == key, scored["total"], 0.0)
        elif kind == "zh":
            scored[cname] = np.where(scored["zone_horiz"] == key, scored["total"], 0.0)
        elif kind == "zv":
            scored[cname] = np.where(scored["zone_vert"] == key, scored["total"], 0.0)
        else:
            raise ValueError(kind)
        cols.append(cname)
    return cols


def score_pitches(model, df: pd.DataFrame):
    """Run the model; return (scored pitches with game date + contrib cols, contrib col names)."""
    scored = model.score(df)
    scored = scored[scored["batter"].notna()].copy()
    scored["batter"] = scored["batter"].astype("int64")
    scored["game_pk"] = scored["game_pk"].astype("int64")

    # The model output drops game_date; re-attach it by game_pk for per-game splits.
    src = df.dropna(subset=["game_pk"]).copy()
    src["game_pk"] = src["game_pk"].astype("int64")
    date_by_game = src.groupby("game_pk")["game_date"].first()
    date_by_game = pd.to_datetime(date_by_game, errors="coerce").dt.strftime("%Y-%m-%d")
    scored["_gdate"] = scored["game_pk"].map(date_by_game)

    contrib = add_contrib_cols(scored)
    return scored, contrib


def aggregate_season(scored: pd.DataFrame, contrib: list) -> pd.DataFrame:
    """Aggregate scored pitches to per-batter xRV/600 PA for all 14 metrics."""
    # PA = distinct (game_pk, at_bat_number) per batter
    pa = (scored[["batter", "game_pk", "at_bat_number"]]
          .drop_duplicates()
          .groupby("batter").size().rename("pa"))
    batters = pa.index
    sums = scored.groupby("batter")[contrib].sum().reindex(batters).fillna(0.0)

    out = pd.DataFrame(index=batters)
    out["pa"] = pa
    for (label, _, _), cname in zip(METRICS, contrib):
        out[label] = sums[cname] / out["pa"] * 600.0
    return out.reset_index()


def build_games_json(scored: pd.DataFrame, contrib: list, qualified_ids: set) -> dict:
    """Per-(batter, game) raw metric SUMS + PA so the frontend can aggregate any
    date range (sum sums / sum PA × 600) and rank vs the season distribution.

    Each player maps to a list of [date, pa, *14 sums] rows (METRICS order),
    sorted by date. Only qualified hitters are emitted — matches the card's
    column visibility and keeps the file small."""
    s = scored[scored["batter"].isin(qualified_ids)]
    if s.empty:
        return {}
    sums = s.groupby(["batter", "game_pk"])[contrib].sum()
    pa = (s[["batter", "game_pk", "at_bat_number"]]
          .drop_duplicates()
          .groupby(["batter", "game_pk"]).size())
    dates = s.groupby(["batter", "game_pk"])["_gdate"].first()

    res: dict = {}
    for idx, row in sums.iterrows():
        d = dates.loc[idx]
        if not isinstance(d, str):
            continue  # unresolved game date → skip (can't date-filter it)
        arr = [d, int(pa.loc[idx])] + [round(float(row[c]), 3) for c in contrib]
        res.setdefault(str(int(idx[0])), []).append(arr)
    for k in res:
        res[k].sort(key=lambda r: r[0])
    return res


def build_json(agg: pd.DataFrame, season: int) -> dict:
    """Filter to qualified hitters, percentile each metric, and shape the JSON."""
    thr = qualify_threshold(season)
    qual = agg[agg["pa"] >= thr].copy()
    log(f"  {len(qual)} qualified hitters (min {thr} PA) of {len(agg)} total")
    if qual.empty:
        return {}

    # Percentile each metric across qualified hitters (higher = better for all 14).
    pct = {}
    n = len(qual)
    for label, _, _ in METRICS:
        ranks = qual[label].rank(method="average")
        pct[label] = ((ranks - 1) / max(n - 1, 1) * 100).round(1)

    result = {}
    for i, row in qual.iterrows():
        metrics = {}
        for label, _, _ in METRICS:
            v = float(row[label])
            metrics[label] = {
                "value": round(v, 2),
                "display": f"{v:+.1f}",
                "pctile": float(pct[label].loc[i]),
            }
        result[str(int(row["batter"]))] = {"pa": int(row["pa"]), "metrics": metrics}
    return result


def run_season(model, season: int, parquet: str | None, out_dir: Path):
    log(f"=== Hitter xRV {season} ===")
    df = load_season_df(season, parquet)
    scored, contrib = score_pitches(model, df)

    # Season card data (per-batter xRV/600 PA + percentiles).
    agg = aggregate_season(scored, contrib)
    data = build_json(agg, season)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"hitter_xrv_{season}.json"
    with open(out_path, "w") as f:
        json.dump(data, f)
    log(f"  Wrote {len(data)} hitters → {out_path}")

    # Per-game sums for client-side date-range aggregation (qualified hitters only).
    qualified_ids = {int(k) for k in data}
    games = build_games_json(scored, contrib, qualified_ids)
    games_path = out_dir / f"hitter_xrv_games_{season}.json"
    with open(games_path, "w") as f:
        json.dump(games, f)
    n_games = sum(len(v) for v in games.values())
    log(f"  Wrote {n_games} player-games ({len(games)} hitters) → {games_path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", required=True,
                    help="Season year, or comma-separated list (e.g. 2023,2024,2025,2026)")
    ap.add_argument("--parquet", default=None,
                    help="Statcast parquet path (only valid with a single --season)")
    ap.add_argument("--out", default=str(ROOT / "public"), help="Output directory")
    args = ap.parse_args()

    seasons = [int(s) for s in str(args.season).split(",") if s.strip()]
    if args.parquet and len(seasons) > 1:
        log("ERROR: --parquet can only be used with a single --season")
        sys.exit(1)

    model = load_model()
    out_dir = Path(args.out)
    for season in seasons:
        run_season(model, season, args.parquet, out_dir)
    log("Done.")


if __name__ == "__main__":
    main()
