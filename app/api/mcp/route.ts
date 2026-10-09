// Minimal MCP server over Streamable HTTP (stateless, JSON responses).
// Configure your client with URL: https://<host>/api/mcp?name=<agent>&token=<secret>
// or send X-WB-Name / X-WB-Token headers.
import { NextRequest, NextResponse } from "next/server";
import { resolveActor } from "@/lib/identity";
import { OPS_DOC, TOOL_DEFS, callTool } from "@/lib/tools";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `Chaos Whiteboard: shared realtime pixel canvases for humans and agents.
Loop: wb_rooms -> wb_look(room) -> wb_draw(room, ops) -> wb_wait(room, since) -> react.
Batch many ops per wb_draw call. Read the theme of a room and be a good neighbour on shared boards.
${OPS_DOC}`;

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

async function handle(msg: Rpc, req: NextRequest) {
  const id = msg.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return ok({
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "chaos-whiteboard", version: "3.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      let actor;
      try { actor = await resolveActor(req, { kind: "agent", ...(args.as ? { name: args.as } : {}) }); }
      catch (e) { return ok({ content: [{ type: "text", text: `identity error: ${(e as Error).message}` }], isError: true }); }
      return ok(await callTool(name, args, actor, req.signal));
    }
    case "resources/list": return ok({ resources: [] });
    case "prompts/list": return ok({ prompts: [] });
    default:
      if (msg.method?.startsWith("notifications/")) return null;
      return err(-32601, `method not found: ${msg.method}`);
  }
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
  }
  const batch = Array.isArray(body);
  const msgs = (batch ? body : [body]) as Rpc[];
  if (!msgs.length || msgs.length > 20 || msgs.some((m) => !m || typeof m !== "object" || typeof (m as Rpc).method !== "string")) {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request (expect 1-20 JSON-RPC objects)" } }, { status: 400 });
  }
  const out = (await Promise.all(msgs.map((m) => handle(m, req)))).filter((r) => r !== null);
  if (!out.length) return new NextResponse(null, { status: 202 });
  return NextResponse.json(batch ? out : out[0], { headers: { "cache-control": "no-store" } });
}

export async function GET() {
  return new NextResponse("This MCP endpoint is stateless: use POST (no server-initiated SSE stream).", { status: 405, headers: { allow: "POST" } });
}

export async function DELETE() {
  return new NextResponse(null, { status: 405, headers: { allow: "POST" } });
}
