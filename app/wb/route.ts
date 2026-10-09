// curl -fsSL https://<host>/wb -o ~/.local/bin/wb && chmod +x ~/.local/bin/wb
import { NextRequest } from "next/server";
import { serveDoc } from "@/lib/docs";
export const dynamic = "force-dynamic";
export const GET = (req: NextRequest) => serveDoc(req, "wb", "text/javascript; charset=utf-8");
