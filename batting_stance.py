"""Baseball Savant swing-path / bat-tracking leaderboard — intercept-point and
batter-position geometry used to place home plate exactly relative to the batter's
center of mass on the hitter card. NOTE: this endpoint returns ONE row per player
(it does not split switch hitters by side), so callers reuse a player's single row
for both L/R panels — a switch hitter's stances are ~mirror images.

  avg_intercept_y_vs_plate  - avg intercept depth vs the FRONT of the plate (inches, +toward pitcher)
  avg_intercept_y_vs_batter - avg intercept depth vs the batter's center of mass
  avg_batter_y_position     - batter COM depth behind the plate front (= vs_batter - vs_plate)
  avg_batter_x_position     - batter COM lateral distance off the plate's near edge

The plate FRONT is avg_batter_y_position in front of the COM; the plate CENTER is
(avg_batter_x_position + 8.5) to the contact side of the COM. Network failures raise
so callers can fall back to the per-pitch derivation.
"""
import io

_URL = ("https://baseballsavant.mlb.com/leaderboard/bat-tracking/swing-path-attack-angle"
        "?dateStart={y}-03-01&dateEnd={y}-11-30&gameType=Regular"
        "&minSwings=1&minGroupSwings=1&seasonStart={y}&seasonEnd={y}&type=batter&csv=true")

_FIELDS = ['avg_intercept_y_vs_plate', 'avg_intercept_y_vs_batter',
           'avg_batter_y_position', 'avg_batter_x_position']


def fetch_batting_stance(season, timeout=120):
    """Return {(mlbam_id, 'L'|'R'): {field: value, …}} for the season. Raises on
    network/parse failure."""
    import requests
    import pandas as pd
    r = requests.get(_URL.format(y=season), headers={'User-Agent': 'Mozilla/5.0'}, timeout=timeout)
    r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.text))
    out = {}
    for _, row in df.iterrows():
        try:
            bid = int(row['id'])
            side = str(row['side']).strip().upper()[:1]
        except Exception:
            continue
        if side not in ('L', 'R'):
            continue
        rec = {}
        ok = True
        for k in _FIELDS:
            v = row.get(k)
            if v is None or (isinstance(v, float) and pd.isna(v)):
                ok = False
                break
            rec[k] = float(v)
        if ok:
            out[(bid, side)] = rec
    return out
