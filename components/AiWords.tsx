"use client";
// AI word maker: a side panel that asks an OpenRouter model for pictionary
// words. The OpenRouter key lives ONLY in this browser (localStorage) and the
// request goes straight from the browser to openrouter.ai. Our server never
// sees the key.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cleanWords } from "@/lib/words";

interface OrModel { id: string; name: string; free: boolean; ctx: number }

const OR = "https://openrouter.ai/api/v1";
const K_KEY = "wb.or.key", K_MODEL = "wb.or.model", K_MODELS = "wb.or.models", K_FREE = "wb.or.freeOnly";
const MODELS_TTL = 6 * 3600 * 1000;
const DEFAULT_MODEL = "openrouter/free"; // OpenRouter's router over the free models

const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const put = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } };

const DIFF_HELP: Record<string, string> = {
  easy: "easy: single everyday objects or animals a child can draw in a few strokes",
  medium: "medium: specific objects, places or characters that need some detail",
  hard: "hard: small scenes, actions or tricky ideas that are still possible to draw",
  mixed: "mixed: about one third easy, one third medium, one third hard",
};

// Text models only; drop classifiers and music models.
function toModels(data: unknown[]): OrModel[] {
  const out: OrModel[] = [];
  for (const raw of data) {
    const m = raw as { id: string; name?: string; context_length?: number; pricing?: { prompt?: string; completion?: string }; architecture?: { output_modalities?: string[] } };
    const outs = m.architecture?.output_modalities ?? ["text"];
    if (!outs.every((o) => o === "text")) continue;
    if (/safety|guard|embed|rerank/i.test(m.id)) continue;
    const free = m.pricing?.prompt === "0" && m.pricing?.completion === "0";
    out.push({ id: m.id, name: m.name ?? m.id, free, ctx: m.context_length ?? 0 });
  }
  out.sort((a, b) => (a.id === DEFAULT_MODEL ? -1 : b.id === DEFAULT_MODEL ? 1 : a.name.localeCompare(b.name)));
  return out;
}

// Models answer with a JSON array, a fenced block, a numbered list or prose.
export function parseWordList(text: string): string[] {
  const t = text.replace(/```(?:json)?/gi, "");
  const a = t.indexOf("["), b = t.lastIndexOf("]");
  if (a >= 0 && b > a) {
    try {
      const arr = JSON.parse(t.slice(a, b + 1));
      if (Array.isArray(arr)) return cleanWords(arr.map((x) => (typeof x === "string" ? x : (x as { word?: string })?.word ?? "")));
    } catch { /* fall through to line parsing */ }
  }
  const lines = t.split(/[\n,;]+/).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/["'`]/g, "").trim());
  return cleanWords(lines);
}

export default function AiWords({ open, onClose, theme, difficulty, have, onAdd }: {
  open: boolean; onClose: () => void; theme: string; difficulty: string;
  have: string[]; onAdd: (words: string[]) => void;
}) {
  const [key, setKey] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<OrModel[]>([]);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [freeOnly, setFreeOnly] = useState(true);
  const [filter, setFilter] = useState("");
  const [topic, setTopic] = useState(theme);
  const [count, setCount] = useState(30);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; bad?: boolean } | null>(null);
  const [result, setResult] = useState<string[]>([]);
  const [off, setOff] = useState<Set<string>>(new Set());
  const abort = useRef<AbortController | null>(null);

  // restore saved choices once
  useEffect(() => {
    const k = get(K_KEY) ?? "";
    setKey(k); setKeyDraft(k);
    setModel(get(K_MODEL) ?? DEFAULT_MODEL);
    setFreeOnly(get(K_FREE) !== "0");
    try {
      const c = JSON.parse(get(K_MODELS) ?? "null") as { t: number; list: OrModel[] } | null;
      if (c && Date.now() - c.t < MODELS_TTL) setModels(c.list);
    } catch { /* bad cache */ }
  }, []);

  useEffect(() => { if (open && theme && !topic) setTopic(theme); }, [open, theme, topic]);
  useEffect(() => { if (open && !models.length) loadModels(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);

  // Escape closes the panel only (capture phase, before the settings modal sees it)
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopImmediatePropagation(); onClose(); } };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [open, onClose]);

  const loadModels = async () => {
    setStatus({ text: "Loading the model list from OpenRouter" });
    try {
      const r = await fetch(`${OR}/models`);
      const j = await r.json();
      const list = toModels(j.data ?? []);
      setModels(list);
      put(K_MODELS, JSON.stringify({ t: Date.now(), list }));
      setStatus({ text: `${list.filter((m) => m.free).length} free models, ${list.length} in total.` });
    } catch (e) {
      setStatus({ text: `Could not load the model list: ${(e as Error).message}`, bad: true });
    }
  };

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return models.filter((m) => (!freeOnly || m.free) && (!f || m.id.toLowerCase().includes(f) || m.name.toLowerCase().includes(f)));
  }, [models, freeOnly, filter]);

  const saveKey = () => {
    const k = keyDraft.trim();
    setKey(k); put(K_KEY, k || null);
    setStatus({ text: k ? "Key saved in this browser." : "Key removed from this browser." });
  };

  const pickModel = (id: string) => { setModel(id); put(K_MODEL, id); };

  const generate = async () => {
    if (!key) { setStatus({ text: "Paste your OpenRouter key first.", bad: true }); return; }
    const q = topic.trim();
    if (!q) { setStatus({ text: "Write a theme first, for example: pirates, kitchen, space.", bad: true }); return; }
    abort.current?.abort();
    const ctl = new AbortController(); abort.current = ctl;
    setBusy(true); setStatus({ text: `Asking ${model}` });
    const avoid = [...new Set([...have, ...result])].slice(0, 200);
    const sys = "You write word lists for a pictionary game. Players draw on a small pixel canvas (32x32 to 128x128 cells) and the others guess the word. "
      + "Rules for every entry: a concrete thing that someone can draw; lowercase English; 1 to 3 words; only letters, spaces, hyphens and apostrophes; "
      + "no names of real people, brands or trademarks; no duplicates. Reply with ONLY a JSON array of strings, nothing else.";
    const user = `Theme: ${q}\nHow many: ${count}\nDifficulty: ${DIFF_HELP[difficulty] ?? DIFF_HELP.mixed}`
      + (notes.trim() ? `\nExtra instructions: ${notes.trim()}` : "")
      + (avoid.length ? `\nDo not use any of these words: ${avoid.join(", ")}` : "");
    try {
      const r = await fetch(`${OR}/chat/completions`, {
        method: "POST", signal: ctl.signal,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "http-referer": location.origin, "x-title": "Chaos Whiteboard" },
        body: JSON.stringify({ model, temperature: 0.9, max_tokens: 4000, messages: [{ role: "system", content: sys }, { role: "user", content: user }] }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) {
        const msg = j.error?.message ?? `HTTP ${r.status}`;
        const why = r.status === 401 ? "OpenRouter rejected the key." : r.status === 402 ? "This model needs credits. Pick a free model." : r.status === 429 ? "The free model is busy, or you hit the free daily limit. Try again or pick another model." : "";
        setStatus({ text: `${why} ${msg}`.trim(), bad: true });
        return;
      }
      const m = j.choices?.[0]?.message ?? {};
      const text = String(m.content || m.reasoning || "");
      const have2 = new Set(avoid);
      const words = parseWordList(text).filter((w) => !have2.has(w));
      if (!words.length) { setStatus({ text: "The model gave no usable words. Try again or pick another model.", bad: true }); return; }
      setResult((prev) => [...prev, ...words]);
      setStatus({ text: `${words.length} new words from ${j.model ?? model}. Click a word to drop it, then add them to the bag.` });
    } catch (e) {
      if ((e as Error).name !== "AbortError") setStatus({ text: `Request failed: ${(e as Error).message}`, bad: true });
    } finally { setBusy(false); }
  };

  const keep = result.filter((w) => !off.has(w));
  const add = () => {
    if (!keep.length) return;
    onAdd(keep);
    setStatus({ text: `Added ${keep.length} words to the bag.` });
    setResult([]); setOff(new Set());
  };
  const toggle = (w: string) => setOff((s) => { const n = new Set(s); if (n.has(w)) n.delete(w); else n.add(w); return n; });

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="drawer-back" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="ai-words-title" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2 id="ai-words-title">AI word maker</h2>
          <button type="button" className="btn ghost small" onClick={onClose} aria-label="Close">Close</button>
        </header>

        <section>
          <h3>OpenRouter key</h3>
          <p className="help">Stored in this browser only. Your browser sends it straight to openrouter.ai. The whiteboard server never sees it.</p>
          <div className="theme-row">
            <input type={showKey ? "text" : "password"} value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} placeholder="sk-or-..." autoComplete="off" spellCheck={false}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveKey(); } }} />
            <button type="button" className="btn small" onClick={() => setShowKey((v) => !v)} aria-pressed={showKey}>{showKey ? "Hide" : "Show"}</button>
          </div>
          <div className="row-gap">
            <button type="button" className="btn small" onClick={saveKey} disabled={keyDraft.trim() === key}>{key ? "Update key" : "Save key"}</button>
            {key && <button type="button" className="btn ghost small danger" onClick={() => { setKeyDraft(""); setKey(""); put(K_KEY, null); setStatus({ text: "Key removed from this browser." }); }}>Forget key</button>}
            {!key && <a className="help" href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">Get a free key</a>}
          </div>
        </section>

        <section>
          <h3>Model</h3>
          <div className="row-gap">
            <input className="grow" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search models" />
            <button type="button" className="btn small" aria-pressed={freeOnly} onClick={() => { setFreeOnly((v) => { put(K_FREE, v ? "0" : "1"); return !v; }); }}>{freeOnly ? "Free only" : "All models"}</button>
            <button type="button" className="btn small" onClick={loadModels} title="Reload the model list">Reload</button>
          </div>
          <select value={model} onChange={(e) => pickModel(e.target.value)} size={Math.min(7, Math.max(3, shown.length))} className="models">
            {!shown.some((m) => m.id === model) && <option value={model}>{model}</option>}
            {shown.map((m) => <option key={m.id} value={m.id}>{m.id === DEFAULT_MODEL ? "Any free model (OpenRouter picks)" : m.name}{m.free ? "" : " (paid)"}</option>)}
          </select>
          <p className="help">{shown.length} shown. Free models have daily limits and can be slow or busy.</p>
        </section>

        <section>
          <h3>Words</h3>
          <label className="stack">Theme
            <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="pirates, kitchen, space, 80s cartoons"
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); generate(); } }} />
          </label>
          <div className="chips">{[15, 30, 50, 80].map((c) => (
            <button type="button" key={c} className="num" aria-pressed={count === c} onClick={() => setCount(c)}>{c} words</button>
          ))}</div>
          <label className="stack">Extra instructions (optional)
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="only food; kid friendly; things from the 80s" />
          </label>
          <p className="help">Difficulty from the bag: {difficulty}. Words already in the bag are skipped.</p>
          <div className="row-gap">
            <button type="button" className="btn hot" onClick={generate} disabled={busy}>{busy ? "Generating" : result.length ? "Generate more" : "Generate"}</button>
            {busy && <button type="button" className="btn ghost small" onClick={() => abort.current?.abort()}>Stop</button>}
          </div>
        </section>

        {status && <p className={`drawer-status ${status.bad ? "bad" : ""}`} role="status">{status.text}</p>}

        {!!result.length && (
          <section>
            <h3>Result <span className="help">{keep.length} of {result.length} kept</span></h3>
            <div className="chips ai-result">{result.map((w) => (
              <button type="button" key={w} aria-pressed={!off.has(w)} onClick={() => toggle(w)} title={off.has(w) ? "Click to keep" : "Click to drop"}>{w}</button>
            ))}</div>
            <div className="row-gap">
              <button type="button" className="btn hot" onClick={add} disabled={!keep.length}>Add {keep.length} words to the bag</button>
              <button type="button" className="btn ghost small" onClick={() => { setResult([]); setOff(new Set()); }}>Clear</button>
            </div>
          </section>
        )}
      </aside>
    </div>,
    document.body,
  );
}
