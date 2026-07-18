/**
 * Terminal demo: run a full simulated match with live LMSR markets in ~15s.
 *
 *   node server/simulator/demo.js [seed] [realSeconds]
 */
import { createDefaultRoster } from "../src/lib/engine/roster";
import { MatchSimulator } from "../src/lib/engine/matchSimulator";
import { createLeagueMarkets } from "../src/lib/engine/playerMarket";

const seed = Number(process.argv[2] ?? 7);
const realSeconds = Number(process.argv[3] ?? 15);

const players = createDefaultRoster();
const markets = createLeagueMarkets(players.map(({ id, b, initialQ }) => ({ id, b, initialQ })));
const sim = new MatchSimulator({ players, markets, seed, realDurationMs: realSeconds * 1000 });

const name = Object.fromEntries(players.map((p) => [p.id, p.name]));

sim.on("kickoff", ({ teams }) => console.log(`⚽ Kickoff: ${teams.join(" vs ")}  (seed ${seed})\n`));
sim.on("event", (e) => {
  const price = markets.get(e.playerId)!.price().toFixed(2);
  console.log(`${e.commentary}  [${name[e.playerId]} → $${price}]`);
});
sim.on("fulltime", ({ score, settlements }) => {
  console.log(`\n🏁 Full time: ${Object.entries(score).map(([t, g]) => `${t} ${g}`).join(" — ")}\n`);
  const table = [...settlements]
    .sort((a, b) => b[1] - a[1])
    .map(([id, v]) => ({ player: name[id], "settled at": `$${v.toFixed(2)}` }));
  console.table(table);
});

sim.start();
// Keep the process alive until fulltime (timer is unref'd).
const keepAlive = setInterval(() => sim.finished && clearInterval(keepAlive), 200);
