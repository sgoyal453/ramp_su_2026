/**
 * Wire types shared by the WebSocket server and the browser client.
 * Keep this file dependency-free so the frontend bundle stays tiny.
 */

export type FieldPosition = "GK" | "DEF" | "MID" | "FWD";
export type LeagueStatus = "lobby" | "live" | "settled";

export interface PublicPlayerDTO {
  id: string;
  name: string;
  team: string;
  position: FieldPosition;
  b: number;
  initialQ?: number;
}

export interface MatchEventDTO {
  minute: number;
  type: string;
  playerId: string;
  playerName: string;
  team: string;
  points: number;
  signalShares: number;
  commentary: string;
}

export interface LeaderboardEntryDTO {
  username: string;
  cash: number;
  /** cash + mark-to-market value of open positions */
  value: number;
  /** playerId -> net shares (negative = short); visible to everyone for the demo */
  positions: Record<string, number>;
}

export interface PortfolioDTO {
  username: string;
  cash: number;
  /** playerId -> net shares (negative = short) */
  positions: Record<string, number>;
  value: number;
}

export interface LeagueStateDTO {
  code: string;
  status: LeagueStatus;
  buyIn: number;
  /** real-dollar buy-in that `buyIn` fake coins represents, e.g. 10 for "$10 = 1,000,000 coins" */
  buyInReal: number;
  startingCash: number;
  /** e.g. "World Cup 2026" */
  seasonLabel: string;
  /** e.g. "Jun 11 – Jul 19, 2026" */
  windowLabel: string;
  /** e.g. "Final · FC Falcon vs United Wolves" */
  matchLabel: string;
  host: string;
  users: string[];
  players: PublicPlayerDTO[];
  /** playerId -> current price ($) */
  prices: Record<string, number>;
  /** playerId -> price sampled once per simulated minute (index 0 = kickoff) */
  history: Record<string, number[]>;
  minute: number;
  matchMinutes: number;
  /** team name -> goals */
  score: Record<string, number>;
  ticker: MatchEventDTO[];
  leaderboard: LeaderboardEntryDTO[];
  /** playerId -> settlement price ($), present once settled */
  settlements: Record<string, number> | null;
  /** the requesting user's own portfolio */
  you: PortfolioDTO | null;
}

// --- client -> server ---
export type ClientMessage =
  | { type: "join"; code: string; username: string }
  | { type: "start" }
  | { type: "trade"; playerId: string; shares: number }
  | { type: "quote"; playerId: string; shares: number; reqId: number };

// --- server -> client ---
export type ServerMessage =
  | { type: "state"; state: LeagueStateDTO }
  | { type: "event"; event: MatchEventDTO }
  | { type: "quote_result"; reqId: number; playerId: string; shares: number; cost: number }
  | { type: "trade_result"; playerId: string; shares: number; cost: number; price: number }
  | { type: "error"; message: string };
