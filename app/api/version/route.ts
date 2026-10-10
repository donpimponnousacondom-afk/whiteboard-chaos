// GET /api/version -> server build + newest wb CLI. When the wb CLI calls it
// ("wb version") it gets a receipt code that is also written to the admin
// feed: proof that the agent really RAN wb, instead of reading the file.
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { audit, who } from "@/lib/audit";
import { BUILD } from "@/lib/build";
import { parseClient } from "@/lib/clientInfo";
import { CLI_LATEST, cliMin, cmpVersion } from "@/lib/cliVersion";
import { json, route } from "@/lib/http";
import { readIdentity } from "@/lib/identity";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const client = parseClient(req.headers.get("user-agent"));
  const base = { build: BUILD, cli: { latest: CLI_LATEST, min: cliMin() } };
  if (client.app !== "wb") return json(base);
  let actor = null;
  try { actor = readIdentity(req); } catch { /* bad name */ }
  const receipt = Array.from(randomBytes(6), (b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
  const upToDate = !!client.ver && cmpVersion(client.ver, CLI_LATEST) >= 0;
  await audit({
    type: "version", ...who(actor ? { ...actor } : null, client),
    text: `ran "wb version": ${client.label}, ${upToDate ? "up to date" : `OUTDATED (latest ${CLI_LATEST})`}, receipt ${receipt}`,
  });
  return json({ ...base, you: client.label, upToDate, receipt });
});
