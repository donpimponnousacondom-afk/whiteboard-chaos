// Room membership: join -> room session token -> write -> leave.
//
//   POST /api/rooms/ROOM/join   (name + identity token)  -> {session: "rs_..."}
//   every write to the room sends X-WB-Session: rs_...
//   POST /api/rooms/ROOM/leave  (with the session)       -> membership ends
//
// Membership persists (no expiry): an agent that ends its run stays a member
// of the room until it leaves or the admin kicks it. Only the session holder
// (or the admin) can end it. The wb CLIs, the browser, MCP and /api/tools join
// for you; raw HTTP clients must join themselves.
import { randomBytes } from "node:crypto";
import { audit, who } from "./audit";
import { HttpError } from "./http";
import { sha } from "./identity";
import { safePublish } from "./rooms";
import { getStore } from "./store";
import type { Actor, RoomMeta } from "./types";

export interface Member {
  name: string;
  kind: "human" | "agent";
  sess: string;        // sha256 of the session token
  joinedAt: number;
  lastSeen: number;
  client: string;      // label at join time
  raw?: boolean;
  via?: string;
  ip?: string;         // admin only
}

export interface Ban { until: number; by: string; t: number; reason?: string; ip?: string }

const K = {
  members: (room: string) => `wb:{${room}}:members`,
  bans: (room: string) => `wb:{${room}}:bans`,
  conn: (room: string, name: string) => `wb:{${room}}:conn:${name.toLowerCase()}`,
  act: (room: string, name: string) => `wb:{${room}}:act:${name.toLowerCase()}`,
};

// Something was written (draw, chat, guess, game): "active" for 15 s.
export function markActive(room: string, name: string) {
  getStore().kvSet(K.act(room, name), String(Date.now()), 15000).catch(() => {});
}

const cache = new Map<string, { sess: string; until: number }>();
const seen = new Map<string, number>();
const ck = (room: string, name: string) => `${room}:${name.toLowerCase()}`;

export async function getMember(room: string, name: string): Promise<Member | null> {
  const raw = await getStore().hashGet(K.members(room), name.toLowerCase());
  try { return raw ? JSON.parse(raw) as Member : null; } catch { return null; }
}

async function putMember(room: string, m: Member) {
  await getStore().hashSet(K.members(room), m.name.toLowerCase(), JSON.stringify(m));
}

export async function activeBan(room: string, name: string, ip: string): Promise<Ban | null> {
  const all = await getStore().hashAll(K.bans(room));
  const now = Date.now();
  for (const [key, raw] of Object.entries(all)) {
    let b: Ban;
    try { b = JSON.parse(raw); } catch { continue; }
    if (b.until && b.until < now) { getStore().hashDel(K.bans(room), key).catch(() => {}); continue; }
    if (key === name.toLowerCase() || (b.ip && b.ip === ip)) return b;
  }
  return null;
}

function banError(room: string, b: Ban) {
  const left = b.until ? Math.max(1, Math.ceil((b.until - Date.now()) / 60000)) : 0;
  return new HttpError(403, "banned", `the admin removed you from room '${room}'${left ? ` for ${left} more min` : " until further notice"}${b.reason ? `: ${b.reason}` : ""}. Do not try another name or a raw request: it is logged.`, { retryMs: left ? left * 60000 : undefined });
}

export async function join(meta: RoomMeta, actor: Actor): Promise<{ session: string; member: Member; rejoined: boolean }> {
  if (!actor.admin) {
    const ban = await activeBan(meta.id, actor.name, actor.ip);
    if (ban) throw banError(meta.id, ban);
  }
  const session = "rs_" + randomBytes(18).toString("base64url");
  const prev = await getMember(meta.id, actor.name);
  const now = Date.now();
  const m: Member = {
    name: actor.name, kind: actor.kind, sess: sha(session), joinedAt: prev?.joinedAt ?? now, lastSeen: now,
    client: actor.client?.label ?? "unknown", raw: actor.client?.raw, via: actor.via, ip: actor.ip,
  };
  await putMember(meta.id, m);
  cache.set(ck(meta.id, actor.name), { sess: m.sess, until: now + 5000 });
  await audit({ type: "join", room: meta.id, ...who(actor), text: `${prev ? "joined again (new session)" : "joined"} via ${m.client}` });
  await safePublish(meta.id, { kind: "member", t: now, actor: actor.name, actorKind: actor.kind, action: "join" });
  return { session, member: m, rejoined: !!prev };
}

export async function leave(meta: RoomMeta, actor: Actor, session: string | null | undefined) {
  const m = await getMember(meta.id, actor.name);
  if (!m) return { ok: true, wasMember: false };
  if (!actor.admin && (!session || sha(session) !== m.sess)) {
    throw new HttpError(403, "bad_session", "only the holder of this membership's session token can leave with it (X-WB-Session)");
  }
  await getStore().hashDel(K.members(meta.id), actor.name.toLowerCase());
  cache.delete(ck(meta.id, actor.name));
  await audit({ type: "leave", room: meta.id, ...who(actor), text: "left the room (logout)" });
  await safePublish(meta.id, { kind: "member", t: Date.now(), actor: actor.name, actorKind: actor.kind, action: "leave" });
  return { ok: true, wasMember: true };
}

const joinHint = (room: string) =>
  `Join first: "wb join ${room}" (the wb CLI does it for you), or POST /api/rooms/${room}/join with X-WB-Name + X-WB-Token, ` +
  `then send the returned session in X-WB-Session on every write.`;

// Writes need a membership. Official clients that cannot carry a session
// (MCP, /api/tools) join automatically; raw HTTP must join itself.
export async function requireMember(meta: RoomMeta, actor: Actor) {
  if (actor.via === "v1" || actor.admin) return;
  const key = ck(meta.id, actor.name);
  const now = Date.now();
  if (actor.via === "mcp" || actor.via === "tools") {
    const c = cache.get(key);
    if (c && c.until > now) return;
    const m = await getMember(meta.id, actor.name);
    if (!m) { await join(meta, actor); return; }
    cache.set(key, { sess: m.sess, until: now + 5000 });
    touchSeen(meta.id, m);
    return;
  }
  const s = actor.session;
  if (!s) throw new HttpError(401, "not_joined", `you are not logged in to room '${meta.id}'. ${joinHint(meta.id)}`);
  const h = sha(s);
  const c = cache.get(key);
  if (c && c.until > now && c.sess === h) return;
  const m = await getMember(meta.id, actor.name);
  if (!m) {
    const ban = await activeBan(meta.id, actor.name, actor.ip);
    if (ban) throw banError(meta.id, ban);
    throw new HttpError(401, "not_joined", `'${actor.name}' is not a member of room '${meta.id}' (you left, or the admin removed you). ${joinHint(meta.id)}`);
  }
  if (m.sess !== h) throw new HttpError(401, "bad_session", `this session is not valid for '${actor.name}' in room '${meta.id}': you joined again somewhere else. Use the newest session, or join again.`);
  cache.set(key, { sess: h, until: now + 5000 });
  touchSeen(meta.id, m);
}

function touchSeen(room: string, m: Member) {
  const key = ck(room, m.name);
  const now = Date.now();
  if (now - (seen.get(key) ?? 0) < 60000) return;
  seen.set(key, now);
  putMember(room, { ...m, lastSeen: now }).catch(() => {});
}

export async function kick(meta: RoomMeta, name: string, minutes: number, byAdmin: string, alsoIp: boolean, reason?: string) {
  const m = await getMember(meta.id, name);
  const until = minutes > 0 ? Date.now() + minutes * 60000 : 0;
  const ban: Ban = { until, by: byAdmin, t: Date.now(), reason: reason?.slice(0, 120), ...(alsoIp && m?.ip ? { ip: m.ip } : {}) };
  await getStore().hashSet(K.bans(meta.id), name.toLowerCase(), JSON.stringify(ban));
  await getStore().hashDel(K.members(meta.id), name.toLowerCase());
  cache.delete(ck(meta.id, name));
  await getStore().kvDel(K.conn(meta.id, name));
  await audit({ type: "kick", room: meta.id, name, kind: m?.kind, client: m?.client, ip: m?.ip, text: `kicked by the admin${minutes > 0 ? ` for ${minutes} min` : " until unbanned"}${ban.ip ? " (IP banned too)" : ""}${reason ? `: ${reason}` : ""}` });
  await safePublish(meta.id, { kind: "kick", t: Date.now(), target: name, minutes, reason: reason?.slice(0, 120) });
  return { ok: true, wasMember: !!m, until };
}

export async function unban(meta: RoomMeta, name: string) {
  await getStore().hashDel(K.bans(meta.id), name.toLowerCase());
  await audit({ type: "unban", room: meta.id, name, text: "ban lifted by the admin" });
  return { ok: true };
}

export async function listBans(room: string): Promise<(Ban & { name: string })[]> {
  const all = await getStore().hashAll(K.bans(room));
  const now = Date.now();
  return Object.entries(all).map(([name, raw]) => { try { return { name, ...JSON.parse(raw) as Ban }; } catch { return null; } })
    .filter((b): b is Ban & { name: string } => !!b && (!b.until || b.until > now));
}

// --- live connections (SSE / WebSocket) --------------------------------------
// One key per room+name, refreshed on every (re)connect. Streams reopen every
// ~270 s, so the key (330 s) stays alive while a client is connected.
export async function markConnected(meta: RoomMeta, actor: Actor, transport: string) {
  const fresh = await getStore().kvSet(K.conn(meta.id, actor.name), transport, 330000, true);
  if (!fresh) { getStore().kvSet(K.conn(meta.id, actor.name), transport, 330000).catch(() => {}); return; }
  await audit({ type: "connect", room: meta.id, ...who(actor), text: `connected (${transport})` });
}

export async function markDisconnected(meta: RoomMeta, actor: Actor, transport: string, ms: number) {
  await getStore().kvDel(K.conn(meta.id, actor.name));
  await audit({ type: "disconnect", room: meta.id, ...who(actor), text: `disconnected (${transport}, after ${fmtDur(ms)})` });
}

function fmtDur(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
}

export type MemberStatus = "active" | "online" | "idle" | "offline";

export interface RosterEntry {
  name: string; kind: "human" | "agent"; status: MemberStatus; client: string; raw?: boolean;
  joinedAt: number; lastSeen: number; activity?: string; ip?: string;
}

// active: drew, chatted or played in the last 15 s; online: connected
// stream or activity in the last 2 min; idle: seen in the last hour.
export async function roster(meta: RoomMeta, withIp: boolean): Promise<RosterEntry[]> {
  const store = getStore();
  const [all, pres] = await Promise.all([store.hashAll(K.members(meta.id)), store.presenceList(meta.id, 3600000)]);
  const presBy = new Map(pres.map((p) => [p.name.toLowerCase(), p]));
  const members = Object.values(all).map((r) => { try { return JSON.parse(r) as Member; } catch { return null; } }).filter((m): m is Member => !!m);
  const [conns, acts] = await Promise.all([
    Promise.all(members.map((m) => store.kvGet(K.conn(meta.id, m.name)))),
    Promise.all(members.map((m) => store.kvGet(K.act(meta.id, m.name)))),
  ]);
  const now = Date.now();
  return members.map((m, i) => {
    const p = presBy.get(m.name.toLowerCase());
    const last = Math.max(m.lastSeen, p?.t ?? 0);
    const status: MemberStatus = acts[i] ? "active" : conns[i] || now - last < 120000 ? "online" : now - last < 3600000 ? "idle" : "offline";
    return {
      name: m.name, kind: m.kind, status, client: m.client, raw: m.raw, joinedAt: m.joinedAt, lastSeen: last,
      activity: p?.status, ...(withIp ? { ip: m.ip } : {}),
    };
  }).sort((a, b) => ["active", "online", "idle", "offline"].indexOf(a.status) - ["active", "online", "idle", "offline"].indexOf(b.status) || a.name.localeCompare(b.name));
}
