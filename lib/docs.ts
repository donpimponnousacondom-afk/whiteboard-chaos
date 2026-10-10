import type { NextRequest } from "next/server";
import { DOCS } from "./generated-docs";
import { origin } from "./http";

// CLIs and the installer are never cached: a self-update must get the newest.
export function serveDoc(req: NextRequest, name: keyof typeof DOCS | string, type: string, cache = "public, max-age=60") {
  const body = (DOCS[name] ?? "").replaceAll("{{ORIGIN}}", origin(req));
  return new Response(body, { headers: { "content-type": type, "cache-control": cache } });
}
