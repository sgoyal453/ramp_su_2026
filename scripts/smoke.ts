/**
 * End-to-end smoke test against a running server:
 * create league -> two WS clients join -> trades (long + short) ->
 * host starts a fast match -> assert live updates and final settlement.
 *
 *   PORT=3210 tsx scripts/smoke.ts
 */
import WebSocket from "ws";
import assert from "node:assert/strict";
import type { LeagueStateDTO, ServerMessage } from "../src/lib/types";

const base = `http://localhost:${process.env.PORT ?? 3210}`;
const wsBase = base.replace("http", "ws");

function connect(code: string, username: string) {
  const ws = new WebSocket(`${wsBase}/ws`);
  const states: LeagueStateDTO[] = [];
  const errors: string[] = [];
  let events = 0;
  const opened = new Promise<void>((resolve) => ws.on("open", resolve));
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data)) as ServerMessage;
    if (msg.type === "state") states.push(msg.state);
    if (msg.type === "event") events++;
    if (msg.type === "error") errors.push(msg.message);
  });
  return {
    ws,
    states,
    errors,
    countEvents: () => events,
    latest: () => states[states.length - 1],
    async join() {
      await opened;
      ws.send(JSON.stringify({ type: "join", code, username }));
      await waitFor(() => states.length > 0, `${username} join state`);
    },
    send: (msg: object) => ws.send(JSON.stringify(msg)),
  };
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 90_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// 1. Create a league with a ~36-second match (matchRealMinutes floor is 1;
//    the server clamps, so use 1 real minute).
const res = await fetch(`${base}/api/league`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "sid", buyIn: 1000, matchRealMinutes: 1 }),
});
const { code } = await res.json();
assert.ok(code, "league code returned");
console.log(`✓ league created: ${code}`);

// 2. Two clients join.
const sid = connect(code, "sid");
const bob = connect(code, "bob");
await sid.join();
await bob.join();
await waitFor(() => sid.latest().users.length === 2, "both users visible");
assert.equal(sid.latest().host, "sid");
assert.equal(sid.latest().you?.cash, 100_000);
assert.ok(sid.latest().players.every((p) => !("skill" in p)), "skill is hidden");
console.log("✓ both clients joined; skill hidden; starting cash correct");

// 3. Non-host cannot start.
bob.send({ type: "start" });
await waitFor(() => bob.errors.some((e) => e.includes("host")), "host-only error");
console.log("✓ non-host start rejected");

// 4. Trades: bob longs the star, sid shorts a bench forward; both see new price.
const STAR = "egy-mohamed-salah";
const BENCH_FWD = "egy-omar-marmoush";
const starBefore = sid.latest().prices[STAR];
bob.send({ type: "trade", playerId: STAR, shares: 100 });
await waitFor(() => (bob.latest().you?.positions[STAR] ?? 0) === 100, "bob position");
await waitFor(() => sid.latest().prices[STAR] > starBefore, "price moved for sid too");
sid.send({ type: "trade", playerId: BENCH_FWD, shares: -200 });
await waitFor(() => (sid.latest().you?.positions[BENCH_FWD] ?? 0) === -200, "sid short open");
assert.ok(sid.latest().you!.cash > 100_000, "short proceeds credited");
console.log("✓ buy + short executed; price moves broadcast to everyone");

// 5. Over-spend and over-short are rejected.
bob.send({ type: "trade", playerId: STAR, shares: 9999 });
await waitFor(() => bob.errors.some((e) => e.includes("insufficient") || e.includes("cap")), "risk-check error");
console.log("✓ over-sized trade rejected");

// 6. Host starts; match runs ~60s; events + minutes stream.
sid.send({ type: "start" });
await waitFor(() => sid.latest().status === "live", "match live");
console.log("✓ match started; waiting for full time (~60s)…");
await waitFor(() => sid.latest().status === "settled", "settlement", 120_000);

const final = sid.latest();
// The committed fixture has a fixed number of verified events (goals, cards,
// subs, plus a derived ASSIST event per assisted goal) — same every run.
assert.equal(sid.countEvents(), 24, `events streamed (${sid.countEvents()})`);
assert.equal(final.minute, 90);
assert.ok(final.settlements && Object.keys(final.settlements).length === final.players.length, "all markets settled");
assert.equal(Object.keys(final.you!.positions).length, 0, "positions converted to cash");
assert.equal(final.leaderboard.length, 2);
assert.ok(final.leaderboard[0].value >= final.leaderboard[1].value, "leaderboard sorted");
assert.ok(final.history[STAR].length >= 91, "price history sampled per minute");

console.log(`✓ full time — score: ${JSON.stringify(final.score)}`);
console.log(`✓ ${sid.countEvents()} events streamed to clients`);
console.log("✓ final leaderboard:");
for (const [i, entry] of final.leaderboard.entries()) {
  console.log(`   ${i + 1}. ${entry.username} — $${entry.value.toFixed(2)}`);
}

sid.ws.close();
bob.ws.close();
console.log("\nALL SMOKE CHECKS PASSED");
