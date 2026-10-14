#!/usr/bin/env python3
"""
build_stuff_waterfall.py — per pitcher × pitch type, how much each pitch trait moved
that pitch's Stuff+ away from the league-average pitch of the same type.

Uses the production Stuff model itself (the four LightGBM FB/OFF × same/oppo
sub-models in pitch-plus-api/models) and the production feature code
(pitch-plus-api/score_pitches.engineer_stuff_features), so every number traces back
to what /leaderboard publishes. Per pitch, LightGBM's exact TreeSHAP contributions
(pred_contrib) split the predicted xRV across features; they are averaged per
pitcher × pitch type, measured against the average qualified pitcher's pitch of that
type, and converted to Stuff+ points with that type's slope of the Stuff+ transform
(−100 / (stuff_std[pt] · rescale.stdev) points per unit of xRV).

The waterfall runs 100 → "Avg {type}" (the league-average pitch of that type) →
one bar per trait → the published Stuff+. The small leftover from the ±4σ clamp and
rounding is spread in proportion to bar size, then bars are rounded to 0.1 with the
remainder folded into the largest, so the bars land exactly on the published value.

Output: {out}/stuff_waterfall_{season}.json
  {"meta": {...}, "<pitcher_id>": {"name", "n", "types": {"FF": {"stuff_plus", "pct",
   "n", "base", "c": {group: pts}}, ...}}}

USAGE (on the droplet; nothing here writes into the live site)
  python3 build_stuff_waterfall.py --season 2026 --out ./private_out
  python3 build_stuff_waterfall.py --season 2026 --api /var/www/pitch-plus-api \\
      --parquet /var/www/pasttheeyetest.com/pitch_xrv_2026.parquet
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

MIN_N = 30          # same per-pitch-type minimum as the /leaderboard
CLAMP = 4.0         # score_pitches._per_type_plus clamps z to ±4

# Display groups, in a fixed order. Features the model has that aren't listed get
# their own bar, so a retrained model never silently drops a trait.
GROUPS = [
    ("velo",      "Velocity",           ["release_speed"]),
    ("ivb",       "Vertical break",     ["pfx_z"]),
    ("hb",        "Horizontal break",   ["pfx_x"]),
    ("spin",      "Spin rate",          ["release_spin_rate"]),
    ("axis",      "Spin axis",          ["spin_axis_sin", "spin_axis_cos"]),
    ("spin_eff",  "Spin efficiency",    ["spin_efficiency"]),
    ("ext",       "Extension",          ["release_extension"]),
    ("rel_z",     "Release height",     ["release_pos_z"]),
    ("rel_x",     "Release side",       ["release_pos_x"]),
    ("arm",       "Arm angle",          ["arm_angle"]),
    ("ride_slot", "Ride vs. slot",      ["pfx_z_dev_from_slot"]),
    ("run_slot",  "Run vs. slot",       ["pfx_x_dev_from_slot"]),
    ("drag",      "Velocity decay",     ["ay_residual"]),
    ("fb_velo",   "Fastball velo",      ["fb_velo"]),
    ("gap",       "Velo gap to FB",     ["delta_velo"]),
]


def log(*a):
    print(*a, flush=True)


def plus_from_stuff(s, norm_pt, rescale):
    """Mean xRV_stuff for one pitcher × type → Stuff+, exactly as score_pitches does
    (it stores the mean ×100 rounded to 3 decimals before grading)."""
    s = round(s * 100, 3) / 100
    z = max(-CLAMP, min(CLAMP, (s - norm_pt["stuff_mean"]) / norm_pt["stuff_std"]))
    raw = round(100 - 10 * z, 1)
    return round(100.0 + (raw - rescale["mean"]) / rescale["stdev"] * 10.0, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--api", default="/var/www/pitch-plus-api",
                    help="pitch-plus-api checkout (models/, score_pitches.py, season/)")
    ap.add_argument("--parquet", default=None,
                    help="default: /var/www/pasttheeyetest.com/pitch_xrv_{season}.parquet")
    ap.add_argument("--grades", default=None,
                    help="published grades; default: {api}/season/pitcher_pitch_type_grades_{season}.json")
    ap.add_argument("--out", default="./private_out")
    args = ap.parse_args()

    api = Path(args.api).resolve()
    parquet = Path(args.parquet or f"/var/www/pasttheeyetest.com/pitch_xrv_{args.season}.parquet")
    grades_path = Path(args.grades or api / "season" / f"pitcher_pitch_type_grades_{args.season}.json")
    out_dir = Path(args.out)

    # Production feature code + model loader (score_pitches resolves models/ relative to itself)
    sys.path.insert(0, str(api))
    import score_pitches as sp  # noqa: E402

    model_dir = api / "models"
    with open(model_dir / "stuff_model_metadata.json") as f:
        meta = json.load(f)
    import lightgbm as lgb
    sub = meta["sub_models"]
    models = {k: lgb.Booster(model_file=str(model_dir / sub[k]["file"])) for k in sub}
    feats = {k: sub[k]["features"] for k in sub}
    fam = meta["family_definition"]
    norms = json.load(open(model_dir / "pitch_plus_norm.json"))
    rescale = norms["_stuff_plus_rescale"]
    log(f"Stuff sub-models: " + ", ".join(f"{k}({len(v)}f)" for k, v in feats.items()))
    log(f"Stuff+ rescale: mean={rescale['mean']:.3f} stdev={rescale['stdev']:.3f}")

    groups = [g for g in GROUPS]
    known = {f for _k, _l, fs in groups for f in fs}
    for f in sorted({f for fs in feats.values() for f in fs} - known):
        groups.append((f, f.replace("_", " ").capitalize(), [f]))
    gidx = {f: i for i, (_k, _l, fs) in enumerate(groups) for f in fs}

    # ── Load + prepare exactly like score_pitches.main / score_dataframe ──
    log(f"Loading {parquet} …")
    df = pd.read_parquet(parquet)
    df = df.drop_duplicates(subset=["game_pk", "at_bat_number", "pitch_number"], keep="first").reset_index(drop=True)
    df = sp._to_float64(df)
    orig_pt = df["pitch_type"].copy()
    df["pitch_type"] = df["pitch_type"].replace(sp.PITCH_TYPE_REMAP)
    log(f"  {len(df):,} pitches; engineering Stuff features …")
    df = sp.engineer_stuff_features(df)

    fb_mask = (
        df["fb_velo"].notna() & (np.abs(df["release_speed"] - df["fb_velo"]) <= fam["mph_threshold"])
    ) | (df["fb_velo"].isna() & df["pitch_type"].isin(set(fam["fastball_types"])))
    same = df["p_throws"] == df["stand"]

    G = np.zeros((len(df), len(groups)))
    xrv = np.zeros(len(df), dtype=np.float32)
    max_gap = 0.0
    for key, model in models.items():
        m = ((fb_mask if key.startswith("FB") else ~fb_mask) & (same if key.endswith("same") else ~same)).values
        if not m.any():
            continue
        X = df.loc[m, feats[key]]
        C = model.predict(X, pred_contrib=True)             # n × (features + bias), exact TreeSHAP
        pred = model.predict(X)
        max_gap = max(max_gap, float(np.max(np.abs(C.sum(1) - pred))))
        xrv[m] = pred.astype("float32")                     # production stores float32
        rows = np.where(m)[0]
        for j, f in enumerate(feats[key]):
            G[rows, gidx[f]] += C[:, j]
        log(f"  {key}: {int(m.sum()):,} pitches")
    log(f"  contributions sum to the prediction (max gap {max_gap:.2e})")

    # ── Per pitcher × (displayed) pitch type ──
    gcols = [k for k, _l, _f in groups]
    agg = pd.DataFrame(G, columns=gcols)
    agg["xrv"] = xrv.astype("float64")
    agg["pitcher"] = df["pitcher"].astype(int).values
    agg["pitch_type"] = orig_pt.values
    grp = agg.groupby(["pitcher", "pitch_type"])
    per = grp[gcols + ["xrv"]].mean()
    per["n"] = grp.size()
    per = per[per["n"] >= MIN_N].reset_index()

    published = {}
    if grades_path.exists():
        published = json.load(open(grades_path))
        log(f"Published grades: {grades_path}")
    else:
        log(f"⚠ {grades_path} not found — totals use this script's own Stuff+ (should match after the daily run)")

    names = {}
    if "player_name" in df.columns:
        names = (df.dropna(subset=["player_name"]).drop_duplicates("pitcher")
                   .set_index("pitcher")["player_name"].to_dict())

    out = {"meta": {"season": args.season, "model": meta.get("config", ""),
                    "groups": [{"key": k, "label": l, "features": fs} for k, l, fs in groups],
                    "min_n": MIN_N,
                    "method": "LightGBM TreeSHAP contributions vs the average qualified pitch of the same type"}}
    worst, clamped, rows_out = 0.0, 0, 0
    for pt, d in per.groupby("pitch_type"):
        npt = norms.get(sp.PITCH_TYPE_REMAP.get(pt, pt))
        if not npt or npt.get("stuff_std", 0) <= 0:
            log(f"  {pt}: no norms — skipped")
            continue
        slope = -100.0 / (npt["stuff_std"] * rescale["stdev"])      # Stuff+ points per unit xRV
        avg = d[gcols + ["xrv"]].mean()                              # average qualified pitcher's pitch
        base = plus_from_stuff(float(avg["xrv"]), npt, rescale)
        targets = []
        for _, r in d.iterrows():
            pid = str(int(r["pitcher"]))
            pub = (published.get(pid, {}).get(pt) or {}).get("stuff_plus")
            mine = plus_from_stuff(float(r["xrv"]), npt, rescale)
            if pub is not None:
                worst = max(worst, abs(pub - mine))
            targets.append(pub if pub is not None else mine)
        d = d.assign(target=targets)
        pct = d["target"].rank(pct=True) * 100

        for (_, r), p in zip(d.iterrows(), pct):
            pid = str(int(r["pitcher"]))
            target = float(r["target"])
            shift = target - base
            pts = (r[gcols].astype(float) - avg[gcols]) * slope
            z = (float(r["xrv"]) - npt["stuff_mean"]) / npt["stuff_std"]
            clamped += abs(z) > CLAMP
            spread = pts.abs().sum()
            if spread > 1e-9:
                pts = pts + (shift - pts.sum()) * pts.abs() / spread
            c = {g: round(float(pts[g]), 1) for g in gcols}
            resid = round(shift - sum(c.values()), 1)
            if resid:
                big = max(c, key=lambda g: abs(c[g]))
                c[big] = round(c[big] + resid, 1)
            c = {g: v for g, v in c.items() if v != 0.0 or g in ("velo",)}
            entry = out.setdefault(pid, {"name": names.get(int(pid), ""), "n": 0, "types": {}})
            entry["types"][pt] = {"stuff_plus": round(target, 1), "pct": int(round(p)),
                                  "n": int(r["n"]), "base": base, "c": c}
            entry["n"] += int(r["n"])
            rows_out += 1
        log(f"  {pt}: {len(d):3d} pitchers  avg {pt} Stuff+ {base:6.1f}  slope {slope:,.0f} pts/xRV")

    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"stuff_waterfall_{args.season}.json"
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    log(f"\nWrote {path}: {len(out) - 1} pitchers, {rows_out} pitch types")
    if published:
        log(f"Recomputed vs published Stuff+: max difference {worst:.1f} "
            f"({'OK' if worst <= 0.15 else 'MISMATCH — parquet or models differ from the last daily run'})")
    log(f"Pitch types beyond the ±4σ clamp: {clamped} (their residual is folded into the bars)")


if __name__ == "__main__":
    main()
