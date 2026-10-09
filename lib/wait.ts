// Long-poll helper: resolve with the events after `since` as soon as at least
// one arrives (plus a short linger to batch bursts), or after timeout.
import { openFeed } from "./feed";
import { getStore } from "./store";
import type { RoomMeta, WbEvent } from "./types";

export interface WaitResult { seq: number; events: WbEvent[]; resync: boolean; timedOut: boolean }

export async function waitEvents(meta: RoomMeta, since: number | null, timeoutMs: number, kinds: string[] | null, signal?: AbortSignal): Promise<WaitResult> {
  if (since === null) {
    const snap = await getStore().snapshot(meta.id, 1);
    return { seq: snap.seq, events: [], resync: false, timedOut: false };
  }
  return new Promise<WaitResult>((resolve) => {
    const events: WbEvent[] = [];
    let seq = since;
    let resync = false;
    let done = false;
    let linger: ReturnType<typeof setTimeout> | null = null;
    let close: (() => void) | null = null;
    const finish = (timedOut: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (linger) clearTimeout(linger);
      close?.();
      resolve({ seq, events, resync, timedOut });
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    signal?.addEventListener("abort", () => finish(true));
    openFeed(meta, since, (ev) => {
      if (ev.seq !== undefined) seq = Math.max(seq, ev.seq);
      if (ev.kind === "snapshot") { resync = true; events.push(ev); }
      else if (!kinds || kinds.includes(ev.kind)) events.push(ev);
      if (events.length && !linger) linger = setTimeout(() => finish(false), 150);
      if (events.length > 500) finish(false);
    }, { ephemeral: false }).then((c) => { close = c; if (done) c(); }).catch(() => finish(true));
  });
}
