import { NextRequest } from "next/server";
import { json, readJson, route } from "@/lib/http";
import { resolveActor } from "@/lib/identity";
import { getRoom } from "@/lib/rooms";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";
type P = { room: string };

export const GET = route<P>(async (_req: NextRequest, { room }) => {
  const meta = await getRoom(room);
  return json({ presence: await getStore().presenceList(meta.id, 30000) });
});

// Heartbeat + cursor. Ephemeral: published live, never stored in history.
export const POST = route<P>(async (req: NextRequest, { room }) => {
  const meta = await getRoom(room);
  const body = await readJson(req);
  const actor = await resolveActor(req, body);
  const store = getStore();
  const x = body.x === undefined || body.x === null ? undefined : Math.round(Number(body.x));
  const y = body.y === undefined || body.y === null ? undefined : Math.round(Number(body.y));
  const color = typeof body.color === "string" ? body.color.slice(0, 7) : undefined;
  const status = typeof body.status === "string" ? body.status.slice(0, 80) : undefined;
  const entry = { name: actor.name, kind: actor.kind, t: Date.now(), x, y, color, status };
  await Promise.all([
    store.presencePut(meta.id, entry),
    store.publish(meta.id, { kind: x !== undefined ? "cursor" : "presence", t: entry.t, actor: actor.name, actorKind: actor.kind, x, y, color, status }),
  ]);
  return json({ ok: true });
});
