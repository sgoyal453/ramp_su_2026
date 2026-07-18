/**
 * Strict validation for fixture snapshots.
 *
 * Web-search results are untrusted input. This module is the gate between
 * the ingestion agent's output and anything the app will run with: it
 * rejects missing, contradictory, or unverifiable data outright. It never
 * repairs or fills gaps — a snapshot either passes whole or is refused.
 *
 * The expected fixture is pinned: the app runs exactly one verified match.
 */

import type {
  FixtureEvent,
  FixtureEventType,
  FixturePeriod,
  FixturePlayer,
  FixturePosition,
  FixtureSnapshot,
} from "./types";

/** The one fixture this demo runs. Everything else is rejected. */
export const EXPECTED_FIXTURE = {
  fixtureId: "argentina-egypt-2026",
  homeTeam: "Argentina",
  awayTeam: "Egypt",
  dateUtc: "2026-07-07",
  finalScore: { Argentina: 3, Egypt: 2 } as Record<string, number>,
} as const;

const POSITIONS: readonly FixturePosition[] = ["GK", "DEF", "MID", "FWD"];
const EVENT_TYPES: readonly FixtureEventType[] = [
  "GOAL",
  "PENALTY_GOAL",
  "OWN_GOAL",
  "YELLOW_CARD",
  "SECOND_YELLOW",
  "RED_CARD",
  "SUBSTITUTION",
  "PENALTY_SAVE",
];
const PERIODS: readonly FixturePeriod[] = ["1H", "2H", "ET1", "ET2"];
const PERIOD_ORDER: Record<FixturePeriod, number> = { "1H": 0, "2H": 1, ET1: 2, ET2: 3 };

export class FixtureValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`fixture snapshot rejected (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n- ${problems.join("\n- ")}`);
    this.name = "FixtureValidationError";
    this.problems = problems;
  }
}

/** Chronological sort key: period, then minute, then stoppage. */
export function eventOrderKey(e: FixtureEvent): number {
  return PERIOD_ORDER[e.period] * 100_000 + e.minute * 100 + (e.stoppage ?? 0);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Validate an untrusted candidate snapshot. Returns the typed snapshot on
 * success; throws FixtureValidationError listing every problem found.
 */
export function validateFixture(raw: unknown): FixtureSnapshot {
  const problems: string[] = [];
  if (!isRecord(raw)) throw new FixtureValidationError(["snapshot is not a JSON object"]);
  const s = raw as Partial<FixtureSnapshot> & Record<string, unknown>;

  // --- pinned fixture identity ---
  if (s.schemaVersion !== 1) problems.push(`schemaVersion must be 1, got ${JSON.stringify(s.schemaVersion)}`);
  if (s.fixtureId !== EXPECTED_FIXTURE.fixtureId) {
    problems.push(`fixtureId must be "${EXPECTED_FIXTURE.fixtureId}", got ${JSON.stringify(s.fixtureId)}`);
  }
  if (s.homeTeam !== EXPECTED_FIXTURE.homeTeam || s.awayTeam !== EXPECTED_FIXTURE.awayTeam) {
    problems.push(
      `teams must be ${EXPECTED_FIXTURE.homeTeam} vs ${EXPECTED_FIXTURE.awayTeam}, got ${JSON.stringify(s.homeTeam)} vs ${JSON.stringify(s.awayTeam)}`,
    );
  }
  if (s.dateUtc !== EXPECTED_FIXTURE.dateUtc) {
    problems.push(`dateUtc must be ${EXPECTED_FIXTURE.dateUtc}, got ${JSON.stringify(s.dateUtc)}`);
  }
  if (typeof s.competition !== "string" || !s.competition.trim()) problems.push("competition is required");
  if (typeof s.stage !== "string" || !s.stage.trim()) problems.push("stage is required");
  if (typeof s.wentToExtraTime !== "boolean") problems.push("wentToExtraTime must be a boolean");
  if (typeof s.penaltyShootout !== "boolean") problems.push("penaltyShootout must be a boolean");

  // --- final score ---
  const score = isRecord(s.finalScore) ? (s.finalScore as Record<string, number>) : null;
  if (!score) {
    problems.push("finalScore is required");
  } else {
    for (const [team, goals] of Object.entries(EXPECTED_FIXTURE.finalScore)) {
      if (score[team] !== goals) {
        problems.push(`finalScore.${team} must be ${goals}, got ${JSON.stringify(score[team])}`);
      }
    }
    for (const team of Object.keys(score)) {
      if (!(team in EXPECTED_FIXTURE.finalScore)) problems.push(`finalScore has unknown team ${JSON.stringify(team)}`);
    }
  }

  // --- players ---
  const players = Array.isArray(s.players) ? (s.players as FixturePlayer[]) : null;
  const playerIds = new Set<string>();
  if (!players || players.length === 0) {
    problems.push("players array is required and must be non-empty");
  } else {
    const startersByTeam = new Map<string, number>();
    for (const [i, p] of players.entries()) {
      const at = `players[${i}]`;
      if (!isRecord(p)) {
        problems.push(`${at} is not an object`);
        continue;
      }
      if (typeof p.id !== "string" || !/^[a-z0-9-]+$/.test(p.id)) {
        problems.push(`${at}.id must be a stable kebab-case id, got ${JSON.stringify(p.id)}`);
      } else if (playerIds.has(p.id)) {
        problems.push(`duplicate player id ${JSON.stringify(p.id)}`);
      } else {
        playerIds.add(p.id);
      }
      if (typeof p.name !== "string" || !p.name.trim()) problems.push(`${at}.name is required`);
      if (p.team !== EXPECTED_FIXTURE.homeTeam && p.team !== EXPECTED_FIXTURE.awayTeam) {
        problems.push(`${at}.team must be one of the fixture teams, got ${JSON.stringify(p.team)}`);
      }
      if (!POSITIONS.includes(p.position as FixturePosition)) {
        problems.push(`${at}.position must be one of ${POSITIONS.join("/")}, got ${JSON.stringify(p.position)}`);
      }
      if (p.shirt !== null && (!Number.isInteger(p.shirt) || (p.shirt as number) < 1 || (p.shirt as number) > 99)) {
        problems.push(`${at}.shirt must be null or an integer 1-99`);
      }
      if (typeof p.started !== "boolean") problems.push(`${at}.started must be a boolean`);
      if (p.started === true && typeof p.team === "string") {
        startersByTeam.set(p.team, (startersByTeam.get(p.team) ?? 0) + 1);
      }
    }
    for (const team of [EXPECTED_FIXTURE.homeTeam, EXPECTED_FIXTURE.awayTeam]) {
      const starters = startersByTeam.get(team) ?? 0;
      if (starters !== 11) problems.push(`${team} must have exactly 11 starters, got ${starters}`);
    }
  }

  // --- events ---
  const events = Array.isArray(s.events) ? (s.events as FixtureEvent[]) : null;
  if (!events) {
    problems.push("events array is required");
  } else {
    const goalsByTeam: Record<string, number> = { [EXPECTED_FIXTURE.homeTeam]: 0, [EXPECTED_FIXTURE.awayTeam]: 0 };
    let lastKey = -1;
    for (const [i, e] of events.entries()) {
      const at = `events[${i}]`;
      if (!isRecord(e)) {
        problems.push(`${at} is not an object`);
        continue;
      }
      if (!EVENT_TYPES.includes(e.type as FixtureEventType)) {
        problems.push(`${at}.type invalid: ${JSON.stringify(e.type)}`);
        continue;
      }
      if (!PERIODS.includes(e.period as FixturePeriod)) problems.push(`${at}.period invalid: ${JSON.stringify(e.period)}`);
      if (!Number.isInteger(e.minute) || e.minute < 1 || e.minute > 120) {
        problems.push(`${at}.minute must be an integer 1-120, got ${JSON.stringify(e.minute)}`);
      }
      if (e.stoppage !== null && (!Number.isInteger(e.stoppage) || (e.stoppage as number) < 1)) {
        problems.push(`${at}.stoppage must be null or a positive integer`);
      }
      if (e.team !== EXPECTED_FIXTURE.homeTeam && e.team !== EXPECTED_FIXTURE.awayTeam) {
        problems.push(`${at}.team invalid: ${JSON.stringify(e.team)}`);
      }
      if (typeof e.playerId !== "string" || !playerIds.has(e.playerId)) {
        problems.push(`${at}.playerId references unknown player ${JSON.stringify(e.playerId)}`);
      }
      if (e.assistPlayerId !== null && !playerIds.has(e.assistPlayerId as string)) {
        problems.push(`${at}.assistPlayerId references unknown player ${JSON.stringify(e.assistPlayerId)}`);
      }
      if (e.type === "SUBSTITUTION") {
        if (typeof e.playerOnId !== "string" || !playerIds.has(e.playerOnId)) {
          problems.push(`${at}.playerOnId references unknown player ${JSON.stringify(e.playerOnId)}`);
        }
      } else if (e.playerOnId !== null && e.playerOnId !== undefined) {
        problems.push(`${at}.playerOnId is only valid on SUBSTITUTION events`);
      }
      if (Number.isInteger(e.minute) && PERIODS.includes(e.period as FixturePeriod)) {
        const key = eventOrderKey(e);
        if (key < lastKey) problems.push(`${at} is out of chronological order`);
        lastKey = Math.max(lastKey, key);
      }
      if (e.type === "GOAL" || e.type === "PENALTY_GOAL") {
        if (typeof e.team === "string" && e.team in goalsByTeam) goalsByTeam[e.team] += 1;
      } else if (e.type === "OWN_GOAL") {
        // An own goal is credited to the opposing team's score.
        const other = e.team === EXPECTED_FIXTURE.homeTeam ? EXPECTED_FIXTURE.awayTeam : EXPECTED_FIXTURE.homeTeam;
        goalsByTeam[other] += 1;
      }
    }
    for (const [team, expected] of Object.entries(EXPECTED_FIXTURE.finalScore)) {
      if (goalsByTeam[team] !== expected) {
        problems.push(`goal events for ${team} total ${goalsByTeam[team]}, inconsistent with final score ${expected}`);
      }
    }
  }

  // --- provenance ---
  const sources = Array.isArray(s.sources) ? s.sources : null;
  if (!sources || sources.length < 2) {
    problems.push("at least 2 independent sources are required");
  } else {
    for (const [i, src] of sources.entries()) {
      if (!isRecord(src) || typeof src.url !== "string" || !/^https?:\/\/.+/.test(src.url)) {
        problems.push(`sources[${i}].url must be a valid http(s) URL`);
      }
      if (!isRecord(src) || typeof src.publisher !== "string" || !src.publisher.trim()) {
        problems.push(`sources[${i}].publisher is required`);
      }
    }
  }
  if (!Array.isArray(s.discrepancies) || (s.discrepancies as unknown[]).some((d) => typeof d !== "string")) {
    problems.push("discrepancies must be an array of strings (empty when sources fully agree)");
  }
  if (typeof s.retrievedAt !== "string" || Number.isNaN(Date.parse(s.retrievedAt))) {
    problems.push("retrievedAt must be a valid ISO timestamp");
  }

  if (problems.length > 0) throw new FixtureValidationError(problems);
  return s as FixtureSnapshot;
}
