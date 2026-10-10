// God mode for one room (X-WB-Admin):
//   {action:"close", note?}          nobody but the admin can read or write
//   {action:"open"}
//   {action:"key", key:"..."|""}     set or remove the write password
//   {action:"kick", name, minutes?=30 (0 = until unban), ip?:false, reason?}
//   {action:"unban", name}
import { NextRequest } from "next/server";
import { HttpError, json, readJson, route } from "@/lib/http";
import { requireAdmin } from "@/lib/identity";
import { kick, unban } from "@/lib/members";
import { getRoom, moderateRoom, publicMeta } from "@/lib/rooms";

export const dynamic = "force-dynamic";

export const POST = route<{ room: string }>(async (req: NextRequest, { room }) => {
  requireAdmin(req);
  const body = await readJson(req);
  const meta = await getRoom(room);
  const action = String(body.action ?? "");
  switch (action) {
    case "close": return json({ ok: true, room: publicMeta(await moderateRoom(meta.id, { closed: true, note: body.note ? String(body.note) : "" })) });
    case "open": return json({ ok: true, room: publicMeta(await moderateRoom(meta.id, { closed: false })) });
    case "key": return json({ ok: true, room: publicMeta(await moderateRoom(meta.id, { key: body.key ? String(body.key) : null })) });
    case "kick": {
      const name = String(body.name ?? "").trim();
      if (!name) throw new HttpError(400, "bad_name", "kick needs {name}");
      const minutes = body.minutes === undefined ? 30 : Math.max(0, Math.min(525600, Number(body.minutes) || 0));
      return json(await kick(meta, name, minutes, "admin", !!body.ip, body.reason ? String(body.reason) : undefined));
    }
    case "unban": {
      const name = String(body.name ?? "").trim();
      if (!name) throw new HttpError(400, "bad_name", "unban needs {name}");
      return json(await unban(meta, name));
    }
    default: throw new HttpError(400, "bad_action", "action must be close, open, key, kick or unban");
  }
});
