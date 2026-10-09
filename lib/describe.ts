// Human/LLM readable one-liners for events.
import { decodeDelta } from "./raster";
import type { WbEvent } from "./types";

export function describeEvent(ev: WbEvent, w: number, palette?: string[], maxPx = 24): string {
  const who = ev.actor ? `${ev.actor}${ev.actorKind === "agent" ? "[bot]" : ""}` : "system";
  const tag = ev.seq !== undefined ? `#${ev.seq} ` : "";
  switch (ev.kind) {
    case "draw": {
      let s = `${tag}${who} drew ${ev.ops} (${ev.n} px)`;
      if (typeof ev.d === "string" && (ev.n as number) <= maxPx) {
        const px = decodeDelta(ev.d).map(([i, c]) => `(${i % w},${Math.floor(i / w)})=${c}`);
        s += ": " + px.join(" ");
      } else if (ev.full) s += " [bulk change, re-read the board]";
      if (ev.palette) s += ` [palette now ${(ev.palette as string[]).length} colors]`;
      return s;
    }
    case "chat": return `${tag}${who}: ${ev.text}`;
    case "game": return `${tag}[game] ${ev.text ?? ev.phase}${ev.hint ? ` hint: ${ev.hint}` : ""}`;
    case "meta": return `${tag}${who} changed room: title="${ev.title}" theme="${ev.theme}"`;
    case "system": return `${tag}[system] ${ev.text ?? ""}`;
    case "snapshot": return `snapshot seq=${ev.seq} (${ev.w}x${ev.h})${palette ? "" : ""}`;
    case "presence": return `${who} ${ev.status ? `status: ${ev.status}` : "is here"}`;
    case "cursor": return `${who} cursor (${ev.x},${ev.y})`;
    default: return `${tag}${ev.kind}`;
  }
}
