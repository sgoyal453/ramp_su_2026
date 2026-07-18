/**
 * PlayerMarket: one LMSR market instance per player per league.
 *
 * Wraps the binary closed-form LMSR from lmsr.ts with:
 *  - dollar scaling (probability price in (0,1) -> display price in $)
 *  - stateful net-shares-outstanding tracking (user trades + bot signals
 *    flow through the exact same mechanism)
 *  - quoting (preview cost without mutating state)
 *  - spend-based sizing ("how many shares does $X buy right now?")
 *  - settlement against a final normalized performance score
 *
 * Sign convention for share counts everywhere: positive = buy/long,
 * negative = sell/short. A user's position is just the sum of their trades;
 * shorting is a net-negative position through the same market — there is no
 * separate short-side book.
 */

import { binaryPrice, binaryTradeCost, binarySharesForCost } from "./lmsr";

export interface PlayerMarketOptions {
  playerId: string;
  /** Liquidity parameter. Lower b = bigger price swings per trade. */
  b?: number;
  /** Dollars at probability 1.0; display price lives in (0, priceScale). */
  priceScale?: number;
  /** Seed net shares outstanding, e.g. to open a favorite above $50. */
  initialQ?: number;
}

export interface Fill {
  shares: number;
  cost: number;
  price: number;
}

export interface MarketSnapshot {
  playerId: string;
  price: number;
  probability: number;
  q: number;
  b: number;
  priceScale: number;
  settled: boolean;
  settlementPrice: number | null;
}

export class PlayerMarket {
  readonly playerId: string;
  readonly b: number;
  readonly priceScale: number;
  q: number;
  settled = false;
  settlementPrice: number | null = null;

  constructor({ playerId, b = 150, priceScale = 100, initialQ = 0 }: PlayerMarketOptions) {
    if (!(b > 0)) throw new RangeError(`b must be > 0, got ${b}`);
    if (!(priceScale > 0)) throw new RangeError(`priceScale must be > 0, got ${priceScale}`);
    this.playerId = playerId;
    this.b = b;
    this.priceScale = priceScale;
    this.q = initialQ;
  }

  /** Current probability-space price, in (0, 1). */
  probability(): number {
    return binaryPrice(this.q, this.b);
  }

  /** Current display price in dollars per share. */
  price(): number {
    return this.settled ? this.settlementPrice! : this.probability() * this.priceScale;
  }

  /**
   * Dollar cost to trade `shares` (positive buy, negative sell/short) at the
   * current state, WITHOUT mutating the market. Positive = trader pays,
   * negative = trader receives.
   */
  quote(shares: number): number {
    this.assertOpen();
    if (!Number.isFinite(shares)) throw new RangeError(`shares must be finite, got ${shares}`);
    return binaryTradeCost(this.q, shares, this.b) * this.priceScale;
  }

  /**
   * Execute a trade of `shares` (positive buy, negative sell/short).
   * Mutates market state and returns the fill.
   */
  trade(shares: number): Fill {
    const cost = this.quote(shares);
    if (shares === 0) return { shares: 0, cost: 0, price: this.price() };
    this.q += shares;
    return { shares, cost, price: this.price() };
  }

  /**
   * Liquidation ("mark-to-close") value of holding `shares` right now: the cash
   * you would net by closing the position at the current state. For a long this
   * is the sell proceeds; for a short it is negative (the buyback you owe).
   *
   * This is what a position is actually worth, unlike `shares * price()` which
   * marks at the marginal price and overstates value by the LMSR spread — so a
   * freshly opened position would otherwise show an instant phantom gain.
   */
  closeValue(shares: number): number {
    if (shares === 0) return 0;
    if (this.settled) return this.payout(shares);
    return -this.quote(-shares);
  }

  /**
   * How many shares a dollar `spend` buys at the current state (spend > 0).
   * Use with trade() for "invest $X" style UI. Does not mutate.
   */
  sharesForSpend(spend: number): number {
    this.assertOpen();
    if (!(spend > 0)) throw new RangeError(`spend must be > 0, got ${spend}`);
    return binarySharesForCost(this.q, spend / this.priceScale, this.b);
  }

  /**
   * Market-maker bot nudge from a simulated match event: trades `shares`
   * through the exact same LMSR mechanism as a user (positive = good event,
   * negative = bad event). Returns the fill so the bot's cost can be tracked.
   */
  applySignal(shares: number): Fill {
    return this.trade(shares);
  }

  /**
   * Close the market against the player's final performance score, normalized
   * to [0, 1]. After settlement every share pays finalScore * priceScale
   * (longs receive it, shorts owe it) and trading is rejected.
   */
  settle(finalScore: number): number {
    if (this.settled) throw new Error(`market ${this.playerId} already settled`);
    if (!(finalScore >= 0 && finalScore <= 1)) {
      throw new RangeError(`finalScore must be in [0, 1], got ${finalScore}`);
    }
    this.settled = true;
    this.settlementPrice = finalScore * this.priceScale;
    return this.settlementPrice;
  }

  /** Dollar payout for a position of `shares` (negative for shorts). */
  payout(shares: number): number {
    if (!this.settled) throw new Error(`market ${this.playerId} not settled yet`);
    return shares * this.settlementPrice!;
  }

  /** Plain-object view for API responses / WebSocket broadcasts. */
  snapshot(): MarketSnapshot {
    return {
      playerId: this.playerId,
      price: this.price(),
      probability: this.probability(),
      q: this.q,
      b: this.b,
      priceScale: this.priceScale,
      settled: this.settled,
      settlementPrice: this.settlementPrice,
    };
  }

  private assertOpen(): void {
    if (this.settled) throw new Error(`market ${this.playerId} is settled; trading closed`);
  }
}

export interface LeaguePlayerSpec {
  id: string;
  b?: number;
  initialQ?: number;
}

/**
 * Build one PlayerMarket per player for a league. Per-player b is how you
 * make a volatile rookie vs. a steady veteran; `defaults` fill the rest.
 */
export function createLeagueMarkets(
  players: LeaguePlayerSpec[],
  defaults: Partial<Omit<PlayerMarketOptions, "playerId">> = {},
): Map<string, PlayerMarket> {
  const markets = new Map<string, PlayerMarket>();
  for (const p of players) {
    if (markets.has(p.id)) throw new Error(`duplicate player id: ${p.id}`);
    markets.set(p.id, new PlayerMarket({ ...defaults, ...p, playerId: p.id }));
  }
  return markets;
}
