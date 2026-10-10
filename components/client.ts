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

// The deploy this page belongs to. Sent with every write; the server answers
// 426 app_outdated when it runs a newer one, and the page asks for a reload.
export const BUILD = process.env.NEXT_PUBLIC_WB_BUILD || "dev";
export const OUTDATED_EVENT = "wb:outdated";

// Room sessions: joining a room returns a session token; writes carry it.
const sessKey = (room: string, name: string) => `wb.sess.${room}.${name.toLowerCase()}`;
export const roomSession = (room: string) => safeGet(sessKey(room, getIdentity().name)) || null;
export const saveSession = (room: string, s: string) => safeSet(sessKey(room, getIdentity().name), s);
export const dropSession = (room: string) => safeSet(sessKey(room, getIdentity().name), "");
const joining = new Map<string, Promise<string>>();
export function joinRoom(room: string): Promise<string> {
  const k = `${room}|${getIdentity().name}`;
  let p = joining.get(k);
  if (!p) {
    p = api<{ session: string }>(`/api/rooms/${room}/join`, { body: {} }).then((r) => { saveSession(room, r.session); return r.session; });
    p.finally(() => joining.delete(k)).catch(() => {});
    joining.set(k, p);
  }
  return p;
}
export const ensureSession = async (room: string) => roomSession(room) ?? joinRoom(room);
const WRITE_PATH = /^\/api\/rooms\/([a-z0-9][a-z0-9-]{0,31})\/(ops|game|presence|leave)$/;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryMs?: number) { super(message); }
}

export async function api<T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown; keepalive?: boolean; headers?: Record<string, string> } = {}, retried = false): Promise<T> {
  const id = getIdentity();
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
  const room = method !== "GET" ? WRITE_PATH.exec(path)?.[1] : undefined;
  const sess = room ? await ensureSession(room) : null;
  const res = await fetch(path, {
    method,
    headers: {
      "content-type": "application/json", "x-wb-name": id.name, "x-wb-token": id.token, "x-wb-kind": "human", "x-wb-build": BUILD,
      ...(sess ? { "x-wb-session": sess } : {}), ...(init.headers ?? {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    keepalive: init.keepalive,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 426 && data.error === "app_outdated" && typeof window !== "undefined") window.dispatchEvent(new CustomEvent(OUTDATED_EVENT));
    // session gone (left elsewhere, joined again in another tab): log in again once
    if (room && !retried && res.status === 401 && (data.error === "not_joined" || data.error === "bad_session")) {
      dropSession(room);
      await joinRoom(room);
      return api<T>(path, init, true);
    }
    throw new ApiError(res.status, data.error ?? "error", data.message ?? `HTTP ${res.status}`, data.retryMs);
  }
  return data as T;
}

export function nonce() {
  return "ui-" + Date.now().toString(36) + "-" + rand(10);
}

// Room owner keys and the admin key live only in this browser.
export const ownerKeyFor = (room: string) => safeGet(`wb.owner.${room}`) ?? "";
export const saveOwnerKey = (room: string, key: string) => safeSet(`wb.owner.${room}`, key);
export const adminKey = () => safeGet("wb.admin") ?? "";
export const saveAdminKey = (key: string) => safeSet("wb.admin", key);
export const ownerHeaders = (room: string): Record<string, string> => {
  const h: Record<string, string> = {};
  const o = ownerKeyFor(room); if (o) h["x-wb-owner"] = o;
  const a = adminKey(); if (a) h["x-wb-admin"] = a;
  return h;
};
export const pref = (k: string, d: string) => safeGet(`wb.pref.${k}`) ?? d;
export const setPref = (k: string, v: string) => safeSet(`wb.pref.${k}`, v);
