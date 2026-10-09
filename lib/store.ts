// Storage + fan-out layer.
//
//  RedisStore  : production. Any Redis 6.2+ reachable over TCP/TLS (Upstash,
//                Redis Cloud, Vercel Marketplace, self-hosted). One Lua script
//                does nonce check + rate limit + board write + seq + stream
//                append atomically, so every instance agrees on ordering.
//  MemoryStore : local dev / single process only. Same semantics, no deps.
//
// Live fan-out uses Redis pub/sub with ONE subscriber connection per server
// instance (see hub.ts), not one connection per viewer.

import Redis from "ioredis";
import { EventEmitter } from "node:events";
import { MAX_COLORS } from "./palette";
import type { CommitReq, CommitResult, RoomMeta, Snapshot, WbEvent } from "./types";

// Persisted events kept per room for catch-up. Full-board events weigh n bytes,
// so big boards keep fewer events (~16 MB worst case per room). Clients that
// fall further behind get a snapshot instead.
export const streamMaxlen = (n: number) => Math.max(300, Math.min(20000, Math.floor(16_000_000 / n)));
// An IP may spend this many times one name's budget (many agents behind one NAT).
const IP_MULT = Math.max(1, Number(process.env.WB_IP_MULT ?? 8));
const NONCE_TTL_S = 7 * 86400; // same 7 days replay window as v1

export interface PresenceEntry {
  name: string;
  kind: "human" | "agent";
  color?: string;
  x?: number;
  y?: number;
  t: number;
  status?: string;
}

export interface Store {
  kind: "redis" | "memory";
  getMeta(room: string): Promise<RoomMeta | null>;
  putMeta(meta: RoomMeta, palette?: string[]): Promise<void>;
  // create only if absent (atomic); false if the room already exists
  createMeta(meta: RoomMeta, palette: string[]): Promise<boolean>;
  deleteRoom(room: string): Promise<void>;
  listRooms(limit: number): Promise<{ meta: RoomMeta; active: number; seq: number }[]>;
  touch(room: string): Promise<void>;
  snapshot(room: string, n: number): Promise<Snapshot>;
  addColors(room: string, hexes: string[]): Promise<string[]>;
  setPalette(room: string, palette: string[]): Promise<void>;
  commit(room: string, req: CommitReq): Promise<CommitResult>;
  range(room: string, since: number, limit: number): Promise<{ events: WbEvent[]; head: number }>;
  publish(room: string, ev: WbEvent): Promise<void>;
  // Subscribe to the live channel of a room. Returns unsubscribe.
  subscribe(room: string, cb: (ev: WbEvent) => void): () => void;
  presencePut(room: string, e: PresenceEntry): Promise<void>;
  presenceList(room: string, maxAgeMs: number): Promise<PresenceEntry[]>;
  kvGet(key: string): Promise<string | null>;
  kvSet(key: string, val: string, ttlMs?: number, nx?: boolean): Promise<boolean>;
  kvDel(key: string): Promise<void>;
  kvIncr(key: string, ttlMs: number): Promise<number>;
  scoreAdd(room: string, name: string, pts: number): Promise<void>;
  scoreTop(room: string, n: number): Promise<{ name: string; score: number }[]>;
  scoreReset(room: string): Promise<void>;
}

// All keys of one room share the {room} hash tag => same cluster slot,
// so the Lua script is cluster-safe.
const K = {
  meta: (r: string) => `wb:{${r}}:meta`,
  board: (r: string) => `wb:{${r}}:board`,
  seq: (r: string) => `wb:{${r}}:seq`,
  ev: (r: string) => `wb:{${r}}:ev`,
  pal: (r: string) => `wb:{${r}}:pal`,
  pres: (r: string) => `wb:{${r}}:pres`,
  scores: (r: string) => `wb:{${r}}:scores`,
  nonce: (r: string, n: string) => `wb:{${r}}:n:${n}`,
  bucket: (r: string, a: string) => `wb:{${r}}:b:${a}`,
  live: (r: string) => `wb:live:${r}`,
  rooms: "wb:rooms",
};

// KEYS: board seq stream nonceKey bucketKey ipBucketKey
// ARGV: 1 n, 2 mode(d|f|n), 3 data, 4 event, 5 maxlen, 6 nonceTtl, 7 useNonce, 8 cost, 9 burst,
//       10 ratePerMs, 11 nowMs, 12 allowDebt, 13 expectSeq('' = any), 14 ipMultiplier
// Returns {0,seq} ok | {1,seq} duplicate nonce | {2,waitMs} rate limited | {3,curSeq} seq conflict
// Every check happens BEFORE the first write, so a rejected call changes nothing.
const COMMIT_LUA = `
if ARGV[7] == '1' then
  local prev = redis.call('GET', KEYS[4])
  if prev then return {1, tonumber(prev)} end
end
local now = tonumber(ARGV[11])
local cost = tonumber(ARGV[8])
local debt = ARGV[12] == '1'
local function check(key, burst, rate)
  local b = redis.call('HMGET', key, 't', 'ts')
  local tokens = tonumber(b[1]) or burst
  local ts = tonumber(b[2]) or now
  tokens = math.min(burst, tokens + math.max(0, now - ts) * rate)
  local need = cost
  if debt then need = math.min(cost, burst) end
  if tokens < need then
    if rate > 0 then return nil, math.ceil((need - tokens) / rate) end
    return nil, 60000
  end
  return tokens, 0
end
local t1, t2
if cost > 0 then
  local burst = tonumber(ARGV[9])
  local rate = tonumber(ARGV[10])
  local mult = tonumber(ARGV[14])
  local w1, w2
  t1, w1 = check(KEYS[5], burst, rate)
  if not t1 then return {2, w1} end
  t2, w2 = check(KEYS[6], burst * mult, rate * mult)
  if not t2 then return {2, w2} end
end
local cur = tonumber(redis.call('GET', KEYS[2]) or '0')
if ARGV[13] ~= '' and tonumber(ARGV[13]) ~= cur then return {3, cur} end
local last = redis.call('XREVRANGE', KEYS[3], '+', '-', 'COUNT', 1)
if last[1] then
  local ls = tonumber(string.match(last[1][1], '^(%d+)'))
  if ls and ls > cur then cur = ls end
end
local seq = cur + 1
if cost > 0 then
  redis.call('HSET', KEYS[5], 't', tostring(t1 - cost), 'ts', tostring(now))
  redis.call('PEXPIRE', KEYS[5], 3600000)
  redis.call('HSET', KEYS[6], 't', tostring(t2 - cost), 'ts', tostring(now))
  redis.call('PEXPIRE', KEYS[6], 3600000)
end
local n = tonumber(ARGV[1])
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('SET', KEYS[1], string.rep('.', n))
end
local mode = ARGV[2]
if mode == 'f' then
  redis.call('SET', KEYS[1], ARGV[3])
elseif mode == 'd' then
  for idx, ch in string.gmatch(ARGV[3], '(%d+):([^,])') do
    redis.call('SETRANGE', KEYS[1], tonumber(idx), ch)
  end
end
redis.call('SET', KEYS[2], seq)
redis.call('XADD', KEYS[3], 'MAXLEN', '~', ARGV[5], tostring(seq) .. '-0', 'e', ARGV[4])
if ARGV[7] == '1' then
  redis.call('SET', KEYS[4], seq, 'EX', tonumber(ARGV[6]))
end
return {0, seq}
`;

// KEYS: pal   ARGV: max hex...
const PALETTE_LUA = `
local max = tonumber(ARGV[1])
local cur = redis.call('LRANGE', KEYS[1], 0, -1)
local idx = {}
for i, v in ipairs(cur) do idx[v] = true end
for i = 2, #ARGV do
  local h = ARGV[i]
  if idx[h] == nil and #cur < max then
    redis.call('RPUSH', KEYS[1], h)
    table.insert(cur, h)
    idx[h] = true
  end
end
return cur
`;

export const nonceKey = (room: string, nonce: string) => K.nonce(room, nonce);
export const NONCE_TTL_MS = NONCE_TTL_S * 1000;

export function encodeChanges(changes: Map<number, string>): string {
  const parts: string[] = [];
  changes.forEach((ch, idx) => parts.push(`${idx}:${ch}`));
  return parts.join(",");
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

type RedisWithCmds = Redis & {
  wbCommit(...args: (string | number)[]): Promise<[number, number]>;
  wbPalette(...args: (string | number)[]): Promise<string[]>;
};

class RedisStore implements Store {
  kind = "redis" as const;
  private r: RedisWithCmds;
  private sub: Redis | null = null;
  private listeners = new Map<string, Set<(ev: WbEvent) => void>>();
  private url: string;

  constructor(url: string) {
    this.url = url;
    this.r = new Redis(url, {
      enableAutoPipelining: true,
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    }) as RedisWithCmds;
    this.r.on("error", (e) => console.error("[wb] redis error", e.message));
    this.r.defineCommand("wbCommit", { numberOfKeys: 6, lua: COMMIT_LUA });
    this.r.defineCommand("wbPalette", { numberOfKeys: 1, lua: PALETTE_LUA });
  }

  private subscriber(): Redis {
    if (this.sub) return this.sub;
    const s = new Redis(this.url, { maxRetriesPerRequest: null });
    s.on("error", (e) => console.error("[wb] redis sub error", e.message));
    s.on("message", (channel: string, msg: string) => {
      const room = channel.slice("wb:live:".length);
      const set = this.listeners.get(room);
      if (!set || set.size === 0) return;
      let ev: WbEvent;
      try { ev = JSON.parse(msg); } catch { return; }
      set.forEach((cb) => { try { cb(ev); } catch (e) { console.error(e); } });
    });
    // ioredis re-subscribes automatically after reconnect.
    this.sub = s;
    return s;
  }

  async getMeta(room: string) {
    const raw = await this.r.get(K.meta(room));
    return raw ? (JSON.parse(raw) as RoomMeta) : null;
  }

  async putMeta(meta: RoomMeta, palette?: string[]) {
    const m = this.r.multi().set(K.meta(meta.id), JSON.stringify(meta));
    if (palette) m.del(K.pal(meta.id)).rpush(K.pal(meta.id), ...palette);
    await m.exec();
    await this.r.zadd(K.rooms, Date.now(), meta.id);
  }

  async createMeta(meta: RoomMeta, palette: string[]) {
    const ok = await this.r.set(K.meta(meta.id), JSON.stringify(meta), "NX");
    if (ok !== "OK") return false;
    await this.r.multi().del(K.pal(meta.id), K.board(meta.id), K.seq(meta.id), K.ev(meta.id)).rpush(K.pal(meta.id), ...palette).exec();
    await this.r.zadd(K.rooms, Date.now(), meta.id);
    return true;
  }

  async deleteRoom(room: string) {
    await this.r.del(K.meta(room), K.board(room), K.seq(room), K.ev(room), K.pal(room), K.pres(room), K.scores(room));
    await this.r.del(`wb:{${room}}:game`);
    await this.r.zrem(K.rooms, room);
  }

  async listRooms(limit: number) {
    const ids = await this.r.zrevrange(K.rooms, 0, limit - 1, "WITHSCORES");
    const out: { meta: RoomMeta; active: number; seq: number }[] = [];
    for (let i = 0; i < ids.length; i += 2) {
      const [meta, seq] = await Promise.all([this.getMeta(ids[i]), this.r.get(K.seq(ids[i]))]);
      if (meta) out.push({ meta, active: Number(ids[i + 1]), seq: Number(seq || 0) });
    }
    return out;
  }

  async touch(room: string) {
    await this.r.zadd(K.rooms, Date.now(), room);
  }

  async snapshot(room: string, n: number): Promise<Snapshot> {
    const res = await this.r.multi().get(K.board(room)).get(K.seq(room)).lrange(K.pal(room), 0, -1).exec();
    const board = (res?.[0]?.[1] as string | null) ?? ".".repeat(n);
    return {
      board: board.length >= n ? board.slice(0, n) : board + ".".repeat(n - board.length),
      seq: Number(res?.[1]?.[1] ?? 0),
      palette: (res?.[2]?.[1] as string[]) ?? [],
    };
  }

  async addColors(room: string, hexes: string[]) {
    return this.r.wbPalette(K.pal(room), MAX_COLORS, ...hexes);
  }

  async setPalette(room: string, palette: string[]) {
    await this.r.multi().del(K.pal(room)).rpush(K.pal(room), ...palette).exec();
  }

  async commit(room: string, q: CommitReq): Promise<CommitResult> {
    let mode = "n";
    let data = "";
    if (q.full !== undefined) { mode = "f"; data = q.full; }
    else if (q.changes && q.changes.size) { mode = "d"; data = encodeChanges(q.changes); }
    const [code, val] = await this.r.wbCommit(
      K.board(room), K.seq(room), K.ev(room),
      K.nonce(room, q.nonce || "-"), K.bucket(room, q.bucket), K.bucket(room, "ip:" + (q.ipBucket || "-")),
      q.n, mode, data, JSON.stringify(q.event), streamMaxlen(q.n), NONCE_TTL_S,
      q.nonce ? "1" : "0", q.cost, q.burst, q.refillPerSec / 1000, Date.now(), q.allowDebt ? "1" : "0",
      q.expectSeq === undefined ? "" : String(q.expectSeq), IP_MULT,
    );
    if (code === 1) return { status: "dup", seq: Number(val) };
    if (code === 2) return { status: "limited", retryMs: Number(val) };
    if (code === 3) return { status: "conflict", seq: Number(val) };
    return { status: "ok", seq: Number(val) };
  }

  async range(room: string, since: number, limit: number) {
    const [rows, head] = await Promise.all([
      this.r.xrange(K.ev(room), `${since + 1}-0`, "+", "COUNT", limit),
      this.r.get(K.seq(room)),
    ]);
    const events: WbEvent[] = rows.map(([id, fields]) => {
      const ev = JSON.parse(fields[1]) as WbEvent;
      ev.seq = Number(id.split("-")[0]);
      return ev;
    });
    return { events, head: Number(head || 0) };
  }

  async publish(room: string, ev: WbEvent) {
    await this.r.publish(K.live(room), JSON.stringify(ev));
  }

  subscribe(room: string, cb: (ev: WbEvent) => void) {
    let set = this.listeners.get(room);
    if (!set) {
      set = new Set();
      this.listeners.set(room, set);
      this.subscriber().subscribe(K.live(room)).catch((e) => console.error("[wb] subscribe", e));
    }
    set.add(cb);
    return () => {
      const s = this.listeners.get(room);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) {
        this.listeners.delete(room);
        this.sub?.unsubscribe(K.live(room)).catch(() => {});
      }
    };
  }

  async presencePut(room: string, e: PresenceEntry) {
    await this.r.multi().hset(K.pres(room), e.name, JSON.stringify(e)).pexpire(K.pres(room), 3600000).exec();
  }

  async presenceList(room: string, maxAgeMs: number) {
    const all = await this.r.hgetall(K.pres(room));
    const now = Date.now();
    const out: PresenceEntry[] = [];
    const stale: string[] = [];
    for (const [k, v] of Object.entries(all)) {
      try {
        const e = JSON.parse(v) as PresenceEntry;
        if (now - e.t <= maxAgeMs) out.push(e); else if (now - e.t > 5 * 60000) stale.push(k);
      } catch { stale.push(k); }
    }
    if (stale.length) this.r.hdel(K.pres(room), ...stale).catch(() => {});
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async kvGet(key: string) { return this.r.get(key); }

  async kvSet(key: string, val: string, ttlMs?: number, nx?: boolean) {
    const args: (string | number)[] = [];
    if (ttlMs) args.push("PX", ttlMs);
    if (nx) args.push("NX");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (this.r as any).set(key, val, ...args);
    return r === "OK";
  }

  async kvDel(key: string) { await this.r.del(key); }

  async kvIncr(key: string, ttlMs: number) {
    // create with a TTL first, so a crash can never leave a counter without expiry
    await this.r.set(key, "0", "PX", ttlMs, "NX");
    return this.r.incr(key);
  }

  async scoreAdd(room: string, name: string, pts: number) { await this.r.zincrby(K.scores(room), pts, name); }

  async scoreTop(room: string, n: number) {
    const r = await this.r.zrevrange(K.scores(room), 0, n - 1, "WITHSCORES");
    const out: { name: string; score: number }[] = [];
    for (let i = 0; i < r.length; i += 2) out.push({ name: r[i], score: Number(r[i + 1]) });
    return out;
  }

  async scoreReset(room: string) { await this.r.del(K.scores(room)); }
}

// ---------------------------------------------------------------------------
// Memory (dev only: state is per process and lost on restart)
// ---------------------------------------------------------------------------

interface MemRoom {
  meta: RoomMeta;
  board: string[];
  seq: number;
  events: WbEvent[];
  palette: string[];
  pres: Map<string, PresenceEntry>;
  scores: Map<string, number>;
  active: number;
}

class MemoryStore implements Store {
  kind = "memory" as const;
  private rooms = new Map<string, MemRoom>();
  private kv = new Map<string, { v: string; exp: number }>();
  private buckets = new Map<string, { t: number; ts: number }>();
  private bus = new EventEmitter();

  constructor() { this.bus.setMaxListeners(0); }

  private kvAlive(key: string) {
    const e = this.kv.get(key);
    if (!e) return null;
    if (e.exp && e.exp < Date.now()) { this.kv.delete(key); return null; }
    return e;
  }

  async getMeta(room: string) { return this.rooms.get(room)?.meta ?? null; }

  async putMeta(meta: RoomMeta, palette?: string[]) {
    const r = this.rooms.get(meta.id);
    if (r) { r.meta = meta; if (palette) r.palette = [...palette]; r.active = Date.now(); return; }
    this.rooms.set(meta.id, {
      meta, board: Array(meta.w * meta.h).fill("."), seq: 0, events: [],
      palette: [...(palette ?? [])], pres: new Map(), scores: new Map(), active: Date.now(),
    });
  }

  async createMeta(meta: RoomMeta, palette: string[]) {
    if (this.rooms.has(meta.id)) return false;
    await this.putMeta(meta, palette);
    return true;
  }

  async deleteRoom(room: string) { this.rooms.delete(room); this.kv.delete(`wb:{${room}}:game`); }

  async listRooms(limit: number) {
    return [...this.rooms.values()].sort((a, b) => b.active - a.active).slice(0, limit)
      .map((r) => ({ meta: r.meta, active: r.active, seq: r.seq }));
  }

  async touch(room: string) { const r = this.rooms.get(room); if (r) r.active = Date.now(); }

  async snapshot(room: string, n: number): Promise<Snapshot> {
    const r = this.rooms.get(room);
    if (!r) return { board: ".".repeat(n), seq: 0, palette: [] };
    return { board: r.board.join(""), seq: r.seq, palette: [...r.palette] };
  }

  async addColors(room: string, hexes: string[]) {
    const r = this.rooms.get(room);
    if (!r) return [];
    for (const h of hexes) if (!r.palette.includes(h) && r.palette.length < MAX_COLORS) r.palette.push(h);
    return [...r.palette];
  }

  async setPalette(room: string, palette: string[]) { const r = this.rooms.get(room); if (r) r.palette = [...palette]; }

  async commit(room: string, q: CommitReq): Promise<CommitResult> {
    const r = this.rooms.get(room);
    if (!r) throw new Error("room missing");
    if (q.nonce) {
      const prev = this.kvAlive(nonceKey(room, q.nonce));
      if (prev) return { status: "dup", seq: Number(prev.v) };
    }
    if (q.cost > 0) {
      const now = Date.now();
      const check = (key: string, burst: number, rate: number) => {
        const b = this.buckets.get(key) ?? { t: burst, ts: now };
        const tokens = Math.min(burst, b.t + Math.max(0, now - b.ts) * rate);
        const need = q.allowDebt ? Math.min(q.cost, burst) : q.cost;
        return tokens < need ? { ok: false, wait: rate > 0 ? Math.ceil((need - tokens) / rate) : 60000, tokens } : { ok: true, wait: 0, tokens };
      };
      const rate = q.refillPerSec / 1000;
      const k1 = `${room}:${q.bucket}`, k2 = `${room}:ip:${q.ipBucket || "-"}`;
      const a = check(k1, q.burst, rate);
      if (!a.ok) return { status: "limited", retryMs: a.wait };
      const b = check(k2, q.burst * IP_MULT, rate * IP_MULT);
      if (!b.ok) return { status: "limited", retryMs: b.wait };
      this.buckets.set(k1, { t: a.tokens - q.cost, ts: now });
      this.buckets.set(k2, { t: b.tokens - q.cost, ts: now });
    }
    if (q.expectSeq !== undefined && q.expectSeq !== r.seq) return { status: "conflict", seq: r.seq };
    if (q.full !== undefined) r.board = q.full.split("");
    else if (q.changes) q.changes.forEach((ch, idx) => { r.board[idx] = ch; });
    r.seq += 1;
    r.events.push({ ...q.event, seq: r.seq });
    const maxlen = streamMaxlen(q.n);
    if (r.events.length > maxlen) r.events.splice(0, r.events.length - maxlen);
    if (q.nonce) this.kv.set(nonceKey(room, q.nonce), { v: String(r.seq), exp: Date.now() + NONCE_TTL_S * 1000 });
    return { status: "ok", seq: r.seq };
  }

  async range(room: string, since: number, limit: number) {
    const r = this.rooms.get(room);
    if (!r) return { events: [], head: 0 };
    return { events: r.events.filter((e) => (e.seq ?? 0) > since).slice(0, limit), head: r.seq };
  }

  async publish(room: string, ev: WbEvent) {
    // async hop so publish never runs listeners inside the commit call stack
    const copy = JSON.parse(JSON.stringify(ev));
    setImmediate(() => this.bus.emit(room, copy));
  }

  subscribe(room: string, cb: (ev: WbEvent) => void) {
    this.bus.on(room, cb);
    return () => { this.bus.off(room, cb); };
  }

  async presencePut(room: string, e: PresenceEntry) { this.rooms.get(room)?.pres.set(e.name, e); }

  async presenceList(room: string, maxAgeMs: number) {
    const r = this.rooms.get(room);
    if (!r) return [];
    const now = Date.now();
    return [...r.pres.values()].filter((e) => now - e.t <= maxAgeMs).sort((a, b) => a.name.localeCompare(b.name));
  }

  async kvGet(key: string) { return this.kvAlive(key)?.v ?? null; }

  async kvSet(key: string, val: string, ttlMs?: number, nx?: boolean) {
    if (nx && this.kvAlive(key)) return false;
    this.kv.set(key, { v: val, exp: ttlMs ? Date.now() + ttlMs : 0 });
    return true;
  }

  async kvDel(key: string) { this.kv.delete(key); }

  async kvIncr(key: string, ttlMs: number) {
    const e = this.kvAlive(key);
    const v = (e ? Number(e.v) : 0) + 1;
    this.kv.set(key, { v: String(v), exp: e?.exp || Date.now() + ttlMs });
    return v;
  }

  async scoreAdd(room: string, name: string, pts: number) {
    const r = this.rooms.get(room);
    if (r) r.scores.set(name, (r.scores.get(name) ?? 0) + pts);
  }

  async scoreTop(room: string, n: number) {
    const r = this.rooms.get(room);
    if (!r) return [];
    return [...r.scores.entries()].map(([name, score]) => ({ name, score })).sort((a, b) => b.score - a.score).slice(0, n);
  }

  async scoreReset(room: string) { this.rooms.get(room)?.scores.clear(); }
}

// ---------------------------------------------------------------------------

export function redisUrl(): string | undefined {
  return process.env.WB_REDIS_URL || process.env.REDIS_URL || process.env.KV_URL || process.env.UPSTASH_REDIS_URL || undefined;
}

const g = globalThis as unknown as { __wbStore?: Store };

export function getStore(): Store {
  if (!g.__wbStore) {
    const url = redisUrl();
    if (url) {
      g.__wbStore = new RedisStore(url);
    } else {
      if (process.env.VERCEL) console.warn("[wb] No REDIS_URL set: using in-memory store. State will NOT be shared between instances.");
      g.__wbStore = new MemoryStore();
    }
  }
  return g.__wbStore;
}
