import { NextRequest } from "next/server";
import { json, readJson, route } from "@/lib/http";
import { resolveActor } from "@/lib/identity";
import { createRoom, ensurePresets, publicMeta } from "@/lib/rooms";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  await ensurePresets();
  const limit = Math.min(200, Number(req.nextUrl.searchParams.get("limit") ?? 50));
  const rooms = await getStore().listRooms(limit);
  return json({ rooms: rooms.map((r) => ({ ...publicMeta(r.meta), seq: r.seq, active: r.active })) });
});

export const POST = route(async (req: NextRequest) => {
  const body = await readJson(req);
  const actor = await resolveActor(req, body);
  const { ownerKey, ...meta } = await createRoom(body, actor);
  return json({
    ok: true, room: publicMeta(meta), ownerKey,
    note: "ownerKey is shown ONCE. Keep it secret: it lets you change this room's settings (header X-WB-Owner).",
  }, 201);
});
