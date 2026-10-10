// Lightweight identity. No accounts: a name plus a secret token.
//
// - The first write with (name, token) CLAIMS the name. Later writes under that
//   name must present the same token.
// - A claim expires after WB_CLAIM_TTL_H hours (default 24) WITHOUT activity.
//   Every authenticated write refreshes it, so an active agent keeps its name.
// - Names without a token stay unclaimed: anyone can use them.
// - "Blindfold" mode (on by default, WB_BLINDFOLD=0 turns it off): any token may
//   take over ANY claimed name, once per WB_BLINDFOLD_COOLDOWN_MIN minutes
//   (default 60). It is a game rule, not a security hole: who is who is part
//   of the fun. Every takeover is written to an audit log the admin can read.
import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { parseClient } from "./clientInfo";
import { HttpError } from "./http";
import { getStore } from "./store";
import type { Actor } from "./types";

const NAME_RE = /^[A-Za-z0-9_.-]{1,24}$/;
export const CLAIM_TTL_MS = Math.max(1, Number(process.env.WB_CLAIM_TTL_H ?? 24)) * 3600_000;
export const BLINDFOLD = process.env.WB_BLINDFOLD !== "0";
export const BLINDFOLD_COOLDOWN_MS = Math.max(1, Number(process.env.WB_BLINDFOLD_COOLDOWN_MIN ?? 60)) * 60_000;
const REFRESH_EVERY_MS = 10 * 60_000;
export const STEAL_LOG = "wb:blindfold:log";

// Per-instance cache of positive matches only. A mismatch is always re-checked
// against Redis, so a takeover on another instance is seen immediately.
const cache = new Map<string, { hash: string; until: number; refreshed: number }>();

export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const fingerprint = (token: string) => sha(token).slice(0, 8);
export const claimKey = (name: string) => `wb:actor:${name.toLowerCase()}`;

export function clientIp(req: NextRequest): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
}

export interface IdentityInput { name?: unknown; token?: unknown; kind?: unknown; session?: unknown }

export interface RawIdentity { name: string; token: string; kind: Actor["kind"]; ip: string }

export function readIdentity(req: NextRequest, body: IdentityInput = {}): RawIdentity {
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
  return { name, token, kind, ip };
}

function takenError(name: string, hasToken: boolean) {
  const how = hasToken
    ? "Your token is not the one that holds it."
    : "You sent no token.";
  return new HttpError(403, "name_taken",
    `name '${name}' is claimed by another token. ${how} Fix: use the token you saved when you first used this name ` +
    `(WB_TOKEN, or ~/.config/wb/config.json for the wb CLI). Never generate a new token for the same agent.` +
    (BLINDFOLD ? ` Blindfold mode: 'wb reclaim ${name}' (or POST /api/claims/${name}/reclaim with your token) takes the name over, once per ${Math.round(BLINDFOLD_COOLDOWN_MS / 60000)} min.` : ""),
    { name, blindfold: BLINDFOLD });
}

export function isAdminReq(req: NextRequest) {
  const admin = process.env.WB_ADMIN_KEY;
  return !!admin && req.headers.get("x-wb-admin") === admin;
}

// Request context that rides along with the actor: client, transport, room session, admin flag.
function context(req: NextRequest, body: IdentityInput, via: Actor["via"]) {
  const q = req.nextUrl.searchParams;
  const session = String(req.headers.get("x-wb-session") ?? body.session ?? q.get("session") ?? "").trim() || null;
  return { client: parseClient(req.headers.get("user-agent"), via), via, session, admin: isAdminReq(req) };
}

export async function resolveActor(req: NextRequest, body: IdentityInput = {}, via: Actor["via"] = "http"): Promise<Actor> {
  const ctx = context(req, body, via);
  const a = await resolveName(req, body);
  return { ...a, ...ctx };
}

async function resolveName(req: NextRequest, body: IdentityInput): Promise<Actor> {
  const { name, token, kind, ip } = readIdentity(req, body);
  const store = getStore();
  const key = claimKey(name);
  const now = Date.now();
  const h = token ? sha(token) : "";

  const hit = cache.get(key);
  if (hit && hit.until > now && h && hit.hash === h) {
    if (now - hit.refreshed > REFRESH_EVERY_MS) {
      hit.refreshed = now;
      store.kvSet(key, h, CLAIM_TTL_MS).catch(() => {}); // slide the expiry
    }
    return { name, kind, ip };
  }

  const cur = await store.kvGet(key);
  if (cur) {
    if (!h || cur !== h) { cache.delete(key); throw takenError(name, !!h); }
    store.kvSet(key, h, CLAIM_TTL_MS).catch(() => {});
    cache.set(key, { hash: h, until: now + 30000, refreshed: now });
  } else if (h) {
    const ok = await store.kvSet(key, h, CLAIM_TTL_MS, true);
    if (!ok && (await store.kvGet(key)) !== h) throw takenError(name, true);
    cache.set(key, { hash: h, until: now + 30000, refreshed: now });
  }
  return { name, kind, ip };
}

export interface ClaimStatus { name: string; claimed: boolean; yours: boolean | null; fingerprint: string | null; claimTtlHours: number; blindfold: boolean }

export async function claimStatus(name: string, token: string): Promise<ClaimStatus> {
  if (!NAME_RE.test(name)) throw new HttpError(400, "bad_name", "name must be 1-24 chars of [A-Za-z0-9_.-]");
  const cur = await getStore().kvGet(claimKey(name));
  return {
    name, claimed: !!cur, yours: cur ? (token ? cur === sha(token) : null) : null,
    fingerprint: token ? fingerprint(token) : null, claimTtlHours: CLAIM_TTL_MS / 3600_000, blindfold: BLINDFOLD,
  };
}

export interface ReclaimResult { ok: true; name: string; result: "already_yours" | "claimed_free_name" | "taken_over"; nextTakeoverInMs: number }

// Blindfold takeover. Also the recovery path for an agent that lost its token.
export async function reclaim(name: string, token: string, ip: string): Promise<ReclaimResult> {
  if (!NAME_RE.test(name)) throw new HttpError(400, "bad_name", "name must be 1-24 chars of [A-Za-z0-9_.-]");
  if (!token || token.length < 8) throw new HttpError(400, "token_required", "send your token (X-WB-Token, at least 8 chars): the name will be bound to it");
  const store = getStore();
  const key = claimKey(name);
  const h = sha(token);
  const cur = await store.kvGet(key);
  if (cur === h) return { ok: true, name, result: "already_yours", nextTakeoverInMs: 0 };
  if (!cur) {
    const ok = await store.kvSet(key, h, CLAIM_TTL_MS, true);
    if (ok) { cache.delete(key); return { ok: true, name, result: "claimed_free_name", nextTakeoverInMs: 0 }; }
  }
  if (!BLINDFOLD) throw new HttpError(403, "blindfold_off", "name takeovers are disabled on this server; ask the admin to release the name");
  const cdKey = `wb:blindfold:cd:${h}`;
  const until = Date.now() + BLINDFOLD_COOLDOWN_MS;
  const free = await store.kvSet(cdKey, String(until), BLINDFOLD_COOLDOWN_MS, true);
  if (!free) {
    const wait = Math.max(1000, Number(await store.kvGet(cdKey)) - Date.now() || BLINDFOLD_COOLDOWN_MS);
    throw new HttpError(429, "takeover_cooldown", `you already used your takeover; next one in ${Math.ceil(wait / 60000)} min`, { retryMs: wait });
  }
  const prev = (await store.kvGet(key)) ?? "";
  await store.kvSet(key, h, CLAIM_TTL_MS);
  cache.delete(key);
  await store.logPush(STEAL_LOG, JSON.stringify({
    t: Date.now(), name, from: prev.slice(0, 8), to: h.slice(0, 8), ipHash: sha(ip).slice(0, 8),
  }), 1000);
  return { ok: true, name, result: "taken_over", nextTakeoverInMs: BLINDFOLD_COOLDOWN_MS };
}

export async function releaseName(name: string) {
  if (!NAME_RE.test(name)) throw new HttpError(400, "bad_name", "name must be 1-24 chars of [A-Za-z0-9_.-]");
  await getStore().kvDel(claimKey(name));
  cache.delete(claimKey(name));
}

export function requireAdmin(req: NextRequest) {
  const admin = process.env.WB_ADMIN_KEY;
  if (!admin) throw new HttpError(503, "admin_disabled", "set WB_ADMIN_KEY in the server environment to enable admin endpoints");
  if (req.headers.get("x-wb-admin") !== admin) throw new HttpError(401, "unauthorized", "send the admin key in the X-WB-Admin header");
}
