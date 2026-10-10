// Log out of a room. Needs the session from /join (X-WB-Session), so nobody
// else can log you out. The admin can remove anyone (kick).
import { NextRequest } from "next/server";
import { json, readJson, route } from "@/lib/http";
import { resolveActor } from "@/lib/identity";
import { leave } from "@/lib/members";
import { getRoom } from "@/lib/rooms";

export const dynamic = "force-dynamic";

export const POST = route<{ room: string }>(async (req: NextRequest, { room }) => {
  const body = await readJson(req);
  const actor = await resolveActor(req, body);
  const meta = await getRoom(room);
  return json(await leave(meta, actor, actor.session));
});
