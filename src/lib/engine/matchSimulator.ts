/**
 * Self-contained soccer match simulator.
 *
 * On construction it pre-generates a randomized-but-plausible 90-minute event
 * timeline (goals, shots, key passes, tackles, saves, fouls, cards, subs),
 * assigning events to players probabilistically from their hidden skill
 * rating. start() replays that timeline on a compressed real-time clock
 * (default 10 real minutes), emitting:
 *
 *   'kickoff'  {}
 *   'minute'   { minute }                          — every simulated minute
 *   'event'    MatchEvent                          — ticker + market nudge
 *   'fulltime' { finalScores, settlements, score } — after settlement
 *
 * If a `markets` Map (from createLeagueMarkets) is provided, each event is
 * also applied as a market-maker bot trade via market.applySignal() — the
 * same LMSR mechanism as user trades — and at full time every market is
 * settled against the player's final normalized performance score.
 *
 * Tests (and anything that wants manual control) can skip start() and call
 * advanceMinute() directly; the timeline is fixed at construction, so a
 * given seed always produces the identical match.
 */

import { EventEmitter } from "node:events";
import { createRng, poisson, weightedPick, type Rng } from "./rng";
import type { RosterPlayer, FieldPosition } from "./roster";
import type { PlayerMarket } from "./playerMarket";

export type MatchEventType =
  | "GOAL"
  | "SHOT_ON_TARGET"
  | "SHOT_OFF_TARGET"
  | "KEY_PASS"
  | "TACKLE"
  | "SAVE"
  | "FOUL"
  | "YELLOW_CARD"
  | "RED_CARD"
  | "SUBSTITUTION";

interface EventSpec {
  rate: number;
  points: number;
  signalShares: number;
  affinity: Record<FieldPosition, number>;
  /** +1: skill makes the event more likely; -1: skews to less skilled players. */
  skillBias: 1 | -1;
  minMinute?: number;
}

export interface MatchEvent {
  minute: number;
  type: MatchEventType;
  playerId: string;
  playerName: string;
  team: string;
  points: number;
  signalShares: number;
  commentary: string;
}

export interface FullTimeResult {
  score: Record<string, number>;
  finalScores: Map<string, number>;
  settlements: Map<string, number>;
}

// Per-simulated-minute rates give plausible match totals over 90':
// ~2.7 goals, ~9 shots on target, ~20 key passes, ~3.6 yellows, etc.
export const EVENT_TYPES: Record<MatchEventType, EventSpec> = {
  GOAL: { rate: 0.03, points: 10, signalShares: 150, affinity: { GK: 0, DEF: 0.1, MID: 0.5, FWD: 1.5 }, skillBias: 1 },
  SHOT_ON_TARGET: { rate: 0.1, points: 2.5, signalShares: 40, affinity: { GK: 0, DEF: 0.15, MID: 0.6, FWD: 1.5 }, skillBias: 1 },
  SHOT_OFF_TARGET: { rate: 0.15, points: 0.5, signalShares: -10, affinity: { GK: 0, DEF: 0.15, MID: 0.6, FWD: 1.5 }, skillBias: 1 },
  KEY_PASS: { rate: 0.22, points: 2, signalShares: 25, affinity: { GK: 0.05, DEF: 0.4, MID: 1.5, FWD: 0.8 }, skillBias: 1 },
  TACKLE: { rate: 0.35, points: 1.5, signalShares: 15, affinity: { GK: 0.05, DEF: 1.5, MID: 1.0, FWD: 0.3 }, skillBias: 1 },
  SAVE: { rate: 0.08, points: 2, signalShares: 30, affinity: { GK: 1, DEF: 0, MID: 0, FWD: 0 }, skillBias: 1 },
  FOUL: { rate: 0.25, points: -1, signalShares: -12, affinity: { GK: 0.1, DEF: 1.2, MID: 1.0, FWD: 0.7 }, skillBias: -1 },
  YELLOW_CARD: { rate: 0.04, points: -2, signalShares: -35, affinity: { GK: 0.1, DEF: 1.2, MID: 1.0, FWD: 0.7 }, skillBias: -1 },
  RED_CARD: { rate: 0.002, points: -8, signalShares: -150, affinity: { GK: 0.1, DEF: 1.2, MID: 1.0, FWD: 0.7 }, skillBias: -1 },
  SUBSTITUTION: { rate: 0.05, points: 0, signalShares: 0, affinity: { GK: 0.05, DEF: 1, MID: 1, FWD: 1 }, skillBias: -1, minMinute: 55 },
};

// Final score normalization: score = points / (points + K), clamped to [0, 1].
// Monotonic in points, saturates smoothly, and a quiet match ~ a low payout.
const SCORE_K = 10;

const COMMENTARY: Record<MatchEventType, (p: RosterPlayer) => string> = {
  GOAL: (p) => `GOAL! ${p.name} scores for ${p.team}!`,
  SHOT_ON_TARGET: (p) => `${p.name} forces a save with a shot on target.`,
  SHOT_OFF_TARGET: (p) => `${p.name} fires wide of the post.`,
  KEY_PASS: (p) => `Lovely vision from ${p.name} to slice open the defense.`,
  TACKLE: (p) => `Crunching tackle won cleanly by ${p.name}.`,
  SAVE: (p) => `Brilliant save by ${p.name}!`,
  FOUL: (p) => `${p.name} concedes a free kick.`,
  YELLOW_CARD: (p) => `Yellow card! ${p.name} goes into the book.`,
  RED_CARD: (p) => `RED CARD! ${p.name} is sent off — ${p.team} down to ten!`,
  SUBSTITUTION: (p) => `${p.name} makes way as ${p.team} freshen things up.`,
};

/** How likely each player is to be the one an event happens to. */
function playerWeight(player: RosterPlayer, spec: EventSpec): number {
  const affinity = spec.affinity[player.position] ?? 0;
  // Positive events reward skill superlinearly; negative events (fouls,
  // cards) skew toward less skilled players.
  const skillFactor = spec.skillBias >= 0 ? (0.2 + player.skill) ** 2 : 1.3 - player.skill;
  return affinity * skillFactor;
}

/** points -> normalized settlement score in [0, 1]. Exported for the UI. */
export function normalizeScore(points: number): number {
  const p = Math.max(0, points);
  return p / (p + SCORE_K);
}

export function generateTimeline(players: RosterPlayer[], rng: Rng, matchMinutes = 90): MatchEvent[] {
  const timeline: MatchEvent[] = [];
  for (let minute = 1; minute <= matchMinutes; minute++) {
    for (const [type, spec] of Object.entries(EVENT_TYPES) as [MatchEventType, EventSpec][]) {
      if (spec.minMinute && minute < spec.minMinute) continue;
      const count = poisson(rng, spec.rate);
      for (let i = 0; i < count; i++) {
        const idx = weightedPick(rng, players.map((p) => playerWeight(p, spec)));
        if (idx < 0) continue;
        const player = players[idx];
        timeline.push({
          minute,
          type,
          playerId: player.id,
          playerName: player.name,
          team: player.team,
          points: spec.points,
          signalShares: spec.signalShares,
          commentary: `${minute}' — ${COMMENTARY[type](player)}`,
        });
      }
    }
  }
  return timeline;
}

export interface MatchSimulatorOptions {
  players: RosterPlayer[];
  /** Per-player LMSR markets to drive; omit to run stats-only. */
  markets?: Map<string, PlayerMarket> | null;
  /** Timeline seed (same seed = same match). */
  seed?: number;
  matchMinutes?: number;
  /** Real-world length of the compressed match (default 10 minutes). */
  realDurationMs?: number;
}

export class MatchSimulator extends EventEmitter {
  readonly players: RosterPlayer[];
  readonly markets: Map<string, PlayerMarket> | null;
  readonly matchMinutes: number;
  readonly realDurationMs: number;
  readonly timeline: MatchEvent[];
  minute = 0;
  finished = false;
  pointsByPlayer: Map<string, number>;
  goals: Map<string, number>;
  eventLog: MatchEvent[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor({ players, markets = null, seed = 1, matchMinutes = 90, realDurationMs = 10 * 60_000 }: MatchSimulatorOptions) {
    super();
    this.players = players;
    this.markets = markets;
    this.matchMinutes = matchMinutes;
    this.realDurationMs = realDurationMs;
    this.timeline = generateTimeline(players, createRng(seed), matchMinutes);
    this.pointsByPlayer = new Map(players.map((p) => [p.id, 0]));
    this.goals = new Map([...new Set(players.map((p) => p.team))].map((t) => [t, 0]));
  }

  /** Drive the match on a compressed real-time clock. */
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

  /** Advance one simulated minute, firing that minute's events. */
  advanceMinute(): void {
    if (this.finished) return;
    this.minute += 1;
    this.emit("minute", { minute: this.minute });
    for (const event of this.timeline) {
      if (event.minute !== this.minute) continue;
      this.pointsByPlayer.set(event.playerId, this.pointsByPlayer.get(event.playerId)! + event.points);
      if (event.type === "GOAL") this.goals.set(event.team, this.goals.get(event.team)! + 1);
      if (this.markets) {
        const market = this.markets.get(event.playerId);
        if (market && event.signalShares !== 0) market.applySignal(event.signalShares);
      }
      this.eventLog.push(event);
      this.emit("event", event);
    }
    if (this.minute >= this.matchMinutes) this.fullTime();
  }

  /** Run the whole remaining match synchronously (tests, instant sims). */
  runToCompletion(): void {
    while (!this.finished) this.advanceMinute();
  }

  private fullTime(): void {
    this.finished = true;
    this.stop();
    const finalScores = new Map<string, number>();
    const settlements = new Map<string, number>();
    for (const player of this.players) {
      const score = normalizeScore(this.pointsByPlayer.get(player.id)!);
      finalScores.set(player.id, score);
      if (this.markets) {
        settlements.set(player.id, this.markets.get(player.id)!.settle(score));
      }
    }
    const result: FullTimeResult = {
      score: Object.fromEntries(this.goals),
      finalScores,
      settlements,
    };
    this.emit("fulltime", result);
  }
}
