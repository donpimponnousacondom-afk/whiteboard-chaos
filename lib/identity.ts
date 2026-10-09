// Lightweight identity. No accounts: a name plus an optional secret token.
// The first write with (name, token) claims the name for 30 days; later
// writes under that name must present the same token. Names without a token
// stay unclaimed and anyone can use them (that is part of the chaos).
import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { HttpError } from "./http";
import { getStore } from "./store";
import type { Actor } from "./types";

const NAME_RE = /^[A-Za-z0-9_.-]{1,24}$/;
const CLAIM_TTL = 30 * 86400 * 1000;
const cache = new Map<string, { hash: string | null; until: number }>();

export const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function clientIp(req: NextRequest): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
}

export interface IdentityInput { name?: unknown; token?: unknown; kind?: unknown }

export async function resolveActor(req: NextRequest, body: IdentityInput = {}): Promise<Actor> {
  const q = req.nextUrl.searchParams;
  const ip = clientIp(req);
  let name = String(req.headers.get("x-wb-name") ?? body.name ?? q.get("name") ?? "").trim();
  const token = String(req.headers.get("x-wb-token") ?? body.token ?? q.get("token") ?? "").trim();
  const kindRaw = String(req.headers.get("x-wb-kind") ?? body.kind ?? q.get("kind") ?? "").toLowerCase();
  const ua = req.headers.get("user-agent") ?? "";
  const kind: Actor["kind"] = kindRaw === "agent" || kindRaw === "human"
    ? kindRaw
    : /mozilla|safari|chrome/i.test(ua) && !/wb-cli|curl|python|node|bot|claude/i.test(ua) ? "human" : "agent";

  if (!name) name = "anon-" + sha(ip + ua).slice(0, 5);
  if (!NAME_RE.test(name)) throw new HttpError(400, "bad_name", "name must be 1-24 chars of [A-Za-z0-9_.-]");
  if (token && token.length < 8) throw new HttpError(400, "bad_token", "token must be at least 8 chars");

  const key = `wb:actor:${name.toLowerCase()}`;
  const now = Date.now();
  let entry = cache.get(key);
  if (!entry || entry.until < now) {
    const hash = await getStore().kvGet(key);
    entry = { hash, until: now + 30000 };
    cache.set(key, entry);
  }
  if (entry.hash) {
    if (!token || sha(token) !== entry.hash) {
      throw new HttpError(403, "name_taken", `name '${name}' is claimed. Send its token (X-WB-Token) or choose another name.`);
    }
  } else if (token) {
    const h = sha(token);
    const ok = await getStore().kvSet(key, h, CLAIM_TTL, true);
    if (!ok) {
      const cur = await getStore().kvGet(key);
      if (cur !== h) throw new HttpError(403, "name_taken", `name '${name}' was just claimed by someone else.`);
    }
    cache.set(key, { hash: h, until: now + 30000 });
  }
  return { name, kind, ip };
}
