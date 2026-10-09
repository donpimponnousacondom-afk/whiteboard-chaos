// End-to-end consistency + latency test against one or more running instances.
//   WB_URLS=http://localhost:3101,http://localhost:3102 node scripts/e2e.mjs
// It writes through every instance at once, listens over SSE on the first one,
// then checks that the streamed board equals the stored board and that seq has no gaps.
const URLS = (process.env.WB_URLS || "http://localhost:3000").split(",");
const WRITERS = Number(process.env.WRITERS || 6);
const BATCHES = Number(process.env.BATCHES || 30);
const room = "e2e-" + Date.now().toString(36);
const W = 64, H = 64;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hdr = (name) => ({ "content-type": "application/json", "x-wb-name": name, "x-wb-token": name + "-secret-token" });
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

async function post(base, path, body, name = "e2e") {
  const t0 = performance.now();
  const r = await fetch(base + path, { method: "POST", headers: hdr(name), body: JSON.stringify(body) });
  const j = await r.json();
  return { status: r.status, j, ms: performance.now() - t0 };
}

function sse(base, since, onEv) {
  const ctrl = new AbortController();
  (async () => {
    const qs = since === null ? "?cursors=0" : `?since=${since}&cursors=0`;
    const r = await fetch(`${base}/api/rooms/${room}/events${qs}`, { signal: ctrl.signal });
    const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let k; while ((k = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, k); buf = buf.slice(k + 2);
        const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
        if (data) onEv(JSON.parse(data), Date.now());
      }
    }
  })().catch((e) => { if (e.name !== "AbortError") console.error("sse", e.message); });
  return () => ctrl.abort();
}

function model() {
  const m = { board: null, seq: null, seqs: [], delays: [] };
  m.on = (ev, at) => {
    if (ev.kind === "snapshot") { m.board = ev.board.split(""); m.seq = ev.seq; return; }
    if (ev.seq === undefined) return;
    if (m.seq !== null && ev.seq !== m.seq + 1) fail(`gap/out-of-order: got ${ev.seq} after ${m.seq}`);
    m.seq = ev.seq; m.seqs.push(ev.seq);
    if (ev.t) m.delays.push(at - ev.t);
    if (typeof ev.full === "string") m.board = ev.full.split("");
    else if (ev.d) for (const p of ev.d.split(",")) { const i = p.indexOf(":"); m.board[Number(p.slice(0, i))] = p.slice(i + 1); }
  };
  return m;
}

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(0) : "-"; };
const rnd = (n) => Math.floor(Math.random() * n);
const COLORS = ["red", "gold", "sky", "#123456", "mint", null, "purple", "#abcdef"];

const created = await post(URLS[0], "/api/rooms", { id: room, w: W, h: H, mode: "free", title: "e2e" });
if (created.status !== 201) fail("create room " + JSON.stringify(created.j));
console.log(`room ${room} on ${URLS.join(" + ")}`);

const live = model();
const stop = sse(URLS[0], null, live.on);
await sleep(800);

const acks = [];
await Promise.all(Array.from({ length: WRITERS }, async (_, w) => {
  const base = URLS[w % URLS.length];
  const name = `writer${w}`;
  for (let b = 0; b < BATCHES; b++) {
    const ops = [];
    const n = 1 + rnd(4);
    for (let k = 0; k < n; k++) {
      const c = COLORS[rnd(COLORS.length)];
      const t = k === 0 && b % 10 === 0 ? 3 : rnd(3);
      if (t === 0) ops.push({ op: "px", x: rnd(W), y: rnd(H), c });
      else if (t === 1) ops.push({ op: "rect", x: rnd(W), y: rnd(H), w: 1 + rnd(6), h: 1 + rnd(6), c });
      else if (t === 2) ops.push({ op: "line", x0: rnd(W), y0: rnd(H), x1: rnd(W), y1: rnd(H), c });
      else ops.push({ op: "chat", text: `w${w} b${b}` });
    }
    const r = await post(base, `/api/rooms/${room}/ops`, { ops, nonce: `${room}-${w}-${b}` }, name);
    if (r.status !== 200) fail(`write ${r.status} ${JSON.stringify(r.j)}`);
    acks.push(r.ms);
    await sleep(rnd(30));
  }
}));

// replay check: a late listener replaying the whole history from seq 0 must converge too
const late = model();
const stopLate = sse(URLS[URLS.length - 1], 0, late.on);
// nonce replay check
const dup = await post(URLS[URLS.length - 1], `/api/rooms/${room}/ops`, { ops: [{ op: "px", x: 0, y: 0, c: "red" }], nonce: `${room}-0-0` }, "writer0");
if (!dup.j.duplicate) fail("nonce replay was not detected");

await sleep(1500);
stop(); stopLate();
const final = await (await fetch(`${URLS[URLS.length - 1]}/api/rooms/${room}`)).json();
if (live.seq !== final.seq) fail(`live seq ${live.seq} != stored ${final.seq}`);
if (live.board.join("") !== final.board) fail("live board differs from stored board");
if (late.seq !== final.seq || late.board?.join("") !== final.board) fail(`late listener did not converge (seq ${late.seq})`);

console.log(`OK  ${live.seqs.length} events streamed in order, boards identical (live + late-join replay), nonce replay rejected`);
console.log(`write ack ms   p50 ${pct(acks, 0.5)}  p95 ${pct(acks, 0.95)}  max ${pct(acks, 1)}  (${acks.length} writes, ${WRITERS} writers)`);
console.log(`fan-out delay  p50 ${pct(live.delays, 0.5)}  p95 ${pct(live.delays, 0.95)}  max ${pct(live.delays, 1)}  (server commit -> SSE client)`);
process.exit(0);
