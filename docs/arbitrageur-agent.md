# Correlation Arbitrageur Agent

## Overview

The arbitrageur is an OpenAI-powered agent (`src/lib/engine/arbitrageurAgent.ts`) that fires automatically after every verified match event during a live league. Its job is to identify **second-order price effects** — players whose market value should move because of what just happened to someone else — and apply those signals directly to the LMSR markets.

It runs asynchronously after the primary signal so it never blocks the match clock. If `OPENAI_API_KEY` is not set, the agent silently does nothing and the app works identically to before.

---

## How it fits into the match lifecycle

```
MatchEvent fires (e.g. Messi scores)
  │
  ├── Primary signal applied immediately
  │     market.applySignal(+150 shares to arg-lionel-messi)
  │
  ├── broadcastState → all clients see Messi's price jump
  │
  └── runArbitrageur(event, context)  ← fire and forget (async)
        │
        ├── Round 1: get_players() + get_match_state()  (parallel tool calls)
        │     Model receives live prices for all 31 players + current score/minute
        │
        └── Round 2: apply_signal() × N
              e.g. apply_signal("egy-mostafa-shobeir", -25, "GK conceded, clean sheet gone")
                   apply_signal("arg-julian-alvarez",  +18, "same-team FWD, team in form")
                   apply_signal("arg-alexis-mac-allister", +20, "MID likely involved in build-up")
              │
              Each call → market.applySignal() + [Arb] ticker entry + broadcastState
```

Clients watch correlated prices ripple in real time, one by one, as the agent decides them. This mirrors institutional arbitrage: the market catching up to news.

---

## Tools

The agent has exactly three tools. It cannot do anything outside of them.

### `get_players()`

Returns all players in the league with their current live LMSR price.

```json
[
  { "id": "arg-lionel-messi", "name": "Lionel Messi", "team": "Argentina", "position": "FWD", "currentPrice": 74.32 },
  { "id": "egy-mostafa-shobeir", "name": "Mostafa Shobeir", "team": "Egypt", "position": "GK", "currentPrice": 51.10 },
  ...
]
```

### `get_match_state()`

Returns current minute, scoreline, and last 5 non-arbitrageur events for context.

```json
{
  "minute": 34,
  "score": { "Argentina": 2, "Egypt": 1 },
  "recentEvents": [
    { "minute": 34, "type": "GOAL", "playerName": "Lionel Messi", "team": "Argentina", "commentary": "34' — GOAL! Lionel Messi scores for Argentina!" },
    ...
  ]
}
```

### `apply_signal(playerId, shares, reason)`

Directly executes an LMSR signal on a player's market — the same mechanism as user trades and primary bot signals.

| Parameter | Type | Description |
|---|---|---|
| `playerId` | `string` | Target player's id (e.g. `"egy-mostafa-shobeir"`) |
| `shares` | `number` | Signal strength. Positive = bullish, negative = bearish. Clamped server-side to **±50**. |
| `reason` | `string` | One sentence explaining the correlation. Shown in the match ticker. |

**Server-side guards (enforced regardless of model output):**
- `shares` clamped to `[-50, 50]`
- Primary event player (`event.playerId`) always rejected — no double-counting
- Settled markets silently rejected
- Unknown player IDs rejected

A successful call:
1. Calls `market.applySignal(shares)` on the target LMSR market
2. Appends a `[Arb] <reason>` entry to the league ticker (`isArbitrageur: true`)
3. Triggers `broadcastState` so all clients see the price move immediately

---

## Signal guidelines (from the system prompt)

The model is instructed to follow these rules for each event type from the verified Argentina vs Egypt fixture:

| Event | Correlated effects |
|---|---|
| `GOAL` / `PENALTY_GOAL` | Opponent GK + DEFs bearish (−20 to −30); same-team MIDs bullish (+15 to +25); same-team other FWDs bullish (+10 to +20) |
| `ASSIST` | Same-team FWDs bullish (+10 to +18); opponent GK slightly bearish (−8 to −12) |
| `OWN_GOAL` | Scoring team's GK bearish (−15 to −20); own-goal player's teammates slightly bearish (−5 to −10) |
| `RED_CARD` / `SECOND_YELLOW` | Same-team survivors bearish (−15 to −25); entire opponent team bullish (+10 to +20) |
| `YELLOW_CARD` | Same-team DEFs slightly bearish (−5 to −10); opponent FWDs slightly bullish (+5 to +8) |
| `PENALTY_SAVE` | Same-team DEFs bullish (+10 to +15); opponent FWDs/MIDs bearish (−10 to −15) |
| `SUBSTITUTION` | Usually no ripple unless attacker replaces defender |

**Sizing modifiers the model applies:**
- After minute 75: signals 30% smaller (less time for effects to materialise)
- Player above $75: less responsive to bullish signals (already priced in)
- Player below $25: less responsive to bearish signals

---

## Agentic loop

The agent runs for up to **6 iterations** (`MAX_ITERATIONS`). In practice it takes 2:

- **Iteration 1** — Model requests `get_players` and `get_match_state` in parallel (`parallel_tool_calls: true`). Both resolve in one round-trip.
- **Iteration 2** — Model calls `apply_signal` for each correlated player it decides to signal (also parallel). Loop ends when `finish_reason === "stop"`.

Total latency: ~1–2 seconds, fully async from the match clock.

**Model:** `gpt-4o-mini` — fast, cheap, reliable for structured tool calling.

---

## Ticker display

Arbitrageur signals appear in the match ticker as italicised, dimmed entries with a purple left border — visually distinct from primary match events but visible and readable:

```
[Arb] GK conceded — Shobeir's clean sheet gone after Messi's goal
[Arb] Mac Allister was involved in build-up — Argentina midfield in form
```

The `reason` string is whatever the model provided in the `apply_signal` call.

---

## Configuration

Add to your `.env` (copy from `.env.example`):

```
OPENAI_API_KEY=sk-proj-...
```

Without this key the agent never runs. The app, tests, and offline demo all work identically — the agent is purely additive.

---

## Integration points

| File | Role |
|---|---|
| `src/lib/engine/arbitrageurAgent.ts` | Agent implementation — `runArbitrageur(event, context)` |
| `src/lib/game/league.ts` | Calls `runArbitrageur` fire-and-forget inside `sim.on("event")`; implements tool callbacks; exposes `onArbitrageurSignal` hook |
| `server.ts` | Wires `onArbitrageurSignal → broadcastState(league)` |
| `src/lib/types.ts` | `MatchEventDTO.isArbitrageur?: true` — lets the UI distinguish arb entries |
| `src/app/league/[code]/page.tsx` | Renders `.entry.arb` class for arbitrageur ticker entries |
| `src/app/globals.css` | `.ticker .entry.arb` styles |

---

## Extending

**To tune signal sizes** — edit the signal ranges in `SYSTEM_PROMPT` inside `arbitrageurAgent.ts`.

**To add new event types** — add them to the bullet list in `SYSTEM_PROMPT`. The model will pick them up immediately; no code changes needed.

**To change the model** — swap `"gpt-4o-mini"` in the `client.chat.completions.create` call. `gpt-4o` would produce higher-quality reasoning at ~3× the cost and ~2× the latency.

**To cap signal strength further** — lower `MAX_SIGNAL_SHARES` (currently `50`).

**To increase the agentic depth** — raise `MAX_ITERATIONS` (currently `6`). The model rarely needs more than 2 iterations.
