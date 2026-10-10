// The admin feed: GET /api/admin/audit?room=ROOM&limit=200 (room optional).
// Admin key: everything, with IPs. Room owner key (X-WB-Owner) + room: that
// room's feed without IPs.
import { NextRequest } from "next/server";
import { readAudit } from "@/lib/audit";
import { HttpError, json, num, route } from "@/lib/http";
import { isAdminReq } from "@/lib/identity";
import { getRoom, isOwner } from "@/lib/rooms";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const q = req.nextUrl.searchParams;
  const room = q.get("room");
  const admin = isAdminReq(req);
  if (!admin) {
    if (!room) throw new HttpError(401, "unauthorized", "the global feed needs X-WB-Admin");
    const meta = await getRoom(room);
    if (!isOwner(meta, req.headers.get("x-wb-owner"), null)) throw new HttpError(401, "unauthorized", "send X-WB-Admin, or X-WB-Owner with this room's owner key");
  }
  const since = num(q.get("since"), 0)!;
  const entries = (await readAudit(room, num(q.get("limit"), 200)!, admin)).filter((e) => e.t > since);
  return json({ room, admin, entries });
});
