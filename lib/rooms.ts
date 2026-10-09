// Room engine: presets, creation, and the single write path `act()`.
// Every mutation goes through act() -> store.commit() so nonce, rate limit,
// ordering and fan-out live in exactly one place (same rule as v1's
// wb_apply_cell()).
import seedV1 from "../seed/chaos-live-grid.json";
import { checkGuess, endRoundIfExpired, gameGuard, gameView, pickWord, skipRound, startRound } from "./game";
import { HttpError } from "./http";
import { sha } from "./identity";
import { ALPHABET, DEFAULT_PALETTE, EMPTY, MAX_COLORS, normHex } from "./palette";
import { applyOps, BULK_OPS, collectHexes, DRAW_OPS, Op, OpError } from "./raster";
import { getStore, nonceKey, NONCE_TTL_MS } from "./store";
import { randomBytes } from "node:crypto";
import { DEFAULT_SETTINGS, mergeSettings, roomSettings } from "./settings";
import type { Actor, Mode, RoomMeta, RoomSettings, WbEvent } from "./types";

export const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MODES: Mode[] = ["free", "place", "guess", "life"];
export const MAX_SIDE = 256;
export const MAX_OPS = 500;

interface Preset extends Partial<RoomMeta> { title: string; w: number; h: number; mode: Mode; seed?: () => string }

const PRESET_V = 2;

export const PRESETS: Record<string, Preset> = {
  chaos: {
    title: "Chaos (v1 classic)", w: 16, h: 16, mode: "free",
    theme: "The original 16x16 board, imported from v1. Anything goes. The v1 API (api.php, cell.php, grid.php) writes here.",
    seed: () => seedFromV1(seedV1 as { cells: string[][] }),
  },
  lobby: { title: "Lobby", w: 64, h: 64, mode: "free", theme: "The big shared wall. Say hi in chat, draw something, leave space for others." },
  place: { title: "Place", w: 128, h: 96, mode: "place", cooldownMs: 2000, theme: "One pixel every 2 seconds per player. Cooperate, conquer, or defend your art." },
  pictionary: { title: "Pictionary", w: 32, h: 32, mode: "guess", theme: "Press Draw the next word: you pick 1 of 3 secret words and draw it. Everyone else guesses in the private guess box. Faster guesses score more, and the drawer scores for every correct guess." },
  life: { title: "Life", w: 48, h: 48, mode: "life", theme: "Paint cells, then step Conway's Game of Life. Newborn cells take the most common neighbour color, so colonies compete." },
};

function seedFromV1(g: { cells: string[][] }): string {
  return g.cells.flat().map((hex) => {
    const h = normHex(hex);
    if (!h || h === "#000000") return EMPTY;
    const i = DEFAULT_PALETTE.indexOf(h);
    return i >= 0 ? ALPHABET[i] : EMPTY;
  }).join("");
}

function modeDefaults(mode: Mode, cooldownMs?: number) {
  if (mode === "place") {
    const cd = Math.max(250, Math.min(600000, cooldownMs ?? 2000));
    return { cooldownMs: cd, burst: 1, refillPerSec: 1000 / cd };
  }
  return { cooldownMs: 0, burst: 4096, refillPerSec: 1024 };
}

export function publicMeta(m: RoomMeta) {
  const { keyHash, ownerKeyHash, settings, ...rest } = m;
  void ownerKeyHash; void settings;
  return { ...rest, locked: !!keyHash, settings: publicSettings(m) };
}

// --- meta cache (per instance, short) -------------------------------------
const metaCache = new Map<string, { meta: RoomMeta; until: number }>();

export async function getRoom(id: string): Promise<RoomMeta> {
  if (!ROOM_RE.test(id)) throw new HttpError(400, "bad_room", "room id must match [a-z0-9][a-z0-9-]{0,31}");
  const c = metaCache.get(id);
  if (c && c.until > Date.now()) return c.meta;
  let meta = await getStore().getMeta(id);
  if (!meta && PRESETS[id]) meta = await createPreset(id);
  // built-in rooms pick up new default texts once per preset version
  if (meta?.system && PRESETS[id] && (meta as RoomMeta & { presetV?: number }).presetV !== PRESET_V) {
    meta = { ...meta, title: PRESETS[id].title, theme: PRESETS[id].theme ?? meta.theme, presetV: PRESET_V } as RoomMeta;
    await getStore().putMeta(meta);
  }
  if (!meta) throw new HttpError(404, "room_not_found", `room '${id}' does not exist. Create it with POST /api/rooms`);
  metaCache.set(id, { meta, until: Date.now() + 3000 });
  return meta;
}

async function createPreset(id: string): Promise<RoomMeta> {
  const p = PRESETS[id];
  const meta: RoomMeta = {
    id, title: p.title, theme: p.theme ?? "", w: p.w, h: p.h, mode: p.mode, bg: "#0d0d14",
    ...modeDefaults(p.mode, p.cooldownMs), keyHash: "", createdAt: Date.now(), createdBy: "system", system: true,
  };
  if (!(await getStore().createMeta(meta, DEFAULT_PALETTE))) return (await getStore().getMeta(id))!;
  if (p.seed) {
    const seed = p.seed();
    await getStore().commit(id, {
      n: p.w * p.h, full: seed, event: { kind: "system", t: Date.now(), text: "seeded from v1", full: seed },
      cost: 0, burst: 1, refillPerSec: 1, allowDebt: true, bucket: "system",
    });
  }
  return meta;
}

export async function ensurePresets() {
  await Promise.all(Object.keys(PRESETS).map((id) => getRoom(id).catch(() => null)));
}

export interface CreateInput {
  id?: unknown; title?: unknown; theme?: unknown; w?: unknown; h?: unknown; size?: unknown;
  mode?: unknown; palette?: unknown; key?: unknown; cooldownMs?: unknown; bg?: unknown;
  settings?: unknown; game?: unknown;
}

export async function createRoom(input: CreateInput, actor: Actor): Promise<RoomMeta & { ownerKey: string }> {
  const store = getStore();
  const id = String(input.id ?? "").toLowerCase().trim() || randomId();
  if (!ROOM_RE.test(id)) throw new HttpError(400, "bad_room", "room id must match [a-z0-9][a-z0-9-]{0,31}");
  if (PRESETS[id] || (await store.getMeta(id))) throw new HttpError(409, "room_exists", `room '${id}' already exists`);
  const n = await store.kvIncr(`wb:rl:create:${actor.ip}`, 3600000);
  if (n > 30) throw new HttpError(429, "too_many_rooms", "room creation limit: 30 per hour per IP", { retryMs: 600000 });

  let w = 32, h = 32;
  if (typeof input.size === "string" && /^\d+x\d+$/.test(input.size)) [w, h] = input.size.split("x").map(Number);
  else if (input.size !== undefined) w = h = Number(input.size);
  if (input.w !== undefined) w = Number(input.w);
  if (input.h !== undefined) h = Number(input.h);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 4 || h < 4 || w > MAX_SIDE || h > MAX_SIDE) {
    throw new HttpError(400, "bad_size", `w and h must be integers 4..${MAX_SIDE}`);
  }
  const mode = String(input.mode ?? "free") as Mode;
  if (!MODES.includes(mode)) throw new HttpError(400, "bad_mode", `mode must be one of ${MODES.join(", ")}`);

  let palette = DEFAULT_PALETTE;
  if (Array.isArray(input.palette) && input.palette.length) {
    const p = input.palette.map((c) => normHex(String(c)));
    if (p.some((c) => !c) || p.length > MAX_COLORS) throw new HttpError(400, "bad_palette", `palette must be 1..${MAX_COLORS} #rrggbb colors`);
    palette = [...new Set(p as string[])];
  }
  const bg = normHex(String(input.bg ?? "#0d0d14")) ?? "#0d0d14";
  const patch = { ...((input.settings as Record<string, unknown>) ?? {}), ...(input.game ? { game: input.game } : {}) };
  const settings = mergeSettings(DEFAULT_SETTINGS, patch);
  const ownerKey = "own_" + randomBytes(18).toString("base64url");
  const meta: RoomMeta = {
    id,
    title: String(input.title ?? id).slice(0, 60),
    theme: String(input.theme ?? "").slice(0, 500),
    w, h, mode, bg,
    ...modeDefaults(mode, input.cooldownMs !== undefined ? Number(input.cooldownMs) : undefined),
    keyHash: input.key ? sha(String(input.key)) : "",
    createdAt: Date.now(),
    createdBy: actor.name,
    ownerKeyHash: sha(ownerKey),
    settings,
  };
  if (!(await store.createMeta(meta, palette))) throw new HttpError(409, "room_exists", `room '${id}' already exists`);
  await store.commit(id, {
    n: w * h, full: EMPTY.repeat(w * h), event: { kind: "system", t: Date.now(), actor: actor.name, text: `room created by ${actor.name}`, full: EMPTY.repeat(w * h) },
    cost: 0, burst: 1, refillPerSec: 1, allowDebt: true, bucket: "system",
  });
  metaCache.delete(id);
  return { ...meta, ownerKey };
}

// Owner = holder of the owner key returned at creation, or the server admin.
export function isOwner(meta: RoomMeta, ownerKey: string | null, adminKey: string | null): boolean {
  if (adminKey && process.env.WB_ADMIN_KEY && adminKey === process.env.WB_ADMIN_KEY) return true;
  return !!ownerKey && !!meta.ownerKeyHash && sha(ownerKey) === meta.ownerKeyHash;
}

export async function updateSettings(id: string, patch: Record<string, unknown>, actor: Actor, ownerKey: string | null, adminKey: string | null) {
  const meta = await getStore().getMeta(id) ?? await getRoom(id);
  if (!isOwner(meta, ownerKey, adminKey)) {
    throw new HttpError(401, "not_owner", meta.ownerKeyHash
      ? "only the room owner can change settings (send X-WB-Owner with the owner key from room creation, or X-WB-Admin)"
      : "this built-in room is managed by the server admin (send X-WB-Admin)");
  }
  const next: RoomMeta = { ...meta, settings: mergeSettings(roomSettings(meta), patch) };
  if (typeof patch.title === "string") next.title = patch.title.slice(0, 60);
  if (typeof patch.theme === "string") next.theme = patch.theme.slice(0, 500);
  await getStore().putMeta(next);
  metaCache.delete(id);
  await commitEvent(next, actor, { kind: "meta", title: next.title, theme: next.theme, settings: publicSettings(next), text: "room settings changed" });
  return next;
}

export function publicSettings(meta: RoomMeta): RoomSettings {
  const s = roomSettings(meta);
  // the custom word list is the room's answer sheet: show only its size
  return { ...s, game: { ...s.game, custom: [] , ...( { customCount: s.game.custom.length } as object) } } as RoomSettings;
}

export async function updateRoom(id: string, patch: { title?: unknown; theme?: unknown; key?: unknown }, actor: Actor, key: string | null) {
  const meta = await getRoom(id);
  checkKey(meta, key);
  const next = { ...meta };
  if (patch.title !== undefined) next.title = String(patch.title).slice(0, 60);
  if (patch.theme !== undefined) next.theme = String(patch.theme).slice(0, 500);
  await getStore().putMeta(next);
  metaCache.delete(id);
  await commitEvent(next, actor, { kind: "meta", title: next.title, theme: next.theme });
  return next;
}

function randomId() {
  const a = ["neon", "rust", "void", "pixel", "glitch", "chrome", "ghost", "acid", "laser", "static"];
  const b = ["alley", "den", "lab", "yard", "vault", "pit", "deck", "loft", "dome", "grid"];
  return `${a[Math.floor(Math.random() * a.length)]}-${b[Math.floor(Math.random() * b.length)]}-${Math.floor(Math.random() * 900 + 100)}`;
}

export function checkKey(meta: RoomMeta, key: string | null) {
  if (!meta.keyHash) return;
  if (!key || sha(key) !== meta.keyHash) throw new HttpError(401, "unauthorized", "this room needs a write key (X-WB-Key header or 'key' field)");
}

// Owner-configured slowmode: one action of this type per `sec` seconds per name.
async function slowmode(meta: RoomMeta, actor: Actor, what: "chat" | "guess", sec: number) {
  if (!sec) return;
  const ms = Math.round(sec * 1000);
  const ok = await getStore().kvSet(`wb:{${meta.id}}:slow:${what}:${actor.name}`, String(Date.now() + ms), ms, true);
  if (!ok) {
    const until = Number(await getStore().kvGet(`wb:{${meta.id}}:slow:${what}:${actor.name}`)) || Date.now() + ms;
    throw new HttpError(429, "slowmode", `slowmode: one ${what} every ${sec} s in this room`, { retryMs: Math.max(100, until - Date.now()) });
  }
}

// A lost publish only delays live viewers (feeds repair gaps from the stream),
// so it must never fail a write that is already committed.
export async function safePublish(room: string, ev: WbEvent) {
  try { await getStore().publish(room, ev); } catch (e) { console.error("[wb] publish failed", (e as Error).message); }
}

// Commit a non-draw event (chat, meta, game) and publish it.
export async function commitEvent(meta: RoomMeta, actor: Actor | null, body: Omit<WbEvent, "t">, opts: { full?: string; nonce?: string } = {}) {
  const store = getStore();
  const ev: WbEvent = {
    t: Date.now(), ...(actor ? { actor: actor.name, actorKind: actor.kind } : {}), ...body,
    ...(opts.full !== undefined ? { full: opts.full } : {}),
  } as WbEvent;
  const res = await store.commit(meta.id, {
    n: meta.w * meta.h, full: opts.full, event: ev, nonce: opts.nonce,
    cost: 0, burst: 1, refillPerSec: 1, allowDebt: true, bucket: actor?.name ?? "system",
  });
  if (res.status === "ok") {
    await safePublish(meta.id, { ...ev, seq: res.seq });
    store.touch(meta.id).catch(() => {});
  }
  return res;
}

export interface ActInput { ops?: unknown; nonce?: unknown }

export interface ActResult {
  ok: boolean;
  seq: number;
  changed: number;
  duplicate?: boolean;
  results: Record<string, unknown>[];
}

const NONCE_RE = /^[A-Za-z0-9._:-]{8,80}$/;

export async function act(roomId: string, actor: Actor, input: ActInput, key: string | null): Promise<ActResult> {
  const store = getStore();
  const meta = await getRoom(roomId);
  checkKey(meta, key);
  if (!Array.isArray(input.ops) || input.ops.length === 0) throw new HttpError(400, "bad_ops", "body must contain ops: [ {op: ...}, ... ]");
  if (input.ops.length > MAX_OPS) throw new HttpError(400, "too_many_ops", `max ${MAX_OPS} ops per request`);
  const nonce = input.nonce === undefined || input.nonce === null ? undefined : String(input.nonce);
  if (nonce !== undefined && !NONCE_RE.test(nonce)) throw new HttpError(400, "bad_nonce", "nonce must be 8-80 chars of [A-Za-z0-9._:-]");

  if (meta.mode === "guess") await endRoundIfExpired(meta);

  const ops = input.ops as (Op | { op: string; [k: string]: unknown })[];
  const drawOps = ops.filter((o) => DRAW_OPS.includes(String(o?.op))) as Op[];
  const otherOps = ops.filter((o) => !DRAW_OPS.includes(String(o?.op)));
  for (const o of otherOps) {
    if (!["chat", "game", "status", "guess"].includes(String(o?.op))) {
      throw new HttpError(400, "unknown_op", `unknown op '${o?.op}'. Draw ops: ${DRAW_OPS.join(", ")}. Other ops: chat, guess, game, status`);
    }
  }

  const results: Record<string, unknown>[] = [];
  let seq = 0;
  let changed = 0;
  let commitIdx = 0;
  const nextNonce = () => (nonce ? (commitIdx++ === 0 ? nonce : `${nonce}.${commitIdx}`) : undefined);

  // ---- drawing -----------------------------------------------------------
  if (drawOps.length) {
    if (meta.mode === "place") {
      const bulk = drawOps.find((o) => BULK_OPS.has(o.op));
      if (bulk) throw new HttpError(403, "disabled_in_place_mode", `'${bulk.op}' is disabled in place mode. Paint single pixels.`);
    }
    await gameGuard(meta, actor);
    if (drawOps.some((o) => o?.op === "life")) {
      const ok = await store.kvSet(`wb:{${meta.id}}:lifetick`, "1", 350, true);
      if (!ok) throw new HttpError(429, "life_throttled", "someone just stepped life; try again in a moment", { retryMs: 350 });
    }
    const n = meta.w * meta.h;
    const raster = (board: string, palette: string[]) => {
      try { return applyOps(board, meta.w, meta.h, drawOps, palette); } catch (e) {
        if (e instanceof OpError) throw new HttpError(400, "bad_op", e.message);
        throw e;
      }
    };
    const hexes = collectHexes(drawOps);
    let done = false;
    for (let attempt = 0; attempt < 6 && !done; attempt++) {
      const snap = await store.snapshot(meta.id, n);
      let palette = snap.palette;
      let paletteChanged = false;
      const fresh = hexes.filter((h) => !palette.includes(h));
      if (fresh.length) {
        // validate against the palette we are about to have BEFORE touching it,
        // so a rejected request never leaks colors into the room palette
        const trial = raster(snap.board, [...palette, ...fresh].slice(0, MAX_COLORS));
        if (meta.mode === "place" && trial.touched.size > meta.burst) {
          throw new HttpError(429, "place_limit", `place mode: at most ${meta.burst} pixel(s) per ${meta.cooldownMs} ms`, { retryMs: meta.cooldownMs });
        }
        palette = await store.addColors(meta.id, fresh);
        paletteChanged = palette.length !== snap.palette.length;
      }
      const r = raster(snap.board, palette);
      const cost = Math.max(r.touched.size, drawOps.some((o) => o.op === "life") ? 1 : 0);
      if (meta.mode === "place" && cost > meta.burst) {
        throw new HttpError(429, "place_limit", `place mode: at most ${meta.burst} pixel(s) per ${meta.cooldownMs} ms`, { retryMs: meta.cooldownMs });
      }
      if (r.touched.size === 0 && !paletteChanged) {
        // nothing to write: still burn the nonce so replays are rejected (v1 semantics)
        const nn = nextNonce();
        if (nn && !(await store.kvSet(nonceKey(meta.id, nn), "0", NONCE_TTL_MS, true))) {
          return { ok: true, duplicate: true, seq: snap.seq, changed: 0, results: [{ op: "draw", duplicate: true }] };
        }
        results.push({ op: "draw", ops: r.summary.length, changed: 0 });
        done = true;
        break;
      }
      // Ops that read the board (flood, life, ...) and full-board writes are
      // compare-and-set on seq, so they never overwrite a concurrent stroke.
      // Pure paint ops commit exactly the cells they touched and need no lock.
      const useFull = r.touched.size > n / 6;
      const cas = r.readsBoard || useFull;
      const changes = new Map<number, string>();
      let maxSlot = -1;
      r.touched.forEach((i) => {
        const ch = r.board[i];
        if (!useFull) changes.set(i, ch);
        const slot = ALPHABET.indexOf(ch);
        if (slot > maxSlot) maxSlot = slot;
      });
      const full = useFull ? r.board.join("") : undefined;
      const stored: WbEvent = {
        t: Date.now(), kind: "draw", actor: actor.name, actorKind: actor.kind, ops: [...new Set(r.summary)].join(","), n: r.touched.size,
        pl: palette.length,
        ...(paletteChanged || maxSlot >= DEFAULT_PALETTE.length ? { palette } : {}),
        ...(useFull ? { full } : { d: [...changes].map(([i, c]) => `${i}:${c}`).join(",") }),
      };
      const res = await store.commit(meta.id, {
        n, changes: useFull ? undefined : changes, full, event: stored, nonce: nonce ? (commitIdx === 0 ? nonce : `${nonce}.${commitIdx}`) : undefined,
        cost, burst: meta.burst, refillPerSec: meta.refillPerSec, allowDebt: meta.mode !== "place",
        bucket: actor.name, ipBucket: actor.ip, expectSeq: cas ? snap.seq : undefined,
      });
      if (res.status === "conflict") { await new Promise((ok) => setTimeout(ok, 5 + Math.random() * 20 * (attempt + 1))); continue; }
      commitIdx++;
      if (res.status === "dup") return { ok: true, duplicate: true, seq: res.seq, changed: 0, results: [{ op: "draw", duplicate: true }] };
      if (res.status === "limited") {
        throw new HttpError(429, "rate_limited", `slow down: wait ${res.retryMs} ms (bucket ${meta.burst} px, refill ${Math.round(meta.refillPerSec * 100) / 100} px/s per name)`, { retryMs: res.retryMs });
      }
      seq = res.seq;
      changed = r.changed.size;
      await safePublish(meta.id, { ...stored, seq });
      store.touch(meta.id).catch(() => {});
      results.push({ op: "draw", ops: r.summary.length, changed: r.changed.size, touched: r.touched.size });
      done = true;
    }
    if (!done) throw new HttpError(409, "busy", "the board is changing too fast for this op; retry", { retryMs: 100 });
  }

  // ---- chat / game / status -----------------------------------------------
  for (const o of otherOps) {
    if (o.op === "chat" || o.op === "guess") {
      const textIn = String((o as { text?: unknown; word?: unknown }).text ?? (o as { word?: unknown }).word ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 280);
      if (!textIn) throw new HttpError(400, "empty_text", `${o.op}.text is empty`);
      const cfg = roomSettings(meta);
      if (o.op === "guess") {
        // private guess: never shown to anyone, answered only to the caller
        if (meta.mode !== "guess") throw new HttpError(400, "not_a_game_room", "guess only works in rooms with mode 'guess'");
        await slowmode(meta, actor, "guess", cfg.guessSlowSec[actor.kind]);
        const r = await checkGuess(meta, actor, textIn, false);
        results.push({ op: "guess", ...r });
        continue;
      }
      await slowmode(meta, actor, "chat", cfg.chatSlowSec[actor.kind]);
      const burst = await store.kvIncr(`wb:{${meta.id}}:chat:${actor.name}`, 10000);
      if (burst > 15) throw new HttpError(429, "chat_flood", "max 15 chat messages per 10 s", { retryMs: 3000 });
      const ipBurst = await store.kvIncr(`wb:{${meta.id}}:chatip:${actor.ip}`, 10000);
      const ipMax = 15 * Math.max(1, Number(process.env.WB_IP_MULT ?? 8));
      if (ipBurst > ipMax) throw new HttpError(429, "chat_flood", `too many chat messages from your network (${ipMax} per 10 s)`, { retryMs: 3000 });
      // in a running round, a chat line that hits or nearly hits the word is
      // treated as a private guess, so it never leaks the answer to the room
      const g = meta.mode === "guess" ? await checkGuess(meta, actor, textIn, true) : null;
      if (g) { results.push({ op: "chat", swallowed: true, ...g }); continue; }
      const res = await commitEvent(meta, actor, { kind: "chat", text: textIn }, { nonce: nextNonce() });
      if (res.status === "ok") seq = res.seq;
      results.push({ op: "chat", ok: true });
    } else if (o.op === "status") {
      const status = String((o as { text?: unknown }).text ?? "").slice(0, 80);
      await store.presencePut(meta.id, { name: actor.name, kind: actor.kind, t: Date.now(), status });
      await store.publish(meta.id, { kind: "presence", t: Date.now(), actor: actor.name, actorKind: actor.kind, status });
      results.push({ op: "status", ok: true });
    } else if (o.op === "game") {
      const action = String((o as { action?: unknown }).action ?? "status");
      if (meta.mode !== "guess") throw new HttpError(400, "not_a_game_room", "game ops only work in rooms with mode 'guess'");
      if (action === "start") results.push({ op: "game", ...(await startRound(meta, actor)) });
      else if (action === "pick") results.push({ op: "game", ...(await pickWord(meta, actor, (o as { word?: unknown }).word)) });
      else if (action === "guess") {
        await slowmode(meta, actor, "guess", roomSettings(meta).guessSlowSec[actor.kind]);
        results.push({ op: "game", ...(await checkGuess(meta, actor, String((o as { word?: unknown }).word ?? ""), false)) });
      }
      else if (action === "skip") results.push({ op: "game", ...(await skipRound(meta, actor)) });
      else results.push({ op: "game", ...(await gameView(meta, actor)) });
    }
  }

  // any successful write counts as presence
  store.presencePut(meta.id, { name: actor.name, kind: actor.kind, t: Date.now() }).catch(() => {});
  if (!seq) seq = (await store.range(meta.id, Number.MAX_SAFE_INTEGER - 1, 1)).head;
  return { ok: true, seq, changed, results };
}
