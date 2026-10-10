import { NextRequest } from "next/server";
import { describeEvent } from "@/lib/describe";
import { json, num, route, text } from "@/lib/http";
import { isAdminReq } from "@/lib/identity";
import { openRoom } from "@/lib/rooms";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export const GET = route<{ room: string }>(async (req: NextRequest, { room }) => {
  const meta = await openRoom(room, isAdminReq(req));
  const q = req.nextUrl.searchParams;
  const limit = Math.max(1, Math.min(1000, num(q.get("limit"), 100)!));
  const store = getStore();
  let since = num(q.get("since"));
  if (since === undefined) {
    const head = (await store.range(meta.id, Number.MAX_SAFE_INTEGER - 1, 1)).head;
    since = Math.max(0, head - limit);
  }
  const { events, head } = await store.range(meta.id, since, limit);
  const kinds = q.get("kinds")?.split(",");
  const list = kinds ? events.filter((e) => kinds.includes(e.kind)) : events;
  if (q.get("format") === "text") return text(list.map((e) => describeEvent(e, meta.w)).join("\n") + "\n");
  return json({ head, since, events: list });
});
