"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { LEAGUE_CATALOG, type LeagueSummary } from "@/lib/leagues/catalog";

const USERNAME = "Sarvagya";

interface FixtureMeta {
  fixtureId: string;
  competition: string;
  stage: string;
  dateUtc: string;
  venue: string | null;
  city: string | null;
  homeTeam: string;
  awayTeam: string;
  sources: string[];
}

export default function Home() {
  const router = useRouter();
  const [active, setActive] = useState<LeagueSummary | null>(null);
  const [fixture, setFixture] = useState<FixtureMeta | null>(null);

  useEffect(() => {
    fetch("/api/fixture")
      .then((res) => res.json())
      .then((body) => {
        if (body.ok) setFixture(body.fixture);
      })
      .catch(() => {}); // homepage still browsable if the fixture endpoint is down
  }, []);

  // The featured World Cup 2026 card is backed by a real verified fixture —
  // once it loads, swap the static placeholder copy for the real matchup.
  const catalog = useMemo(() => {
    if (!fixture) return LEAGUE_CATALOG;
    return LEAGUE_CATALOG.map((l) =>
      l.id === "world-cup-2026"
        ? {
            ...l,
            blurb: `${fixture.stage} — ${fixture.homeTeam} vs ${fixture.awayTeam} is live right now${
              fixture.venue ? ` at ${fixture.venue}` : ""
            }. You're in this one.`,
          }
        : l,
    );
  }, [fixture]);

  const sports = useMemo(() => {
    const set = new Set(catalog.map((l) => l.sport));
    return ["All", ...set];
  }, [catalog]);
  const [filter, setFilter] = useState("All");
  const shown = filter === "All" ? catalog : catalog.filter((l) => l.sport === filter);

  function openLeague(league: LeagueSummary) {
    if (league.joined && league.code) {
      localStorage.setItem("fsm-username", USERNAME);
      router.push(`/league/${league.code}`);
    } else {
      setActive(league);
    }
  }

  return (
    <main className="browse">
      <header className="browse-header">
        <div>
          <h1>⚽ Pitch Exchange</h1>
          <p className="tagline">Every league is one sport, priced live, over a fixed window. Browse what&rsquo;s out there.</p>
        </div>
        <div className="me-badge">
          Signed in as <strong>{USERNAME}</strong>
        </div>
      </header>

      <div className="sport-filters">
        {sports.map((s) => (
          <button key={s} className={`chip ${filter === s ? "active" : ""}`} onClick={() => setFilter(s)}>
            {s}
          </button>
        ))}
      </div>

      <div className="league-grid">
        {shown.map((league) => (
          <button key={league.id} className={`league-card ${league.joined ? "joined" : ""}`} onClick={() => openLeague(league)}>
            <div className="league-card-top">
              <span className="league-emoji">{league.emoji}</span>
              <span className={`badge ${league.status === "live" ? "live" : ""}`}>{league.status}</span>
            </div>
            <div className="league-name">{league.name}</div>
            <div className="league-sport muted">{league.sport}</div>
            <div className="league-window muted">{league.windowLabel}</div>
            <div className="league-card-bottom">
              <span className="muted">{league.traders.toLocaleString()} traders</span>
              <span className="muted">
                ${league.buyInReal} = {league.buyInFake.toLocaleString()}
              </span>
            </div>
            {league.joined && <div className="joined-tag">You&rsquo;re in this league →</div>}
          </button>
        ))}
      </div>

      {active && (
        <div className="modal-backdrop" onClick={() => setActive(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-top">
              <span className="league-emoji">{active.emoji}</span>
              <span className={`badge ${active.status === "live" ? "live" : ""}`}>{active.status}</span>
            </div>
            <h2>{active.name}</h2>
            <p className="muted">{active.sport} · {active.windowLabel}</p>
            <p>{active.blurb}</p>
            <p className="muted">
              {active.traders.toLocaleString()} traders · ${active.buyInReal} buy-in = {active.buyInFake.toLocaleString()} coins
            </p>
            <p className="not-joined">You&rsquo;re not in this league yet — {USERNAME} is only trading World Cup 2026.</p>
            <button onClick={() => setActive(null)}>Close</button>
          </div>
        </div>
      )}
    </main>
  );
}
