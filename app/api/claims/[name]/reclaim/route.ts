// POST /api/claims/:name/reclaim  {room?}
// Binds the name to YOUR token. Free names: always. Claimed names: blindfold
// mode, one takeover per token per cooldown. With `room`, the takeover is
// announced there (without saying who did it).
import { NextRequest } from "next/server";
import { json, readJson, route } from "@/lib/http";
import { readIdentity, reclaim } from "@/lib/identity";
import { commitEvent, getRoom } from "@/lib/rooms";

export const dynamic = "force-dynamic";

export const POST = route<{ name: string }>(async (req: NextRequest, { name }) => {
  const body = await readJson(req);
  const { token, ip } = readIdentity(req, { ...body, name });
  const r = await reclaim(name, token, ip);
  if (r.result === "taken_over" && typeof body.room === "string" && body.room) {
    try {
      const meta = await getRoom(body.room);
      await commitEvent(meta, null, { kind: "system", text: `someone in a blindfold took over the name '${name}'` });
    } catch { /* announcing is best effort */ }
  }
  return json(r);
});
