# ⚽ Pitch Exchange — Fantasy Soccer Stock Market

A fantasy sports web app where you don't draft a roster — you **trade shares in
players** with play money while a simulated soccer match runs live. Share prices
move in real time via an **LMSR automated market maker**, driven by both user
trades and match events. Highest portfolio at full time wins the league.

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000  (PORT=3210 npm run dev to change)
```

Create a league, share the 6-character invite code with friends, everyone joins,
host hits **Start match**. A 90-minute match plays out in ~10 real minutes
(configurable 1–30 at league creation).

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
- **Leagues** (`src/lib/game/`) — invite codes, up to 20 traders, $100k
  starting cash, cash-can't-go-negative + fully-collateralized-short rules,
  settlement + leaderboard.
- **Server** (`server.ts`) — custom Next.js server with a WebSocket hub;
  all state in memory, zero external dependencies, demo-safe on bad wifi.
- **UI** (`src/app/`) — live market table with sparklines, buy/sell/short,
  portfolio + P&L, match ticker, leaderboard, settlement banner.

## Scripts for verification

- `scripts/smoke.ts` — end-to-end WS test: create → join ×2 → trade/short →
  risk-check rejections → full match → settlement assertions.
- `scripts/screenshot.ts` — drives the real UI headlessly (Playwright) and
  captures lobby/live screenshots.

Rosters are fictional (FC Falcon vs United Wolves). No external APIs.
