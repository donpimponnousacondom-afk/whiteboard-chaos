// "guess" mode: Pictionary for humans and agents.
//  - game start  : caller becomes drawer, board is wiped, secret word returned ONLY to the drawer
//  - during round: only the drawer can paint; everyone else guesses via chat
//  - correct guess: guesser +2, drawer +1, word revealed, round ends
//  - timeout     : word revealed, nobody scores
import { HttpError } from "./http";
import { commitEvent } from "./rooms";
import { getStore } from "./store";
import type { Actor, RoomMeta } from "./types";
import { WORDS } from "./words";

export const ROUND_MS = 150_000;

interface GameState {
  status: "idle" | "active";
  round: number;
  drawer?: string;
  word?: string;
  startedAt?: number;
  endsAt?: number;
  lastWord?: string;
  lastWinner?: string | null;
}

const key = (room: string) => `wb:{${room}}:game`;

async function load(room: string): Promise<GameState> {
  const raw = await getStore().kvGet(key(room));
  return raw ? JSON.parse(raw) : { status: "idle", round: 0 };
}

async function save(room: string, s: GameState) {
  await getStore().kvSet(key(room), JSON.stringify(s));
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

export function hint(word: string, startedAt: number, endsAt: number, now = Date.now()): string {
  const frac = (now - startedAt) / (endsAt - startedAt);
  const reveal = new Set<number>();
  if (frac > 0.5) reveal.add(0);
  if (frac > 0.75 && word.length > 3) reveal.add(Math.floor(word.length / 2));
  return [...word].map((c, i) => (reveal.has(i) ? c : "_")).join(" ");
}

export async function endRoundIfExpired(meta: RoomMeta) {
  const s = await load(meta.id);
  if (s.status !== "active" || !s.endsAt || Date.now() < s.endsAt) return;
  const first = await getStore().kvSet(`wb:{${meta.id}}:ended:${s.round}`, "1", 3600000, true);
  if (!first) return;
  await save(meta.id, { status: "idle", round: s.round, lastWord: s.word, lastWinner: null });
  await commitEvent(meta, null, { kind: "game", phase: "timeout", round: s.round, drawer: s.drawer, word: s.word, text: `time's up! the word was "${s.word}"` });
}

export async function gameGuard(meta: RoomMeta, actor: Actor) {
  if (meta.mode !== "guess") return;
  const s = await load(meta.id);
  if (s.status === "active" && s.drawer !== actor.name) {
    throw new HttpError(403, "not_drawer", `round ${s.round} is live and ${s.drawer} is drawing. Guess with a chat op instead.`);
  }
}

export async function startRound(meta: RoomMeta, actor: Actor) {
  await endRoundIfExpired(meta);
  const store = getStore();
  const s = await load(meta.id);
  if (s.status === "active") throw new HttpError(409, "round_active", `round ${s.round} is running (drawer: ${s.drawer})`);
  const lock = await store.kvSet(`wb:{${meta.id}}:gamelock`, actor.name, 2000, true);
  if (!lock) throw new HttpError(409, "round_starting", "someone else is starting a round");
  const word = WORDS[Math.floor(Math.random() * WORDS.length)];
  const now = Date.now();
  const next: GameState = { status: "active", round: s.round + 1, drawer: actor.name, word, startedAt: now, endsAt: now + ROUND_MS, lastWord: s.lastWord, lastWinner: s.lastWinner };
  await save(meta.id, next);
  await commitEvent(meta, actor, {
    kind: "game", phase: "start", round: next.round, drawer: actor.name, hint: hint(word, now, next.endsAt!), endsAt: next.endsAt, len: word.length,
    text: `${actor.name} is drawing a ${word.length}-letter word. Guess in chat!`,
  }, { full: ".".repeat(meta.w * meta.h) });
  return {
    ok: true, round: next.round, youAreDrawer: true, word, endsAt: next.endsAt,
    instructions: `Draw "${word}" on the ${meta.w}x${meta.h} board. Do NOT write the word or its letters. Others guess in chat. Round ends in ${ROUND_MS / 1000}s.`,
  };
}

export async function skipRound(meta: RoomMeta, actor: Actor) {
  const s = await load(meta.id);
  if (s.status !== "active") return { ok: true, status: "idle" };
  if (s.drawer !== actor.name && Date.now() < (s.endsAt ?? 0)) throw new HttpError(403, "not_drawer", "only the drawer can skip a running round");
  const first = await getStore().kvSet(`wb:{${meta.id}}:ended:${s.round}`, "1", 3600000, true);
  if (first) {
    await save(meta.id, { status: "idle", round: s.round, lastWord: s.word, lastWinner: null });
    await commitEvent(meta, actor, { kind: "game", phase: "skip", round: s.round, drawer: s.drawer, word: s.word, text: `${actor.name} skipped. the word was "${s.word}"` });
  }
  return { ok: true, status: "idle", word: s.word };
}

export async function handleChatForGame(meta: RoomMeta, actor: Actor, text: string): Promise<{ swallowed: boolean; result?: Record<string, unknown>; seq?: number } | null> {
  const s = await load(meta.id);
  if (s.status !== "active" || !s.word) return null;
  const guess = norm(text), word = norm(s.word);
  if (actor.name === s.drawer) {
    if (guess.includes(word)) throw new HttpError(400, "no_spoilers", "the drawer cannot say the word");
    return null;
  }
  if (guess === word) {
    const first = await getStore().kvSet(`wb:{${meta.id}}:ended:${s.round}`, "1", 3600000, true);
    if (!first) return { swallowed: true, result: { correct: true, late: true, message: "correct, but someone was faster" } };
    await save(meta.id, { status: "idle", round: s.round, lastWord: s.word, lastWinner: actor.name });
    await getStore().scoreAdd(meta.id, actor.name, 2);
    if (s.drawer) await getStore().scoreAdd(meta.id, s.drawer, 1);
    const res = await commitEvent(meta, actor, {
      kind: "game", phase: "win", round: s.round, drawer: s.drawer, winner: actor.name, word: s.word,
      text: `${actor.name} guessed "${s.word}"! +2 ${actor.name}, +1 ${s.drawer}`,
    });
    return { swallowed: true, result: { correct: true, word: s.word, points: 2 }, seq: res.status === "ok" ? res.seq : undefined };
  }
  if (word.length >= 4 && lev(guess, word) <= 1) return { swallowed: false, result: { correct: false, close: true, message: "so close!" } };
  return { swallowed: false, result: { correct: false } };
}

export async function gameView(meta: RoomMeta, actor: Actor | null) {
  if (meta.mode !== "guess") return { status: "n/a", mode: meta.mode };
  await endRoundIfExpired(meta);
  const s = await load(meta.id);
  const scores = await getStore().scoreTop(meta.id, 10);
  const base = { status: s.status, round: s.round, lastWord: s.lastWord ?? null, lastWinner: s.lastWinner ?? null, scores, now: Date.now(), roundMs: ROUND_MS };
  if (s.status !== "active" || !s.word) return base;
  const isDrawer = !!actor && actor.name === s.drawer;
  return {
    ...base, drawer: s.drawer, endsAt: s.endsAt, startedAt: s.startedAt, len: s.word.length,
    hint: hint(s.word, s.startedAt!, s.endsAt!), youAreDrawer: isDrawer, ...(isDrawer ? { word: s.word } : {}),
  };
}
