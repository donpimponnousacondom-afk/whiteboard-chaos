// GET /api/claims/:name  -> is the name claimed, and is it yours (send X-WB-Token)?
import { NextRequest } from "next/server";
import { json, route } from "@/lib/http";
import { claimStatus } from "@/lib/identity";

export const dynamic = "force-dynamic";

export const GET = route<{ name: string }>(async (req: NextRequest, { name }) => {
  const token = String(req.headers.get("x-wb-token") ?? req.nextUrl.searchParams.get("token") ?? "").trim();
  return json(await claimStatus(name, token));
});
