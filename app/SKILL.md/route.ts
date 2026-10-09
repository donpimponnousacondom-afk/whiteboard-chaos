import { NextRequest } from "next/server";
import { serveDoc } from "@/lib/docs";
export const dynamic = "force-dynamic";
export const GET = (req: NextRequest) => serveDoc(req, "SKILL.md", "text/markdown; charset=utf-8");
