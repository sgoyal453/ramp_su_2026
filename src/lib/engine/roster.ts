/**
 * Curated fictional roster: FC Falcon vs United Wolves, 9 a side
 * (1 GK, 3 DEF, 3 MID, 2 FWD each) = 18 tradeable players.
 *
 * `skill` (0..1) is HIDDEN from the UI — it drives how often the simulator
 * assigns events to a player, so attentive traders can infer who is quietly
 * good by watching patterns. Never send it to clients.
 *
 * `b` is the per-player LMSR liquidity: low b = volatile hype player,
 * high b = steady veteran. `initialQ` opens pre-match favorites above $50.
 */
export type FieldPosition = "GK" | "DEF" | "MID" | "FWD";

export interface RosterPlayer {
  id: string;
  name: string;
  team: string;
  position: FieldPosition;
  /** Hidden skill rating in (0, 1) — never send to clients. */
  skill: number;
  b: number;
  initialQ?: number;
}

/** Client-safe view of a player (no hidden skill rating). */
export type PublicPlayer = Omit<RosterPlayer, "skill">;

export const TEAMS = {
  FALCON: "FC Falcon",
  WOLVES: "United Wolves",
} as const;

export function createDefaultRoster(): RosterPlayer[] {
  return [
    // --- FC Falcon ---
    { id: "fal-gk-1", name: "Viktor Hale", team: TEAMS.FALCON, position: "GK", skill: 0.72, b: 300 },
    { id: "fal-def-2", name: "Bruno Castel", team: TEAMS.FALCON, position: "DEF", skill: 0.61, b: 250 },
    { id: "fal-def-3", name: "Ade Okonkwo", team: TEAMS.FALCON, position: "DEF", skill: 0.78, b: 220, initialQ: 60 },
    { id: "fal-def-4", name: "Jonas Weir", team: TEAMS.FALCON, position: "DEF", skill: 0.45, b: 200 },
    { id: "fal-mid-6", name: "Mateo Reyna", team: TEAMS.FALCON, position: "MID", skill: 0.85, b: 260, initialQ: 90 },
    { id: "fal-mid-8", name: "Kofi Mensah", team: TEAMS.FALCON, position: "MID", skill: 0.58, b: 180 },
    { id: "fal-mid-10", name: "Ilya Petrov", team: TEAMS.FALCON, position: "MID", skill: 0.69, b: 200 },
    { id: "fal-fwd-9", name: "Dario Lunt", team: TEAMS.FALCON, position: "FWD", skill: 0.81, b: 160, initialQ: 70 },
    { id: "fal-fwd-11", name: "Rio Tanaka", team: TEAMS.FALCON, position: "FWD", skill: 0.52, b: 90 }, // hype rookie: tiny b, big swings
    // --- United Wolves ---
    { id: "wol-gk-1", name: "Emil Varga", team: TEAMS.WOLVES, position: "GK", skill: 0.66, b: 300 },
    { id: "wol-def-2", name: "Sef Adeyemi", team: TEAMS.WOLVES, position: "DEF", skill: 0.7, b: 240 },
    { id: "wol-def-3", name: "Lars Brandt", team: TEAMS.WOLVES, position: "DEF", skill: 0.55, b: 220 },
    { id: "wol-def-5", name: "Tomas Silva", team: TEAMS.WOLVES, position: "DEF", skill: 0.63, b: 230 },
    { id: "wol-mid-4", name: "Yusuf Demir", team: TEAMS.WOLVES, position: "MID", skill: 0.74, b: 240, initialQ: 50 },
    { id: "wol-mid-7", name: "Cole Barrow", team: TEAMS.WOLVES, position: "MID", skill: 0.48, b: 170 },
    { id: "wol-mid-8", name: "Nico Ferreri", team: TEAMS.WOLVES, position: "MID", skill: 0.8, b: 250, initialQ: 80 },
    { id: "wol-fwd-10", name: "Amara Kone", team: TEAMS.WOLVES, position: "FWD", skill: 0.88, b: 200, initialQ: 110 }, // the star
    { id: "wol-fwd-11", name: "Petey Vance", team: TEAMS.WOLVES, position: "FWD", skill: 0.42, b: 100 }, // wildcard
  ];
}

/** Strip the hidden skill rating before sending a player to clients. */
export function publicPlayer(player: RosterPlayer): PublicPlayer {
  const { skill: _skill, ...visible } = player;
  return visible;
}
