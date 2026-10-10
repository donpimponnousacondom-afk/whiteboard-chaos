// Server-wide settings the admin changes at runtime (no redeploy), stored in
// Redis. Today: the per-IP limits. Many agents on one machine share an IP, so
// the admin can turn IP limits off, change their size, or trust some IPs.
//   env defaults: WB_IP_LIMIT=0 (off), WB_IP_MULT=8, WB_TRUSTED_IPS=1.2.3.4,5.6.7.8
import { HttpError } from "./http";
import { getStore } from "./store";

export interface ServerConfig {
  ipLimit: boolean;       // false: no limit is shared by IP (pixels, chat, room creation)
  ipMult: number;         // an IP may spend this many times one name's budget
  trustedIps: string[];   // these IPs never hit IP limits
}

const KEY = "wb:config";
const DEFAULTS: ServerConfig = {
  ipLimit: process.env.WB_IP_LIMIT !== "0",
  ipMult: Math.max(1, Number(process.env.WB_IP_MULT ?? 8)),
  trustedIps: (process.env.WB_TRUSTED_IPS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
};

let cache: { cfg: ServerConfig; until: number } | null = null;

export async function serverConfig(): Promise<ServerConfig> {
  if (cache && cache.until > Date.now()) return cache.cfg;
  let cfg = DEFAULTS;
  try {
    const raw = await getStore().kvGet(KEY);
    if (raw) cfg = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* keep defaults */ }
  cache = { cfg, until: Date.now() + 5000 };
  return cfg;
}

// 0 = this IP has no IP limit at all.
export async function ipMultFor(ip: string): Promise<number> {
  const c = await serverConfig();
  if (!c.ipLimit || c.trustedIps.includes(ip)) return 0;
  return c.ipMult;
}

export async function setServerConfig(patch: Partial<Record<keyof ServerConfig, unknown>>): Promise<ServerConfig> {
  const cur = await serverConfig();
  const next: ServerConfig = { ...cur };
  if (patch.ipLimit !== undefined) next.ipLimit = !!patch.ipLimit;
  if (patch.ipMult !== undefined) {
    const n = Number(patch.ipMult);
    if (!Number.isFinite(n) || n < 1 || n > 1000) throw new HttpError(400, "bad_setting", "ipMult must be 1..1000");
    next.ipMult = n;
  }
  if (patch.trustedIps !== undefined) {
    const list = Array.isArray(patch.trustedIps) ? patch.trustedIps : String(patch.trustedIps).split(/[\s,]+/);
    next.trustedIps = [...new Set(list.map((s) => String(s).trim()).filter((s) => /^[0-9a-fA-F:.]{2,45}$/.test(s)))].slice(0, 100);
  }
  await getStore().kvSet(KEY, JSON.stringify(next));
  cache = { cfg: next, until: Date.now() + 5000 };
  return next;
}
