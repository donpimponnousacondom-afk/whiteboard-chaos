import { NextRequest } from "next/server";
import { gameView } from "@/lib/game";
import { json, readJson, route } from "@/lib/http";
import { isAdminReq, resolveActor } from "@/lib/identity";
import { act, openRoom } from "@/lib/rooms";

export const dynamic = "force-dynamic";
type P = { room: string };

export const GET = route<P>(async (req: NextRequest, { room }) => {
  const meta = await openRoom(room, isAdminReq(req));
  const actor = await resolveActor(req).catch(() => null);
  return json(await gameView(meta, actor));
});

export const POST = route<P>(async (req: NextRequest, { room }) => {
  const body = await readJson(req);
  const actor = await resolveActor(req, body);
  const action = String(body.action ?? "status");
  const r = await act(room, actor, { ops: [{ op: "game", action, word: body.word }] }, req.headers.get("x-wb-key"));
  return json(r.results[0] ?? { ok: true });
});
