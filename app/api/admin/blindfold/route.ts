// GET /api/admin/blindfold?limit=200   (header X-WB-Admin) -> name takeover audit log, newest first.
// `from` / `to` are token fingerprints (first 8 hex of sha256(token)); `wb whoami` shows an agent's own.
import { NextRequest } from "next/server";
import { json, num, route } from "@/lib/http";
import { requireAdmin, STEAL_LOG } from "@/lib/identity";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  requireAdmin(req);
  const limit = Math.max(1, Math.min(1000, num(req.nextUrl.searchParams.get("limit"), 200)!));
  const rows = await getStore().logRange(STEAL_LOG, limit);
  return json({ takeovers: rows.map((r) => JSON.parse(r)) });
});
