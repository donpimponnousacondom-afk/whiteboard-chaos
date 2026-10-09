// One WebSocket connection = one ordered feed downstream + ops/cursors upstream.
// Protocol (JSON text frames):
//   client -> server  {"type":"ops","id":1,"ops":[...],"nonce":"..."}
//                     {"type":"cursor","x":3,"y":4,"color":"#ff3d5a"}
//                     {"type":"ping"}
//   server -> client  the same event objects as SSE (snapshot, draw, chat, game, cursor, ...)
//                     {"kind":"ack","id":1,"seq":..,"changed":..,"results":[..]}
//                     {"kind":"error","id":1,"error":"rate_limited","message":"..","retryMs":..}
//                     {"kind":"pong"} | {"kind":"reconnect"} (then close 4000)
import type { WebSocket } from "ws";
import { openFeed } from "./feed";
import { HttpError } from "./http";
import { act } from "./rooms";
import { getStore } from "./store";
import type { Actor, RoomMeta } from "./types";

export async function runWsSession(ws: WebSocket, meta: RoomMeta, actor: Actor, since: number | null, key: string | null, lifetimeMs: number) {
  const store = getStore();
  const send = (obj: unknown) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  send({ kind: "hello", t: Date.now(), room: { id: meta.id, w: meta.w, h: meta.h, mode: meta.mode, title: meta.title }, you: actor.name, transport: "websocket" });

  let busy: Promise<void> = Promise.resolve(); // keep this client's writes in order
  let pending = 0;
  let lastCursor = 0;
  let closed = false;
  let close = () => {};
  const timers: ReturnType<typeof setTimeout>[] = [];
  // register teardown FIRST: the client may vanish while the feed is being set up
  ws.on("close", () => { closed = true; timers.forEach((t) => { clearTimeout(t); clearInterval(t); }); close(); });
  ws.on("error", () => { /* close follows */ });
  ws.on("message", (raw) => {
    let msg: { type?: string; id?: unknown; ops?: unknown; nonce?: unknown; x?: unknown; y?: unknown; color?: unknown; status?: unknown };
    try { msg = JSON.parse(String(raw)); } catch { send({ kind: "error", error: "invalid_json" }); return; }
    if (msg.type === "ping") { send({ kind: "pong", t: Date.now() }); return; }
    if (msg.type === "cursor") {
      if (Date.now() - lastCursor < 50) return; // max 20 cursor updates per second
      lastCursor = Date.now();
      const x = Math.round(Number(msg.x)), y = Math.round(Number(msg.y));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const color = typeof msg.color === "string" ? msg.color.slice(0, 7) : undefined;
      store.presencePut(meta.id, { name: actor.name, kind: actor.kind, t: Date.now(), x, y, color }).catch(() => {});
      store.publish(meta.id, { kind: "cursor", t: Date.now(), actor: actor.name, actorKind: actor.kind, x, y, color }).catch(() => {});
      return;
    }
    if (msg.type === "ops") {
      if (pending >= 16) { send({ kind: "error", id: msg.id, error: "too_many_pending", message: "wait for acks before sending more batches", retryMs: 200 }); return; }
      pending++;
      busy = busy.then(async () => {
        try {
          const r = await act(meta.id, actor, { ops: msg.ops, nonce: msg.nonce }, key);
          send({ kind: "ack", id: msg.id, ...r });
        } catch (e) {
          if (e instanceof HttpError) send({ kind: "error", id: msg.id, error: e.code, message: e.message, ...(e.extra ?? {}) });
          else send({ kind: "error", id: msg.id, error: "internal", message: (e as Error).message });
        } finally { pending--; }
      });
      return;
    }
    send({ kind: "error", id: msg.id, error: "unknown_type", message: "type must be ops, cursor or ping" });
  });

  try {
    close = await openFeed(meta, since, (ev) => send(ev), { ephemeral: true });
  } catch (e) {
    send({ kind: "error", error: "feed_failed", message: (e as Error).message });
    ws.close(1011, "feed failed");
    return;
  }
  if (closed || ws.readyState !== 1) { close(); return; }
  store.presencePut(meta.id, { name: actor.name, kind: actor.kind, t: Date.now() }).catch(() => {});
  const ka = setInterval(() => { try { ws.ping(); } catch { /* closed */ } }, 25000);
  timers.push(ka as unknown as ReturnType<typeof setTimeout>);
  timers.push(setTimeout(() => { send({ kind: "reconnect", t: Date.now() }); ws.close(4000, "reconnect"); }, lifetimeMs));
}
