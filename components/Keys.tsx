"use client";
// Keyboard helpers for humans: the tool ring (hold Q or Ctrl) and the help
// panel with a map of the left hand's keys.
import { useEffect, useMemo, useRef, useState } from "react";
import { leftHandMap, OTHER_KEYS, TOOLS, type Tool } from "./tools";

export type WheelPick = { tool: Tool } | { color: string } | null;

const R_DEAD = 22, R_COLOR_OUT = 62, R_TOOL_OUT = 124;

function sector(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number) {
  const p = (r: number, a: number) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(r1, a0)} A${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L${p(r0, a1)} A${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
}

// The ring opens around the cursor. Pointing is by direction: a flick toward a
// tool picks it even outside the ring. The inner ring holds 8 palette colors.
export function ToolWheel({ at, tool, color, colors, onHover, onPick }: {
  at: { x: number; y: number }; tool: Tool; color: string; colors: string[];
  onHover: (p: WheelPick) => void; onPick: (p: WheelPick) => void;
}) {
  const size = R_TOOL_OUT * 2 + 24;
  const half = size / 2;
  // keep the whole ring on screen
  const [pos] = useState(() => ({
    x: Math.max(half, Math.min(window.innerWidth - half, at.x)),
    y: Math.max(half, Math.min(window.innerHeight - half, at.y)),
  }));
  const [hover, setHover] = useState<WheelPick>(null);
  const hoverRef = useRef<WheelPick>(null);
  const cols = useMemo(() => colors.slice(0, 8), [colors]);
  const step = (2 * Math.PI) / TOOLS.length;
  const cstep = (2 * Math.PI) / Math.max(1, cols.length);
  const start = -Math.PI / 2 - step / 2; // first tool straight up

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const dx = e.clientX - pos.x, dy = e.clientY - pos.y;
      const d = Math.hypot(dx, dy);
      let next: WheelPick = null;
      if (d >= R_DEAD) {
        const a = Math.atan2(dy, dx);
        if (d < R_COLOR_OUT && cols.length) {
          const i = Math.floor((((a - start) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / cstep);
          next = { color: cols[Math.min(cols.length - 1, i)] };
        } else {
          const i = Math.floor((((a - start) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / step);
          next = { tool: TOOLS[Math.min(TOOLS.length - 1, i)].id };
        }
      }
      const same = JSON.stringify(next) === JSON.stringify(hoverRef.current);
      if (!same) { hoverRef.current = next; setHover(next); onHover(next); }
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, [pos, cols, cstep, step, start, onHover]);

  const isTool = (id: Tool) => !!hover && "tool" in hover && hover.tool === id;
  const isColor = (c: string) => !!hover && "color" in hover && hover.color === c;
  const label = hover ? ("tool" in hover ? TOOLS.find((t) => t.id === hover.tool)!.label : hover.color) : "Point, then let go";

  return (
    <div className="wheel" style={{ left: pos.x - half, top: pos.y - half, width: size, height: size }} role="menu" aria-label="Tool ring">
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        {TOOLS.map((t, i) => {
          const a0 = start + i * step, a1 = a0 + step, mid = (a0 + a1) / 2;
          const ix = half + Math.cos(mid) * ((R_COLOR_OUT + R_TOOL_OUT) / 2), iy = half + Math.sin(mid) * ((R_COLOR_OUT + R_TOOL_OUT) / 2);
          return (
            <g key={t.id} className={`slice${isTool(t.id) ? " hot" : ""}${tool === t.id ? " cur" : ""}`} role="menuitem" aria-label={t.label}
              onPointerUp={() => onPick({ tool: t.id })}>
              <path d={sector(half, half, R_COLOR_OUT + 4, R_TOOL_OUT, a0 + 0.012, a1 - 0.012)} />
              <g transform={`translate(${ix - 11} ${iy - 15}) scale(0.92)`}><path className="ico" d={t.icon} /></g>
              <text x={ix} y={iy + 19} textAnchor="middle">{t.keys[0].toUpperCase()}</text>
            </g>
          );
        })}
        {cols.map((c, i) => {
          const a0 = start + i * cstep, a1 = a0 + cstep;
          return (
            <path key={c + i} className={`swatch${isColor(c) ? " hot" : ""}`} d={sector(half, half, R_DEAD + 2, R_COLOR_OUT, a0 + 0.02, a1 - 0.02)} style={{ fill: c }}
              onPointerUp={() => onPick({ color: c })} role="menuitem" aria-label={`Color ${c}`} />
          );
        })}
        <circle cx={half} cy={half} r={R_DEAD - 3} className="core" style={{ fill: color }} />
      </svg>
      <div className="wheel-label" style={{ top: size - 6 }}>{label}</div>
    </div>
  );
}

export function KeysHelp({ onClose, guessRoom }: { onClose: () => void; guessRoom: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" || e.key === "?") { e.stopImmediatePropagation(); e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);
  const rows = leftHandMap(guessRoom);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal keys-help" role="dialog" aria-modal="true" aria-labelledby="keys-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 id="keys-title">Keyboard</h2>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
        <p className="keys-lede">Your right hand draws. Your left hand stays here and changes tools without a trip to the toolbar.</p>
        <div className="keyboard" aria-label="Left hand keys">
          {rows.map((row, r) => (
            <div className="krow" key={r} style={{ paddingLeft: r * 22 }}>
              {row.map((k) => (
                <div key={k.key} className={`kcap${k.label ? "" : " idle"}${k.hold ? " hold" : ""}`}>
                  <span className="kletter">{k.key.toUpperCase()}</span>
                  {k.icon && <svg viewBox="0 0 24 24" aria-hidden><path d={k.icon} /></svg>}
                  <span className="kname">{k.label}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <dl className="keys-list">
          {OTHER_KEYS.map(([k, v]) => (
            <div key={k}><dt>{k.split("  ").map((p) => <kbd key={p}>{p}</kbd>)}</dt><dd>{v}</dd></div>
          ))}
        </dl>
        <p className="note">Old letters still work: P pencil, L line, O circle, I pick color, H move the view, M mirror.</p>
      </div>
    </div>
  );
}
