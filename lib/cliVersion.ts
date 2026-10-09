// wb CLI version guard. The CLI sends "user-agent: wb-cli/X.Y.Z". The server
// refuses CLIs older than the minimum (default: the CLI this server ships at
// /wb), so agents cannot keep playing with stale tools.
//   WB_MIN_CLI=3.3.0   accept older CLIs down to this version
//   WB_MIN_CLI=off     no guard
import { DOCS } from "./generated-docs";

export const CLI_LATEST = /const VERSION = "(\d+\.\d+\.\d+)"/.exec(DOCS.wb ?? "")?.[1] ?? "0.0.0";

export function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

export function cliMin(): string | null {
  const v = process.env.WB_MIN_CLI?.trim();
  if (v === "off" || v === "0") return null;
  return v && /^\d+\.\d+\.\d+$/.test(v) ? v : CLI_LATEST;
}

// The CLI version of a request, or null when the caller is not the wb CLI.
export function cliVersionOf(ua: string | null): string | null {
  return /^wb-cli\/(\d+\.\d+\.\d+)/.exec(ua ?? "")?.[1] ?? null;
}
