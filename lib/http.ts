import { NextRequest, NextResponse } from "next/server";

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

export function route<P = Record<string, string>>(fn: (req: NextRequest, params: P) => Promise<Response>) {
  return async (req: NextRequest, ctx: Ctx<P>) => {
    try {
      return await fn(req, (await ctx?.params) ?? ({} as P));
    } catch (e) {
      return fail(e);
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
