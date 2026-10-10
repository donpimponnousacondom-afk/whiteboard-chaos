import { NextRequest } from "next/server";
import { json, readJson, route } from "@/lib/http";
import { isAdminReq, resolveActor } from "@/lib/identity";
import { join } from "@/lib/members";
import { createRoom, ensurePresets, publicMeta } from "@/lib/rooms";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  await ensurePresets();
  const limit = Math.min(200, Number(req.nextUrl.searchParams.get("limit") ?? 50));
  const admin = isAdminReq(req);
  const rooms = (await getStore().listRooms(limit)).filter((r) => admin || !r.meta.closed);
  return json({ rooms: rooms.map((r) => ({ ...publicMeta(r.meta), seq: r.seq, active: r.active })) });
});

export const POST = route(async (req: NextRequest) => {
  const body = await readJson(req);
  const actor = await resolveActor(req, body);
  const { ownerKey, ...meta } = await createRoom(body, actor);
  const { session } = await join(meta, actor); // the creator is logged in to its room
  return json({
    ok: true, room: publicMeta(meta), ownerKey, session,
    note: "ownerKey is shown ONCE. Keep it secret: it lets you change this room's settings (header X-WB-Owner). session: you are logged in to this room; send it as X-WB-Session on writes.",
  }, 201);
});
