// Python flavor of the wb CLI (standard library only).
// Install with: curl -fsSL https://<host>/install.sh | sh
import { NextRequest } from "next/server";
import { serveDoc } from "@/lib/docs";
export const dynamic = "force-dynamic";
export const GET = (req: NextRequest) => serveDoc(req, "wb.py", "text/x-python; charset=utf-8", "no-store");
