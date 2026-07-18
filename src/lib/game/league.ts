/**
 * League: one private competition — the verified real fixture's roster, one
 * LMSR market per player, user portfolios, a historical match replay, and
 * settlement.
 *
 * Every league is built from the committed fixture snapshot (Argentina vs
 * Egypt, 2026 World Cup Round of 16). There is no fictional roster and no
 * hidden skill rating: every market opens at the same neutral price with the
 * same liquidity, and only verified real events move prices between trades.
 *
 * The server layer owns broadcasting; League exposes hooks (onEvent/onMinute/
 * onFullTime) rather than talking to sockets itself, so it stays unit-testable.
 */

import { createLeagueMarkets, type PlayerMarket } from "../engine/playerMarket";
import { HistoricalMatchReplay, type ReplayEvent, type ReplayFullTime } from "../engine/historicalReplay";
import { runArbitrageur } from "../engine/arbitrageurAgent";
import { getFixture } from "../fixtures/load";
import type { FixtureSnapshot } from "../fixtures/types";
import type { LeagueStateDTO, LeagueStatus, MatchEventDTO, LeaderboardEntryDTO, FixtureMetaDTO } from "../types";

export const MAX_USERS = 20;
export const DEFAULT_STARTING_CASH = 100_000;
export const MAX_TRADE_SHARES = 10_000;
export const TICKER_LIMIT = 200;
/** One uniform liquidity for every market: real players get no synthetic
 *  "volatile rookie" / "steady veteran" differentiation. */
export const DEFAULT_B = 150;

export interface UserAccount {
  username: string;
  cash: number;
  positions: Map<string, number>;
}

export interface LeagueHooks {
  onEvent?: (event: ReplayEvent) => void;
  onMinute?: (minute: number) => void;
  onFullTime?: (result: ReplayFullTime) => void;
  /** Called each time the arbitrageur agent applies a correlated signal. */
  onArbitrageurSignal?: () => void;
}

export interface LeagueOptions {
  code: string;
  host: string;
  buyIn?: number;
  /** Real-dollar equivalent of `buyIn` fake coins, e.g. 10 for "$10 = 1,000,000 coins". */
  buyInReal?: number;
  startingCash?: number;
  /** Real-world duration of the compressed replay, in minutes. */
  matchRealMinutes?: number;
  /**
   * Verified fixture snapshot; defaults to the committed cached snapshot.
   * Constructing a league is impossible without one — synthetic data is
   * never substituted.
   */
  fixture?: FixtureSnapshot;
  /** Competition this league represents, e.g. "World Cup 2026". */
  seasonLabel?: string;
  /** Human-readable date range the league runs over, e.g. "Jun 11 – Jul 19, 2026". */
  windowLabel?: string;
  /** Label for the fixture; defaults to the real match, e.g. "Round of 16 · Argentina vs Egypt". */
  matchLabel?: string;
}

export class League {
  readonly code: string;
  readonly host: string;
  readonly buyIn: number;
  readonly buyInReal: number;
  readonly startingCash: number;
  readonly matchRealMinutes: number;
  readonly fixture: FixtureSnapshot;
  readonly seasonLabel: string;
  readonly windowLabel: string;
  readonly matchLabel: string;
  readonly markets: Map<string, PlayerMarket>;
  readonly users = new Map<string, UserAccount>();
  status: LeagueStatus = "lobby";
  sim: HistoricalMatchReplay | null = null;
  ticker: MatchEventDTO[] = [];
  history: Record<string, number[]> = {};
  minute = 0;
  score: Record<string, number> = {};
  settlements: Record<string, number> | null = null;

  constructor({
    code,
    host,
    buyIn = 1000,
    buyInReal = 10,
    startingCash = DEFAULT_STARTING_CASH,
    matchRealMinutes = 10,
    fixture,
    seasonLabel = "",
    windowLabel = "",
    matchLabel = "",
  }: LeagueOptions) {
    this.code = code;
    this.host = host;
    this.buyIn = buyIn;
    this.buyInReal = buyInReal;
    this.startingCash = startingCash;
    this.matchRealMinutes = matchRealMinutes;
    // Throws when the committed snapshot is missing or invalid — a league can
    // never exist without a verified real fixture.
    this.fixture = fixture ?? getFixture();
    this.seasonLabel = seasonLabel;
    this.windowLabel = windowLabel;
    this.matchLabel = matchLabel || `${this.fixture.stage} · ${this.fixture.homeTeam} vs ${this.fixture.awayTeam}`;
    this.markets = createLeagueMarkets(
      this.fixture.players.map(({ id }) => ({ id })),
      { b: DEFAULT_B },
    );
    for (const p of this.fixture.players) {
      this.history[p.id] = [this.markets.get(p.id)!.price()];
    }
    this.score = { [this.fixture.homeTeam]: 0, [this.fixture.awayTeam]: 0 };
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

  /**
   * Seed a non-interactive demo trader with a fake cash balance and positions,
   * bypassing the LMSR (their holdings are cosmetic — this doesn't move
   * market state). Used to pre-populate a league's leaderboard for a demo.
   */
  seedBotUser(username: string, cash: number, positions: Record<string, number> = {}): void {
    const account = this.addUser(username);
    account.cash = cash;
    account.positions = new Map(Object.entries(positions).filter(([id]) => this.markets.has(id)));
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

  /**
   * Kick off the historical replay. Host only; lobby only.
   * `fastForwardMinutes` instantly replays that many match minutes (events
   * fire, markets move, history fills) before the live clock starts, so a
   * league can open already "in progress" for a demo.
   */
  start(username: string, hooks: LeagueHooks = {}, fastForwardMinutes = 0): void {
    if (username !== this.host) throw new Error("only the host can start the match");
    if (this.status !== "lobby") throw new Error(`match already ${this.status}`);
    this.status = "live";
    this.sim = new HistoricalMatchReplay({
      fixture: this.fixture,
      markets: this.markets,
      realDurationMs: this.matchRealMinutes * 60_000,
    });
    this.sim.on("event", (event: ReplayEvent) => {
      this.ticker.unshift(event);
      if (this.ticker.length > TICKER_LIMIT) this.ticker.pop();
      this.score = Object.fromEntries(this.sim!.goals);
      hooks.onEvent?.(event);

      // Fire the arbitrageur agent async — never blocks the match clock.
      // Skipped silently when OPENAI_API_KEY is absent or the market is settled.
      runArbitrageur(event, {
        getPlayers: () =>
          this.fixture.players.map((p) => ({
            id: p.id,
            name: p.name,
            team: p.team,
            position: p.position,
            currentPrice: this.markets.get(p.id)!.price(),
          })),
        getMatchState: () => ({
          minute: this.minute,
          score: { ...this.score },
          recentEvents: this.ticker
            .filter((e) => !e.isArbitrageur)
            .slice(0, 5)
            .map((e) => ({
              minute: e.minute,
              type: e.type,
              playerName: e.playerName,
              team: e.team,
              commentary: e.commentary,
            })),
        }),
        applySignal: (playerId, shares, reason) => {
          if (playerId === event.playerId) return false;
          const market = this.markets.get(playerId);
          if (!market || market.settled) return false;
          market.applySignal(shares);
          const player = this.fixture.players.find((p) => p.id === playerId);
          const arbEvent: MatchEventDTO = {
            minute: this.minute,
            type: "ARB_SIGNAL",
            playerId,
            playerName: player?.name ?? playerId,
            team: player?.team ?? "",
            points: 0,
            signalShares: shares,
            commentary: `[Arb] ${reason}`,
            isArbitrageur: true,
          };
          this.ticker.unshift(arbEvent);
          if (this.ticker.length > TICKER_LIMIT) this.ticker.pop();
          hooks.onArbitrageurSignal?.();
          return true;
        },
      }).catch((err) => console.error("[arbitrageur]", err));
    });
    this.sim.on("minute", ({ minute }: { minute: number }) => {
      this.minute = minute;
      for (const p of this.fixture.players) this.history[p.id].push(this.markets.get(p.id)!.price());
      hooks.onMinute?.(minute);
    });
    this.sim.on("fulltime", (result: ReplayFullTime) => {
      this.settle(result);
      hooks.onFullTime?.(result);
    });
    const clamped = Math.min(fastForwardMinutes, this.sim.matchMinutes - 1);
    for (let i = 0; i < clamped; i++) this.sim.advanceMinute();
    this.sim.start();
  }

  /**
   * Portfolio value: cash + liquidation value of every open position. Positions
   * are marked at what closing them would net right now (not the marginal
   * price), so opening a position is P&L-neutral and value only moves as the
   * market does.
   */
  portfolioValue(username: string): number {
    const account = this.userOrThrow(username);
    let value = account.cash;
    for (const [playerId, shares] of account.positions) {
      value += this.markets.get(playerId)!.closeValue(shares);
    }
    return value;
  }

  leaderboard(): LeaderboardEntryDTO[] {
    return [...this.users.values()]
      .map((u) => ({
        username: u.username,
        cash: u.cash,
        value: this.portfolioValue(u.username),
        positions: Object.fromEntries(u.positions),
      }))
      .sort((a, b) => b.value - a.value);
  }

  /** Client-safe fixture metadata: identifies the real match (with sources)
   *  without leaking its events or outcome into the lobby. */
  fixtureMeta(): FixtureMetaDTO {
    return {
      fixtureId: this.fixture.fixtureId,
      competition: this.fixture.competition,
      stage: this.fixture.stage,
      dateUtc: this.fixture.dateUtc,
      venue: this.fixture.venue,
      city: this.fixture.city,
      homeTeam: this.fixture.homeTeam,
      awayTeam: this.fixture.awayTeam,
      sources: this.fixture.sources.map((s) => s.url),
    };
  }

  /** Personalized snapshot for one user (or a spectator when username is null). */
  toDTO(username: string | null): LeagueStateDTO {
    const account = username ? this.users.get(username) : null;
    return {
      code: this.code,
      status: this.status,
      buyIn: this.buyIn,
      buyInReal: this.buyInReal,
      startingCash: this.startingCash,
      seasonLabel: this.seasonLabel,
      windowLabel: this.windowLabel,
      matchLabel: this.matchLabel,
      fixture: this.fixtureMeta(),
      host: this.host,
      users: [...this.users.keys()],
      players: this.fixture.players.map((p) => ({
        id: p.id,
        name: p.name,
        team: p.team,
        position: p.position,
        b: DEFAULT_B,
        shirt: p.shirt,
        started: p.started,
      })),
      prices: Object.fromEntries(this.fixture.players.map((p) => [p.id, this.markets.get(p.id)!.price()])),
      history: this.history,
      minute: this.minute,
      matchMinutes: this.sim?.matchMinutes ?? (this.fixture.wentToExtraTime ? 120 : 90),
      score: this.score,
      ticker: this.ticker,
      leaderboard: this.leaderboard(),
      settlements: this.settlements,
      you: account
        ? {
            username: account.username,
            cash: account.cash,
            positions: Object.fromEntries(account.positions),
            positionValues: Object.fromEntries(
              [...account.positions].map(([playerId, shares]) => [
                playerId,
                this.markets.get(playerId)!.closeValue(shares),
              ]),
            ),
            value: this.portfolioValue(account.username),
          }
        : null,
    };
  }

  /** Convert every open position to cash at settlement prices. */
  private settle(result: ReplayFullTime): void {
    this.status = "settled";
    this.minute = this.sim!.matchMinutes;
    this.settlements = Object.fromEntries(result.settlements);
    for (const p of this.fixture.players) this.history[p.id].push(this.markets.get(p.id)!.price());
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
