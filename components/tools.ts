// Drawing tools and the keyboard map. Keys are plain letters: the left hand
// rests on Q W E R T / A S D F G / Z X C V B while the right hand draws.
// No Ctrl+letter shortcuts (the browser owns those), except Ctrl+Z for undo.

export type Tool = "pencil" | "eraser" | "line" | "rect" | "circle" | "flood" | "picker" | "text" | "pan";

export interface ToolDef { id: Tool; keys: string[]; label: string; icon: string }

export const TOOLS: ToolDef[] = [
  { id: "pencil", keys: ["d", "b", "p"], label: "Pencil", icon: "M3 21l3.5-1 11-11-2.5-2.5-11 11L3 21zM16 5.5l2.5 2.5 1.5-1.5L17.5 4 16 5.5z" },
  { id: "eraser", keys: ["e"], label: "Eraser", icon: "M4 17l7-7 6 6-4 4H8l-4-3zm9-11l6 6-2 2-6-6 2-2zM9 21h11" },
  { id: "line", keys: ["a", "l"], label: "Line", icon: "M4 20L20 4" },
  { id: "rect", keys: ["r"], label: "Rectangle", icon: "M4 6h16v12H4z" },
  { id: "circle", keys: ["c", "o"], label: "Circle", icon: "M12 4a8 8 0 100 16 8 8 0 000-16z" },
  { id: "flood", keys: ["f"], label: "Fill bucket", icon: "M5 11l6-6 7 7-6 6-7-7zm14 4s-2 2.2-2 3.5a2 2 0 004 0C21 17.2 19 15 19 15z" },
  { id: "picker", keys: ["s", "i"], label: "Pick color", icon: "M14 4l6 6-2 2-1-1-7 7H7v-3l7-7-1-1 1-2z" },
  { id: "text", keys: ["t"], label: "Text", icon: "M5 5h14M12 5v14M9 19h6" },
  { id: "pan", keys: ["v", "h"], label: "Move the view", icon: "M12 3v18M3 12h18M12 3l-3 3m3-3l3 3M12 21l-3-3m3 3l3-3M3 12l3-3m-3 3l3 3m15-3l-3-3m3 3l-3 3" },
];

export const ICON_MIRROR = "M12 3v18M9 7L4 12l5 5V7zm6 0l5 5-5 5V7z";
export const ICON_UNDO = "M9 7L4 12l5 5M4 12h11a5 5 0 010 10h-3";
export const ICON_SWAP = "M7 4L3 8l4 4M3 8h14M17 12l4 4-4 4M21 16H7";
export const ICON_FIT = "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5";
export const ICON_GUESS = "M9 9a3 3 0 115 2c-1 .7-2 1.3-2 3M12 18h.01";
export const ICON_WHEEL = "M12 3a9 9 0 100 18 9 9 0 000-18zm0 5a4 4 0 100 8 4 4 0 000-8z";

export const toolByKey = (k: string) => TOOLS.find((t) => t.keys.includes(k));

// One entry per key on the left-hand map in the help panel.
export interface KeySlot { key: string; label: string; icon?: string; hold?: boolean }

export function leftHandMap(guessRoom: boolean): KeySlot[][] {
  const t = (id: Tool, key: string): KeySlot => { const d = TOOLS.find((x) => x.id === id)!; return { key, label: d.label, icon: d.icon }; };
  return [
    [{ key: "q", label: "Tool ring (hold)", icon: ICON_WHEEL, hold: true }, { key: "w", label: "Mirror", icon: ICON_MIRROR }, t("eraser", "e"), t("rect", "r"), t("text", "t")],
    [t("line", "a"), t("picker", "s"), t("pencil", "d"), t("flood", "f"), guessRoom ? { key: "g", label: "Type a guess", icon: ICON_GUESS } : { key: "g", label: "" }],
    [{ key: "z", label: "Undo", icon: ICON_UNDO }, { key: "x", label: "Swap colors", icon: ICON_SWAP }, t("circle", "c"), t("pan", "v"), { key: "b", label: "Pencil", icon: TOOLS[0].icon }],
  ];
}

export const OTHER_KEYS: [string, string][] = [
  ["1 to 9", "Pick a color from the room palette"],
  ["[  ]", "Smaller or bigger brush"],
  ["Ctrl (hold)", "Tool ring, same as holding Q"],
  ["Ctrl+Z", "Undo your last stroke (also Z)"],
  ["Space (hold)", "Drag to move the view"],
  ["+  -  0", "Zoom in, zoom out, fit to screen"],
  ["Shift", "With rectangle or circle: filled shape"],
  ["Alt + click", "Pick the color under the cursor"],
  ["Right click", "Erase, second color or pick (set below the palette)"],
  ["Enter", "Write in the chat"],
  ["?", "This help"],
  ["Esc", "Close this help or the tool ring"],
];
