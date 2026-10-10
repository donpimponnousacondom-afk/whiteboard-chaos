// curl -fsSL https://<host>/install.sh | sh            (Python wb)
// curl -fsSL https://<host>/install.sh | sh -s -- node (Node wb)
import { NextRequest } from "next/server";
import { serveDoc } from "@/lib/docs";
export const dynamic = "force-dynamic";
export const GET = (req: NextRequest) => serveDoc(req, "install.sh", "text/x-shellscript; charset=utf-8", "no-store");
