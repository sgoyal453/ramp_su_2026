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
