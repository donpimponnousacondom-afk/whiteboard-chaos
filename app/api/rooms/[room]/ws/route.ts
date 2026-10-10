// WebSocket transport (Vercel WebSockets are in public beta and need Fluid compute).
//   wss://<host>/api/rooms/<room>/ws?name=<you>&token=<secret>[&since=SEQ][&key=WRITE_KEY]
// Off Vercel (next dev / next start) this returns 501 and clients fall back to SSE + POST.
import { experimental_upgradeWebSocket } from "@vercel/functions";
import { NextRequest } from "next/server";
import { json, route } from "@/lib/http";
import { isAdminReq, resolveActor } from "@/lib/identity";
import { openRoom } from "@/lib/rooms";
import { runWsSession } from "@/lib/wsSession";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const LIFETIME_MS = Number(process.env.WB_SSE_MAX_S ?? 270) * 1000;

export const GET = route<{ room: string }>(async (req: NextRequest, { room }) => {
  const meta = await openRoom(room, isAdminReq(req));
  const actor = await resolveActor(req, {}, "ws");
  if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return json({ ok: false, error: "upgrade_required", message: "connect with a WebSocket client, or use /events (SSE) + POST /ops" }, 426);
  }
  const q = req.nextUrl.searchParams;
  const s = q.get("since");
  const since = s !== null && s !== "" && Number.isFinite(Number(s)) ? Number(s) : null;
  const key = q.get("key");
  try {
    return await experimental_upgradeWebSocket((ws) => runWsSession(ws, meta, actor, since, key, LIFETIME_MS), { maxPayload: 1024 * 1024 });
  } catch (e) {
    return json({ ok: false, error: "websocket_unavailable", message: (e as Error).message, fallback: `/api/rooms/${room}/events` }, 501);
  }
});
