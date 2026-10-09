// Palette handling. A board cell is ONE character:
//   '.'            empty (renders as the room background)
//   '0'-'9','a'-'z','A'-'Z'  palette slot 0..61
// One char per cell keeps the board a plain string: cheap to store in Redis,
// cheap to stream, and readable by an LLM as a text grid.

export const EMPTY = ".";
export const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const MAX_COLORS = ALPHABET.length; // 62

// v1 palette first (so old agents' colors map to the same slots), then a
// PICO-8 flavoured extension for richer pixel art.
export const DEFAULT_PALETTE: string[] = [
  "#ff3d5a", "#ff8a3d", "#ffd23d", "#b6ff3d", "#3dffa8", "#3de1ff", "#3d7bff", "#8a3dff",
  "#ff3df2", "#ffffff", "#c9c9d6", "#7a7a92", "#3a3a4d", "#1a1a26", "#000000", "#8b4513",
  "#1d2b53", "#7e2553", "#008751", "#ab5236", "#5f574f", "#ff004d", "#ffa300", "#ffec27",
  "#00e436", "#29adff", "#83769c", "#ff77a8", "#ffccaa", "#6a6c7a", "#b0b2bf", "#f4b41b",
];

export function charToSlot(ch: string): number {
  if (ch === EMPTY) return -1;
  return ALPHABET.indexOf(ch);
}

export function slotToChar(slot: number): string {
  if (slot < 0) return EMPTY;
  return ALPHABET[slot] ?? EMPTY;
}

export function normHex(input: string): string | null {
  let s = String(input).trim().toLowerCase();
  if (!s.startsWith("#")) s = "#" + s;
  if (/^#[0-9a-f]{3}$/.test(s)) s = "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function nearestSlot(palette: string[], hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  let best = 0;
  let bestD = Infinity;
  palette.forEach((p, i) => {
    const [pr, pg, pb] = hexToRgb(p);
    // weighted RGB distance, good enough for pixel art
    const d = 2 * (r - pr) ** 2 + 4 * (g - pg) ** 2 + 3 * (b - pb) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

// Named colors so agents can say "red" instead of "#ff3d5a".
export const NAMED: Record<string, string> = {
  red: "#ff3d5a", orange: "#ff8a3d", yellow: "#ffd23d", lime: "#b6ff3d", mint: "#3dffa8",
  cyan: "#3de1ff", blue: "#3d7bff", purple: "#8a3dff", pink: "#ff3df2", white: "#ffffff",
  silver: "#c9c9d6", gray: "#7a7a92", grey: "#7a7a92", slate: "#3a3a4d", ink: "#1a1a26",
  black: "#000000", brown: "#8b4513", navy: "#1d2b53", plum: "#7e2553", green: "#008751",
  rust: "#ab5236", stone: "#5f574f", crimson: "#ff004d", amber: "#ffa300", gold: "#f4b41b",
  sky: "#29adff", lavender: "#83769c", rose: "#ff77a8", peach: "#ffccaa",
};
