/**
 * Custom server: Next.js (pages + assets) + a WebSocket hub + one tiny REST
 * endpoint. All game state is in-memory in this process; the Next app is a
 * pure client of the WS protocol in src/lib/types.ts.
 *
 *   POST /api/league  {username, buyIn?, matchRealMinutes?} -> {code}
 *   WS   /ws          join / trade / quote / start, per src/lib/types.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";
import { createLeague, getLeague } from "./src/lib/game/store";
import type { League } from "./src/lib/game/league";
import type { ClientMessage, ServerMessage } from "./src/lib/types";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3000);

interface Connection {
  socket: WebSocket;
  league: League | null;
  username: string | null;
}

const connections = new Set<Connection>();

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

/** Push a personalized state snapshot to every member of a league. */
function broadcastState(league: League): void {
  for (const conn of connections) {
    if (conn.league === league) send(conn.socket, { type: "state", state: league.toDTO(conn.username) });
  }
}

function broadcast(league: League, message: ServerMessage): void {
  for (const conn of connections) {
    if (conn.league === league) send(conn.socket, message);
  }
}

function handleMessage(conn: Connection, message: ClientMessage): void {
  switch (message.type) {
    case "join": {
      const league = getLeague(message.code);
      if (!league) throw new Error(`no league with code ${message.code}`);
      const username = String(message.username).trim().slice(0, 24);
      if (!username) throw new Error("username required");
      league.addUser(username);
      conn.league = league;
      conn.username = username;
      broadcastState(league); // everyone sees the new roster of users
      return;
    }
    case "start": {
      const { league, username } = requireMembership(conn);
      league.start(username, {
        onEvent: (event) => {
          broadcast(league, { type: "event", event });
          broadcastState(league); // events move prices; keep everyone current
        },
        onMinute: () => broadcastState(league),
        onFullTime: () => broadcastState(league),
      });
      broadcastState(league);
      return;
    }
    case "trade": {
      const { league, username } = requireMembership(conn);
      const fill = league.trade(username, message.playerId, message.shares);
      send(conn.socket, { type: "trade_result", playerId: message.playerId, shares: fill.shares, cost: fill.cost, price: fill.price });
      broadcastState(league); // a trade moves the price for everyone
      return;
    }
    case "quote": {
      const { league } = requireMembership(conn);
      const cost = league.quote(message.playerId, message.shares);
      send(conn.socket, { type: "quote_result", reqId: message.reqId, playerId: message.playerId, shares: message.shares, cost });
      return;
    }
    default:
      throw new Error(`unknown message type ${(message as { type?: string }).type}`);
  }
}

function requireMembership(conn: Connection): { league: League; username: string } {
  if (!conn.league || !conn.username) throw new Error("join a league first");
  return { league: conn.league, username: conn.username };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const app = next({ dev });
const handle = app.getRequestHandler();

await app.prepare();
const nextUpgrade = app.getUpgradeHandler();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname === "/api/league" && req.method === "POST") {
      const body = await readJsonBody(req);
      const username = String(body.username ?? "").trim().slice(0, 24);
      if (!username) return json(res, 400, { error: "username required" });
      const league = createLeague({
        host: username,
        buyIn: Number(body.buyIn) > 0 ? Number(body.buyIn) : 1000,
        matchRealMinutes: clamp(Number(body.matchRealMinutes) || 10, 1, 30),
      });
      return json(res, 201, { code: league.code });
    }
    if (url.pathname.startsWith("/api/league/") && req.method === "GET") {
      const league = getLeague(url.pathname.split("/")[3] ?? "");
      if (!league) return json(res, 404, { error: "league not found" });
      return json(res, 200, { code: league.code, status: league.status, users: [...league.users.keys()] });
    }
    await handle(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: "internal error" });
  }
});

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (socket: WebSocket) => {
  const conn: Connection = { socket, league: null, username: null };
  connections.add(conn);
  socket.on("message", (data) => {
    try {
      handleMessage(conn, JSON.parse(String(data)) as ClientMessage);
    } catch (err) {
      send(socket, { type: "error", message: err instanceof Error ? err.message : "bad request" });
    }
  });
  socket.on("close", () => connections.delete(conn));
});

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    // Let Next handle its own upgrades (HMR websocket in dev).
    nextUpgrade(req, socket, head);
  }
});

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

server.listen(port, () => {
  console.log(`⚽ fantasy stock market ready on http://localhost:${port} (${dev ? "dev" : "prod"})`);
});
