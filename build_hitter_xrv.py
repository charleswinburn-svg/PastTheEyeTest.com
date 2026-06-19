#!/usr/bin/env python3
"""
build_hitter_xrv.py — Score a season of Statcast with the hitter xRV model and
write public/hitter_xrv_{season}.json: per-batter xRV/600 PA broken down into
14 metrics (overall, the three swing/take skills, by pitch family, by zone), each
with a league percentile among qualified hitters.

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
        log(f"  {path} not found — fetching {season} from Statcast (pybaseball) ...")
        try:
            from pybaseball import statcast
        except ImportError:
            log("ERROR: pybaseball not installed and no parquet present. pip install pybaseball")
            sys.exit(1)
        df = statcast(start_dt=f"{season}-03-15", end_dt=f"{season}-11-15")
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


def score_and_aggregate(model, df: pd.DataFrame) -> pd.DataFrame:
    """Run the model and aggregate to per-batter xRV/600 PA for all 14 metrics."""
    scored = model.score(df)
    scored = scored[scored["batter"].notna()].copy()
    scored["batter"] = scored["batter"].astype("int64")

    # PA = distinct (game_pk, at_bat_number) per batter
    pa = (scored[["batter", "game_pk", "at_bat_number"]]
          .drop_duplicates()
          .groupby("batter").size().rename("pa"))

    batters = pa.index
    out = pd.DataFrame(index=batters)
    out["pa"] = pa

    g = scored.groupby("batter")

    def slice_sum(mask):
        s = scored.loc[mask].groupby("batter")["total"].sum()
        return s.reindex(batters).fillna(0.0)

    for label, kind, key in METRICS:
        if kind == "col":
            col = g[key].sum().reindex(batters).fillna(0.0)
        elif kind == "group":
            col = slice_sum(scored["pitch_group"] == key)
        elif kind == "zh":
            col = slice_sum(scored["zone_horiz"] == key)
        elif kind == "zv":
            col = slice_sum(scored["zone_vert"] == key)
        else:
            raise ValueError(kind)
        # per 600 PA
        out[label] = col / out["pa"] * 600.0

    return out.reset_index()


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
    agg = score_and_aggregate(model, df)
    data = build_json(agg, season)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"hitter_xrv_{season}.json"
    with open(out_path, "w") as f:
        json.dump(data, f)
    log(f"  Wrote {len(data)} hitters → {out_path}")


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
