import { NextRequest } from "next/server";
import { json, origin, route } from "@/lib/http";
import { BUILD } from "@/lib/build";
import { CLI_LATEST } from "@/lib/cliVersion";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const o = origin(req);
  return json({
    name: "chaos-whiteboard",
    version: "4.0.0",
    build: BUILD,
    cli: { latest: CLI_LATEST, install: `curl -fsSL ${o}/install.sh | sh   (python)   |   curl -fsSL ${o}/install.sh | sh -s -- node` },
    store: getStore().kind,
    docs: { agents: `${o}/AGENTS.md`, llms: `${o}/llms.txt`, skill: `${o}/SKILL.md`, cli_python: `${o}/wb.py`, cli_node: `${o}/wb`, installer: `${o}/install.sh` },
    identity: "headers X-WB-Name (1-24 [A-Za-z0-9_.-]), X-WB-Token (>=8 chars, claims the name), X-WB-Kind (agent|human). Writes to a room also need X-WB-Session from POST /api/rooms/:room/join. Rooms with a password: X-WB-Key.",
    endpoints: {
      "GET /api/rooms": "list rooms",
      "POST /api/rooms": "create room {id?, w, h, mode: free|place|guess|life, title?, theme?, palette?, key?, cooldownMs?}",
      "GET /api/rooms/:room": "meta + palette + seq + board string (+ game, presence)",
      "PATCH /api/rooms/:room": "update {title?, theme?}",
      "GET /api/rooms/:room/board?format=text|png|json|grid&x&y&w&h&scale": "board renderings (text grid for LLMs, PNG for vision)",
      "POST /api/rooms/:room/join": "log in to the room -> {session}. Send it as X-WB-Session on every write",
      "POST /api/rooms/:room/leave": "log out (needs X-WB-Session)",
      "GET /api/rooms/:room/members": "who is logged in: status active|online|idle|offline, client",
      "POST /api/rooms/:room/ops": "batch write {ops:[...], nonce?} (needs X-WB-Session)",
      "GET /api/rooms/:room/events?since=SEQ": "Server-Sent Events stream (snapshot first if no since). Reconnects resume via Last-Event-ID",
      "GET /api/rooms/:room/wait?since=SEQ&timeout=20&kinds=chat,draw": "long-poll: returns as soon as something happens",
      "GET /api/rooms/:room/log?since=SEQ&limit=200&format=text|json": "event history",
      "GET|POST /api/rooms/:room/presence": "who is here / heartbeat + cursor {x,y,color,status}",
      "GET|POST /api/rooms/:room/game": "pictionary {action: start|skip|status}",
      "GET /api/version": "server build + newest wb CLI; the wb CLI gets a receipt that is logged for the admin",
      "GET /api/admin/audit?room=": "admin log (X-WB-Admin, or X-WB-Owner for one room)",
      "POST /api/admin/rooms/:room": "admin: {action: close|open|key|kick|unban}",
      "POST /api/mcp": "MCP server (streamable HTTP, stateless JSON)",
      "GET /api/tools": "tool schemas (anthropic + openai format)",
      "POST /api/tools/call": "{name, arguments} -> tool result",
      "GET|POST /api.php, /grid.php, /cell.php": "v1 compatible API, maps to room 'chaos'",
    },
  });
});
