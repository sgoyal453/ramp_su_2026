import { test } from "node:test";
import assert from "node:assert/strict";

import {
  logSumExp,
  softplus,
  inverseSoftplus,
  cost,
  prices,
  tradeCost,
  binaryPrice,
  binaryTradeCost,
  binarySharesForCost,
} from "./lmsr";
import { PlayerMarket, createLeagueMarkets } from "./playerMarket";

const approx = (actual: number, expected: number, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < eps, `expected ${actual} ≈ ${expected}`);

// ---------------------------------------------------------------------------
// Core math
// ---------------------------------------------------------------------------

test("logSumExp matches naive computation and survives huge inputs", () => {
  approx(logSumExp([0, 0]), Math.log(2));
  approx(logSumExp([1, 2, 3]), Math.log(Math.exp(1) + Math.exp(2) + Math.exp(3)));
  // Naive exp() would overflow to Infinity here.
  approx(logSumExp([1000, 1000]), 1000 + Math.log(2));
  approx(logSumExp([-1000, 1000]), 1000, 1e-6);
});

test("softplus and inverseSoftplus are inverses across magnitudes", () => {
  for (const x of [-50, -3, -0.1, 0, 0.1, 3, 50, 500]) {
    approx(inverseSoftplus(softplus(x)), x, 1e-6);
  }
});

test("prices are a proper distribution and favor higher q", () => {
  const q = [10, 0, -10];
  const p = prices(q, 100);
  approx(p.reduce((a, x) => a + x, 0), 1);
  assert.ok(p[0] > p[1] && p[1] > p[2]);
  for (const pi of p) assert.ok(pi > 0 && pi < 1);
});

test("vector tradeCost equals cost difference", () => {
  const q = [5, -3];
  const delta = [7, 0];
  const b = 50;
  approx(tradeCost(q, delta, b), cost([12, -3], b) - cost(q, b));
});

test("binary closed form agrees with 2-outcome vector form", () => {
  const b = 80;
  for (const q of [-200, -5, 0, 5, 200]) {
    approx(binaryPrice(q, b), prices([q, 0], b)[0], 1e-12);
    approx(binaryTradeCost(q, 17, b), tradeCost([q, 0], [17, 0], b), 1e-9);
  }
});

test("cost is path independent: one big trade == many small trades", () => {
  const b = 60;
  const big = binaryTradeCost(0, 90, b);
  let piecewise = 0;
  let q = 0;
  for (let i = 0; i < 90; i++) {
    piecewise += binaryTradeCost(q, 1, b);
    q += 1;
  }
  approx(piecewise, big, 1e-9);
});

test("buying costs more than spot, selling returns less (price impact)", () => {
  const b = 100;
  const n = 50;
  const spot = binaryPrice(0, b) * n;
  assert.ok(binaryTradeCost(0, n, b) > spot); // buys walk the price up
  assert.ok(-binaryTradeCost(0, -n, b) < spot); // sells walk it down
});

test("binarySharesForCost inverts binaryTradeCost", () => {
  const b = 75;
  for (const q of [-40, 0, 120]) {
    for (const n of [1, 33.5, 400]) {
      const spend = binaryTradeCost(q, n, b);
      approx(binarySharesForCost(q, spend, b), n, 1e-6);
    }
  }
});

test("binarySharesForCost rejects spends that drain the whole market", () => {
  assert.throws(() => binarySharesForCost(0, -1000, 10), RangeError);
});

// ---------------------------------------------------------------------------
// PlayerMarket
// ---------------------------------------------------------------------------

test("fresh market opens at half the price scale", () => {
  const m = new PlayerMarket({ playerId: "p1", priceScale: 100 });
  approx(m.price(), 50);
  approx(m.probability(), 0.5);
});

test("buys raise the price, sells lower it, for everyone", () => {
  const m = new PlayerMarket({ playerId: "p1", b: 100 });
  const before = m.price();
  m.trade(200);
  const afterBuy = m.price();
  assert.ok(afterBuy > before);
  m.trade(-300);
  assert.ok(m.price() < afterBuy);
});

test("quote does not mutate state; trade charges exactly the quote", () => {
  const m = new PlayerMarket({ playerId: "p1" });
  const quoted = m.quote(120);
  approx(m.price(), 50); // unchanged by quoting
  const fill = m.trade(120);
  approx(fill.cost, quoted);
});

test("immediate round trip is cash neutral", () => {
  const m = new PlayerMarket({ playerId: "p1", b: 90 });
  const buy = m.trade(250);
  const sell = m.trade(-250);
  approx(buy.cost + sell.cost, 0, 1e-9);
  approx(m.price(), 50);
});

test("lower b means bigger price impact for the same trade", () => {
  const rookie = new PlayerMarket({ playerId: "rookie", b: 40 });
  const veteran = new PlayerMarket({ playerId: "vet", b: 400 });
  rookie.trade(100);
  veteran.trade(100);
  assert.ok(rookie.price() - 50 > veteran.price() - 50);
});

test("shorting profits when the price falls", () => {
  const m = new PlayerMarket({ playerId: "p1", b: 100 });
  const short = m.trade(-150); // open short: receive cash now
  assert.ok(short.cost < 0);
  m.applySignal(-400); // bad match events push the price further down
  const cover = m.trade(150); // buy back cheaper
  assert.ok(cover.cost > 0);
  assert.ok(-short.cost > cover.cost, "short should net a profit");
});

test("sharesForSpend sizes a buy that costs the spend", () => {
  const m = new PlayerMarket({ playerId: "p1", b: 120 });
  const shares = m.sharesForSpend(1000);
  const fill = m.trade(shares);
  approx(fill.cost, 1000, 1e-6);
});

test("bot signals move price through the same mechanism as user trades", () => {
  const viaUser = new PlayerMarket({ playerId: "a", b: 100 });
  const viaBot = new PlayerMarket({ playerId: "b", b: 100 });
  viaUser.trade(75);
  viaBot.applySignal(75);
  approx(viaUser.price(), viaBot.price(), 1e-12);
});

test("settlement fixes the price, pays longs and charges shorts, closes trading", () => {
  const m = new PlayerMarket({ playerId: "p1", priceScale: 100 });
  m.settle(0.8);
  approx(m.price(), 80);
  approx(m.payout(10), 800); // long
  approx(m.payout(-10), -800); // short owes
  assert.throws(() => m.trade(1), /settled/);
  assert.throws(() => m.quote(1), /settled/);
  assert.throws(() => m.settle(0.5), /already settled/);
});

test("settle validates score range and payout requires settlement", () => {
  const m = new PlayerMarket({ playerId: "p1" });
  assert.throws(() => m.payout(5), /not settled/);
  assert.throws(() => m.settle(1.2), RangeError);
  assert.throws(() => m.settle(-0.1), RangeError);
  assert.throws(() => m.settle(NaN), RangeError);
});

test("market stays sane under a long random trade sequence", () => {
  const m = new PlayerMarket({ playerId: "p1", b: 50 });
  let net = 0;
  // Deterministic pseudo-random walk (no Math.random for reproducibility).
  for (let i = 1; i <= 2000; i++) {
    const shares = ((i * 7919) % 41) - 20; // in [-20, 20]
    m.trade(shares);
    net += shares;
    const p = m.price();
    assert.ok(p > 0 && p < m.priceScale && Number.isFinite(p));
  }
  // Unwinding the whole net position returns to the opening price.
  m.trade(-net);
  approx(m.price(), 50, 1e-9);
});

// ---------------------------------------------------------------------------
// League factory
// ---------------------------------------------------------------------------

test("createLeagueMarkets builds one market per player with overrides", () => {
  const markets = createLeagueMarkets(
    [
      { id: "striker-9", b: 40 }, // volatile hype player
      { id: "keeper-1" }, // takes league default
      { id: "vet-4", initialQ: 100 }, // opens above $50 as a favorite
    ],
    { b: 200, priceScale: 100 },
  );
  assert.equal(markets.size, 3);
  assert.equal(markets.get("striker-9")!.b, 40);
  assert.equal(markets.get("keeper-1")!.b, 200);
  assert.ok(markets.get("vet-4")!.price() > 50);
  // Markets are independent: trading one leaves the others untouched.
  markets.get("striker-9")!.trade(500);
  approx(markets.get("keeper-1")!.price(), 50);
});

test("createLeagueMarkets rejects duplicate player ids", () => {
  assert.throws(() => createLeagueMarkets([{ id: "x" }, { id: "x" }]), /duplicate/);
});
