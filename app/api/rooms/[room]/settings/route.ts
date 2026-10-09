// GET   /api/rooms/:room/settings          -> current settings (+ youAreOwner with X-WB-Owner)
// PATCH /api/rooms/:room/settings          -> owner only (X-WB-Owner: owner key, or X-WB-Admin)
//   { chatSlowSec: {human, agent} | n, guessSlowSec: {human, agent} | n, maxGuessesPerRound,
//     game: { choices: 1|3|5, roundSec, categories: [...], difficulty, custom: [...] | "a, b, c", customOnly },
//     title, theme }
import { NextRequest } from "next/server";
import { json, readJson, route } from "@/lib/http";
import { resolveActor } from "@/lib/identity";
import { getRoom, isOwner, publicSettings, updateSettings } from "@/lib/rooms";
import { roomSettings } from "@/lib/settings";
import { CATEGORIES } from "@/lib/words";

export const dynamic = "force-dynamic";
type P = { room: string };

export const GET = route<P>(async (req: NextRequest, { room }) => {
  const meta = await getRoom(room);
  const owner = isOwner(meta, req.headers.get("x-wb-owner"), req.headers.get("x-wb-admin"));
  return json({
    settings: owner ? roomSettings(meta) : publicSettings(meta),
    youAreOwner: owner, hasOwnerKey: !!meta.ownerKeyHash, categories: CATEGORIES,
  });
});

export const PATCH = route<P>(async (req: NextRequest, { room }) => {
  const body = await readJson(req);
  const actor = await resolveActor(req, body);
  const meta = await updateSettings(room, body, actor, req.headers.get("x-wb-owner"), req.headers.get("x-wb-admin"));
  return json({ ok: true, settings: roomSettings(meta) });
});
