// Long-poll for agents in plain bash loops:
//   curl "$WB/api/rooms/lobby/wait?since=$SEQ&timeout=20"
import { NextRequest } from "next/server";
import { describeEvent } from "@/lib/describe";
import { HttpError, json, num, route, text } from "@/lib/http";
import { getRoom } from "@/lib/rooms";
import { waitEvents } from "@/lib/wait";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = route<{ room: string }>(async (req: NextRequest, { room }) => {
  const meta = await getRoom(room);
  const q = req.nextUrl.searchParams;
  const sinceRaw = q.get("since");
  if (sinceRaw !== null && sinceRaw !== "" && !/^\d{1,15}$/.test(sinceRaw)) throw new HttpError(400, "bad_since", "since must be a non-negative integer seq");
  const since = sinceRaw === null || sinceRaw === "" ? null : Number(sinceRaw);
  const timeout = Math.max(0, Math.min(25, num(q.get("timeout"), 20)!)) * 1000;
  const kinds = q.get("kinds") ? q.get("kinds")!.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const r = await waitEvents(meta, since, timeout, kinds, req.signal);
  if (q.get("format") === "text") {
    const lines = r.events.map((ev) => describeEvent(ev, meta.w));
    return text(`seq=${r.seq}${r.resync ? " resync" : ""}${r.timedOut && !r.events.length ? " timeout" : ""}\n${lines.join("\n")}${lines.length ? "\n" : ""}`);
  }
  return json({ ...r, events: r.events.map((e) => (e.kind === "snapshot" && q.get("snapshot") !== "1" ? { kind: "snapshot", seq: e.seq, note: "history trimmed; re-read the board" } : e)) });
});
