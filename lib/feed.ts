// Ordered event feed for one listener (an SSE connection or a long-poll).
//
// Pub/sub from different server instances can arrive out of order, and a
// listener may connect with an old `since`. The feed guarantees the listener
// sees persisted events strictly in seq order with no gaps: it buffers,
// backfills from the Redis stream, and falls back to a full snapshot when
// the history it needs has been trimmed.
import { getStore } from "./store";
import type { RoomMeta, WbEvent } from "./types";

export interface FeedOpts {
  ephemeral: boolean; // pass cursor/presence events through
}

export async function openFeed(meta: RoomMeta, since: number | null, emit: (ev: WbEvent) => void, opts: FeedOpts): Promise<() => void> {
  const store = getStore();
  const n = meta.w * meta.h;
  let last = 0;
  let ready = false;
  let closed = false;
  const early: WbEvent[] = [];
  const pending = new Map<number, WbEvent>();
  let repairTimer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  const serial = (fn: () => Promise<void> | void) => { chain = chain.then(fn).catch((e) => console.error("[wb] feed", e)); return chain; };

  const sendSnapshot = async () => {
    const snap = await store.snapshot(meta.id, n);
    last = snap.seq;
    pending.forEach((_, s) => { if (s <= last) pending.delete(s); });
    emit({ kind: "snapshot", t: Date.now(), seq: snap.seq, w: meta.w, h: meta.h, board: snap.board, palette: snap.palette });
  };

  const drain = () => {
    while (pending.has(last + 1)) {
      const ev = pending.get(last + 1)!;
      pending.delete(last + 1);
      last += 1;
      emit(ev);
    }
  };

  const backfill = async (from: number) => {
    for (let guard = 0; guard < 20; guard++) {
      const { events, head } = await store.range(meta.id, from, 1000);
      if (from > head) { await sendSnapshot(); return; }               // store was reset
      if ((events.length && events[0].seq! > from + 1) || (!events.length && head > from)) { await sendSnapshot(); return; } // trimmed
      for (const ev of events) { if (ev.seq! > last) { last = ev.seq!; emit(ev); } }
      if (events.length < 1000) return;
      from = last;
    }
    await sendSnapshot();
  };

  const repair = () => serial(async () => {
    repairTimer = null;
    if (closed || !pending.size) return;
    await backfill(last);
    drain();
    if (pending.size) { pending.clear(); await sendSnapshot(); }
  });

  const handle = (ev: WbEvent) => {
    if (ev.seq === undefined || ev.seq === null) { if (opts.ephemeral) emit(ev); return; }
    if (ev.seq <= last) return;
    if (ev.seq === last + 1) { last = ev.seq; emit(ev); drain(); return; }
    pending.set(ev.seq, ev);
    if (!repairTimer) repairTimer = setTimeout(repair, 250);
  };

  const unsub = store.subscribe(meta.id, (ev) => {
    if (closed) return;
    if (!ready) { early.push(ev); return; }
    serial(() => handle(ev));
  });

  // Setup errors must reach the caller (a silent failure would leave this
  // listener buffering forever), so this step is not wrapped by serial().
  const setup = chain.then(async () => {
    if (since === null || since === undefined || !Number.isInteger(since) || since < 0) await sendSnapshot();
    else { last = since; await backfill(since); }
    ready = true;
    for (const ev of early.splice(0)) handle(ev);
  });
  chain = setup.catch(() => {});
  try {
    await setup;
  } catch (e) {
    closed = true;
    unsub();
    throw e;
  }

  // Pub/sub can drop messages (subscriber reconnect, failed publish). In a quiet
  // room no later event would reveal the gap, so poll the head now and then.
  let lastActivity = Date.now();
  const tap = emit;
  emit = (ev) => { lastActivity = Date.now(); tap(ev); };
  const poll = setInterval(() => {
    if (closed || Date.now() - lastActivity < 4000) return;
    serial(async () => {
      const { events, head } = await store.range(meta.id, last, 1);
      if (head > last && events.length) { await backfill(last); drain(); }
      else if (head > last) await sendSnapshot();
      lastActivity = Date.now();
    });
  }, 5000);

  return () => {
    closed = true;
    clearInterval(poll);
    if (repairTimer) clearTimeout(repairTimer);
    unsub();
  };
}
