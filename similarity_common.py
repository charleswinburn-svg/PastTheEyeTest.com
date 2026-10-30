#!/usr/bin/env python3
"""
similarity_common.py — Shared pieces of the player-similarity builders
(build_similarity_hitters.py / build_similarity_pitchers.py).

The similarity model (also implemented in src/baseball/similarity.js, which must
stay in step with this file):

  * Unit of comparison is a player-season. Every feature is z-scored within its
    own season (mean/sd over that season's qualified pool, clipped to ±Z_CLIP),
    so a 2024 season and a 2026 season are compared on the same scale.
  * Each component (hitters: swing / contact / whiff / discipline; pitchers:
    arsenal / release / whiff / command / contact) has a distance
        d_c = sqrt( sum_f w_f (z_a,f - z_b,f)^2 / sum_f w_f )
    over the features both players have. A component with fewer than half of
    its features shared is null.
  * Component similarity % = 100 * max(0, 1 - d_c / D_c), where D_c is the
    95th-percentile pairwise d_c in the pool (meta.calib). Overall similarity
    is the weighted mean of the component percentages.
  * The pitcher arsenal component compares pitch type to pitch type, weighted by
    usage, with a fixed penalty (meta.calib.missing_pitch_penalty, in z-units)
    for a pitch only one of the two throws, blended with a pitch-mix term built
    from z-scored family usage shares.

Output JSON (one file per season, written by `write_similarity_json`):
  {season, level, type, generated_at,
   meta: {components: {key: {label, features: [...]}},
          features: {key: {label, weight, fmt, lower_better?}},
          stats: {key: {mean, sd}},
          arsenal_features: {key: {label, weight, fmt}},     # pitchers
          arsenal_stats: {pitch_type: {key: {mean, sd}}},    # pitchers
          calib: {component: D95, missing_pitch_penalty, shape_weight}},
   players: {pid: {name, team, hand, n, v: {key: value}, arsenal: {...}}}}
"""
from __future__ import annotations

import json
import math
import random
from datetime import datetime, timezone

Z_CLIP = 3.0
PAIR_SAMPLE = 200_000
CALIB_PCTILE = 0.95
MISSING_PITCH_PENALTY = 1.5   # z-units: cost of a pitch type the other pitcher lacks
SHAPE_WEIGHT = 0.7            # arsenal = SHAPE_WEIGHT * shapes + (1 - SHAPE_WEIGHT) * mix
MIN_SHARED_FRAC = 0.5         # component needs at least this share of its features on both sides

# ───────────────────────── Hitters ─────────────────────────
# (key, label, component, weight, fmt)
HITTER_FEATURES = [
    # Swing traits
    ("bat_speed",          "Bat speed",            "swing",      1.0, ".1f"),
    ("swing_length",       "Swing length",         "swing",      1.0, ".1f"),
    ("attack_angle",       "Attack angle",         "swing",      1.0, ".1f"),
    ("attack_direction",   "Attack direction",     "swing",      1.0, ".1f"),
    ("swing_path_tilt",    "Swing tilt",           "swing",      1.0, ".1f"),
    ("intercept_x",        "Intercept depth",      "swing",      0.5, ".1f"),
    ("fast_swing_pct",     "Fast swing %",         "swing",      0.5, ".1f"),
    ("iswing_plus",        "iSwing+",              "swing",      1.0, ".0f"),
    ("speed_vs_location",  "Speed vs location",    "swing",      0.5, ".1f"),
    ("aa_adjustment",      "AA adjustability",     "swing",      0.5, ".1f"),
    ("length_for_location","Length for location",  "swing",      0.5, ".1f"),
    ("effort_level",       "Effort level",         "swing",      0.5, ".1f"),
    # Contact quality
    ("contact_xrv",        "Contact xRV/600",      "contact",    1.0, "+.1f"),
    ("xslgcon",            "xSLGcon",              "contact",    1.0, ".3f"),
    ("xwobacon",           "xwOBAcon",             "contact",    1.0, ".3f"),
    ("ev90",               "EV90",                 "contact",    1.0, ".1f"),
    ("avg_ev",             "Avg EV",               "contact",    0.5, ".1f"),
    ("barrel_pct",         "Barrel %",             "contact",    1.0, ".1f"),
    ("blasts_per_contact", "Blasts / contact",     "contact",    0.5, ".1f"),
    ("la_sweetspot",       "LA sweet-spot %",      "contact",    0.5, ".1f"),
    # Whiff
    ("z_contact",          "Z-Contact %",          "whiff",      1.0, ".1f"),
    ("k_pct",              "K %",                  "whiff",      1.0, ".1f"),
    ("whiff_pct",          "Whiff %",              "whiff",      1.0, ".1f"),
    ("whiff_xrv",          "Whiff xRV/600",        "whiff",      1.0, "+.1f"),
    # Discipline
    ("chase_pct",          "Chase %",              "discipline", 1.0, ".1f"),
    ("chase_xrv",          "Chase-zone xRV/600",   "discipline", 1.0, "+.1f"),
    ("bb_pct",             "BB %",                 "discipline", 1.0, ".1f"),
    ("decision_xrv",       "Decision xRV/600",     "discipline", 1.0, "+.1f"),
]
HITTER_COMPONENTS = {
    "swing":      "Swing traits",
    "contact":    "Contact quality",
    "whiff":      "Whiff",
    "discipline": "Discipline",
}

# ───────────────────────── Pitchers ─────────────────────────
PITCHER_FEATURES = [
    # Arsenal — pitch-mix shares (the per-pitch-type shapes live in `arsenal`)
    ("mix_FF",             "Four-seam %",          "arsenal",    1.0, ".0f"),
    ("mix_SI",             "Sinker %",             "arsenal",    1.0, ".0f"),
    ("mix_FC",             "Cutter %",             "arsenal",    1.0, ".0f"),
    ("mix_SL",             "Slider/sweeper %",     "arsenal",    1.0, ".0f"),
    ("mix_CU",             "Curveball %",          "arsenal",    1.0, ".0f"),
    ("mix_CH",             "Changeup/splitter %",  "arsenal",    1.0, ".0f"),
    # Release traits
    ("arm_angle",          "Arm angle",            "release",    1.0, ".0f"),
    ("release_x",          "Release side (arm)",   "release",    1.0, ".2f"),
    ("release_z",          "Release height",       "release",    1.0, ".2f"),
    ("extension",          "Extension",            "release",    1.0, ".2f"),
    ("fb_vaa",             "FB VAA",               "release",    1.0, ".1f"),
    ("fb_haa",             "FB HAA (arm)",         "release",    1.0, ".1f"),
    # Whiff / stuff
    ("stuff_plus",         "Stuff+",               "whiff",      1.0, ".0f"),
    ("k_pct",              "K %",                  "whiff",      1.0, ".1f"),
    ("whiff_pct",          "Whiff %",              "whiff",      1.0, ".1f"),
    ("chase_pct",          "Chase %",              "whiff",      0.5, ".1f"),
    ("csw_pct",            "CSW %",                "whiff",      0.5, ".1f"),
    # Command
    ("loc_plus",           "Location+",            "command",    1.0, ".0f"),
    ("bb_pct",             "BB %",                 "command",    1.0, ".1f"),
    ("zone_pct",           "Zone %",               "command",    1.0, ".1f"),
    ("fstrike_pct",        "First-pitch strike %", "command",    0.5, ".1f"),
    # Contact quality allowed
    ("xwobacon_allowed",   "xwOBAcon allowed",     "contact",    1.0, ".3f"),
    ("xslgcon_allowed",    "xSLGcon allowed",      "contact",    1.0, ".3f"),
    ("avg_ev_allowed",     "Avg EV allowed",       "contact",    1.0, ".1f"),
    ("barrel_pct",         "Barrel %",             "contact",    1.0, ".1f"),
    ("hard_hit_pct",       "Hard-hit %",           "contact",    0.5, ".1f"),
    ("gb_pct",             "GB %",                 "contact",    1.0, ".1f"),
]
PITCHER_COMPONENTS = {
    "arsenal":  "Arsenal",
    "release":  "Release",
    "whiff":    "Whiff / stuff",
    "command":  "Command",
    "contact":  "Contact allowed",
}
# Per-pitch-type shape features, z-scored per (season, pitch type).
ARSENAL_FEATURES = [
    ("velo",         "Velo",         1.0, ".1f"),
    ("ivb",          "IVB",          1.0, ".1f"),
    ("hb",           "HB (arm-side)",1.0, ".1f"),
    ("spin",         "Spin",         0.75, ".0f"),
    ("axis_sin",     "Axis (sin)",   0.5, ".2f"),
    ("axis_cos",     "Axis (cos)",   0.5, ".2f"),
    ("velo_minus_fb","Velo − FB",    0.75, ".1f"),
    ("extension",    "Extension",    0.25, ".2f"),
    # Per-type release point (arm-side x, height) — drawn on the release
    # diagram only; weight 0 keeps them out of the distance (the pitcher-level
    # release_x / release_z already cover it).
    ("rel_x",        "Release side", 0.0, ".2f"),
    ("rel_z",        "Release height", 0.0, ".2f"),
]
# Pitch-type aliases for matching (same aliasing the scoring models use).
PITCH_ALIAS = {"KC": "CU", "CS": "CU", "FO": "FS"}
# Pitch families for the mix term.
PITCH_FAMILY = {
    "FF": "FF", "SI": "SI", "FC": "FC",
    "SL": "SL", "ST": "SL", "SV": "SL",
    "CU": "CU", "KC": "CU", "CS": "CU",
    "CH": "CH", "FS": "CH", "FO": "CH", "SC": "CH",
}
MIX_FAMILIES = ["FF", "SI", "FC", "SL", "CU", "CH"]


# ───────────────────────── helpers ─────────────────────────
def is_num(v) -> bool:
    return v is not None and isinstance(v, (int, float)) and math.isfinite(v)


def feature_meta(features):
    return {k: {"label": lab, "component": comp, "weight": w, "fmt": fmt}
            for k, lab, comp, w, fmt in features}


def component_meta(components, features):
    out = {}
    for ckey, clabel in components.items():
        out[ckey] = {"label": clabel,
                     "features": [k for k, _, comp, _, _ in features if comp == ckey]}
    return out


def compute_stats(values_by_player: dict, keys) -> dict:
    """values_by_player: {pid: {key: value}} → {key: {mean, sd}} over finite values.
    sd falls back to 1.0 when the feature is constant or has <3 values (the
    feature then contributes a zero z-difference rather than a NaN)."""
    stats = {}
    for k in keys:
        xs = [p[k] for p in values_by_player.values() if is_num(p.get(k))]
        if len(xs) < 3:
            continue
        mean = sum(xs) / len(xs)
        var = sum((x - mean) ** 2 for x in xs) / max(1, len(xs) - 1)
        sd = math.sqrt(var)
        stats[k] = {"mean": round(mean, 6), "sd": round(sd, 6) if sd > 1e-9 else 1.0}
    return stats


def zscore(v, st) -> float | None:
    if st is None or not is_num(v):
        return None
    z = (v - st["mean"]) / st["sd"]
    return max(-Z_CLIP, min(Z_CLIP, z))


def z_vector(values: dict, stats: dict, keys) -> dict:
    return {k: zscore(values.get(k), stats.get(k)) for k in keys}


def component_distance(za: dict, zb: dict, keys, weights: dict) -> float | None:
    """Weighted RMS z-difference over the features present on both sides.
    None when fewer than MIN_SHARED_FRAC of `keys` are shared."""
    num = 0.0
    den = 0.0
    shared = 0
    for k in keys:
        a, b = za.get(k), zb.get(k)
        if a is None or b is None:
            continue
        w = weights.get(k, 1.0)
        num += w * (a - b) ** 2
        den += w
        shared += 1
    if not keys or shared < max(1, math.ceil(MIN_SHARED_FRAC * len(keys))) or den <= 0:
        return None
    return math.sqrt(num / den)


def arsenal_shape_distance(ars_a: dict, ars_b: dict, arsenal_stats: dict,
                           weights: dict, penalty: float) -> float | None:
    """Usage-weighted mean over the union of pitch types: shared → RMS z-diff of
    the shape features; thrown by one side only → `penalty`. ars_*: {pt: {usage, velo, ...}}"""
    types = set(ars_a) | set(ars_b)
    if not types:
        return None
    num = den = 0.0
    keys = [k for k in weights]
    for pt in types:
        a, b = ars_a.get(pt), ars_b.get(pt)
        ua = a.get("usage", 0.0) if a else 0.0
        ub = b.get("usage", 0.0) if b else 0.0
        w = (ua + ub) / 2.0
        if w <= 0:
            continue
        if a and b:
            st = arsenal_stats.get(pt, {})
            za = {k: zscore(a.get(k), st.get(k)) for k in keys}
            zb = {k: zscore(b.get(k), st.get(k)) for k in keys}
            d = component_distance(za, zb, keys, weights)
            if d is None:
                d = penalty
        else:
            d = penalty
        num += w * d
        den += w
    return num / den if den > 0 else None


def pairwise_calibration(players: dict, meta: dict, kind: str,
                         n_pairs: int = PAIR_SAMPLE, seed: int = 0) -> dict:
    """D_c = CALIB_PCTILE quantile of pairwise component distances over a random
    sample of player pairs within this season's pool."""
    rng = random.Random(seed)
    pids = list(players)
    comps = meta["components"]
    fweights = {k: f["weight"] for k, f in meta["features"].items()}
    stats = meta["stats"]
    keys_all = list(meta["features"])
    zs = {pid: z_vector(players[pid]["v"], stats, keys_all) for pid in pids}
    aw = {k: f["weight"] for k, f in meta.get("arsenal_features", {}).items()}
    dists = {c: [] for c in comps}
    if len(pids) < 2:
        return {c: 1.0 for c in comps}
    n_pairs = min(n_pairs, len(pids) * (len(pids) - 1) // 2)
    for _ in range(n_pairs):
        a, b = rng.sample(pids, 2)
        for c, cm in comps.items():
            if kind == "pitcher" and c == "arsenal":
                d = arsenal_distance(players[a], players[b], zs[a], zs[b], meta,
                                     aw, fweights, calib=None)
            else:
                d = component_distance(zs[a], zs[b], cm["features"], fweights)
            if d is not None:
                dists[c].append(d)
    out = {}
    for c, ds in dists.items():
        if not ds:
            out[c] = 1.0
            continue
        ds.sort()
        idx = min(len(ds) - 1, int(CALIB_PCTILE * len(ds)))
        out[c] = round(ds[idx], 4)
    return out


def arsenal_distance(pa: dict, pb: dict, za: dict, zb: dict, meta: dict,
                     arsenal_weights: dict, fweights: dict, calib: dict | None) -> float | None:
    """Blend of per-pitch-type shape distance and the z-scored pitch-mix distance."""
    penalty = (calib or {}).get("missing_pitch_penalty", MISSING_PITCH_PENALTY)
    shape_w = (calib or {}).get("shape_weight", SHAPE_WEIGHT)
    d_shape = arsenal_shape_distance(pa.get("arsenal", {}), pb.get("arsenal", {}),
                                     meta.get("arsenal_stats", {}), arsenal_weights, penalty)
    mix_keys = meta["components"]["arsenal"]["features"]
    d_mix = component_distance(za, zb, mix_keys, fweights)
    if d_shape is None and d_mix is None:
        return None
    if d_shape is None:
        return d_mix
    if d_mix is None:
        return d_shape
    return shape_w * d_shape + (1 - shape_w) * d_mix


def clean_value(v, nd=4):
    if not is_num(v):
        return None
    return round(float(v), nd)


def pack_players(players: dict, meta: dict) -> dict:
    """Compact on-disk form: `v` becomes an array in meta.feature_keys order and
    each arsenal entry an array in ["usage"] + meta.arsenal_keys order (the
    repeated key strings are most of the file otherwise)."""
    fkeys = meta["feature_keys"]
    akeys = meta.get("arsenal_keys", [])
    packed = {}
    for pid, p in players.items():
        q = {k: val for k, val in p.items() if k not in ("v", "arsenal")}
        q["v"] = [p["v"].get(k) for k in fkeys]
        if "arsenal" in p:
            q["arsenal"] = {pt: [a.get("usage")] + [a.get(k) for k in akeys]
                            for pt, a in p["arsenal"].items()}
        packed[pid] = q
    return packed


def write_similarity_json(path, *, season, kind, players: dict, meta: dict, level="MLB"):
    meta = dict(meta)
    meta["feature_keys"] = list(meta["features"])
    if "arsenal_features" in meta:
        meta["arsenal_keys"] = list(meta["arsenal_features"])
    out = {
        "season": season,
        "level": level,
        "type": kind,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "meta": meta,
        "players": pack_players(players, meta),
    }
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"), allow_nan=False)
    return out
