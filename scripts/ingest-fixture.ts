/**
 * ONE-TIME, DEVELOPER-RUN fixture ingestion.
 *
 *   npx tsx scripts/ingest-fixture.ts                    # live OpenAI web search -> validate -> write
 *   npx tsx scripts/ingest-fixture.ts --dry-run          # validate + print, write nothing
 *   npx tsx scripts/ingest-fixture.ts --from-file <path> # ingest a saved agent answer through the
 *                                                        # exact same validation gate (no API call)
 *
 * Uses the OpenAI Responses API with web search (OPENAI_API_KEY from .env) to
 * retrieve the completed Argentina 3-2 Egypt 2026 World Cup fixture from
 * authoritative sources, cross-checked against the official FIFA match
 * report. The response is untrusted input: it is mapped into the app-owned
 * schema, strictly validated (src/lib/fixtures/validate.ts), and ONLY a
 * fully valid snapshot is written — with source provenance and retrieval
 * time. Missing/contradictory/unverifiable data aborts with a nonzero exit;
 * nothing is ever fabricated to fill a gap.
 *
 * The written file is meant to be reviewed and committed once. The running
 * app reads only the committed file and never calls OpenAI.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateFixture, EXPECTED_FIXTURE } from "../src/lib/fixtures/validate";
import type { FixtureEvent, FixturePlayer, FixtureSnapshot } from "../src/lib/fixtures/types";

const OUT_PATH = join(process.cwd(), "src", "data", "fixtures", "argentina-egypt-2026.json");
const DRY_RUN = process.argv.includes("--dry-run");

// ---------------------------------------------------------------------------
// Env: read OPENAI_API_KEY from .env (script-only; the demo server never uses it)
// ---------------------------------------------------------------------------

function loadDotEnv(): void {
  const path = join(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// ---------------------------------------------------------------------------
// The agent's answer contract (names, not ids — ids are derived locally)
// ---------------------------------------------------------------------------

interface AgentPlayer {
  name: string;
  team: string;
  position: string;
  shirt: number | null;
  started: boolean;
}

interface AgentEvent {
  minute: number;
  stoppage: number | null;
  period: string;
  type: string;
  team: string;
  player: string;
  assist: string | null;
  playerOn: string | null;
}

interface AgentAnswer {
  verified: boolean;
  /** Disagreements on score/scorers/teams/date — any entry aborts ingestion. */
  coreConflicts: string[];
  /** Small detail disagreements (e.g. a card minute) + how they were resolved. */
  minorDiscrepancies: string[];
  match: {
    competition: string;
    stage: string;
    dateUtc: string;
    venue: string | null;
    city: string | null;
    homeTeam: string;
    awayTeam: string;
    finalScore: Record<string, number>;
    wentToExtraTime: boolean;
    penaltyShootout: boolean;
  };
  players: AgentPlayer[];
  events: AgentEvent[];
  sources: { url: string; publisher: string; whatItVerified: string }[];
}

const PROMPT = `Research the completed 2026 FIFA World Cup fixture: ${EXPECTED_FIXTURE.homeTeam} vs ${EXPECTED_FIXTURE.awayTeam}, played ${EXPECTED_FIXTURE.dateUtc}, final score ${EXPECTED_FIXTURE.finalScore.Argentina}-${EXPECTED_FIXTURE.finalScore.Egypt} to Argentina.

Use web search. You MUST locate the official FIFA match report for this fixture plus at least one independent authoritative source (BBC, ESPN, Guardian, etc.) and cross-check the final score and every scorer between them.

Return ONLY a JSON object (no markdown fence, no prose) with this exact shape:
{
  "verified": boolean,          // true only if score AND scorers agree across sources
  "coreConflicts": string[],    // disagreements on score, scorers, teams, or date; empty if none
  "minorDiscrepancies": string[], // small detail disagreements (e.g. a card minute differs by 1) and which source you followed
  "match": { "competition": string, "stage": string, "dateUtc": "YYYY-MM-DD", "venue": string|null, "city": string|null, "homeTeam": string, "awayTeam": string, "finalScore": {"Argentina": n, "Egypt": n}, "wentToExtraTime": boolean, "penaltyShootout": boolean },
  "players": [ { "name": string, "team": "Argentina"|"Egypt", "position": "GK"|"DEF"|"MID"|"FWD", "shirt": number|null, "started": boolean } ],
  "events": [ { "minute": number, "stoppage": number|null, "period": "1H"|"2H"|"ET1"|"ET2", "type": "GOAL"|"PENALTY_GOAL"|"OWN_GOAL"|"YELLOW_CARD"|"SECOND_YELLOW"|"RED_CARD"|"SUBSTITUTION"|"PENALTY_SAVE", "team": string, "player": string, "assist": string|null, "playerOn": string|null } ],
  "sources": [ { "url": string, "publisher": string, "whatItVerified": string } ]
}

Rules:
- players: BOTH teams — exactly 11 started=true for Argentina AND exactly 11 started=true for Egypt, plus every substitute who appeared (started=false). An answer with only one team's players is invalid and useless.
- events: every verified goal (with assist when recorded), yellow/red card, substitution, and any goalkeeper penalty save, in chronological order. A real knockout match typically has several substitutions and cards — search match reports and live commentary until you have found them all (or can state none occurred).
- every player name used in events (player/assist/playerOn) must appear CHARACTER-FOR-CHARACTER IDENTICALLY in the players array — pick one spelling per person and use it everywhere (transliterations vary across sources; note the variant you chose in minorDiscrepancies).
- NEVER guess. If a detail cannot be verified, use null (or omit the event). If the fixture itself cannot be verified as ${EXPECTED_FIXTURE.homeTeam} ${EXPECTED_FIXTURE.finalScore.Argentina}-${EXPECTED_FIXTURE.finalScore.Egypt} ${EXPECTED_FIXTURE.awayTeam} on ${EXPECTED_FIXTURE.dateUtc}, set verified=false and explain in conflicts.
- sources: list every URL you actually consulted, including the FIFA match report.`;

// ---------------------------------------------------------------------------
// Mapping: agent answer -> app-owned snapshot (ids derived deterministically)
// ---------------------------------------------------------------------------

const TEAM_PREFIX: Record<string, string> = { Argentina: "arg", Egypt: "egy" };

export function slugId(team: string, name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${TEAM_PREFIX[team] ?? "unk"}-${slug}`;
}

export function buildSnapshot(answer: AgentAnswer, retrievedAt: string): unknown {
  if (!answer.verified) {
    throw new Error(`agent could not verify the fixture: ${answer.coreConflicts.join("; ") || "no reason given"}`);
  }
  if (answer.coreConflicts.length > 0) {
    throw new Error(`sources conflict on core facts — refusing to write a snapshot: ${answer.coreConflicts.join("; ")}`);
  }
  // Accent/case/punctuation-insensitive key. Deliberately NOT fuzzy — a name
  // that differs by a letter is treated as a different (unknown) person.
  const nameKey = (name: string) =>
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  const nameToId = new Map<string, string>();
  const players: FixturePlayer[] = answer.players.map((p) => {
    const id = slugId(p.team, p.name);
    nameToId.set(`${p.team}:${nameKey(p.name)}`, id);
    nameToId.set(nameKey(p.name), id); // fallback lookup when the event omits team context
    return { id, name: p.name, team: p.team, position: p.position as FixturePlayer["position"], shirt: p.shirt, started: p.started };
  });
  const resolve = (team: string, name: string | null): string | null => {
    if (name === null) return null;
    const id = nameToId.get(`${team}:${nameKey(name)}`) ?? nameToId.get(nameKey(name));
    if (!id) throw new Error(`event references "${name}" who is not in the player list — refusing to invent a player`);
    return id;
  };
  const events: FixtureEvent[] = answer.events.map((e) => ({
    minute: e.minute,
    stoppage: e.stoppage,
    period: e.period as FixtureEvent["period"],
    type: e.type as FixtureEvent["type"],
    team: e.team,
    playerId: resolve(e.team, e.player)!,
    assistPlayerId: resolve(e.team, e.assist),
    playerOnId: e.type === "SUBSTITUTION" ? resolve(e.team, e.playerOn) : null,
  }));
  return {
    schemaVersion: 1,
    fixtureId: EXPECTED_FIXTURE.fixtureId,
    competition: answer.match.competition,
    stage: answer.match.stage,
    dateUtc: answer.match.dateUtc,
    venue: answer.match.venue,
    city: answer.match.city,
    homeTeam: answer.match.homeTeam,
    awayTeam: answer.match.awayTeam,
    finalScore: answer.match.finalScore,
    wentToExtraTime: answer.match.wentToExtraTime,
    penaltyShootout: answer.match.penaltyShootout,
    players,
    events,
    sources: answer.sources,
    discrepancies: answer.minorDiscrepancies,
    retrievedAt,
  } satisfies FixtureSnapshot;
}

/** Parse the model's text output as the AgentAnswer JSON. */
export function parseAgentAnswer(text: string): AgentAnswer {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`agent response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("agent response is not a JSON object");
  const a = parsed as Partial<AgentAnswer>;
  if (
    typeof a.verified !== "boolean" ||
    !Array.isArray(a.coreConflicts) ||
    !Array.isArray(a.minorDiscrepancies) ||
    !a.match ||
    !Array.isArray(a.players) ||
    !Array.isArray(a.events) ||
    !Array.isArray(a.sources)
  ) {
    throw new Error("agent response missing required fields (verified/coreConflicts/minorDiscrepancies/match/players/events/sources)");
  }
  return a as AgentAnswer;
}

// ---------------------------------------------------------------------------
// OpenAI Responses API call (web search enabled)
// ---------------------------------------------------------------------------

async function callOpenAI(apiKey: string, extraInstruction = ""): Promise<string> {
  const model = process.env.OPENAI_MODEL ?? "gpt-4.1";
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      tools: [{ type: "web_search" }],
      input: extraInstruction ? `${PROMPT}\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED: ${extraInstruction}\nFix exactly that and answer again in full.` : PROMPT,
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI API error ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const body = (await res.json()) as { output?: { type: string; content?: { type: string; text?: string }[] }[] };
  const text = (body.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text ?? "")
    .join("\n");
  if (!text.trim()) throw new Error("OpenAI response contained no output text");
  return text;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const fromFileIdx = process.argv.indexOf("--from-file");
  if (fromFileIdx !== -1) {
    const path = process.argv[fromFileIdx + 1];
    if (!path) throw new Error("--from-file requires a path to a saved agent answer");
    const answer = parseAgentAnswer(readFileSync(path, "utf8"));
    const valid = validateFixture(buildSnapshot(answer, new Date().toISOString()));
    finish(valid);
    return;
  }

  loadDotEnv();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is not set (put it in .env — see .env.example). This script is the only thing that needs it.");
    process.exit(1);
  }

  // Up to 3 attempts: mechanical contract violations (bad JSON, inconsistent
  // name spellings, missing lineup halves) go back to the model to fix. A
  // verified=false or core-conflict answer is NOT retried — that is a data
  // problem, not a formatting one.
  const MAX_ATTEMPTS = 3;
  let valid: FixtureSnapshot | null = null;
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !valid; attempt++) {
    console.log(`Querying OpenAI web search for the fixture record (attempt ${attempt}/${MAX_ATTEMPTS})…`);
    try {
      const text = await callOpenAI(apiKey, lastError);
      const answer = parseAgentAnswer(text);
      // The gate: strict app-owned validation. Throws with a full problem list.
      valid = validateFixture(buildSnapshot(answer, new Date().toISOString()));
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (/could not verify|conflict on core facts/.test(lastError)) throw err;
      console.warn(`  attempt ${attempt} rejected: ${lastError.split("\n")[0]}`);
    }
  }
  if (!valid) throw new Error(`all ${MAX_ATTEMPTS} attempts rejected; last: ${lastError}`);

  finish(valid);
}

function finish(valid: FixtureSnapshot): void {
  if (DRY_RUN) {
    console.log(JSON.stringify(valid, null, 2));
    console.log("\n--dry-run: snapshot is valid; nothing written.");
    return;
  }
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(valid, null, 2) + "\n");
  console.log(`Wrote validated snapshot to ${OUT_PATH}`);
  console.log(`Sources: ${valid.sources.map((s) => s.url).join(", ")}`);
  console.log("Review the file, then commit it. The running app only ever reads the committed copy.");
}

// Only run as a script — tests import the pure helpers above.
if (process.argv[1]?.endsWith("ingest-fixture.ts")) {
  main().catch((err) => {
    console.error(`\nINGESTION REFUSED: ${err instanceof Error ? err.message : err}`);
    console.error("No snapshot was written. Fix the source data problem and re-run; never hand-edit gaps into the file.");
    process.exit(1);
  });
}
