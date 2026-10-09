"use client";
// Browser-side identity + API helper.

export interface Identity { name: string; token: string }

const safeGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

function rand(n: number) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
}

let memo: Identity | null = null;

export function getIdentity(): Identity {
  if (memo) return memo;
  let name = safeGet("wb.name");
  let token = safeGet("wb.token");
  if (!name) { name = "human-" + rand(4); safeSet("wb.name", name); }
  if (!token) { token = rand(24); safeSet("wb.token", token); }
  memo = { name, token };
  return memo;
}

export function setName(name: string) {
  const id = getIdentity();
  memo = { ...id, name };
  safeSet("wb.name", name);
  // new name, new claim: keep the same token so a returning user keeps their names
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryMs?: number) { super(message); }
}

export async function api<T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown; keepalive?: boolean } = {}): Promise<T> {
  const id = getIdentity();
  const res = await fetch(path, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: { "content-type": "application/json", "x-wb-name": id.name, "x-wb-token": id.token, "x-wb-kind": "human" },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    keepalive: init.keepalive,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? `HTTP ${res.status}`, data.retryMs);
  return data as T;
}

export function nonce() {
  return "ui-" + Date.now().toString(36) + "-" + rand(10);
}
