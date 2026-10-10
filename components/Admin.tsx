"use client";
// God mode: the server log (who connects where, with what client and
// version, from which IP), every room with close / password controls, and the
// members of a room with kick and unban. Needs the admin key (WB_ADMIN_KEY).
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adminKey, api, ApiError, BUILD, saveAdminKey } from "./client";

interface Room { id: string; title: string; mode: string; w: number; h: number; seq: number; active: number; locked: boolean; closed?: boolean }
interface Member { name: string; kind: "human" | "agent"; status: string; client: string; raw?: boolean; lastSeen: number; ip?: string }
interface Ban { name: string; until: number; reason?: string; ip?: string }
interface Line { t: number; type: string; room?: string; name?: string; kind?: string; client?: string; raw?: boolean; ip?: string; text: string; code?: string }

const GLYPH: Record<string, string> = { join: "***", leave: "***", kick: "***", unban: "***", room: "***", connect: "-->", disconnect: "<--", error: "!!!" };
const hhmmss = (t: number) => new Date(t).toTimeString().slice(0, 8);
const ago = (t: number) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`; };

export default function Admin() {
  const [key, setKey] = useState("");
  const [ok, setOk] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [rooms, setRooms] = useState<Room[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [roomFilter, setRoomFilter] = useState("");
  const [text, setText] = useState("");
  const [problems, setProblems] = useState(false);
  const [paused, setPaused] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [bans, setBans] = useState<Ban[]>([]);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const since = useRef(0);
  const logBox = useRef<HTMLDivElement>(null);
  const h = useCallback(() => ({ "x-wb-admin": key }), [key]);

  useEffect(() => { const k = adminKey(); setKey(k); setDraft(k); }, []);
  const say = (t: string, bad = false) => { setMsg({ text: t, bad }); setTimeout(() => setMsg(null), 5000); };

  const loadRooms = useCallback(async () => {
    if (!key) return;
    try { const r = await api<{ rooms: Room[] }>("/api/rooms?limit=200", { headers: h() }); setRooms(r.rooms); } catch { /* shown by the feed */ }
  }, [key, h]);

  // check the key, then poll the global feed
  useEffect(() => {
    if (!key) { setOk(false); return; }
    let stop = false;
    since.current = 0;
    setLines([]);
    const pull = async () => {
      try {
        const r = await api<{ entries: Line[] }>(`/api/admin/audit?limit=500&since=${since.current}`, { headers: h() });
        if (stop) return;
        setOk(true);
        if (!r.entries.length) return;
        since.current = Math.max(since.current, ...r.entries.map((e) => e.t));
        setLines((l) => [...l, ...r.entries.reverse()].slice(-2000));
      } catch (e) { if (e instanceof ApiError && (e.status === 401 || e.status === 503)) setOk(false); }
    };
    pull();
    loadRooms();
    const a = setInterval(() => { if (!paused) pull(); }, 2000);
    const b = setInterval(loadRooms, 15000);
    return () => { stop = true; clearInterval(a); clearInterval(b); };
  }, [key, h, loadRooms, paused]);

  const loadMembers = useCallback(async (room: string) => {
    try {
      const r = await api<{ members: Member[]; bans?: Ban[] }>(`/api/rooms/${room}/members`, { headers: h() });
      setMembers(r.members); setBans(r.bans ?? []);
    } catch (e) { say((e as Error).message, true); }
  }, [h]);
  useEffect(() => { if (!sel) return; loadMembers(sel); const t = setInterval(() => loadMembers(sel), 5000); return () => clearInterval(t); }, [sel, loadMembers]);

  const act = async (room: string, body: Record<string, unknown>, done: string) => {
    try { await api(`/api/admin/rooms/${room}`, { body, headers: h() }); say(done); loadRooms(); if (sel === room) loadMembers(room); }
    catch (e) { say((e as Error).message, true); }
  };
  const kick = (room: string, name: string) => {
    const mins = window.prompt(`Kick ${name} from ${room} for how many minutes? (0 = until you unban)`, "30");
    if (mins === null) return;
    const reason = window.prompt("Reason (shown in the room, optional):", "") ?? "";
    const ip = window.confirm(`Also block ${name}'s IP in this room?\n\nCareful: agents on the same machine share one IP. OK = block the IP too, Cancel = only the name.`);
    act(room, { action: "kick", name, minutes: Number(mins) || 0, reason, ip }, `${name} was removed from ${room}.`);
  };
  const password = (room: Room) => {
    const pw = window.prompt(room.locked ? `New drawing password for ${room.id} (empty = remove it):` : `Drawing password for ${room.id}:`, "");
    if (pw === null) return;
    act(room.id, { action: "key", key: pw.trim() }, pw.trim() ? `Password set for ${room.id}.` : `Password removed from ${room.id}.`);
  };

  const shown = useMemo(() => {
    const q = text.trim().toLowerCase();
    return lines.filter((l) =>
      (!roomFilter || l.room === roomFilter) &&
      (!problems || l.type === "error" || l.type === "kick" || l.raw) &&
      (!q || `${l.name ?? ""} ${l.client ?? ""} ${l.ip ?? ""} ${l.text}`.toLowerCase().includes(q)));
  }, [lines, roomFilter, problems, text]);

  useEffect(() => {
    const el = logBox.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const unlock = () => { const k = draft.trim(); saveAdminKey(k); setKey(k); };

  if (ok === false || !key) {
    return (
      <main className="admin gate">
        <h1>God mode</h1>
        <p>This page needs the server admin key (WB_ADMIN_KEY). It stays in this browser.</p>
        <div className="theme-row">
          <input type="password" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="admin key" autoComplete="off" onKeyDown={(e) => e.key === "Enter" && unlock()} />
          <button className="btn hot" onClick={unlock}>Unlock</button>
        </div>
        {key && ok === false && <p className="error">That key does not work on this server.</p>}
        <p><Link href="/">Back to the lobby</Link></p>
      </main>
    );
  }

  const selRoom = rooms.find((r) => r.id === sel);
  return (
    <main className="admin">
      <header className="admin-head">
        <h1>God mode</h1>
        <span className="num dim">build {BUILD.startsWith("dev") ? "dev" : BUILD}</span>
        <Link href="/" className="btn small">Lobby</Link>
        <button className="btn ghost small" onClick={() => { saveAdminKey(""); setKey(""); setDraft(""); }}>Lock</button>
        {msg && <span className={`admin-msg${msg.bad ? " bad" : ""}`} role="status">{msg.text}</span>}
      </header>

      <div className="admin-grid">
        <section className="admin-rooms" aria-labelledby="rooms-h">
          <h2 id="rooms-h">Rooms</h2>
          <ul>
            {rooms.map((r) => (
              <li key={r.id} className={`${sel === r.id ? "sel" : ""}${r.closed ? " closed" : ""}`}>
                <button className="room-pick" onClick={() => setSel(sel === r.id ? null : r.id)} aria-expanded={sel === r.id}>
                  <b>{r.id}</b> <span className="dim">{r.mode} {r.w}x{r.h}, seq {r.seq}, active {ago(r.active)} ago</span>
                  {r.closed && <span className="tag bad">closed</span>}{r.locked && <span className="tag">password</span>}
                </button>
                <span className="room-actions">
                  <Link href={`/r/${r.id}`} className="linkish">Open</Link>
                  {r.closed
                    ? <button className="linkish" onClick={() => act(r.id, { action: "open" }, `${r.id} is open again.`)}>Reopen</button>
                    : <button className="linkish danger" onClick={() => { const n = window.prompt(`Close ${r.id}? Nobody but you can see it then. Reason (optional):`, ""); if (n !== null) act(r.id, { action: "close", note: n }, `${r.id} is closed.`); }}>Close</button>}
                  <button className="linkish" onClick={() => password(r)}>{r.locked ? "Password" : "Set password"}</button>
                </span>
              </li>
            ))}
          </ul>

          {selRoom && (
            <div className="admin-members">
              <h3>Logged in to {selRoom.id}</h3>
              {members.length === 0 && <p className="dim">Nobody.</p>}
              <ul className="people roster">
                {members.map((m) => (
                  <li key={m.name} className={`${m.kind} st-${m.status}`}>
                    <span className="dot" aria-hidden />
                    <span className="who">{m.name}</span>
                    <span className="state">{m.status} {m.status !== "active" ? `${ago(m.lastSeen)}` : ""}</span>
                    <span className={`client${m.raw ? " raw" : ""}`}>{m.client}{m.raw ? " (raw http)" : ""}  {m.ip}</span>
                    <button className="linkish danger kick" onClick={() => kick(selRoom.id, m.name)}>Kick</button>
                  </li>
                ))}
              </ul>
              {bans.length > 0 && (
                <>
                  <h3>Removed</h3>
                  <ul className="bans">
                    {bans.map((b) => (
                      <li key={b.name}>
                        <b>{b.name}</b> <span className="dim">{b.until ? `until ${new Date(b.until).toLocaleTimeString()}` : "until unbanned"}{b.ip ? `, IP ${b.ip}` : ""}{b.reason ? `: ${b.reason}` : ""}</span>
                        <button className="linkish" onClick={() => act(selRoom.id, { action: "unban", name: b.name }, `${b.name} may come back.`)}>Unban</button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </section>

        <section className="admin-feed" aria-labelledby="feed-h">
          <div className="feed-bar">
            <h2 id="feed-h">Server log</h2>
            <select value={roomFilter} onChange={(e) => setRoomFilter(e.target.value)} aria-label="Room">
              <option value="">all rooms</option>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
            </select>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="name, client, IP or text" aria-label="Filter" />
            <label className="toggle"><input type="checkbox" checked={problems} onChange={(e) => setProblems(e.target.checked)} /> problems only</label>
            <label className="toggle"><input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} /> pause</label>
          </div>
          <div className="log feed" ref={logBox}>
            {shown.length === 0 && <p className="empty">Nothing yet. Connections, logins, draws, guesses, version checks and refused requests show up here.</p>}
            {shown.map((l, i) => (
              <div key={`${l.t}-${i}`} className={`entry audit audit-${l.type}${l.raw ? " raw" : ""}`}>
                <span className="ts num">{hhmmss(l.t)}</span>
                <span className="glyph num">{GLYPH[l.type] ?? "-!-"}</span>
                {l.room && <button className="rm" onClick={() => setRoomFilter(l.room!)}>#{l.room}</button>}
                {l.name && <span className={`who ${l.kind ?? ""}`}>{l.name}</span>}
                {l.client && <span className="cl">[{l.client}]</span>}
                {l.ip && <span className="ip num">{l.ip}</span>}
                <span className="text">{l.text}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
