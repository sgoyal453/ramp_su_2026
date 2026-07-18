/**
 * League: one private competition — a roster, one LMSR market per player,
 * user portfolios, a match simulator, and settlement.
 *
 * The server layer owns broadcasting; League exposes hooks (onEvent/onMinute/
 * onFullTime) rather than talking to sockets itself, so it stays unit-testable.
 */

import { createDefaultRoster, publicPlayer, type RosterPlayer } from "../engine/roster";
import { createLeagueMarkets, type PlayerMarket } from "../engine/playerMarket";
import { MatchSimulator, type MatchEvent, type FullTimeResult } from "../engine/matchSimulator";
import type { LeagueStateDTO, LeagueStatus, MatchEventDTO, LeaderboardEntryDTO } from "../types";

export const MAX_USERS = 20;
export const DEFAULT_STARTING_CASH = 100_000;
export const MAX_TRADE_SHARES = 10_000;
export const TICKER_LIMIT = 200;

export interface UserAccount {
  username: string;
  cash: number;
  positions: Map<string, number>;
}

export interface LeagueHooks {
  onEvent?: (event: MatchEvent) => void;
  onMinute?: (minute: number) => void;
  onFullTime?: (result: FullTimeResult) => void;
}

export interface LeagueOptions {
  code: string;
  host: string;
  buyIn?: number;
  startingCash?: number;
  /** Real-world duration of the compressed 90' match, in minutes. */
  matchRealMinutes?: number;
  seed?: number;
}

export class League {
  readonly code: string;
  readonly host: string;
  readonly buyIn: number;
  readonly startingCash: number;
  readonly matchRealMinutes: number;
  readonly seed: number;
  readonly players: RosterPlayer[];
  readonly markets: Map<string, PlayerMarket>;
  readonly users = new Map<string, UserAccount>();
  status: LeagueStatus = "lobby";
  sim: MatchSimulator | null = null;
  ticker: MatchEventDTO[] = [];
  history: Record<string, number[]> = {};
  minute = 0;
  score: Record<string, number> = {};
  settlements: Record<string, number> | null = null;

  constructor({ code, host, buyIn = 1000, startingCash = DEFAULT_STARTING_CASH, matchRealMinutes = 10, seed }: LeagueOptions) {
    this.code = code;
    this.host = host;
    this.buyIn = buyIn;
    this.startingCash = startingCash;
    this.matchRealMinutes = matchRealMinutes;
    this.seed = seed ?? Math.floor(Math.random() * 2 ** 31);
    this.players = createDefaultRoster();
    this.markets = createLeagueMarkets(
      this.players.map(({ id, b, initialQ }) => ({ id, b, initialQ })),
    );
    for (const p of this.players) {
      this.history[p.id] = [this.markets.get(p.id)!.price()];
      this.score = {};
    }
    for (const team of new Set(this.players.map((p) => p.team))) this.score[team] = 0;
    this.addUser(host);
  }

  /** Join (or rejoin — idempotent) with a username. */
  addUser(username: string): UserAccount {
    const existing = this.users.get(username);
    if (existing) return existing;
    if (this.users.size >= MAX_USERS) throw new Error(`league ${this.code} is full (${MAX_USERS} users)`);
    if (this.status === "settled") throw new Error("league already settled");
    const account: UserAccount = { username, cash: this.startingCash, positions: new Map() };
    this.users.set(username, account);
    return account;
  }

  /** Preview the dollar cost of a trade without executing it. */
  quote(playerId: string, shares: number): number {
    const market = this.marketOrThrow(playerId);
    this.validateShares(shares);
    return market.quote(shares);
  }

  /**
   * Execute a trade for a user. Positive shares = buy, negative = sell/short.
   * Rules: cash can never go negative, and a short position must be fully
   * collateralized — worst-case buyback (priceScale per share) within cash.
   */
  trade(username: string, playerId: string, shares: number) {
    if (this.status === "settled") throw new Error("match is over; trading closed");
    const account = this.userOrThrow(username);
    const market = this.marketOrThrow(playerId);
    this.validateShares(shares);

    const cost = market.quote(shares);
    const newCash = account.cash - cost;
    if (newCash < 0) throw new Error(`insufficient cash: need $${cost.toFixed(2)}, have $${account.cash.toFixed(2)}`);

    const newPosition = (account.positions.get(playerId) ?? 0) + shares;
    if (newPosition < 0) {
      const collateral = -newPosition * market.priceScale;
      if (collateral > newCash) {
        throw new Error(
          `short exposure cap: ${-newPosition} short shares need $${collateral.toFixed(2)} collateral, cash would be $${newCash.toFixed(2)}`,
        );
      }
    }

    const fill = market.trade(shares);
    account.cash = newCash;
    if (newPosition === 0) account.positions.delete(playerId);
    else account.positions.set(playerId, newPosition);
    return { ...fill, position: newPosition, cash: account.cash };
  }

  /** Kick off the simulated match. Host only; lobby only. */
  start(username: string, hooks: LeagueHooks = {}): void {
    if (username !== this.host) throw new Error("only the host can start the match");
    if (this.status !== "lobby") throw new Error(`match already ${this.status}`);
    this.status = "live";
    this.sim = new MatchSimulator({
      players: this.players,
      markets: this.markets,
      seed: this.seed,
      realDurationMs: this.matchRealMinutes * 60_000,
    });
    this.sim.on("event", (event: MatchEvent) => {
      this.ticker.unshift(event);
      if (this.ticker.length > TICKER_LIMIT) this.ticker.pop();
      this.score = Object.fromEntries(this.sim!.goals);
      hooks.onEvent?.(event);
    });
    this.sim.on("minute", ({ minute }: { minute: number }) => {
      this.minute = minute;
      for (const p of this.players) this.history[p.id].push(this.markets.get(p.id)!.price());
      hooks.onMinute?.(minute);
    });
    this.sim.on("fulltime", (result: FullTimeResult) => {
      this.settle(result);
      hooks.onFullTime?.(result);
    });
    this.sim.start();
  }

  /** Mark-to-market portfolio value: cash + Σ position × current price. */
  portfolioValue(username: string): number {
    const account = this.userOrThrow(username);
    let value = account.cash;
    for (const [playerId, shares] of account.positions) {
      value += shares * this.markets.get(playerId)!.price();
    }
    return value;
  }

  leaderboard(): LeaderboardEntryDTO[] {
    return [...this.users.values()]
      .map((u) => ({ username: u.username, cash: u.cash, value: this.portfolioValue(u.username) }))
      .sort((a, b) => b.value - a.value);
  }

  /** Personalized snapshot for one user (or a spectator when username is null). */
  toDTO(username: string | null): LeagueStateDTO {
    const account = username ? this.users.get(username) : null;
    return {
      code: this.code,
      status: this.status,
      buyIn: this.buyIn,
      startingCash: this.startingCash,
      host: this.host,
      users: [...this.users.keys()],
      players: this.players.map(publicPlayer),
      prices: Object.fromEntries(this.players.map((p) => [p.id, this.markets.get(p.id)!.price()])),
      history: this.history,
      minute: this.minute,
      matchMinutes: this.sim?.matchMinutes ?? 90,
      score: this.score,
      ticker: this.ticker,
      leaderboard: this.leaderboard(),
      settlements: this.settlements,
      you: account
        ? {
            username: account.username,
            cash: account.cash,
            positions: Object.fromEntries(account.positions),
            value: this.portfolioValue(account.username),
          }
        : null,
    };
  }

  /** Convert every open position to cash at settlement prices. */
  private settle(result: FullTimeResult): void {
    this.status = "settled";
    this.minute = this.sim!.matchMinutes;
    this.settlements = Object.fromEntries(result.settlements);
    for (const p of this.players) this.history[p.id].push(this.markets.get(p.id)!.price());
    for (const account of this.users.values()) {
      for (const [playerId, shares] of account.positions) {
        account.cash += this.markets.get(playerId)!.payout(shares);
      }
      account.positions.clear();
    }
  }

  private userOrThrow(username: string): UserAccount {
    const account = this.users.get(username);
    if (!account) throw new Error(`unknown user ${username} — join the league first`);
    return account;
  }

  private marketOrThrow(playerId: string): PlayerMarket {
    const market = this.markets.get(playerId);
    if (!market) throw new Error(`unknown player ${playerId}`);
    return market;
  }

  private validateShares(shares: number): void {
    if (!Number.isFinite(shares) || shares === 0) throw new Error(`invalid share amount: ${shares}`);
    if (Math.abs(shares) > MAX_TRADE_SHARES) throw new Error(`max ${MAX_TRADE_SHARES} shares per trade`);
  }
}
