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
(−100 / (stuff_std[pt] · rescale.stdev) points per unit of xRV, or that season's own
published slope — see below).

The waterfall runs 100 → "Avg {type}" (the league-average pitch of that type) →
one bar per trait → the published Stuff+. The small leftover from the ±4σ clamp and
rounding is spread in proportion to bar size, then bars are rounded to 0.1 with the
remainder folded into the largest, so the bars land exactly on the published value.

Platoon: the same breakdown is built separately vs same-handed hitters (RHP vs RHH,
LHP vs LHH) and vs opposite-handed hitters, each against the league-average pitch of
that type vs that side, and reconciled to the published L/R split grades (≥30 pitches).

Each season was graded with the norms of its own scoring run, so the xRV → Stuff+ map
is read back from that season's published grades: per pitch type, published stuff_plus
is exactly linear in the published mean xRV ("stuff"), and that line gives the season's
slope. The current norm file is used only when it reproduces the season (today's).

Output: {out}/stuff_waterfall_{season}.json
  {"meta": {...}, "<pitcher_id>": {"name", "throws", "n", "types": {"FF": {"stuff_plus",
   "pct", "n", "base", "c": {group: pts}, "same": {...}, "oppo": {...}}, ...}}}

USAGE (on the droplet)
  python3 build_stuff_waterfall.py --season 2026 --out ./public
  python3 build_stuff_waterfall.py --seasons 2023 2024 2025 2026 --out ./public
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


class Grader:
    """xRV_stuff (pitcher × type mean) → Stuff+ for one pitch type, plus its slope."""

    def __init__(self, npt=None, rescale=None, line=None):
        self.npt, self.rescale, self.line = npt, rescale, line
        if line:
            self.slope = line[1] * 100.0                                  # pts per unit xRV
        else:
            self.slope = -100.0 / (npt["stuff_std"] * rescale["stdev"])

    def __call__(self, s):
        if self.line:
            a, b = self.line
            return round(a + b * (round(s * 100, 3)), 1)
        return plus_from_stuff(s, self.npt, self.rescale)


def season_graders(published, norms, stored, remap):
    """Per pitch type graders for this season, the first of these that reproduces the
    published grades from the published xRV:
      1. the current norm file (today's season),
      2. the current per-type norms with this season's own Stuff+ rescale (a season scored
         with today's norms — its rescale is refit to its own population at scoring time),
      3. each pitch type's own published line (a season graded with older per-type norms)."""
    pairs = {}
    for t in published.values():
        if not isinstance(t, dict):
            continue
        for pt, g in t.items():
            if isinstance(g, dict) and g.get("stuff") is not None and g.get("stuff_plus") is not None:
                pairs.setdefault(pt, []).append((g["stuff"], g["stuff_plus"]))

    def npt_of(pt):
        n = norms.get(remap.get(pt, pt))
        return n if n and n.get("stuff_std", 0) > 0 else None

    def err(rescale):
        e = 0.0
        for pt, v in pairs.items():
            if npt_of(pt):
                e = max(e, max(abs(plus_from_stuff(x / 100, npt_of(pt), rescale) - y) for x, y in v))
        return e

    types = set(pairs) | {k for k in norms if not k.startswith("_")}
    stored_err = err(stored)
    if not pairs or stored_err <= 0.15:
        return {pt: Grader(npt_of(pt), stored) for pt in types if npt_of(pt)}, "current norm file", stored_err

    # 2. published = 100 + (raw − mean)/stdev·10, raw = 100 − 10·clip(z) from today's per-type norms
    raw, pub = [], []
    for pt, v in pairs.items():
        if npt_of(pt):
            for x, y in v:
                raw.append(round(100 - 10 * max(-CLAMP, min(CLAMP, (x / 100 - npt_of(pt)["stuff_mean"])
                                                           / npt_of(pt)["stuff_std"])), 1))
                pub.append(y)
    if len(raw) >= 20:
        k, c = np.polyfit(raw, pub, 1)
        if k > 0:
            own = {"stdev": 10.0 / k, "mean": (100.0 - c) / k}
            own_err = err(own)
            if own_err <= 0.15:
                return ({pt: Grader(npt_of(pt), own) for pt in types if npt_of(pt)},
                        f"current per-type norms, season rescale mean={own['mean']:.3f} stdev={own['stdev']:.3f}",
                        own_err)

    graders, worst = {}, 0.0
    for pt in types:
        v = np.array(pairs.get(pt, []), dtype=float)
        if len(v) >= 8:
            b, a = np.polyfit(v[:, 0], v[:, 1], 1)
            keep = np.abs(v[:, 1] - (a + b * v[:, 0])) <= 0.3        # drop ±4σ-clamped pitchers
            if keep.sum() >= 8:
                b, a = np.polyfit(v[keep, 0], v[keep, 1], 1)
            else:
                keep = np.ones(len(v), bool)                           # too few to trim: keep the plain fit
            graders[pt] = Grader(line=(a, b))
            worst = max(worst, float(np.max(np.abs(v[keep, 1] - (a + b * v[keep, 0])))))
        elif npt_of(pt):
            graders[pt] = Grader(npt_of(pt), stored)
    return graders, "per-type published lines (older per-type norms)", worst


def bars(r, avg, gcols, slope, base, target):
    """One pitcher × type (× side): trait bars in Stuff+ points that sum exactly to target − base."""
    shift = target - base
    pts = (r[gcols].astype(float) - avg[gcols]) * slope
    spread = pts.abs().sum()
    if spread > 1e-9:
        pts = pts + (shift - pts.sum()) * pts.abs() / spread
    c = {g: round(float(pts[g]), 1) for g in gcols}
    resid = round(shift - sum(c.values()), 1)
    if resid:
        big = max(c, key=lambda g: abs(c[g]))
        c[big] = round(c[big] + resid, 1)
    return {g: v for g, v in c.items() if v != 0.0 or g == "velo"}


def load_models(api):
    import lightgbm as lgb
    model_dir = api / "models"
    with open(model_dir / "stuff_model_metadata.json") as f:
        meta = json.load(f)
    sub = meta["sub_models"]
    models = {k: lgb.Booster(model_file=str(model_dir / sub[k]["file"])) for k in sub}
    feats = {k: sub[k]["features"] for k in sub}
    norms = json.load(open(model_dir / "pitch_plus_norm.json"))
    return meta, models, feats, norms


def build_season(season, parquet, grades_path, out_dir, sp, meta, models, feats, norms):
    fam = meta["family_definition"]
    stored = norms["_stuff_plus_rescale"]

    groups = [g for g in GROUPS]
    known = {f for _k, _l, fs in groups for f in fs}
    for f in sorted({f for fs in feats.values() for f in fs} - known):
        groups.append((f, f.replace("_", " ").capitalize(), [f]))
    gidx = {f: i for i, (_k, _l, fs) in enumerate(groups) for f in fs}

    # ── Load + prepare exactly like score_pitches.main / score_dataframe ──
    log(f"\n═══ {season} ═══\nLoading {parquet} …")
    df = pd.read_parquet(parquet)
    missing = [c for c in ("pitcher", "pitch_type", "stand", "p_throws", "release_speed", "pfx_x", "pfx_z",
                           "release_spin_rate", "release_pos_x", "release_pos_z", "release_extension")
               if c not in df.columns]
    if missing:
        log(f"✗ {parquet} is missing columns {missing} — {season} skipped")
        return False
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

    # ── Per pitcher × (displayed) pitch type, overall and per batter side ──
    gcols = [k for k, _l, _f in groups]
    agg = pd.DataFrame(G, columns=gcols)
    agg["xrv"] = xrv.astype("float64")
    agg["pitcher"] = df["pitcher"].astype(int).values
    agg["pitch_type"] = orig_pt.values
    agg["stand"] = df["stand"].values
    throws = df.groupby(df["pitcher"].astype(int))["p_throws"].agg(lambda s: s.mode().iat[0]).to_dict()

    grp = agg.groupby(["pitcher", "pitch_type"])
    per = grp[gcols + ["xrv"]].mean()
    per["n"] = grp.size()
    per = per[per["n"] >= MIN_N].reset_index()

    sgrp = agg[agg["stand"].isin(["L", "R"])].groupby(["pitcher", "pitch_type", "stand"])
    per_s = sgrp[gcols + ["xrv"]].mean()
    per_s["n"] = sgrp.size()
    per_s = per_s[per_s["n"] >= MIN_N].reset_index()
    # Same-handed = the pitcher's (majority) hand; the split stays keyed to the published L/R
    per_s["side"] = np.where(per_s["stand"] == per_s["pitcher"].map(throws), "same", "oppo")

    published = {}
    if grades_path.exists():
        published = json.load(open(grades_path))
        log(f"Published grades: {grades_path}")
    else:
        log(f"⚠ {grades_path} not found — totals use this script's own Stuff+ (should match after the daily run)")

    def pub_of(pid, pt, stand=None):
        g = published.get(pid, {}).get(pt) or {}
        if stand:
            g = g.get(stand) or {}
        return g.get("stuff_plus")

    def npt_of(pt):
        n = norms.get(sp.PITCH_TYPE_REMAP.get(pt, pt))
        return n if n and n.get("stuff_std", 0) > 0 else None

    graders, mode, scale_err = season_graders(published, norms, stored, sp.PITCH_TYPE_REMAP)
    log(f"Stuff+ scale: {mode} (reproduces published grades within {scale_err:.1f})")

    # Does today's model reproduce the xRV this season was published with?
    xgap = []
    for _, r in per.iterrows():
        g = (published.get(str(int(r["pitcher"])), {}).get(r["pitch_type"]) or {})
        gr = graders.get(r["pitch_type"])
        if g.get("stuff") is not None and gr:
            xgap.append(abs(round(float(r["xrv"]) * 100, 3) - g["stuff"]) * abs(gr.slope) / 100)
    if xgap:
        q = np.percentile(xgap, [50, 95, 100])
        log(f"Model vs published xRV, in Stuff+ points: median {q[0]:.1f}, 95th pct {q[1]:.1f}, max {q[2]:.1f}"
            + ("" if q[1] <= 1.0 else "  ⚠ today's model/parquet don't reproduce this season's xRV"))

    names = {}
    if "player_name" in df.columns:
        names = (df.dropna(subset=["player_name"]).drop_duplicates("pitcher")
                   .set_index("pitcher")["player_name"].to_dict())

    out = {"meta": {"season": season, "model": meta.get("config", ""),
                    "groups": [{"key": k, "label": l, "features": fs} for k, l, fs in groups],
                    "min_n": MIN_N, "scale": mode,
                    "method": "LightGBM TreeSHAP contributions vs the average qualified pitch of the same type"}}
    worst = {"overall": 0.0, "same": 0.0, "oppo": 0.0}
    rows_out = side_rows = clamped = 0

    def entry(pid):
        return out.setdefault(pid, {"name": names.get(int(pid), ""), "throws": throws.get(int(pid), ""),
                                    "n": 0, "types": {}})

    def graded(d, grade, stand_col, side):
        """Targets (published where available) + percentile for one pitch type (× side)."""
        targets = []
        for _, r in d.iterrows():
            pid = str(int(r["pitcher"]))
            pub = pub_of(pid, r["pitch_type"], r[stand_col] if stand_col else None)
            mine = grade(float(r["xrv"]))
            if pub is not None:
                worst[side] = max(worst[side], abs(pub - mine))
            targets.append(pub if pub is not None else mine)
        d = d.assign(target=targets)
        return d, d["target"].rank(pct=True) * 100

    for pt, d in per.groupby("pitch_type"):
        npt = npt_of(pt)
        grade = graders.get(pt) or (Grader(npt, stored) if npt else None)
        if not grade:
            log(f"  {pt}: no norms — skipped")
            continue
        slope = grade.slope                                          # Stuff+ points per unit xRV
        avg = d[gcols + ["xrv"]].mean()                              # average qualified pitcher's pitch
        base = grade(float(avg["xrv"]))
        d, pct = graded(d, grade, None, "overall")
        for (_, r), p in zip(d.iterrows(), pct):
            pid = str(int(r["pitcher"]))
            target = float(r["target"])
            if npt:
                clamped += abs((float(r["xrv"]) - npt["stuff_mean"]) / npt["stuff_std"]) > CLAMP
            e = entry(pid)
            e["types"][pt] = {"stuff_plus": round(target, 1), "pct": int(round(p)),
                              "n": int(r["n"]), "base": base, "c": bars(r, avg, gcols, slope, base, target)}
            e["n"] += int(r["n"])
            rows_out += 1
        bases = {}
        for side in ("same", "oppo"):
            ds = per_s[(per_s["pitch_type"] == pt) & (per_s["side"] == side)]
            if ds.empty:
                continue
            savg = ds[gcols + ["xrv"]].mean()                        # avg qualified pitch of this type vs this side
            sbase = bases[side] = grade(float(savg["xrv"]))
            ds, spct = graded(ds, grade, "stand", side)
            for (_, r), p in zip(ds.iterrows(), spct):
                t = (out.get(str(int(r["pitcher"]))) or {}).get("types", {}).get(pt)
                if t is None:
                    continue
                target = float(r["target"])
                t[side] = {"stuff_plus": round(target, 1), "pct": int(round(p)), "n": int(r["n"]),
                           "base": sbase, "c": bars(r, savg, gcols, slope, sbase, target)}
                side_rows += 1
        log(f"  {pt}: {len(d):3d} pitchers  avg {pt} Stuff+ {base:6.1f}"
            f"  (same {bases.get('same', '—')}, oppo {bases.get('oppo', '—')})  slope {slope:,.0f} pts/xRV")

    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"stuff_waterfall_{season}.json"
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    log(f"Wrote {path}: {len(out) - 1} pitchers, {rows_out} pitch types, {side_rows} platoon splits")
    if published:
        for k, v in worst.items():
            log(f"  Recomputed vs published Stuff+ ({k}): max difference {v:.1f} "
                f"({'OK' if v <= 0.3 else 'bars reconciled to published — see the xRV line above'})")
    log(f"  Pitch types beyond the ±4σ clamp: {clamped} (their residual is folded into the bars)")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--seasons", type=int, nargs="+", help="build several seasons in one run")
    ap.add_argument("--api", default="/var/www/pitch-plus-api",
                    help="pitch-plus-api checkout (models/, score_pitches.py, season/)")
    ap.add_argument("--parquet", default=None,
                    help="default: /var/www/pasttheeyetest.com/pitch_xrv_{season}.parquet")
    ap.add_argument("--grades", default=None,
                    help="published grades; default: {api}/season/pitcher_pitch_type_grades_{season}.json")
    ap.add_argument("--out", default="./private_out")
    args = ap.parse_args()
    seasons = args.seasons or [args.season]
    if len(seasons) > 1 and (args.parquet or args.grades):
        ap.error("--parquet / --grades name one season's files; use --season with them")

    api = Path(args.api).resolve()
    sys.path.insert(0, str(api))            # production feature code
    import score_pitches as sp  # noqa: E402
    meta, models, feats, norms = load_models(api)
    log("Stuff sub-models: " + ", ".join(f"{k}({len(v)}f)" for k, v in feats.items()))

    failed = []
    for season in seasons:
        parquet = Path(args.parquet or f"/var/www/pasttheeyetest.com/pitch_xrv_{season}.parquet")
        grades = Path(args.grades or api / "season" / f"pitcher_pitch_type_grades_{season}.json")
        if not parquet.exists():
            log(f"\n✗ {season}: {parquet} not found — skipped "
                f"(fetch it with: fetch_statcast.py --year {season} --out {parquet})")
            failed.append(season)
            continue
        if not build_season(season, parquet, grades, Path(args.out), sp, meta, models, feats, norms):
            failed.append(season)
    if failed:
        log(f"\nNot built: {failed}")
        sys.exit(1)


if __name__ == "__main__":
    main()
