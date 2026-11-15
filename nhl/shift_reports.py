"""Shift charts from the NHL's printed shift reports, for games its shift API has nothing for.

The stats API (`shiftcharts`) sometimes returns no rows for a run of games; a whole week
in October 2026 is like that. The league still publishes each game's "TOI Shift Report"
as a web page, one for the home team and one for the visitors:

    https://www.nhl.com/scores/htmlreports/20262027/TH020154.HTM     (TV... for the visitors)

Each player has a heading ("6 LOHREI, MASON") followed by one row per shift: shift number,
period, start and end as "elapsed / remaining", and the length. Players are matched to
their NHL ids by team and sweater number, using the roster in the game's play-by-play.

`fetch` returns the same slim list the scraper notebook caches from the API:
[[player_id, team_id, period, start_seconds, end_seconds], ...].
"""
import re

URL = "https://www.nhl.com/scores/htmlreports/{season}/{side}{code}.HTM"
HEADING = re.compile(r'<td[^>]*class="[^"]*playerHeading[^"]*"[^>]*>\s*(\d+)\s+([^<]*?)\s*</td>', re.I)
CELL = r"<td[^>]*>\s*{}\s*</td>\s*"
SHIFT = re.compile(CELL.format(r"\d+") + CELL.format(r"(\d+|OT)") +
                   CELL.format(r"(\d+):(\d+)\s*/\s*\d+:\d+") + CELL.format(r"(\d+):(\d+)\s*/\s*\d+:\d+"), re.I)


def parse(html, team_id, by_number):
    """Shift rows for one team's report. `by_number` maps sweater number to player id."""
    out, unknown = [], []
    heads = list(HEADING.finditer(html))
    for k, h in enumerate(heads):
        pid = by_number.get(int(h.group(1)))
        if pid is None:
            unknown.append(f"{h.group(1)} {h.group(2)}")
            continue
        block = html[h.end():heads[k + 1].start() if k + 1 < len(heads) else len(html)]
        for per, m1, s1, m2, s2 in SHIFT.findall(block):
            period = 4 if per.upper() == "OT" else int(per)
            st, en = int(m1) * 60 + int(s1), int(m2) * 60 + int(s2)
            if en > st:
                out.append([int(pid), int(team_id), period, st, en])
    return out, unknown


def fetch(game_id, pbp, session, log=None):
    """Both teams' shifts for one game, or None when either report is missing or unreadable."""
    gid = str(game_id)
    season, code = f"{gid[:4]}{int(gid[:4]) + 1}", gid[4:]
    shifts = []
    for side, team in (("TH", pbp["homeTeam"]), ("TV", pbp["awayTeam"])):
        by_number = {p["sweaterNumber"]: p["playerId"] for p in pbp.get("rosterSpots", [])
                     if p.get("teamId") == team["id"] and p.get("sweaterNumber") is not None}
        try:
            r = session.get(URL.format(season=season, side=side, code=code), timeout=30,
                            headers={"User-Agent": "Mozilla/5.0 (compatible; xg-research/0.1)"})
        except Exception:
            return None
        if r.status_code != 200:
            return None
        rows, unknown = parse(r.content.decode("utf-8", errors="replace"), team["id"], by_number)
        if unknown and log:
            log(f"shift report {gid} {team['abbrev']}: no roster match for {unknown}")
        if len({row[0] for row in rows}) < 12:          # a real report lists 18 skaters and a goalie or two
            return None
        shifts += rows
    return shifts
