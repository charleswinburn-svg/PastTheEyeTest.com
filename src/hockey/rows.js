// What each graphic shows: labels, columns and hover text. Ported from the ratings notebook's
// dashboard (section 21) so the site and the notebook describe every number the same way.
// `v` is the ratings version: "3y" (current value) or "1y" (this season only).

export const VERSIONS = [
  { id: "3y", label: "3-year", long: "3-year ratings (current value)" },
  { id: "1y", label: "1-year", long: "1-year ratings (this season only)" },
];
export const POSITION_NAME = { C: "Center", L: "Left wing", R: "Right wing", D: "Defense", G: "Goalie" };
export const GROUP_NAME = { F: "forwards", D: "defensemen", G: "goalies" };

// ── percentile rows: [label, percentile column, what it is] ──
export const skaterRows = v => [
  ["WAR", `war_${v}_pct`, "Wins above replacement: total value, so it rewards playing more."],
  ["Individual Impact", `impact_${v}_pct`, "Goals above average per 60 minutes, all components combined."],
  ["EV Offense", `off_${v}_pct`, "Isolated effect on his team's expected goals at 5v5."],
  ["EV Defense", `def_${v}_pct`, "Isolated effect on expected goals against at 5v5."],
  ["Power Play", `pp_off_${v}_pct`, "Isolated effect on expected goals with the man advantage."],
  ["Penalty Kill", `pk_def_${v}_pct`, "Isolated effect on expected goals against while shorthanded."],
  ["Finishing", `fin_${v}_pct`, "Goals above expected and goal scoring."],
  ["Playmaking", `play_${v}_pct`, "Primary and secondary assists, weighted by situation."],
  ["Penalties", `pen_${v}_pct`, "Minor penalties drawn minus taken."],
  ["Competition", `competition_${v}_pct`, "Context, not skill: quality of the opponents he faces at 5v5."],
  ["Teammates", `teammates_${v}_pct`, "Context, not skill: quality of the linemates he plays with at 5v5."],
];
export const goalieRows = v => [
  ["WAR", `war_${v}_pct`, "Wins above replacement: total value, so it rewards playing more."],
  ["Individual Impact", `impact_${v}_pct`, "Goals saved above average per game's worth of shots: the rate behind WAR."],
  ["Team-adjusted GSAA", `adj100_${v}_pct`, "Goals saved above average per 100 shots after allowing for the team in front of him and the shooters he faced."],
  ["GSAx, all shots", `gsax100_${v}_pct`, "Goals saved above expected per 100 shots, before any adjustment."],
  ["5v5 GSAx", `gsax5v5_100_${v}_pct`, "Goals saved above expected per 100 shots at 5v5."],
  ["GSAx vs power play", `gsaxpk_100_${v}_pct`, "Goals saved above expected per 100 shots while his team is shorthanded."],
  ["Low danger", `gsaxlow_100_${v}_pct`, "Shots with under a 5% chance of scoring."],
  ["Medium danger", `gsaxmed_100_${v}_pct`, "Shots with a 5 to 15% chance of scoring."],
  ["High danger", `gsaxhigh_100_${v}_pct`, "Shots with over a 15% chance of scoring."],
  ["Rebound control", `reb100_${v}_pct`, "Rebound shots allowed against what his saves would be expected to produce."],
  ["Win prob. added", `wpa1000_${v}_pct`, "Goals saved, weighted by how much each one mattered to the result."],
];

// The rating behind a percentile column, as text ("off_3y_pct" -> off_3y).
const RAW_DECIMALS = { off: 3, def: 3, pp_off: 3, pk_def: 3, competition: 3, teammates: 3, adj100: 3 };
export function rawValue(p, pctCol) {
  const stem = pctCol.slice(0, -4);
  const col = stem.startsWith("pen_") ? stem.replace("pen_", "pen_diff60_") : stem;
  const x = p[col];
  if (x == null) return null;
  return fixed(x, RAW_DECIMALS[stem.slice(0, -3)] ?? 2);
}

// ── where WAR comes from: [label, column stem, what it is]; column is `${stem}_${v}`, in wins ──
export const SKATER_PARTS = [
  ["EV Offense", "war_off", "Expected goals he adds for his team at 5v5."],
  ["EV Defense", "war_def", "Expected goals he takes away from opponents at 5v5."],
  ["Power Play", "war_pp", "Expected goals he adds with the man advantage."],
  ["Penalty Kill", "war_pk", "Expected goals he takes away while shorthanded."],
  ["Shooting results", "war_shoot", "Goals above expected on his own shots."],
  ["Setup results", "war_setup", "Goals above expected on teammates' shots while he is on the ice."],
  ["Penalties", "war_pen", "Minor penalties drawn minus taken, at the goal value of a minor."],
];
export const GOALIE_PARTS = [
  ["5v5 GSAx", "war_5v5", "Goals saved above expected at 5v5, against a replacement goalie."],
  ["GSAx vs power play", "war_pk", "Goals saved above expected while his team is shorthanded, against a replacement goalie."],
  ["GSAx, other", "war_other", "4-on-4, 3-on-3, his own team's power play and anything else."],
  ["Shooter, team adj.", "war_adj", "Credit for the finishing skill of the shooters he faced; in the 3-year version also the team in front of him and the pull toward average for small samples."],
  ["Rebound control", "war_reb", "Goals saved by giving up fewer rebound shots than expected."],
];

// ── z-scores against the league average: [label, value column]. The league mean, spread and sign
//    come with the season file (z_ref), computed among the players ranked on that row. ──
export const skaterZ = v => [
  ["On-ice xG for /60", `xgf60_${v}`], ["On-ice xG against /60", `xga60_${v}`],
  ["Finishing", `fin_${v}`], ["Playmaking", `play_${v}`],
  ["Power play", `pp_off_${v}`], ["Penalty kill", `pk_def_${v}`],
  ["Quality of competition", `competition_${v}`], ["Quality of teammates", `teammates_${v}`],
];
export const goalieZ = v => [
  ["Team-adj. GSAA /100", `adj100_${v}`], ["GSAx /100", `gsax100_${v}`],
  ["5v5 GSAx /100", `gsax5v5_100_${v}`], ["GSAx vs PP /100", `gsaxpk_100_${v}`],
  ["Low danger /100", `gsaxlow_100_${v}`], ["Medium danger /100", `gsaxmed_100_${v}`],
  ["High danger /100", `gsaxhigh_100_${v}`], ["Rebound control /100", `reb100_${v}`],
  ["Win prob. added /1,000", `wpa1000_${v}`],
];
export function zScores(p, rows, ref) {
  return rows.map(([label, col]) => {
    const r = ref?.[col];
    const value = p[col];
    const ranked = r && value != null && p[r.ranked] != null;
    return { label, col, value, mean: r?.mean, n: r?.n, z: ranked ? r.sign * (value - r.mean) / r.sd : null };
  });
}

// ── goalie season totals for "the numbers" ──
export const GOALIE_TOTALS = [
  ["GSAx, all shots", "gsax"], ["GSAx at 5v5", "gsax_5v5"], ["GSAx vs the power play", "gsax_pk"],
  ["GSAx, low danger", "gsax_low"], ["GSAx, medium danger", "gsax_med"], ["GSAx, high danger", "gsax_high"],
  ["Rebound control, goals saved", "reb_saved"], ["Win probability added, wins", "wpa"],
];

// ── impact by season ──
export const MEASURES = [
  { id: "WAR", col: "war", tier: "tier_war", unit: "Wins above replacement" },
  { id: "GAR", col: "gar", tier: "tier_gar", unit: "Goals above replacement" },
  { id: "GAA", col: "gaa", tier: "tier_gaa", unit: "Goals above average" },
];

// ── leaderboard columns: [group, header, column, decimals, what it is, colour direction]
//    colour direction: 1 = higher is better, -1 = lower is better, 0 = never coloured ──
export const LB_GROUPS = ["WAR and Impact", "Season totals", "Ratings", "Percentiles"];
export const leaderboardColumns = (kind, v) => (kind === "skaters" ? [
  ["WAR and Impact", "WAR", `war_${v}`, 2, "Wins above replacement.", 1],
  ["WAR and Impact", "GAR", `gar_${v}`, 1, "Goals above replacement.", 1],
  ["WAR and Impact", "GAA", `gaa_${v}`, 1, "Goals above average.", 1],
  ["WAR and Impact", "Impact/60", `impact_${v}`, 2, "Individual Impact: goals above average per 60 minutes.", 1],
  ["WAR and Impact", "Off WAR", `war_off_${v}`, 2, "Wins from EV offense.", 1],
  ["WAR and Impact", "Def WAR", `war_def_${v}`, 2, "Wins from EV defense.", 1],
  ["WAR and Impact", "PP WAR", `war_pp_${v}`, 2, "Wins from the power play.", 1],
  ["WAR and Impact", "PK WAR", `war_pk_${v}`, 2, "Wins from the penalty kill.", 1],
  ["WAR and Impact", "Shoot WAR", `war_shoot_${v}`, 2, "Wins from goals above expected on his own shots.", 1],
  ["WAR and Impact", "Setup WAR", `war_setup_${v}`, 2, "Wins from goals above expected on teammates' shots.", 1],
  ["WAR and Impact", "Pen WAR", `war_pen_${v}`, 2, "Wins from penalties drawn minus taken.", 1],
  ["Season totals", "G", "goals", 0, "Goals.", 1],
  ["Season totals", "A1", "a1", 0, "Primary assists.", 1],
  ["Season totals", "A2", "a2", 0, "Secondary assists.", 1],
  ["Season totals", "PTS", "points", 0, "Points.", 1],
  ["Season totals", "EVP", "ev_points", 0, "Even-strength points.", 1],
  ["Season totals", "PPP", "pp_points", 0, "Power-play points.", 1],
  ["Season totals", "SHP", "sh_points", 0, "Shorthanded points.", 1],
  ["Season totals", "ixG", "ixg", 1, "His own expected goals.", 1],
  ["Season totals", "GAx", "gax", 1, "Goals above expected on his own shots.", 1],
  ["Season totals", "Pen drawn", "pen_drawn", 0, "Minor penalties drawn.", 1],
  ["Season totals", "Pen taken", "pen_taken", 0, "Minor penalties taken.", -1],
  ["Ratings", "EV Off", `off_${v}`, 3, "Isolated effect on xG for per 60 at 5v5.", 1],
  ["Ratings", "EV Def", `def_${v}`, 3, "Isolated effect on xG against per 60 at 5v5. Higher is better.", 1],
  ["Ratings", "PP", `pp_off_${v}`, 3, "Isolated effect on xG for per 60 on the power play.", 1],
  ["Ratings", "PK", `pk_def_${v}`, 3, "Isolated effect on xG against per 60 on the penalty kill. Higher is better.", 1],
  ["Ratings", "Finishing", `fin_${v}`, 2, "Finishing score.", 1],
  ["Ratings", "Playmaking", `play_${v}`, 2, "Playmaking score.", 1],
  ["Ratings", "Pen/60", `pen_diff60_${v}`, 2, "Minor penalties drawn minus taken per 60.", 1],
  ["Ratings", "xGF/60", `xgf60_${v}`, 2, "Raw on-ice xG for per 60 at 5v5.", 1],
  ["Ratings", "xGA/60", `xga60_${v}`, 2, "Raw on-ice xG against per 60 at 5v5. Lower is better.", -1],
  ["Ratings", "QoC", `competition_${v}`, 3, "Quality of competition (context, not skill).", 0],
  ["Ratings", "QoT", `teammates_${v}`, 3, "Quality of teammates (context, not skill).", 0],
  ["Percentiles", "EV Off %", `off_${v}_pct`, 0, "Percentile within position.", 1],
  ["Percentiles", "EV Def %", `def_${v}_pct`, 0, "Percentile within position.", 1],
  ["Percentiles", "PP %", `pp_off_${v}_pct`, 0, "Percentile within position.", 1],
  ["Percentiles", "PK %", `pk_def_${v}_pct`, 0, "Percentile within position.", 1],
  ["Percentiles", "Finishing %", `fin_${v}_pct`, 0, "Percentile within position.", 1],
  ["Percentiles", "Playmaking %", `play_${v}_pct`, 0, "Percentile within position.", 1],
  ["Percentiles", "Penalties %", `pen_${v}_pct`, 0, "Percentile within position.", 1],
  ["Percentiles", "QoC %", `competition_${v}_pct`, 0, "Percentile within position (context, not skill).", 0],
  ["Percentiles", "QoT %", `teammates_${v}_pct`, 0, "Percentile within position (context, not skill).", 0],
] : [
  ["WAR and Impact", "WAR", `war_${v}`, 2, "Wins above replacement, built on GSAx.", 1],
  ["WAR and Impact", "GAR", `gar_${v}`, 1, "Goals saved above replacement.", 1],
  ["WAR and Impact", "GSAA", `gaa_${v}`, 1, "Goals saved above average, as used in WAR.", 1],
  ["WAR and Impact", "Impact/GP", `impact_${v}`, 2, "Individual Impact: goals saved above average per game's worth of shots.", 1],
  ["WAR and Impact", "5v5 WAR", `war_5v5_${v}`, 2, "Wins from GSAx at 5v5.", 1],
  ["WAR and Impact", "vs PP WAR", `war_pk_${v}`, 2, "Wins from GSAx against the power play.", 1],
  ["WAR and Impact", "Other WAR", `war_other_${v}`, 2, "Wins from GSAx in other situations.", 1],
  ["WAR and Impact", "Adj WAR", `war_adj_${v}`, 2, "Shooter and team adjustment.", 1],
  ["WAR and Impact", "Rebound WAR", `war_reb_${v}`, 2, "Wins from rebound control.", 1],
  ["Season totals", "GA", "ga", 0, "Goals against on unblocked shots with the net occupied.", 0],
  ["Season totals", "xGA", "xga", 1, "Expected goals against.", 0],
  ["Season totals", "GSAx", "gsax", 1, "Goals saved above expected.", 1],
  ["Season totals", "5v5 GSAx", "gsax_5v5", 1, "Goals saved above expected at 5v5.", 1],
  ["Season totals", "vs PP GSAx", "gsax_pk", 1, "Goals saved above expected against the power play.", 1],
  ["Season totals", "Low GSAx", "gsax_low", 1, "Low-danger shots.", 1],
  ["Season totals", "Med GSAx", "gsax_med", 1, "Medium-danger shots.", 1],
  ["Season totals", "High GSAx", "gsax_high", 1, "High-danger shots.", 1],
  ["Season totals", "Rebound GS", "reb_saved", 1, "Goals saved through rebound control.", 1],
  ["Season totals", "WPA", "wpa", 2, "Win probability added, in wins.", 1],
  ["Ratings", "Team-adj/100", `adj100_${v}`, 3, "Team-adjusted goals saved above average per 100 shots.", 1],
  ["Ratings", "GSAx/100", `gsax100_${v}`, 2, "Goals saved above expected per 100 shots.", 1],
  ["Ratings", "5v5/100", `gsax5v5_100_${v}`, 2, "At 5v5, per 100 shots.", 1],
  ["Ratings", "vs PP/100", `gsaxpk_100_${v}`, 2, "Against the power play, per 100 shots.", 1],
  ["Ratings", "Low/100", `gsaxlow_100_${v}`, 2, "Low danger, per 100 shots.", 1],
  ["Ratings", "Med/100", `gsaxmed_100_${v}`, 2, "Medium danger, per 100 shots.", 1],
  ["Ratings", "High/100", `gsaxhigh_100_${v}`, 2, "High danger, per 100 shots.", 1],
  ["Ratings", "Rebound/100", `reb100_${v}`, 2, "Rebound control per 100 saves.", 1],
  ["Ratings", "WPA/1000", `wpa1000_${v}`, 2, "Win probability added per 1,000 shots.", 1],
  ["Percentiles", "Team-adj %", `adj100_${v}_pct`, 0, "Percentile among goalies.", 1],
  ["Percentiles", "GSAx %", `gsax100_${v}_pct`, 0, "Percentile among goalies.", 1],
  ["Percentiles", "5v5 %", `gsax5v5_100_${v}_pct`, 0, "Percentile among goalies.", 1],
  ["Percentiles", "vs PP %", `gsaxpk_100_${v}_pct`, 0, "Percentile among goalies.", 1],
  ["Percentiles", "Low %", `gsaxlow_100_${v}_pct`, 0, "Percentile among goalies.", 1],
  ["Percentiles", "Med %", `gsaxmed_100_${v}_pct`, 0, "Percentile among goalies.", 1],
  ["Percentiles", "High %", `gsaxhigh_100_${v}_pct`, 0, "Percentile among goalies.", 1],
  ["Percentiles", "Rebound %", `reb100_${v}_pct`, 0, "Percentile among goalies.", 1],
  ["Percentiles", "WPA %", `wpa1000_${v}_pct`, 0, "Percentile among goalies.", 1],
]).map(([group, head, col, dec, tip, dir]) => ({ group, head, col, dec, tip, dir }));

// ── number formatting: a minus sign for negatives, nothing in front of positives ──
const MINUS = "−";
export function fixed(x, d = 2) {
  if (x == null || !isFinite(x)) return "–";
  const s = Math.abs(x).toFixed(d);
  return (x < 0 && Number(s) !== 0 ? MINUS : "") + s;
}
export const whole = x => (x == null ? "–" : Math.round(x).toLocaleString("en-US"));
