/**
 * Runtime fixture loading: read the committed snapshot from disk once,
 * validate it, and keep it in memory. Every league reuses the cached
 * snapshot; a server restart just reloads the same committed file.
 *
 * There is deliberately no refresh path here — regenerating the snapshot is
 * a developer action (scripts/ingest-fixture.ts) followed by review and a
 * commit. If the file is missing or fails validation the app must refuse to
 * create leagues rather than substitute synthetic data.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateFixture, FixtureValidationError } from "./validate";
import type { FixtureSnapshot } from "./types";

export const FIXTURE_PATH = join(process.cwd(), "src", "data", "fixtures", "argentina-egypt-2026.json");

export type FixtureAvailability =
  | { ok: true; fixture: FixtureSnapshot }
  | { ok: false; error: string };

let cache: FixtureAvailability | null = null;

/** Load (once) and return availability. Never throws. */
export function fixtureAvailability(): FixtureAvailability {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    cache = { ok: true, fixture: validateFixture(raw) };
  } catch (err) {
    const reason =
      err instanceof FixtureValidationError
        ? err.message
        : err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT"
          ? `fixture snapshot not found at ${FIXTURE_PATH} — run the ingestion script and commit the result`
          : `fixture snapshot unreadable: ${err instanceof Error ? err.message : String(err)}`;
    cache = { ok: false, error: reason };
  }
  return cache;
}

/** The cached committed fixture. Throws when unavailable — callers that can
 *  degrade gracefully should use fixtureAvailability() instead. */
export function getFixture(): FixtureSnapshot {
  const availability = fixtureAvailability();
  if (!availability.ok) throw new Error(availability.error);
  return availability.fixture;
}

/** Test hook: clear the memory cache so a test can point at fresh state. */
export function resetFixtureCache(): void {
  cache = null;
}
