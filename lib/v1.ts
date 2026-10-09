import { NextResponse } from "next/server";
import { ALPHABET, EMPTY } from "./palette";
import { getRoom } from "./rooms";
import { getStore } from "./store";

export const V1_ROOM = process.env.WB_V1_ROOM ?? "chaos";
export const v1Res = (code: number, obj: unknown) => NextResponse.json(obj, { status: code, headers: { "cache-control": "no-store" } });

export async function v1Grid() {
  const meta = await getRoom(V1_ROOM);
  const snap = await getStore().snapshot(meta.id, meta.w * meta.h);
  const cells: string[][] = [];
  for (let y = 0; y < meta.h; y++) {
    const row: string[] = [];
    for (let x = 0; x < meta.w; x++) {
      const c = snap.board[y * meta.w + x];
      row.push(c === EMPTY ? "#000000" : snap.palette[ALPHABET.indexOf(c)] ?? "#000000");
    }
    cells.push(row);
  }
  return v1Res(200, { width: meta.w, height: meta.h, cells });
}

