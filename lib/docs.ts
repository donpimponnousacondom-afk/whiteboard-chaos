import type { NextRequest } from "next/server";
import { DOCS } from "./generated-docs";
import { origin } from "./http";

export function serveDoc(req: NextRequest, name: keyof typeof DOCS | string, type: string) {
  const body = (DOCS[name] ?? "").replaceAll("{{ORIGIN}}", origin(req));
  return new Response(body, { headers: { "content-type": type, "cache-control": "public, max-age=60" } });
}
