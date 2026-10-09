import { NextRequest, NextResponse } from "next/server";
import { HttpError, json, num, route, text } from "@/lib/http";
import { ALPHABET, EMPTY } from "@/lib/palette";
import { clampRegion, renderPng, renderText } from "@/lib/render";
import { getRoom } from "@/lib/rooms";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export const GET = route<{ room: string }>(async (req: NextRequest, { room }) => {
  const meta = await getRoom(room);
  const q = req.nextUrl.searchParams;
  const snap = await getStore().snapshot(meta.id, meta.w * meta.h);
  const reg = clampRegion({ x: num(q.get("x")), y: num(q.get("y")), w: num(q.get("w")), h: num(q.get("h")) }, meta.w, meta.h);
  const format = q.get("format") ?? "text";
  if (format === "png") {
    const auto = Math.max(1, Math.min(32, Math.floor(1024 / Math.max(reg.w, reg.h))));
    const png = renderPng(snap.board, meta.w, snap.palette, reg, num(q.get("scale"), auto)!, meta.bg, q.get("transparent") === "1", q.get("grid") === "1");
    return new NextResponse(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "no-store", "x-wb-seq": String(snap.seq) } });
  }
  if (format === "json") {
    const rows: string[] = [];
    for (let y = reg.y; y < reg.y + reg.h; y++) rows.push(snap.board.slice(y * meta.w + reg.x, y * meta.w + reg.x + reg.w));
    return json({ room: meta.id, w: meta.w, h: meta.h, seq: snap.seq, region: reg, palette: snap.palette, rows });
  }
  if (format === "grid") {
    // v1 shape: {width,height,cells:[[#rrggbb]]}, empty = #000000
    const cells: string[][] = [];
    for (let y = reg.y; y < reg.y + reg.h; y++) {
      const row: string[] = [];
      for (let x = reg.x; x < reg.x + reg.w; x++) {
        const c = snap.board[y * meta.w + x];
        row.push(c === EMPTY ? "#000000" : snap.palette[ALPHABET.indexOf(c)] ?? "#000000");
      }
      cells.push(row);
    }
    return json({ width: reg.w, height: reg.h, cells, seq: snap.seq });
  }
  if (format !== "text") throw new HttpError(400, "bad_format", "format must be text, png, json or grid");
  if (reg.w * reg.h > 65536) throw new HttpError(400, "region_too_big", "max 65536 cells");
  const header = `# room ${meta.id} "${meta.title}" ${meta.w}x${meta.h} mode=${meta.mode} seq=${snap.seq} region x=${reg.x} y=${reg.y} w=${reg.w} h=${reg.h}`;
  return text(renderText(snap.board, meta.w, snap.palette, reg, header));
});
