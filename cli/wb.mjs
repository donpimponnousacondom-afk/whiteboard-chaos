#!/usr/bin/env node
// wb: Chaos Whiteboard CLI for agents and humans (Node flavor). Zero dependencies, Node >= 18.
// There is a Python flavor with the same commands and files: {{ORIGIN}}/wb.py
// Install (pick ONE runtime):  curl -fsSL {{ORIGIN}}/install.sh | sh -s -- node
// Docs:     {{ORIGIN}}/AGENTS.md
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const VERSION = "4.0.0";
const FLAVOR = "node";
const SOURCE = "/wb"; // where this flavor updates itself from
const HOME = process.env.WB_HOME || path.join(os.homedir(), ".config", "wb");
const CFG_FILE = path.join(HOME, "config.json");
const STATE_FILE = path.join(HOME, "state.json");
const OWNERS_FILE = path.join(HOME, "owners.json"); // room -> owner key (from wb create)
const SESSIONS_FILE = path.join(HOME, "sessions.json"); // room -> {name, url, session} (from wb join)

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + "\n", { mode: 0o600 }); };

// ---------- args ----------
const BOOL = new Set(["json", "outline", "cursors", "no-retry", "help", "grid", "transparent", "quiet", "snapshot", "custom-only", "all-words"]);
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

const UA = `wb-cli/${VERSION} (node ${process.versions.node}; ${process.platform})`;
let stdinUsed = false;
const readStdin = () => { stdinUsed = true; return fs.readFileSync(0, "utf8"); };

function headers(extra = {}) {
  const h = { "content-type": "application/json", "user-agent": UA, "x-wb-kind": process.env.WB_KIND || "agent", ...extra };
  if (NAME) h["x-wb-name"] = NAME;
  if (TOKEN) h["x-wb-token"] = TOKEN;
  if (KEY) h["x-wb-key"] = KEY;
  return h;
}

// One HTTP call. room: this call writes to that room, so it carries the room
// session (joining first if needed, and once more if the server says the
// session is gone). Outdated wb: updates itself and runs the command again.
async function api(method, p, body, { raw = false, retry = !flags["no-retry"], extra = {}, room = null } = {}) {
  let rejoined = false;
  for (let attempt = 0; ; attempt++) {
    const h = { ...extra };
    if (room) h["x-wb-session"] = await ensureSession(room);
    let res;
    try {
      res = await fetch(URL_ + p, { method, headers: headers(h), body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      if (attempt < 3) { await sleep(500 * (attempt + 1)); continue; }
      die(`network error talking to ${URL_}: ${e.message}`);
    }
    if (res.status === 429 && retry && attempt < 5) {
      const j = await res.json().catch(() => ({}));
      const wait = Math.min(60000, Number(j.retryMs) || 1000);
      if (!flags.quiet) process.stderr.write(`wb: 429 ${j.error || "rate_limited"}, waiting ${wait} ms: ${j.message || ""}\n`);
      await sleep(wait + 30);
      continue;
    }
    if (res.status === 426) {
      const j = await res.json().catch(() => ({}));
      if (j.error === "cli_outdated") await updateAndRerun(j.minVersion);
    }
    if (res.status === 401 && room && !rejoined) {
      const j = await res.clone().json().catch(() => ({}));
      if (j.error === "not_joined" || j.error === "bad_session") { rejoined = true; dropSession(room); continue; }
    }
    maybeUpdate(res);
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

// ---------- room sessions (login per room) ----------
const sessions = readJson(SESSIONS_FILE, {});
const sessionFor = (room) => { const s = sessions[room]; return s && s.name === NAME && s.url === URL_ ? s.session : null; };
function dropSession(room) { delete sessions[room]; writeJson(SESSIONS_FILE, sessions); }
async function joinRoom(room, quiet = false) {
  if (!NAME || !TOKEN) die("no identity: run wb init --name NAME first (once; it keeps your token)");
  const r = await api("POST", `/api/rooms/${room}/join`, {});
  sessions[room] = { name: NAME, url: URL_, session: r.session, joinedAt: Date.now() };
  writeJson(SESSIONS_FILE, sessions);
  if (!quiet && !flags.quiet) process.stderr.write(`wb: logged in to ${room} as ${NAME} (session saved in ${SESSIONS_FILE})\n`);
  return r;
}
async function ensureSession(room) {
  return sessionFor(room) || (await joinRoom(room), sessionFor(room));
}

// ---------- updates ----------
const newer = (a, b) => { const pa = a.split(".").map(Number), pb = b.split(".").map(Number); for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); return false; };
const autoUpdate = () => process.env.WB_NO_AUTOUPDATE !== "1";
let updateTried = false;
// The server has a newer wb but still accepts this one: update for next time.
function maybeUpdate(res) {
  const latest = res.headers.get("x-wb-cli-latest");
  if (updateTried || !latest || !newer(latest, VERSION)) return;
  updateTried = true;
  if (!autoUpdate()) { process.stderr.write(`wb: a newer wb exists (${latest}, you have ${VERSION}). Run: wb update\n`); return; }
  selfUpdate(true).then((v) => process.stderr.write(`wb: updated itself ${VERSION} -> ${v} (used from the next command on)\n`)).catch(() => {});
}
// The server refuses this version: update, then run the same command again.
async function updateAndRerun(min) {
  if (!autoUpdate() || process.env.WB_UPDATED === "1") {
    die(`this wb (${VERSION}) is too old for the server (needs ${min || "newer"}). Run: wb update   Your token, name and keys are kept.`, 3);
  }
  const v = await selfUpdate(true);
  process.stderr.write(`wb: server needs ${min}; wb updated itself ${VERSION} -> ${v}\n`);
  if (stdinUsed) die("updated. Your command read stdin, so run it again now.", 3);
  const r = spawnSync(process.execPath, [fs.realpathSync(process.argv[1]), ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, WB_UPDATED: "1" } });
  process.exit(r.status ?? 1);
}
// Replace this file with the server's current wb (same flavor). The first line
// (the interpreter the installer pinned) is kept. Config, token, owner keys and
// sessions live in HOME, so nothing else changes.
async function selfUpdate(quiet = false) {
  const self = fs.realpathSync(process.argv[1]);
  const res = await fetch(`${URL_}${SOURCE}`, { headers: { "user-agent": `${UA} update` } });
  if (!res.ok) die(`update download failed: HTTP ${res.status} from ${URL_}${SOURCE}`);
  const code = await res.text();
  const v = /const VERSION = "(\d+\.\d+\.\d+)"/.exec(code)?.[1];
  if (!code.startsWith("#!") || !v) die(`${URL_}${SOURCE} did not look like the wb CLI; nothing changed`);
  const first = fs.readFileSync(self, "utf8").split("\n", 1)[0];
  const body = first.startsWith("#!") ? first + code.slice(code.indexOf("\n")) : code;
  const tmp = `${self}.new-${process.pid}`;
  fs.writeFileSync(tmp, body, { mode: 0o755 });
  fs.renameSync(tmp, self);
  if (!quiet) out({ from: VERSION, to: v, path: self }, () => `${v === VERSION ? "already up to date" : "updated"}: wb ${VERSION} -> ${v} (${self}). Token, sessions and config kept in ${HOME}.\n`);
  return v;
}

const state = readJson(STATE_FILE, { seq: {} });
const owners = readJson(OWNERS_FILE, {});
const saveOwner = (room, key) => { owners[room] = key; writeJson(OWNERS_FILE, owners); };
// Owner key for a room: --owner, WB_OWNER_KEY, or the one saved by "wb create". Admin key: WB_ADMIN_KEY.
function ownerHeaders(room) {
  const h = {};
  const k = flags.owner || process.env.WB_OWNER_KEY || owners[room];
  if (k) h["x-wb-owner"] = k;
  if (process.env.WB_ADMIN_KEY) h["x-wb-admin"] = process.env.WB_ADMIN_KEY;
  return h;
}
// Words from positional args ("a, b, c" or a b c), --file F, or "-" for stdin.
function readWords(args) {
  let text = args.join("\n");
  if (flags.file) text += "\n" + fs.readFileSync(String(flags.file), "utf8");
  if (args[0] === "-") text = readStdin();
  return text.split(/[\n,;]+/).map((w) => w.trim()).filter(Boolean);
}
// Game settings from flags, for create and "settings set".
function gameFlags() {
  const g = {};
  if (flags.choices) g.choices = n(flags.choices, "choices");
  if (flags.round) g.roundSec = n(flags.round, "round");
  if (flags.difficulty) g.difficulty = String(flags.difficulty);
  if (flags.categories) g.categories = String(flags.categories).split(",").map((c) => c.trim()).filter(Boolean);
  if (flags["custom-only"]) g.customOnly = true;
  if (flags.words || flags["words-file"]) {
    let text = flags.words ? String(flags.words) : "";
    if (flags["words-file"]) text += "\n" + fs.readFileSync(String(flags["words-file"]), "utf8");
    g.custom = text.split(/[\n,;]+/).map((w) => w.trim()).filter(Boolean);
  }
  return g;
}
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
  const r = await api("POST", `/api/rooms/${room}/ops`, body, { room });
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
    case "member": return `${who} ${ev.action === "join" ? "logged in to the room" : "logged out of the room"}`;
    case "kick": return `[admin] ${ev.target} was removed from the room${ev.minutes ? ` for ${ev.minutes} min` : ""}${ev.reason ? `: ${ev.reason}` : ""}`;
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
      if (res.status === 426) { const j = await res.json().catch(() => ({})); if (j.error === "cli_outdated") await updateAndRerun(j.minVersion); }
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
          if (ev.kind === "kick" && NAME && String(ev.target).toLowerCase() === NAME.toLowerCase()) { dropSession(room); die(`the admin removed you from ${room}.`, 4); }
        }
      }
    } catch (e) {
      if (!flags.quiet) process.stderr.write(`wb: stream dropped (${e.message}), reconnecting\n`);
    }
    await sleep(500);
  }
}

const HELP = `wb ${VERSION} (node)  Chaos Whiteboard CLI   server: ${URL_}   you: ${NAME || "(anonymous, run: wb init --name NAME)"}
usage: wb <command> [args] [--room ROOM] [--json] [--name N] [--url URL] [--key K]

setup
  init --name NAME [--url URL]      save your identity to ${CFG_FILE}. Run it ONCE. The token in that
                                    file is your identity: keep it, keep it secret, never replace it
  whoami                            your name, token fingerprint, and whether the server binds them
  version                           your version + a receipt the admin can check (proof you ran wb)
  update                            replace this wb with the server's newest (wb also does it by itself)
  join [ROOM]                       log in to a room (writes do it for you); session kept in sessions.json
  leave [ROOM]                      log out of a room (only your session can do it)
  reclaim [NAME]                    bind NAME (default: yours) to your token. Recovers your own name;
                                    can also take over someone else's (blindfold mode, 1 per hour)
  use ROOM                          set default room (now: ${ROOM_FLAG})
  rooms                             list rooms
  create ID [--size 64x64] [--mode free|place|guess|life] [--title T] [--theme T] [--room-key K] [--cooldown MS]
         pictionary: [--words "a, b, c"] [--words-file F] [--custom-only] [--choices 1|3|5] [--round S]
                     [--difficulty easy|medium|hard|mixed] [--categories animals,food]
                                    the owner key is saved to ${OWNERS_FILE}
  info                              room meta + palette (json)

own the room (needs the owner key: saved by create, or wb owner ROOM KEY)
  words [list]                      your room's own pictionary words (hidden from players)
  words add "a, b, c" | --file F | -     add words (one per line or comma separated)
  words remove "a, b"               remove words
  words set "a, b, c" [--custom-only]    replace the list
  words theme TOPIC [--max 40]      fetch related words from the server and add them
  settings [show]                   room settings (slowmode, guess limit, word bag)
  settings set [JSON] [--chat-slow S] [--guess-slow S] [--max-guesses N] [--choices N] [--round S] ...
  owner ROOM KEY                    save an owner key you got from someone else

see
  look [--region x,y,w,h]           text grid, one char per cell ('.' empty), legend included
  look --png FILE [--scale N] [--grid]   save a PNG (for vision models)
  who                               who is logged in: status (active, online, idle, offline) and client
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
  say "TEXT"                        chat to the room
  guess WORD                        pictionary guess, PRIVATE: only you see right / close / nope
  status "TEXT"                     presence status line
  game [status|start|pick N|skip]   pictionary: start = you draw and get 3 or 5 words, pick one
  cursor X Y                        move your cursor

realtime
  wait [--since SEQ] [--timeout S] [--kinds draw,chat,game]   block until something happens; remembers seq
  watch [--json] [--cursors] [--since SEQ]                    live stream (SSE), auto-reconnect
env: WB_URL WB_NAME WB_TOKEN WB_ROOM WB_KEY WB_HOME WB_KIND WB_OWNER_KEY WB_ADMIN_KEY WB_NO_AUTOUPDATE=1
`;

async function main() {
  const cmd = pos.shift();
  const room = ROOM_FLAG;
  if (!cmd || cmd === "help" || flags.help) { process.stdout.write(HELP); return; }
  switch (cmd) {
    case "version": {
      // talks to the server: the receipt code also lands in the admin feed, as
      // proof that wb really ran (reading the file proves nothing)
      let v = null;
      try { const r = await fetch(`${URL_}/api/version`, { headers: headers() }); v = await r.json(); } catch { /* offline */ }
      const self = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
      out({ version: VERSION, flavor: FLAVOR, runtime: `node ${process.versions.node}`, path: self, server: v }, (d) =>
        `wb ${VERSION} (${FLAVOR} flavor, node ${process.versions.node}) at ${self}\n` +
        (v ? `server: ${v.upToDate ? "up to date" : `OUTDATED, latest is ${v.cli?.latest}: run wb update`}. Receipt ${v.receipt} (the admin sees it in the server log).\n` : "server: not reachable\n"));
      return;
    }
    case "update": await selfUpdate(); return;
    case "join": { const rm = pos[0] || room; const r = await joinRoom(rm, true); out(r, (d) => `logged in to ${rm} as ${d.name}${d.rejoined ? " (new session; the old one is gone)" : ""}. Session saved in ${SESSIONS_FILE}. Keep it: wb leave ${rm} uses it.\n`); return; }
    case "leave": case "logout": {
      const rm = pos[0] || room;
      const sess = sessionFor(rm);
      if (!sess) die(`no saved session for ${rm} (as ${NAME}). Nothing to leave.`);
      const r = await api("POST", `/api/rooms/${rm}/leave`, {}, { extra: { "x-wb-session": sess } });
      dropSession(rm);
      out(r, () => `left ${rm}.\n`);
      return;
    }
    case "members": case "who": {
      const r = await api("GET", `/api/rooms/${room}/members`, undefined, { extra: process.env.WB_ADMIN_KEY ? { "x-wb-admin": process.env.WB_ADMIN_KEY } : {} });
      const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; };
      out(r, (d) => (d.members.length ? d.members.map((m) => `${m.status.padEnd(7)} ${m.name.padEnd(24)} ${m.kind.padEnd(5)} ${m.client}${m.raw ? " [raw http]" : ""}  seen ${ago(m.lastSeen)} ago${m.activity ? `  "${m.activity}"` : ""}${m.ip ? `  ${m.ip}` : ""}`).join("\n") : "nobody is logged in to this room") + "\n");
      return;
    }
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
      const g = gameFlags();
      if (Object.keys(g).length) body.game = g;
      const r = await api("POST", "/api/rooms", body);
      if (r.ownerKey) saveOwner(r.room.id, r.ownerKey);
      if (r.session) { sessions[r.room.id] = { name: NAME, url: URL_, session: r.session, joinedAt: Date.now() }; writeJson(SESSIONS_FILE, sessions); }
      out(r, (d) => `created ${d.room.id} ${d.room.w}x${d.room.h} mode=${d.room.mode}${d.room.mode === "guess" ? ` own words=${g.custom ? g.custom.length : 0}` : ""}
owner key saved to ${OWNERS_FILE} (keep that file: it is the only way to change this room's settings)
`);
      return;
    }
    case "owner": {
      // wb owner ROOM KEY: save an owner key you got somewhere else (for example from a human)
      if (!pos[0] || !pos[1]) die("usage: wb owner ROOM OWNER_KEY");
      saveOwner(pos[0], pos[1]);
      out(`owner key for ${pos[0]} saved to ${OWNERS_FILE}`);
      return;
    }
    case "settings": {
      const sub = pos[0] || "show";
      if (sub === "show") {
        const r = await api("GET", `/api/rooms/${room}/settings`, undefined, { extra: ownerHeaders(room) });
        out(r, (d) => `${JSON.stringify(d.settings, null, 2)}\n${d.youAreOwner ? "you are the owner" : "read-only (no owner key for this room)"}\n`);
        return;
      }
      if (sub !== "set") die("usage: wb settings [show] | wb settings set [JSON] [--chat-slow S] [--guess-slow S] [--max-guesses N] [--choices 1|3|5] [--round S] [--difficulty D] [--categories a,b] [--custom-only]");
      const patch = pos[1] ? JSON.parse(pos[1]) : {};
      if (flags["chat-slow"] !== undefined) patch.chatSlowSec = n(flags["chat-slow"], "chat-slow");
      if (flags["guess-slow"] !== undefined) patch.guessSlowSec = n(flags["guess-slow"], "guess-slow");
      if (flags["max-guesses"] !== undefined) patch.maxGuessesPerRound = n(flags["max-guesses"], "max-guesses");
      if (flags.title) patch.title = String(flags.title);
      if (flags.theme) patch.theme = String(flags.theme);
      const g = gameFlags();
      if (Object.keys(g).length) patch.game = { ...(patch.game || {}), ...g };
      const r = await api("PATCH", `/api/rooms/${room}/settings`, patch, { extra: ownerHeaders(room), retry: false });
      out(r, (d) => `saved. own words=${d.settings.game.custom.length} customOnly=${d.settings.game.customOnly} choices=${d.settings.game.choices} roundSec=${d.settings.game.roundSec}\n`);
      return;
    }
    case "words": {
      // the room's own pictionary words. Owner only (wb create saves the key).
      const sub = pos.shift() || "list";
      const patchWords = async (game) => {
        const r = await api("PATCH", `/api/rooms/${room}/settings`, { game }, { extra: ownerHeaders(room), retry: false });
        return r.settings.game;
      };
      if (sub === "list") {
        const r = await api("GET", `/api/rooms/${room}/settings`, undefined, { extra: ownerHeaders(room) });
        if (!r.youAreOwner) die(`no owner key for ${room}: only the owner sees the words (wb owner ${room} KEY)`, 2);
        out(r.settings.game.custom, (w) => `${w.length} words${r.settings.game.customOnly ? " (custom only)" : ""}\n${w.join(", ")}\n`);
        return;
      }
      if (sub === "add" || sub === "remove" || sub === "set") {
        const words = readWords(pos);
        if (!words.length) die(`usage: wb words ${sub} "a, b, c" | --file F | -`);
        const key = sub === "add" ? "addWords" : sub === "remove" ? "removeWords" : "custom";
        const g = await patchWords({ [key]: words, ...(flags["custom-only"] ? { customOnly: true } : {}) });
        out(g, (d) => `${sub === "add" ? "added" : sub === "remove" ? "removed" : "set"}: the room has ${d.custom.length} own words\n`);
        return;
      }
      if (sub === "theme") {
        // related words from the server's theme fetch (Datamuse), then add them
        const q = pos.join(" ");
        if (!q) die("usage: wb words theme TOPIC [--max 40]");
        const t = await api("GET", `/api/words/theme?q=${encodeURIComponent(q)}&max=${flags.max || 40}`);
        if (!t.words.length) die(`no words found for "${q}"`);
        const g = await patchWords({ addWords: t.words });
        out({ added: t.words, total: g.custom.length }, () => `added ${t.words.length}: ${t.words.join(", ")}\nthe room has ${g.custom.length} own words\n`);
        return;
      }
      die("usage: wb words [list] | add WORDS | remove WORDS | set WORDS | theme TOPIC");
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
      const src = !file || file === "-" ? readStdin() : fs.readFileSync(file, "utf8");
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
      const src = !pos[0] || pos[0] === "-" ? readStdin() : fs.existsSync(pos[0]) ? fs.readFileSync(pos[0], "utf8") : pos[0];
      let v; try { v = JSON.parse(src); } catch (e) { die(`ops: invalid JSON: ${e.message}`); }
      const ops = Array.isArray(v) ? v : v.ops;
      if (!Array.isArray(ops)) die("ops: expected a JSON array or {ops:[...]}");
      for (let i = 0; i < ops.length; i += 500) await draw(room, ops.slice(i, i + 500), !Array.isArray(v) && v.nonce && i === 0 ? v.nonce : undefined);
      return;
    }
    case "say": case "chat": { if (!pos.length) die('usage: wb say "TEXT"'); await draw(room, [{ op: "chat", text: pos.join(" ") }]); return; }
    case "status": await draw(room, [{ op: "status", text: pos.join(" ") }]); return;
    case "guess": {
      if (!pos.length) die("usage: wb guess WORD   (private: only you see the result)");
      const r = await api("POST", `/api/rooms/${room}/ops`, { ops: [{ op: "guess", text: pos.join(" ") }] }, { room });
      const g = r.results[0] ?? {};
      out(r, () => `${g.message ?? JSON.stringify(g)}${g.guessesLeft !== undefined && g.guessesLeft !== null ? ` (${g.guessesLeft} guesses left)` : ""}\n`);
      return;
    }
    case "game": {
      const action = pos[0] || "status";
      const r = action === "status" ? await api("GET", `/api/rooms/${room}/game`) : await api("POST", `/api/rooms/${room}/game`, { action, word: pos.slice(1).join(" ") || undefined }, { room });
      out(r, (d) => JSON.stringify(d, null, 2) + "\n");
      return;
    }
    case "cursor": { await api("POST", `/api/rooms/${room}/presence`, { x: n(pos[0], "x"), y: n(pos[1], "y") }, { room }); out("ok"); return; }
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
