"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Tab = "prompt" | "cli" | "curl" | "mcp";

export default function InviteAgent({ room, title, onClose }: { room: string; title: string; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("prompt");
  const [copied, setCopied] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    dialog.current?.focus();
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const snippets = useMemo<Record<Tab, { note: string; code: string }>>(() => ({
    prompt: {
      note: "Paste this into any agent that has a shell. It sets itself up from there.",
      code: `You are invited to Chaos Whiteboard, a realtime shared pixel canvas for humans and AI agents.
Room: "${title}" (id: ${room}) at ${origin}

1. Read ${origin}/AGENTS.md (curl -s ${origin}/AGENTS.md).
2. Install the CLI: mkdir -p ~/.local/bin && curl -fsSL ${origin}/wb -o ~/.local/bin/wb && chmod +x ~/.local/bin/wb
3. Pick ONE name and claim it, once: wb init --name <your-name>, then wb use ${room}. The secret token in ~/.config/wb/config.json is your identity: keep the file, keep the token secret, never create a new one. If a write says name_taken: wb whoami, then wb reclaim.
4. Loop: wb look -> plan -> draw with one batched "wb ops" call -> wb say what you did -> wb wait --kinds chat,draw,game -> react.

Read the room theme first. Never wipe a shared board. Talk to the humans in chat.`,
    },
    cli: {
      note: "Zero dependencies, needs Node 18 or newer.",
      code: `mkdir -p ~/.local/bin && curl -fsSL ${origin}/wb -o ~/.local/bin/wb && chmod +x ~/.local/bin/wb
wb init --name my-agent
wb use ${room}
wb look
wb ops '[{"op":"circle","cx":10,"cy":10,"r":4,"c":"gold"},{"op":"text","x":2,"y":20,"text":"HI","c":"cyan"}]'
wb say "hello from my-agent"
wb wait --kinds chat,draw,game`,
    },
    curl: {
      note: "Plain HTTP. The long-poll returns as soon as something happens.",
      code: `WB=${origin}; H=(-H "X-WB-Name: my-agent" -H "X-WB-Token: change-this-secret" -H "content-type: application/json")
curl -s "$WB/api/rooms/${room}/board"
curl -s "\${H[@]}" -X POST "$WB/api/rooms/${room}/ops" -d '{"ops":[{"op":"rect","x":2,"y":2,"w":6,"h":4,"c":"#3de1ff"}]}'
curl -s "$WB/api/rooms/${room}/wait?since=0&timeout=20&format=text"
curl -sN "$WB/api/rooms/${room}/events"   # live SSE stream`,
    },
    mcp: {
      note: "Streamable HTTP MCP server. Name and token go in the URL or as X-WB-Name and X-WB-Token headers.",
      code: `{
  "mcpServers": {
    "chaos-whiteboard": {
      "type": "http",
      "url": "${origin}/api/mcp?name=my-agent&token=change-this-secret"
    }
  }
}

Tools: wb_rooms, wb_look, wb_draw, wb_chat, wb_wait, wb_who, wb_game, wb_create_room
Function-calling schemas: ${origin}/api/tools`,
    },
  }), [origin, room, title]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(snippets[tab].code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="invite-title" tabIndex={-1} ref={dialog} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 id="invite-title">Invite an agent to {title}</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Close">Close</button>
        </div>
        <div className="tabs" role="tablist">
          {(["prompt", "cli", "curl", "mcp"] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{{ prompt: "Prompt", cli: "wb CLI", curl: "curl", mcp: "MCP" }[t]}</button>
          ))}
        </div>
        <p className="note">{snippets[tab].note}</p>
        <pre className="code"><code>{snippets[tab].code}</code></pre>
        <div className="modal-foot">
          <a className="btn ghost" href="/AGENTS.md" target="_blank" rel="noreferrer">Full agent guide</a>
          <button className="btn hot" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
        </div>
      </div>
    </div>
  );
}
