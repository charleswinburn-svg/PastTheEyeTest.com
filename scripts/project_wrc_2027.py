# %% [markdown]
# # 2027 wRC+ projections from xRV/600 (Orioles)
#
# Run in Google Colab:
#   1. Upload your FanGraphs cookies.txt (Netscape format) to the Colab files pane.
#   2. Set COOKIES_PATH below, then Runtime > Run all.
#
# Model
#   Stage 1 (conversion): PA-weighted  wRC+ = a + b * xRV/600  on 2023-26.
#       A player's "residual" in a season is wRC+ minus that conversion
#       (what xRV misses: park, speed, BABIP skill).
#   Stage 2 (ridge, fit by leave-one-season-out CV on 2024-26 outcomes):
#       features are the projection as a z-score on the full leaderboard,
#       plus lagged wRC+ and/or lagged residuals (each shrunk by PA). In
#       training, the projection is a stand-in built from each player's
#       prior two seasons of xRV/600. CV picks the feature set, ridge
#       penalty and shrinkage amounts; the held-out folds use a conversion
#       fit without the held-out season, so nothing leaks.
#   Range: built from the out-of-sample CV residuals. Their variance is
#       modeled as  s2 + c / PA  (forecast error + single-season noise),
#       and the quantiles of the standardized residuals give p10-p90, using
#       each player's expected 2027 PA.

# %%
import http.cookiejar
import json
import time
import unicodedata

import numpy as np
import pandas as pd
import requests

COOKIES_PATH = "cookies.txt"       # your FanGraphs cookies export (optional)
REPO_RAW = "https://raw.githubusercontent.com/charleswinburn-svg/PastTheEyeTest.com/main/public"
SEASONS = [2023, 2024, 2025, 2026]
MIN_PA = 100                       # min PA for a season to enter the fits
TEAM = "BAL"
OUT_CSV = "orioles_wrc_proj_2027.csv"
OUT_JSON = "wrc_proj_2027.json"


# %% Session with FanGraphs cookies only
def make_session(path):
    s = requests.Session()
    s.headers["User-Agent"] = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                               "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36")
    try:
        jar = http.cookiejar.MozillaCookieJar(path)
        jar.load(ignore_discard=True, ignore_expires=True)
        n = 0
        for c in jar:                      # keep FanGraphs cookies, drop the rest
            if "fangraphs.com" in c.domain:
                s.cookies.set_cookie(c)
                n += 1
        print(f"Loaded {n} FanGraphs cookies")
    except FileNotFoundError:
        print("No cookies file found; trying without (the leaderboard API is usually public)")
    return s


session = make_session(COOKIES_PATH)


# %% Pull wRC+ from the FanGraphs leaderboard API
FG_URL = "https://www.fangraphs.com/api/leaders/major-league/data"


def fetch_wrc(season):
    params = dict(age="", pos="all", stats="bat", lg="all", qual=0,
                  season=season, season1=season, startdate="", enddate="",
                  month=0, hand="", team=0, pageitems=2000000000, pagenum=1,
                  ind=0, rost=0, players="", type=8, postseason="",
                  sortdir="default", sortstat="WAR")
    r = session.get(FG_URL, params=params, timeout=60)
    r.raise_for_status()
    rows = r.json()["data"]
    df = pd.DataFrame(rows)
    name_col = "PlayerName" if "PlayerName" in df else "Name"
    out = pd.DataFrame({
        "mlbam": pd.to_numeric(df.get("xMLBAMID"), errors="coerce"),
        "name": df[name_col],
        "fg_pa": pd.to_numeric(df["PA"], errors="coerce"),
        "wrc_plus": pd.to_numeric(df["wRC+"], errors="coerce"),
    })
    out["season"] = season
    return out


fg = []
for y in SEASONS:
    d = fetch_wrc(y)
    print(y, len(d), "hitters,", d["mlbam"].notna().sum(), "with MLBAM IDs")
    fg.append(d)
    time.sleep(1.5)
fg = pd.concat(fg, ignore_index=True)


# %% Load xRV/600 (actual 2023-26, projected 2027) from your repo
def get_json(name):
    r = requests.get(f"{REPO_RAW}/{name}", timeout=60)
    r.raise_for_status()
    return r.json()


xrv_rows = []
for y in SEASONS:
    for pid, v in get_json(f"hitter_xrv_{y}.json").items():
        m = v.get("metrics", {}).get("xRV/600")
        if m and m.get("value") is not None:
            xrv_rows.append({"mlbam": int(pid), "season": y,
                             "xrv_pa": v.get("pa") or 0, "xrv": m["value"]})
xrv = pd.DataFrame(xrv_rows)

proj_rows = []
for pid, v in get_json("hitter_xrv_2027P.json").items():
    m = v.get("metrics", {}).get("xRV/600")
    if not m:
        continue
    ci = m.get("ci") or {}
    proj_rows.append({"mlbam": int(pid),
                      "xrv27_p50": ci.get("p50", m["value"]),
                      "xrv27_p25": ci.get("p25"), "xrv27_p75": ci.get("p75")})
proj = pd.DataFrame(proj_rows)

bd = get_json("baseball_data_2027P.json")
roster = pd.DataFrame([{"mlbam": h["player_id"], "name": h["name"], "team": h.get("team")}
                       for h in bd["hitters"]])


# %% Join; fall back to name matching where FanGraphs lacks an MLBAM ID
def norm(s):
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode()
    return "".join(ch for ch in s.lower() if ch.isalnum())


name_to_id = {norm(n): i for n, i in zip(roster["name"], roster["mlbam"])}
fg["mlbam"] = fg["mlbam"].astype(float)
miss = fg["mlbam"].isna()
if miss.any():
    fg.loc[miss, "mlbam"] = fg.loc[miss, "name"].map(lambda n: name_to_id.get(norm(n))).astype(float)
fg = fg.dropna(subset=["mlbam", "wrc_plus"])
fg["mlbam"] = fg["mlbam"].astype(int)
# Players traded midseason appear once (season total) with type=8 / ind=0.
fg = fg.sort_values("fg_pa", ascending=False).drop_duplicates(["mlbam", "season"])

hist = fg.merge(xrv, on=["mlbam", "season"], how="inner")
hist["pa"] = hist["fg_pa"]
fit = hist[hist["pa"] >= MIN_PA].copy()
print(f"{len(fit)} player-seasons with >= {MIN_PA} PA for the fit")


# %% Stage 1: conversion xRV/600 -> wRC+ (weighted least squares)
def wls(x, y, w):
    X = np.column_stack([np.ones_like(x), x])
    W = np.sqrt(w)
    coef, *_ = np.linalg.lstsq(X * W[:, None], y * W, rcond=None)
    pred = X @ coef
    r2 = 1 - np.sum(w * (y - pred) ** 2) / np.sum(w * (y - np.average(y, weights=w)) ** 2)
    rmse = np.sqrt(np.average((y - pred) ** 2, weights=w))
    return coef, r2, rmse


(a, b), r2, rmse = wls(fit["xrv"].values, fit["wrc_plus"].values, fit["pa"].values)
print(f"Conversion: wRC+ = {a:.1f} + {b:.3f} * xRV/600   (R² {r2:.3f}, RMSE {rmse:.1f})")
for y in SEASONS:
    s = fit[fit.season == y]
    (ay, by), r2y, _ = wls(s["xrv"].values, s["wrc_plus"].values, s["pa"].values)
    print(f"  {y}: {ay:.1f} + {by:.3f}x  R² {r2y:.3f}  n={len(s)}")

hist["resid"] = hist["wrc_plus"] - (a + b * hist["xrv"])
R = hist.pivot_table(index="mlbam", columns="season", values="resid")
P = hist.pivot_table(index="mlbam", columns="season", values="pa").fillna(0)


# %% Stage 2: ridge regression, fit by out-of-sample CV
xpa = xrv.pivot_table(index="mlbam", columns="season", values="xrv_pa").fillna(0)
xv = xrv.pivot_table(index="mlbam", columns="season", values="xrv")
wv = hist.pivot_table(index="mlbam", columns="season", values="wrc_plus")
wp = hist.pivot_table(index="mlbam", columns="season", values="pa").fillna(0)
IDS = xv.index.union(wv.index).union(pd.Index(proj["mlbam"]))
LG_XRV = float(np.average(xrv["xrv"], weights=xrv["xrv_pa"].clip(lower=1)))
LG_WRC = float(np.average(hist["wrc_plus"], weights=hist["pa"].clip(lower=1)))
TARGETS = [2024, 2025, 2026]


def col(df, y, fill=None):
    """Season column y of a pivot, aligned to IDS; missing -> NaN or fill."""
    s = (df[y] if y in df.columns else pd.Series(dtype=float)).reindex(IDS).astype(float)
    return s if fill is None else s.fillna(fill)


def shrunk(val, pa, mean, k):
    pa = pa.where(val.notna(), 0)
    return mean + (val.fillna(mean) - mean) * pa / (pa + k)


def wstats(v, w):
    m = np.average(v, weights=w)
    return m, np.sqrt(np.average((v - m) ** 2, weights=w))


def rmse(e, w):
    return float(np.sqrt(np.average(np.asarray(e) ** 2, weights=w)))


# ---- Stand-in projection (history only): recency-weighted, regressed xRV/600
def proxy_proj(t, w2, kx):
    x1, p1 = col(xv, t - 1), col(xpa, t - 1, 0.0)
    x2, p2 = col(xv, t - 2), col(xpa, t - 2, 0.0)
    p1 = p1.where(x1.notna(), 0)
    p2 = p2.where(x2.notna(), 0) * w2
    den = p1 + p2
    avg = (x1.fillna(0) * p1 + x2.fillna(0) * p2) / den.replace(0, np.nan)
    return LG_XRV + (avg - LG_XRV) * den / (den + kx)


best = None
for w2 in np.arange(0.2, 1.01, 0.1):
    for kx in [100, 200, 300, 400, 600, 800, 1200, 1600]:
        e, ww = [], []
        for t in TARGETS:
            pr = proxy_proj(t, w2, kx)
            ok = pr.notna() & (col(xpa, t, 0.0) >= 200) & col(xv, t).notna()
            e.append((col(xv, t)[ok] - pr[ok]).values)
            ww.append(col(xpa, t, 0.0)[ok].values)
        m = rmse(np.concatenate(e), np.concatenate(ww))
        if best is None or m < best[0]:
            best = (m, w2, kx)
_, W2, KX = best
print(f"Stand-in projection: prior-season weight {W2:.1f}, regression {KX} PA")


def zscore(values, weights):
    m, sd = wstats(values, weights)
    return (values - m) / sd, sd


# Projection z-scores on each season's full leaderboard (weights = prior 2 seasons' PA)
Z, RAW = {}, {}
for t in TARGETS:
    pr = proxy_proj(t, W2, KX)
    pool = pr.notna()
    w = (col(xpa, t - 1, 0.0) + col(xpa, t - 2, 0.0)).clip(lower=50)
    z = pd.Series(np.nan, index=IDS)
    z[pool], _ = zscore(pr[pool], w[pool])
    Z[t], RAW[t] = z, pr

proj["w"] = proj["mlbam"].map(col(xpa, 2025, 0.0) + col(xpa, 2026, 0.0)).fillna(0).clip(lower=50)
Z[2027] = pd.Series(np.nan, index=IDS)
zz, SD_PROJ = zscore(proj["xrv27_p50"].values, proj["w"].values)
Z[2027][proj["mlbam"].values] = zz


# ---- Conversion fit excluding a season (so held-out folds don't leak)
def conversion(exclude=None):
    f = fit if exclude is None else fit[fit.season != exclude]
    (a_, b_), _, _ = wls(f["xrv"].values, f["wrc_plus"].values, f["pa"].values)
    return a_, b_


CONV = {None: (a, b), **{h: conversion(h) for h in TARGETS}}


def resid(y, conv):
    a_, b_ = CONV[conv]
    return col(wv, y) - (a_ + b_ * col(xv, y))


_cache = {}


def feature(name, t, k, conv):
    key = (name, t, k, conv if name.startswith("res") else None)
    if key not in _cache:
        lag = int(name[-1])
        y = t - lag
        if name.startswith("wrc"):
            _cache[key] = shrunk(col(wv, y), col(wp, y, 0.0), LG_WRC, k)
        else:
            _cache[key] = shrunk(resid(y, conv), col(wp, y, 0.0), 0.0, k)
    return _cache[key]


def design(t, feats, kw, kr, conv):
    cols_ = {"proj_z": Z[t]}
    for f in feats[1:]:
        if f == "tail_hi":          # skill layer: extra slope above +TAIL_KNOT SD
            cols_[f] = (Z[t] - TAIL_KNOT).clip(lower=0)
        elif f == "tail_lo":        # ... and below -TAIL_KNOT SD
            cols_[f] = (Z[t] + TAIL_KNOT).clip(upper=0)
        else:
            cols_[f] = feature(f, t, kw if f.startswith("wrc") else kr, conv)
    return pd.DataFrame(cols_)


def ridge_fit(X, y, w, alpha):
    mu = np.average(X, axis=0, weights=w)
    sd = np.sqrt(np.average((X - mu) ** 2, axis=0, weights=w))
    sd[sd == 0] = 1
    Xs = (X - mu) / sd
    ym = np.average(y, weights=w)
    A = Xs.T @ (Xs * w[:, None]) + alpha * w.sum() * np.eye(X.shape[1])
    beta = np.linalg.solve(A, Xs.T @ (w * (y - ym))) / sd
    return ym - mu @ beta, beta


def target_rows(t):
    y, pa = col(wv, t), col(wp, t, 0.0)
    return Z[t].notna() & y.notna() & (pa >= MIN_PA)


ROWS = {t: target_rows(t) for t in TARGETS}


def cv_run(feats, alpha, kw, kr):
    """Leave-one-season-out; returns held-out (season, pa, residual, raw proj)."""
    out_ = []
    for hold in TARGETS:
        Xtr, ytr, wtr = [], [], []
        for t in TARGETS:
            if t == hold:
                continue
            ok = ROWS[t]
            Xtr.append(design(t, feats, kw, kr, hold)[ok].values)
            ytr.append(col(wv, t)[ok].values)
            wtr.append(col(wp, t, 0.0)[ok].values)
        c0, beta = ridge_fit(np.vstack(Xtr), np.concatenate(ytr), np.concatenate(wtr), alpha)
        ok = ROWS[hold]
        Xte = design(hold, feats, kw, kr, hold)[ok].values
        yte, pte = col(wv, hold)[ok].values, col(wp, hold, 0.0)[ok].values
        out_.append(pd.DataFrame({"season": hold, "pa": pte, "e": yte - (c0 + Xte @ beta),
                                  "y": yte, "raw": RAW[hold][ok].values, "z": Z[hold][ok].values}))
    return pd.concat(out_, ignore_index=True)


# Skill layer: tail_hi / tail_lo let the stretch differ for hitters projected
# more than TAIL_KNOT SD above or below average. If the projection clamps the
# extremes harder than the middle, these get positive coefficients.
TAIL_KNOT = 1.0
SKILL = ["tail_hi", "tail_lo"]
FEATURE_SETS = {
    "projection only": ["proj_z"],
    "projection + skill": ["proj_z", *SKILL],
    "projection + wRC+ lags": ["proj_z", "wrc_lag1", "wrc_lag2"],
    "projection + residual lags": ["proj_z", "res_lag1", "res_lag2"],
    "projection + skill + wRC+ lags": ["proj_z", *SKILL, "wrc_lag1", "wrc_lag2"],
    "projection + skill + residual lags": ["proj_z", *SKILL, "res_lag1", "res_lag2"],
}
# wRC+ lags and residual lags are NOT offered together: wRC+ = xRV-implied
# wRC+ + residual, so the pair is nearly collinear and the ridge trades them
# off with wild, sign-flipping coefficients (a great season lowering the
# projection). A richer set must also beat a simpler one by MIN_GAIN held-out
# RMSE on 300+ PA seasons, and every lag coefficient must come out positive.
MIN_GAIN = 0.15
ALPHAS = [0, 0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1.0]
KS = [100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600]

def final_fit(feats, alpha, kw, kr):
    Xa, ya, wa = [], [], []
    for t in TARGETS:
        ok = ROWS[t]
        Xa.append(design(t, feats, kw, kr, None)[ok].values)
        ya.append(col(wv, t)[ok].values)
        wa.append(col(wp, t, 0.0)[ok].values)
    return ridge_fit(np.vstack(Xa), np.concatenate(ya), np.concatenate(wa), alpha)


results = []
for fname, feats in FEATURE_SETS.items():
    use_w = any(f.startswith("wrc") for f in feats)
    use_r = any(f.startswith("res") for f in feats)
    for alpha in ALPHAS:
        for kw in (KS if use_w else [0]):
            for kr in (KS if use_r else [0]):
                r = cv_run(feats, alpha, kw, kr)
                big_ = r.pa >= 300
                results.append((rmse(r.e, r.pa), rmse(r.e[big_], r.pa[big_]), fname, alpha, kw, kr))
res_df = pd.DataFrame(results, columns=["cv_rmse", "cv_rmse_300", "features", "alpha", "kw", "kr"])
best_by_set = res_df.loc[res_df.groupby("features")["cv_rmse"].idxmin()].copy()
best_by_set["n_feats"] = best_by_set.features.map(lambda f: len(FEATURE_SETS[f]))
def lags_positive(feats, beta):
    return bool(all(bb > 0 for f, bb in zip(feats, beta) if f.startswith(("wrc", "res"))))


best_by_set["lag_coefs_positive"] = [
    lags_positive(FEATURE_SETS[r.features],
                  final_fit(FEATURE_SETS[r.features], r.alpha, int(r.kw), int(r.kr))[1])
    for r in best_by_set.itertuples()]
best_by_set = best_by_set.sort_values("n_feats")
print("Best CV fit per feature set (held-out RMSE, PA-weighted):")
print(best_by_set.drop(columns="n_feats").round(3).to_string(index=False))

# Parsimony: start from projection-only; switch only for a clear 300+ PA gain
B = best_by_set.iloc[0]
for r in best_by_set.iloc[1:].itertuples():
    if r.lag_coefs_positive and r.cv_rmse_300 <= B.cv_rmse_300 - MIN_GAIN:
        B = best_by_set.loc[r.Index]
print(f"Chosen: {B.features}")
FEATS, ALPHA, KW, KR = FEATURE_SETS[B.features], float(B.alpha), int(B.kw), int(B.kr)

# ---- Out-of-sample comparison against the simple versions
oos = cv_run(FEATS, ALPHA, KW, KR)
_, sd_act = wstats(xrv["xrv"], xrv["xrv_pa"].clip(lower=1))
ca = np.array([CONV[s_][0] for s_ in oos.season])
cb = np.array([CONV[s_][1] for s_ in oos.season])
oos["e_1to1"] = oos.y - ca - cb * oos.raw
oos["e_full"] = oos.y - ca - cb * (LG_XRV + oos.z * sd_act)
print("Held-out RMSE           all rows   300+ PA")
big = oos.pa >= 300
for label, e in [("1:1 conversion", "e_1to1"), ("full-leaderboard stretch", "e_full"),
                 (f"ridge ({B.features})", "e")]:
    print(f"  {label:34s} {rmse(oos[e], oos.pa):6.1f}   {rmse(oos[e][big], oos.pa[big]):6.1f}")


# %% Clamping check: whole-league, out-of-sample calibration by skill level
# Held-out seasons with 300+ PA, binned by projected skill (projection z).
# If a model clamps too much, actual > predicted at the top and actual <
# predicted at the bottom, and the calibration slope (actual on predicted) > 1.
cal = oos[oos.pa >= 300].copy()
cal["pred_ridge"] = cal.y - cal.e
cal["pred_1to1"] = cal.y - cal.e_1to1
cal["pred_full"] = cal.y - cal.e_full
cal["skill_decile"] = pd.qcut(cal.z, 10, labels=False, duplicates="drop") + 1


def wmean(d, c):
    return np.average(d[c], weights=d.pa)


tbl = pd.DataFrame([{
    "decile": k, "n": len(d), "proj_z": wmean(d, "z"), "actual": wmean(d, "y"),
    "ridge": wmean(d, "pred_ridge"), "1:1": wmean(d, "pred_1to1"), "full": wmean(d, "pred_full")}
    for k, d in cal.groupby("skill_decile")])
print("Out-of-sample calibration by skill decile (300+ PA, PA-weighted means of wRC+):")
print(tbl.round(1).to_string(index=False))
for c in ["ridge", "1:1", "full"]:
    pc = "pred_" + {"ridge": "ridge", "1:1": "1to1", "full": "full"}[c]
    (_, slope), _, _ = wls(cal[pc].values, cal.y.values, cal.pa.values)
    print(f"  calibration slope, {c:5s}: {slope:.2f}  (1.00 = right amount of stretch; "
          f">1 too clamped, <1 too stretched)")

# ---- Final fit on all seasons
C0, BETA = final_fit(FEATS, ALPHA, KW, KR)
print(f"Final model ({B.features}, alpha {ALPHA}, wRC+ shrink {KW}, residual shrink {KR}):")
print("  wRC+ = " + f"{C0:.1f} " + " ".join(f"{bb:+.3f}*{f}" for bb, f in zip(BETA, FEATS)))
BETA_XRV = BETA[0] / SD_PROJ
print(f"  stretch: {BETA_XRV:.2f} wRC+ per projected xRV/600 point (1:1 conversion is {b:.2f})")


# %% Error model from out-of-sample residuals:  var(e) = s2 + c / PA
# Fit on 200+ PA seasons only: 2027 ranges use 200-650 PA, and 100-PA seasons'
# extreme misses would otherwise dominate. Non-negative least squares on PA bins.
from scipy.optimize import nnls

eo = oos[oos.pa >= 200].copy()
eo["bin"] = pd.qcut(eo.pa, 8, labels=False, duplicates="drop")
g = eo.groupby("bin").agg(inv_pa=("pa", lambda x: np.mean(1 / x)),
                          e2=("e", lambda x: np.mean(x ** 2)), n=("e", "size"))
sw = np.sqrt(g.n.values)
(S2, CPA), _ = nnls(np.column_stack([np.ones(len(g)), g.inv_pa]) * sw[:, None], g.e2.values * sw)
print("Held-out RMSE by PA bin: " + ", ".join(
    f"{int(1 / iv)} PA {np.sqrt(e2):.1f}" for iv, e2 in zip(g.inv_pa, g.e2)))


def err_sd(pa):
    return np.sqrt(S2 + CPA / np.asarray(pa, float))


u = eo.e / err_sd(eo.pa)
Q = {q: float(np.quantile(u, q / 100)) for q in [10, 25, 75, 90]}
print(f"Out-of-sample error SD: {err_sd(300):.1f} at 300 PA, {err_sd(600):.1f} at 600 PA "
      f"(forecast-error floor {np.sqrt(S2):.1f})")
print("  standardized-residual quantiles " + ", ".join(f"p{q} {v:+.2f}" for q, v in Q.items()))


# %% 2027 projections
X27 = design(2027, FEATS, KW, KR, None)
out = roster.merge(proj, on="mlbam", how="inner")
ids = out["mlbam"].values
out["proj_z"] = X27.loc[ids, "proj_z"].values
out["wrc27_1to1"] = a + b * out["xrv27_p50"]
out["wrc27_p50"] = C0 + X27.loc[ids].values @ BETA

p25_, p26_ = col(xpa, 2025, 0.0).loc[ids].values, col(xpa, 2026, 0.0).loc[ids].values
played = (p25_ > 0) * 0.5 + (p26_ > 0) * 1.0
exp_pa = np.where(played > 0, (0.5 * p25_ + p26_) / np.where(played > 0, played, 1), 250)
out["exp_pa"] = np.clip(exp_pa, 200, 650)
sd27 = err_sd(out["exp_pa"])
for q, v in Q.items():
    out[f"wrc27_p{q}"] = out["wrc27_p50"] + v * sd27

reg = out[out["w"] >= 300]
print(f"Projected 2027 wRC+ among regulars (300+ PA in 2025-26): "
      f"PA-wtd mean {np.average(reg.wrc27_p50, weights=reg.w):.1f}, SD {wstats(reg.wrc27_p50, reg.w)[1]:.1f}")


# %% Whole-league comparison
# League rank / percentile among regulars, and team totals
out["lg_rank"] = np.nan
out.loc[reg.index, "lg_rank"] = reg["wrc27_p50"].rank(ascending=False, method="min")
out["lg_pctile"] = np.nan
out.loc[reg.index, "lg_pctile"] = 100 * reg["wrc27_p50"].rank(pct=True)
print(f"Regulars ranked: {len(reg)}")

qs = [10, 25, 50, 75, 90]
obs26 = hist[(hist.season == 2026) & (hist.pa >= 300)]
dist = pd.DataFrame({
    "projected 2027 (regulars)": np.percentile(reg.wrc27_p50, qs),
    "1:1 projection (regulars)": np.percentile(reg.wrc27_1to1, qs),
    "actual 2026 (300+ PA)": np.percentile(obs26.wrc_plus, qs),
}, index=[f"p{q}" for q in qs]).T
print("League distribution of wRC+:")
print(dist.round(1).to_string())

print("Top 15 projected 2027 wRC+ (regulars):")
print(reg.sort_values("wrc27_p50", ascending=False)
      [["name", "team", "xrv27_p50", "wrc27_1to1", "wrc27_p50", "wrc27_p10", "wrc27_p90"]]
      .head(15).round(1).to_string(index=False))

teams = (out[out.team.notna()]
         .assign(wx=lambda d: d.wrc27_p50 * d.exp_pa)
         .groupby("team").agg(hitters=("name", "size"), pa=("exp_pa", "sum"), wx=("wx", "sum")))
teams["proj_wrc_plus"] = teams.wx / teams.pa
teams = teams.drop(columns="wx").sort_values("proj_wrc_plus", ascending=False)
teams["rank"] = range(1, len(teams) + 1)
print("Team projected wRC+ (expected-PA-weighted, current rosters):")
print(teams.round(1).to_string())
if TEAM in teams.index:
    print(f"  {TEAM}: {teams.loc[TEAM, 'proj_wrc_plus']:.1f}, rank {teams.loc[TEAM, 'rank']} of {len(teams)}")

wide = hist.pivot_table(index="mlbam", columns="season", values=["wrc_plus", "xrv", "pa"])
for y in [2025, 2026]:
    for c in ["pa", "xrv", "wrc_plus"]:
        out[f"{c}_{y}"] = out["mlbam"].map(wide.get((c, y), pd.Series(dtype=float)))

cols = ["name", "pa_2025", "wrc_plus_2025", "xrv_2025", "pa_2026", "wrc_plus_2026", "xrv_2026",
        "xrv27_p50", "proj_z", "wrc27_1to1", "wrc27_p50", "lg_rank", "lg_pctile", "exp_pa",
        "wrc27_p10", "wrc27_p25", "wrc27_p75", "wrc27_p90"]
bal = out[out["team"] == TEAM][cols].sort_values("wrc27_p50", ascending=False)
pd.set_option("display.width", 250)
print(bal.round(1).to_string(index=False))

bal.round(2).to_csv(OUT_CSV, index=False)
(out[["team"] + cols].sort_values("wrc27_p50", ascending=False)
 .round(2).to_csv("league_wrc_proj_2027.csv", index=False))
meta = {"conversion": {"a": round(a, 3), "b": round(b, 4), "r2": round(r2, 3)},
        "ridge": {"features": FEATS, "intercept": round(float(C0), 3),
                  "coef": {f: round(float(bb), 4) for f, bb in zip(FEATS, BETA)},
                  "alpha": ALPHA, "wrc_shrink_pa": KW, "resid_shrink_pa": KR,
                  "cv_rmse": round(float(B.cv_rmse), 2), "wrc_per_proj_xrv": round(float(BETA_XRV), 3)},
        "error_model": {"s2": round(float(S2), 2), "c": round(float(CPA), 1),
                        "std_quantiles": {f"p{q}": round(v, 3) for q, v in Q.items()}},
        "min_pa": MIN_PA}
players = {str(r.mlbam): {"name": r.name, "team": r.team, "wRC+": round(r.wrc27_p50, 1),
                          **{f"p{q}": round(getattr(r, f"wrc27_p{q}"), 1) for q in Q},
                          "exp_pa": int(r.exp_pa), "proj_z": round(r.proj_z, 2),
                          "lg_rank": None if np.isnan(r.lg_rank) else int(r.lg_rank),
                          "lg_pctile": None if np.isnan(r.lg_pctile) else round(r.lg_pctile, 1)}
           for r in out.itertuples()}
with open(OUT_JSON, "w") as f:
    json.dump({"meta": meta, "players": players}, f)
print(f"Wrote {OUT_CSV} (Orioles), league_wrc_proj_2027.csv and {OUT_JSON} (all {len(players)} projected hitters)")
