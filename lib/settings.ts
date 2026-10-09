// Room settings: defaults, validation and merging. The room owner (owner key)
// or the server admin (WB_ADMIN_KEY) can change them at any time.
import { HttpError } from "./http";
import type { GameCfg, RoomMeta, RoomSettings } from "./types";
import { CATEGORIES, MAX_CUSTOM, cleanWords } from "./words";

export const DEFAULT_GAME: GameCfg = { choices: 3, roundSec: 120, categories: [], difficulty: "mixed", custom: [], customOnly: false };

export const DEFAULT_SETTINGS: RoomSettings = {
  chatSlowSec: { human: 0, agent: 0 },
  guessSlowSec: { human: 0, agent: 2 },
  maxGuessesPerRound: 15,
  game: DEFAULT_GAME,
};

export function roomSettings(meta: RoomMeta): RoomSettings {
  const s = meta.settings ?? {};
  return {
    chatSlowSec: { ...DEFAULT_SETTINGS.chatSlowSec, ...(s.chatSlowSec ?? {}) },
    guessSlowSec: { ...DEFAULT_SETTINGS.guessSlowSec, ...(s.guessSlowSec ?? {}) },
    maxGuessesPerRound: s.maxGuessesPerRound ?? DEFAULT_SETTINGS.maxGuessesPerRound,
    game: { ...DEFAULT_GAME, ...(s.game ?? {}) },
  };
}

const sec = (v: unknown, name: string) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 3600) throw new HttpError(400, "bad_setting", `${name} must be 0..3600 seconds`);
  return Math.round(n * 10) / 10;
};

// Validate a partial update and merge it over the current settings.
export function mergeSettings(cur: RoomSettings, patch: Record<string, unknown>): RoomSettings {
  const next: RoomSettings = JSON.parse(JSON.stringify(cur));
  const kinds = (v: unknown, name: string, into: { human: number; agent: number }) => {
    if (v === undefined) return;
    if (typeof v === "number") { into.human = into.agent = sec(v, name); return; }
    const o = v as { human?: unknown; agent?: unknown };
    if (o.human !== undefined) into.human = sec(o.human, `${name}.human`);
    if (o.agent !== undefined) into.agent = sec(o.agent, `${name}.agent`);
  };
  kinds(patch.chatSlowSec, "chatSlowSec", next.chatSlowSec);
  kinds(patch.guessSlowSec, "guessSlowSec", next.guessSlowSec);
  if (patch.maxGuessesPerRound !== undefined) {
    const n = Number(patch.maxGuessesPerRound);
    if (!Number.isInteger(n) || n < 0 || n > 1000) throw new HttpError(400, "bad_setting", "maxGuessesPerRound must be 0..1000 (0 = unlimited)");
    next.maxGuessesPerRound = n;
  }
  const g = patch.game as Record<string, unknown> | undefined;
  if (g && typeof g === "object") {
    if (g.choices !== undefined) {
      const c = Number(g.choices);
      if (![1, 3, 5].includes(c)) throw new HttpError(400, "bad_setting", "game.choices must be 1, 3 or 5");
      next.game.choices = c as 1 | 3 | 5;
    }
    if (g.roundSec !== undefined) {
      const r = Number(g.roundSec);
      if (!Number.isInteger(r) || r < 30 || r > 600) throw new HttpError(400, "bad_setting", "game.roundSec must be 30..600");
      next.game.roundSec = r;
    }
    if (g.difficulty !== undefined) {
      if (!["easy", "medium", "hard", "mixed"].includes(String(g.difficulty))) throw new HttpError(400, "bad_setting", "game.difficulty must be easy, medium, hard or mixed");
      next.game.difficulty = g.difficulty as GameCfg["difficulty"];
    }
    if (g.categories !== undefined) {
      if (!Array.isArray(g.categories)) throw new HttpError(400, "bad_setting", `game.categories must be a list of: ${CATEGORIES.join(", ")}`);
      next.game.categories = g.categories.map(String).filter((c) => CATEGORIES.includes(c));
    }
    if (g.custom !== undefined) next.game.custom = cleanWords(g.custom);
    // addWords / removeWords edit the list without sending all of it again
    if (g.addWords !== undefined) next.game.custom = [...new Set([...next.game.custom, ...cleanWords(g.addWords)])].slice(0, MAX_CUSTOM);
    if (g.removeWords !== undefined) {
      const drop = new Set(cleanWords(g.removeWords));
      next.game.custom = next.game.custom.filter((w) => !drop.has(w));
    }
    if (g.customOnly !== undefined) next.game.customOnly = !!g.customOnly;
    if (next.game.customOnly && next.game.custom.length < 5) throw new HttpError(400, "bad_setting", "customOnly needs at least 5 custom words");
  }
  return next;
}
