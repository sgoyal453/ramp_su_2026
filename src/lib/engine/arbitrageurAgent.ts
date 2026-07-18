/**
 * Correlation arbitrageur: an OpenAI-powered agent that observes each primary
 * match event and applies correlated LMSR signals to related players' markets.
 *
 * The agent receives the triggering event, then uses three tools to reason
 * about second-order effects:
 *   get_players()       — who's in the league and what are current prices
 *   get_match_state()   — minute, score, and recent events for context
 *   apply_signal()      — directly moves a player's LMSR market (±50 cap)
 *
 * Runs async after the primary signal so it never blocks the match clock.
 * Gracefully no-ops when OPENAI_API_KEY is absent.
 */

import OpenAI from "openai";
import type { ReplayEvent } from "./historicalReplay";

export interface PlayerSnapshot {
  id: string;
  name: string;
  team: string;
  position: string;
  currentPrice: number;
}

export interface MatchStateSnapshot {
  minute: number;
  score: Record<string, number>;
  recentEvents: Array<{
    minute: number;
    type: string;
    playerName: string;
    team: string;
    commentary: string;
  }>;
}

export interface ArbitrageurContext {
  getPlayers: () => PlayerSnapshot[];
  getMatchState: () => MatchStateSnapshot;
  /**
   * Apply a correlated signal to a player's market.
   * Returns false if rejected (market settled, invalid player id, or
   * attempting to double-signal the primary event player).
   */
  applySignal: (playerId: string, shares: number, reason: string) => boolean;
}

const MAX_ITERATIONS = 6;
const MAX_SIGNAL_SHARES = 50;

const SYSTEM_PROMPT = `You are an automated market arbitrageur for a fantasy soccer trading game \
based on real verified match data (Argentina vs Egypt, 2026 World Cup Round of 16). \
Player share prices are driven by an LMSR (Logarithmic Market Scoring Rule) market maker — \
prices live in a $0–$100 range: $50 = neutral, >$50 = performing well, <$50 = underperforming.

When a primary verified match event occurs involving one player, identify genuinely correlated \
second-order effects on OTHER players and call apply_signal for each one.

Event types you will encounter (verified real events only — no fabricated stats):
• GOAL / PENALTY_GOAL: opponent GK and DEFs bearish (clean sheet gone, -20 to -30 shares); \
same-team MIDs bullish (+15 to +25, assist probability); same-team other FWDs bullish \
(+10 to +20, team in form)
• ASSIST: same-team FWDs bullish (+10 to +18, getting good service from this creator); \
opponent GK slightly bearish (-8 to -12, team is combining well)
• OWN_GOAL: scoring team's GK bearish (-15 to -20, fluky goal); own-goal player's teammates \
slightly bearish (-5 to -10, morale dip)
• RED_CARD / SECOND_YELLOW: same-team survivors bearish (-15 to -25, playing 10v11); \
entire opponent team bullish (+10 to +20, numerical advantage for remaining match
• YELLOW_CARD: same-team DEFs slightly bearish (-5 to -10, reckless backline); \
opponent FWDs slightly bullish (+5 to +8, more space)
• PENALTY_SAVE: same-team outfield DEFs bullish (+10 to +15, massive momentum swing); \
opponent FWDs/MIDs bearish (-10 to -15, penalty missed = morale blow)
• SUBSTITUTION: usually no ripple unless the player coming ON is a known attacker \
replacing a DEF (slight bullish for same-team FWDs, -5 to +8)

Sizing rules:
- Signals after minute 75: 30% smaller (less time for effects to materialise)
- Players already above $75: less responsive to bullish signals
- Players already below $25: less responsive to bearish signals
- Be selective — only signal players genuinely affected; never signal everyone on a team

Call get_players() and get_match_state() first to calibrate to the live market. \
Do NOT signal the player who triggered the primary event — they are already priced in.`;

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_players",
      description:
        "Get all players in the league with their id, name, team, position, and current LMSR market price in dollars.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_match_state",
      description:
        "Get the current match minute, scoreline, and the last 5 match events for context.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_signal",
      description:
        "Apply a correlated market signal to a player's LMSR market. " +
        "Positive shares = bullish (price rises), negative = bearish (price falls). " +
        "Capped server-side at ±50 shares. Do NOT call for the player who triggered the primary event.",
      parameters: {
        type: "object",
        properties: {
          playerId: {
            type: "string",
            description: "The target player's id (e.g. 'fal-mid-6')",
          },
          shares: {
            type: "number",
            description: "Signal strength in shares. Range: -50 to +50.",
          },
          reason: {
            type: "string",
            description:
              "One concise sentence explaining why this player is affected.",
          },
        },
        required: ["playerId", "shares", "reason"],
      },
    },
  },
];

export async function runArbitrageur(
  event: ReplayEvent,
  context: ArbitrageurContext,
): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return;

  const client = new OpenAI({ apiKey });

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `Primary event at minute ${event.minute}: ${event.type} by ${event.playerName} ` +
        `(team: ${event.team}, id: ${event.playerId}).\n` +
        `Commentary: "${event.commentary}"\n` +
        `Primary LMSR signal already applied: ${event.signalShares > 0 ? "+" : ""}${event.signalShares} shares to ${event.playerId}.\n\n` +
        `Call get_players() and get_match_state() to understand the live market, then apply ` +
        `correlated signals to other affected players.`,
    },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      parallel_tool_calls: true,
    });

    const choice = response.choices[0];
    messages.push(choice.message);

    if (choice.finish_reason !== "tool_calls" || !choice.message.tool_calls?.length) break;

    const toolResults: OpenAI.Chat.Completions.ChatCompletionToolMessageParam[] = [];

    for (const tc of choice.message.tool_calls) {
      if (tc.type !== "function") continue; // narrow the SDK union; we only define function tools
      let result: unknown;
      const args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;

      switch (tc.function.name) {
        case "get_players":
          result = context.getPlayers();
          break;

        case "get_match_state":
          result = context.getMatchState();
          break;

        case "apply_signal": {
          const playerId = String(args.playerId ?? "");
          const rawShares = Number(args.shares ?? 0);
          const reason = String(args.reason ?? "");
          const shares = Math.max(
            -MAX_SIGNAL_SHARES,
            Math.min(MAX_SIGNAL_SHARES, Math.round(rawShares)),
          );
          const accepted = context.applySignal(playerId, shares, reason);
          result = accepted
            ? { ok: true, playerId, shares, message: `Signal of ${shares} shares applied to ${playerId}` }
            : { ok: false, playerId, message: "Signal rejected: market settled, invalid player, or primary player double-signal attempt" };
          break;
        }

        default:
          result = { error: `Unknown tool: ${tc.function.name}` };
      }

      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }

    messages.push(...toolResults);
  }
}
