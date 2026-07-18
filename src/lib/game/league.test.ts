import { test } from "node:test";
import assert from "node:assert/strict";

import { League, MAX_USERS } from "./league";

// Real ids from the committed Argentina-Egypt fixture (src/data/fixtures).
const MESSI = "arg-lionel-messi";
const SALAH = "egy-mohamed-salah";

function newLeague() {
  // Tiny real duration; tests drive the sim manually via runToCompletion.
  return new League({ code: "TEST01", host: "alice", matchRealMinutes: 0.01 });
}

test("host joins on creation; joins are idempotent; league caps at MAX_USERS", () => {
  const league = newLeague();
  assert.deepEqual([...league.users.keys()], ["alice"]);
  league.addUser("bob");
  league.addUser("bob");
  assert.equal(league.users.size, 2);
  for (let i = 0; i < MAX_USERS - 2; i++) league.addUser(`user${i}`);
  assert.throws(() => league.addUser("late"), /full/);
});

test("buy debits cash by the LMSR cost and records the position", () => {
  const league = newLeague();
  const before = league.users.get("alice")!.cash;
  const fill = league.trade("alice", MESSI, 100);
  assert.ok(fill.cost > 0);
  assert.equal(league.users.get("alice")!.cash, before - fill.cost);
  assert.equal(league.users.get("alice")!.positions.get(MESSI), 100);
  // Everyone in the league sees the moved price.
  assert.equal(league.toDTO("bob").prices[MESSI], league.markets.get(MESSI)!.price());
});

test("cannot spend more cash than you have", () => {
  const league = newLeague();
  assert.throws(() => league.trade("alice", MESSI, 10_000), /insufficient cash|max/);
});

test("shorts require full collateral within cash", () => {
  const league = newLeague();
  // startingCash 100k, priceScale 100 -> absolute max ~1000 short shares.
  assert.throws(() => league.trade("alice", SALAH, -2000), /short exposure cap/);
  const fill = league.trade("alice", SALAH, -500);
  assert.ok(fill.cost < 0, "short pays the trader now");
  assert.equal(league.users.get("alice")!.positions.get(SALAH), -500);
});

test("selling an owned position back to zero clears it", () => {
  const league = newLeague();
  league.trade("alice", MESSI, 50);
  league.trade("alice", MESSI, -50);
  assert.equal(league.users.get("alice")!.positions.has(MESSI), false);
  // Round trip with no market movement in between is cash neutral.
  assert.ok(Math.abs(league.users.get("alice")!.cash - league.startingCash) < 1e-6);
});

test("only the host can start, and only from the lobby", () => {
  const league = newLeague();
  league.addUser("bob");
  assert.throws(() => league.start("bob"), /only the host/);
  league.start("alice");
  assert.equal(league.status, "live");
  assert.throws(() => league.start("alice"), /already live/);
  league.sim!.stop();
});

test("full match: history sampled per minute, settlement converts positions to cash", () => {
  const league = newLeague();
  league.addUser("bob");
  const events: number[] = [];
  league.start("alice", { onMinute: (m) => events.push(m) });
  league.sim!.stop(); // drive manually instead of on the timer
  league.trade("alice", SALAH, 200); // long Egypt's star
  league.trade("bob", SALAH, -200); // bob shorts him
  league.sim!.runToCompletion();

  assert.equal(league.status, "settled");
  assert.equal(events.length, 90);
  assert.ok(league.settlements);
  for (const p of league.fixture.players) {
    assert.equal(league.history[p.id].length, 92); // kickoff + 90 minutes + settlement
  }
  // Positions are gone; all value is cash; leaderboard is consistent.
  for (const user of league.users.values()) assert.equal(user.positions.size, 0);
  const board = league.leaderboard();
  assert.equal(board.length, 2);
  assert.ok(board[0].value >= board[1].value);
  for (const entry of board) assert.equal(entry.value, entry.cash);
  // Long + short on the same player are zero-sum against each other modulo
  // price movement between the two trades; both must at least be finite.
  assert.ok(board.every((e) => Number.isFinite(e.cash)));
  // Trading after settlement is rejected.
  assert.throws(() => league.trade("alice", SALAH, 1), /trading closed/);
});

test("toDTO hides no fixture internals it shouldn't, personalizes portfolio, and serializes cleanly", () => {
  const league = newLeague();
  league.trade("alice", MESSI, 10);
  const dto = league.toDTO("alice");
  assert.equal(dto.you?.username, "alice");
  assert.equal(dto.you?.positions[MESSI], 10);
  assert.equal(league.toDTO(null).you, null);
  assert.equal(dto.fixture.homeTeam, "Argentina");
  assert.equal(dto.fixture.awayTeam, "Egypt");
  JSON.stringify(dto); // must be JSON-safe for the wire
});
