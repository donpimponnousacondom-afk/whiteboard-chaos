// Server settings (X-WB-Admin). GET -> {config, yourIp}. POST {ipLimit?, ipMult?, trustedIps?}.
import { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { json, readJson, route } from "@/lib/http";
import { clientIp, requireAdmin } from "@/lib/identity";
import { serverConfig, setServerConfig } from "@/lib/serverConfig";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  requireAdmin(req);
  return json({ config: await serverConfig(), yourIp: clientIp(req) });
});

export const POST = route(async (req: NextRequest) => {
  requireAdmin(req);
  const body = await readJson(req);
  const config = await setServerConfig(body);
  await audit({ type: "room", name: "admin", ip: clientIp(req), text: `admin changed IP limits: ${config.ipLimit ? `on, ${config.ipMult}x a name's budget` : "OFF"}${config.trustedIps.length ? `, trusted IPs ${config.trustedIps.join(" ")}` : ""}` });
  return json({ config, yourIp: clientIp(req) });
});
