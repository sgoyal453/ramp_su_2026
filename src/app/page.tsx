"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";

export default function Home() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [buyIn, setBuyIn] = useState(1000);
  const [duration, setDuration] = useState(10);
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setUsername(localStorage.getItem("fsm-username") ?? "");
  }, []);

  function saveName(): string | null {
    const name = username.trim();
    if (!name) {
      setError("Pick a username first.");
      return null;
    }
    localStorage.setItem("fsm-username", name);
    return name;
  }

  async function createLeague() {
    const name = saveName();
    if (!name) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/league", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: name, buyIn, matchRealMinutes: duration }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to create league");
      router.push(`/league/${body.code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create league");
      setBusy(false);
    }
  }

  async function joinLeague() {
    const name = saveName();
    if (!name) return;
    const code = joinCode.trim().toUpperCase();
    if (!code) {
      setError("Enter an invite code.");
      return;
    }
    setBusy(true);
    setError("");
    const res = await fetch(`/api/league/${code}`);
    if (!res.ok) {
      setError(`No league found with code ${code}.`);
      setBusy(false);
      return;
    }
    router.push(`/league/${code}`);
  }

  return (
    <main className="home">
      <div className="home-hero">
        <div className="brand">
          <BrandMark />
          <span className="wordmark">Ticker</span>
        </div>
        <h1>
          Trade the game, <span className="accent">live.</span>
        </h1>
        <p className="tagline">
          A live stock market for sports. Buy, sell, and short players while a simulated match moves the market in real
          time. Highest portfolio at the final whistle wins the league.
        </p>
      </div>

      <div className="card">
        <div className="field">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="e.g. sid"
            maxLength={24}
          />
        </div>
      </div>

      <div className="card">
        <h2>Create a league</h2>
        <div className="row">
          <div className="field">
            <label htmlFor="buyin">Buy-in ($)</label>
            <input id="buyin" type="number" min={1} value={buyIn} onChange={(e) => setBuyIn(Number(e.target.value))} />
          </div>
          <div className="field">
            <label htmlFor="duration">Match length (real minutes)</label>
            <input
              id="duration"
              type="number"
              min={1}
              max={30}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            />
          </div>
        </div>
        <button className="primary" onClick={createLeague} disabled={busy}>
          Create league
        </button>
      </div>

      <div className="divider">or</div>

      <div className="card">
        <h2>Join with an invite code</h2>
        <div className="row">
          <div className="field">
            <label htmlFor="code">Invite code</label>
            <input
              id="code"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="e.g. XK4PQ2"
              maxLength={6}
            />
          </div>
          <button onClick={joinLeague} disabled={busy}>
            Join league
          </button>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}
    </main>
  );
}
