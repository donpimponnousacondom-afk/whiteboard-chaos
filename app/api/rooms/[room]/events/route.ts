// Server-Sent Events: the realtime downstream channel.
//   - no ?since and no Last-Event-ID -> first message is a full snapshot
//   - with since -> missed events are replayed in order (or a snapshot if trimmed)
//   - every persisted event carries `id: <seq>`, so EventSource reconnects resume exactly
//   - the stream closes itself before the platform limit; clients reconnect transparently
import { NextRequest } from "next/server";
import { openFeed } from "@/lib/feed";
import { BUILD } from "@/lib/build";
import { parseClient } from "@/lib/clientInfo";
import { route } from "@/lib/http";
import { isAdminReq, readIdentity } from "@/lib/identity";
import { markConnected, markDisconnected } from "@/lib/members";
import { openRoom, publicMeta } from "@/lib/rooms";
import type { Actor } from "@/lib/types";
import type { WbEvent } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const LIFETIME_MS = Number(process.env.WB_SSE_MAX_S ?? 270) * 1000;

export const GET = route<{ room: string }>(async (req: NextRequest, { room }) => {
  const admin = isAdminReq(req);
  const meta = await openRoom(room, admin);
  const q = req.nextUrl.searchParams;
  // who is watching (for the admin feed only; reading needs no login)
  let viewer: Actor | null = null;
  try {
    const id = readIdentity(req);
    if (!id.name.startsWith("anon-")) viewer = { name: id.name, kind: id.kind, ip: id.ip, client: parseClient(req.headers.get("user-agent")) };
  } catch { /* bad name: anonymous viewer */ }
  const opened = Date.now();
  const lastId = req.headers.get("last-event-id") ?? q.get("since");
  const since = lastId !== null && /^\d{1,15}$/.test(lastId) ? Number(lastId) : null;
  const ephemeral = q.get("cursors") !== "0";
  const enc = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const write = (s: string) => { if (open) { try { controller.enqueue(enc.encode(s)); } catch { open = false; } } };
      const send = (ev: WbEvent) => {
        const id = ev.seq !== undefined && ev.kind !== "snapshot" ? `id: ${ev.seq}\n` : ev.kind === "snapshot" ? `id: ${ev.seq}\n` : "";
        write(`${id}data: ${JSON.stringify(ev)}\n\n`);
      };
      write(`retry: 1000\n: chaos-whiteboard ${meta.id}\n\n`);
      write(`data: ${JSON.stringify({ kind: "hello", t: Date.now(), room: publicMeta(meta), since, build: BUILD })}\n\n`);
      if (viewer) markConnected(meta, viewer, "sse").catch(() => {});
      let close = () => {};
      let aborted = false;
      const onAbort = () => {
        aborted = true; cleanup();
        if (viewer) markDisconnected(meta, viewer, "sse", Date.now() - opened).catch(() => {});
      };
      cleanup = () => { open = false; close(); try { controller.close(); } catch { /* closed */ } };
      req.signal.addEventListener("abort", onAbort);
      try {
        close = await openFeed(meta, since, send, { ephemeral });
      } catch (e) {
        write(`data: ${JSON.stringify({ kind: "error", t: Date.now(), message: (e as Error).message })}\n\n`);
        cleanup();
        return;
      }
      if (aborted || !open) { close(); return; }
      const ping = setInterval(() => write(`: ping ${Date.now()}\n\n`), 15000);
      const life = setTimeout(() => { write(`data: ${JSON.stringify({ kind: "reconnect", t: Date.now() })}\n\n`); finish(); }, LIFETIME_MS);
      const finish = () => {
        if (!open) return;
        open = false;
        clearInterval(ping); clearTimeout(life); close();
        try { controller.close(); } catch { /* already closed */ }
      };
      cleanup = finish;
    },
    cancel() { cleanup(); },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
});
