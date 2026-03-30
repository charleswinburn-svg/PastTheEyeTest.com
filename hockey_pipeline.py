#!/usr/bin/env python3
"""
Hockey Player Scoring Pipeline
Reads NST + Evolving Hockey CSVs, computes composite percentile scores, outputs JSON.
Port of hockey_app.R scoring engine.

Usage:
  python hockey_pipeline.py <data_dir> [mode] [output_dir]
  
  mode: "2025-26", "2024-25", "2023-24", or "rolling" (default: "2025-26")
  
Example:
  python hockey_pipeline.py ./data rolling ./output
"""

import pandas as pd
import numpy as np
from scipy.stats import beta as beta_dist
import json, os, sys, unicodedata, re, time
try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

# ============================================================
# CONFIG
# ============================================================

YEAR_LABELS = {"2025-26": "2025", "2024-25": "2024", "2023-24": "2023"}
ROLLING_WEIGHTS = {"2025": 0.53, "2024": 0.31, "2023": 0.16}
MIN_TOI_PER_YEAR = 100
MIN_GOALIE_GP = 15

NST_FILE_TYPES = {
    "5v5_indiv": "5v5individualrates", "5v5_onice": "5v5onicerates",
    "5v5_counts": "5v5onicecounts", "5v5_rel": "5v5relativerates",
    "all_str": "allsituationsrates", "pp_indiv": "ppindividualrates",
    "pp_onice": "pponicerates", "pk_indiv": "pkindividualrates",
    "pk_onice": "pkonicerates",
}

GOALIE_FILE_MAP = {"2025-26": "25-26goalies.csv", "2024-25": "24-25goalies.csv", "2023-24": "23-24goalies.csv"}

BASE_WEIGHTS = {
    "5v5 Offense": 0.275, "5v5 Defense": 0.215, "Production": 0.20,
    "Power Play": 0.055, "Penalty Kill": 0.055, "Penalties": 0.05,
    "Competition": 0.075, "Teammates": 0.075,
}

GOALIE_WEIGHTS = {
    "5v5 GSAx": 0.400, "Penalty Kill": 0.075, "High Danger GSAx": 0.1875,
    "Med Danger GSAx": 0.125, "Low Danger GSAx": 0.0625, "Rebound Control": 0.05, "Ice Time": 0.10,
}

RATE_COLS = [
    "ev5_g_per60","ev5_a_per60","ev5_pa_per60","ev5_sa_per60","ev5_xg_per60",
    "ev5_hits_per60","ev5_tk_per60","ev5_blk_per60",
    "onice_cf_per60","onice_ca_per60","onice_ff_per60","onice_fa_per60",
    "onice_gf_per60","onice_ga_per60","onice_xgf_per60","onice_xga_per60",
    "hdcf_per60","hdca_per60","onice_sv_pct","onice_sh_pct",
    "rel_xgf_per60","rel_xga_per60","rel_gf_per60","rel_ga_per60",
    "all_g_per60","all_pa_per60","all_sa_per60","all_pim_per60","all_pen_drawn_per60",
    "pp_g_per60","pp_pa_per60","pp_sa_per60","pp_pts_per60",
    "pp_onice_xgf_per60","pp_onice_gf_per60","pp_onice_hdcf_per60",
    "pk_tk_per60","pk_blk_per60","pk_onice_xga_per60","pk_onice_hdca_per60","pk_onice_ca_per60",
    "qoc_rapm_xg","qoc_off_xgar","qoc_def_xgar",
    "qot_rapm_xg","qot_off_xgar","qot_def_xgar",
    "qot_rapm_xgf","qot_rapm_xga","qot_rapm_cf","qot_rapm_ca",
]

# ============================================================
# NAME NORMALIZATION + ALIASES
# ============================================================

NAME_ALIAS_MAP = {
    "alex holtz": "alexander holtz", "alex alexeyev": "alexander alexeyev",
    "alex romanov": "alexander romanov", "alex nikishin": "alexander nikishin",
    "alex wennberg": "alexander wennberg", "alex carrier": "alexandre carrier",
    "alex texier": "alexandre texier", "alexei toropchenko": "alexey toropchenko",
    "evgeny dadonov": "evgenii dadonov", "matt dumba": "mathew dumba",
    "matt benning": "matthew benning", "cam atkinson": "cameron atkinson",
    "nick paul": "nicholas paul", "patrick maroon": "pat maroon",
    "emil martinsen lilleberg": "emil lilleberg", "frederick gaudreau": "frederic gaudreau",
    "jacob middleton": "jake middleton", "janis moser": "jj moser",
    "josh mahura": "joshua mahura", "maxwell crozier": "max crozier",
    "pierreolivier joseph": "po joseph", "thomas novak": "tommy novak",
    "william borgen": "will borgen", "zachary bolduc": "zack bolduc",
    "nicholas suzuki": "nick suzuki", "zachary werenski": "zach werenski",
    "christopher tanev": "chris tanev", "mitchell marner": "mitch marner",
    "samuel reinhart": "sam reinhart", "samuel bennett": "sam bennett",
    "nicholas robertson": "nick robertson", "nicholas jensen": "nick jensen",
    "timothy stutzle": "tim stutzle", "cameron york": "cam york",
    "alexander kerfoot": "alex kerfoot", "michael matheson": "mike matheson",
    "maxwell pacioretty": "max pacioretty", "callan foote": "cal foote",
}

OLYMPIC_ROSTERS = {
    "ca": ["Sam Bennett","Macklin Celebrini","Sidney Crosby","Brandon Hagel","Bo Horvat","Seth Jarvis","Nathan MacKinnon","Brad Marchand","Mitch Marner","Connor McDavid","Sam Reinhart","Mark Stone","Nick Suzuki","Tom Wilson","Drew Doughty","Thomas Harley","Cale Makar","Josh Morrissey","Colton Parayko","Travis Sanheim","Shea Theodore","Devon Toews","Jordan Binnington","Darcy Kuemper","Logan Thompson"],
    "us": ["Matt Boldy","Kyle Connor","Jack Eichel","Jack Hughes","Jake Guentzel","Clayton Keller","Dylan Larkin","Auston Matthews","J.T. Miller","Brock Nelson","Brady Tkachuk","Matthew Tkachuk","Tage Thompson","Vincent Trocheck","Brock Faber","Noah Hanifin","Quinn Hughes","Jackson LaCombe","Charlie McAvoy","Jake Sanderson","Jaccob Slavin","Zach Werenski","Connor Hellebuyck","Jake Oettinger","Jeremy Swayman"],
    "fi": ["Joel Armia","Sebastian Aho","Mikael Granlund","Erik Haula","Roope Hintz","Kaapo Kakko","Oliver Kapanen","Joel Kiviranta","Artturi Lehkonen","Anton Lundell","Eetu Luostarinen","Mikko Rantanen","Teuvo Teravainen","Eeli Tolvanen","Miro Heiskanen","Henri Jokiharju","Mikko Lehtonen","Esa Lindell","Olli Maatta","Nikolas Matinpalo","Niko Mikkola","Rasmus Ristolainen","Joonas Korpisalo","Kevin Lankinen","Juuse Saros"],
    "se": ["Jesper Bratt","Joel Eriksson Ek","Filip Forsberg","Pontus Holmberg","Marcus Johansson","Adrian Kempe","Gabriel Landeskog","Elias Lindholm","William Nylander","Elias Pettersson","Rickard Rakell","Lucas Raymond","Alexander Wennberg","Mika Zibanejad","Rasmus Andersson","Philip Broberg","Rasmus Dahlin","Oliver Ekman-Larsson","Gustav Forsling","Victor Hedman","Erik Karlsson","Hampus Lindholm","Filip Gustavsson","Jacob Markstrom","Jesper Wallstedt"],
    "cz": ["Roman Cervenka","Filip Chlapik","Radek Faksa","Jakub Flek","Tomas Hertl","David Kampf","Ondrej Kase","Dominik Kubalik","Martin Necas","Ondrej Palat","David Pastrnak","Lukas Sedlak","Matej Stransky","David Tomasek","Radko Gudas","Filip Hronek","Michal Kempny","Tomas Kundratek","Jan Rutta","Radim Simek","David Spacek","Jiri Tichacek","Lukas Dostal","Karel Vejmelka","Dan Vladar"],
    "de": ["Leon Draisaitl","Alexander Ehl","Dominik Kahun","Marc Michaelis","JJ Peterka","Lukas Reichel","Tobias Rieder","Tim Stutzle","Nico Sturm","Moritz Seider","Philipp Grubauer"],
    "ch": ["Kevin Fiala","Nico Hischier","Timo Meier","Nino Niederreiter","Roman Josi","Jonas Siegenthaler","J.J. Moser","Akira Schmid"],
    "sk": ["Juraj Slafkovsky","Tomas Tatar","Erik Cernak","Martin Fehervary","Simon Nemec"],
    "dk": ["Oliver Bjorkstrand","Nikolaj Ehlers","Lars Eller","Frederik Andersen","Mads Sogaard"],
    "lv": ["Zemgus Girgensons","Elvis Merzlikins","Arturs Silovs"],
}

_olympic_lookup = {}
for _cc, _roster in OLYMPIC_ROSTERS.items():
    for _nm in _roster:
        _key = unicodedata.normalize("NFKD", _nm.lower().strip()).encode("ascii", "ignore").decode()
        _olympic_lookup[_key] = _cc

def normalize_name(name):
    s = str(name).lower().strip()
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = re.sub(r"[.'\-]", "", s)
    s = re.sub(r"\s*\([dclr]w?\)\s*$", "", s)
    return re.sub(r"\s+", " ", s).strip()

def apply_aliases(name):
    return NAME_ALIAS_MAP.get(name, name)

def normalize_pos_group(pos):
    pos = str(pos).upper().strip()
    if pos in ("D","LD","RD","DEFENSE","DEFENCE","DEFENSEMAN","DEFENCEMAN"): return "D"
    if pos in ("F","C","LW","RW","L","R","W","FORWARD"): return "F"
    return None

def get_olympic_country(name):
    key = unicodedata.normalize("NFKD", name.lower().strip()).encode("ascii", "ignore").decode()
    return _olympic_lookup.get(key)

def stretch_pctile(x):
    if not np.isfinite(x): return x
    return beta_dist.cdf(min(x / 100 / 0.985, 1.0), 1.3, 1.3) * 100

stretch_v = np.vectorize(stretch_pctile)

def ensure_cols(df, cols):
    for c in cols:
        if c not in df.columns: df[c] = np.nan
    return df

def pct_rank(s):
    n = s.notna().sum()
    if n <= 1: return pd.Series(0.0, index=s.index)
    return (s.rank(method="average", na_option="keep") - 1) / (n - 1)

NST_TO_NHL = {
    "T.B":"TBL","S.J":"SJS","N.J":"NJD","L.A":"LAK","ANA":"ANA","ARI":"ARI","BOS":"BOS",
    "BUF":"BUF","CAR":"CAR","CBJ":"CBJ","CGY":"CGY","CHI":"CHI","COL":"COL","DAL":"DAL",
    "DET":"DET","EDM":"EDM","FLA":"FLA","MIN":"MIN","MTL":"MTL","NSH":"NSH","NYI":"NYI",
    "NYR":"NYR","OTT":"OTT","PHI":"PHI","PIT":"PIT","SEA":"SEA","STL":"STL","TOR":"TOR",
    "UTA":"UTA","VAN":"VAN","VGK":"VGK","WPG":"WPG","WSH":"WSH",
}

def current_team(t):
    return [x.strip() for x in str(t).split(",")][-1]

def team_nhl(t):
    a = current_team(t).upper()
    return NST_TO_NHL.get(a, a)

# ============================================================
# CSV LOADING
# ============================================================

def read_csv_safe(path):
    # Check if file is actually HTML (bad download)
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        first = f.read(500)
    if first.strip().startswith("<!") or first.strip().startswith("<html") or "<table" in first.lower()[:500]:
        # It's HTML — parse the table out of it
        print(f"  Note: {os.path.basename(path)} is HTML, parsing table...")
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            html = f.read()
        tables = pd.read_html(html)
        if not tables:
            raise ValueError(f"No tables found in {path}")
        df = max(tables, key=len)
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = [' '.join(str(c) for c in col).strip() for col in df.columns]
        # Overwrite with clean CSV for next time
        df.to_csv(path, index=False)
    else:
        try: df = pd.read_csv(path, encoding="utf-8")
        except (UnicodeDecodeError, pd.errors.ParserError):
            try: df = pd.read_csv(path, encoding="latin-1")
            except pd.errors.ParserError:
                # Last resort: try HTML parse
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    html = f.read()
                tables = pd.read_html(html)
                if not tables:
                    raise
                df = max(tables, key=len)
                df.to_csv(path, index=False)
    df = df.loc[:, ~df.columns.str.match(r"^Unnamed")]
    # Replace ± with "pm" BEFORE ASCII normalization so EH columns like "RAPM_xG±/60" become "RAPM_xGpm/60"
    df.columns = [unicodedata.normalize("NFKD", str(c).replace("±","pm")).encode("ascii","ignore").decode().strip() for c in df.columns]
    return df


# ============================================================
# AUTO-DOWNLOAD NST + MONEYPUCK DATA
# ============================================================

NST_BASE = "https://www.naturalstattrick.com/playerteams.php"
NST_PARAMS = {
    "5v5individualrates": {"sit": "5v5", "stdoi": "std", "rate": "y"},
    "5v5onicerates":      {"sit": "5v5", "stdoi": "oi",  "rate": "y"},
    "5v5onicecounts":     {"sit": "5v5", "stdoi": "oi",  "rate": "n"},
    "5v5relativerates":   {"sit": "5v5", "stdoi": "sr",  "rate": "y"},
    "allsituationsrates": {"sit": "all", "stdoi": "std", "rate": "y"},
    "ppindividualrates":  {"sit": "pp",  "stdoi": "std", "rate": "y"},
    "pponicerates":       {"sit": "pp",  "stdoi": "oi",  "rate": "y"},
    "pkindividualrates":  {"sit": "pk",  "stdoi": "std", "rate": "y"},
    "pkonicerates":       {"sit": "pk",  "stdoi": "oi",  "rate": "y"},
}

MONEYPUCK_GOALIE_URL = "https://moneypuck.com/moneypuck/playerData/seasonSummary/{year}/regular/goalies.csv"
GOALIE_YEAR_MAP = {"25-26goalies.csv": "2025", "24-25goalies.csv": "2024", "23-24goalies.csv": "2023"}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

def year_to_nst_season(year):
    """Convert pipeline year '2025' to NST season '20252026'."""
    y = int(year)
    return f"{y}{y+1}"

def download_nst_file(year, file_type, data_dir):
    """Download a single NST CSV via their CSV export endpoint. Returns True on success."""
    if not HAS_REQUESTS:
        print("    requests library not installed. pip install requests")
        return False
    if file_type not in NST_PARAMS:
        return False
    
    params = NST_PARAMS[file_type]
    season = year_to_nst_season(year)
    url_params = {
        "fromseason": season, "thruseason": season, "stype": "2",
        "sit": params["sit"], "score": "all", "stdoi": params["stdoi"],
        "rate": params["rate"], "team": "ALL", "pos": "S", "loc": "B",
        "toi": "0", "gpfilt": "none", "fd": "", "td": "", "tgp": "410",
        "lines": "single", "datea": "", "dateb": "",
    }
    
    dest = os.path.join(data_dir, f"{year}{file_type}.csv")
    try:
        print(f"    Downloading {year}{file_type}...", end=" ", flush=True)
        sess = requests.Session()
        sess.headers.update(HEADERS)
        
        # Hit the page first to get cookies
        page_r = sess.get(NST_BASE, params=url_params, timeout=30)
        page_r.raise_for_status()
        
        # Now request CSV export
        csv_params = dict(url_params)
        csv_params["csvexport"] = "1"
        csv_r = sess.get(NST_BASE, params=csv_params, timeout=30)
        csv_r.raise_for_status()
        
        content = csv_r.text.strip()
        if not content.startswith("<!") and not content.startswith("<html") and "," in content[:200]:
            # Got actual CSV
            with open(dest, "w", encoding="utf-8") as f:
                f.write(content)
            lines = content.split("\n")
            print(f"OK ({len(lines)-1} rows)")
        else:
            # CSV export returned HTML — parse table from original page
            tables = pd.read_html(page_r.text)
            if not tables:
                print("NO DATA")
                return False
            df = max(tables, key=len)
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = [' '.join(str(c) for c in col).strip() for col in df.columns]
            # Drop any row that looks like a header repeat
            df = df[df.iloc[:, 0] != df.columns[0]]
            df.to_csv(dest, index=False)
            print(f"OK ({len(df)} rows, from HTML)")
        
        time.sleep(8)  # NST rate limits aggressively
        return True
    except Exception as e:
        print(f"FAIL ({e})")
        # Retry once after longer wait
        try:
            print(f"    Retrying {year}{file_type} after 15s...", end=" ", flush=True)
            time.sleep(15)
            sess2 = requests.Session()
            sess2.headers.update(HEADERS)
            page_r2 = sess2.get(NST_BASE, params=url_params, timeout=45)
            page_r2.raise_for_status()
            tables = pd.read_html(page_r2.text)
            if tables:
                df = max(tables, key=len)
                if isinstance(df.columns, pd.MultiIndex):
                    df.columns = [' '.join(str(c) for c in col).strip() for col in df.columns]
                df = df[df.iloc[:, 0] != df.columns[0]]
                df.to_csv(dest, index=False)
                print(f"OK ({len(df)} rows, retry)")
                time.sleep(8)
                return True
            print("NO DATA")
        except Exception as e2:
            print(f"FAIL ({e2})")
        return False

def download_goalie_file(fname, data_dir):
    """Download MoneyPuck goalie CSV. Returns True on success."""
    if not HAS_REQUESTS:
        return False
    year = GOALIE_YEAR_MAP.get(fname)
    if not year:
        return False
    
    url = MONEYPUCK_GOALIE_URL.format(year=year)
    dest = os.path.join(data_dir, fname)
    try:
        print(f"    Downloading {fname} from MoneyPuck...", end=" ", flush=True)
        r = requests.get(url, headers=HEADERS, timeout=30)
        r.raise_for_status()
        with open(dest, "w") as f:
            f.write(r.text)
        lines = r.text.strip().split("\n")
        print(f"OK ({len(lines)-1} rows)")
        time.sleep(1)
        return True
    except Exception as e:
        print(f"FAIL ({e})")
        return False

def ensure_nst_data(data_dir, year):
    """Check for missing NST files and download them."""
    os.makedirs(data_dir, exist_ok=True)
    missing = []
    for ft in NST_FILE_TYPES.values():
        p = os.path.join(data_dir, f"{year}{ft}.csv")
        if not os.path.exists(p):
            missing.append(ft)
    
    if not missing:
        return
    
    print(f"  Missing {len(missing)} NST files for {year}.")
    
    # Try auto-download first
    if HAS_REQUESTS:
        print(f"  Attempting auto-download (8s delay between requests)...")
        failed = []
        for ft in missing:
            ok = download_nst_file(year, ft, data_dir)
            if not ok:
                failed.append(ft)
        if not failed:
            return
        missing = failed
    
    # Print manual download instructions for any that failed
    if missing:
        season = year_to_nst_season(year)
        print(f"\n  === MANUAL DOWNLOAD NEEDED for {year} ===")
        print(f"  Open each URL in your browser, the page will have a CSV export button.")
        print(f"  Save each file to: {os.path.abspath(data_dir)}/")
        print()
        for ft in missing:
            params = NST_PARAMS[ft]
            url = (f"https://www.naturalstattrick.com/playerteams.php?"
                   f"fromseason={season}&thruseason={season}&stype=2"
                   f"&sit={params['sit']}&score=all&stdoi={params['stdoi']}"
                   f"&rate={params['rate']}&team=ALL&pos=S&loc=B&toi=0"
                   f"&gpfilt=none&fd=&td=&tgp=410&lines=single")
            fname = f"{year}{ft}.csv"
            print(f"  {fname}:")
            print(f"    {url}")
            # Also print the direct CSV export URL
            print(f"    CSV: {url}&csvexport=1")
            print()
        print(f"  After downloading, re-run the pipeline.")

def ensure_goalie_data(data_dir):
    """Check for missing goalie files and download them."""
    os.makedirs(data_dir, exist_ok=True)
    for fname in GOALIE_FILE_MAP.values():
        p = os.path.join(data_dir, fname)
        if not os.path.exists(p):
            ok = download_goalie_file(fname, data_dir)
            if not ok:
                year = GOALIE_YEAR_MAP.get(fname, "")
                url = MONEYPUCK_GOALIE_URL.format(year=year)
                print(f"    Manual: download {url}")
                print(f"    Save as: {os.path.join(os.path.abspath(data_dir), fname)}")

def load_year_csvs(data_dir, year):
    # Auto-download missing NST files
    ensure_nst_data(data_dir, year)
    
    result = {}
    for key, ft in NST_FILE_TYPES.items():
        p = os.path.join(data_dir, f"{year}{ft}.csv")
        if os.path.exists(p): result[key] = read_csv_safe(p)
    for extra in ("qoc","qot"):
        p = os.path.join(data_dir, f"{year}{extra}.csv")
        if os.path.exists(p): result[extra] = read_csv_safe(p)
    return result

# ============================================================
# PARSE YEAR DATA - merge 9+ CSVs into one player df
# ============================================================

def _extract(df, col_map, rename_map=None):
    """Helper: rename Player/Team/Position, convert numeric columns."""
    df = df.copy()
    if rename_map is None:
        rename_map = {"Player":"name","Team":"team","Position":"position"}
    df = df.rename(columns=rename_map)
    for old, new in col_map.items():
        df[new] = pd.to_numeric(df.get(old, np.nan), errors="coerce")
    keep = list(rename_map.values()) + list(col_map.values())
    # Add GP/TOI if present
    for c in ["gp","toi_min","toi_min_all","toi_min_pp","toi_min_pk","pp_gp","pk_gp"]:
        if c in df.columns: keep.append(c)
    return df[[c for c in keep if c in df.columns]]

def parse_year_data(csvs):
    m = csvs

    # 1. 5v5 individual
    ind = m["5v5_indiv"].copy()
    ind = ensure_cols(ind, ["Goals/60","Total Assists/60","First Assists/60","Second Assists/60",
                             "ixG/60","Hits/60","Takeaways/60","Shots Blocked/60"])
    ind = ind.rename(columns={"Player":"name","Team":"team","Position":"position"})
    ind["gp"] = pd.to_numeric(ind["GP"], errors="coerce")
    ind["toi_min"] = pd.to_numeric(ind["TOI"], errors="coerce")
    for o,n in [("Goals/60","ev5_g_per60"),("Total Assists/60","ev5_a_per60"),
                ("First Assists/60","ev5_pa_per60"),("Second Assists/60","ev5_sa_per60"),
                ("ixG/60","ev5_xg_per60"),("Hits/60","ev5_hits_per60"),
                ("Takeaways/60","ev5_tk_per60"),("Shots Blocked/60","ev5_blk_per60")]:
        ind[n] = pd.to_numeric(ind.get(o, np.nan), errors="coerce")
    keys = ["name","team","position","gp","toi_min"] + [c for c in ind.columns if c.startswith("ev5_")]
    df = ind[keys].copy()

    # 2-9: merge remaining CSV types
    def merge_csv(key, col_map, how="left"):
        nonlocal df
        if key not in m or m[key] is None: 
            for n in col_map.values():
                df[n] = np.nan
            return
        sub = m[key].copy()
        sub = ensure_cols(sub, list(col_map.keys()))
        sub = sub.rename(columns={"Player":"name","Team":"team","Position":"position"})
        for o,n in col_map.items():
            sub[n] = pd.to_numeric(sub.get(o, np.nan), errors="coerce")
        # Handle GP/TOI for special teams
        for extra in [("GP","pp_gp"),("GP","pk_gp"),("TOI","toi_min_pp"),("TOI","toi_min_pk"),("TOI","toi_min_all")]:
            if extra[1] in [n for n in col_map.values()]:
                continue
            # Check if we need to extract these
        merge_cols = ["name","team","position"] + list(col_map.values())
        extra_cols = []
        if "GP" in sub.columns and key in ("pp_indiv","pk_indiv"):
            ec = "pp_gp" if "pp" in key else "pk_gp"
            sub[ec] = pd.to_numeric(sub["GP"], errors="coerce")
            extra_cols.append(ec)
        if "TOI" in sub.columns and key in ("pp_indiv","pk_indiv","all_str"):
            ec = {"pp_indiv":"toi_min_pp","pk_indiv":"toi_min_pk","all_str":"toi_min_all"}[key]
            sub[ec] = pd.to_numeric(sub["TOI"], errors="coerce")
            extra_cols.append(ec)
        merge_cols += extra_cols
        merge_cols = [c for c in merge_cols if c in sub.columns]
        df = df.merge(sub[merge_cols], on=["name","team","position"], how=how)

    merge_csv("5v5_onice", {"CF/60":"onice_cf_per60","CA/60":"onice_ca_per60","FF/60":"onice_ff_per60",
                             "FA/60":"onice_fa_per60","GF/60":"onice_gf_per60","GA/60":"onice_ga_per60",
                             "xGF/60":"onice_xgf_per60","xGA/60":"onice_xga_per60","HDCF/60":"hdcf_per60",
                             "HDCA/60":"hdca_per60","On-Ice SV%":"onice_sv_pct","On-Ice SH%":"onice_sh_pct"})
    merge_csv("5v5_counts", {"Def. Zone Starts":"cnt_dz","Off. Zone Starts":"cnt_oz","Neu. Zone Starts":"cnt_nz"})
    merge_csv("5v5_rel", {"xGF/60 Rel":"rel_xgf_per60","xGA/60 Rel":"rel_xga_per60",
                           "GF/60 Rel":"rel_gf_per60","GA/60 Rel":"rel_ga_per60"})
    merge_csv("all_str", {"Goals/60":"all_g_per60","First Assists/60":"all_pa_per60",
                           "Second Assists/60":"all_sa_per60","PIM/60":"all_pim_per60",
                           "Penalties Drawn/60":"all_pen_drawn_per60"})
    merge_csv("pp_indiv", {"Goals/60":"pp_g_per60","First Assists/60":"pp_pa_per60",
                            "Second Assists/60":"pp_sa_per60","Total Points/60":"pp_pts_per60"})
    merge_csv("pp_onice", {"xGF/60":"pp_onice_xgf_per60","GF/60":"pp_onice_gf_per60","HDCF/60":"pp_onice_hdcf_per60"})
    merge_csv("pk_indiv", {"Takeaways/60":"pk_tk_per60","Shots Blocked/60":"pk_blk_per60"})
    merge_csv("pk_onice", {"xGA/60":"pk_onice_xga_per60","HDCA/60":"pk_onice_hdca_per60","CA/60":"pk_onice_ca_per60"})

    # Ensure all needed columns exist
    for c in ["toi_min_pp","toi_min_pk","toi_min_all","pp_gp","pk_gp",
              "qoc_rapm_xg","qoc_off_xgar","qoc_def_xgar",
              "qot_rapm_xg","qot_off_xgar","qot_def_xgar",
              "qot_rapm_xgf","qot_rapm_xga","qot_rapm_cf","qot_rapm_ca"]:
        if c not in df.columns: df[c] = np.nan

    # EH QoC
    if "qoc" in m and m["qoc"] is not None:
        qoc = m["qoc"].copy()
        qoc = ensure_cols(qoc, ["RAPM_xGpm/60","Off_xGAR/60","Def_xGAR/60","TOI","Position"])
        qoc["name_lower"] = qoc["Player"].apply(lambda x: apply_aliases(normalize_name(x)))
        qoc["eh_pos"] = qoc["Position"].apply(normalize_pos_group)
        qoc["toi_eh"] = pd.to_numeric(qoc["TOI"], errors="coerce")
        for o,n in [("RAPM_xGpm/60","qoc_rapm_xg"),("Off_xGAR/60","qoc_off_xgar"),("Def_xGAR/60","qoc_def_xgar")]:
            qoc[n] = pd.to_numeric(qoc.get(o, np.nan), errors="coerce")
        qoc = qoc.dropna(subset=["qoc_rapm_xg"])
        qoc_agg = qoc.groupby(["name_lower","eh_pos"]).apply(
            lambda g: pd.Series({c: np.average(g.loc[g[c].notna(), c], weights=g.loc[g[c].notna(),"toi_eh"].clip(lower=1)) if g[c].notna().sum()>0 else np.nan for c in ["qoc_rapm_xg","qoc_off_xgar","qoc_def_xgar"]}),
            include_groups=False
        ).reset_index()
        df["name_lower"] = df["name"].apply(lambda x: apply_aliases(normalize_name(x)))
        df["eh_pos"] = df["position"].apply(normalize_pos_group)
        df = df.drop(columns=["qoc_rapm_xg","qoc_off_xgar","qoc_def_xgar"], errors="ignore")
        df = df.merge(qoc_agg, on=["name_lower","eh_pos"], how="left")
        df = df.drop(columns=["name_lower","eh_pos"], errors="ignore")

    # EH QoT
    if "qot" in m and m["qot"] is not None:
        qot = m["qot"].copy()
        qot_cols_src = ["RAPM_xGpm/60","Off_xGAR/60","Def_xGAR/60","RAPM_xGF/60","RAPM_xGA/60","RAPM_CF/60","RAPM_CA/60"]
        qot_cols_dst = ["qot_rapm_xg","qot_off_xgar","qot_def_xgar","qot_rapm_xgf","qot_rapm_xga","qot_rapm_cf","qot_rapm_ca"]
        qot = ensure_cols(qot, qot_cols_src + ["TOI","Position"])
        qot["name_lower"] = qot["Player"].apply(lambda x: apply_aliases(normalize_name(x)))
        qot["eh_pos"] = qot["Position"].apply(normalize_pos_group)
        qot["toi_eh"] = pd.to_numeric(qot["TOI"], errors="coerce")
        for s,d in zip(qot_cols_src, qot_cols_dst):
            qot[d] = pd.to_numeric(qot.get(s, np.nan), errors="coerce")
        qot = qot.dropna(subset=["qot_rapm_xg"])
        qot_agg = qot.groupby(["name_lower","eh_pos"]).apply(
            lambda g: pd.Series({c: np.average(g.loc[g[c].notna(), c], weights=g.loc[g[c].notna(),"toi_eh"].clip(lower=1)) if g[c].notna().sum()>0 else np.nan for c in qot_cols_dst}),
            include_groups=False
        ).reset_index()
        df["name_lower"] = df["name"].apply(lambda x: apply_aliases(normalize_name(x)))
        df["eh_pos"] = df["position"].apply(normalize_pos_group)
        df = df.drop(columns=qot_cols_dst, errors="ignore")
        df = df.merge(qot_agg, on=["name_lower","eh_pos"], how="left")
        df = df.drop(columns=["name_lower","eh_pos"], errors="ignore")

    return df


# ============================================================
# BLEND YEARS
# ============================================================

def blend_years(year_dfs):
    frames = []
    for yr, d in year_dfs.items():
        d = d.copy()
        d["data_year"] = yr
        d["name_lower"] = d["name"].apply(lambda x: apply_aliases(normalize_name(x)))
        d["yr_weight"] = ROLLING_WEIGHTS.get(yr, 0)
        frames.append(d)
    all_data = pd.concat(frames, ignore_index=True)
    all_data["eff_weight"] = all_data["yr_weight"] * all_data["toi_min"].clip(lower=1)
    all_data = all_data[all_data["toi_min"] >= 200]

    identity = (all_data.sort_values("data_year", ascending=False)
                .groupby("name_lower").first().reset_index()[["name_lower","name","team","position"]])
    sc = all_data.groupby("name_lower").agg(
        has_recent=("data_year", lambda x: any(y in ["2025","2024"] for y in x)),
        n250=("toi_min", lambda x: (x >= 250).sum()), max_toi=("toi_min","max")
    ).reset_index()
    sc = sc[sc["has_recent"] & ((sc["n250"] >= 2) | (sc["max_toi"] >= 300))]
    elig = all_data[all_data["name_lower"].isin(sc["name_lower"])].copy()
    avail = [c for c in RATE_COLS if c in elig.columns]

    def wavg(g):
        r = {}
        for c in avail:
            v = g[c].notna()
            r[c] = np.average(g.loc[v, c], weights=g.loc[v, "eff_weight"]) if v.sum() > 0 else np.nan
        for c in ["gp","toi_min","toi_min_all","toi_min_pp","toi_min_pk","pp_gp","pk_gp"]:
            r[c] = g[c].sum() if c in g.columns else 0
        for c in ["cnt_dz","cnt_oz","cnt_nz"]:
            r[c] = (g[c] * g["yr_weight"]).sum() if c in g.columns else 0
        return pd.Series(r)

    blended = elig.groupby("name_lower").apply(wavg, include_groups=False).reset_index()
    return identity.merge(blended, on="name_lower").drop(columns=["name_lower"])


# ============================================================
# SCORE PIPELINE
# ============================================================

def score_pipeline(df):
    df = df.copy()
    df["pos_group"] = df["position"].apply(normalize_pos_group)
    df = df[df["pos_group"].isin(["F","D"])].copy()

    pim = df["all_pim_per60"]; drw = df["all_pen_drawn_per60"]
    df["penalty_ratio"] = np.where(drw.notna() & (drw > 0), pim / drw,
                           np.where(pim.notna() & (pim > 0), pim * 10, np.nan))
    total_sh = df["cnt_dz"].fillna(0) + df["cnt_oz"].fillna(0) + df["cnt_nz"].fillna(0)
    df["dz_shift_pct"] = np.where(total_sh > 0, df["cnt_dz"].fillna(0) / total_sh * 100, 33.3)
    df["oz_shift_pct"] = np.where(total_sh > 0, df["cnt_oz"].fillna(0) / total_sh * 100, 33.3)
    gp_s = df["gp"].clip(lower=1)
    df["toi_min_pp"] = df["toi_min_pp"].fillna(0)
    df["toi_min_pk"] = df["toi_min_pk"].fillna(0)
    df["pp_toi_per_gp"] = df["toi_min_pp"] / gp_s
    df["pk_toi_per_gp"] = df["toi_min_pk"] / gp_s
    df["has_pp"] = (df["toi_min_pp"] > 0) & (df["pp_toi_per_gp"] >= 1.0)
    df["has_pk"] = (df["toi_min_pk"] > 0) & (df["pk_toi_per_gp"] >= 1.0)

    # Weight calculation matching R logic
    for k in ["5v5 Offense","5v5 Defense","Production","Penalties","Competition","Teammates"]:
        df["w_" + k.lower().replace(" ","_")] = BASE_WEIGHTS[k]

    # Deployment factor from OZ shift %
    for pg in ["F","D"]:
        m = df["pos_group"] == pg
        oz_avg = df.loc[m, "oz_shift_pct"].mean()
        oz_sd = df.loc[m, "oz_shift_pct"].std()
        if oz_sd > 0:
            df.loc[m, "deployment_factor"] = ((df.loc[m, "oz_shift_pct"] - oz_avg) / oz_sd).clip(-1, 1)
        else:
            df.loc[m, "deployment_factor"] = 0.0

    # Shift 5v5 offense/defense weights by deployment
    deploy_shift = df["deployment_factor"] * 0.05
    df["w_5v5_offense"] = df["w_5v5_offense"] + deploy_shift
    df["w_5v5_defense"] = df["w_5v5_defense"] - deploy_shift

    # PP/PK average TOI per GP (among those who qualify)
    pp_avg = df.loc[df["has_pp"], "pp_toi_per_gp"].mean() if df["has_pp"].any() else 1.0
    pk_avg = df.loc[df["has_pk"], "pk_toi_per_gp"].mean() if df["has_pk"].any() else 1.0
    pp_toi_ratio = np.where(df["has_pp"] & (pp_avg > 0),
                            np.minimum(df["pp_toi_per_gp"] / pp_avg, 1.0), 0)
    pk_toi_ratio = np.where(df["has_pk"] & (pk_avg > 0),
                            np.minimum(df["pk_toi_per_gp"] / pk_avg, 1.0), 0)
    pp_claim = np.where(df["has_pp"], df["pp_toi_per_gp"], 0)
    pk_claim = np.where(df["has_pk"], df["pk_toi_per_gp"], 0)
    total_claim = pp_claim + pk_claim
    pp_share = np.where(total_claim > 0, pp_claim / total_claim, 0)
    pk_share = np.where(total_claim > 0, pk_claim / total_claim, 0)
    st_pool = BASE_WEIGHTS["Power Play"] + BASE_WEIGHTS["Penalty Kill"]  # 0.11
    df["w_pp"] = st_pool * pp_share * pp_toi_ratio
    df["w_pk"] = st_pool * pk_share * pk_toi_ratio
    st_leftover = st_pool - df["w_pp"] - df["w_pk"]
    st_to_offense = st_leftover * (0.5 + 0.5 * df["deployment_factor"])
    st_to_defense = st_leftover - st_to_offense
    df["w_5v5_offense"] = df["w_5v5_offense"] + st_to_offense
    df["w_5v5_defense"] = df["w_5v5_defense"] + st_to_defense

    # QoT adjustment
    for pg in ["F","D"]:
        m = df["pos_group"] == pg
        s = df.loc[m].copy()
        # Offensive QoT composite - higher = better offensive teammates
        pqo_xgf = np.where(s["qot_rapm_xgf"].notna(), pct_rank(s["qot_rapm_xgf"])*100, np.nan)
        pqo_cf  = np.where(s["qot_rapm_cf"].notna(), pct_rank(s["qot_rapm_cf"])*100, np.nan)
        pqo_gar = np.where(s["qot_off_xgar"].notna(), pct_rank(s["qot_off_xgar"])*100, np.nan)
        w1o = np.where(np.isfinite(pqo_xgf), 0.40, 0)
        w2o = np.where(np.isfinite(pqo_cf), 0.20, 0)
        w3o = np.where(np.isfinite(pqo_gar), 0.40, 0)
        wto = w1o + w2o + w3o
        pqo = np.where(wto > 0,
            (np.nan_to_num(pqo_xgf * w1o) + np.nan_to_num(pqo_cf * w2o) + np.nan_to_num(pqo_gar * w3o)) / np.maximum(wto, 0.01),
            np.where(s["qot_rapm_xg"].notna(), pct_rank(s["qot_rapm_xg"])*100, 50))

        # Defensive QoT composite - INVERT xga and ca (higher xGA/CA = worse def teammates = higher score)
        pqd_xga = np.where(s["qot_rapm_xga"].notna(), (1 - pct_rank(s["qot_rapm_xga"]))*100, np.nan)
        pqd_ca  = np.where(s["qot_rapm_ca"].notna(), (1 - pct_rank(s["qot_rapm_ca"]))*100, np.nan)
        pqd_gar = np.where(s["qot_def_xgar"].notna(), pct_rank(s["qot_def_xgar"])*100, np.nan)
        w1d = np.where(np.isfinite(pqd_xga), 0.40, 0)
        w2d = np.where(np.isfinite(pqd_ca), 0.20, 0)
        w3d = np.where(np.isfinite(pqd_gar), 0.40, 0)
        wtd = w1d + w2d + w3d
        pqd = np.where(wtd > 0,
            (np.nan_to_num(pqd_xga * w1d) + np.nan_to_num(pqd_ca * w2d) + np.nan_to_num(pqd_gar * w3d)) / np.maximum(wtd, 0.01),
            np.where(s["qot_rapm_xg"].notna(), pct_rank(s["qot_rapm_xg"])*100, 50))

        oz = (pqo - np.nanmean(pqo)) / max(np.nanstd(pqo), 1)
        dz = (pqd - np.nanmean(pqd)) / max(np.nanstd(pqd), 1)
        ob = np.clip(-oz * 0.5, -0.65, 0.65)
        db = np.clip(-dz * 0.5, -0.65, 0.65)
        for c in ["onice_xgf_per60","ev5_xg_per60","onice_gf_per60","hdcf_per60",
                   "onice_cf_per60","onice_ff_per60","rel_xgf_per60","rel_gf_per60"]:
            if c in s.columns: df.loc[m, c] = s[c] + ob * max(s[c].std(), 0.01)
        for c in ["onice_xga_per60","onice_ga_per60","hdca_per60","onice_ca_per60","rel_xga_per60"]:
            if c in s.columns: df.loc[m, c] = s[c] - db * max(s[c].std(), 0.01)

    # Percentile scoring by position
    for pg in ["F","D"]:
        m = df["pos_group"] == pg
        s = df.loc[m].copy()
        # Offense
        px = {k: pct_rank(s[k])*100 for k in ["onice_xgf_per60","ev5_xg_per60","onice_gf_per60",
              "hdcf_per60","onice_cf_per60","onice_ff_per60","rel_xgf_per60","rel_gf_per60"]}
        psh = np.where(s["onice_sh_pct"].notna(), (1-pct_rank(s["onice_sh_pct"]))*100, 50)
        pdq = np.where(s["qoc_def_xgar"].notna(), pct_rank(s["qoc_def_xgar"])*100,
                       np.where(s["qoc_rapm_xg"].notna(), pct_rank(s["qoc_rapm_xg"])*100, 50))
        if pg == "D":
            off_raw = px["onice_xgf_per60"]*0.27 + px["hdcf_per60"]*0.12 + px["onice_cf_per60"]*0.08 + px["onice_ff_per60"]*0.08 + px["rel_xgf_per60"]*0.29 + px["onice_gf_per60"]*0.04 + px["rel_gf_per60"]*0.02 + pdq*0.10
        else:
            off_raw = px["onice_xgf_per60"]*0.24 + px["ev5_xg_per60"]*0.07 + px["hdcf_per60"]*0.10 + px["onice_cf_per60"]*0.05 + px["onice_ff_per60"]*0.05 + px["rel_xgf_per60"]*0.30 + px["onice_gf_per60"]*0.04 + px["rel_gf_per60"]*0.05 + pdq*0.10

        # Defense
        dpc = {k: (1-pct_rank(s[k]))*100 for k in ["onice_xga_per60","onice_ga_per60","hdca_per60","onice_ca_per60","rel_xga_per60"]}
        dsv = np.where(s["onice_sv_pct"].notna(), (1-pct_rank(s["onice_sv_pct"]))*100, 50)
        dqc = np.where(s["qoc_rapm_xg"].notna(), pct_rank(s["qoc_rapm_xg"])*100, 50)
        dbl = pct_rank(s["ev5_blk_per60"])*100
        dtk = pct_rank(s["ev5_tk_per60"])*100
        if pg == "D":
            def_raw = dpc["onice_xga_per60"]*0.28 + dpc["hdca_per60"]*0.10 + dpc["onice_ca_per60"]*0.05 + dqc*0.10 + dbl*0.03 + dtk*0.04 + dsv*0.05 + dpc["onice_ga_per60"]*0.05 + dpc["rel_xga_per60"]*0.30
        else:
            def_raw = dpc["onice_xga_per60"]*0.28 + dpc["hdca_per60"]*0.12 + dpc["onice_ca_per60"]*0.05 + dqc*0.10 + dtk*0.05 + dsv*0.05 + dpc["onice_ga_per60"]*0.05 + dpc["rel_xga_per60"]*0.30

        # Production
        pg_g = pct_rank(s["all_g_per60"])*100
        pg_pa = pct_rank(s["all_pa_per60"])*100
        pg_sa = pct_rank(s["all_sa_per60"])*100
        prod = pg_g*0.30+pg_pa*0.40+pg_sa*0.30 if pg=="D" else pg_g*0.55+pg_pa*0.30+pg_sa*0.15

        # Penalties
        pen = (1 - pct_rank(s["penalty_ratio"])) * 100

        # QoC
        pqr = np.where(s["qoc_rapm_xg"].notna(), pct_rank(s["qoc_rapm_xg"])*100, np.nan)
        pdz = pct_rank(s["dz_shift_pct"])*100
        pqo2 = np.where(s["qoc_off_xgar"].notna(), pct_rank(s["qoc_off_xgar"])*100, np.nan)
        pqd2 = np.where(s["qoc_def_xgar"].notna(), pct_rank(s["qoc_def_xgar"])*100, np.nan)
        qoc_raw = np.where(np.isfinite(pqr),
            pqr*0.4 + pdz*0.2 + np.where(np.isfinite(pqo2), pqo2*0.2, pqr*0.2) + np.where(np.isfinite(pqd2), pqd2*0.2, pqr*0.2), np.nan)

        # Teammates
        etg = pct_rank(s["toi_min"]/s["gp"].clip(lower=1))*100
        ptg = pct_rank(s["toi_min_pp"].fillna(0)/s["gp"].clip(lower=1))*100
        ktg = pct_rank(s["toi_min_pk"].fillna(0)/s["gp"].clip(lower=1))*100
        team_raw = etg*0.50 + ptg*0.25 + ktg*0.25

        # PP
        ppg = pct_rank(s["pp_g_per60"])*100*0.50 + pct_rank(s["pp_pa_per60"])*100*0.30 + pct_rank(s["pp_sa_per60"])*100*0.20
        pp_raw = ppg*(3/7) + pct_rank(s["pp_onice_xgf_per60"])*100*(1/7) + pct_rank(s["pp_onice_gf_per60"])*100*(1/7) + pct_rank(s["pp_onice_hdcf_per60"])*100*(1/7) + pct_rank(s["pp_toi_per_gp"])*100*(1/7)
        pp_raw = np.where(s["has_pp"], pp_raw, np.nan)

        # PK
        pk_raw = ((1-pct_rank(s["pk_onice_xga_per60"]))*100*0.30 + pct_rank(s["pk_toi_per_gp"])*100*0.25 +
                  (1-pct_rank(s["pk_onice_hdca_per60"]))*100*0.18 + pct_rank(s["pk_blk_per60"])*100*0.12 +
                  pct_rank(s["pk_tk_per60"])*100*0.08 + (1-pct_rank(s["pk_onice_ca_per60"]))*100*0.07)
        pk_raw = np.where(s["has_pk"], pk_raw, np.nan)

        # Stretch
        df.loc[m, "cat_5v5_offense"] = stretch_v(pct_rank(pd.Series(off_raw, index=s.index))*100)
        df.loc[m, "cat_5v5_defense"] = stretch_v(pct_rank(pd.Series(def_raw, index=s.index))*100)
        df.loc[m, "cat_production"] = stretch_v(pct_rank(pd.Series(prod, index=s.index))*100)
        df.loc[m, "cat_penalties"] = stretch_v(pen)
        df.loc[m, "cat_teammates"] = stretch_v(pct_rank(pd.Series(team_raw, index=s.index))*100)

        qoc_s = pd.Series(qoc_raw, index=s.index)
        qv = qoc_s.notna()
        s["cat_qoc"] = np.nan
        if qv.sum() > 1:
            s.loc[qv, "cat_qoc"] = stretch_v(pct_rank(qoc_s[qv])*100)
        df.loc[m, "cat_qoc"] = s["cat_qoc"].values

        pp_s = pd.Series(pp_raw, index=s.index)
        ppv = pp_s.notna()
        s["cat_pp"] = np.nan
        if ppv.sum() > 1:
            s.loc[ppv, "cat_pp"] = stretch_v(pct_rank(pp_s[ppv])*100)
        df.loc[m, "cat_pp"] = s["cat_pp"].values

        pk_s = pd.Series(pk_raw, index=s.index)
        pkv = pk_s.notna()
        s["cat_pk"] = np.nan
        if pkv.sum() > 1:
            s.loc[pkv, "cat_pk"] = stretch_v(pct_rank(pk_s[pkv])*100)
        df.loc[m, "cat_pk"] = s["cat_pk"].values

    # Overall
    cc = ["cat_5v5_offense","cat_5v5_defense","cat_production","cat_pp","cat_pk","cat_penalties","cat_qoc","cat_teammates"]
    wc = ["w_5v5_offense","w_5v5_defense","w_production","w_pp","w_pk","w_penalties","w_competition","w_teammates"]
    cm = df[cc].values.copy(); wm = df[wc].values.copy()
    wm[np.isnan(cm)] = 0
    rs = wm.sum(axis=1); rs[rs==0] = 1; wm = wm / rs[:,None]
    cm[np.isnan(cm)] = 0
    df["overall_raw"] = (cm * wm).sum(axis=1)
    for pg in ["F","D"]:
        m = df["pos_group"]==pg
        df.loc[m, "overall_pctile"] = stretch_v(pct_rank(df.loc[m, "overall_raw"])*100)

    nc = df["name"].value_counts()
    df["display_name"] = df.apply(lambda r: f"{r['name']} ({r['position']})" if nc.get(r["name"],0)>1 else r["name"], axis=1)
    return df


# ============================================================
# GOALIE PIPELINE
# ============================================================

def parse_goalie_metrics(gdf, min_gp=MIN_GOALIE_GP):
    gdf = gdf.copy()
    for c in gdf.columns:
        if c not in ("name","team","situation"):
            gdf[c] = pd.to_numeric(gdf[c], errors="coerce")
    a = gdf[gdf["situation"]=="all"].copy()
    a = a[a["games_played"]>=min_gp]
    a["gp"]=a["games_played"]; a["icetime_sec"]=a["icetime"]; a["icetime_min"]=a["icetime_sec"]/60
    a["gsax_total"]=a["xGoals"]-a["goals"]
    a["hd_gsax"]=a["highDangerxGoals"]-a["highDangerGoals"]
    a["md_gsax"]=a["mediumDangerxGoals"]-a["mediumDangerGoals"]
    a["ld_gsax"]=a["lowDangerxGoals"]-a["lowDangerGoals"]
    h=a["icetime_sec"]/3600
    a["gsax_per60"]=a["gsax_total"]/h; a["hd_gsax_per60"]=a["hd_gsax"]/h
    a["md_gsax_per60"]=a["md_gsax"]/h; a["ld_gsax_per60"]=a["ld_gsax"]/h
    a["reb_per60"]=(a["xRebounds"]-a["rebounds"])/h
    a["shots_faced"]=a.get("lowDangerShots",0)+a.get("mediumDangerShots",0)+a.get("highDangerShots",0)
    a=a[a["gsax_per60"].notna()&(a["icetime_sec"]>0)]

    e5=gdf[gdf["situation"]=="5on5"].copy()
    e5["ev5_ice_sec"]=e5["icetime"]
    e5h=e5["ev5_ice_sec"]/3600
    e5["ev5_gsax_composite_per60"]=np.where(e5["ev5_ice_sec"]>0,
        ((e5["highDangerxGoals"]-e5["highDangerGoals"])*0.55+(e5["mediumDangerxGoals"]-e5["mediumDangerGoals"])*0.30+(e5["lowDangerxGoals"]-e5["lowDangerGoals"])*0.15)/e5h, np.nan)

    pk=gdf[gdf["situation"]=="4on5"].copy()
    pk["pk_ice_sec"]=pk["icetime"]; pk["pk_gsax"]=pk["xGoals"]-pk["goals"]
    pk["pk_gsax_per60"]=np.where(pk["pk_ice_sec"]>0, pk["pk_gsax"]/(pk["pk_ice_sec"]/3600), np.nan)

    tgp=gdf[gdf["situation"]=="all"].groupby("team")["games_played"].sum().reset_index().rename(columns={"games_played":"team_total_gp"})

    r=a[["name","team","gp","icetime_sec","icetime_min","gsax_total","gsax_per60","hd_gsax","hd_gsax_per60","md_gsax","md_gsax_per60","ld_gsax","ld_gsax_per60","reb_per60","shots_faced","rebounds","xRebounds"]].copy()
    r=r.merge(e5[["name","team","ev5_ice_sec","ev5_gsax_composite_per60"]], on=["name","team"], how="left")
    r=r.merge(pk[["name","team","pk_ice_sec","pk_gsax","pk_gsax_per60"]], on=["name","team"], how="left")
    r=r.merge(tgp, on="team", how="left")
    r["gp_share"]=r["gp"]/r["team_total_gp"].clip(lower=1)
    return r

def goalie_score_pipeline(df):
    df=df.copy()
    df["cat_ev5_gsax"]=stretch_v(np.where(df["ev5_gsax_composite_per60"].notna(), pct_rank(df["ev5_gsax_composite_per60"])*100, np.nan))
    df["cat_pk_gsax"]=stretch_v(np.where(df["pk_gsax_per60"].notna(), pct_rank(df["pk_gsax_per60"])*100, np.nan))
    for c,s in [("cat_hd_gsax","hd_gsax_per60"),("cat_md_gsax","md_gsax_per60"),("cat_ld_gsax","ld_gsax_per60"),("cat_rebound","reb_per60"),("cat_ice_time","gp_share")]:
        df[c]=stretch_v(pct_rank(df[s])*100)
    ck=["cat_ev5_gsax","cat_pk_gsax","cat_hd_gsax","cat_md_gsax","cat_ld_gsax","cat_rebound","cat_ice_time"]
    wv=list(GOALIE_WEIGHTS.values())
    def ro(row):
        cs=[row[k] for k in ck]; ok=[np.isfinite(c) for c in cs]
        tw=sum(w for w,o in zip(wv,ok) if o)
        return sum(c*w/tw for c,w,o in zip(cs,wv,ok) if o) if tw>0 else np.nan
    df["overall_raw"]=df.apply(ro, axis=1)
    df["overall_pctile"]=stretch_v(pct_rank(df["overall_raw"])*100)
    return df

def blend_goalie_years(year_dfs):
    parsed={}
    for yr,gdf in year_dfs.items():
        p=parse_goalie_metrics(gdf, min_gp=5); p["data_year"]=yr; p["yr_weight"]=ROLLING_WEIGHTS.get(yr,0); parsed[yr]=p
    ad=pd.concat(parsed.values(), ignore_index=True)
    ad["name_lower"]=ad["name"].apply(normalize_name)
    ad["eff_weight"]=ad["yr_weight"]*ad["icetime_min"].clip(lower=1)
    identity=(ad.sort_values("data_year",ascending=False).groupby("name_lower").first().reset_index()[["name_lower","name","team"]])
    sc=ad.groupby("name_lower").agg(has_recent=("data_year",lambda x:any(y in ["2025","2024"] for y in x)),ns=("data_year","nunique"),mg=("gp","max"),tg=("gp","sum")).reset_index()
    sc=sc[sc["has_recent"]&(sc["tg"]>=40)&((sc["ns"]>=2)|(sc["mg"]>=20))]
    el=ad[ad["name_lower"].isin(sc["name_lower"])].copy()
    rc=["gsax_per60","hd_gsax_per60","md_gsax_per60","ld_gsax_per60","reb_per60","ev5_gsax_composite_per60","pk_gsax_per60"]
    def wg(g):
        r={}
        for c in rc:
            v=g[c].notna()
            r[c]=np.average(g.loc[v,c],weights=g.loc[v,"eff_weight"]) if v.sum()>0 else np.nan
        r["gp"]=g["gp"].sum(); r["icetime_sec"]=g["icetime_sec"].sum(); r["icetime_min"]=g["icetime_min"].sum()
        for c in ["gsax_total","hd_gsax","md_gsax","ld_gsax","shots_faced"]:
            r[c]=(g[c]*g["yr_weight"]).sum()
        r["gp_share"]=np.average(g["gp_share"],weights=g["yr_weight"])
        return pd.Series(r)
    bl=el.groupby("name_lower").apply(wg, include_groups=False).reset_index()
    return identity.merge(bl, on="name_lower").drop(columns=["name_lower"])


# ============================================================
# JSON OUTPUT
# ============================================================

def skater_to_json(row):
    cats={}
    for cn,col,wk in [("5v5 Offense","cat_5v5_offense","w_5v5_offense"),("5v5 Defense","cat_5v5_defense","w_5v5_defense"),
                       ("Production","cat_production","w_production"),("Power Play","cat_pp","w_pp"),
                       ("Penalty Kill","cat_pk","w_pk"),("Penalties","cat_penalties","w_penalties"),
                       ("Competition","cat_qoc","w_competition"),("Teammates","cat_teammates","w_teammates")]:
        v=row.get(col); w=row.get(wk,0)
        cats[cn]={"pctile":round(v,1) if pd.notna(v) and np.isfinite(v) else None, "weight":round(w,4) if pd.notna(w) else 0}
    return {
        "name":row.get("name",""), "display_name":row.get("display_name",row.get("name","")),
        "team":team_nhl(row.get("team","")), "team_raw":str(row.get("team","")),
        "position":row.get("position",""), "pos_group":row.get("pos_group",""),
        "gp":int(row["gp"]) if pd.notna(row.get("gp")) else 0,
        "toi_min":round(row.get("toi_min",0)) if pd.notna(row.get("toi_min")) else 0,
        "oz_shift_pct":round(row.get("oz_shift_pct",0),1) if pd.notna(row.get("oz_shift_pct")) else None,
        "overall_pctile":round(row["overall_pctile"],1) if pd.notna(row.get("overall_pctile")) else None,
        "categories":cats, "olympic_country":get_olympic_country(row.get("name","")),
    }

def goalie_to_json(row):
    cats={}
    for cn,col in [("5v5 GSAx","cat_ev5_gsax"),("Penalty Kill","cat_pk_gsax"),("High Danger GSAx","cat_hd_gsax"),
                    ("Med Danger GSAx","cat_md_gsax"),("Low Danger GSAx","cat_ld_gsax"),
                    ("Rebound Control","cat_rebound"),("Ice Time","cat_ice_time")]:
        v=row.get(col)
        cats[cn]={"pctile":round(v,1) if pd.notna(v) and np.isfinite(v) else None, "weight":round(GOALIE_WEIGHTS[cn],4)}
    return {
        "name":row.get("name",""), "team":team_nhl(row.get("team","")),
        "gp":int(row["gp"]) if pd.notna(row.get("gp")) else 0,
        "icetime_hrs":round(row.get("icetime_sec",0)/3600) if pd.notna(row.get("icetime_sec")) else 0,
        "gsax_total":round(row.get("gsax_total",0),1) if pd.notna(row.get("gsax_total")) else None,
        "gsax_per60":round(row.get("gsax_per60",0),2) if pd.notna(row.get("gsax_per60")) else None,
        "gp_share":round(row.get("gp_share",0)*100) if pd.notna(row.get("gp_share")) else None,
        "overall_pctile":round(row["overall_pctile"],1) if pd.notna(row.get("overall_pctile")) else None,
        "categories":cats, "olympic_country":get_olympic_country(row.get("name","")),
        "raw_per60":{"ev5_gsax":round(row.get("ev5_gsax_composite_per60",0),2) if pd.notna(row.get("ev5_gsax_composite_per60")) else None,
                     "pk_gsax":round(row.get("pk_gsax_per60",0),2) if pd.notna(row.get("pk_gsax_per60")) else None,
                     "hd_gsax":round(row.get("hd_gsax_per60",0),2) if pd.notna(row.get("hd_gsax_per60")) else None,
                     "md_gsax":round(row.get("md_gsax_per60",0),2) if pd.notna(row.get("md_gsax_per60")) else None,
                     "ld_gsax":round(row.get("ld_gsax_per60",0),2) if pd.notna(row.get("ld_gsax_per60")) else None,
                     "reb":round(row.get("reb_per60",0),2) if pd.notna(row.get("reb_per60")) else None},
    }


# ============================================================
# MAIN
# ============================================================

def run_pipeline(data_dir, mode="2025-26", output_dir=None):
    if output_dir is None: output_dir = data_dir
    print(f"Hockey pipeline: mode={mode}, data_dir={data_dir}")

    # Skaters
    if mode == "3-Year Rolling":
        ydfs={}; yscored={}
        for yr in ["2025","2024","2023"]:
            csvs=load_year_csvs(data_dir, yr)
            if "5v5_indiv" in csvs:
                ydfs[yr]=parse_year_data(csvs)
                yf=ydfs[yr][ydfs[yr]["toi_min"]>=200].copy()
                if len(yf)>=20:
                    try: yscored[yr]=score_pipeline(yf)
                    except Exception as e: print(f"  Warn: {yr}: {e}")
        if len(ydfs)<2: print("ERROR: need 2+ years"); return
        df=blend_years(ydfs)
    else:
        yr=YEAR_LABELS.get(mode, mode)
        csvs=load_year_csvs(data_dir, yr)
        if "5v5_indiv" not in csvs: print(f"ERROR: no data for {yr}"); return
        df=parse_year_data(csvs)
        df=df[df["toi_min"]>=MIN_TOI_PER_YEAR]
        yscored={}

    df=score_pipeline(df)
    print(f"  {len(df)} skaters ({(df['pos_group']=='F').sum()} F, {(df['pos_group']=='D').sum()} D)")
    skaters=[skater_to_json(r) for _,r in df.iterrows()]

    # Trends
    st={}
    if mode=="3-Year Rolling" and yscored:
        yl={"2025":"25-26","2024":"24-25","2023":"23-24"}
        for yr,sc in yscored.items():
            for _,r in sc.iterrows():
                dn=r.get("display_name",r.get("name",""))
                st.setdefault(dn,[]).append({"season":yl.get(yr,yr),
                    "offense":round(r["cat_5v5_offense"],1) if pd.notna(r.get("cat_5v5_offense")) else None,
                    "defense":round(r["cat_5v5_defense"],1) if pd.notna(r.get("cat_5v5_defense")) else None,
                    "overall":round(r["overall_pctile"],1) if pd.notna(r.get("overall_pctile")) else None})

    # Goalies
    ensure_goalie_data(data_dir)
    gj=[]; gt={}
    try:
        if mode=="3-Year Rolling":
            gydf={}; gys={}
            for season,fname in GOALIE_FILE_MAP.items():
                p=os.path.join(data_dir, fname)
                if os.path.exists(p):
                    gdf=read_csv_safe(p); yk=YEAR_LABELS[season]; gydf[yk]=gdf
                    try:
                        yp=parse_goalie_metrics(gdf, min_gp=10)
                        if len(yp)>=5: gys[yk]=goalie_score_pipeline(yp)
                    except: pass
            if len(gydf)>=2:
                gb=blend_goalie_years(gydf); gs=goalie_score_pipeline(gb)
                gj=[goalie_to_json(r) for _,r in gs.iterrows()]
                yl={"2025":"25-26","2024":"24-25","2023":"23-24"}
                for yr,sc in gys.items():
                    for _,r in sc.iterrows():
                        gt.setdefault(r["name"],[]).append({"season":yl.get(yr,yr),
                            "hd_gsax":round(r["cat_hd_gsax"],1) if pd.notna(r.get("cat_hd_gsax")) else None,
                            "md_gsax":round(r["cat_md_gsax"],1) if pd.notna(r.get("cat_md_gsax")) else None,
                            "ld_gsax":round(r["cat_ld_gsax"],1) if pd.notna(r.get("cat_ld_gsax")) else None})
        else:
            p=os.path.join(data_dir, GOALIE_FILE_MAP.get(mode,""))
            if os.path.exists(p):
                gdf=read_csv_safe(p); gp=parse_goalie_metrics(gdf)
                if len(gp)>=5: gs=goalie_score_pipeline(gp); gj=[goalie_to_json(r) for _,r in gs.iterrows()]
        print(f"  {len(gj)} goalies")
    except Exception as e: print(f"  Goalie warn: {e}")

    output={"mode":mode,"skaters":skaters,"goalies":gj,"skater_trends":st,"goalie_trends":gt,
            "weights":{"skater":{k:round(v,4) for k,v in BASE_WEIGHTS.items()},
                       "goalie":{k:round(v,4) for k,v in GOALIE_WEIGHTS.items()}}}
    fname_map={"3-Year Rolling":"hockey_data_rolling.json","2025-26":"hockey_data_2025.json",
               "2024-25":"hockey_data_2024.json","2023-24":"hockey_data_2023.json"}
    fname=fname_map.get(mode,"hockey_data.json")
    op=os.path.join(output_dir, fname)
    os.makedirs(output_dir, exist_ok=True)
    with open(op,"w") as f: json.dump(output, f, indent=2, default=str)
    print(f"  -> {op}")
    return output

if __name__=="__main__":
    dd=sys.argv[1] if len(sys.argv)>1 else "."
    md=sys.argv[2] if len(sys.argv)>2 else "2025-26"
    if md=="rolling": md="3-Year Rolling"
    od=sys.argv[3] if len(sys.argv)>3 else dd
    if md=="all":
        for m in ["3-Year Rolling","2025-26","2024-25","2023-24"]:
            print(f"\n--- {m} ---")
            run_pipeline(dd, m, od)
    else:
        run_pipeline(dd, md, od)

    # ── Generate headshots.json and logos.json ──
    if HAS_REQUESTS:
        print("\n--- Fetching NHL headshots & logos ---")
        NHL_TEAMS = ["ANA","BOS","BUF","CAR","CBJ","CGY","CHI","COL","DAL","DET","EDM","FLA",
                     "LAK","MIN","MTL","NJD","NSH","NYI","NYR","OTT","PHI","PIT","SEA","SJS",
                     "STL","TBL","TOR","UTA","VAN","VGK","WPG","WSH"]
        headshots = {}
        logos = {}
        for t in NHL_TEAMS:
            try:
                r = requests.get(f"https://api-web.nhle.com/v1/roster/{t}/current", timeout=10)
                if r.status_code != 200:
                    print(f"  {t}: HTTP {r.status_code}")
                    continue
                d = r.json()
                for pos in ["forwards","defensemen","goalies"]:
                    for p in d.get(pos,[]):
                        fn = p.get("firstName",{}).get("default","")
                        ln = p.get("lastName",{}).get("default","")
                        name = f"{fn} {ln}".strip()
                        if name and p.get("headshot"):
                            headshots[name] = p["headshot"]
                logos[t] = f"https://assets.nhle.com/logos/nhl/svg/{t}_light.svg"
                time.sleep(0.3)
            except Exception as e:
                print(f"  {t}: {e}")
        # Also map NST abbreviations to logo URLs
        NST_MAP = {"L.A":"LAK","N.J":"NJD","S.J":"SJS","T.B":"TBL"}
        for nst, nhl in NST_MAP.items():
            if nhl in logos:
                logos[nst] = logos[nhl]
        hp = os.path.join(od, "headshots.json")
        lp = os.path.join(od, "logos.json")
        with open(hp,"w") as f: json.dump(headshots, f, separators=(',',':'))
        with open(lp,"w") as f: json.dump(logos, f, separators=(',',':'))
        print(f"  {len(headshots)} headshots -> {hp}")
        print(f"  {len(logos)} logos -> {lp}")
    else:
        print("\n  Skipping headshots (install requests: pip install requests)")

