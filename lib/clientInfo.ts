// Who is calling, from the User-Agent. Shown in the admin feed and the member
// list, so a human can see at once whether an agent uses the real wb CLI or
// fakes it with curl.
import type { ClientInfo } from "./types";

export function parseClient(ua: string | null, via?: string): ClientInfo {
  const u = (ua ?? "").trim();
  let m: RegExpExecArray | null;
  if ((m = /^wb-cli\/(\d+\.\d+\.\d+)(?:\s*\(([^)]*)\))?/.exec(u))) {
    // "wb-cli/4.0.0 (python 3.14.0; linux)" or older "wb-cli/3.4.0"
    const parts = (m[2] ?? "").split(";").map((s) => s.trim()).filter(Boolean);
    const rt = parts.find((p) => /^(python|node)\b/.test(p)) ?? (m[2] ? undefined : "node");
    return { app: "wb", ver: m[1], rt, label: `wb ${m[1]}${rt ? ` ${rt}` : ""}`, raw: false };
  }
  if (via === "mcp") return { app: "mcp", label: `mcp${u ? ` (${short(u)})` : ""}`, raw: false };
  if (via === "tools") return { app: "tools", label: `tool calls${u ? ` (${short(u)})` : ""}`, raw: false };
  if (via === "v1") return { app: "v1", label: `v1 api (${short(u) || "no user-agent"})`, raw: false };
  if ((m = /^curl\/([\d.]+)/i.exec(u))) return { app: "curl", ver: m[1], label: `curl ${m[1]}`, raw: true };
  if ((m = /^Wget\/([\d.]+)/i.exec(u))) return { app: "wget", ver: m[1], label: `wget ${m[1]}`, raw: true };
  if ((m = /^Python-urllib\/([\d.]+)/i.exec(u))) return { app: "python-urllib", ver: m[1], label: `python urllib ${m[1]}`, raw: true };
  if ((m = /^python-requests\/([\d.]+)/i.exec(u))) return { app: "python-requests", ver: m[1], label: `python requests ${m[1]}`, raw: true };
  if ((m = /^python-httpx\/([\d.]+)/i.exec(u))) return { app: "python-httpx", ver: m[1], label: `python httpx ${m[1]}`, raw: true };
  if (/aiohttp/i.test(u)) return { app: "aiohttp", label: "python aiohttp", raw: true };
  if (/^node(-fetch)?\b|undici/i.test(u)) return { app: "node", label: `node fetch`, raw: true };
  if (/mozilla/i.test(u)) {
    const b = /(Firefox|Edg|OPR|Chrome|Safari)\/(\d+)/.exec(u);
    const name = b ? ({ Edg: "Edge", OPR: "Opera" } as Record<string, string>)[b[1]] ?? b[1] : "browser";
    return { app: "browser", ver: b?.[2], label: `${name}${b ? ` ${b[2]}` : ""}`, raw: false };
  }
  if (!u) return { app: "unknown", label: "no user-agent", raw: true };
  return { app: "other", label: short(u), raw: true };
}

function short(u: string) { return u.length > 40 ? u.slice(0, 40) + "..." : u; }
