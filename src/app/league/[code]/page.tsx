"use client";

import { use, useEffect, useMemo, useRef, useState } from "react";
import { Sparkline } from "@/components/Sparkline";
import type { LeagueStateDTO, MatchEventDTO, ServerMessage } from "@/lib/types";

const QTY_CHOICES = [10, 25, 50, 100, 250];
const USERNAME = "Sarvagya";

const fmt = (n: number, digits = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export default function LeaguePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const username = USERNAME;
  const [state, setState] = useState<LeagueStateDTO | null>(null);
  const [qty, setQty] = useState(25);
  const [viewing, setViewing] = useState<string | null>(null);
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
            <span className="scoreline">
              {teams.map((t) => `${t} ${state.score[t]}`).join(" — ")}
            </span>
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
          {" · "}
          Invite code <span className="code">{state.code}</span> · {state.users.length} traders
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
            <div style={{ overflowX: "auto" }}>
              <table className="market">
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>Trend</th>
                    <th className="num">Price</th>
                    <th className="num">Δ Kickoff</th>
                    <th className="num">Your shares</th>
                    {state.status === "settled" && <th className="num">Settled</th>}
                    {state.status !== "settled" && <th className="num">Trade</th>}
                  </tr>
                </thead>
                <tbody>
                  {state.players.map((p) => {
                    const price = state.prices[p.id];
                    const kickoff = state.history[p.id]?.[0] ?? 50;
                    const delta = price - kickoff;
                    const position = you?.positions[p.id] ?? 0;
                    return (
                      <tr key={p.id}>
                        <td>
                          <div className="player-name">{p.name}</div>
                          <div className="player-meta">
                            <span className="pos-badge">{p.position}</span>
                            {p.team}
                          </div>
                        </td>
                        <td>
                          <Sparkline data={state.history[p.id] ?? []} />
                        </td>
                        <td className="num price">${fmt(price)}</td>
                        <td className={`num ${Math.abs(delta) < 0.005 ? "muted" : delta > 0 ? "up" : "down"}`}>
                          {Math.abs(delta) < 0.005 ? "·" : delta > 0 ? "▲" : "▼"} {fmt(Math.abs(delta))}
                        </td>
                        <td className={`num ${position < 0 ? "down" : ""}`}>
                          {position !== 0 ? fmt(position, 0) : <span className="muted">—</span>}
                        </td>
                        {state.status === "settled" ? (
                          <td className="num">${fmt(state.settlements?.[p.id] ?? 0)}</td>
                        ) : (
                          <td>
                            <div className="trade-buttons">
                              <button className="buy" onClick={() => trade(p.id, qty)}>
                                Buy
                              </button>
                              <button className="sell" onClick={() => trade(p.id, -qty)}>
                                Sell
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
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
                          <td className="num">${fmt(shares * state.prices[playerId])}</td>
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
            <table className="plain">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Trader</th>
                  <th className="num">Portfolio</th>
                </tr>
              </thead>
              <tbody>
                {state.leaderboard.map((entry, i) => (
                  <tr
                    key={entry.username}
                    className={`clickable-row ${entry.username === you?.username ? "me" : ""}`}
                    onClick={() => setViewing(entry.username)}
                  >
                    <td>{i + 1}</td>
                    <td>{entry.username}</td>
                    <td className="num">${fmt(entry.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="panel">
            <h2>Match ticker</h2>
            {state.ticker.length === 0 ? (
              <p className="muted">Events will appear here once the match kicks off.</p>
            ) : (
              <div className="ticker">
                {state.ticker.map((event, i) => (
                  <TickerEntry key={`${event.minute}-${event.playerId}-${event.type}-${i}`} event={event} />
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
    </main>
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

function TickerEntry({ event }: { event: MatchEventDTO }) {
  const cls = event.type === "GOAL" ? "goal" : event.signalShares < 0 ? "bad" : "";
  return <div className={`entry ${cls}`}>{event.commentary}</div>;
}
