// Who is logged in to this room, with status (active, online, idle, offline)
// and client. IPs and bans only with the admin key.
import { NextRequest } from "next/server";
import { json, route } from "@/lib/http";
import { isAdminReq } from "@/lib/identity";
import { listBans, roster } from "@/lib/members";
import { openRoom } from "@/lib/rooms";

export const dynamic = "force-dynamic";

export const GET = route<{ room: string }>(async (req: NextRequest, { room }) => {
  const admin = isAdminReq(req);
  const meta = await openRoom(room, admin);
  const [members, bans] = await Promise.all([roster(meta, admin), admin ? listBans(meta.id) : Promise.resolve(undefined)]);
  return json({ room: meta.id, members, ...(bans ? { bans } : {}), admin });
});
