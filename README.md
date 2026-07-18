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
  C(q+n) − C(q), numerically stable closed forms. Per-player `b` controls
  volatility (low b = hype rookie, high b = steady veteran). Buys, sells,
  shorts (net-negative positions), and simulator signals all flow through the
  same mechanism.
- **Match simulator** (`src/lib/engine/matchSimulator.ts`) — seeded,
  self-contained event timeline (goals, shots, key passes, tackles, cards…)
  assigned by hidden per-player skill ratings; events nudge markets via bot
  trades; at full time markets settle against each player's normalized
  performance score.
- **Leagues** (`src/lib/game/`) — invite codes, up to 20 traders,
  cash-can't-go-negative + fully-collateralized-short rules, settlement +
  leaderboard. `store.ts` boots one fixed-code singleton, **World Cup 2026**
  (`WC2026`), pre-seeded with 10 fake co-traders and fast-forwarded ~58
  simulated minutes in so the demo opens mid-match instead of at an empty
  kickoff.
- **League directory** (`src/lib/leagues/catalog.ts`) — 20 browsable leagues
  across AFL, Baseball, Basketball, Football, Formula-1, Handball, Hockey,
  MMA, NBA, NFL, Rugby, Volleyball, plus World Cup 2026. Presentational data
  only; World Cup 2026 is the sole entry wired to the trading engine.
- **Server** (`server.ts`) — custom Next.js server with a WebSocket hub;
  all state in memory, zero external dependencies, demo-safe on bad wifi.
- **UI** (`src/app/`) — homepage league browser, live market table with
  sparklines, buy/sell/short, portfolio + P&L, clickable leaderboard rows
  (view any trader's positions), match ticker, settlement banner.

## Scripts for verification

- `scripts/smoke.ts` — end-to-end WS test: create → join ×2 → trade/short →
  risk-check rejections → full match → settlement assertions.
- `scripts/screenshot.ts` — drives the real UI headlessly (Playwright) and
  captures lobby/live screenshots. Predates the single-user homepage rework
  below and needs updating before use (still targets the old join-by-form
  flow).

Rosters are fictional (FC Falcon vs United Wolves). No external APIs, no real
player names/likeness, no real league data beyond public competition names.

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
