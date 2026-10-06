"use client";

/**
 * A key's easing curve (ENGINE_PARITY_ROADMAP.md EP17): a cubic Bézier from
 * (0,0) to (1,1) — time across, progress up — shaped by dragging its two
 * handles, as CSS's cubic-bezier. Handles may overshoot (0..1 across, −1..2
 * up) for anticipation and bounce. Presets set common shapes.
 */

import { useRef, useState } from "react";

import { DEFAULT_EASE_CURVE, easeCurve, type EaseCurve } from "@cartbox/editor";

const SIZE = 120;
const PAD = 30;
const PRESETS: Record<string, EaseCurve> = {
  "ease in-out": DEFAULT_EASE_CURVE,
  "ease in": [0.42, 0, 1, 1],
  "ease out": [0, 0, 0.58, 1],
  overshoot: [0.34, 1.56, 0.64, 1],
  anticipate: [0.36, -0.4, 0.7, 1],
};

/** Canvas point for curve coordinates (y up; room above and below for overshoot). */
const toPx = (x: number, y: number) => ({ x: PAD + x * SIZE, y: PAD + (1 - y) * SIZE });

export function CurveEditor({ curve, onChange }: { curve: EaseCurve; onChange: (curve: EaseCurve) => void }) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ handle: 0 | 1; curve: EaseCurve } | null>(null);
  const shown = drag?.curve ?? curve;
  const [x1, y1, x2, y2] = shown;
  const path = Array.from({ length: 41 }, (_, i) => {
    const u = i / 40;
    const p = toPx(u, easeCurve(shown, u));
    return `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  }).join(" ");
  const a = toPx(0, 0);
  const b = toPx(1, 1);
  const h1 = toPx(x1, y1);
  const h2 = toPx(x2, y2);

  const move = (e: React.PointerEvent) => {
    if (!drag || !svg.current) return;
    const r = svg.current.getBoundingClientRect();
    const scale = r.width / (SIZE + PAD * 2);
    const x = Math.max(0, Math.min(1, ((e.clientX - r.left) / scale - PAD) / SIZE));
    const y = Math.max(-1, Math.min(2, 1 - ((e.clientY - r.top) / scale - PAD) / SIZE));
    const round = (v: number) => Math.round(v * 100) / 100;
    const next: EaseCurve = drag.handle === 0 ? [round(x), round(y), x2, y2] : [x1, y1, round(x), round(y)];
    setDrag({ handle: drag.handle, curve: next });
  };

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
      <svg
        ref={svg}
        width={(SIZE + PAD * 2) * 0.8}
        height={(SIZE + PAD * 2) * 0.8}
        viewBox={`0 0 ${SIZE + PAD * 2} ${SIZE + PAD * 2}`}
        role="img"
        aria-label={`Easing curve ${shown.join(", ")}`}
        style={{ background: "rgba(0,0,0,0.3)", borderRadius: 6, touchAction: "none", flex: "none" }}
        onPointerMove={move}
        onPointerUp={() => {
          if (drag) onChange(drag.curve);
          setDrag(null);
        }}
      >
        <rect x={a.x} y={b.y} width={SIZE} height={SIZE} fill="none" stroke="rgba(255,255,255,0.15)" />
        <line x1={a.x} y1={a.y} x2={h1.x} y2={h1.y} stroke="#7db8fc" strokeWidth={1} />
        <line x1={b.x} y1={b.y} x2={h2.x} y2={h2.y} stroke="#7db8fc" strokeWidth={1} />
        <path d={path} fill="none" stroke="#ffd84a" strokeWidth={2} />
        {([h1, h2] as const).map((h, i) => (
          <circle
            key={i}
            cx={h.x}
            cy={h.y}
            r={7}
            fill="#7db8fc"
            style={{ cursor: "grab" }}
            aria-label={i === 0 ? "First handle" : "Second handle"}
            onPointerDown={(e) => {
              (e.target as Element).setPointerCapture?.(e.pointerId);
              svg.current?.setPointerCapture(e.pointerId);
              setDrag({ handle: i as 0 | 1, curve });
            }}
          />
        ))}
      </svg>
      <div style={{ display: "grid", gap: 3 }}>
        {Object.entries(PRESETS).map(([name, c]) => (
          <button key={name} type="button" className="cbx-btn" style={{ fontSize: 11, padding: "2px 6px" }} onClick={() => onChange(c)}>
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}
