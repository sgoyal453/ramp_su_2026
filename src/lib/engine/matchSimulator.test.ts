import { test } from "node:test";
import assert from "node:assert/strict";

import { createRng, poisson, weightedPick } from "./rng";
import { createDefaultRoster, publicPlayer, TEAMS } from "./roster";
import {
  MatchSimulator,
  generateTimeline,
  normalizeScore,
  EVENT_TYPES,
  type MatchEvent,
  type FullTimeResult,
} from "./matchSimulator";
import { createLeagueMarkets } from "./playerMarket";

function newMatch({ seed = 7 } = {}) {
  const players = createDefaultRoster();
  const markets = createLeagueMarkets(players.map(({ id, b, initialQ }) => ({ id, b, initialQ })));
  return { players, markets, sim: new MatchSimulator({ players, markets, seed }) };
}

// ---------------------------------------------------------------------------
// RNG
// ---------------------------------------------------------------------------

test("rng is deterministic per seed and uniform-ish", () => {
  const a = createRng(42);
  const b = createRng(42);
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
  const c = createRng(43);
  assert.notEqual(createRng(42)(), c());
});

test("poisson mean approximates lambda", () => {
  const rng = createRng(1);
  let sum = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) sum += poisson(rng, 0.25);
  assert.ok(Math.abs(sum / n - 0.25) < 0.02);
});

test("weightedPick respects weights and rejects all-zero", () => {
  const rng = createRng(5);
  const counts = [0, 0, 0];
  for (let i = 0; i < 9000; i++) counts[weightedPick(rng, [1, 2, 0])]++;
  assert.equal(counts[2], 0);
  assert.ok(counts[1] > counts[0] * 1.6);
  assert.equal(weightedPick(rng, [0, 0]), -1);
});

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

test("roster has 18 players, 9 per team, with valid fields", () => {
  const players = createDefaultRoster();
  assert.equal(players.length, 18);
  for (const team of Object.values(TEAMS)) {
    assert.equal(players.filter((p) => p.team === team).length, 9);
  }
  const ids = new Set(players.map((p) => p.id));
  assert.equal(ids.size, 18);
  for (const p of players) {
    assert.ok(p.skill > 0 && p.skill < 1);
    assert.ok(p.b > 0);
    assert.ok(["GK", "DEF", "MID", "FWD"].includes(p.position));
  }
});

test("publicPlayer strips the hidden skill rating", () => {
  const p = createDefaultRoster()[0]!;
  const pub = publicPlayer(p);
  assert.equal("skill" in pub, false);
  assert.equal(pub.name, p.name);
  assert.equal(pub.id, p.id);
});

// ---------------------------------------------------------------------------
// Timeline generation
// ---------------------------------------------------------------------------

test("timeline is plausible: sane goal count, ordered minutes, known players", () => {
  const players = createDefaultRoster();
  const ids = new Set(players.map((p) => p.id));
  for (const seed of [1, 2, 3, 4, 5]) {
    const timeline = generateTimeline(players, createRng(seed));
    const goals = timeline.filter((e) => e.type === "GOAL").length;
    assert.ok(goals <= 12, `absurd goal count ${goals}`);
    assert.ok(timeline.length > 40 && timeline.length < 400, `event count ${timeline.length}`);
    let last = 0;
    for (const e of timeline) {
      assert.ok(e.minute >= last && e.minute >= 1 && e.minute <= 90);
      last = e.minute;
      assert.ok(ids.has(e.playerId));
      assert.ok(e.commentary.startsWith(`${e.minute}'`));
      assert.ok(EVENT_TYPES[e.type]);
    }
  }
});

test("same seed produces the identical timeline, different seeds differ", () => {
  const players = createDefaultRoster();
  const a = generateTimeline(players, createRng(9));
  const b = generateTimeline(players, createRng(9));
  assert.deepEqual(a, b);
  const c = generateTimeline(players, createRng(10));
  assert.notDeepEqual(a, c);
});

test("substitutions never happen before minute 55", () => {
  const players = createDefaultRoster();
  for (const seed of [1, 2, 3]) {
    for (const e of generateTimeline(players, createRng(seed))) {
      if (e.type === "SUBSTITUTION") assert.ok(e.minute >= 55);
    }
  }
});

test("higher-skill players earn more points on average across many matches", () => {
  const players = createDefaultRoster();
  const totals = new Map(players.map((p) => [p.id, 0]));
  for (let seed = 1; seed <= 40; seed++) {
    const sim = new MatchSimulator({ players, seed });
    sim.runToCompletion();
    for (const [id, pts] of sim.pointsByPlayer) totals.set(id, (totals.get(id) ?? 0) + pts);
  }
  const star = totals.get("wol-fwd-10")!; // skill 0.88 forward
  const journeyman = totals.get("fal-def-4")!; // skill 0.45 defender
  assert.ok(star > journeyman, `star ${star} should out-earn journeyman ${journeyman}`);
});

// ---------------------------------------------------------------------------
// Match flow + market integration
// ---------------------------------------------------------------------------

test("events flow through applySignal and move only that player's market", () => {
  const { sim, markets } = newMatch();
  const before = new Map([...markets].map(([id, m]) => [id, m.price()]));
  // Advance until the first market-moving event fires.
  let moved: MatchEvent | null = null;
  sim.on("event", (e: MatchEvent) => {
    if (!moved && e.signalShares !== 0) moved = e;
  });
  while (!moved && !sim.finished) sim.advanceMinute();
  assert.ok(moved, "expected at least one market-moving event");
  const found: MatchEvent = moved;
  const delta = markets.get(found.playerId)!.price() - before.get(found.playerId)!;
  assert.ok(found.signalShares > 0 ? delta > 0 : delta < 0);
});

test("full match settles every market at the normalized final score", () => {
  const { sim, markets, players } = newMatch();
  let fulltime: FullTimeResult | null = null;
  sim.on("fulltime", (ft: FullTimeResult) => (fulltime = ft));
  sim.runToCompletion();
  assert.ok(fulltime);
  const result: FullTimeResult = fulltime;
  for (const p of players) {
    const m = markets.get(p.id)!;
    assert.ok(m.settled);
    const score = result.finalScores.get(p.id)!;
    assert.ok(score >= 0 && score <= 1);
    assert.equal(result.settlements.get(p.id), score * m.priceScale);
    assert.equal(normalizeScore(sim.pointsByPlayer.get(p.id)!), score);
    assert.throws(() => m.trade(1), /settled/);
  }
  assert.ok(Object.values(result.score).every((g) => g >= 0));
});

test("event ordering: minute events fire in order and clock stops at 90", () => {
  const sim = new MatchSimulator({ players: createDefaultRoster(), seed: 7 });
  const minutes: number[] = [];
  sim.on("minute", (m: { minute: number }) => minutes.push(m.minute));
  sim.runToCompletion();
  assert.equal(minutes.length, 90);
  assert.deepEqual(minutes.slice(0, 3), [1, 2, 3]);
  assert.equal(sim.minute, 90);
  assert.ok(sim.finished);
  // Advancing after full time is a no-op.
  sim.advanceMinute();
  assert.equal(sim.minute, 90);
});

test("start() drives the match on a compressed clock", async () => {
  const players = createDefaultRoster();
  // 90 simulated minutes compressed into ~0.45s of real time.
  const sim = new MatchSimulator({ players, seed: 3, realDurationMs: 450 });
  const done = new Promise((resolve) => sim.on("fulltime", resolve));
  let kickedOff = false;
  sim.on("kickoff", () => (kickedOff = true));
  sim.start();
  assert.throws(() => sim.start(), /already started/);
  await done;
  assert.ok(kickedOff);
  assert.ok(sim.finished);
  assert.equal(sim.minute, 90);
});

test("normalizeScore maps points into [0,1], clamping negatives", () => {
  assert.equal(normalizeScore(-5), 0);
  assert.equal(normalizeScore(0), 0);
  assert.ok(normalizeScore(10) > 0.4 && normalizeScore(10) < 0.6);
  assert.ok(normalizeScore(100) > 0.85 && normalizeScore(100) < 1);
  for (const pts of [1, 5, 20]) assert.ok(normalizeScore(pts + 1) > normalizeScore(pts));
});
