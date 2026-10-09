// Drawing ops -> cell changes. Pure functions, no I/O.
// The same module runs in the browser (tool previews) and on the server.

import { glyph, FONT_H, FONT_W } from "./font";
import { ALPHABET, EMPTY, NAMED, normHex, nearestSlot, slotToChar } from "./palette";

export type ColorSpec = string | number | null | undefined;

export type Op =
  | { op: "px"; x: number; y: number; c?: ColorSpec }
  | { op: "pixels"; pts: [number, number, ColorSpec?][]; c?: ColorSpec }
  | { op: "line"; x0: number; y0: number; x1: number; y1: number; c?: ColorSpec; size?: number }
  | { op: "rect"; x: number; y: number; w: number; h: number; c?: ColorSpec; fill?: boolean }
  | { op: "circle"; cx: number; cy: number; r: number; c?: ColorSpec; fill?: boolean }
  | { op: "flood"; x: number; y: number; c?: ColorSpec }
  | { op: "text"; x: number; y: number; text: string; c?: ColorSpec; scale?: number }
  | { op: "stamp"; x: number; y: number; rows: string[]; key?: Record<string, ColorSpec> }
  | { op: "clear"; x?: number; y?: number; w?: number; h?: number }
  | { op: "fill"; c?: ColorSpec }
  | { op: "replace"; from: ColorSpec; to: ColorSpec }
  | { op: "life"; steps?: number }
  | { op: "shift"; dx?: number; dy?: number }
  | { op: "mirror"; axis?: "x" | "y" }
  | { op: "noise"; density?: number; colors?: ColorSpec[]; x?: number; y?: number; w?: number; h?: number };

export const DRAW_OPS = ["px", "pixels", "line", "rect", "circle", "flood", "text", "stamp", "clear", "fill", "replace", "life", "shift", "mirror", "noise"];
export const BULK_OPS = new Set(["clear", "fill", "replace", "life", "shift", "mirror", "noise"]);

export class OpError extends Error {}

const ERASE = new Set([".", "", "erase", "empty", "none", "clear", "transparent"]);

// Return the hex a spec wants to add to the palette, if any.
export function specHex(c: ColorSpec): string | null {
  if (c === null || c === undefined || typeof c === "number") return null;
  const s = String(c).trim();
  if (ERASE.has(s.toLowerCase())) return null;
  if (s.length === 1 && ALPHABET.includes(s)) return null;
  const named = NAMED[s.toLowerCase()];
  if (named) return named;
  return normHex(s);
}

// Resolve a color spec to a board char. `fallback` is used when c is omitted.
export function resolveColor(c: ColorSpec, palette: string[], fallback?: ColorSpec): string {
  if (c === undefined) {
    if (fallback === undefined) throw new OpError("missing color 'c'");
    return resolveColor(fallback, palette);
  }
  if (c === null) return EMPTY;
  if (typeof c === "number") {
    if (!Number.isInteger(c) || c < -1 || c >= palette.length) throw new OpError(`palette index ${c} out of range 0..${palette.length - 1}`);
    return slotToChar(c);
  }
  const s = String(c).trim();
  if (ERASE.has(s.toLowerCase())) return EMPTY;
  if (s.length === 1 && ALPHABET.includes(s)) {
    if (ALPHABET.indexOf(s) >= palette.length) throw new OpError(`palette char '${s}' not in palette (size ${palette.length})`);
    return s;
  }
  const hex = NAMED[s.toLowerCase()] ?? normHex(s);
  if (!hex) throw new OpError(`bad color '${s}': use #rrggbb, a palette char, a palette index, a name, or null to erase`);
  const i = palette.indexOf(hex);
  return slotToChar(i >= 0 ? i : nearestSlot(palette, hex));
}

export const READ_OPS = new Set(["flood", "replace", "life", "shift", "mirror"]); // result depends on current board
export const MAX_PTS = 70000;      // pixels in one request
export const MAX_ROWS = 256;       // stamp rows (and row length)

export function collectHexes(ops: Op[]): string[] {
  const out = new Set<string>();
  const add = (c: ColorSpec) => { const h = specHex(c); if (h) out.add(h); };
  for (const o of ops) {
    if (!o || typeof o !== "object") continue;
    const a = o as Record<string, unknown>;
    add(a.c as ColorSpec);
    if (o.op === "pixels" && Array.isArray(o.pts)) o.pts.forEach((p) => { if (Array.isArray(p)) add(p[2]); });
    if (o.op === "stamp" && o.key && typeof o.key === "object") Object.values(o.key).forEach(add);
    if (o.op === "replace") { add(o.from); add(o.to); }
    if (o.op === "noise" && Array.isArray(o.colors)) o.colors.forEach(add);
  }
  return [...out];
}

const int = (v: unknown, name: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new OpError(`'${name}' must be a number`);
  return Math.round(n);
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface RasterResult {
  board: string[];          // working board after all ops
  changed: Set<number>;     // indexes whose final value differs from the input
  touched: Set<number>;     // indexes written by any op (what a delta commit must carry)
  readsBoard: boolean;      // true if any op's result depends on the current board
  summary: string[];        // op names
}

// Apply ops to a COPY of the board. Every loop is clipped to the board, and the
// total work is capped, so no request can burn more than a few ms of CPU.
export function applyOps(boardIn: string, w: number, h: number, ops: Op[], palette: string[], rng: () => number = Math.random): RasterResult {
  const board = boardIn.split("");
  const n = w * h;
  const touched = new Set<number>();
  const summary: string[] = [];
  let readsBoard = false;
  let work = 0;
  const budget = 8 * n + 200000;
  const spend = (k: number) => { work += k; if (work > budget) throw new OpError("this batch is too much work; split it into smaller batches"); };

  const set = (x: number, y: number, ch: string) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    board[i] = ch;
    touched.add(i);
  };
  // iterate the intersection of a rect with the board
  const each = (x: number, y: number, rw: number, rh: number, fn: (xx: number, yy: number) => void) => {
    const x0 = clamp(x, 0, w), x1 = clamp(x + rw, 0, w), y0 = clamp(y, 0, h), y1 = clamp(y + rh, 0, h);
    spend(Math.max(0, x1 - x0) * Math.max(0, y1 - y0));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) fn(xx, yy);
  };
  let pts = 0;

  if (!Array.isArray(ops)) throw new OpError("ops must be an array");
  if (ops.filter((o) => o && (o as Op).op === "life").length > 1) throw new OpError("only one life op per batch (use steps)");

  for (const raw of ops) {
    if (!raw || typeof raw !== "object") throw new OpError("each op must be an object");
    const o = raw as Op;
    if (READ_OPS.has(o.op)) readsBoard = true;
    switch (o.op) {
      case "px": {
        set(int(o.x, "x"), int(o.y, "y"), resolveColor(o.c, palette));
        spend(1);
        break;
      }
      case "pixels": {
        if (!Array.isArray(o.pts)) throw new OpError("pixels.pts must be [[x,y,c],...]");
        pts += o.pts.length;
        if (pts > MAX_PTS) throw new OpError(`at most ${MAX_PTS} points per batch`);
        spend(o.pts.length);
        for (const p of o.pts) {
          if (!Array.isArray(p)) throw new OpError("each point must be [x, y, c]");
          set(int(p[0], "x"), int(p[1], "y"), resolveColor(p[2], palette, o.c));
        }
        break;
      }
      case "line": {
        const ch = resolveColor(o.c, palette);
        const size = clamp(int(o.size ?? 1, "size"), 1, 16);
        // clamp endpoints far outside the board so the walk stays short
        const lim = 2 * (w + h);
        let x0 = clamp(int(o.x0, "x0"), -lim, lim), y0 = clamp(int(o.y0, "y0"), -lim, lim);
        const x1 = clamp(int(o.x1, "x1"), -lim, lim), y1 = clamp(int(o.y1, "y1"), -lim, lim);
        const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
        let err = dx + dy;
        const off = Math.floor((size - 1) / 2);
        spend((dx - dy + 1) * size * size);
        for (let guard = 0; guard < 4 * lim + 8; guard++) {
          for (let by = 0; by < size; by++) for (let bx = 0; bx < size; bx++) set(x0 - off + bx, y0 - off + by, ch);
          if (x0 === x1 && y0 === y1) break;
          const e2 = 2 * err;
          if (e2 >= dy) { err += dy; x0 += sx; }
          if (e2 <= dx) { err += dx; y0 += sy; }
        }
        break;
      }
      case "rect": {
        const ch = resolveColor(o.c, palette);
        const x = int(o.x, "x"), y = int(o.y, "y"), rw = int(o.w, "w"), rh = int(o.h, "h");
        if (o.fill === false) {
          each(x, y, rw, 1, (xx, yy) => set(xx, yy, ch));
          each(x, y + rh - 1, rw, 1, (xx, yy) => set(xx, yy, ch));
          each(x, y, 1, rh, (xx, yy) => set(xx, yy, ch));
          each(x + rw - 1, y, 1, rh, (xx, yy) => set(xx, yy, ch));
        } else each(x, y, rw, rh, (xx, yy) => set(xx, yy, ch));
        break;
      }
      case "circle": {
        const ch = resolveColor(o.c, palette);
        const cx = int(o.cx, "cx"), cy = int(o.cy, "cy");
        const r = clamp(int(o.r, "r"), 0, 2 * Math.max(w, h));
        const inside = (dx: number, dy: number) => dx * dx + dy * dy <= r * r + r * 0.8;
        each(cx - r, cy - r, 2 * r + 1, 2 * r + 1, (xx, yy) => {
          const dx = xx - cx, dy = yy - cy;
          if (!inside(dx, dy)) return;
          if (o.fill === false && inside(dx + 1, dy) && inside(dx - 1, dy) && inside(dx, dy + 1) && inside(dx, dy - 1)) return;
          set(xx, yy, ch);
        });
        break;
      }
      case "flood": {
        const ch = resolveColor(o.c, palette);
        const sx = int(o.x, "x"), sy = int(o.y, "y");
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) break;
        const target = board[sy * w + sx];
        if (target === ch) break;
        spend(n);
        const stack = [sy * w + sx];
        while (stack.length) {
          const i = stack.pop()!;
          if (board[i] !== target) continue;
          board[i] = ch; touched.add(i);
          const x = i % w, y = (i - x) / w;
          if (x > 0) stack.push(i - 1);
          if (x < w - 1) stack.push(i + 1);
          if (y > 0) stack.push(i - w);
          if (y < h - 1) stack.push(i + w);
        }
        break;
      }
      case "text": {
        const ch = resolveColor(o.c, palette);
        const text = String(o.text ?? "").slice(0, 200);
        const scale = clamp(int(o.scale ?? 1, "scale"), 1, 8);
        let cx = int(o.x, "x"), cy = int(o.y, "y");
        const x0 = cx;
        spend(text.length * FONT_W * FONT_H * scale * scale);
        for (const t of text) {
          if (t === "\n") { cx = x0; cy += (FONT_H + 1) * scale; continue; }
          if (cx < w && cy < h && cx + FONT_W * scale >= 0 && cy + FONT_H * scale >= 0) {
            const g = glyph(t);
            for (let gy = 0; gy < FONT_H; gy++) for (let gx = 0; gx < FONT_W; gx++) {
              if (!g[gy][gx]) continue;
              for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) set(cx + gx * scale + sx, cy + gy * scale + sy, ch);
            }
          }
          cx += (FONT_W + 1) * scale;
        }
        break;
      }
      case "stamp": {
        if (!Array.isArray(o.rows)) throw new OpError("stamp.rows must be an array of strings");
        if (o.rows.length > MAX_ROWS) throw new OpError(`stamp: at most ${MAX_ROWS} rows`);
        const key: Record<string, string> = {};
        if (o.key && typeof o.key === "object") for (const [k, v] of Object.entries(o.key)) key[k] = resolveColor(v, palette);
        const x = int(o.x ?? 0, "x"), y = int(o.y ?? 0, "y");
        o.rows.forEach((row, ry) => {
          const chars = [...String(row)];
          if (chars.length > MAX_ROWS) throw new OpError(`stamp: rows can be at most ${MAX_ROWS} chars`);
          spend(chars.length);
          chars.forEach((c, rx) => {
            if (c === " " || c === "~") return; // transparent
            if (key[c] !== undefined) return set(x + rx, y + ry, key[c]);
            if (c === EMPTY) return set(x + rx, y + ry, EMPTY);
            const slot = ALPHABET.indexOf(c);
            if (slot < 0 || slot >= palette.length) throw new OpError(`stamp char '${c}' is not a palette char and not in key`);
            set(x + rx, y + ry, c);
          });
        });
        break;
      }
      case "clear": {
        each(int(o.x ?? 0, "x"), int(o.y ?? 0, "y"), int(o.w ?? w, "w"), int(o.h ?? h, "h"), (xx, yy) => set(xx, yy, EMPTY));
        break;
      }
      case "fill": {
        const ch = resolveColor(o.c, palette);
        each(0, 0, w, h, (xx, yy) => set(xx, yy, ch));
        break;
      }
      case "replace": {
        const a = resolveColor(o.from, palette), b = resolveColor(o.to, palette);
        spend(n);
        for (let i = 0; i < n; i++) if (board[i] === a) { board[i] = b; touched.add(i); }
        break;
      }
      case "life": {
        const steps = clamp(int(o.steps ?? 1, "steps"), 1, 16);
        spend(steps * n * 9);
        for (let s = 0; s < steps; s++) {
          const next = board.slice();
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const counts: Record<string, number> = {};
            let k = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              const c = board[((y + dy + h) % h) * w + ((x + dx + w) % w)];
              if (c !== EMPTY) { k++; counts[c] = (counts[c] ?? 0) + 1; }
            }
            const i = y * w + x;
            const alive = board[i] !== EMPTY;
            if (alive && (k < 2 || k > 3)) next[i] = EMPTY;
            else if (!alive && k === 3) {
              let best = EMPTY, bn = 0;
              for (const [c, kk] of Object.entries(counts)) if (kk > bn) { best = c; bn = kk; }
              next[i] = best;
            }
          }
          for (let i = 0; i < n; i++) if (board[i] !== next[i]) { board[i] = next[i]; touched.add(i); }
        }
        break;
      }
      case "shift": {
        const dx = int(o.dx ?? 0, "dx"), dy = int(o.dy ?? 0, "dy");
        spend(n);
        const src = board.slice();
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = y * w + x;
          board[i] = src[((y - dy) % h + h) % h * w + ((x - dx) % w + w) % w];
          if (board[i] !== src[i]) touched.add(i);
        }
        break;
      }
      case "mirror": {
        spend(n);
        if ((o.axis ?? "x") === "x") {
          for (let y = 0; y < h; y++) for (let x = 0; x < Math.floor(w / 2); x++) set(w - 1 - x, y, board[y * w + x]);
        } else {
          for (let y = 0; y < Math.floor(h / 2); y++) for (let x = 0; x < w; x++) set(x, h - 1 - y, board[y * w + x]);
        }
        break;
      }
      case "noise": {
        const density = clamp(Number(o.density ?? 0.2) || 0, 0, 1);
        if (o.colors !== undefined && !Array.isArray(o.colors)) throw new OpError("noise.colors must be an array");
        const cols = (o.colors && o.colors.length ? o.colors.slice(0, 62) : [null]).map((c) => resolveColor(c, palette));
        each(int(o.x ?? 0, "x"), int(o.y ?? 0, "y"), int(o.w ?? w, "w"), int(o.h ?? h, "h"), (xx, yy) => {
          if (rng() < density) set(xx, yy, cols[Math.floor(rng() * cols.length)]);
        });
        break;
      }
      default:
        throw new OpError(`unknown op '${(o as { op?: string }).op}'. Known: ${DRAW_OPS.join(", ")}`);
    }
    summary.push(o.op);
  }

  const changed = new Set<number>();
  touched.forEach((i) => { if (board[i] !== boardIn[i]) changed.add(i); });
  return { board, changed, touched, readsBoard, summary };
}

// Decode a delta string "idx:c,idx:c" into pairs.
export function decodeDelta(d: string): [number, string][] {
  if (!d) return [];
  return d.split(",").map((p) => {
    const k = p.indexOf(":");
    return [Number(p.slice(0, k)), p.slice(k + 1)] as [number, string];
  });
}
