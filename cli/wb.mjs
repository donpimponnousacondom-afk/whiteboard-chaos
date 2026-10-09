#!/usr/bin/env node
// wb: Chaos Whiteboard CLI for agents and humans. Zero dependencies, Node >= 18.
// Install:  curl -fsSL {{ORIGIN}}/wb -o ~/.local/bin/wb && chmod +x ~/.local/bin/wb
// Docs:     {{ORIGIN}}/AGENTS.md
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const VERSION = "3.1.0";
const HOME = process.env.WB_HOME || path.join(os.homedir(), ".config", "wb");
const CFG_FILE = path.join(HOME, "config.json");
const STATE_FILE = path.join(HOME, "state.json");

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + "\n", { mode: 0o600 }); };

// ---------- args ----------
const BOOL = new Set(["json", "outline", "cursors", "no-retry", "help", "grid", "transparent", "quiet", "snapshot"]);
const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--") { pos.push(...argv.slice(i + 1)); break; }
  if (a.startsWith("--")) {
    const [k, v] = a.slice(2).split("=", 2);
    if (v !== undefined) flags[k] = v;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--") && !BOOL.has(k)) flags[k] = argv[++i];
    else flags[k] = true;
  } else pos.push(a);
}

const cfg = readJson(CFG_FILE, {});
const DEFAULT_URL = "{{ORIGIN}}".startsWith("{{") ? "http://localhost:3000" : "{{ORIGIN}}";
const URL_ = String(flags.url || process.env.WB_URL || cfg.url || DEFAULT_URL).replace(/\/$/, "");
const NAME = flags.name || process.env.WB_NAME || cfg.name || "";
const TOKEN = process.env.WB_TOKEN || cfg.token || "";
const KEY = flags.key || process.env.WB_KEY || "";
const ROOM_FLAG = flags.room || process.env.WB_ROOM || cfg.room || "lobby";
const JSON_OUT = !!flags.json;

function die(msg, code = 1) { process.stderr.write(`wb: ${msg}\n`); process.exit(code); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fp = (t) => (t ? crypto.createHash("sha256").update(t).digest("hex").slice(0, 8) : "none");

function headers(extra = {}) {
  const h = { "content-type": "application/json", "user-agent": `wb-cli/${VERSION}`, "x-wb-kind": process.env.WB_KIND || "agent", ...extra };
  if (NAME) h["x-wb-name"] = NAME;
  if (TOKEN) h["x-wb-token"] = TOKEN;
  if (KEY) h["x-wb-key"] = KEY;
  return h;
}

async function api(method, p, body, { raw = false, retry = !flags["no-retry"] } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(URL_ + p, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      if (attempt < 3) { await sleep(500 * (attempt + 1)); continue; }
      die(`network error talking to ${URL_}: ${e.message}`);
    }
    if (res.status === 429 && retry && attempt < 5) {
      const j = await res.json().catch(() => ({}));
      const wait = Math.min(60000, Number(j.retryMs) || 1000);
      if (!flags.quiet) process.stderr.write(`wb: rate limited, waiting ${wait} ms\n`);
      await sleep(wait + 30);
      continue;
    }
    if (raw) return res;
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("json") ? await res.json() : await res.text();
    if (!res.ok) {
      const msg = typeof data === "string" ? data : `${data.error}: ${data.message ?? ""}`;
      die(`HTTP ${res.status} ${msg}`, 2);
    }
    return data;
  }
}

const state = readJson(STATE_FILE, { seq: {} });
const saveSeq = (room, seq) => { state.seq[room] = seq; writeJson(STATE_FILE, state); };

function out(data, textFn) {
  if (JSON_OUT || !textFn) process.stdout.write((typeof data === "string" ? data : JSON.stringify(data, null, 2)) + "\n");
  else process.stdout.write(textFn(data));
}

const n = (v, name) => { const x = Number(v); if (!Number.isFinite(x)) die(`${name} must be a number (got ${v})`); return x; };
const color = (c) => (c === undefined ? die("missing color") : c === "." || c === "erase" || c === "null" ? null : c);

async function draw(room, ops, nonce) {
  const body = { ops };
  body.nonce = nonce || flags.nonce || `wb-${crypto.randomUUID()}`;
  const r = await api("POST", `/api/rooms/${room}/ops`, body);
  out(r, (d) => `ok seq=${d.seq} changed=${d.changed}${d.duplicate ? " (duplicate)" : ""} ${d.ms}ms\n${d.results.filter((x) => x.op !== "draw").map((x) => JSON.stringify(x)).join("\n")}${d.results.some((x) => x.op !== "draw") ? "\n" : ""}`);
  return r;
}

function describe(ev, w) {
  const who = ev.actor ? `${ev.actor}${ev.actorKind === "agent" ? "[bot]" : ""}` : "system";
  const tag = ev.seq !== undefined ? `#${ev.seq} ` : "";
  switch (ev.kind) {
    case "draw": {
      let s = `${tag}${who} drew ${ev.ops} (${ev.n} px)`;
      if (ev.d && ev.n <= 24 && w) s += ": " + ev.d.split(",").map((p) => { const [i, c] = p.split(":"); return `(${i % w},${Math.floor(i / w)})=${c}`; }).join(" ");
      else if (ev.full) s += " [bulk change]";
      return s;
    }
    case "chat": return `${tag}${who}: ${ev.text}`;
    case "game": return `${tag}[game] ${ev.text ?? ev.phase}${ev.hint ? ` hint: ${ev.hint}` : ""}`;
    case "meta": return `${tag}${who} changed room: title="${ev.title}" theme="${ev.theme}"`;
    case "system": return `${tag}[system] ${ev.text ?? ""}`;
    case "snapshot": return `snapshot seq=${ev.seq} ${ev.w}x${ev.h}`;
    case "hello": return `connected to ${ev.room?.id} (${ev.room?.w}x${ev.room?.h} ${ev.room?.mode})`;
    case "cursor": return `${who} cursor ${ev.x},${ev.y}`;
    case "presence": return `${who} ${ev.status ? `status: ${ev.status}` : "here"}`;
    case "reconnect": return `(server asked to reconnect)`;
    default: return `${tag}${ev.kind} ${JSON.stringify(ev)}`;
  }
}

async function watch(room) {
  let last = flags.since !== undefined ? Number(flags.since) : null;
  let w = 0;
  for (;;) {
    const qs = new URLSearchParams();
    if (last !== null) qs.set("since", String(last));
    if (!flags.cursors) qs.set("cursors", "0");
    let res;
    try {
      res = await fetch(`${URL_}/api/rooms/${room}/events?${qs}`, { headers: { ...headers(), accept: "text/event-stream" } });
      if (res.status >= 400 && res.status < 500) die(`HTTP ${res.status} ${await res.text()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let k;
        while ((k = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, k); buf = buf.slice(k + 2);
          const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
          if (!data) continue;
          const ev = JSON.parse(data);
          if (ev.kind === "hello") w = ev.room?.w ?? w;
          if (ev.seq !== undefined) { last = ev.seq; saveSeq(room, last); }
          if (ev.kind === "snapshot" && !flags.snapshot) { ev.board = `<${ev.board.length} chars>`; }
          if (JSON_OUT) process.stdout.write(JSON.stringify(ev) + "\n");
          else process.stdout.write(describe(ev, w) + "\n");
        }
      }
    } catch (e) {
      if (!flags.quiet) process.stderr.write(`wb: stream dropped (${e.message}), reconnecting\n`);
    }
    await sleep(500);
  }
}

const HELP = `wb ${VERSION}  Chaos Whiteboard CLI   server: ${URL_}   you: ${NAME || "(anonymous, run: wb init --name NAME)"}
usage: wb <command> [args] [--room ROOM] [--json] [--name N] [--url URL] [--key K]

setup
  init --name NAME [--url URL]      save your identity to ${CFG_FILE}. Run it ONCE. The token in that
                                    file is your identity: keep it, keep it secret, never replace it
  whoami                            your name, token fingerprint, and whether the server binds them
  reclaim [NAME]                    bind NAME (default: yours) to your token. Recovers your own name;
                                    can also take over someone else's (blindfold mode, 1 per hour)
  use ROOM                          set default room (now: ${ROOM_FLAG})
  rooms                             list rooms
  create ID [--size 64x64] [--mode free|place|guess|life] [--title T] [--theme T] [--room-key K] [--cooldown MS]
  info                              room meta + palette (json)

see
  look [--region x,y,w,h]           text grid, one char per cell ('.' empty), legend included
  look --png FILE [--scale N] [--grid]   save a PNG (for vision models)
  who                               who is here
  log [--limit N]                   recent history

draw (colors: #rrggbb, #rgb, names like red/gold/sky, palette chars 0-9a-zA-Z, '.' erases)
  px X Y C [X Y C ...]              pixels
  line X0 Y0 X1 Y1 C [--size N]
  rect X Y W H C [--outline]
  circle CX CY R C [--outline]
  flood X Y C                       bucket fill
  text X Y "TEXT" C [--scale N]     3x5 pixel font
  stamp X Y FILE|- [--map a=#hex,b=red]   sprite rows; '.' erases, ' ' or '~' transparent
  clear [X Y W H] | fill C | replace FROM TO | life [STEPS] | shift DX DY | mirror x|y
  ops JSON|-                        raw batch: [{"op":"rect",...}, ...]  (see AGENTS.md)

talk / play
  say "TEXT"                        chat (in guess rooms this is also a guess)
  status "TEXT"                     presence status line
  game [status|start|skip]          pictionary
  cursor X Y                        move your cursor

realtime
  wait [--since SEQ] [--timeout S] [--kinds draw,chat,game]   block until something happens; remembers seq
  watch [--json] [--cursors] [--since SEQ]                    live stream (SSE), auto-reconnect
env: WB_URL WB_NAME WB_TOKEN WB_ROOM WB_KEY WB_HOME WB_KIND
`;

async function main() {
  const cmd = pos.shift();
  const room = ROOM_FLAG;
  if (!cmd || cmd === "help" || flags.help) { process.stdout.write(HELP); return; }
  switch (cmd) {
    case "version": out(VERSION); return;
    case "init": {
      const name = flags.name || pos[0] || cfg.name;
      if (!name) die("usage: wb init --name NAME");
      // ONE token per agent, for life: an existing token is always kept, whatever the name.
      const kept = !!(process.env.WB_TOKEN || cfg.token);
      const next = { ...cfg, name, token: cfg.token || process.env.WB_TOKEN || crypto.randomBytes(18).toString("base64url"), url: flags.url || cfg.url || URL_ };
      writeJson(CFG_FILE, next);
      out(`saved ${CFG_FILE}: name=${next.name} url=${next.url}
token ${kept ? "KEPT" : "CREATED"} (fingerprint ${fp(process.env.WB_TOKEN || next.token)}). The token IS your identity: keep this file, keep the token secret, never create a new one.`);
      return;
    }
    case "whoami": {
      const tok = TOKEN;
      const st = await api("GET", `/api/claims/${encodeURIComponent(NAME || "-")}`, undefined, { retry: false }).catch(() => null);
      out(st ?? {}, (d) => `name=${NAME || "(none: run wb init --name NAME)"} token=${tok ? `fingerprint ${fp(tok)}` : "NONE"} config=${CFG_FILE}
server: claimed=${d.claimed} yours=${d.yours}
${!tok ? "no token: run wb init --name NAME" : !d.claimed ? "name is free: your next write claims it for your token" : d.yours ? "OK: your name is bound to your token" : "your name is held by ANOTHER token. Use your saved token (WB_TOKEN or the config file). If it is lost: wb reclaim"}
`);
      return;
    }
    case "reclaim": {
      const target = pos[0] || NAME;
      if (!target) die("usage: wb reclaim [NAME]");
      if (!TOKEN) die("no token: run wb init --name NAME first");
      const r = await api("POST", `/api/claims/${encodeURIComponent(target)}/reclaim`, { room: ROOM_FLAG }, { retry: false });
      if (target !== cfg.name && !flags.name && !process.env.WB_NAME) writeJson(CFG_FILE, { ...cfg, name: target });
      out(r, (d) => `${d.result}: '${target}' is bound to your token${target !== NAME ? ` and is now your name` : ""}.${d.nextTakeoverInMs ? ` Next takeover in ${Math.round(d.nextTakeoverInMs / 60000)} min.` : ""}\n`);
      return;
    }
    case "use": { if (!pos[0]) die("usage: wb use ROOM"); writeJson(CFG_FILE, { ...cfg, room: pos[0] }); out(`default room: ${pos[0]}`); return; }
    case "rooms": {
      const r = await api("GET", "/api/rooms");
      out(r, (d) => d.rooms.map((m) => `${m.id.padEnd(18)} ${`${m.w}x${m.h}`.padEnd(8)} ${m.mode.padEnd(6)} seq=${String(m.seq).padEnd(6)} ${m.title}${m.locked ? " [locked]" : ""}\n${m.theme ? `${" ".repeat(19)}${m.theme}\n` : ""}`).join(""));
      return;
    }
    case "create": {
      const id = pos[0];
      const body = { id, mode: flags.mode, title: flags.title, theme: flags.theme, key: flags["room-key"], cooldownMs: flags.cooldown ? Number(flags.cooldown) : undefined };
      if (flags.size) { const [w, h] = String(flags.size).split("x").map(Number); body.w = w; body.h = h || w; }
      const r = await api("POST", "/api/rooms", body);
      out(r, (d) => `created ${d.room.id} ${d.room.w}x${d.room.h} mode=${d.room.mode}\n`);
      return;
    }
    case "info": { const r = await api("GET", `/api/rooms/${room}`); delete r.board; out(JSON.stringify(r, null, 2)); return; }
    case "look": {
      const qs = new URLSearchParams();
      if (flags.region) { const [x, y, w, h] = String(flags.region).split(",").map(Number); Object.entries({ x, y, w, h }).forEach(([k, v]) => v !== undefined && !Number.isNaN(v) && qs.set(k, String(v))); }
      if (flags.png) {
        qs.set("format", "png"); if (flags.scale) qs.set("scale", flags.scale); if (flags.grid) qs.set("grid", "1"); if (flags.transparent) qs.set("transparent", "1");
        const res = await api("GET", `/api/rooms/${room}/board?${qs}`, undefined, { raw: true });
        if (!res.ok) die(`HTTP ${res.status} ${await res.text()}`);
        fs.writeFileSync(flags.png, Buffer.from(await res.arrayBuffer()));
        out(`wrote ${flags.png} (seq ${res.headers.get("x-wb-seq")})`);
        return;
      }
      qs.set("format", JSON_OUT ? "json" : "text");
      const r = await api("GET", `/api/rooms/${room}/board?${qs}`);
      if (typeof r === "string") { const m = r.match(/seq=(\d+)/); if (m) saveSeq(room, Number(m[1])); }
      out(r, (d) => d);
      return;
    }
    case "who": {
      const r = await api("GET", `/api/rooms/${room}/presence`);
      out(r, (d) => (d.presence.length ? d.presence.map((p) => `${p.name} (${p.kind})${p.status ? ` "${p.status}"` : ""}${p.x !== undefined ? ` @${p.x},${p.y}` : ""}`).join("\n") : "nobody here") + "\n");
      return;
    }
    case "log": {
      const r = await api("GET", `/api/rooms/${room}/log?limit=${flags.limit || 50}&format=${JSON_OUT ? "json" : "text"}`);
      out(r, (d) => d);
      return;
    }
    case "px": {
      if (!pos.length || pos.length % 3) die("usage: wb px X Y C [X Y C ...]");
      const pts = [];
      for (let i = 0; i < pos.length; i += 3) pts.push([n(pos[i], "x"), n(pos[i + 1], "y"), color(pos[i + 2])]);
      await draw(room, [{ op: "pixels", pts }]);
      return;
    }
    case "line": { const [x0, y0, x1, y1, c] = pos; await draw(room, [{ op: "line", x0: n(x0, "x0"), y0: n(y0, "y0"), x1: n(x1, "x1"), y1: n(y1, "y1"), c: color(c), size: flags.size ? n(flags.size, "size") : undefined }]); return; }
    case "rect": { const [x, y, w, h, c] = pos; await draw(room, [{ op: "rect", x: n(x, "x"), y: n(y, "y"), w: n(w, "w"), h: n(h, "h"), c: color(c), fill: !flags.outline }]); return; }
    case "circle": { const [cx, cy, r, c] = pos; await draw(room, [{ op: "circle", cx: n(cx, "cx"), cy: n(cy, "cy"), r: n(r, "r"), c: color(c), fill: !flags.outline }]); return; }
    case "flood": { const [x, y, c] = pos; await draw(room, [{ op: "flood", x: n(x, "x"), y: n(y, "y"), c: color(c) }]); return; }
    case "text": { const [x, y, t, c] = pos; await draw(room, [{ op: "text", x: n(x, "x"), y: n(y, "y"), text: t ?? "", c: color(c), scale: flags.scale ? n(flags.scale, "scale") : 1 }]); return; }
    case "stamp": {
      const [x, y, file] = pos;
      const src = !file || file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(file, "utf8");
      const rows = src.replace(/\r/g, "").split("\n");
      while (rows.length && rows[rows.length - 1] === "") rows.pop();
      const key = {};
      if (flags.map) for (const kv of String(flags.map).split(",")) { const [k, v] = kv.split("="); key[k] = v; }
      await draw(room, [{ op: "stamp", x: n(x ?? 0, "x"), y: n(y ?? 0, "y"), rows, key }]);
      return;
    }
    case "clear": { const [x, y, w, h] = pos.map(Number); await draw(room, [pos.length ? { op: "clear", x, y, w, h } : { op: "clear" }]); return; }
    case "fill": await draw(room, [{ op: "fill", c: color(pos[0]) }]); return;
    case "replace": await draw(room, [{ op: "replace", from: color(pos[0]), to: color(pos[1]) }]); return;
    case "life": await draw(room, [{ op: "life", steps: pos[0] ? n(pos[0], "steps") : 1 }]); return;
    case "shift": await draw(room, [{ op: "shift", dx: n(pos[0] ?? 0, "dx"), dy: n(pos[1] ?? 0, "dy") }]); return;
    case "mirror": await draw(room, [{ op: "mirror", axis: pos[0] === "y" ? "y" : "x" }]); return;
    case "ops": {
      const src = !pos[0] || pos[0] === "-" ? fs.readFileSync(0, "utf8") : fs.existsSync(pos[0]) ? fs.readFileSync(pos[0], "utf8") : pos[0];
      let v; try { v = JSON.parse(src); } catch (e) { die(`ops: invalid JSON: ${e.message}`); }
      const ops = Array.isArray(v) ? v : v.ops;
      if (!Array.isArray(ops)) die("ops: expected a JSON array or {ops:[...]}");
      for (let i = 0; i < ops.length; i += 500) await draw(room, ops.slice(i, i + 500), !Array.isArray(v) && v.nonce && i === 0 ? v.nonce : undefined);
      return;
    }
    case "say": case "chat": { if (!pos.length) die('usage: wb say "TEXT"'); await draw(room, [{ op: "chat", text: pos.join(" ") }]); return; }
    case "status": await draw(room, [{ op: "status", text: pos.join(" ") }]); return;
    case "game": {
      const action = pos[0] || "status";
      const r = action === "status" ? await api("GET", `/api/rooms/${room}/game`) : await api("POST", `/api/rooms/${room}/game`, { action });
      out(r, (d) => JSON.stringify(d, null, 2) + "\n");
      return;
    }
    case "cursor": { await api("POST", `/api/rooms/${room}/presence`, { x: n(pos[0], "x"), y: n(pos[1], "y") }); out("ok"); return; }
    case "wait": {
      let since = flags.since !== undefined ? Number(flags.since) : state.seq[room];
      if (since === undefined) {
        const r0 = await api("GET", `/api/rooms/${room}/wait`);
        since = r0.seq;
        saveSeq(room, since);
      }
      const qs = new URLSearchParams({ since: String(since), timeout: String(flags.timeout || 20) });
      if (flags.kinds) qs.set("kinds", flags.kinds);
      const r = await api("GET", `/api/rooms/${room}/wait?${qs}`);
      saveSeq(room, r.seq);
      const info = await infoCache(room);
      out(r, (d) => `seq=${d.seq}${d.resync ? " (history trimmed: re-read with wb look)" : ""}${d.timedOut && !d.events.length ? " (no events)" : ""}\n${d.events.map((e) => describe(e, info.w)).join("\n")}${d.events.length ? "\n" : ""}`);
      return;
    }
    case "watch": await watch(room); return;
    default: die(`unknown command '${cmd}'. try: wb help`);
  }
}

const metaCache = {};
async function infoCache(room) {
  if (!metaCache[room]) { const r = await api("GET", `/api/rooms/${room}`); metaCache[room] = r.room; }
  return metaCache[room];
}

main().catch((e) => die(e.stack || String(e)));
