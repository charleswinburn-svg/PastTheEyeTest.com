"""Turn the ratings notebook's CSVs into the JSON files the site reads.

    meta.json                 when it was built, seasons, how much of the latest season is played, settings in use
    players.json              every player: name, position, handedness, country, flag, birth date, height, weight
    skaters_{season}.json     every column of player_ratings.csv for that season, plus tier and flag
    goalies_{season}.json     every column of goalie_ratings.csv for that season, plus tier and flag
    history.json              each player's WAR / GAR / GAA and tier by season, and where the tier lines fell
    teams.json                team_war.csv

Earlier seasons' files are written once and then left alone, so published numbers for a
finished season do not drift from night to night. `every_season=True` rewrites them all
(use it after changing a notebook, and once when a season ends).

The tier and z-score rules are the ones in the notebook's Streamlit dashboard (section 21).
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from .nbrun import log

# Roster spots per team in each tier, best first; everyone below the last one is in the final tier.
TIER_SLOTS = {"F": [("1st line", 3), ("2nd line", 3), ("3rd line", 3), ("4th line", 3)],
              "D": [("1st pair", 2), ("2nd pair", 2), ("3rd pair", 2)],
              "G": [("Starter (1)", 1), ("1B", 0.5)]}
TIER_LAST = {"F": "Depth", "D": "Depth", "G": "Backup"}
TIER_COLS = {"WAR": "war_1y", "GAR": "gar_1y", "GAA": "gaa_1y"}

# z-scores against the league average: (value column, column that says a player is ranked there, sign)
SKATER_Z = [("xgf60_{v}", "off_{v}_pct", 1), ("xga60_{v}", "def_{v}_pct", -1), ("fin_{v}", "fin_{v}_pct", 1),
            ("play_{v}", "play_{v}_pct", 1), ("pp_off_{v}", "pp_off_{v}_pct", 1), ("pk_def_{v}", "pk_def_{v}_pct", 1),
            ("competition_{v}", "competition_{v}_pct", 1), ("teammates_{v}", "teammates_{v}_pct", 1)]
GOALIE_Z = [(f"{stem}_{{v}}", f"{stem}_{{v}}_pct", 1) for stem in
            ("adj100", "gsax100", "gsax5v5_100", "gsaxpk_100", "gsaxlow_100", "gsaxmed_100", "gsaxhigh_100",
             "reb100", "wpa1000")]

# NHL birth-country codes (three letters) to the two-letter codes flag images use.
ISO2 = {
    "CAN": "ca", "USA": "us", "SWE": "se", "FIN": "fi", "RUS": "ru", "CZE": "cz", "SVK": "sk", "CHE": "ch",
    "DEU": "de", "DNK": "dk", "NOR": "no", "LVA": "lv", "AUT": "at", "FRA": "fr", "BLR": "by", "SVN": "si",
    "GBR": "gb", "NLD": "nl", "AUS": "au", "KAZ": "kz", "UKR": "ua", "LTU": "lt", "POL": "pl", "ITA": "it",
    "HRV": "hr", "BGR": "bg", "JPN": "jp", "KOR": "kr", "CHN": "cn", "BRA": "br", "NGA": "ng", "JAM": "jm",
    "BHS": "bs", "LBN": "lb", "IDN": "id", "TWN": "tw", "ZAF": "za", "UZB": "uz", "EST": "ee", "HUN": "hu",
    "BEL": "be", "ESP": "es", "SRB": "rs", "ROU": "ro", "IRL": "ie", "MEX": "mx", "HTI": "ht", "PRY": "py",
    "VEN": "ve", "TZA": "tz", "BRN": "bn", "ISL": "is", "LUX": "lu", "PRT": "pt", "GRC": "gr", "TUR": "tr",
    "ISR": "il", "IND": "in", "PAK": "pk", "PHL": "ph", "THA": "th", "VNM": "vn", "MYS": "my", "SGP": "sg",
    "NZL": "nz", "ARG": "ar", "CHL": "cl", "COL": "co", "PER": "pe", "URY": "uy", "ECU": "ec", "BOL": "bo",
    "CUB": "cu", "DOM": "do", "TTO": "tt", "BRB": "bb", "BMU": "bm", "GUY": "gy", "SUR": "sr", "PAN": "pa",
    "CRI": "cr", "GTM": "gt", "HND": "hn", "SLV": "sv", "NIC": "ni", "BLZ": "bz", "KEN": "ke", "GHA": "gh",
    "ETH": "et", "EGY": "eg", "MAR": "ma", "DZA": "dz", "TUN": "tn", "SEN": "sn", "CMR": "cm", "CIV": "ci",
    "COD": "cd", "COG": "cg", "AGO": "ao", "ZWE": "zw", "ZMB": "zm", "UGA": "ug", "RWA": "rw", "SDN": "sd",
    "SOM": "so", "LBR": "lr", "SLE": "sl", "MOZ": "mz", "MDG": "mg", "MUS": "mu", "ARM": "am", "AZE": "az",
    "GEO": "ge", "MDA": "md", "KGZ": "kg", "TJK": "tj", "TKM": "tm", "MNG": "mn", "IRN": "ir", "IRQ": "iq",
    "SYR": "sy", "JOR": "jo", "SAU": "sa", "ARE": "ae", "QAT": "qa", "KWT": "kw", "AFG": "af", "NPL": "np",
    "LKA": "lk", "BGD": "bd", "MMR": "mm", "KHM": "kh", "PRK": "kp", "HKG": "hk", "BIH": "ba", "MNE": "me",
    "MKD": "mk", "ALB": "al", "XKX": "xk", "CYP": "cy", "MLT": "mt", "AND": "ad", "MCO": "mc", "LIE": "li",
    "SMR": "sm", "FRO": "fo", "GRL": "gl", "PRI": "pr", "VIR": "vi", "GUM": "gu",
}


def value(x):
    """A CSV cell as plain JSON: None for missing, ints kept whole, floats to four decimals."""
    if x is None:
        return None
    if isinstance(x, (bool, np.bool_)):
        return bool(x)
    if isinstance(x, (int, np.integer)):
        return int(x)
    if isinstance(x, (float, np.floating)):
        if not np.isfinite(x):
            return None
        return int(x) if float(x).is_integer() and abs(x) < 1e15 else round(float(x), 4)
    return str(x)


def label(y):
    return f"{y}-{str(y + 1)[2:]}"


def with_tiers(d, kind):
    """Every player-season, with the tier its 1-year WAR, GAR and GAA ranked in at its position that season."""
    d = d.copy()
    if kind == "skaters":
        d["played"] = d.min_all_1y.fillna(0) > 0
    else:
        d = d.rename(columns={"goalie_id": "player_id"})
        d["pos_group"], d["played"] = "G", d.shots.fillna(0) > 0
    teams = d[d.played].groupby("season").team.nunique()
    for name, col in TIER_COLS.items():
        if col not in d.columns:
            continue
        spot = d[d.played].groupby(["season", "pos_group"])[col].rank(ascending=False, method="first")
        spot = (spot / d.loc[d.played, "season"].map(teams)).reindex(d.index)
        tier = d.pos_group.map(TIER_LAST).where(d.played)
        for g, slots in TIER_SLOTS.items():
            top = 0
            for name_, n in slots:
                tier = tier.mask((d.pos_group == g) & (spot > top) & (spot <= top + n), name_)
                top += n
        d[f"tier_{name}"] = tier
    return d


def z_reference(season_rows, kind):
    """League mean, spread and player count behind each z-score row, per ratings version and peer group.

    A player's z-score is sign * (value - mean) / sd, shown only when he is ranked on that row
    and at least 10 players are.
    """
    out = {}
    for v in ("3y", "1y"):
        if kind == "skaters":
            groups = {g: season_rows[season_rows.pos_group == g] for g in ("F", "D")}
        else:
            q = season_rows.get(f"qualified_{v}")
            groups = {"G": season_rows[q == True] if q is not None else season_rows.iloc[0:0]}   # noqa: E712
        out[v] = {}
        for g, peers in groups.items():
            ref = {}
            for col, ranked, sign in (SKATER_Z if kind == "skaters" else GOALIE_Z):
                col, ranked = col.format(v=v), ranked.format(v=v)
                if col not in peers or ranked not in peers:
                    continue
                vals = peers.loc[peers[ranked].notna(), col].dropna()
                if len(vals) >= 10 and vals.std() > 0:
                    ref[col] = {"mean": round(float(vals.mean()), 5), "sd": round(float(vals.std()), 5),
                                "n": int(len(vals)), "sign": sign, "ranked": ranked}
            out[v][g] = ref
    return out


def season_file(rows, kind, y, flags):
    rows = rows[rows.team.notna()].sort_values("war_1y", ascending=False)
    rows = rows.assign(flag=rows.player_id.map(flags))
    cols = [c for c in rows.columns if c != "played"]
    done = float(rows.season_done.min()) if "season_done" in rows and len(rows) else 1.0
    return {"season": y, "label": label(y), "kind": kind, "season_done": round(done, 4),
            "columns": cols, "rows": [[value(x) for x in rec] for rec in rows[cols].itertuples(index=False, name=None)],
            "z_ref": z_reference(rows, kind)}


def dump(path, obj):
    path.write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False, allow_nan=False))


def export(data_dir, site_dir, every_season=False, picks=None):
    data_dir, site_dir = Path(data_dir), Path(site_dir)
    tmp = site_dir.parent / (site_dir.name + ".tmp")
    tmp.mkdir(parents=True, exist_ok=True)
    site_dir.mkdir(parents=True, exist_ok=True)
    written = []

    # ---- players and flags
    bios = pd.read_csv(data_dir / "players.csv")
    overrides = {int(k): v for k, v in json.loads((Path(__file__).parent / "flag_overrides.json").read_text()).items()
                 if not k.startswith("_")}
    codes = bios.birth_country.map(ISO2)
    unknown = sorted(set(bios.birth_country[codes.isna() & bios.birth_country.notna()]))
    if unknown:
        log(f"WARNING no flag for country code(s) {unknown}; add them to ISO2 in nhl/export_site.py")
    flags = {int(p): overrides.get(int(p), c if isinstance(c, str) else None) for p, c in zip(bios.player_id, codes)}
    keep = ["player_id", "player", "position", "shoots_catches", "birth_country", "birth_date", "height_in",
            "weight_lb", "current_team", "sweater_number", "is_active"]
    keep = [c for c in keep if c in bios.columns]
    dump(tmp / "players.json", {"columns": keep + ["flag"],
                                "rows": [[value(x) for x in rec] + [flags[int(rec[0])]]
                                         for rec in bios[keep].itertuples(index=False, name=None)]})
    written.append("players.json")

    # ---- one file per season and kind; earlier seasons only when missing
    frames = {"skaters": with_tiers(pd.read_csv(data_dir / "player_ratings.csv", low_memory=False), "skaters"),
              "goalies": with_tiers(pd.read_csv(data_dir / "goalie_ratings.csv", low_memory=False), "goalies")}
    seasons = sorted(int(y) for y in frames["skaters"].season.unique())
    latest = seasons[-1]
    for kind, d in frames.items():
        for y in seasons:
            name = f"{kind}_{y}.json"
            if y != latest and not every_season and (site_dir / name).exists():
                continue
            dump(tmp / name, season_file(d[d.season == y], kind, y, flags))
            written.append(name)

    # ---- history, built from the season files as they will be published (kept ones included)
    def published(name):
        f = tmp / name
        return json.loads((f if f.exists() else site_dir / name).read_text())

    history = {"columns": ["season", "team", "war", "gar", "gaa", "tier_war", "tier_gar", "tier_gaa"],
               "players": {}, "cuts": {}}
    for kind in frames:
        for y in seasons:
            f = published(f"{kind}_{y}.json")
            ix = {c: i for i, c in enumerate(f["columns"])}
            need = ["team", "war_1y", "gar_1y", "gaa_1y", "tier_WAR", "tier_GAR", "tier_GAA"]
            if any(c not in ix for c in need + ["player_id", "pos_group"]):
                continue
            for row in f["rows"]:
                if row[ix["tier_WAR"]] is None:               # did not play that season
                    continue
                history["players"].setdefault(str(row[ix["player_id"]]), []).append([y] + [row[ix[c]] for c in need])
                # the lowest value in each tier is the line between it and the tier below
                for m, col in TIER_COLS.items():
                    tier, val = row[ix[f"tier_{m}"]], row[ix[col]]
                    if tier is None or val is None:
                        continue
                    slot = history["cuts"].setdefault(row[ix["pos_group"]], {}).setdefault(m, {}).setdefault(str(y), {})
                    slot[tier] = val if tier not in slot else min(slot[tier], val)
    dump(tmp / "history.json", history)
    written.append("history.json")

    # ---- teams and meta
    tw = pd.read_csv(data_dir / "team_war.csv")
    dump(tmp / "teams.json", {"columns": list(tw.columns),
                              "rows": [[value(x) for x in rec] for rec in tw.itertuples(index=False, name=None)]})
    cur = frames["skaters"][frames["skaters"].season == latest]
    done = float(cur.season_done.min()) if "season_done" in cur else 1.0
    dump(tmp / "meta.json", {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "latest_season": latest, "season_done": round(done, 4),
        "seasons": [{"season": y, "label": label(y), "in_progress": bool(y == latest and done < 1)} for y in seasons],
        "tiers": {g: [n for n, _ in TIER_SLOTS[g]] + [TIER_LAST[g]] for g in TIER_SLOTS},
        "settings": {k: v for k, v in (picks or {}).items() if k != "at"},
        "source": "NHL play-by-play and shift charts; xG and ratings by PastTheEyeTest"})
    written += ["teams.json", "meta.json"]

    for name in written:                                      # swap in, one file at a time
        os.replace(tmp / name, site_dir / name)
    tmp.rmdir()
    size = sum((site_dir / n).stat().st_size for n in written) / 1e6
    log(f"export: wrote {len(written)} file(s), {size:.1f} MB, to {site_dir} "
        f"({label(latest)}{' in progress' if done < 1 else ''}; {len(flags):,} players)")
