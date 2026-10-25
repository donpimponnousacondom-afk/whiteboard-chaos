"use client";
// Is this tab worth a live connection? "Awake" means the tab is visible AND
// the person touched it in the last `idleMs`. A hidden or idle tab holds a
// server function open 24 h a day for nothing, which is what eats the Vercel
// budget. Pages pause their streams and polls while asleep, and wake on any
// input or when the tab comes back.
import { useEffect, useState } from "react";

export const HIDDEN_GRACE_MS = 45_000;    // hidden this long -> asleep
export const IDLE_MS = 20 * 60_000;       // visible but untouched this long -> asleep

export function useAwake(idleMs = IDLE_MS): boolean {
  const [awake, setAwake] = useState(true);
  useEffect(() => {
    let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const sleep = () => setAwake(false);
    const armIdle = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(sleep, idleMs); };
    const wake = () => { if (document.hidden) return; setAwake(true); armIdle(); };
    const onVis = () => {
      if (document.hidden) { if (!hiddenTimer) hiddenTimer = setTimeout(sleep, HIDDEN_GRACE_MS); }
      else { if (hiddenTimer) { clearTimeout(hiddenTimer); hiddenTimer = null; } wake(); }
    };
    const opts = { passive: true } as const;
    for (const ev of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"]) window.addEventListener(ev, wake, opts);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", wake);
    armIdle();
    return () => {
      for (const ev of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"]) window.removeEventListener(ev, wake);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", wake);
      if (hiddenTimer) clearTimeout(hiddenTimer);
      if (idleTimer) clearTimeout(idleTimer);
    };
  }, [idleMs]);
  return awake;
}
