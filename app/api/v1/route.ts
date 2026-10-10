// v1 compatibility: the original PHP API, served over room "chaos".
//   GET  /api.php            index
//   GET  /api.php?view=grid  {width,height,cells}
//   GET  /grid.php           same
//   POST /api.php|/cell.php  {x,y,color,nonce}  -> 200 | 400 | 401 | 409 nonce_replayed
import { NextRequest } from "next/server";
import { HttpError, readJson, route } from "@/lib/http";
import { resolveActor } from "@/lib/identity";
import { act, getRoom } from "@/lib/rooms";

export const dynamic = "force-dynamic";

import { v1Grid as grid, v1Res as res, V1_ROOM as ROOM } from "@/lib/v1";

export const GET = route(async (req: NextRequest) => {
  const view = req.nextUrl.searchParams.get("view") ?? "";
  if (view === "grid" || req.nextUrl.searchParams.get("grid") === "1") return grid();
  if (view !== "") return res(400, { ok: false, error: "unknown_view" });
  return res(200, {
    name: "chaos-whiteboard", version: "3.0.0-v1compat", grid: { width: 16, height: 16 }, agents_md: "/AGENTS.md",
    note: "v1 compatibility layer over room 'chaos'. The v3 API at /api has many rooms, batch ops, SSE and MCP.",
    endpoints: {
      "GET /api.php": "this index", "GET /api.php?view=grid": "grid state", "GET /grid.php": "grid state",
      "POST /api.php": 'set one cell: {"x":0-15,"y":0-15,"color":"#rrggbb","nonce":"8-64 chars"}', "POST /cell.php": "same",
    },
  });
});

export const POST = route(async (req: NextRequest) => {
  const v1Key = process.env.WB_API_KEY;
  if (v1Key && req.headers.get("x-api-key") !== v1Key) return res(401, { ok: false, error: "unauthorized" });
  let body: Record<string, unknown>;
  try { body = await readJson(req); } catch { return res(400, { ok: false, error: "invalid_json" }); }
  const meta = await getRoom(ROOM);
  const x = Number(body.x), y = Number(body.y);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= meta.w || y >= meta.h) return res(400, { ok: false, error: "bad_coordinates" });
  if (typeof body.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(body.color)) return res(400, { ok: false, error: "bad_color" });
  if (typeof body.nonce !== "string" || !/^[A-Za-z0-9._-]{8,64}$/.test(body.nonce)) return res(400, { ok: false, error: "bad_nonce" });
  const color = body.color.toLowerCase();
  const actor = await resolveActor(req, { ...body, name: body.name ?? req.headers.get("x-wb-name") ?? undefined }, "v1");
  try {
    const r = await act(ROOM, actor, { ops: [{ op: "px", x, y, c: color === "#000000" ? null : color }], nonce: body.nonce }, null);
    if (r.duplicate) return res(409, { ok: false, error: "nonce_replayed" });
    return res(200, { ok: true, x, y, color, seq: r.seq });
  } catch (e) {
    if (e instanceof HttpError && e.status === 429) return res(429, { ok: false, error: "rate_limited", retryMs: e.extra?.retryMs });
    throw e;
  }
});
