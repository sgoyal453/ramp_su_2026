# ⚽ Pitch Exchange — Fantasy Sports Stock Market

A fantasy sports web app where you don't draft a roster — you **trade shares in
players** with play money while a simulated match runs live. Share prices move
in real time via an **LMSR automated market maker**, driven by both user trades
and match events. Highest portfolio when the window closes wins the league.

The app is a **directory of leagues**, one per sport/competition, each running
over its own fixed window (a season, a tournament, a fight card — not a single
game). Sarvagya is a member of exactly one: **World Cup 2026**, playable
end-to-end. Every other league on the homepage is browsable for flavor only.

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000  (PORT=3210 npm run dev to change)
```

The homepage opens straight into the league directory, signed in as
**Sarvagya**. Click the **World Cup 2026** card (marked "you're in this
league") to enter the live trading view; the match is already in progress
when you arrive. Other cards open an info popup — you can look, but Sarvagya
isn't a member.

```bash
npm test             # 44 unit tests (LMSR math, simulator, league rules)
npm run demo         # terminal-only match: node scripts/demo.ts [seed] [seconds]
npm run build        # production build (then: npm start)
```

## How it works

- **LMSR pricing** (`src/lib/engine/lmsr.ts`, `playerMarket.ts`) — each player
  has a binary LMSR market: price = sigmoid(q/b) × $100, cost of a trade =
  C(q+n) − C(q), numerically stable closed forms. Buys, sells, shorts
  (net-negative positions), match-event signals, and correlation-agent
  signals all flow through the same mechanism.
- **Real fixture data, not a simulation** (`src/lib/fixtures/`,
  `src/data/fixtures/argentina-egypt-2026.json`) — every league replays a
  single verified, completed match: Argentina 3–2 Egypt, FIFA World Cup 2026
  Round of 16, cross-checked against 8 independent sources (ESPN, FOX
  Sports, Sky Sports, Al Jazeera, Sports Illustrated) with every
  cross-source discrepancy logged. `scripts/ingest-fixture.ts` is the
  one-time, developer-run ingestion tool (OpenAI web search → strict
  schema validation → commit); the running app never calls an LLM to
  fetch match data, only to read the committed, reviewed JSON snapshot.
  `src/lib/fixtures/validate.ts` rejects anything that doesn't match the
  pinned fixture identity, has fewer than 2 sources, or has scorers/cards
  inconsistent with the final score — a league simply cannot be created
  without a fully valid snapshot (`src/lib/fixtures/load.ts`).
- **Historical replay engine** (`src/lib/engine/historicalReplay.ts`) —
  replays the verified event list (goals, assists, cards, subs, penalty
  saves) on a compressed real-time clock, driving per-player LMSR markets
  exactly like a live feed would; two replays of the same fixture are
  identical. Settlement scores come only from real recorded events — no
  points are fabricated to make quiet players move. The older
  `src/lib/engine/matchSimulator.ts` (fictional, seeded random events) is
  no longer used by any league; it's kept standalone for `npm run demo`,
  a terminal-only illustration of the LMSR math with a generated roster.
- **Correlation arbitrageur agent** (`src/lib/engine/arbitrageurAgent.ts`) —
  an OpenAI tool-calling agent that watches each primary match event and
  reasons about second-order effects on other players (e.g. a red card
  makes the shorthanded team's other defenders bearish and the opposition
  bullish), applying its own small, capped LMSR signals asynchronously so
  it never blocks the match clock. Wired into `server.ts`'s live event
  loop; every accepted signal lands in the ticker tagged `isArbitrageur`
  (shown with a violet 🤖 tag in the UI). No-ops entirely without
  `OPENAI_API_KEY` set — the rest of the app runs identically without it.
- **Leagues** (`src/lib/game/`) — invite codes, up to 20 traders,
  cash-can't-go-negative + fully-collateralized-short rules, settlement +
  leaderboard. `store.ts` boots one fixed-code singleton, **World Cup 2026**
  (`WC2026`), pre-seeded with 10 fake co-traders and fast-forwarded ~58
  match minutes in so the demo opens mid-match instead of at an empty
  kickoff.
- **League directory** (`src/lib/leagues/catalog.ts`) — 20 browsable leagues
  across AFL, Baseball, Basketball, Football, Formula-1, Handball, Hockey,
  MMA, NBA, NFL, Rugby, Volleyball, plus World Cup 2026. Presentational data
  only; World Cup 2026 is the sole entry wired to the trading engine. The
  homepage fetches `GET /api/fixture` to show the real matchup instead of
  a hardcoded placeholder.
- **Server** (`server.ts`) — custom Next.js server with a WebSocket hub;
  all league state in memory. The committed fixture snapshot is loaded and
  validated once at boot; if it's missing or invalid the server still
  starts, but league creation is refused (`503`) rather than falling back
  to anything synthetic.
- **UI** (`src/app/`) — homepage league browser; live player-card grid
  (position-colored, shirt numbers, bench tags, glowing price-pulse on
  every move) with buy/sell/short; portfolio + P&L; an animated leaderboard
  (Framer Motion, reorders as values shift) with clickable rows to view any
  trader's positions; match ticker distinguishing real events from
  agent-driven signals; a "verified against N sources" badge; settlement
  banner. Dark cyber-sports theme (`src/app/globals.css`): deep near-black
  base, electric cyan / neon green / hot pink signal colors.

## Scripts for verification

- `scripts/smoke.ts` — end-to-end WS test: create → join ×2 → trade/short →
  risk-check rejections → full match → settlement assertions against the
  real fixture (24 verified events, final score 3–2).
- `scripts/screenshot.ts` — drives the real UI headlessly (Playwright) and
  captures lobby/live screenshots. Predates the single-user homepage rework
  below and needs updating before use (still targets the old join-by-form
  flow).
- `scripts/ingest-fixture.ts` — developer-only; regenerates the committed
  fixture snapshot from live OpenAI web search. Never run by the app itself.

World Cup 2026 replays real, publicly reported match events (goals, cards,
lineups) with cited sources — the kind of factual sports data any fantasy
platform uses. Every other sport in the directory is browse-only flavor
data. No external API calls happen at runtime; the only network calls in
this repo are the one-time, developer-run ingestion script.

## Changelog

**Single-player entry point.** Removed the create-league/join-by-code forms.
The homepage now signs in as a hardcoded user, **Sarvagya**, and there's no
invite-code flow to opt into — you're either in a league or you're not.
(`src/app/page.tsx`, `src/app/league/[code]/page.tsx`)

**World Cup 2026 as a season-long league, not a single game.** Leagues now
carry a `seasonLabel`, `windowLabel`, and `matchLabel` (e.g. "World Cup 2026" /
"Jun 11 – Jul 19, 2026" / "Final · FC Falcon vs United Wolves"), shown in the
league page header. The underlying match simulator is unchanged (one
compressed live match drives pricing), but the league is now framed as a
tournament window rather than a one-off fixture. (`src/lib/game/league.ts`,
`src/lib/types.ts`)

**$1,000,000 starting cash, $10 real buy-in.** World Cup 2026 starts every
trader at 1,000,000 fake coins; the league page header shows the conversion
badge "$10 = 1,000,000 coins" (`buyInReal` / `buyIn` on the league DTO).
(`src/lib/game/store.ts`, `src/lib/types.ts`)

**Leaderboard seeded with 10 fake co-traders, all portfolios already live.**
`League.seedBotUser()` sets a trader's cash/positions directly (bypassing the
LMSR — cosmetic seeding, not a real trade) so the World Cup 2026 league opens
with a populated, varied leaderboard instead of everyone flat at their
starting balance — including Sarvagya's own seeded position. The match is
also fast-forwarded ~58 of 90 simulated minutes before the live clock starts,
so prices and portfolio values already reflect a match in progress.
(`src/lib/game/store.ts`, `League.start()`'s new `fastForwardMinutes` param)

**Every trader's portfolio is now visible, not just your own.**
`LeaderboardEntryDTO` carries each trader's `positions`; clicking any
leaderboard row (including bots) opens a modal with their full holdings.
Previously only your own portfolio (`you`) was ever sent to the client.
(`src/lib/types.ts`, `src/lib/game/league.ts`, `PortfolioModal` in
`src/app/league/[code]/page.tsx`)

**Homepage is now a scrollable directory of ~20 leagues,** one per sport:
AFL, Baseball (MLB/NPB/KBO), Basketball (EuroLeague/March Madness), Football
(Premier League/La Liga/Champions League), Formula-1, Handball, Hockey
(NHL/IIHF), MMA (UFC), NBA, NFL, Rugby (Six Nations/Rugby World Cup), and
Volleyball — plus World Cup 2026, the only one marked "you're in this
league." Clicking it opens the real trading view; clicking anything else
opens an info popup that makes clear Sarvagya isn't a member. This is a new
static catalog (`src/lib/leagues/catalog.ts`) — none of the other 19 leagues
are wired to a real backend league or trading engine.

**Cyber-sports redesign merged with real-fixture/agent backend.** Two
branches were integrated: a full visual redesign (player stat cards,
price-pulse glow, Framer Motion leaderboard, dark neon theme) and a
from-scratch backend swap (fictional roster + random simulator →
verified real Argentina-Egypt fixture + historical replay + correlation
arbitrageur agent). The merge kept the redesign's visuals/interactions and
the backend branch's data/live-match logic. Fixes made during integration
that the backend branch hadn't caught up on itself:
- `arbitrageurAgent.ts` was dead code — nothing called `runArbitrageur`
  anywhere. Wired it into `server.ts`'s live event loop.
- Its system prompt still described the *old fictional* simulator's event
  vocabulary (`SAVE`, `KEY_PASS`, `TACKLE`, `FOUL`, …), none of which exist
  in the real fixture's event set. Rewritten for the actual event types
  (`GOAL`/`PENALTY_GOAL`/`OWN_GOAL`/`ASSIST`/cards/`SUBSTITUTION`/
  `PENALTY_SAVE`).
- Its OpenAI SDK tool-call handling didn't type-check against the
  installed SDK version (`tool_calls` can include non-function custom
  tools now) — added the `tc.type !== "function"` guard.
- `league.test.ts` still passed a removed `seed` option and traded the old
  fictional player ids (`fal-fwd-9`, `wol-fwd-10`) — rewritten against the
  real fixture (`arg-lionel-messi`, `egy-mohamed-salah`, `league.fixture`).
- `scripts/smoke.ts` had the same stale fictional ids and an 18-player
  settlement assertion (the real fixture has 31 players) — fixed, plus
  swapped its "events streamed" threshold for an exact count (24) since
  fixture replays are deterministic.
- Player cards now surface the real fixture's shirt numbers and bench
  ("SUB") status — data the merged DTO already carried but nothing
  rendered. The league page also shows a "verified against N sources"
  badge and the real venue.
- The homepage's featured World Cup 2026 card had a leftover placeholder
  blurb naming the old fictional teams; it now fetches `/api/fixture` and
  shows the real matchup.
