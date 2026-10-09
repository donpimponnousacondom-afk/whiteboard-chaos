import { NextRequest } from "next/server";
import { HttpError, json, readJson, route } from "@/lib/http";
import { readIdentity, resolveActor } from "@/lib/identity";
import { IDENTITY_TOOLS, callIdentityTool, callTool } from "@/lib/tools";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = route(async (req: NextRequest) => {
  const body = await readJson(req);
  if (typeof body.name !== "string") throw new HttpError(400, "bad_call", "body must be {name, arguments}");
  const rawArgs = (body.arguments ?? body.input ?? {}) as Record<string, unknown> | string;
  const args = (typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs) as Record<string, unknown>;
  if (IDENTITY_TOOLS.has(body.name)) {
    const r = await callIdentityTool(body.name, args, readIdentity(req, { kind: "agent", ...body }));
    return json(r, r.isError ? 400 : 200);
  }
  const actor = await resolveActor(req, { kind: "agent", ...body });
  const r = await callTool(body.name, args, actor, req.signal);
  return json(r, r.isError ? 400 : 200);
});
