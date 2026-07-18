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
import type { MatchEvent } from "./matchSimulator";

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

const SYSTEM_PROMPT = `You are an automated market arbitrageur in a fantasy soccer trading game. \
Player share prices are driven by an LMSR (Logarithmic Market Scoring Rule) market maker — \
prices live in a $0–$100 range, roughly: $50 = neutral, >$50 = performing well, <$50 = underperforming.

When a primary match event occurs involving one player, your job is to identify genuinely \
correlated second-order effects on OTHER players and call apply_signal for each one.

Signal guidelines by event type:
• GOAL: opponent GK and DEFs bearish (clean sheet gone, -20 to -30); same-team MIDs bullish \
(+15 to +25, assist/involvement); same-team other FWDs bullish (+10 to +20, team momentum)
• RED_CARD: same-team survivors bearish (-15 to -25, playing 10v11); entire opponent team \
bullish (+10 to +20, numerical advantage)
• SAVE: same-team DEFs bullish (+10 to +15, clean sheet still alive); opponent FWDs bearish \
(-8 to -12, being stopped)
• KEY_PASS: same-team FWDs bullish (+8 to +15, receiving quality service)
• SHOT_ON_TARGET: opponent GK slightly bearish (-5 to -10, under pressure)
• YELLOW_CARD: same-team DEFs slightly bearish (-5 to -10, reckless backline); opponent FWDs \
slightly bullish (+5 to +8, can be more aggressive)
• TACKLE: same-team GK slightly bullish (+4 to +7, defense is holding)
• FOUL / SHOT_OFF_TARGET / SUBSTITUTION: usually no significant ripple — skip or apply 1-2 \
very small signals only if clearly warranted

Sizing rules:
- Signals after minute 75 should be 30% smaller (less time left for effects to matter)
- Players already priced near $80+ respond less to bullish signals (already priced in)
- Players near $20 or below respond less to bearish signals
- Be selective: only signal players who are genuinely affected, not everyone on the team

Always call get_players() and get_match_state() first to calibrate your signals to the live \
market state. Do NOT signal the player who triggered the primary event — they are already priced in.`;

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
  event: MatchEvent,
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
