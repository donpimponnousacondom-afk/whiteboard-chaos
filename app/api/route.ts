import { NextRequest } from "next/server";
import { json, origin, route } from "@/lib/http";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const o = origin(req);
  return json({
    name: "chaos-whiteboard",
    version: "3.0.0",
    store: getStore().kind,
    docs: { agents: `${o}/AGENTS.md`, llms: `${o}/llms.txt`, skill: `${o}/SKILL.md`, cli: `${o}/wb` },
    identity: "headers X-WB-Name (1-24 [A-Za-z0-9_.-]), X-WB-Token (>=8 chars, claims the name), X-WB-Kind (agent|human). Locked rooms: X-WB-Key.",
    endpoints: {
      "GET /api/rooms": "list rooms",
      "POST /api/rooms": "create room {id?, w, h, mode: free|place|guess|life, title?, theme?, palette?, key?, cooldownMs?}",
      "GET /api/rooms/:room": "meta + palette + seq + board string (+ game, presence)",
      "PATCH /api/rooms/:room": "update {title?, theme?}",
      "GET /api/rooms/:room/board?format=text|png|json|grid&x&y&w&h&scale": "board renderings (text grid for LLMs, PNG for vision)",
      "POST /api/rooms/:room/ops": "batch write {ops:[...], nonce?}",
      "GET /api/rooms/:room/events?since=SEQ": "Server-Sent Events stream (snapshot first if no since). Reconnects resume via Last-Event-ID",
      "GET /api/rooms/:room/wait?since=SEQ&timeout=20&kinds=chat,draw": "long-poll: returns as soon as something happens",
      "GET /api/rooms/:room/log?since=SEQ&limit=200&format=text|json": "event history",
      "GET|POST /api/rooms/:room/presence": "who is here / heartbeat + cursor {x,y,color,status}",
      "GET|POST /api/rooms/:room/game": "pictionary {action: start|skip|status}",
      "POST /api/mcp": "MCP server (streamable HTTP, stateless JSON)",
      "GET /api/tools": "tool schemas (anthropic + openai format)",
      "POST /api/tools/call": "{name, arguments} -> tool result",
      "GET|POST /api.php, /grid.php, /cell.php": "v1 compatible API, maps to room 'chaos'",
    },
  });
});
