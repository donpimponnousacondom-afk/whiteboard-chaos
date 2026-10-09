// "guess" mode: Pictionary for humans and agents.
//
//  start   : caller becomes the drawer. With choices > 1 the drawer gets 3 or 5
//            words (only they see them) and picks one ("choosing" phase, 20 s,
//            then the first word is picked automatically).
//  active  : the board is wiped, only the drawer paints. Everyone else guesses:
//            privately with the `guess` op (never shown to anyone), or in chat.
//            Chat that is correct or close is swallowed too, so near misses and
//            typos never give the word away.
//  scoring : guesser gets 50 + up to 100 for speed, +20 for being first. The
//            drawer gets 25 per correct guesser. After the first correct guess
//            at most 30 s remain. The round ends when time is up or everyone
//            present has guessed.
//  words   : each room draws from a shuffled deck built from its word bag, so
//            no word repeats until the whole deck has been used.
import { HttpError } from "./http";
import { commitEvent } from "./rooms";
import { roomSettings } from "./settings";
import { getStore } from "./store";
import type { Actor, RoomMeta } from "./types";
import { bankWords } from "./words";

const CHOOSE_MS = 20_000;
const AFTER_FIRST_MS = 30_000;

interface Guessed { name: string; pts: number; at: number }

interface GameState {
  status: "idle" | "choosing" | "active";
  round: number;
  drawer?: string;
  options?: string[];
  chooseUntil?: number;
  word?: string;
  startedAt?: number;
  endsAt?: number;
  roundMs?: number;
  guessed?: Guessed[];
  lastWord?: string;
  lastWinners?: string[];
}

const key = (room: string) => `wb:{${room}}:game`;
const deckKey = (room: string) => `wb:{${room}}:deck`;

async function load(room: string): Promise<GameState> {
  const raw = await getStore().kvGet(key(room));
  return raw ? (JSON.parse(raw) as GameState) : { status: "idle", round: 0 };
}

async function save(room: string, s: GameState) {
  await getStore().kvSet(key(room), JSON.stringify(s));
}

// Small per-room mutex so concurrent guesses or starts cannot overwrite each other.
async function withLock<T>(room: string, fn: () => Promise<T>): Promise<T> {
  const k = `wb:{${room}}:glock`;
  const id = Math.random().toString(36).slice(2);
  for (let i = 0; i < 40; i++) {
    if (await getStore().kvSet(k, id, 3000, true)) {
      try { return await fn(); } finally { if ((await getStore().kvGet(k)) === id) await getStore().kvDel(k); }
    }
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
  }
  throw new HttpError(409, "game_busy", "the game is busy, try again");
}

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

// "_ _ _   _ _ _" with letters revealed at 40 %, 60 % and 80 % of the round.
export function hint(word: string, startedAt: number, endsAt: number, now = Date.now()): string {
  const frac = Math.min(1, (now - startedAt) / Math.max(1, endsAt - startedAt));
  const letters = [...word].map((c, i) => ({ c, i })).filter((x) => /[a-z]/i.test(x.c));
  const reveal = new Set<number>();
  const steps = [0.4, 0.6, 0.8].filter((t) => frac >= t).length;
  // deterministic positions so everyone sees the same hint
  for (let k = 0; k < steps && k < letters.length - 1; k++) reveal.add(letters[(k * 7 + word.length * 3) % letters.length].i);
  return [...word].map((c, i) => (c === " " ? " " : reveal.has(i) ? c : "_")).join(" ");
}

function wordBag(meta: RoomMeta): string[] {
  const g = roomSettings(meta).game;
  const own = g.custom ?? [];
  const bag = g.customOnly ? own : [...new Set([...bankWords(g.categories, g.difficulty), ...own])];
  return bag.length ? bag : bankWords(undefined, "mixed");
}

// Draw n different words from the room's shuffled deck. The deck is rebuilt
// when it runs low or when the room's word bag changed.
async function drawWords(meta: RoomMeta, n: number): Promise<string[]> {
  const bag = wordBag(meta);
  const sig = `${bag.length}:${bag.slice(0, 5).join("|")}`;
  const raw = await getStore().kvGet(deckKey(meta.id));
  let deck: { sig: string; words: string[] } = raw ? JSON.parse(raw) : { sig: "", words: [] };
  if (deck.sig !== sig || deck.words.length < n) {
    const fresh = [...bag];
    for (let i = fresh.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [fresh[i], fresh[j]] = [fresh[j], fresh[i]]; }
    // keep the leftovers of the old deck at the front so they still come up first
    deck = { sig, words: deck.sig === sig ? [...deck.words, ...fresh.filter((w) => !deck.words.includes(w))] : fresh };
  }
  const out = deck.words.splice(0, Math.min(n, deck.words.length));
  await getStore().kvSet(deckKey(meta.id), JSON.stringify(deck));
  return out;
}

async function activate(meta: RoomMeta, s: GameState, word: string, actor: Actor | null) {
  const now = Date.now();
  const roundMs = roomSettings(meta).game.roundSec * 1000;
  const next: GameState = { ...s, status: "active", word, options: undefined, chooseUntil: undefined, startedAt: now, endsAt: now + roundMs, roundMs, guessed: [] };
  await save(meta.id, next);
  await commitEvent(meta, actor, {
    kind: "game", phase: "start", round: next.round, drawer: next.drawer, hint: hint(word, now, next.endsAt!), endsAt: next.endsAt, len: word.length,
    text: `${next.drawer} is drawing (${word.split(" ").map((w) => w.length).join("+")} letters). Guess with the guess box!`,
  }, { full: ".".repeat(meta.w * meta.h) });
  return next;
}

async function finish(meta: RoomMeta, s: GameState, reason: "timeout" | "all" | "skip", by: Actor | null) {
  const winners = (s.guessed ?? []).map((g) => g.name);
  await save(meta.id, { status: "idle", round: s.round, lastWord: s.word, lastWinners: winners });
  const text = reason === "skip" ? `${by?.name ?? "someone"} ended the round. The word was "${s.word}"`
    : winners.length ? `round over! the word was "${s.word}". ${winners.length} guessed it: ${winners.join(", ")}`
    : `time's up! nobody got "${s.word}"`;
  await commitEvent(meta, null, { kind: "game", phase: "end", reason, round: s.round, drawer: s.drawer, word: s.word, winners, text });
}

// Lazy clock: called on every game interaction. Moves expired phases forward.
export async function tickGame(meta: RoomMeta) {
  if (meta.mode !== "guess") return;
  const s0 = await load(meta.id);
  const now = Date.now();
  const due = (s0.status === "choosing" && now > (s0.chooseUntil ?? 0)) || (s0.status === "active" && now > (s0.endsAt ?? 0));
  if (!due) return;
  await withLock(meta.id, async () => {
    const s = await load(meta.id);
    if (s.status === "choosing" && Date.now() > (s.chooseUntil ?? 0)) await activate(meta, s, s.options?.[0] ?? (await drawWords(meta, 1))[0], null);
    else if (s.status === "active" && Date.now() > (s.endsAt ?? 0)) await finish(meta, s, "timeout", null);
  });
}

export const endRoundIfExpired = tickGame;

export async function gameGuard(meta: RoomMeta, actor: Actor) {
  if (meta.mode !== "guess") return;
  const s = await load(meta.id);
  if ((s.status === "active" || s.status === "choosing") && s.drawer !== actor.name) {
    throw new HttpError(403, "not_drawer", `${s.drawer} is drawing right now. Guess with the guess op (wb guess WORD) instead.`);
  }
}

export async function startRound(meta: RoomMeta, actor: Actor) {
  await tickGame(meta);
  return withLock(meta.id, async () => {
    const s = await load(meta.id);
    if (s.status !== "idle") throw new HttpError(409, "round_active", `round ${s.round} is running (drawer: ${s.drawer})`);
    const n = roomSettings(meta).game.choices;
    const options = await drawWords(meta, n);
    const base: GameState = { status: "choosing", round: s.round + 1, drawer: actor.name, lastWord: s.lastWord, lastWinners: s.lastWinners };
    if (options.length <= 1) {
      const st = await activate(meta, base, options[0], actor);
      return { ok: true, round: st.round, youAreDrawer: true, word: st.word, endsAt: st.endsAt, instructions: drawInstructions(meta, st.word!) };
    }
    const st: GameState = { ...base, options, chooseUntil: Date.now() + CHOOSE_MS };
    await save(meta.id, st);
    await commitEvent(meta, actor, { kind: "game", phase: "choosing", round: st.round, drawer: actor.name, chooseUntil: st.chooseUntil, text: `${actor.name} is choosing a word...` });
    return {
      ok: true, round: st.round, youAreDrawer: true, options, chooseUntil: st.chooseUntil,
      instructions: `Pick one: ${options.map((w, i) => `${i + 1}) ${w}`).join("  ")}. Send {op:"game", action:"pick", word:"<word or number>"} (wb game pick 2) within 20 s, or the first one is picked for you.`,
    };
  });
}

function drawInstructions(meta: RoomMeta, word: string) {
  return `Draw "${word}" on the ${meta.w}x${meta.h} board. No letters, no numbers. Others guess privately. Round ends in ${roomSettings(meta).game.roundSec} s.`;
}

export async function pickWord(meta: RoomMeta, actor: Actor, choice: unknown) {
  await tickGame(meta);
  return withLock(meta.id, async () => {
    const s = await load(meta.id);
    if (s.status !== "choosing" || !s.options) throw new HttpError(409, "not_choosing", "there is no word to pick right now");
    if (s.drawer !== actor.name) throw new HttpError(403, "not_drawer", "only the drawer picks the word");
    const c = String(choice ?? "").trim().toLowerCase();
    const idx = /^\d+$/.test(c) ? Number(c) - 1 : s.options.findIndex((w) => w === c);
    if (idx < 0 || idx >= s.options.length) throw new HttpError(400, "bad_pick", `pick one of: ${s.options.map((w, i) => `${i + 1}) ${w}`).join(", ")}`);
    const st = await activate(meta, s, s.options[idx], actor);
    return { ok: true, round: st.round, youAreDrawer: true, word: st.word, endsAt: st.endsAt, instructions: drawInstructions(meta, st.word!) };
  });
}

export async function skipRound(meta: RoomMeta, actor: Actor) {
  return withLock(meta.id, async () => {
    const s = await load(meta.id);
    if (s.status === "idle") return { ok: true, status: "idle" };
    const late = s.status === "active" ? Date.now() > (s.endsAt ?? 0) : Date.now() > (s.chooseUntil ?? 0);
    if (s.drawer !== actor.name && !late) throw new HttpError(403, "not_drawer", "only the drawer can end a running round");
    if (s.status === "choosing") {
      await save(meta.id, { status: "idle", round: s.round, lastWord: s.lastWord, lastWinners: s.lastWinners });
      await commitEvent(meta, actor, { kind: "game", phase: "end", reason: "skip", round: s.round, text: `${actor.name} passed. Anyone can start the next round.` });
      return { ok: true, status: "idle" };
    }
    await finish(meta, s, "skip", actor);
    return { ok: true, status: "idle", word: s.word };
  });
}

export interface GuessResult { correct: boolean; close?: boolean; points?: number; already?: boolean; message: string; guessesLeft?: number | null }

// Check a guess. `fromChat` = it came from a chat message.
// Returns null when the text should go to chat as a normal message.
export async function checkGuess(meta: RoomMeta, actor: Actor, text: string, fromChat: boolean): Promise<GuessResult | null> {
  await tickGame(meta);
  const s0 = await load(meta.id);
  if (s0.status !== "active" || !s0.word) {
    if (fromChat) return null;
    throw new HttpError(409, "no_round", s0.status === "choosing" ? `${s0.drawer} is still choosing a word` : "no round is running. Start one with the game op (wb game start)");
  }
  const guess = norm(text), word = norm(s0.word);
  if (actor.name === s0.drawer) {
    if (guess.includes(word)) throw new HttpError(400, "no_spoilers", "the drawer cannot say the word");
    if (fromChat) return null;
    throw new HttpError(400, "you_are_drawing", "you are the drawer: draw, don't guess");
  }
  if (s0.guessed?.some((g) => g.name === actor.name)) {
    if (guess.includes(word)) throw new HttpError(400, "no_spoilers", "you already guessed it: don't tell the others");
    if (fromChat) return null;
    return { correct: true, already: true, message: "you already guessed this one" };
  }
  const isHit = guess === word;
  const isClose = !isHit && word.length >= 4 && lev(guess, word) <= 1;
  // a far-off chat line is just chat
  if (fromChat && !isHit && !isClose) return null;

  // per-round guess cap (chat lines only count when they hit or nearly hit)
  const st = roomSettings(meta);
  let left: number | null = null;
  if (st.maxGuessesPerRound > 0) {
    const used = await getStore().kvIncr(`wb:{${meta.id}}:gc:${s0.round}:${actor.name}`, 3600_000);
    left = Math.max(0, st.maxGuessesPerRound - used);
    if (used > st.maxGuessesPerRound) throw new HttpError(429, "out_of_guesses", `you used all ${st.maxGuessesPerRound} guesses for this round`, { retryMs: Math.max(1000, (s0.endsAt ?? 0) - Date.now()) });
  }
  if (!isHit) return { correct: false, close: isClose, message: isClose ? "so close! check the spelling" : "nope", guessesLeft: left };

  return withLock(meta.id, async () => {
    const s = await load(meta.id);
    if (s.status !== "active" || norm(s.word ?? "") !== word) return { correct: false, message: "too late, the round just ended" };
    if (s.guessed?.some((g) => g.name === actor.name)) return { correct: true, already: true, message: "you already guessed this one" };
    const now = Date.now();
    const frac = Math.max(0, ((s.endsAt ?? now) - now) / (s.roundMs ?? 120_000));
    const first = !(s.guessed?.length);
    const pts = Math.round(50 + 100 * frac) + (first ? 20 : 0);
    s.guessed = [...(s.guessed ?? []), { name: actor.name, pts, at: now }];
    if (first && (s.endsAt ?? 0) - now > AFTER_FIRST_MS) s.endsAt = now + AFTER_FIRST_MS;
    await getStore().scoreAdd(meta.id, actor.name, pts);
    if (s.drawer) await getStore().scoreAdd(meta.id, s.drawer, 25);
    // everyone present (seen in the last 60 s, minus the drawer) guessed -> end now
    const present = (await getStore().presenceList(meta.id, 60_000)).filter((p) => p.name !== s.drawer).map((p) => p.name);
    const all = present.length > 0 && present.every((n) => s.guessed!.some((g) => g.name === n));
    await save(meta.id, s);
    await commitEvent(meta, null, {
      kind: "game", phase: "guess", round: s.round, guesser: actor.name, points: pts, endsAt: s.endsAt, guessedCount: s.guessed.length,
      text: `${actor.name} guessed the word! +${pts}${first ? " (first!)" : ""}${first && s.endsAt === now + AFTER_FIRST_MS ? ". 30 seconds left" : ""}`,
    });
    if (all) await finish(meta, s, "all", null);
    return { correct: true, points: pts, message: `correct! the word is "${s.word}". +${pts}. Don't tell the others`, guessesLeft: left };
  });
}

export async function gameView(meta: RoomMeta, actor: Actor | null) {
  if (meta.mode !== "guess") return { status: "n/a", mode: meta.mode };
  await tickGame(meta);
  const s = await load(meta.id);
  const scores = await getStore().scoreTop(meta.id, 10);
  const cfg = roomSettings(meta);
  const base = {
    status: s.status, round: s.round, lastWord: s.lastWord ?? null, lastWinners: s.lastWinners ?? [], scores, now: Date.now(),
    roundSec: cfg.game.roundSec, choices: cfg.game.choices, maxGuessesPerRound: cfg.maxGuessesPerRound,
  };
  if (s.status === "idle") return base;
  const isDrawer = !!actor && actor.name === s.drawer;
  if (s.status === "choosing") {
    return { ...base, drawer: s.drawer, chooseUntil: s.chooseUntil, youAreDrawer: isDrawer, ...(isDrawer ? { options: s.options } : {}) };
  }
  const youGuessed = !!actor && !!s.guessed?.some((g) => g.name === actor.name);
  return {
    ...base, drawer: s.drawer, endsAt: s.endsAt, startedAt: s.startedAt, len: s.word?.length,
    hint: hint(s.word!, s.startedAt!, s.endsAt!), guessed: s.guessed ?? [], youAreDrawer: isDrawer, youGuessed,
    ...(isDrawer || youGuessed ? { word: s.word } : {}),
  };
}

// Back-compat name used by older code paths.
export async function handleChatForGame(meta: RoomMeta, actor: Actor, text: string) {
  const r = await checkGuess(meta, actor, text, true);
  if (!r) return null;
  return { swallowed: true, result: r as unknown as Record<string, unknown> };
}
