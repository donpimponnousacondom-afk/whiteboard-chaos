import { NextRequest } from "next/server";
import { json, readJson, route } from "@/lib/http";
import { resolveActor } from "@/lib/identity";
import { act } from "@/lib/rooms";

export const dynamic = "force-dynamic";

export const POST = route<{ room: string }>(async (req: NextRequest, { room }) => {
  const t0 = Date.now();
  const body = await readJson(req);
  const actor = await resolveActor(req, body);
  // convenience: a bare single op is accepted too
  const input = Array.isArray(body.ops) ? body : body.op ? { ops: [body], nonce: body.nonce } : body;
  const res = await act(room, actor, input, req.headers.get("x-wb-key") ?? req.headers.get("x-api-key") ?? (body.key as string) ?? null);
  return json({ ...res, actor: actor.name, ms: Date.now() - t0 });
});
