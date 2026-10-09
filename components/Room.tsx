"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ALPHABET, EMPTY, hexToRgb, normHex } from "@/lib/palette";
import { applyOps, decodeDelta, READ_OPS, type Op } from "@/lib/raster";
import { api, ApiError, getIdentity, nonce, setName as saveName } from "./client";
import InviteAgent from "./InviteAgent";

type Tool = "pencil" | "eraser" | "line" | "rect" | "circle" | "flood" | "picker" | "text" | "pan";

interface Meta {
  id: string; title: string; theme: string; w: number; h: number; mode: "free" | "place" | "guess" | "life";
  bg: string; cooldownMs: number; burst: number; refillPerSec: number; locked: boolean;
}
interface LogEntry { key: string; seq?: number; kind: string; actor?: string; actorKind?: string; text: string; t: number }
interface Presence { name: string; kind: "human" | "agent"; t: number; status?: string; x?: number; y?: number; color?: string }
interface Cursor { x: number; y: number; color?: string; kind?: string; t: number }
interface GameState {
  status: string; round?: number; drawer?: string; hint?: string; endsAt?: number; word?: string; youAreDrawer?: boolean;
  scores?: { name: string; score: number }[]; lastWord?: string | null; lastWinner?: string | null; len?: number;
}
interface WbEv { seq?: number; kind: string; actor?: string; actorKind?: string; [k: string]: unknown }

const TOOLS: { id: Tool; key: string; label: string; icon: string }[] = [
  { id: "pencil", key: "p", label: "Pencil", icon: "M3 21l3.5-1 11-11-2.5-2.5-11 11L3 21zM16 5.5l2.5 2.5 1.5-1.5L17.5 4 16 5.5z" },
  { id: "eraser", key: "e", label: "Eraser", icon: "M4 17l7-7 6 6-4 4H8l-4-3zm9-11l6 6-2 2-6-6 2-2zM9 21h11" },
  { id: "line", key: "l", label: "Line", icon: "M4 20L20 4" },
  { id: "rect", key: "r", label: "Rectangle", icon: "M4 6h16v12H4z" },
  { id: "circle", key: "c", label: "Circle", icon: "M12 4a8 8 0 100 16 8 8 0 000-16z" },
  { id: "flood", key: "f", label: "Fill bucket", icon: "M5 11l6-6 7 7-6 6-7-7zm14 4s-2 2.2-2 3.5a2 2 0 004 0C21 17.2 19 15 19 15z" },
  { id: "picker", key: "i", label: "Pick color", icon: "M14 4l6 6-2 2-1-1-7 7H7v-3l7-7-1-1 1-2z" },
  { id: "text", key: "t", label: "Text", icon: "M5 5h14M12 5v14M9 19h6" },
  { id: "pan", key: "h", label: "Pan (or hold Space)", icon: "M12 3v18M3 12h18M12 3l-3 3m3-3l3 3M12 21l-3-3m3 3l3-3M3 12l3-3m-3 3l3 3m15-3l-3-3m3 3l-3 3" },
];

const MODE_TEXT: Record<Meta["mode"], string> = {
  free: "free for all",
  place: "place: 1 pixel per cooldown",
  guess: "pictionary",
  life: "game of life",
};

export default function Room({ roomId }: { roomId: string }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [palette, setPalette] = useState<string[]>([]);
  const [tool, setTool] = useState<Tool>("pencil");
  const [color, setColor] = useState<string>("#ff3d5a");
  const [size, setSize] = useState(1);
  const [mirror, setMirror] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [showDraws, setShowDraws] = useState(false);
  const [presence, setPresence] = useState<Presence[]>([]);
  const [game, setGame] = useState<GameState | null>(null);
  const [conn, setConn] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [latency, setLatency] = useState<number | null>(null);
  const [seqView, setSeqView] = useState(0);
  const [toast, setToast] = useState<{ text: string; tone: "info" | "bad" } | null>(null);
  const [name, setName] = useState("");
  const [chat, setChat] = useState("");
  const [invite, setInvite] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [lifeAuto, setLifeAuto] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [railTab, setRailTab] = useState<"chat" | "people">("chat");
  const [transport, setTransport] = useState<"ws" | "sse" | null>(null);

  // mutable engine state (kept out of React for speed)
  const metaRef = useRef<Meta | null>(null);
  const boardRef = useRef<string[]>([]);
  const palRef = useRef<string[]>([]);
  const rgbRef = useRef<[number, number, number][]>([]);
  const seqRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const offRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<ImageData | null>(null);
  const view = useRef({ zoom: 8, px: 0, py: 0, fitted: false });
  const dirty = useRef(true);
  const offDirty = useRef(true);
  const preview = useRef<Map<number, string>>(new Map());
  const cursors = useRef<Map<string, Cursor>>(new Map());
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const queue = useRef<Op[]>([]);
  const inflight = useRef(false);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toolRef = useRef(tool); toolRef.current = tool;
  const colorRef = useRef(color); colorRef.current = color;
  const sizeRef = useRef(size); sizeRef.current = size;
  const mirrorRef = useRef(mirror); mirrorRef.current = mirror;
  const cooldownRef = useRef(0); cooldownRef.current = cooldownUntil;
  const gameRef = useRef<GameState | null>(null); gameRef.current = game;
  const spaceDown = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const wsWaiters = useRef(new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>());
  const wsSeqId = useRef(0);

  const flash = useCallback((text: string, tone: "info" | "bad" = "info") => {
    setToast({ text, tone });
    setTimeout(() => setToast((t) => (t?.text === text ? null : t)), 3200);
  }, []);

  const addLog = useCallback((entries: LogEntry[]) => {
    if (!entries.length) return;
    setLog((l) => {
      const next = [...l, ...entries];
      return next.length > 400 ? next.slice(next.length - 400) : next;
    });
  }, []);

  // ---------------------------------------------------------------- board
  const setPal = useCallback((p: string[]) => {
    // the room palette is append-only: a shorter list is just an older view
    if (p.length < palRef.current.length) return;
    palRef.current = p;
    rgbRef.current = p.map(hexToRgb);
    setPalette(p);
  }, []);

  const writeCell = (i: number, ch: string) => {
    const img = imgRef.current, m = metaRef.current;
    if (!img || !m) return;
    const slot = ch === EMPTY ? -1 : ALPHABET.indexOf(ch);
    const [r, g, b] = slot >= 0 && rgbRef.current[slot] ? rgbRef.current[slot] : hexToRgb(m.bg);
    const o = i * 4;
    img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
  };

  const loadBoard = useCallback((board: string) => {
    const m = metaRef.current;
    if (!m) return;
    if (!offRef.current || offRef.current.width !== m.w || offRef.current.height !== m.h) {
      const off = document.createElement("canvas");
      off.width = m.w; off.height = m.h;
      offRef.current = off;
      imgRef.current = off.getContext("2d")!.createImageData(m.w, m.h);
    }
    boardRef.current = board.split("");
    for (let i = 0; i < boardRef.current.length; i++) writeCell(i, boardRef.current[i]);
    offDirty.current = true; dirty.current = true;
  }, []);

  const setCells = (pairs: Iterable<[number, string]>) => {
    for (const [i, ch] of pairs) { boardRef.current[i] = ch; writeCell(i, ch); }
    offDirty.current = true; dirty.current = true;
  };

  // ---------------------------------------------------------------- render loop
  useEffect(() => {
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const c = canvasRef.current, m = metaRef.current, off = offRef.current;
      if (!c || !m || !off) return;
      // fade stale cursors
      const tnow = Date.now();
      cursors.current.forEach((cur, k) => { if (tnow - cur.t > 12000) { cursors.current.delete(k); dirty.current = true; } });
      if (!dirty.current) return;
      dirty.current = false;
      if (offDirty.current && imgRef.current) { off.getContext("2d")!.putImageData(imgRef.current, 0, 0); offDirty.current = false; }
      const dpr = window.devicePixelRatio || 1;
      const ctx = c.getContext("2d")!;
      const W = c.width / dpr, H = c.height / dpr;
      const { zoom, px, py } = view.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#07070b";
      ctx.fillRect(0, 0, W, H);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, px, py, m.w * zoom, m.h * zoom);
      // grid
      if (zoom >= 7) {
        ctx.strokeStyle = zoom >= 14 ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.04)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        const x0 = Math.max(0, Math.floor(-px / zoom)), x1 = Math.min(m.w, Math.ceil((W - px) / zoom));
        const y0 = Math.max(0, Math.floor(-py / zoom)), y1 = Math.min(m.h, Math.ceil((H - py) / zoom));
        for (let x = x0; x <= x1; x++) { const sx = Math.round(px + x * zoom) + 0.5; ctx.moveTo(sx, py + y0 * zoom); ctx.lineTo(sx, py + y1 * zoom); }
        for (let y = y0; y <= y1; y++) { const sy = Math.round(py + y * zoom) + 0.5; ctx.moveTo(px + x0 * zoom, sy); ctx.lineTo(px + x1 * zoom, sy); }
        ctx.stroke();
      }
      ctx.strokeStyle = "#2c2c44";
      ctx.strokeRect(px - 0.5, py - 0.5, m.w * zoom + 1, m.h * zoom + 1);
      // preview
      if (preview.current.size) {
        ctx.globalAlpha = 0.75;
        preview.current.forEach((ch, i) => {
          const x = i % m.w, y = Math.floor(i / m.w);
          const slot = ALPHABET.indexOf(ch);
          ctx.fillStyle = ch === EMPTY ? m.bg : palRef.current[slot] ?? "#fff";
          ctx.fillRect(px + x * zoom, py + y * zoom, zoom, zoom);
        });
        ctx.globalAlpha = 1;
      }
      // hover cell
      const hv = hoverRef.current;
      if (hv && toolRef.current !== "pan") {
        const s = toolRef.current === "pencil" || toolRef.current === "eraser" ? sizeRef.current : 1;
        const off2 = Math.floor((s - 1) / 2);
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 1;
        ctx.strokeRect(px + (hv.x - off2) * zoom + 0.5, py + (hv.y - off2) * zoom + 0.5, s * zoom - 1, s * zoom - 1);
      }
      // other people's cursors
      ctx.font = "600 11px 'IBM Plex Sans', system-ui, sans-serif";
      cursors.current.forEach((cur, who) => {
        const age = tnow - cur.t;
        ctx.globalAlpha = age > 8000 ? Math.max(0, 1 - (age - 8000) / 4000) : 1;
        const cx = px + (cur.x + 0.5) * zoom, cy = py + (cur.y + 0.5) * zoom;
        const tint = cur.kind === "agent" ? "#3de1ff" : "#ffd23d";
        ctx.strokeStyle = tint; ctx.fillStyle = tint; ctx.lineWidth = 1.5;
        if (cur.kind === "agent") {
          const r = Math.max(5, zoom * 0.6);
          ctx.strokeRect(cx - r, cy - r, r * 2, r * 2);
          ctx.beginPath(); ctx.moveTo(cx - r - 4, cy); ctx.lineTo(cx - r, cy); ctx.moveTo(cx + r, cy); ctx.lineTo(cx + r + 4, cy); ctx.stroke();
        } else {
          ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy + 14); ctx.lineTo(cx + 4, cy + 10); ctx.lineTo(cx + 10, cy + 10); ctx.closePath(); ctx.fill();
        }
        const label = cur.kind === "agent" ? `${who} [bot]` : who;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = "rgba(11,11,16,0.85)";
        ctx.fillRect(cx + 10, cy + 12, tw + 8, 16);
        ctx.fillStyle = tint;
        ctx.fillText(label, cx + 14, cy + 24);
        ctx.globalAlpha = 1;
      });
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const fit = useCallback(() => {
    const c = canvasRef.current, m = metaRef.current;
    if (!c || !m) return;
    const W = c.clientWidth, H = c.clientHeight;
    const zoom = Math.max(1, Math.min(48, Math.floor(Math.min((W - 48) / m.w, (H - 48) / m.h))));
    view.current = { zoom, px: Math.round((W - m.w * zoom) / 2), py: Math.round((H - m.h * zoom) / 2), fitted: true };
    dirty.current = true;
  }, []);

  // size the canvas to its box
  useEffect(() => {
    const wrap = wrapRef.current, c = canvasRef.current;
    if (!wrap || !c) return;
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.max(1, Math.floor(wrap.clientWidth * dpr));
      c.height = Math.max(1, Math.floor(wrap.clientHeight * dpr));
      if (!view.current.fitted) fit();
      dirty.current = true;
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [fit]);

  // ---------------------------------------------------------------- server sync
  const refreshGame = useCallback(async () => {
    if (metaRef.current?.mode !== "guess") return;
    try { setGame(await api<GameState>(`/api/rooms/${roomId}/game`)); } catch { /* ignore */ }
  }, [roomId]);

  const refreshPresence = useCallback(async () => {
    try { const r = await api<{ presence: Presence[] }>(`/api/rooms/${roomId}/presence`); setPresence(r.presence); } catch { /* ignore */ }
  }, [roomId]);

  const resync = useCallback(async () => {
    try {
      for (let i = 0; i < 4; i++) {
        const r = await api<{ board: string; palette: string[]; seq: number }>(`/api/rooms/${roomId}`);
        if (r.seq < seqRef.current) { await new Promise((ok) => setTimeout(ok, 250)); continue; } // live feed is ahead: retry
        setPal(r.palette);
        loadBoard(r.board);
        seqRef.current = r.seq;
        setSeqView(r.seq);
        return;
      }
    } catch { /* ignore */ }
  }, [roomId, loadBoard, setPal]);

  const handleEvent = useCallback((ev: WbEv) => {
    if (ev.kind === "snapshot") {
      setPal(ev.palette as string[]);
      loadBoard(ev.board as string);
      seqRef.current = ev.seq ?? 0;
      setSeqView(seqRef.current);
      return;
    }
    if (ev.kind === "cursor") {
      if (ev.actor && ev.actor !== getIdentity().name && typeof ev.x === "number") {
        cursors.current.set(ev.actor, { x: ev.x, y: ev.y as number, color: ev.color as string, kind: ev.actorKind, t: Date.now() });
        dirty.current = true;
      }
      return;
    }
    if (ev.kind === "presence") { refreshPresence(); return; }
    if (ev.kind === "hello" || ev.kind === "reconnect") return;
    if (ev.seq !== undefined) {
      if (ev.seq <= seqRef.current) return;
      seqRef.current = ev.seq;
      setSeqView(ev.seq);
    }
    const base = { key: `${ev.seq ?? Math.random()}`, seq: ev.seq, kind: ev.kind, actor: ev.actor, actorKind: ev.actorKind, t: Date.now() };
    switch (ev.kind) {
      case "draw": {
        if (ev.palette) setPal(ev.palette as string[]);
        else if (typeof ev.pl === "number" && ev.pl > palRef.current.length) resync();
        if (typeof ev.full === "string") loadBoard(ev.full);
        else if (typeof ev.d === "string") {
          if (ev.palette) { for (let i = 0; i < boardRef.current.length; i++) writeCell(i, boardRef.current[i]); }
          setCells(decodeDelta(ev.d));
        }
        if (ev.actor && ev.actor !== getIdentity().name) {
          const c = cursors.current.get(ev.actor);
          if (c) c.t = Date.now();
        }
        addLog([{ ...base, text: `${ev.ops} (${ev.n} px)` }]);
        break;
      }
      case "chat": addLog([{ ...base, text: String(ev.text ?? "") }]); break;
      case "system": if (typeof ev.full === "string") loadBoard(ev.full); addLog([{ ...base, text: String(ev.text ?? "") }]); break;
      case "meta":
        setMeta((m) => (m ? { ...m, title: String(ev.title), theme: String(ev.theme) } : m));
        addLog([{ ...base, text: `renamed the room "${ev.title}"` }]);
        break;
      case "game":
        if (typeof ev.full === "string") loadBoard(ev.full);
        addLog([{ ...base, text: String(ev.text ?? ev.phase) }]);
        refreshGame();
        break;
    }
  }, [addLog, loadBoard, refreshGame, refreshPresence, resync, setPal]);

  // initial load + SSE
  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    let wsTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingWs: WebSocket | null = null;
    const onMsg = (data: string) => {
      let ev: WbEv;
      try { ev = JSON.parse(data); } catch { return; }
      if (ev.kind === "ack" || ev.kind === "error") {
        const w = wsWaiters.current.get(ev.id as number);
        if (w) { wsWaiters.current.delete(ev.id as number); if (ev.kind === "ack") w.resolve(ev); else w.reject(new ApiError(ev.error === "rate_limited" ? 429 : 400, String(ev.error), String(ev.message ?? ev.error), ev.retryMs as number | undefined)); }
        return;
      }
      if (ev.kind === "pong") return;
      try { handleEvent(ev); } catch (e) { console.error(e); }
    };
    const startSse = () => {
      if (cancelled) return;
      setTransport("sse");
      const src = new EventSource(`/api/rooms/${roomId}/events?since=${seqRef.current}`);
      es = src;
      src.onopen = () => setConn("live");
      src.onerror = () => {
        setConn("reconnecting");
        // the browser gives up for good after a non-200 answer (deploy, 5xx): restart it ourselves
        if (src.readyState === EventSource.CLOSED && !cancelled) { src.close(); setTimeout(startSse, 1500 + Math.random() * 1500); }
      };
      src.onmessage = (m) => onMsg(m.data);
    };
    // Prefer a WebSocket (Vercel WebSockets beta). If it does not open quickly, use SSE + POST.
    const startWs = (attempt: number) => {
      if (cancelled) return;
      const id = getIdentity();
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const qs = new URLSearchParams({ name: id.name, token: id.token, kind: "human", since: String(seqRef.current) });
      let opened = false;
      let ws: WebSocket;
      try { ws = new WebSocket(`${proto}://${location.host}/api/rooms/${roomId}/ws?${qs}`); } catch { startSse(); return; }
      wsTimer = setTimeout(() => { if (!opened) { ws.onclose = null; ws.close(); startSse(); } }, attempt === 0 ? 2500 : 5000);
      pendingWs = ws;
      ws.onopen = () => {
        if (cancelled) { ws.close(); return; }
        opened = true; if (wsTimer) clearTimeout(wsTimer); wsRef.current = ws; setTransport("ws"); setConn("live");
      };
      ws.onmessage = (m) => onMsg(String(m.data));
      ws.onclose = () => {
        if (wsTimer) clearTimeout(wsTimer);
        if (wsRef.current === ws) wsRef.current = null;
        wsWaiters.current.forEach((w) => w.reject(new Error("connection closed")));
        wsWaiters.current.clear();
        if (cancelled) return;
        if (!opened) { startSse(); return; }
        setConn("reconnecting");
        setTimeout(() => startWs(attempt + 1), Math.min(10000, 300 * 2 ** Math.min(attempt, 5)));
      };
    };
    const pref = new URLSearchParams(location.search).get("transport");
    setName(getIdentity().name);
    (async () => {
      try {
        const r = await api<{ room: Meta; board: string; palette: string[]; seq: number; presence: Presence[]; game?: GameState }>(`/api/rooms/${roomId}`);
        if (cancelled) return;
        metaRef.current = r.room;
        setMeta(r.room);
        setPal(r.palette);
        loadBoard(r.board);
        seqRef.current = r.seq;
        setSeqView(r.seq);
        setPresence(r.presence);
        if (r.game) setGame(r.game);
        view.current.fitted = false;
        fit();
        // recent history for context
        try {
          const lg = await api<{ events: WbEv[] }>(`/api/rooms/${roomId}/log?limit=60&kinds=chat,game,system,meta,draw`);
          addLog(lg.events.filter((e) => (e.seq ?? 0) <= r.seq).map((e) => ({
            key: `h${e.seq}`, seq: e.seq, kind: e.kind, actor: e.actor, actorKind: e.actorKind, t: Number(e.t),
            text: e.kind === "draw" ? `${e.ops} (${e.n} px)` : String(e.text ?? e.phase ?? ""),
          })));
        } catch { /* ignore */ }
        if (pref === "sse") startSse(); else startWs(0);
      } catch (e) {
        setError(e instanceof ApiError && e.status === 404 ? `Room "${roomId}" does not exist yet.` : `Could not load the room: ${(e as Error).message}`);
      }
    })();
    return () => { cancelled = true; es?.close(); if (wsTimer) clearTimeout(wsTimer); const w = wsRef.current; wsRef.current = null; w?.close(); pendingWs?.close(); };
  }, [roomId, addLog, fit, handleEvent, loadBoard, setPal]);

  // heartbeat + presence poll + clock
  useEffect(() => {
    const beat = () => api(`/api/rooms/${roomId}/presence`, { body: {} }).then(refreshPresence).catch(() => {});
    beat();
    const a = setInterval(beat, 15000);
    const b = setInterval(refreshPresence, 8000);
    const c = setInterval(() => setNow(Date.now()), 500);
    return () => { clearInterval(a); clearInterval(b); clearInterval(c); };
  }, [roomId, refreshPresence]);

  // life autoplay
  useEffect(() => {
    if (!lifeAuto) return;
    const t = setInterval(() => { api(`/api/rooms/${roomId}/ops`, { body: { ops: [{ op: "life" }] } }).catch(() => {}); }, 450);
    return () => clearInterval(t);
  }, [lifeAuto, roomId]);

  // ---------------------------------------------------------------- writes
  const flush = useCallback(async () => {
    flushTimer.current = null;
    if (inflight.current || !queue.current.length) return;
    const ops = queue.current.splice(0, 500);
    inflight.current = true;
    const t0 = performance.now();
    try {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const id = ++wsSeqId.current;
        await new Promise<Record<string, unknown>>((resolve, reject) => {
          wsWaiters.current.set(id, { resolve, reject });
          ws.send(JSON.stringify({ type: "ops", id, ops, nonce: nonce() }));
          setTimeout(() => { if (wsWaiters.current.delete(id)) reject(new Error("no answer from the server")); }, 10000);
        });
      } else {
        await api(`/api/rooms/${roomId}/ops`, { body: { ops, nonce: nonce() } });
      }
      setLatency(Math.round(performance.now() - t0));
      const m = metaRef.current;
      if (m?.mode === "place") setCooldownUntil(Date.now() + m.cooldownMs);
      // flood & co. were guessed locally from a possibly stale board: take the server's truth
      if (ops.some((o) => READ_OPS.has(o.op))) setTimeout(resync, 150);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === "name_taken") flash(`The name "${getIdentity().name}" belongs to someone else. Pick another name at the top.`, "bad");
        else if (e.status === 429) flash(e.retryMs ? `Too fast. Wait ${(e.retryMs / 1000).toFixed(1)} s.` : e.message, "bad");
        else flash(e.message, "bad");
      } else flash("Network error. Your last change was not saved.", "bad");
      queue.current = [];
      await resync();
    } finally {
      inflight.current = false;
      if (queue.current.length) flushTimer.current = setTimeout(flush, 0);
    }
  }, [roomId, flash, resync]);

  const enqueue = useCallback((ops: Op[]) => {
    const m = metaRef.current;
    if (!m || !ops.length) return;
    // optimistic local apply
    try {
      const r = applyOps(boardRef.current.join(""), m.w, m.h, ops, palRef.current);
      const pairs: [number, string][] = [];
      r.changed.forEach((i) => pairs.push([i, r.board[i]]));
      setCells(pairs);
    } catch (e) { flash((e as Error).message, "bad"); return; }
    queue.current.push(...ops);
    if (!flushTimer.current) flushTimer.current = setTimeout(flush, 25);
  }, [flash, flush]);

  const mirrorOp = (op: Op): Op[] => {
    const m = metaRef.current;
    if (!mirrorRef.current || !m) return [op];
    const W = m.w - 1;
    switch (op.op) {
      case "line": return [op, { ...op, x0: W - op.x0, x1: W - op.x1 }];
      case "rect": return [op, { ...op, x: m.w - op.x - op.w }];
      case "circle": return [op, { ...op, cx: W - op.cx }];
      case "flood": return [op, { ...op, x: W - op.x }];
      case "px": return [op, { ...op, x: W - op.x }];
      default: return [op];
    }
  };

  const currentColor = () => (toolRef.current === "eraser" ? null : colorRef.current);

  const shapeOp = (t: Tool, a: { x: number; y: number }, b: { x: number; y: number }, shift: boolean): Op | null => {
    const c = currentColor();
    if (t === "line") return { op: "line", x0: a.x, y0: a.y, x1: b.x, y1: b.y, c, size: 1 };
    if (t === "rect") {
      const w = Math.abs(b.x - a.x) + 1, h = Math.abs(b.y - a.y) + 1;
      return { op: "rect", x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w, h, c, fill: shift };
    }
    if (t === "circle") {
      const r = Math.round(Math.hypot(b.x - a.x, b.y - a.y));
      return { op: "circle", cx: a.x, cy: a.y, r, c, fill: shift };
    }
    return null;
  };

  // ---------------------------------------------------------------- pointer input
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ mode: "none" | "draw" | "shape" | "pan" | "pinch"; start?: { x: number; y: number }; last?: { x: number; y: number }; panStart?: { px: number; py: number; sx: number; sy: number }; pinch?: { d: number; zoom: number; mx: number; my: number; px: number; py: number } }>({ mode: "none" });
  const lastCursorSent = useRef(0);

  const toCell = (e: { clientX: number; clientY: number }) => {
    const c = canvasRef.current!, rect = c.getBoundingClientRect();
    const { zoom, px, py } = view.current;
    return { x: Math.floor((e.clientX - rect.left - px) / zoom), y: Math.floor((e.clientY - rect.top - py) / zoom), sx: e.clientX - rect.left, sy: e.clientY - rect.top };
  };
  const inBoard = (p: { x: number; y: number }) => { const m = metaRef.current; return !!m && p.x >= 0 && p.y >= 0 && p.x < m.w && p.y < m.h; };

  const canPaint = () => {
    const m = metaRef.current;
    if (!m) return false;
    if (m.mode === "place" && Date.now() < cooldownRef.current) { flash(`Cooldown: ${((cooldownRef.current - Date.now()) / 1000).toFixed(1)} s left`, "bad"); return false; }
    const g = gameRef.current;
    if (m.mode === "guess" && g?.status === "active" && g.drawer !== getIdentity().name) { flash(`${g.drawer} is drawing. Type your guess in the chat.`, "bad"); return false; }
    return true;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current!;
    c.setPointerCapture(e.pointerId);
    const p = toCell(e);
    pointers.current.set(e.pointerId, { x: p.sx, y: p.sy });
    const g = gesture.current;
    if (pointers.current.size === 2) {
      // second finger: switch to pinch, drop any shape preview
      preview.current.clear();
      const [a, b] = [...pointers.current.values()];
      g.mode = "pinch";
      g.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: view.current.zoom, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, px: view.current.px, py: view.current.py };
      return;
    }
    const t = toolRef.current;
    if (e.button === 1 || e.button === 2 || t === "pan" || spaceDown.current) {
      g.mode = "pan";
      g.panStart = { px: view.current.px, py: view.current.py, sx: p.sx, sy: p.sy };
      return;
    }
    if (!inBoard(p)) return;
    if (t === "picker") {
      const ch = boardRef.current[p.y * metaRef.current!.w + p.x];
      if (ch !== EMPTY) { setColor(palRef.current[ALPHABET.indexOf(ch)]); setTool("pencil"); }
      return;
    }
    if (!canPaint()) return;
    if (t === "flood") { enqueue(mirrorOp({ op: "flood", x: p.x, y: p.y, c: currentColor() })); return; }
    if (t === "text") {
      const s = window.prompt("Text to stamp (3x5 pixel font):");
      if (s) enqueue([{ op: "text", x: p.x, y: p.y, text: s, c: currentColor(), scale: sizeRef.current }]);
      return;
    }
    if (t === "pencil" || t === "eraser") {
      g.mode = "draw"; g.last = p;
      if (metaRef.current!.mode === "place") { enqueue([{ op: "px", x: p.x, y: p.y, c: currentColor() }]); g.mode = "none"; return; }
      enqueue(mirrorOp({ op: "line", x0: p.x, y0: p.y, x1: p.x, y1: p.y, c: currentColor(), size: sizeRef.current }));
      return;
    }
    g.mode = "shape"; g.start = p; g.last = p;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toCell(e);
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: p.sx, y: p.sy });
    const g = gesture.current;
    // hover + cursor broadcast
    const hv = inBoard(p) ? { x: p.x, y: p.y } : null;
    if (hv?.x !== hoverRef.current?.x || hv?.y !== hoverRef.current?.y) {
      hoverRef.current = hv; setHover(hv); dirty.current = true;
      if (hv && Date.now() - lastCursorSent.current > 120) {
        lastCursorSent.current = Date.now();
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "cursor", x: hv.x, y: hv.y, color: colorRef.current }));
        else api(`/api/rooms/${roomId}/presence`, { body: { x: hv.x, y: hv.y, color: colorRef.current } }).catch(() => {});
      }
    }
    if (g.mode === "pinch" && g.pinch && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const zoom = Math.max(0.5, Math.min(64, g.pinch.zoom * (d / g.pinch.d)));
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      view.current.zoom = zoom;
      view.current.px = mx - (g.pinch.mx - g.pinch.px) * (zoom / g.pinch.zoom);
      view.current.py = my - (g.pinch.my - g.pinch.py) * (zoom / g.pinch.zoom);
      dirty.current = true;
      return;
    }
    if (g.mode === "pan" && g.panStart) {
      view.current.px = g.panStart.px + (p.sx - g.panStart.sx);
      view.current.py = g.panStart.py + (p.sy - g.panStart.sy);
      dirty.current = true;
      return;
    }
    if (g.mode === "draw" && g.last && (p.x !== g.last.x || p.y !== g.last.y)) {
      enqueue(mirrorOp({ op: "line", x0: g.last.x, y0: g.last.y, x1: p.x, y1: p.y, c: currentColor(), size: sizeRef.current }));
      g.last = p;
      return;
    }
    if (g.mode === "shape" && g.start && (p.x !== g.last?.x || p.y !== g.last?.y)) {
      g.last = p;
      const m = metaRef.current!;
      const op = shapeOp(toolRef.current, g.start, p, e.shiftKey);
      preview.current.clear();
      if (op) {
        try {
          const r = applyOps(EMPTY.repeat(m.w * m.h), m.w, m.h, mirrorOp(op).map((o) => ({ ...o, c: (o as { c?: unknown }).c ?? "#000000" }) as Op), palRef.current);
          r.board.forEach((ch, i) => { if (ch !== EMPTY) preview.current.set(i, (op as { c?: unknown }).c === null ? EMPTY : ch); });
        } catch { /* ignore preview errors */ }
      }
      dirty.current = true;
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g.mode === "shape" && g.start && g.last) {
      const op = shapeOp(toolRef.current, g.start, g.last, e.shiftKey);
      preview.current.clear();
      dirty.current = true;
      if (op) enqueue(mirrorOp(op));
    }
    if (pointers.current.size === 0) gesture.current = { mode: "none" };
  };

  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const c = canvasRef.current!, rect = c.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const v = view.current;
    if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022));
      const zoom = Math.max(0.5, Math.min(64, v.zoom * factor));
      v.px = mx - (mx - v.px) * (zoom / v.zoom);
      v.py = my - (my - v.py) * (zoom / v.zoom);
      v.zoom = zoom;
    } else {
      v.px -= e.deltaX; v.py -= e.deltaY;
    }
    dirty.current = true;
  }, []);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  // keyboard
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (e.code === "Space") { spaceDown.current = true; e.preventDefault(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
      if (t) { setTool(t.id); return; }
      if (e.key === "m") setMirror((v) => !v);
      else if (e.key === "[") setSize((s) => Math.max(1, s - 1));
      else if (e.key === "]") setSize((s) => Math.min(8, s + 1));
      else if (e.key === "0") fit();
      else if (e.key === "+" || e.key === "=") { view.current.zoom = Math.min(64, view.current.zoom * 1.25); dirty.current = true; }
      else if (e.key === "-") { view.current.zoom = Math.max(0.5, view.current.zoom / 1.25); dirty.current = true; }
      else if (e.key === "Enter") { (document.getElementById("chat-input") as HTMLInputElement | null)?.focus(); e.preventDefault(); }
    };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") spaceDown.current = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [fit]);

  // ---------------------------------------------------------------- actions
  const sendChat = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = chat.trim();
    if (!text) return;
    setChat("");
    try {
      const r = await api<{ results: { correct?: boolean; close?: boolean; message?: string }[] }>(`/api/rooms/${roomId}/ops`, { body: { ops: [{ op: "chat", text }] } });
      const res = r.results[0];
      if (res?.correct) flash("Correct! +2 points.");
      else if (res?.close) flash("So close. Keep guessing.");
    } catch (err) { flash((err as Error).message, "bad"); setChat(text); }
  };

  const gameAction = async (action: "start" | "skip") => {
    try {
      const r = await api<GameState & { word?: string }>(`/api/rooms/${roomId}/game`, { body: { action } });
      if (r.word && action === "start") flash(`Your word: ${r.word}. Draw it, no letters.`);
      refreshGame();
    } catch (e) { flash((e as Error).message, "bad"); }
  };

  const commitName = (n: string) => {
    const clean = n.trim().replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 24);
    if (!clean) { setName(getIdentity().name); return; }
    saveName(clean);
    setName(clean);
    api(`/api/rooms/${roomId}/presence`, { body: {} }).catch((e) => flash((e as Error).message, "bad"));
  };

  const clearBoard = () => {
    if (!window.confirm("Erase the whole board for everyone?")) return;
    enqueue([{ op: "clear" }]);
  };

  const myName = name;
  const visibleLog = useMemo(() => log.filter((l) => showDraws || l.kind !== "draw"), [log, showDraws]);
  const logEnd = useRef<HTMLDivElement>(null);
  useEffect(() => { logEnd.current?.scrollIntoView({ block: "end" }); }, [visibleLog.length]);

  if (error) {
    return (
      <main className="room-error">
        <p>{error}</p>
        <Link href="/" className="btn">Back to the lobby</Link>
      </main>
    );
  }

  const m = meta;
  const cooldownLeft = Math.max(0, cooldownUntil - now);
  const humans = presence.filter((p) => p.kind === "human").length;
  const agents = presence.length - humans;
  const roundLeft = game?.status === "active" && game.endsAt ? Math.max(0, Math.ceil((game.endsAt - now) / 1000)) : 0;

  return (
    <div className="room">
      <header className="room-bar">
        <Link href="/" className="wordmark small" aria-label="Chaos Whiteboard lobby"><span>CHAOS</span> <b>WHITEBOARD</b></Link>
        <div className="room-title">
          <h1>{m?.title ?? roomId}</h1>
          {m && <span className={`mode mode-${m.mode}`}>{MODE_TEXT[m.mode]}{m.locked ? ", locked" : ""}</span>}
        </div>
        <div className="room-stats" aria-live="polite">
          <span className={`dot ${conn}`} title={conn} />
          <span title="WebSocket when available, otherwise Server-Sent Events + HTTP">{conn === "live" ? `live${transport ? ` (${transport === "ws" ? "websocket" : "sse"})` : ""}` : conn}</span>
          {latency !== null && <span className="num" title="Round trip of your last write">{latency} ms</span>}
          <span className="num" title="Events in this room">seq {seqView}</span>
          <span title="People here"><i className="h">{humans}</i> humans, <i className="a">{agents}</i> agents</span>
        </div>
        <div className="room-actions">
          <label className="name-field" title="Your name. Saved in this browser.">
            <span>You</span>
            <input value={name} onChange={(e) => setName(e.target.value)} onBlur={(e) => commitName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} maxLength={24} spellCheck={false} />
          </label>
          <button className="btn hot" onClick={() => setInvite(true)}>Invite an agent</button>
          <a className="btn" href={`/api/rooms/${roomId}/board?format=png&scale=${m ? Math.max(1, Math.floor(1024 / Math.max(m.w, m.h))) : 8}`} download={`${roomId}.png`}>PNG</a>
        </div>
      </header>

      <div className="room-body">
        <section className="stage" aria-label="Canvas">
          <div className="stage-canvas" ref={wrapRef}>
            <canvas
              ref={canvasRef}
              className={`tool-${tool}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onPointerLeave={() => { hoverRef.current = null; setHover(null); dirty.current = true; }}
              onContextMenu={(e) => e.preventDefault()}
            />
            <div className="coords num" aria-hidden>{hover ? `${hover.x}, ${hover.y}` : m ? `${m.w} x ${m.h}` : ""}</div>
            {m?.mode === "place" && cooldownLeft > 0 && (
              <div className="cooldown"><div style={{ width: `${(cooldownLeft / m.cooldownMs) * 100}%` }} /><span>{(cooldownLeft / 1000).toFixed(1)} s</span></div>
            )}
            {toast && <div className={`toast ${toast.tone}`} role="status">{toast.text}</div>}
          </div>

          <nav className="dock" aria-label="Tools">
            {TOOLS.map((t) => (
              <button key={t.id} className={tool === t.id ? "on" : ""} onClick={() => setTool(t.id)} title={`${t.label} (${t.key.toUpperCase()})`} aria-label={t.label} aria-pressed={tool === t.id}>
                <svg viewBox="0 0 24 24" aria-hidden><path d={t.icon} /></svg>
              </button>
            ))}
            <span className="sep" />
            <button className={mirror ? "on" : ""} onClick={() => setMirror((v) => !v)} title="Mirror drawing left/right (M)" aria-pressed={mirror} aria-label="Mirror">
              <svg viewBox="0 0 24 24" aria-hidden><path d="M12 3v18M9 7L4 12l5 5V7zm6 0l5 5-5 5V7z" /></svg>
            </button>
            <div className="size" title="Brush size ([ and ])">
              <button onClick={() => setSize((s) => Math.max(1, s - 1))} aria-label="Smaller brush">-</button>
              <span className="num">{size}</span>
              <button onClick={() => setSize((s) => Math.min(8, s + 1))} aria-label="Bigger brush">+</button>
            </div>
            <button onClick={fit} title="Fit to screen (0)" aria-label="Fit to screen"><svg viewBox="0 0 24 24" aria-hidden><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg></button>
          </nav>

          <div className="palette" aria-label="Colors">
            <div className="current" style={{ background: tool === "eraser" ? "transparent" : color }} title={tool === "eraser" ? "Eraser" : color} />
            <div className="swatches">
              {palette.map((p, i) => (
                <button key={p + i} style={{ background: p }} className={color === p && tool !== "eraser" ? "on" : ""} title={`${p} (slot ${ALPHABET[i]})`}
                  onClick={() => { setColor(p); if (tool === "eraser" || tool === "picker" || tool === "pan") setTool("pencil"); }} aria-label={`Color ${p}`} />
              ))}
            </div>
            <label className="custom" title="Any color: new colors are added to this room's palette (max 62)">
              <input type="color" value={normHex(color) ?? "#ff3d5a"} onChange={(e) => { setColor(e.target.value); if (tool === "eraser") setTool("pencil"); }} />
              <span className="num">{color}</span>
            </label>
          </div>
        </section>

        <aside className="rail">
          {m?.theme && <p className="theme">{m.theme}</p>}

          {m?.mode === "guess" && (
            <div className="panel game">
              {game?.status === "active" ? (
                <>
                  <div className="game-row">
                    <span>{game.drawer === myName ? "You are drawing" : `${game.drawer} is drawing`}</span>
                    <span className="num big">{roundLeft}s</span>
                  </div>
                  {game.word ? <p className="secret">Your word: <b>{game.word}</b></p> : <p className="hint num">{game.hint}</p>}
                  {(game.drawer === myName || roundLeft === 0) && <button className="btn" onClick={() => gameAction("skip")}>End round</button>}
                </>
              ) : (
                <>
                  <p>{game?.lastWord ? `Last word: ${game.lastWord}${game.lastWinner ? `, guessed by ${game.lastWinner}` : ", nobody got it"}.` : "Nobody is drawing yet."}</p>
                  <button className="btn hot" onClick={() => gameAction("start")}>Draw the next word</button>
                </>
              )}
              {!!game?.scores?.length && (
                <ol className="scores">{game.scores.map((s) => <li key={s.name}><span>{s.name}</span><span className="num">{s.score}</span></li>)}</ol>
              )}
            </div>
          )}

          {m?.mode === "life" && (
            <div className="panel life">
              <button className="btn" onClick={() => api(`/api/rooms/${roomId}/ops`, { body: { ops: [{ op: "life" }] } }).catch((e) => flash(e.message, "bad"))}>Step</button>
              <button className={`btn ${lifeAuto ? "hot" : ""}`} onClick={() => setLifeAuto((v) => !v)} aria-pressed={lifeAuto}>{lifeAuto ? "Stop" : "Run"}</button>
              <button className="btn" onClick={() => enqueue([{ op: "noise", density: 0.18, colors: palRef.current.slice(0, 9) }])}>Seed</button>
            </div>
          )}

          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={railTab === "chat"} onClick={() => setRailTab("chat")}>Chat</button>
            <button role="tab" aria-selected={railTab === "people"} onClick={() => setRailTab("people")}>Here now <span className="num">{presence.length}</span></button>
            {railTab === "chat" && (
              <label className="toggle"><input type="checkbox" checked={showDraws} onChange={(e) => setShowDraws(e.target.checked)} /> show strokes</label>
            )}
          </div>

          {railTab === "people" ? (
            <ul className="people">
              {presence.length === 0 && <li className="empty">Nobody else yet. Invite an agent to get things moving.</li>}
              {presence.map((p) => (
                <li key={p.name} className={p.kind}>
                  <span className="who">{p.name}{p.name === myName ? " (you)" : ""}</span>
                  <span className="kind">{p.kind === "agent" ? "agent" : "human"}</span>
                  {p.status && <span className="status">{p.status}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <div className="log" aria-live="polite">
              {visibleLog.length === 0 && <p className="empty">No messages yet. Say hi, or press Enter to start typing.</p>}
              {visibleLog.map((l) => (
                <div key={l.key} className={`entry ${l.kind}`}>
                  {l.actor && (l.kind === "chat" || l.kind === "draw") && <span className={`who ${l.actorKind}`}>{l.actor}</span>}
                  <span className="text">{l.text}</span>
                </div>
              ))}
              <div ref={logEnd} />
            </div>
          )}

          <form className="say" onSubmit={sendChat}>
            <input id="chat-input" value={chat} onChange={(e) => setChat(e.target.value)} maxLength={280}
              placeholder={m?.mode === "guess" && game?.status === "active" && game.drawer !== myName ? "Type your guess" : "Say something"} autoComplete="off" />
            <button className="btn" type="submit">Send</button>
          </form>

          {m && m.mode !== "place" && m.mode !== "guess" && (
            <button className="btn ghost danger" onClick={clearBoard}>Erase board</button>
          )}
        </aside>
      </div>

      {invite && m && <InviteAgent room={m.id} title={m.title} onClose={() => setInvite(false)} />}
    </div>
  );
}
