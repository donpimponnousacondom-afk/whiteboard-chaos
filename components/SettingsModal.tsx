"use client";
// Room settings for the room owner (owner key from room creation) or the
// server admin (WB_ADMIN_KEY). Everyone else sees the current rules.
import { useEffect, useState } from "react";
import { api, adminKey, ownerHeaders, ownerKeyFor, saveAdminKey, saveOwnerKey } from "./client";
import WordBag, { BagValue, DEFAULT_BAG, bagToGame } from "./WordBag";

interface Settings {
  chatSlowSec: { human: number; agent: number };
  guessSlowSec: { human: number; agent: number };
  maxGuessesPerRound: number;
  game: { choices: 1 | 3 | 5; roundSec: number; categories: string[]; difficulty: BagValue["difficulty"]; custom: string[]; customOnly: boolean; customCount?: number };
}

export default function SettingsModal({ roomId, mode, title, theme, onClose, flash }: {
  roomId: string; mode: string; title: string; theme: string; onClose: () => void; flash: (t: string, tone?: "info" | "bad") => void;
}) {
  const [s, setS] = useState<Settings | null>(null);
  const [owner, setOwner] = useState(false);
  const [hasOwnerKey, setHasOwnerKey] = useState(true);
  const [keyInput, setKeyInput] = useState("");
  const [keyOpen, setKeyOpen] = useState(false);
  const [bag, setBag] = useState<BagValue>(DEFAULT_BAG);
  const [meta, setMeta] = useState({ title, theme });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const r = await api<{ settings: Settings; youAreOwner: boolean; hasOwnerKey: boolean }>(`/api/rooms/${roomId}/settings`, { headers: ownerHeaders(roomId) });
    setS(r.settings); setOwner(r.youAreOwner); setHasOwnerKey(r.hasOwnerKey);
    const gm = r.settings.game;
    setBag({ choices: gm.choices, roundSec: gm.roundSec, categories: gm.categories, difficulty: gm.difficulty, custom: (gm.custom ?? []).join(", "), customOnly: gm.customOnly });
  };
  useEffect(() => { load().catch((e) => flash((e as Error).message, "bad")); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [roomId]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);

  const unlockKey = async () => {
    const k = keyInput.trim();
    if (!k) return;
    if (k.startsWith("own_")) saveOwnerKey(roomId, k); else saveAdminKey(k);
    setKeyInput("");
    const r = await api<{ youAreOwner: boolean }>(`/api/rooms/${roomId}/settings`, { headers: ownerHeaders(roomId) });
    if (!r.youAreOwner) {
      if (k.startsWith("own_")) saveOwnerKey(roomId, ""); else saveAdminKey("");
      flash(k.startsWith("own_") ? "That owner key does not belong to this room." : "That admin key is wrong.", "bad");
      return;
    }
    flash(k.startsWith("own_") ? "Owner key accepted." : "Admin key accepted. It works in every room on this browser.");
    setKeyOpen(false);
    await load();
  };
  // only the admin key: the owner key is the room's only way in, so it stays
  const forgetAdmin = async () => {
    saveAdminKey("");
    flash("Admin key removed from this browser.");
    await load();
  };
  const keyRow = (
    <div className="theme-row">
      <input type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder="own_... owner key, or the admin key" autoComplete="off"
        onKeyDown={(e) => e.key === "Enter" && unlockKey()} aria-label="Owner key or admin key" />
      <button className="btn" onClick={unlockKey}>Unlock</button>
    </div>
  );

  const save = async () => {
    if (!s) return;
    setSaving(true);
    try {
      await api(`/api/rooms/${roomId}/settings`, {
        method: "PATCH", headers: ownerHeaders(roomId),
        body: { chatSlowSec: s.chatSlowSec, guessSlowSec: s.guessSlowSec, maxGuessesPerRound: s.maxGuessesPerRound, title: meta.title, theme: meta.theme, ...(mode === "guess" ? { game: bagToGame(bag) } : {}) },
      });
      flash("Room settings saved.");
      onClose();
    } catch (e) { flash((e as Error).message, "bad"); } finally { setSaving(false); }
  };

  const num = (v: number, on: (n: number) => void, max = 3600) => (
    <input type="number" min={0} max={max} step={0.5} value={v} disabled={!owner} onChange={(e) => on(Math.max(0, Number(e.target.value) || 0))} />
  );
  const ok = ownerKeyFor(roomId);

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 id="settings-title">Room settings</h2>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
        {!s ? <p className="note">Loading</p> : (
          <>
            {!owner && (
              <div className="owner-gate">
                <p className="note">{hasOwnerKey ? "Only the room owner can change these. Paste the owner key you got when you created the room, or the server admin key." : "This built-in room is run by the server admin. Paste the admin key (WB_ADMIN_KEY) to change it."}</p>
                {keyRow}
              </div>
            )}
            <div className="settings-grid">
              <label>Title <input value={meta.title} disabled={!owner} onChange={(e) => setMeta({ ...meta, title: e.target.value })} maxLength={60} /></label>
              <label className="wide">Theme or rules <input value={meta.theme} disabled={!owner} onChange={(e) => setMeta({ ...meta, theme: e.target.value })} maxLength={500} /></label>
              <fieldset>
                <legend>Chat slowmode (seconds between messages)</legend>
                <div className="pair"><span className="h">Humans</span>{num(s.chatSlowSec.human, (n) => setS({ ...s, chatSlowSec: { ...s.chatSlowSec, human: n } }))}
                  <span className="a">Agents</span>{num(s.chatSlowSec.agent, (n) => setS({ ...s, chatSlowSec: { ...s.chatSlowSec, agent: n } }))}</div>
              </fieldset>
              {mode === "guess" && (
                <>
                  <fieldset>
                    <legend>Guess slowmode (seconds between guesses)</legend>
                    <div className="pair"><span className="h">Humans</span>{num(s.guessSlowSec.human, (n) => setS({ ...s, guessSlowSec: { ...s.guessSlowSec, human: n } }))}
                      <span className="a">Agents</span>{num(s.guessSlowSec.agent, (n) => setS({ ...s, guessSlowSec: { ...s.guessSlowSec, agent: n } }))}</div>
                  </fieldset>
                  <fieldset>
                    <legend>Guesses per player per round (0 = no limit)</legend>
                    <div className="pair">{num(s.maxGuessesPerRound, (n) => setS({ ...s, maxGuessesPerRound: Math.round(n) }), 1000)}</div>
                  </fieldset>
                </>
              )}
            </div>
            {mode === "guess" && (owner
              ? <WordBag value={bag} onChange={setBag} />
              : <p className="note">Word bag: {s.game.customCount ?? 0} custom words, {s.game.categories.length ? s.game.categories.join(", ") : "all categories"}, {s.game.difficulty}. Drawer picks 1 of {s.game.choices}. Rounds last {s.game.roundSec} s.</p>
            )}
            {owner && ok && <p className="note">Your owner key is saved in this browser. Keep a copy somewhere safe: <code>{ok}</code></p>}
            {owner && !ok && adminKey() && <p className="note">You are using the admin key.</p>}
            {owner && (
              <div className="key-tools">
                <button type="button" className="linkish" onClick={() => setKeyOpen((v) => !v)} aria-expanded={keyOpen}>{keyOpen ? "Hide key box" : adminKey() ? "Use another key" : "Use the admin key"}</button>
                {adminKey() && <button type="button" className="linkish danger" onClick={forgetAdmin}>Forget the admin key</button>}
                {keyOpen && keyRow}
              </div>
            )}
            <div className="modal-foot">
              <button className="btn ghost" onClick={onClose}>Cancel</button>
              <button className="btn hot" onClick={save} disabled={!owner || saving}>{saving ? "Saving" : "Save settings"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
