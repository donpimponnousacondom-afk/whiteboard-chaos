// Agent tool surface shared by MCP (/api/mcp) and plain function calling
// (/api/tools + /api/tools/call). One implementation, three transports.
import { describeEvent } from "./describe";
import { gameView } from "./game";
import { HttpError } from "./http";
import { DEFAULT_PALETTE } from "./palette";
import { clampRegion, renderPng, renderText } from "./render";
import { act, commitEvent, createRoom, getRoom, MODES, publicMeta } from "./rooms";
import { getStore } from "./store";
import type { Actor } from "./types";
import { claimStatus, reclaim, type RawIdentity } from "./identity";
import { waitEvents } from "./wait";

export const OPS_DOC = `Ops (coordinates are cells, x = column from left, y = row from top, origin top-left):
  {op:"px", x, y, c}                         one pixel
  {op:"pixels", pts:[[x,y,c],...], c?}       many pixels (per-point c, or shared c)
  {op:"line", x0,y0,x1,y1, c, size?}         line, size 1..16
  {op:"rect", x,y,w,h, c, fill?}             fill defaults true; fill:false = outline
  {op:"circle", cx,cy,r, c, fill?}           fill defaults true
  {op:"flood", x,y, c}                       bucket fill (4-connected)
  {op:"text", x,y, text, c, scale?}          3x5 pixel font, each char 4 cells wide * scale
  {op:"stamp", x,y, rows:["..ab","a~~b"], key?:{a:"#ff0000"}}  sprite: palette chars or key letters, "." erases, " " or "~" = transparent
  {op:"clear", x?,y?,w?,h?}                  erase region (default whole board)
  {op:"fill", c}                             paint entire board
  {op:"replace", from, to}                   swap one color for another everywhere
  {op:"life", steps?}                        Conway's Game of Life step(s), board wraps
  {op:"shift", dx?, dy?}                     scroll the board with wraparound (animation!)
  {op:"mirror", axis:"x"|"y"}                copy left->right (x) or top->bottom (y)
  {op:"noise", density?, colors?, x?,y?,w?,h?}  random sprinkle
  {op:"chat", text}                          say something to the room
  {op:"guess", text}                         pictionary guess, PRIVATE: only you see the answer (right, close, nope)
  {op:"status", text}                        set your presence status line
  {op:"game", action:"start"|"pick"|"skip"|"status", word?} pictionary control (mode=guess rooms); pick takes a word or its number
Colors c: "#rrggbb" | "#rgb" | name (red, blue, gold, ...) | palette char "0".."9","a".."z","A".."Z" | palette index number | null or "." to erase.
New hex colors are added to the room palette (max 62), then snapped to the nearest color.`;

const roomProp = { type: "string", description: "room id, e.g. lobby, chaos, place, pictionary, life" };

export const TOOL_DEFS = [
  {
    name: "wb_rooms",
    description: "List whiteboard rooms with size, mode, theme and activity. Start here.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "wb_look",
    description: "Read a room's board. Returns a text grid (one char per cell, '.' = empty, other chars = palette slots, legend included) and/or a PNG image. For boards wider than ~100 cells, read a region.",
    input_schema: {
      type: "object",
      properties: {
        room: roomProp,
        x: { type: "integer" }, y: { type: "integer" }, w: { type: "integer" }, h: { type: "integer" },
        format: { type: "string", enum: ["text", "image", "both"], description: "default text" },
        scale: { type: "integer", description: "PNG pixels per cell, default auto" },
      },
      required: ["room"],
    },
  },
  {
    name: "wb_draw",
    description: "Apply a batch of drawing ops (and optionally chat/game ops) atomically as one event. Batch as much as you can into one call.\n" + OPS_DOC,
    input_schema: {
      type: "object",
      properties: {
        room: roomProp,
        ops: {
          type: "array", minItems: 1, maxItems: 500,
          items: { type: "object", properties: { op: { type: "string" } }, required: ["op"], additionalProperties: true },
        },
        nonce: { type: "string", description: "optional idempotency key (8-80 chars). Re-sending the same nonce is a no-op." },
        key: { type: "string", description: "write key for locked rooms" },
      },
      required: ["room", "ops"],
    },
  },
  {
    name: "wb_chat",
    description: "Send a chat message to a room. In 'guess' rooms, chat messages are also guesses.",
    input_schema: { type: "object", properties: { room: roomProp, text: { type: "string", maxLength: 280 } }, required: ["room", "text"] },
  },
  {
    name: "wb_wait",
    description: "Block until something happens in a room after seq `since` (or timeout). Returns events in order and the new seq to pass next time. Use this as your realtime loop: look -> draw -> wait -> react.",
    input_schema: {
      type: "object",
      properties: {
        room: roomProp,
        since: { type: "integer", description: "last seq you have seen; omit to just get the current seq" },
        timeout: { type: "integer", description: "seconds, 1..25 (default 20)" },
        kinds: { type: "array", items: { type: "string", enum: ["draw", "chat", "game", "meta", "system"] } },
      },
      required: ["room"],
    },
  },
  {
    name: "wb_who",
    description: "Who is in the room right now (humans and agents, cursors, status).",
    input_schema: { type: "object", properties: { room: roomProp }, required: ["room"] },
  },
  {
    name: "wb_game",
    description: "Pictionary for mode=guess rooms. status: round, hint, scores (and your options or word if you draw). start: you become the drawer and get 1, 3 or 5 secret words. pick: choose one (word or number). guess: a PRIVATE guess, only you see the result. skip: end your round.",
    input_schema: { type: "object", properties: { room: roomProp, action: { type: "string", enum: ["status", "start", "pick", "guess", "skip"] }, word: { type: "string", description: "for pick (word or 1-based number) and guess" } }, required: ["room"] },
  },
  {
    name: "wb_whoami",
    description: "Show your identity: name, token fingerprint, and whether the server still binds your name to your token. Call it first if a write fails with name_taken.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "wb_reclaim",
    description: "Bind a name to YOUR token. A free name is claimed at once. A name held by another token is taken over (blindfold mode: one takeover per token per hour). Use it to recover your own name if your token changed. Pass room to announce the takeover there (anonymously).",
    input_schema: { type: "object", properties: { name: { type: "string", description: "default: your current name" }, room: roomProp }, additionalProperties: false },
  },
  {
    name: "wb_create_room",
    description: "Create a new room/canvas. Modes: free (anything goes), place (1 px per cooldown per player), guess (pictionary), life (Game of Life).",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "[a-z0-9-], max 32 chars; omit for a random id" },
        w: { type: "integer", minimum: 4, maximum: 256 }, h: { type: "integer", minimum: 4, maximum: 256 },
        mode: { type: "string", enum: MODES },
        title: { type: "string" }, theme: { type: "string", description: "prompt/rules shown to everyone" },
        palette: { type: "array", items: { type: "string" }, description: "custom palette of #rrggbb (max 62)" },
        cooldownMs: { type: "integer", description: "place mode cooldown" },
        key: { type: "string", description: "optional write key; only holders can draw" },
      },
    },
  },
];

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface ToolResult { content: Content[]; isError?: boolean; structuredContent?: Record<string, unknown> }

const txt = (text: string, structured?: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}) });

// Tools that must work even when the caller's name is held by another token.
export const IDENTITY_TOOLS = new Set(["wb_whoami", "wb_reclaim"]);

export async function callIdentityTool(name: string, args: Record<string, unknown>, id: RawIdentity): Promise<ToolResult> {
  try {
    if (name === "wb_whoami") {
      const st = await claimStatus(id.name, id.token);
      const verdict = !id.token ? "you send no token: your name is not protected and you cannot claim it"
        : !st.claimed ? "your name is free: your next write claims it for your token"
        : st.yours ? "your name is bound to your token: all good"
        : "your name is held by ANOTHER token: use the token you saved, or wb_reclaim";
      return txt(`name=${id.name} token_fingerprint=${st.fingerprint ?? "none"} claimed=${st.claimed} yours=${st.yours}\n${verdict}\nclaims expire after ${st.claimTtlHours} h without activity. Keep your token secret and never replace it.`, st as unknown as Record<string, unknown>);
    }
    const target = String(args.name ?? id.name);
    const r = await reclaim(target, id.token, id.ip);
    if (r.result === "taken_over" && typeof args.room === "string" && args.room) {
      try { const meta = await getRoom(args.room); await commitEvent(meta, null, { kind: "system", text: `someone in a blindfold took over the name '${target}'` }); } catch { /* best effort */ }
    }
    return txt(`${r.result}: '${target}' is now bound to your token.${r.nextTakeoverInMs ? ` Next takeover allowed in ${Math.round(r.nextTakeoverInMs / 60000)} min.` : ""}${target !== id.name ? ` Use name '${target}' in your next calls.` : ""}`, r as unknown as Record<string, unknown>);
  } catch (e) {
    if (e instanceof HttpError) return { content: [{ type: "text", text: `error ${e.status} ${e.code}: ${e.message}` }], isError: true };
    throw e;
  }
}

export async function callTool(name: string, args: Record<string, unknown>, actor: Actor, signal?: AbortSignal): Promise<ToolResult> {
  try {
    return await dispatch(name, args ?? {}, actor, signal);
  } catch (e) {
    if (e instanceof HttpError) return { content: [{ type: "text", text: `error ${e.status} ${e.code}: ${e.message}${e.extra?.retryMs ? ` (retry in ${e.extra.retryMs} ms)` : ""}` }], isError: true };
    return { content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
}

async function dispatch(name: string, a: Record<string, unknown>, actor: Actor, signal?: AbortSignal): Promise<ToolResult> {
  const store = getStore();
  switch (name) {
    case "wb_rooms": {
      const rooms = await store.listRooms(50);
      const lines = rooms.map(({ meta, active, seq }) =>
        `- ${meta.id}: "${meta.title}" ${meta.w}x${meta.h} mode=${meta.mode}${meta.keyHash ? " locked" : ""} seq=${seq} active=${new Date(active).toISOString()}${meta.theme ? `\n    theme: ${meta.theme}` : ""}`);
      return txt(`you are "${actor.name}". rooms:\n${lines.join("\n")}`, { rooms: rooms.map((r) => ({ ...publicMeta(r.meta), seq: r.seq, active: r.active })) });
    }
    case "wb_look": {
      const meta = await getRoom(String(a.room));
      const snap = await store.snapshot(meta.id, meta.w * meta.h);
      const reg = clampRegion({ x: a.x as number, y: a.y as number, w: a.w as number, h: a.h as number }, meta.w, meta.h);
      const format = String(a.format ?? "text");
      const header = `# room ${meta.id} "${meta.title}" ${meta.w}x${meta.h} mode=${meta.mode} seq=${snap.seq} region x=${reg.x} y=${reg.y} w=${reg.w} h=${reg.h}${meta.theme ? `\n# theme: ${meta.theme}` : ""}`;
      const content: Content[] = [];
      if (format !== "image") {
        if (reg.w * reg.h > 16384) throw new HttpError(400, "region_too_big", "text view is limited to 16384 cells; pass x,y,w,h");
        content.push({ type: "text", text: renderText(snap.board, meta.w, snap.palette, reg, header) + `# full palette: ${snap.palette.map((p, i) => `${"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"[i]}=${p}`).join(" ")}\n` });
      }
      if (format !== "text") {
        const scale = Number(a.scale) || Math.max(2, Math.min(16, Math.floor(512 / Math.max(reg.w, reg.h))));
        const png = renderPng(snap.board, meta.w, snap.palette.length ? snap.palette : DEFAULT_PALETTE, reg, scale, meta.bg, false, true);
        content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
        if (format === "image") content.unshift({ type: "text", text: header });
      }
      return { content };
    }
    case "wb_draw": {
      const r = await act(String(a.room), actor, { ops: a.ops, nonce: a.nonce }, a.key ? String(a.key) : null);
      return txt(`ok seq=${r.seq} changed=${r.changed}${r.duplicate ? " (duplicate nonce, nothing applied)" : ""}\n${JSON.stringify(r.results)}`, r as unknown as Record<string, unknown>);
    }
    case "wb_chat": {
      const r = await act(String(a.room), actor, { ops: [{ op: "chat", text: a.text }] }, a.key ? String(a.key) : null);
      return txt(`sent. seq=${r.seq} ${JSON.stringify(r.results[0] ?? {})}`, r as unknown as Record<string, unknown>);
    }
    case "wb_wait": {
      const meta = await getRoom(String(a.room));
      const since = a.since === undefined || a.since === null ? null : Number(a.since);
      if (since !== null && (!Number.isInteger(since) || since < 0)) throw new HttpError(400, "bad_since", "since must be a non-negative integer seq");
      const timeout = Math.max(1, Math.min(25, Number(a.timeout ?? 20))) * 1000;
      const kinds = Array.isArray(a.kinds) && a.kinds.length ? (a.kinds as string[]) : null;
      const r = await waitEvents(meta, since, timeout, kinds, signal);
      const lines = r.events.map((ev) => describeEvent(ev, meta.w));
      const head = since === null ? `current seq=${r.seq}. call again with since=${r.seq}.` : r.timedOut && !r.events.length ? `no events (timeout). seq=${r.seq}` : `${r.events.length} event(s), now seq=${r.seq}${r.resync ? " (history trimmed: board snapshot included, re-read with wb_look)" : ""}`;
      return txt(`${head}\n${lines.join("\n")}`, { seq: r.seq, resync: r.resync, count: r.events.length });
    }
    case "wb_who": {
      const meta = await getRoom(String(a.room));
      const ps = await store.presenceList(meta.id, 60000);
      return txt(ps.length ? ps.map((p) => `- ${p.name} (${p.kind})${p.status ? ` "${p.status}"` : ""}${p.x !== undefined ? ` cursor ${p.x},${p.y}` : ""} ${Math.round((Date.now() - p.t) / 1000)}s ago`).join("\n") : "nobody active in the last 60 s", { presence: ps });
    }
    case "wb_game": {
      const meta = await getRoom(String(a.room));
      const action = String(a.action ?? "status");
      if (action === "status") {
        const v = await gameView(meta, actor);
        return txt(JSON.stringify(v, null, 1), v as Record<string, unknown>);
      }
      const r = await act(meta.id, actor, { ops: [{ op: "game", action, word: a.word }] }, null);
      return txt(JSON.stringify(r.results[0], null, 1), r.results[0]);
    }
    case "wb_create_room": {
      const { ownerKey, ...meta } = await createRoom(a, actor);
      return txt(`created room ${meta.id} ${meta.w}x${meta.h} mode=${meta.mode}. Owner key (shown once, keep it secret, needed to change settings): ${ownerKey}`, { ...publicMeta(meta), ownerKey });
    }
    default:
      throw new HttpError(404, "unknown_tool", `unknown tool ${name}`);
  }
}
