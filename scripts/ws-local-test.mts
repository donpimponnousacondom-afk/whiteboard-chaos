// Local test of the WebSocket session: emulates the Vercel runtime bridge that
// experimental_upgradeWebSocket() expects, then drives it with a real ws client.
//   REDIS_URL=redis://localhost:6379 npx tsx scripts/ws-local-test.ts http://localhost:3101
import http from "node:http";
import { experimental_upgradeWebSocket } from "@vercel/functions";
import WebSocket from "ws";
import { getRoom } from "../lib/rooms";
import { runWsSession } from "../lib/wsSession";

const httpBase = process.argv[2]; // a running instance for the cross-transport check
const ROOM = "lobby";

const server = http.createServer((_q, s) => { s.statusCode = 404; s.end(); });
server.on("upgrade", async (req, socket, head) => {
  (globalThis as Record<symbol, unknown>)[Symbol.for("@vercel/request-context")] = { get: () => ({ upgradeWebSocket: () => ({ req, socket, head }) }) };
  const meta = await getRoom(ROOM);
  await experimental_upgradeWebSocket((ws) => runWsSession(ws, meta, { name: "ws-tester", kind: "agent", ip: "local" }, null, null, 60000));
});
await new Promise<void>((r) => server.listen(3199, r));

const ws = new WebSocket(`ws://localhost:3199/api/rooms/${ROOM}/ws`);
const got: { kind: string; seq?: number; actor?: string; id?: number }[] = [];
ws.on("message", (m) => got.push(JSON.parse(String(m))));
await new Promise((r) => ws.on("open", r));
await new Promise((r) => setTimeout(r, 400));
const t0 = performance.now();
ws.send(JSON.stringify({ type: "ops", id: 1, ops: [{ op: "px", x: 63, y: 0, c: "lime" }, { op: "chat", text: "hi over websocket" }] }));
while (!got.find((g) => g.kind === "ack")) await new Promise((r) => setTimeout(r, 5));
const ackMs = performance.now() - t0;
// a write from plain HTTP on another process must arrive over the socket
const before = got.length;
await fetch(`${httpBase}/api/rooms/${ROOM}/ops`, { method: "POST", headers: { "content-type": "application/json", "x-wb-name": "http-writer" }, body: JSON.stringify({ ops: [{ op: "px", x: 62, y: 0, c: "red" }] }) });
const deadline = Date.now() + 3000;
while (!got.slice(before).find((g) => g.actor === "http-writer") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
const cross = got.slice(before).find((g) => g.actor === "http-writer");
ws.send(JSON.stringify({ type: "ping" }));
await new Promise((r) => setTimeout(r, 200));
console.log("kinds:", got.map((g) => g.kind).join(","));
console.log(`ack in ${ackMs.toFixed(0)} ms, cross-process event over ws: ${cross ? "yes seq " + cross.seq : "NO"}`);
ws.close(); server.close();
process.exit(cross && got[0].kind === "hello" && got[1].kind === "snapshot" ? 0 : 1);
