// Board renderers for agents: text grid (token friendly) and PNG (for vision).
import { deflateSync } from "node:zlib";
import { ALPHABET, EMPTY, hexToRgb } from "./palette";

export interface Region { x: number; y: number; w: number; h: number }

export function clampRegion(r: Partial<Region>, W: number, H: number): Region {
  const x = Math.max(0, Math.min(W - 1, Math.floor(r.x ?? 0)));
  const y = Math.max(0, Math.min(H - 1, Math.floor(r.y ?? 0)));
  const w = Math.max(1, Math.min(W - x, Math.floor(r.w ?? W)));
  const h = Math.max(1, Math.min(H - y, Math.floor(r.h ?? H)));
  return { x, y, w, h };
}

// Text grid with coordinate rulers. Every cell is one char:
//   '.' empty, '0'..'9','a'..'z','A'..'Z' palette slot.
export function renderText(board: string, W: number, palette: string[], reg: Region, header: string): string {
  const lines: string[] = [];
  const used = new Set<string>();
  const rows: string[] = [];
  for (let y = reg.y; y < reg.y + reg.h; y++) {
    const row = board.slice(y * W + reg.x, y * W + reg.x + reg.w);
    for (const c of row) if (c !== EMPTY) used.add(c);
    rows.push(row);
  }
  lines.push(header);
  const legend = [...used].sort((a, b) => ALPHABET.indexOf(a) - ALPHABET.indexOf(b))
    .map((c) => `${c}=${palette[ALPHABET.indexOf(c)] ?? "?"}`);
  lines.push(`# legend (colors in view): .=empty ${legend.join(" ")}`);
  lines.push(`# x runs left->right (columns), y runs top->bottom (rows). Cell (x,y) = row y, column x.`);
  const pad = String(reg.y + reg.h - 1).length;
  const lastX = reg.x + reg.w - 1;
  const digits = String(lastX).length;
  for (let d = digits - 1; d >= 0; d--) {
    let s = "";
    for (let x = reg.x; x <= lastX; x++) {
      const p = 10 ** d;
      s += d === 0 || x % p === 0 || x === reg.x ? String(Math.floor(x / p) % 10) : " ";
    }
    lines.push(" ".repeat(pad + 1) + s);
  }
  rows.forEach((r, i) => lines.push(String(reg.y + i).padStart(pad, " ") + " " + r));
  return lines.join("\n") + "\n";
}

// --- PNG -------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function renderPng(board: string, W: number, palette: string[], reg: Region, scale: number, bg: string, transparent: boolean, grid: boolean): Buffer {
  // cap the output at 2048 px per side (a 256x256 board renders at scale <= 8)
  const s = Math.max(1, Math.min(64, Math.floor(scale) || 1, Math.floor(2048 / Math.max(reg.w, reg.h)) || 1));
  const outW = reg.w * s, outH = reg.h * s;
  const rgbs = palette.map(hexToRgb);
  const bgc = hexToRgb(bg);
  const raw = Buffer.alloc((outW * 4 + 1) * outH);
  let o = 0;
  for (let py = 0; py < outH; py++) {
    raw[o++] = 0; // filter: none
    const by = reg.y + Math.floor(py / s);
    for (let px = 0; px < outW; px++) {
      const bx = reg.x + Math.floor(px / s);
      const ch = board[by * W + bx];
      const slot = ch === EMPTY ? -1 : ALPHABET.indexOf(ch);
      let [r, g, b] = slot >= 0 && rgbs[slot] ? rgbs[slot] : bgc;
      let a = slot >= 0 || !transparent ? 255 : 0;
      if (grid && s >= 6 && (px % s === 0 || py % s === 0)) {
        // subtle grid line so vision models can count cells
        r = Math.round(r * 0.75 + 40 * 0.25); g = Math.round(g * 0.75 + 40 * 0.25); b = Math.round(b * 0.75 + 60 * 0.25); a = 255;
      }
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(outW, 0); ihdr.writeUInt32BE(outH, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
