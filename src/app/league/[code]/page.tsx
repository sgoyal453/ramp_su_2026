"use client";

import { use, useEffect, useMemo, useRef, useState } from "react";
import { Sparkline } from "@/components/Sparkline";
import { BrandMark } from "@/components/BrandMark";
import type { LeagueStateDTO, MatchEventDTO, ServerMessage } from "@/lib/types";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

const QTY_CHOICES = [10, 25, 50, 100, 250];

const fmt = (n: number, digits = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export default function LeaguePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const [username, setUsername] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [state, setState] = useState<LeagueStateDTO | null>(null);
  const [qty, setQty] = useState(25);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setUsername(localStorage.getItem("fsm-username"));
  }, []);

  function showToast(text: string, error = false) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, error });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  useEffect(() => {
    if (!username) return;
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

  if (!username) {
    return (
      <main className="home">
        <div className="home-hero">
          <div className="brand">
            <BrandMark />
            <span className="wordmark">Ticker</span>
          </div>
        </div>
        <div className="card">
          <h2>Pick a username to join league {code}</h2>
          <div className="row">
            <div className="field">
              <label htmlFor="name">Username</label>
              <input id="name" value={nameInput} onChange={(e) => setNameInput(e.target.value)} maxLength={24} />
            </div>
            <button
              className="primary"
              onClick={() => {
                const name = nameInput.trim();
                if (!name) return;
                localStorage.setItem("fsm-username", name);
                setUsername(name);
              }}
            >
              Join
            </button>
          </div>
        </div>
      </main>
    );
  }

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
        <div className="brand">
          <BrandMark size={30} />
          <span className="wordmark" style={{ fontSize: 17 }}>
            Ticker
          </span>
        </div>
        <span className="invite">
          Invite<span className="code">{state.code}</span>
        </span>
        <span className={`badge ${state.status}`}>{state.status}</span>
        {state.status !== "lobby" && (
          <>
            <span className="clock">{state.minute}&rsquo;</span>
            <span className="scoreline">
              {teams.map((t) => `${t} ${state.score[t]}`).join("  —  ")}
            </span>
          </>
        )}
        <span className="spacer" />
        <span className="muted">
          {state.users.length} {state.users.length === 1 ? "trader" : "traders"} · buy-in ${fmt(state.buyIn, 0)}
        </span>
        {state.status === "lobby" &&
          (isHost ? (
            <button className="primary" onClick={startMatch}>
              ▶ Start match
            </button>
          ) : (
            <span className="muted">waiting for {state.host} to kick off…</span>
          ))}
      </div>

      {state.status === "settled" && (
        <div className="fulltime-banner">
          <span className="trophy">🏆</span>
          <span>
            Full time — all positions settled. <strong>{state.leaderboard[0]?.username}</strong> wins the league with $
            {fmt(state.leaderboard[0]?.value ?? 0)}.
          </span>
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
                    const flat = Math.abs(delta) < 0.005;
                    return (
                      <tr key={p.id}>
                        <td>
                          <div className="player-cell">
                            <span className="player-avatar">{initials(p.name)}</span>
                            <div>
                              <div className="player-name">{p.name}</div>
                              <div className="player-meta">
                                <span className="pos-badge">{p.position}</span>
                                {p.team}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <Sparkline data={state.history[p.id] ?? []} />
                        </td>
                        <td className="num price">${fmt(price)}</td>
                        <td className="num">
                          <span className={`delta-pill ${flat ? "flat" : delta > 0 ? "up" : "down"}`}>
                            {flat ? "·" : delta > 0 ? "▲" : "▼"} {fmt(Math.abs(delta))}
                          </span>
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
              <div className="portfolio-value">
                <span className="big-value">${fmt(you.value)}</span>
                <span className={`pnl-pill ${you.value >= state.startingCash ? "up" : "down"}`}>
                  {you.value >= state.startingCash ? "▲" : "▼"} ${fmt(Math.abs(you.value - state.startingCash))}
                </span>
              </div>
              <p className="portfolio-sub">Cash ${fmt(you.cash)} available</p>
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
                          <td className="num">${fmt(you.positionValues[playerId] ?? 0)}</td>
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
                  <tr key={entry.username} className={entry.username === you?.username ? "me" : ""}>
                    <td>
                      <span className={`rank ${["gold", "silver", "bronze"][i] ?? ""}`}>{i + 1}</span>
                    </td>
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
              <p className="empty-note">Events will appear here once the match kicks off.</p>
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
    </main>
  );
}

function TickerEntry({ event }: { event: MatchEventDTO }) {
  const cls = event.type === "GOAL" ? "goal" : event.signalShares < 0 ? "bad" : "";
  const text = event.commentary.replace(/^\s*\d+'\s*[—-]\s*/, "");
  return (
    <div className={`entry ${cls}`}>
      <span className="tk-min">{event.minute}&rsquo;</span>
      <span>{text}</span>
    </div>
  );
}
