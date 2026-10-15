#!/usr/bin/env python3
"""
build_iswing_history.py — walk-forward, out-of-sample LEAN iSwing+ for every
batter-season, plus the "does he beat his swing?" residual.

For each season Y it trains the lean iSwing+ model (10 swing features, no hitter
traits) on contact swings from seasons BEFORE Y only, then scores season Y. So every
number in the output is what you could have published at the end of that season,
and it is safe to use in projection backtests. The first season in the data has no
earlier seasons to learn from, so it gets no row.

Per batter-season output (history/iswing_history.csv):
  iswing            lean iSwing+ (100 = average, 15 = 1 SD among ≥100-swing hitters)
  n_swings          competitive swings scored
  n_bbe             batted balls with an xwOBAcon value
  xwobacon_actual   his actual xwOBAcon on those batted balls
  xwobacon_swing    what the model expected from those same swings
  swing_residual    actual − expected: how much he beats (+) or trails (−) his swing

USAGE
  python3 build_iswing_history.py --swings "competitive_swings_*.csv"
  python3 build_iswing_history.py --swings competitive_swings_2023_2026.csv --out history/
"""

import argparse
import glob
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.model_selection import GroupShuffleSplit
from sklearn.preprocessing import StandardScaler
from xgboost import XGBRegressor

LEAN_FEATURES = [
    "bat_speed", "swing_length",
    "speed_over_expected", "speed_vs_location",
    "aa_vs_optimal", "aa_adjustment", "tilt_for_height", "direction_from_optimal", "length_for_location",
    "effort_level",
]
XGB_PARAMS = dict(n_estimators=800, max_depth=7, learning_rate=0.03, subsample=0.8, colsample_bytree=0.7,
                  min_child_weight=50, gamma=0.1, reg_alpha=0.1, reg_lambda=1.0, eval_metric="rmse",
                  early_stopping_rounds=50, random_state=42, n_jobs=-1)
MIN_SCALE_SWINGS = 100   # hitters used to set each season's 100/15 scale


def log(*a):
    print(*a, flush=True)


def add_features(df):
    """v9.1 lean definitions. League norms and personal ceilings are per SEASON."""
    have = lambda *c: all(x in df.columns for x in c)
    df["year"] = pd.to_datetime(df["game_date"]).dt.year
    df["batter"] = df["batter"].astype(int)
    if have("bat_speed", "plate_x"):
        xb = pd.cut(df["plate_x"].clip(-1.999, 1.999), bins=np.linspace(-2, 2, 21), labels=False)
        df["speed_over_expected"] = (df["bat_speed"]
                                     - df.groupby([df["year"], xb])["bat_speed"].transform("mean")).fillna(0)
    if have("bat_speed", "plate_x", "plate_z"):
        df["speed_vs_location"] = df["bat_speed"] * (1 + 0.3 * np.sqrt(df["plate_x"]**2 + (df["plate_z"] - 2.5)**2))
    if have("attack_angle", "plate_z"):
        pz = df["plate_z"].clip(1.0, 4.0)
        df["aa_vs_optimal"] = -np.abs(df["attack_angle"] - (3 * (pz - 1.0)**2 + 7).clip(5, 30))
        if have("sz_top", "sz_bot"):
            phn = (df["plate_z"] - df["sz_bot"]) / (df["sz_top"] - df["sz_bot"]).replace(0, np.nan)
        else:
            phn = (df["plate_z"] - 1.5) / 1.85
        phn = phn.clip(0, 1.5)
        df["aa_adjustment"] = -np.abs(df["attack_angle"] - (3 * (phn * 1.85)**2 + 7).clip(5, 30))
    if have("swing_path_tilt", "plate_z"):
        df["tilt_for_height"] = -np.abs(df["swing_path_tilt"] - (58 - 10 * df["plate_z"].clip(1.0, 4.0)).clip(20, 48))
    if have("attack_direction", "plate_x", "stand"):
        bpx = np.where(df["stand"] == "R", -df["plate_x"], df["plate_x"])
        bad = np.where(df["stand"] == "R", -df["attack_direction"], df["attack_direction"])
        df["direction_from_optimal"] = -np.abs(bad - (20 * bpx).clip(-18, 18))
    if have("swing_length", "plate_x"):
        df["length_for_location"] = -(df["swing_length"] - (7.3 + 0.3 * df["plate_x"]))
    if "bat_speed" in df.columns:
        p90 = df.groupby(["batter", "year"])["bat_speed"].transform("quantile", 0.90)
        df["effort_level"] = df["bat_speed"] / p90.replace(0, np.nan)
    missing = [f for f in LEAN_FEATURES if f not in df.columns]
    if missing:
        raise KeyError(f"Cannot build {missing} — raw Statcast columns missing from the swings CSV")
    contact = df["launch_speed"].notna() & df["launch_angle"].notna() if "launch_angle" in df.columns \
        else df["launch_speed"].notna()
    df["xwOBAcon"] = np.where(contact, df["estimated_woba_using_speedangle"], np.nan)
    return df


def fit_model(train):
    med = {c: float(train[c].median()) for c in LEAN_FEATURES}
    X = train[LEAN_FEATURES].fillna(med)
    y = train["xwOBAcon"]
    tr, va = next(GroupShuffleSplit(1, test_size=0.15, random_state=42).split(X, y, groups=train["batter"]))
    sc = StandardScaler().fit(X.iloc[tr])
    Xs = pd.DataFrame(sc.transform(X), columns=LEAN_FEATURES, index=X.index)
    m = XGBRegressor(**XGB_PARAMS).fit(Xs.iloc[tr], y.iloc[tr], eval_set=[(Xs.iloc[va], y.iloc[va])], verbose=False)
    return m, sc, med


def predict(m, sc, med, d):
    X = d[LEAN_FEATURES].fillna(med)
    return m.predict(pd.DataFrame(sc.transform(X), columns=LEAN_FEATURES, index=X.index))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--swings", nargs="+", default=["competitive_swings_*.csv"],
                    help="swings CSV path(s) or glob(s); seasons are taken from game_date")
    ap.add_argument("--out", default="./history")
    args = ap.parse_args()

    paths = sorted({p for g in args.swings for p in glob.glob(g)})
    if not paths:
        raise SystemExit(f"No swings CSVs match {args.swings}")
    df = pd.concat([pd.read_csv(p, low_memory=False) for p in paths], ignore_index=True)
    key = [c for c in ["game_date", "batter", "pitcher", "balls", "strikes", "plate_x", "plate_z", "bat_speed"]
           if c in df.columns]
    df = df.drop_duplicates(subset=key).dropna(subset=["bat_speed"]).reset_index(drop=True)
    df = add_features(df)
    seasons = sorted(df["year"].unique())
    log(f"Loaded {len(df):,} swings from {len(paths)} file(s); seasons {[int(s) for s in seasons]}")
    log("Swings per season: " + ", ".join(f"{y}: {n:,}" for y, n in df["year"].value_counts().sort_index().items()))

    contact = df[df["xwOBAcon"].notna()]
    rows = []
    for Y in seasons:
        train = contact[contact["year"] < Y]
        if train["batter"].nunique() < 100:
            log(f"  {Y}: no earlier seasons to train on — skipped (expected for the first season)")
            continue
        m, sc, med = fit_model(train)
        d = df[df["year"] == Y].copy()
        d["pred"] = predict(m, sc, med, d).clip(0.001)
        g = d.groupby("batter").agg(raw=("pred", "mean"), n_swings=("pred", "size"))
        bbe = d[d["xwOBAcon"].notna()].groupby("batter").agg(
            n_bbe=("xwOBAcon", "size"), xwobacon_actual=("xwOBAcon", "mean"), xwobacon_swing=("pred", "mean"))
        g = g.join(bbe, how="left")
        g["n_bbe"] = g["n_bbe"].fillna(0).astype(int)
        # 100/15 scale set on regulars, applied to everyone
        lr = np.log(g["raw"])
        ref = lr[g["n_swings"] >= MIN_SCALE_SWINGS]
        g["iswing"] = 100 + 15 * (lr - ref.mean()) / ref.std()
        g["swing_residual"] = g["xwobacon_actual"] - g["xwobacon_swing"]
        g["season"] = Y
        rows.append(g.reset_index().rename(columns={"batter": "player_id"}))
        log(f"  {Y}: trained on {[int(s) for s in sorted(train.year.unique())]} ({len(train):,} BBE), "
            f"scored {len(g):,} batters, best_iter={m.best_iteration}")

    if not rows:
        raise SystemExit("Need at least two seasons of swings.")
    out = pd.concat(rows, ignore_index=True)[
        ["player_id", "season", "iswing", "n_swings", "n_bbe", "xwobacon_actual", "xwobacon_swing", "swing_residual"]]
    Path(args.out).mkdir(parents=True, exist_ok=True)
    path = Path(args.out) / "iswing_history.csv"
    out.round(5).to_csv(path, index=False)
    log(f"\nWrote {path}  ({len(out):,} batter-seasons)")

    # Quick look at whether beating your swing repeats
    r = out[out["n_bbe"] >= 60][["player_id", "season", "swing_residual"]]
    nxt = r.copy(); nxt["season"] -= 1
    mm = r.merge(nxt, on=["player_id", "season"], suffixes=("", "_next"))
    if len(mm) >= 30:
        log(f"Swing-residual year-to-year r = {mm['swing_residual'].corr(mm['swing_residual_next']):+.3f} "
            f"(n={len(mm)}, ≥60 BBE both seasons). ≳0.3 → a real skill the projection should keep.")


if __name__ == "__main__":
    main()
