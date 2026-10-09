"use client";
// Word bag editor for pictionary rooms: built-in categories + difficulty, the
// room's own words, a theme fetch (Datamuse) and an AI word maker (OpenRouter,
// with the user's own key, from the browser).
import { useState } from "react";
import AiWords from "./AiWords";
import { api } from "./client";

export interface BagValue {
  choices: 1 | 3 | 5;
  roundSec: number;
  categories: string[];
  difficulty: "easy" | "medium" | "hard" | "mixed";
  custom: string;          // one word per line or comma separated
  customOnly: boolean;
}

export const CATS = ["animals", "food", "objects", "places", "nature", "fantasy", "transport", "people", "actions", "body", "sports", "tech"];
export const DEFAULT_BAG: BagValue = { choices: 3, roundSec: 120, categories: [], difficulty: "mixed", custom: "", customOnly: false };

export function bagToGame(v: BagValue) {
  return { choices: v.choices, roundSec: v.roundSec, categories: v.categories, difficulty: v.difficulty, custom: v.custom, customOnly: v.customOnly };
}

export default function WordBag({ value, onChange }: { value: BagValue; onChange: (v: BagValue) => void }) {
  const [theme, setTheme] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [ai, setAi] = useState(false);
  const set = (p: Partial<BagValue>) => onChange({ ...value, ...p });
  const list = () => [...new Set(value.custom.split(/[\n,;]+/).map((w) => w.trim().toLowerCase()).filter(Boolean))];
  const count = list().length;
  const addWords = (words: string[]) => {
    const have = list();
    const seen = new Set(have);
    const add = words.filter((w) => !seen.has(w));
    set({ custom: [...have, ...add].join(", ") });
    setNote(`Added ${add.length} AI words. Remove any that are hard to draw.`);
  };

  const fetchTheme = async () => {
    const q = theme.trim();
    if (!q) return;
    setBusy(true); setNote(null);
    try {
      const r = await api<{ words: string[] }>(`/api/words/theme?q=${encodeURIComponent(q)}&max=40`);
      const have = new Set(list());
      const add = r.words.filter((w) => !have.has(w));
      set({ custom: [...have, ...add].join(", ") });
      setNote(`Added ${add.length} words for "${q}". Remove any that are hard to draw.`);
    } catch (e) {
      setNote((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="wordbag">
      <fieldset>
        <legend>Words offered to the drawer</legend>
        <div className="chips">{([1, 3, 5] as const).map((c) => (
          <button type="button" key={c} aria-pressed={value.choices === c} onClick={() => set({ choices: c })}>{c === 1 ? "1 (no choice)" : `pick 1 of ${c}`}</button>
        ))}</div>
      </fieldset>
      <fieldset>
        <legend>Round length</legend>
        <div className="chips">{[60, 90, 120, 180, 240].map((s) => (
          <button type="button" key={s} className="num" aria-pressed={value.roundSec === s} onClick={() => set({ roundSec: s })}>{s} s</button>
        ))}</div>
      </fieldset>
      <fieldset>
        <legend>Difficulty</legend>
        <div className="chips">{(["easy", "medium", "hard", "mixed"] as const).map((d) => (
          <button type="button" key={d} aria-pressed={value.difficulty === d} onClick={() => set({ difficulty: d })}>{d}</button>
        ))}</div>
      </fieldset>
      <fieldset>
        <legend>Categories <span className="help">{value.categories.length ? `${value.categories.length} picked` : "all"}</span></legend>
        <div className="chips">{CATS.map((c) => (
          <button type="button" key={c} aria-pressed={value.categories.includes(c)}
            onClick={() => set({ categories: value.categories.includes(c) ? value.categories.filter((x) => x !== c) : [...value.categories, c] })}>{c}</button>
        ))}</div>
      </fieldset>
      <fieldset className="wide">
        <legend>Your own words <span className="help">{count} words, hidden from players</span></legend>
        <div className="theme-row">
          <input value={theme} onChange={(e) => setTheme(e.target.value)} placeholder="Theme, for example pirates, kitchen, space"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); fetchTheme(); } }} />
          <button type="button" className="btn" onClick={fetchTheme} disabled={busy} title="Related words from a free dictionary service">{busy ? "Fetching" : "Fetch words"}</button>
          <button type="button" className="btn ai" onClick={() => setAi(true)} title="Make words with an AI model (your OpenRouter key)">AI words</button>
        </div>
        <textarea value={value.custom} onChange={(e) => set({ custom: e.target.value })} rows={4} placeholder="treasure, parrot, pirate ship, cannon" spellCheck={false} />
        {note && <p className="help">{note}</p>}
        <label className="check"><input type="checkbox" checked={value.customOnly} onChange={(e) => set({ customOnly: e.target.checked })} /> Only use my words (needs at least 5)</label>
      </fieldset>
      <AiWords open={ai} onClose={() => setAi(false)} theme={theme} difficulty={value.difficulty} have={list()} onAdd={addWords} />
    </div>
  );
}
