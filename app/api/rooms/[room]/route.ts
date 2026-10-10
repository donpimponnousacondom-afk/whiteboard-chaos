import { NextRequest } from "next/server";
import { gameView } from "@/lib/game";
import { HttpError, json, readJson, route } from "@/lib/http";
import { isAdminReq, resolveActor } from "@/lib/identity";
import { getRoom, openRoom, publicMeta, updateRoom } from "@/lib/rooms";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";
type P = { room: string };

export const GET = route<P>(async (req: NextRequest, { room }) => {
  const meta = await openRoom(room, isAdminReq(req));
  const store = getStore();
  const [snap, presence] = await Promise.all([store.snapshot(meta.id, meta.w * meta.h), store.presenceList(meta.id, 30000)]);
  const actor = req.headers.get("x-wb-name") ? await resolveActor(req).catch(() => null) : null;
  return json({
    room: publicMeta(meta), seq: snap.seq, palette: snap.palette, board: snap.board, presence,
    game: meta.mode === "guess" ? await gameView(meta, actor) : undefined,
    encoding: "board is a string of w*h chars, row-major (index = y*w + x). '.' = empty, '0'-'9','a'-'z','A'-'Z' = palette slot 0..61",
  });
});

export const PATCH = route<P>(async (req: NextRequest, { room }) => {
  const body = await readJson(req);
  const actor = await resolveActor(req, body);
  const meta = await updateRoom(room, body, actor, req.headers.get("x-wb-key") ?? (body.key as string) ?? null);
  return json({ ok: true, room: publicMeta(meta) });
});

export const DELETE = route<P>(async (req: NextRequest, { room }) => {
  const admin = process.env.WB_ADMIN_KEY;
  if (!admin || req.headers.get("x-wb-admin") !== admin) throw new HttpError(401, "unauthorized", "deleting rooms needs X-WB-Admin = WB_ADMIN_KEY");
  await getRoom(room);
  await getStore().deleteRoom(room);
  return json({ ok: true, deleted: room });
});
