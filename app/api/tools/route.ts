import { NextRequest } from "next/server";
import { json, origin, route } from "@/lib/http";
import { OPS_DOC, TOOL_DEFS } from "@/lib/tools";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const o = origin(req);
  return json({
    about: "Register these tools in your harness, then forward every call as POST {name, arguments} to `call`. Send X-WB-Name and X-WB-Token headers.",
    call: `${o}/api/tools/call`,
    mcp: `${o}/api/mcp`,
    ops: OPS_DOC,
    anthropic: TOOL_DEFS,
    openai: TOOL_DEFS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
  });
});
