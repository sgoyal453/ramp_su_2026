/**
 * Core LMSR (Logarithmic Market Scoring Rule) math.
 *
 * Everything in this file works in "probability space": prices are in (0, 1)
 * and costs are in the same abstract units as the liquidity parameter `b`.
 * Dollar scaling / per-player state lives in playerMarket.ts.
 *
 * Cost function:            C(q) = b * ln( sum_i e^(q_i / b) )
 * Instantaneous price:      p_i  = e^(q_i / b) / sum_j e^(q_j / b)
 * Cost to trade a delta:    C(q + delta) - C(q)
 *
 * All functions are pure. `q` is the vector of net shares outstanding per
 * outcome. For the binary (per-player) markets we also expose closed-form
 * helpers that track only the net long/short quantity on the "performance"
 * side, with the complementary outcome pinned at q = 0 — mathematically
 * identical to the 2-outcome vector form, but O(1) and numerically tidy.
 */

/** Numerically stable ln(sum(e^x_i)). */
export function logSumExp(xs: number[]): number {
  let m = -Infinity;
  for (const x of xs) if (x > m) m = x;
  if (!Number.isFinite(m)) return m; // all -Infinity (or empty)
  let s = 0;
  for (const x of xs) s += Math.exp(x - m);
  return m + Math.log(s);
}

/** Numerically stable softplus: ln(1 + e^x). */
export function softplus(x: number): number {
  return x > 0 ? x + Math.log1p(Math.exp(-x)) : Math.log1p(Math.exp(x));
}

/** Inverse of softplus: ln(e^y - 1), for y > 0. */
export function inverseSoftplus(y: number): number {
  if (y <= 0) throw new RangeError(`inverseSoftplus requires y > 0, got ${y}`);
  // For large y, e^y - 1 ~ e^y and ln(e^y - 1) = y + ln(1 - e^-y).
  return y > 30 ? y : Math.log(Math.expm1(y));
}

// ---------------------------------------------------------------------------
// General n-outcome LMSR (vector form)
// ---------------------------------------------------------------------------

/** C(q) = b * ln(sum e^(q_i/b)) */
export function cost(q: number[], b: number): number {
  return b * logSumExp(q.map((qi) => qi / b));
}

/** Instantaneous price vector; sums to 1. */
export function prices(q: number[], b: number): number[] {
  const scaled = q.map((qi) => qi / b);
  const lse = logSumExp(scaled);
  return scaled.map((x) => Math.exp(x - lse));
}

/** Cost to move the market from q to q + delta (negative = trader is paid). */
export function tradeCost(q: number[], delta: number[], b: number): number {
  const after = q.map((qi, i) => qi + (delta[i] ?? 0));
  return cost(after, b) - cost(q, b);
}

// ---------------------------------------------------------------------------
// Binary LMSR, closed form (one tradeable side, complement pinned at 0)
// ---------------------------------------------------------------------------
// q here is the scalar net shares outstanding on the "performance" outcome.
// C(q) = b * ln(e^(q/b) + 1) = b * softplus(q/b)
// p(q) = sigmoid(q/b)

/** Instantaneous probability-price of the binary market, in (0, 1). */
export function binaryPrice(q: number, b: number): number {
  return 1 / (1 + Math.exp(-q / b));
}

/**
 * Cost to buy `n` shares (n < 0 sells / shorts) when net outstanding is `q`.
 * Positive result = trader pays; negative = trader receives.
 */
export function binaryTradeCost(q: number, n: number, b: number): number {
  return b * (softplus((q + n) / b) - softplus(q / b));
}

/**
 * Inverse of binaryTradeCost in n: how many shares does `spend` buy?
 * `spend` may be negative (selling for proceeds of -spend) as long as the
 * resulting cost level stays positive, which it always is for finite q.
 */
export function binarySharesForCost(q: number, spend: number, b: number): number {
  const target = softplus(q / b) + spend / b;
  if (target <= 0) {
    throw new RangeError(`spend ${spend} exceeds total market value at q=${q}`);
  }
  return b * inverseSoftplus(target) - q;
}
