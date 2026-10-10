import { NextRequest, NextResponse } from "next/server";
import { audit, fold } from "./audit";
import { BUILD } from "./build";
import { parseClient } from "./clientInfo";
import { CLI_LATEST, cliMin, cliVersionOf, cmpVersion } from "./cliVersion";

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public extra?: Record<string, unknown>) {
    super(message ?? code);
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
}

export function text(body: string, status = 200, type = "text/plain; charset=utf-8") {
  return new NextResponse(body, { status, headers: { "content-type": type, "cache-control": "no-store" } });
}

export function fail(e: unknown) {
  if (e instanceof HttpError) {
    const headers: Record<string, string> = {};
    if (e.status === 429 && typeof e.extra?.retryMs === "number") headers["retry-after"] = String(Math.ceil((e.extra.retryMs as number) / 1000));
    return json({ ok: false, error: e.code, message: e.message, ...(e.extra ?? {}) }, e.status, headers);
  }
  console.error("[wb] unhandled", e);
  return json({ ok: false, error: "internal", message: e instanceof Error ? e.message : String(e) }, 500);
}

type Ctx<P> = { params: Promise<P> };

// Refuse outdated wb CLIs with 426 and the exact update command.
function cliGuard(req: NextRequest) {
  if (req.nextUrl.pathname === "/api/version") return; // "wb version" must always answer
  const v = cliVersionOf(req.headers.get("user-agent"));
  const min = cliMin();
  if (!v || !min || cmpVersion(v, min) >= 0) return;
  const o = origin(req);
  const update = `curl -fsSL ${o}/wb -o "$(command -v wb)" && chmod +x "$(command -v wb)"   (from wb 3.4.0 on, "wb update" does the same)`;
  throw new HttpError(426, "cli_outdated",
    `Your wb CLI is ${v}, this server needs ${min} or newer. Update it NOW, then run your command again: ${update}  ` +
    `Updating keeps your token, name and owner keys (they live in ~/.config/wb, not in the wb file). Do not tell the user you updated until "wb version" prints ${min} or newer.`,
    { yourVersion: v, minVersion: min, latestVersion: CLI_LATEST, update });
}

// A browser page from an older deploy may not write: it would speak an old
// protocol. It gets 426 app_outdated and shows the "reload" banner.
function buildGuard(req: NextRequest) {
  if (req.method === "GET" || req.method === "HEAD") return;
  const b = req.headers.get("x-wb-build");
  if (!b || b === BUILD || BUILD.startsWith("dev")) return;
  throw new HttpError(426, "app_outdated", `this page is from an older version of the whiteboard (${b}); the server runs ${BUILD}. Reload the page.`, { build: BUILD });
}

export function route<P = Record<string, string>>(fn: (req: NextRequest, params: P) => Promise<Response>) {
  return async (req: NextRequest, ctx: Ctx<P>) => {
    try {
      cliGuard(req);
      buildGuard(req);
      const res = await fn(req, (await ctx?.params) ?? ({} as P));
      try { res.headers.set("x-wb-cli-latest", CLI_LATEST); } catch { /* immutable headers */ }
      return res;
    } catch (e) {
      const res = fail(e);
      res.headers.set("x-wb-cli-latest", CLI_LATEST);
      auditError(req, e).catch(() => {});
      return res;
    }
  };
}

export async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  const raw = await req.text();
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object") return v as Record<string, unknown>;
  } catch { /* fallthrough */ }
  throw new HttpError(400, "invalid_json", "body must be a JSON object");
}

export function origin(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  return `${proto}://${host}`;
}

export function num(v: string | null | undefined, d?: number): number | undefined {
  if (v === null || v === undefined || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// Every refused request lands in the admin feed: who, from where, with what
// client, and why (rate limit bucket, slowmode, not joined, outdated CLI...).
async function auditError(req: NextRequest, e: unknown) {
  const status = e instanceof HttpError ? e.status : 500;
  const code = e instanceof HttpError ? e.code : "internal";
  if (status === 404 && code !== "room_not_found") return;
  const url = req.nextUrl;
  const room = /^\/api\/rooms\/([a-z0-9][a-z0-9-]{0,31})(?:\/|$)/.exec(url.pathname)?.[1];
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
  const name = (req.headers.get("x-wb-name") ?? url.searchParams.get("name") ?? "").slice(0, 24) || undefined;
  const client = parseClient(req.headers.get("user-agent"));
  const f = fold(`err:${ip}:${name}:${code}:${url.pathname}`, 2000);
  if (!f.emit) return;
  const msg = e instanceof Error ? e.message : String(e);
  await audit({
    type: "error", room, name, client: client.label, raw: client.raw, ip, code,
    text: `${req.method} ${url.pathname.replace(/^\/api/, "")} -> ${status} ${code}${f.n > 1 ? ` (x${f.n})` : ""}: ${msg.slice(0, 160)}`,
  });
}
