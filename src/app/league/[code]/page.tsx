"use client";

import { use, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Sparkline } from "@/components/Sparkline";
import type { LeagueStateDTO, MatchEventDTO, PlayerStatsDTO, PublicPlayerDTO, ServerMessage } from "@/lib/types";

const QTY_CHOICES = [10, 25, 50, 100, 250];
const USERNAME = "Sarvagya";

// Position → glow color. Kept out of globals.css because it's data-driven
// (one accent per field position), set per-card via the --pos-color custom
// property that the card's border/chip styles key off of.
const POSITION_COLOR: Record<string, string> = {
  GK: "var(--cyan)",
  DEF: "var(--violet)",
  MID: "var(--gold)",
  FWD: "var(--pink)",
};

const fmt = (n: number, digits = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Brief glowing flash on a price when it moves, direction-coded. */
function usePriceFlash(price: number): "" | "pulse-up" | "pulse-down" {
  const prevRef = useRef(price);
  const [flash, setFlash] = useState<"" | "pulse-up" | "pulse-down">("");
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = price;
    if (Math.abs(price - prev) < 0.005) return;
    setFlash(price > prev ? "pulse-up" : "pulse-down");
    const t = setTimeout(() => setFlash(""), 700);
    return () => clearTimeout(t);
  }, [price]);
  return flash;
}

export default function LeaguePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const username = USERNAME;
  const [state, setState] = useState<LeagueStateDTO | null>(null);
  const [qty, setQty] = useState(25);
  const [viewing, setViewing] = useState<string | null>(null);
  const [statsFor, setStatsFor] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(text: string, error = false) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, error });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    wsRef.current = ws;
    ws.onopen = () => {
      setConnected(true);
      ws.send(JSON.stringify({ type: "join", code, username }));
    };
    ws.onclose = () => setConnected(false);
    ws.onmessage = (msg) => {
      const message = JSON.parse(msg.data) as ServerMessage;
      switch (message.type) {
        case "state":
          setState(message.state);
          break;
        case "event":
          break; // ticker rides along inside state broadcasts
        case "trade_result": {
          const verb = message.cost >= 0 ? `bought for $${fmt(message.cost)}` : `sold for $${fmt(-message.cost)}`;
          showToast(`${Math.abs(message.shares)} shares ${verb} — price now $${fmt(message.price)}`);
          break;
        }
        case "error":
          showToast(message.message, true);
          break;
      }
    };
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, username]);

  const trade = (playerId: string, shares: number) =>
    wsRef.current?.send(JSON.stringify({ type: "trade", playerId, shares }));
  const startMatch = () => wsRef.current?.send(JSON.stringify({ type: "start" }));

  const teams = useMemo(() => (state ? Object.keys(state.score) : []), [state]);

  if (!state) {
    return (
      <main className="league">
        <p className="muted">{connected ? "Joining league…" : "Connecting…"}</p>
      </main>
    );
  }

  const you = state.you;
  const isHost = you?.username === state.host;

  return (
    <main className="league">
      <div className="topbar">
        <span className="code">{USERNAME}</span>
        {state.seasonLabel && <span className="season-label">{state.seasonLabel}</span>}
        <span className={`badge ${state.status}`}>{state.status}</span>
        {state.status !== "lobby" && (
          <>
            <span className="clock">{state.minute}&rsquo;</span>
            <span className="scoreline">{teams.map((t) => `${t} ${state.score[t]}`).join(" — ")}</span>
          </>
        )}
        <span className="spacer" />
        {state.status === "lobby" &&
          (isHost ? (
            <button className="primary" onClick={startMatch}>
              ▶ Start match
            </button>
          ) : (
            <span className="muted">waiting for {state.host} to kick off…</span>
          ))}
        <span className="conversion-badge">
          ${fmt(state.buyInReal, 0)} = {fmt(state.buyIn, 0)} coins
        </span>
      </div>
      {(state.windowLabel || state.matchLabel) && (
        <div className="sub-header muted">
          {state.windowLabel}
          {state.windowLabel && state.matchLabel && " · "}
          {state.matchLabel}
          {state.fixture.venue && ` · ${state.fixture.venue}`}
          {" · "}
          Invite code <span className="code">{state.code}</span> · {state.users.length} traders
          {state.fixture.sources.length > 0 && (
            <>
              {" · "}
              <span className="verified-badge" title={state.fixture.sources.join("\n")}>
                ✓ verified against {state.fixture.sources.length} sources
              </span>
            </>
          )}
        </div>
      )}

      {state.status === "settled" && (
        <div className="fulltime-banner">
          🏁 Full time — all positions settled. {state.leaderboard[0]?.username} wins the league with $
          {fmt(state.leaderboard[0]?.value ?? 0)}.
        </div>
      )}

      <div className="columns">
        <div>
          <section className="panel">
            <h2>Player market</h2>
            <div className="qty-row">
              <span className="label">Trade size</span>
              {QTY_CHOICES.map((n) => (
                <button key={n} className={`qty ${qty === n ? "active" : ""}`} onClick={() => setQty(n)}>
                  {n}
                </button>
              ))}
              <span className="label muted">selling past zero opens a short</span>
            </div>
            <div className="player-grid">
              {state.players.map((p) => (
                <PlayerCard
                  key={p.id}
                  player={p}
                  price={state.prices[p.id]}
                  history={state.history[p.id] ?? []}
                  position={you?.positions[p.id] ?? 0}
                  qty={qty}
                  settled={state.status === "settled"}
                  settlementPrice={state.settlements?.[p.id] ?? null}
                  onTrade={(shares) => trade(p.id, shares)}
                  onViewStats={() => setStatsFor(p.id)}
                />
              ))}
            </div>
          </section>
        </div>

        <div>
          {you && (
            <section className="panel">
              <h2>Your portfolio</h2>
              <div className="big-value">${fmt(you.value)}</div>
              <p className="muted" style={{ margin: "2px 0 10px" }}>
                cash ${fmt(you.cash)} · P&amp;L{" "}
                <span className={you.value >= state.startingCash ? "up" : "down"}>
                  {you.value >= state.startingCash ? "+" : "−"}${fmt(Math.abs(you.value - state.startingCash))}
                </span>
              </p>
              {Object.keys(you.positions).length > 0 && (
                <table className="plain">
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th className="num">Shares</th>
                      <th className="num">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(you.positions).map(([playerId, shares]) => {
                      const player = state.players.find((p) => p.id === playerId);
                      return (
                        <tr key={playerId}>
                          <td>{player?.name ?? playerId}</td>
                          <td className={`num ${shares < 0 ? "down" : ""}`}>{fmt(shares, 0)}</td>
                          <td className="num">${fmt(you.positionValues[playerId] ?? shares * state.prices[playerId])}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>
          )}

          <section className="panel">
            <h2>Leaderboard</h2>
            <div className="leaderboard-list">
              {state.leaderboard.map((entry, i) => (
                <motion.div
                  key={entry.username}
                  layout
                  transition={{ type: "spring", stiffness: 500, damping: 40 }}
                  className={`leader-row ${entry.username === you?.username ? "me" : ""}`}
                  onClick={() => setViewing(entry.username)}
                >
                  <span className={`leader-rank ${i === 0 ? "top1" : i === 1 ? "top2" : i === 2 ? "top3" : ""}`}>
                    {i + 1}
                  </span>
                  <span className="leader-name">{entry.username}</span>
                  <span className="leader-value num">${fmt(entry.value)}</span>
                </motion.div>
              ))}
            </div>
          </section>

          <section className="panel">
            <h2>Match ticker</h2>
            {state.ticker.length === 0 ? (
              <p className="muted">Events will appear here once the match kicks off.</p>
            ) : (
              <div className="ticker">
                {state.ticker.map((event, i) => (
                  <TickerEntry key={`t-${state.ticker.length - i}-${event.playerId}-${event.type}`} event={event} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {toast && <div className={`toast ${toast.error ? "error" : ""}`}>{toast.text}</div>}

      {viewing && (
        <PortfolioModal
          username={viewing}
          entry={state.leaderboard.find((e) => e.username === viewing)!}
          players={state.players}
          prices={state.prices}
          onClose={() => setViewing(null)}
        />
      )}

      {statsFor &&
        (() => {
          const player = state.players.find((p) => p.id === statsFor);
          if (!player) return null;
          return (
            <PlayerStatsModal
              player={player}
              price={state.prices[statsFor]}
              history={state.history[statsFor] ?? []}
              stats={state.playerStats?.[statsFor]}
              settlement={state.settlements?.[statsFor] ?? null}
              status={state.status}
              yourShares={you?.positions[statsFor] ?? 0}
              onClose={() => setStatsFor(null)}
            />
          );
        })()}
    </main>
  );
}

function PlayerCard({
  player,
  price,
  history,
  position,
  qty,
  settled,
  settlementPrice,
  onTrade,
  onViewStats,
}: {
  player: PublicPlayerDTO;
  price: number;
  history: number[];
  position: number;
  qty: number;
  settled: boolean;
  settlementPrice: number | null;
  onTrade: (shares: number) => void;
  onViewStats: () => void;
}) {
  const flash = usePriceFlash(price);
  const kickoff = history[0] ?? price;
  const delta = price - kickoff;
  const flat = Math.abs(delta) < 0.005;
  const posColor = POSITION_COLOR[player.position] ?? "var(--ink-muted)";

  return (
    <div
      className={`player-card clickable-row ${position !== 0 ? "has-position" : ""} ${settled ? "settled" : ""}`}
      style={{ "--pos-color": posColor } as React.CSSProperties}
      onClick={onViewStats}
      title={`View ${player.name}'s stats`}
    >
      <div className="player-card-head">
        <div>
          <div className="player-card-name">
            {player.shirt != null && <span className="shirt-badge">{player.shirt}</span>}
            {player.name}
            {player.started === false && <span className="bench-badge">SUB</span>}
            <span className="stats-hint">stats ›</span>
          </div>
          <div className="player-card-team">{player.team}</div>
        </div>
        <span className="pos-chip">{player.position}</span>
      </div>

      <div className="player-card-price-row">
        <span className={`player-card-price ${flash}`}>${fmt(price)}</span>
        <span className={`player-card-delta ${flat ? "muted" : delta > 0 ? "up" : "down"}`}>
          {flat ? "·" : delta > 0 ? "▲" : "▼"} {fmt(Math.abs(delta))}
        </span>
      </div>

      <div className="player-card-spark">
        <Sparkline data={history} width={220} height={34} />
      </div>

      <div className="player-card-foot">
        {settled ? (
          <span className="settled-price">Settled ${fmt(settlementPrice ?? 0)}</span>
        ) : (
          <span className={`your-shares ${position > 0 ? "has-long" : position < 0 ? "has-short" : ""}`}>
            {position !== 0 ? `${fmt(position, 0)} shares` : "no position"}
          </span>
        )}
        {!settled && (
          <div className="trade-buttons">
            <button
              className="buy"
              onClick={(e) => {
                e.stopPropagation();
                onTrade(qty);
              }}
            >
              Buy
            </button>
            <button
              className="sell"
              onClick={(e) => {
                e.stopPropagation();
                onTrade(-qty);
              }}
            >
              Sell
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const EVENT_LABELS: Record<string, string> = {
  GOAL: "Goals",
  PENALTY_GOAL: "Penalty goals",
  OWN_GOAL: "Own goals",
  ASSIST: "Assists",
  YELLOW_CARD: "Yellow cards",
  SECOND_YELLOW: "Second yellows",
  RED_CARD: "Red cards",
  SUBSTITUTION: "Substitutions",
  PENALTY_SAVE: "Penalty saves",
};

function PlayerStatsModal({
  player,
  price,
  history,
  stats,
  settlement,
  status,
  yourShares,
  onClose,
}: {
  player: LeagueStateDTO["players"][number];
  price: number;
  history: number[];
  stats: PlayerStatsDTO | undefined;
  settlement: number | null;
  status: LeagueStateDTO["status"];
  yourShares: number;
  onClose: () => void;
}) {
  const kickoff = history[0] ?? 50;
  const delta = price - kickoff;
  const pct = kickoff !== 0 ? (delta / kickoff) * 100 : 0;
  const flat = Math.abs(delta) < 0.005;
  const high = history.length ? Math.max(...history) : price;
  const low = history.length ? Math.min(...history) : price;
  const eventRows = Object.entries(stats?.events ?? {}).sort((a, b) => b[1] - a[1]);
  const deltaClass = flat ? "muted" : delta > 0 ? "up" : "down";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-top">
          <h2>{player.name}</h2>
          <span className={`badge ${status}`}>{status}</span>
        </div>
        <div className="player-meta" style={{ marginBottom: 12 }}>
          <span className="pos-badge">{player.position}</span>
          {player.team}
        </div>

        <div className="big-value">${fmt(price)}</div>
        <p className="muted" style={{ margin: "2px 0 12px" }}>
          <span className={deltaClass}>
            {flat ? "·" : delta > 0 ? "▲" : "▼"} ${fmt(Math.abs(delta))} ({fmt(Math.abs(pct), 1)}%)
          </span>{" "}
          since kickoff
        </p>

        <div style={{ margin: "0 0 14px" }}>
          <Sparkline data={history} width={360} height={64} />
        </div>

        <table className="plain">
          <tbody>
            <tr>
              <td className="muted">Session high</td>
              <td className="num">${fmt(high)}</td>
            </tr>
            <tr>
              <td className="muted">Session low</td>
              <td className="num">${fmt(low)}</td>
            </tr>
            <tr>
              <td className="muted">Your position</td>
              <td className={`num ${yourShares < 0 ? "down" : ""}`}>
                {yourShares !== 0 ? `${fmt(yourShares, 0)} shares` : "—"}
              </td>
            </tr>
            <tr>
              <td className="muted">Performance points</td>
              <td className="num">{fmt(stats?.points ?? 0, 1)}</td>
            </tr>
            <tr>
              <td className="muted">{status === "settled" ? "Settled at" : "Projected settlement"}</td>
              <td className="num">
                ${fmt(status === "settled" && settlement != null ? settlement : stats?.projectedSettlement ?? 0)}
              </td>
            </tr>
          </tbody>
        </table>

        <h3 className="stats-subhead">Match events</h3>
        {eventRows.length > 0 ? (
          <table className="plain">
            <tbody>
              {eventRows.map(([type, count]) => (
                <tr key={type}>
                  <td>{EVENT_LABELS[type] ?? type}</td>
                  <td className="num">{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">
            {status === "lobby" ? "No events yet — the match hasn't kicked off." : "No events for this player yet."}
          </p>
        )}

        <button onClick={onClose} style={{ marginTop: 16 }}>
          Close
        </button>
      </div>
    </div>
  );
}

function PortfolioModal({
  username,
  entry,
  players,
  prices,
  onClose,
}: {
  username: string;
  entry: LeagueStateDTO["leaderboard"][number];
  players: LeagueStateDTO["players"];
  prices: LeagueStateDTO["prices"];
  onClose: () => void;
}) {
  const positions = Object.entries(entry.positions);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{username}&rsquo;s portfolio</h2>
        <div className="big-value">${fmt(entry.value)}</div>
        <p className="muted" style={{ margin: "2px 0 10px" }}>
          cash ${fmt(entry.cash)}
        </p>
        {positions.length > 0 ? (
          <table className="plain">
            <thead>
              <tr>
                <th>Player</th>
                <th className="num">Shares</th>
                <th className="num">Value</th>
              </tr>
            </thead>
            <tbody>
              {positions.map(([playerId, shares]) => {
                const player = players.find((p) => p.id === playerId);
                return (
                  <tr key={playerId}>
                    <td>{player?.name ?? playerId}</td>
                    <td className={`num ${shares < 0 ? "down" : ""}`}>{fmt(shares, 0)}</td>
                    <td className="num">${fmt(shares * prices[playerId])}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="muted">All cash, no open positions.</p>
        )}
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

const GOAL_EVENTS = new Set(["GOAL", "PENALTY_GOAL", "OWN_GOAL"]);

function TickerEntry({ event }: { event: MatchEventDTO }) {
  const cls = event.isArbitrageur
    ? "arb"
    : GOAL_EVENTS.has(event.type)
      ? "goal"
      : event.signalShares < 0
        ? "bad"
        : "";
  return (
    <div className={`entry enter ${cls}`}>
      {event.isArbitrageur && <span className="arb-tag">🤖 agent</span>}
      {event.commentary}
    </div>
  );
}
