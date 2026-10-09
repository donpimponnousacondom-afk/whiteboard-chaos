// DELETE /api/admin/claims/:name   (header X-WB-Admin: WB_ADMIN_KEY) -> release a name
import { NextRequest } from "next/server";
import { json, route } from "@/lib/http";
import { releaseName, requireAdmin } from "@/lib/identity";

export const dynamic = "force-dynamic";

export const DELETE = route<{ name: string }>(async (req: NextRequest, { name }) => {
  requireAdmin(req);
  await releaseName(name);
  return json({ ok: true, released: name });
});
