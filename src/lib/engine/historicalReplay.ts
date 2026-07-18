/**
 * HistoricalMatchReplay: replays a verified real fixture snapshot through the
 * same lifecycle contract as MatchSimulator ('kickoff' / 'minute' / 'event' /
 * 'fulltime'), driving the per-player LMSR markets and settling them from
 * real-event scores.
 *
 * Differences from the fictional simulator, by design:
 *  - No randomness, no hidden skill ratings, no generated timeline. The event
 *    list is exactly the committed snapshot; two replays are identical.
 *  - EVENT-ONLY SCORING ADAPTER (documented below): points and market signals
 *    apply only to verified goals, assists, cards, substitutions, and
 *    goalkeeper penalty saves present in the snapshot. Players with no
 *    verified scoring event keep 0 points; nothing (tackles, shots, key
 *    passes, form) is fabricated to make quiet players move.
 *  - The recorded 90'+stoppage (or 120' with extra time) match is scaled to
 *    the league's real-time window; stoppage-time events fold into the last
 *    minute of their period (45+2 fires at clock minute 45) so the clock
 *    stays a simple 1..N sequence while preserving order.
 */

import { EventEmitter } from "node:events";
import { normalizeScore } from "./matchSimulator";
import { eventOrderKey } from "../fixtures/validate";
import type { FixtureEvent, FixturePeriod, FixtureSnapshot } from "../fixtures/types";
import type { PlayerMarket } from "./playerMarket";

/** Wire/ticker event shape shared with the fictional simulator. */
export interface ReplayEvent {
  minute: number;
  type: string;
  playerId: string;
  playerName: string;
  team: string;
  points: number;
  signalShares: number;
  commentary: string;
}

export interface ReplayFullTime {
  score: Record<string, number>;
  finalScores: Map<string, number>;
  settlements: Map<string, number>;
}

/**
 * The event-only scoring adapter. Every entry is a verified event type from
 * the fixture schema; `points` feeds the settlement score (normalized via the
 * same normalizeScore as the simulator) and `signalShares` is the market-maker
 * nudge applied through the ordinary LMSR trade path.
 */
export const REPLAY_SCORING: Record<string, { points: number; signalShares: number }> = {
  GOAL: { points: 10, signalShares: 150 },
  PENALTY_GOAL: { points: 10, signalShares: 150 },
  OWN_GOAL: { points: -4, signalShares: -80 },
  ASSIST: { points: 6, signalShares: 90 }, // derived from a goal's verified assistPlayerId
  YELLOW_CARD: { points: -2, signalShares: -35 },
  SECOND_YELLOW: { points: -8, signalShares: -150 },
  RED_CARD: { points: -8, signalShares: -150 },
  SUBSTITUTION: { points: 0, signalShares: 0 },
  PENALTY_SAVE: { points: 8, signalShares: 120 },
};

/** Fold stoppage time into the last minute of its period for the clock. */
export function clockMinute(e: FixtureEvent): number {
  const periodEnd: Record<FixturePeriod, number> = { "1H": 45, "2H": 90, ET1: 105, ET2: 120 };
  return Math.min(e.minute + 0, periodEnd[e.period]) === e.minute && e.stoppage === null
    ? e.minute
    : Math.min(e.minute, periodEnd[e.period]);
}

export interface HistoricalMatchReplayOptions {
  fixture: FixtureSnapshot;
  /** Per-player LMSR markets to drive; omit to run stats-only. */
  markets?: Map<string, PlayerMarket> | null;
  /** Real-world length of the compressed replay (default 10 minutes). */
  realDurationMs?: number;
}

export class HistoricalMatchReplay extends EventEmitter {
  readonly fixture: FixtureSnapshot;
  readonly markets: Map<string, PlayerMarket> | null;
  readonly matchMinutes: number;
  readonly realDurationMs: number;
  /** Replay events in order, each tagged with the clock minute it fires at. */
  readonly timeline: { at: number; event: ReplayEvent; fixtureEvent: FixtureEvent }[];
  minute = 0;
  finished = false;
  pointsByPlayer: Map<string, number>;
  goals: Map<string, number>;
  eventLog: ReplayEvent[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor({ fixture, markets = null, realDurationMs = 10 * 60_000 }: HistoricalMatchReplayOptions) {
    super();
    this.fixture = fixture;
    this.markets = markets;
    this.realDurationMs = realDurationMs;
    this.matchMinutes = fixture.wentToExtraTime ? 120 : 90;
    this.pointsByPlayer = new Map(fixture.players.map((p) => [p.id, 0]));
    this.goals = new Map([
      [fixture.homeTeam, 0],
      [fixture.awayTeam, 0],
    ]);
    this.timeline = [...fixture.events]
      .sort((a, b) => eventOrderKey(a) - eventOrderKey(b))
      .flatMap((e) => this.toReplayEvents(e).map((event) => ({ at: clockMinute(e), event, fixtureEvent: e })));
  }

  private playerName(id: string): string {
    return this.fixture.players.find((p) => p.id === id)?.name ?? id;
  }

  /** Expand one verified fixture event into its replay event(s). A goal with a
   *  recorded assist yields a second ASSIST event for the provider. */
  private toReplayEvents(e: FixtureEvent): ReplayEvent[] {
    const name = this.playerName(e.playerId);
    const minuteLabel = e.stoppage ? `${e.minute}+${e.stoppage}` : `${e.minute}`;
    const scoring = REPLAY_SCORING[e.type];
    const commentaryByType: Record<string, string> = {
      GOAL: `GOAL! ${name} scores for ${e.team}!`,
      PENALTY_GOAL: `GOAL! ${name} converts a penalty for ${e.team}!`,
      OWN_GOAL: `Own goal by ${name} (${e.team}).`,
      YELLOW_CARD: `Yellow card for ${name} (${e.team}).`,
      SECOND_YELLOW: `Second yellow — ${name} (${e.team}) is sent off!`,
      RED_CARD: `RED CARD! ${name} (${e.team}) is sent off!`,
      SUBSTITUTION: `${e.team} substitution: ${this.playerName(e.playerOnId ?? "")} replaces ${name}.`,
      PENALTY_SAVE: `Penalty saved by ${name} (${e.team})!`,
    };
    const events: ReplayEvent[] = [
      {
        minute: clockMinute(e),
        type: e.type,
        playerId: e.playerId,
        playerName: name,
        team: e.team,
        points: scoring.points,
        signalShares: scoring.signalShares,
        commentary: `${minuteLabel}' — ${commentaryByType[e.type]}`,
      },
    ];
    if ((e.type === "GOAL" || e.type === "PENALTY_GOAL") && e.assistPlayerId) {
      const assistName = this.playerName(e.assistPlayerId);
      events.push({
        minute: clockMinute(e),
        type: "ASSIST",
        playerId: e.assistPlayerId,
        playerName: assistName,
        team: e.team,
        points: REPLAY_SCORING.ASSIST.points,
        signalShares: REPLAY_SCORING.ASSIST.signalShares,
        commentary: `${minuteLabel}' — Assist by ${assistName} (${e.team}).`,
      });
    }
    return events;
  }

  /** Drive the replay on a compressed real-time clock. */
  start(): void {
    if (this.timer || this.finished) throw new Error("match already started or finished");
    this.emit("kickoff", { teams: [...this.goals.keys()] });
    const msPerMinute = this.realDurationMs / this.matchMinutes;
    this.timer = setInterval(() => this.advanceMinute(), msPerMinute);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Advance one clock minute, firing that minute's verified events. */
  advanceMinute(): void {
    if (this.finished) return;
    this.minute += 1;
    this.emit("minute", { minute: this.minute });
    for (const { at, event, fixtureEvent } of this.timeline) {
      if (at !== this.minute) continue;
      this.pointsByPlayer.set(event.playerId, this.pointsByPlayer.get(event.playerId)! + event.points);
      if (event.type === "GOAL" || event.type === "PENALTY_GOAL") {
        this.goals.set(event.team, this.goals.get(event.team)! + 1);
      } else if (event.type === "OWN_GOAL") {
        const other = fixtureEvent.team === this.fixture.homeTeam ? this.fixture.awayTeam : this.fixture.homeTeam;
        this.goals.set(other, this.goals.get(other)! + 1);
      }
      if (this.markets && event.signalShares !== 0) {
        this.markets.get(event.playerId)?.applySignal(event.signalShares);
      }
      this.eventLog.push(event);
      this.emit("event", event);
    }
    if (this.minute >= this.matchMinutes) this.fullTime();
  }

  /** Run the whole remaining replay synchronously (tests, instant runs). */
  runToCompletion(): void {
    while (!this.finished) this.advanceMinute();
  }

  private fullTime(): void {
    this.finished = true;
    this.stop();
    const finalScores = new Map<string, number>();
    const settlements = new Map<string, number>();
    for (const player of this.fixture.players) {
      const score = normalizeScore(this.pointsByPlayer.get(player.id)!);
      finalScores.set(player.id, score);
      if (this.markets) {
        settlements.set(player.id, this.markets.get(player.id)!.settle(score));
      }
    }
    const result: ReplayFullTime = {
      score: Object.fromEntries(this.goals),
      finalScores,
      settlements,
    };
    this.emit("fulltime", result);
  }
}
