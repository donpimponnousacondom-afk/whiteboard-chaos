// Audit feed for the admin ("who connects where, with what"). Like an IRC
// server log: connects, joins, draws, guesses, errors, version checks.
// Kept per room (last 600) and globally (last 3000). IPs are stored here and
// shown ONLY with the admin key.
import { getStore } from "./store";
import type { Actor, ClientInfo } from "./types";

export type AuditType =
  | "connect" | "disconnect" | "join" | "leave" | "kick" | "unban" | "draw" | "guess"
  | "error" | "version" | "room" | "game";

export interface AuditEntry {
  t: number;
  type: AuditType;
  room?: string;
  name?: string;
  kind?: "human" | "agent";
  client?: string;     // label, e.g. "wb 4.0.0 python 3.14.0"
  raw?: boolean;       // not an official client (curl, urllib, ...)
  ip?: string;
  text: string;
  code?: string;
  n?: number;          // repeated entries folded into this one
}

const roomKey = (room: string) => `wb:{${room}}:audit`;
const GLOBAL = "wb:audit";

export async function audit(e: Omit<AuditEntry, "t"> & { t?: number }) {
  const entry = JSON.stringify({ t: Date.now(), ...e });
  const store = getStore();
  try {
    await Promise.all([
      store.logPush(GLOBAL, entry, 3000),
      e.room ? store.logPush(roomKey(e.room), entry, 600) : Promise.resolve(),
    ]);
  } catch (err) { console.error("[wb] audit failed", (err as Error).message); }
}

export function who(actor: Actor | null | undefined, client?: ClientInfo) {
  const c = client ?? actor?.client;
  return { name: actor?.name, kind: actor?.kind, client: c?.label, raw: c?.raw, ip: actor?.ip };
}

// Fold bursts: at most one entry per key per window; the next one reports how
// many were folded. Per instance (good enough: a few duplicates across
// instances are harmless, and it costs no Redis calls).
const folds = new Map<string, { t: number; n: number; px: number }>();

export function fold(key: string, windowMs: number, px = 0): { emit: boolean; n: number; px: number } {
  const now = Date.now();
  const f = folds.get(key);
  if (f && now - f.t < windowMs) { f.n++; f.px += px; return { emit: false, n: 0, px: 0 }; }
  const out = { emit: true, n: f ? f.n + 1 : 1, px: (f?.px ?? 0) + px };
  folds.set(key, { t: now, n: 0, px: 0 });
  if (folds.size > 5000) for (const [k, v] of folds) if (now - v.t > 60000) folds.delete(k);
  return out;
}

export async function readAudit(room: string | null, limit: number, withIp: boolean): Promise<AuditEntry[]> {
  const raw = await getStore().logRange(room ? roomKey(room) : GLOBAL, Math.max(1, Math.min(limit, room ? 600 : 3000)));
  const out: AuditEntry[] = [];
  for (const r of raw) {
    try {
      const e = JSON.parse(r) as AuditEntry;
      if (!withIp) delete e.ip;
      out.push(e);
    } catch { /* skip bad line */ }
  }
  return out;
}
