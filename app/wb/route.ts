// Node flavor of the wb CLI. Install with: curl -fsSL https://<host>/install.sh | sh -s -- node
import { NextRequest } from "next/server";
import { serveDoc } from "@/lib/docs";
export const dynamic = "force-dynamic";
export const GET = (req: NextRequest) => serveDoc(req, "wb", "text/javascript; charset=utf-8", "no-store");
