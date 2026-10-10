// Log in to a room. Returns a room session token: send it as X-WB-Session on
// every write to this room. Keep it: it is also the only way to leave.
import { NextRequest } from "next/server";
import { json, readJson, route } from "@/lib/http";
import { resolveActor } from "@/lib/identity";
import { join } from "@/lib/members";
import { openRoom, publicMeta } from "@/lib/rooms";

export const dynamic = "force-dynamic";

export const POST = route<{ room: string }>(async (req: NextRequest, { room }) => {
  const body = await readJson(req);
  const actor = await resolveActor(req, body);
  const meta = await openRoom(room, actor.admin);
  const r = await join(meta, actor);
  return json({
    ok: true, room: publicMeta(meta), name: actor.name, session: r.session, rejoined: r.rejoined, client: actor.client?.label,
    note: "Send this session as X-WB-Session on every write to this room. Keep it on disk: it is also the only way to leave (POST /leave). Joining again makes a new session and invalidates the old one.",
  });
});
