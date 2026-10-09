import { NextRequest } from "next/server";
import { HttpError, json, readJson, route } from "@/lib/http";
import { resolveActor } from "@/lib/identity";
import { callTool } from "@/lib/tools";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = route(async (req: NextRequest) => {
  const body = await readJson(req);
  if (typeof body.name !== "string") throw new HttpError(400, "bad_call", "body must be {name, arguments}");
  const actor = await resolveActor(req, { kind: "agent", ...body });
  const args = (body.arguments ?? body.input ?? {}) as Record<string, unknown>;
  const r = await callTool(body.name, typeof args === "string" ? JSON.parse(args) : args, actor, req.signal);
  return json(r, r.isError ? 400 : 200);
});
