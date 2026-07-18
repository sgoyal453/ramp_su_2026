/**
 * App-owned schema for a verified historical fixture snapshot.
 *
 * A snapshot is produced ONCE by the developer-run ingestion script
 * (scripts/ingest-fixture.ts), validated strictly (validate.ts), reviewed,
 * and committed to src/data/fixtures/. At runtime the server only ever reads
 * the committed file — no API key, model call, or web search happens in the
 * running app.
 *
 * Everything in a snapshot must be verifiable against the cited sources.
 * Unknown details are null — never guessed.
 */

export type FixturePosition = "GK" | "DEF" | "MID" | "FWD";

export type FixtureEventType =
  | "GOAL"
  | "PENALTY_GOAL"
  | "OWN_GOAL"
  | "YELLOW_CARD"
  | "SECOND_YELLOW"
  | "RED_CARD"
  | "SUBSTITUTION"
  | "PENALTY_SAVE";

export type FixturePeriod = "1H" | "2H" | "ET1" | "ET2";

export interface FixturePlayer {
  /** Stable, unique, slug-style id derived from team + name (e.g. "arg-lionel-messi"). */
  id: string;
  name: string;
  team: string;
  position: FixturePosition;
  shirt: number | null;
  /** True for the starting XI; false for substitutes who appeared. */
  started: boolean;
}

export interface FixtureEvent {
  /** Match minute as recorded (1-90, or 91-120 in extra time). */
  minute: number;
  /** Stoppage-time component, e.g. 2 for "45+2". Null when none. */
  stoppage: number | null;
  period: FixturePeriod;
  type: FixtureEventType;
  team: string;
  playerId: string;
  /** Verified assist provider for goal events; null when none recorded. */
  assistPlayerId: string | null;
  /** For SUBSTITUTION: the player coming on (playerId is the player going off). */
  playerOnId: string | null;
}

export interface FixtureSource {
  url: string;
  publisher: string;
  whatItVerified: string;
}

export interface FixtureSnapshot {
  schemaVersion: 1;
  fixtureId: string;
  competition: string;
  stage: string;
  /** Kickoff date in UTC, YYYY-MM-DD. */
  dateUtc: string;
  venue: string | null;
  city: string | null;
  homeTeam: string;
  awayTeam: string;
  /** team name -> goals at full time (after extra time if played). */
  finalScore: Record<string, number>;
  wentToExtraTime: boolean;
  penaltyShootout: boolean;
  players: FixturePlayer[];
  /** Chronological verified events. */
  events: FixtureEvent[];
  /** Provenance: every source the ingestion run actually used. */
  sources: FixtureSource[];
  /**
   * Minor cross-source discrepancies found during ingestion (e.g. a card
   * minute differing by one between publishers) and how they were resolved.
   * Core conflicts — score, scorers, teams, date — are never recorded here;
   * they abort ingestion instead.
   */
  discrepancies: string[];
  /** ISO timestamp of the ingestion run that produced this snapshot. */
  retrievedAt: string;
}
