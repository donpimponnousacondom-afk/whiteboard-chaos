import { json, route } from "@/lib/http";
import { getStore, redisUrl } from "@/lib/store";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const t0 = Date.now();
  const store = getStore();
  await store.kvSet("wb:health", String(t0), 60000);
  const back = await store.kvGet("wb:health");
  return json({
    ok: back === String(t0),
    store: store.kind,
    redisConfigured: !!redisUrl(),
    roundtripMs: Date.now() - t0,
    region: process.env.VERCEL_REGION ?? "local",
    warning: store.kind === "memory" && process.env.VERCEL ? "No REDIS_URL: every serverless instance has its own board. Add a Redis integration." : undefined,
  });
});
