/**
 * In-memory league registry. Lives only in the custom server's module graph
 * (server.ts + ws handlers) — Next.js route handlers must NOT import this,
 * since Next bundles app code separately and would get a second instance.
 */

import { League, type LeagueOptions } from "./league";

const leagues = new Map<string, League>();

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L

function generateCode(): string {
  let code = "";
  do {
    code = Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");
  } while (leagues.has(code));
  return code;
}

export function createLeague(opts: Omit<LeagueOptions, "code">): League {
  const league = new League({ ...opts, code: generateCode() });
  leagues.set(league.code, league);
  return league;
}

export function getLeague(code: string): League | undefined {
  return leagues.get(code.toUpperCase());
}

// ---------------------------------------------------------------------------
// World Cup 2026 — the one league Sarvagya is actually in. Fixed invite code
// so the homepage can link straight to it; seeded with fake traders and a
// match that's already in progress so the demo opens "live" instead of at
// kickoff with an empty lobby.
// ---------------------------------------------------------------------------

export const WORLD_CUP_CODE = "WC2026";
export const WORLD_CUP_HOST = "Sarvagya";

const BOT_TRADERS = [
  "Priya K.", "Marco D.", "Aiko T.", "Liam O.", "Fatima R.",
  "Chen W.", "Noah S.", "Elena V.", "Kwame A.", "Zara H.",
];

function randomPositions(playerIds: string[], count: number): Record<string, number> {
  const shuffled = [...playerIds].sort(() => Math.random() - 0.5);
  const positions: Record<string, number> = {};
  for (const id of shuffled.slice(0, count)) {
    const shares = Math.round((Math.random() - 0.35) * 500); // skews slightly long
    if (shares !== 0) positions[id] = shares;
  }
  return positions;
}

/** Idempotent: returns the existing singleton after the first call. */
export function ensureWorldCupLeague(): League {
  const existing = leagues.get(WORLD_CUP_CODE);
  if (existing) return existing;

  const league = new League({
    code: WORLD_CUP_CODE,
    host: WORLD_CUP_HOST,
    buyIn: 1_000_000,
    buyInReal: 10,
    startingCash: 1_000_000,
    matchRealMinutes: 18,
    seasonLabel: "World Cup 2026",
    windowLabel: "Jun 11 – Jul 19, 2026",
    matchLabel: "Final · FC Falcon vs United Wolves",
  });
  leagues.set(league.code, league);

  const playerIds = league.players.map((p) => p.id);

  // Sarvagya (host) — a couple of live positions, not a flat starting balance.
  league.seedBotUser(WORLD_CUP_HOST, 1_000_000, randomPositions(playerIds, 2));

  // 10 fake co-traders with cash/position variance so the leaderboard looks lived-in.
  for (const name of BOT_TRADERS) {
    const cash = Math.round(850_000 + Math.random() * 300_000);
    league.seedBotUser(name, cash, randomPositions(playerIds, 1 + Math.floor(Math.random() * 4)));
  }

  // Kick off and fast-forward into the second half so it reads as live right now.
  league.start(WORLD_CUP_HOST, {}, 58);

  return league;
}
