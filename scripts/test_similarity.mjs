// node scripts/test_similarity.mjs [pitcher-file.json]
// Sanity checks for src/baseball/similarity.js against the committed hitter
// files (and an optional pitcher file). Exits non-zero on failure.
import { readFileSync, existsSync } from "node:fs";
import { unpackFile, rankComps, comparePlayers } from "../src/baseball/similarity.js";

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"} ${msg}`); if (!ok) failures++; };
const load = p => unpackFile(JSON.parse(readFileSync(p, "utf8")));

// ── Hitters ──
const hPools = [2023, 2024, 2025, 2026].map(y => `public/similarity_hitters_${y}.json`).filter(existsSync).map(load);
check(hPools.length >= 1, `loaded ${hPools.length} hitter seasons`);
const cur = hPools[hPools.length - 1];
const pid = Object.keys(cur.players)[0];
const metaA = { ...cur.meta, type: "hitter" };
const self = comparePlayers(cur.players[pid], metaA, cur.players[pid], cur.meta);
check(self && Math.abs(self.overall - 100) < 1e-9, "identical hitter → 100% overall");
check(Object.values(self.comps).every(c => c.sim === 100), "identical hitter → 100% every component");

const other = Object.keys(cur.players)[5];
const ab = comparePlayers(cur.players[pid], metaA, cur.players[other], cur.meta);
const ba = comparePlayers(cur.players[other], metaA, cur.players[pid], cur.meta);
check(Math.abs(ab.overall - ba.overall) < 1e-9, "hitter distance is symmetric");

const r = rankComps({ season: cur.season, pid }, hPools, { limit: 10 });
check(r.results.length === 10, "rankComps returns 10 comps");
check(!r.results.some(x => x.self && String(x.season) === String(cur.season)), "target's own season excluded");
check(r.results.every((x, i, a) => i === 0 || a[i - 1].overall >= x.overall), "results sorted by overall desc");
const rz = rankComps({ season: cur.season, pid }, hPools, { limit: 10, weights: { swing: 0 } });
check(rz.results.every(x => x.comps.swing && (x.comps.swing.sim ?? 0) >= 0), "zero-weight component still reported");

// Missing-feature handling: wipe one swing feature → component still computable
const clone = JSON.parse(JSON.stringify(cur.players[other]));
clone.v.attack_direction = null;
const miss = comparePlayers(cur.players[pid], metaA, clone, cur.meta);
check(miss.comps.swing.sim != null, "one missing swing feature → swing component still scored");
const wipe = JSON.parse(JSON.stringify(cur.players[other]));
for (const k of cur.meta.components.swing.features) wipe.v[k] = null;
const none = comparePlayers(cur.players[pid], metaA, wipe, cur.meta);
check(none.comps.swing.sim == null && none.overall != null, "all swing features missing → component null, overall from the rest");

const sameHand = rankComps({ season: cur.season, pid }, hPools, { limit: 50, sameHand: true });
const th = cur.players[pid].hand;
check(sameHand.results.every(x => !x.hand || !th || x.hand === "S" || th === "S" || x.hand === th), "sameHand filter respected");
console.log(`  top hitter comps for ${cur.players[pid].name} (${cur.season}):`,
  r.results.slice(0, 5).map(x => `${x.name} ${x.season} ${x.overall.toFixed(0)}%`).join(" | "));

// ── Pitchers (optional file) ──
const pFile = process.argv[2] || "public/similarity_pitchers_2026.json";
if (existsSync(pFile)) {
  const pool = load(pFile);
  const pm = { ...pool.meta, type: "pitcher" };
  const ids = Object.keys(pool.players);
  const a = ids[0];
  const s = comparePlayers(pool.players[a], pm, pool.players[a], pool.meta);
  check(s && Math.abs(s.overall - 100) < 1e-9, "identical pitcher → 100% overall");
  const b = ids[3];
  const x = comparePlayers(pool.players[a], pm, pool.players[b], pool.meta);
  const y = comparePlayers(pool.players[b], pm, pool.players[a], pool.meta);
  check(Math.abs(x.overall - y.overall) < 1e-6, "pitcher distance is symmetric");
  check(x.comps.arsenal.sim != null, "arsenal component scored");
  if (pool.players["900000"] && pool.players["900001"]) {
    const rr = rankComps({ season: pool.season, pid: "900000" }, [pool], { limit: 3 });
    check(rr.results[0]?.pid === "900001" && rr.results[0].overall > 95,
      `mirrored LHP twin is the #1 comp of its RHP (${rr.results[0]?.overall?.toFixed(1)}%)`);
  }
  const rp = rankComps({ season: pool.season, pid: a }, [pool], { limit: 5 });
  console.log(`  top pitcher comps for ${pool.players[a].name}:`,
    rp.results.map(z => `${z.name} ${z.overall.toFixed(0)}%`).join(" | "));
} else {
  console.log(`(no pitcher file at ${pFile} — pitcher checks skipped)`);
}

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log("all checks passed");
