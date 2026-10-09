// Copy every Chaos Whiteboard key (wb:*) from one Redis to another, with TTLs.
// Use it once to move from Upstash to your own server. Copies by data type
// (no DUMP/RESTORE), so it works across Redis versions and with the "wb" user.
//
//   FROM='rediss://default:UPSTASH_PASS@xxx.upstash.io:6379' \
//   TO='rediss://wb:WB_PASS@redis.yourdomain.net:6380' \
//   node scripts/copy-redis.mjs
import Redis from "ioredis";

const from = new Redis(process.env.FROM, { maxRetriesPerRequest: 3 });
const to = new Redis(process.env.TO, { maxRetriesPerRequest: 3 });
let cursor = "0", copied = 0, skipped = 0;

async function copyKey(k) {
  const type = await from.type(k);
  const pttl = await from.pttl(k);
  const m = to.multi().del(k);
  if (type === "string") m.set(k, await from.get(k));
  else if (type === "hash") { const h = await from.hgetall(k); if (Object.keys(h).length) m.hset(k, h); }
  else if (type === "list") { const l = await from.lrange(k, 0, -1); if (l.length) m.rpush(k, ...l); }
  else if (type === "set") { const s = await from.smembers(k); if (s.length) m.sadd(k, ...s); }
  else if (type === "zset") { const z = await from.zrange(k, 0, -1, "WITHSCORES"); for (let i = 0; i < z.length; i += 2) m.zadd(k, z[i + 1], z[i]); }
  else if (type === "stream") {
    let start = "-";
    for (;;) {
      const rows = await from.xrange(k, start, "+", "COUNT", 1000);
      for (const [id, fields] of rows) m.xadd(k, id, ...fields);
      if (rows.length < 1000) break;
      start = "(" + rows[rows.length - 1][0];
    }
  } else { skipped++; return; }
  if (pttl > 0) m.pexpire(k, pttl);
  await m.exec();
  copied++;
}

do {
  const [next, keys] = await from.scan(cursor, "MATCH", "wb:*", "COUNT", 200);
  cursor = next;
  for (const k of keys) await copyKey(k);
  process.stdout.write(`\rcopied ${copied} keys`);
} while (cursor !== "0");
console.log(`\ndone${skipped ? ` (${skipped} keys of unknown type skipped)` : ""}`);
await from.quit(); await to.quit();
