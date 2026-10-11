"use client";

/**
 * A live picture of a controller's sticks and triggers for the Start menu
 * (CONTROLLER_SETTINGS_ROADMAP.md C1). Each stick shows its raw position, its
 * dead zones and max input threshold, and where the player's tuning puts it;
 * each trigger shows its pull against the point it presses at; and a line says
 * what the game receives as move and look. Nothing here changes a setting.
 */

import { useEffect, useState, type CSSProperties } from "react";
import {
  DEFAULT_STICK_DEAD_ZONES,
  DEFAULT_TRIGGER_THRESHOLD,
  applyLookSettings,
  layoutSticks,
  lookGains,
  shapeStick,
  standardizePad,
  type ControlSettings,
  type StickDeadZones,
} from "@cartbox/player";

interface PadReading {
  readonly axes: readonly [number, number, number, number];
  readonly lt: number;
  readonly rt: number;
}

/** The first connected controller's sticks and triggers, read every frame while shown. */
function usePadReading(): PadReading | null {
  const [reading, setReading] = useState<PadReading | null>(null);
  useEffect(() => {
    let frame = 0;
    let last = "";
    const loop = () => {
      frame = requestAnimationFrame(loop);
      const raw = Array.from(navigator.getGamepads?.() ?? []).find((p) => p && p.connected);
      const next: PadReading | null = raw
        ? (() => {
            const pad = standardizePad(raw);
            const a = (i: number) => pad.axes[i] ?? 0;
            const t = (i: number) => pad.buttons[i]?.value || (pad.buttons[i]?.pressed ? 1 : 0);
            return { axes: [a(0), a(1), a(2), a(3)], lt: t(6), rt: t(7) };
          })()
        : null;
      // Re-render only when something moved enough to see.
      const key = next ? [...next.axes, next.lt, next.rt].map((v) => v.toFixed(3)).join() : "";
      if (key === last) return;
      last = key;
      setReading(next);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);
  return reading;
}

/**
 * `lookGain`: the game reads its look gain (C2), so it gets the look stick
 * unscaled and the player's sensitivity as a speed beside it.
 */
export function StickPreview({ settings, lookGain = false }: { settings: ControlSettings; lookGain?: boolean }) {
  const reading = usePadReading();
  const left = settings.leftStick ?? DEFAULT_STICK_DEAD_ZONES;
  const right = settings.rightStick ?? DEFAULT_STICK_DEAD_ZONES;
  const raw = reading?.axes ?? null;
  const shapedLeft = raw ? shapeStick(raw[0], raw[1], left) : null;
  const shapedRight = raw ? shapeStick(raw[2], raw[3], right) : null;
  const game = shapedLeft && shapedRight ? applyLookSettings(layoutSticks([...shapedLeft, ...shapedRight], settings.stickLayout), settings, !lookGain) : null;
  const gains = lookGain ? lookGains(settings) : null;
  const fmt = (x: number, y: number) => `${x.toFixed(2)}, ${y.toFixed(2)}`.replace(/-/g, "−");

  return (
    <div style={styles.wrap} aria-label="Live controller preview">
      <div style={styles.sticks}>
        <Stick label="Left stick" zones={left} raw={raw ? [raw[0], raw[1]] : null} shaped={shapedLeft} />
        <Stick label="Right stick" zones={right} raw={raw ? [raw[2], raw[3]] : null} shaped={shapedRight} />
        <div style={styles.triggers}>
          <Trigger label="LT" value={reading?.lt ?? 0} pull={settings.leftTrigger ?? DEFAULT_TRIGGER_THRESHOLD} />
          <Trigger label="RT" value={reading?.rt ?? 0} pull={settings.rightTrigger ?? DEFAULT_TRIGGER_THRESHOLD} />
        </div>
      </div>
      <p style={styles.caption}>
        {game ? (
          <span style={{ fontFamily: "var(--font-data)", fontVariantNumeric: "tabular-nums" }}>
            The game receives: move {fmt(game[0], game[1])} · look {fmt(game[2], game[3])}
            {gains && ` at ×${gains.x.toFixed(2)} turn, ×${gains.y.toFixed(2)} pitch`}
          </span>
        ) : (
          "Connect a controller and move its sticks to see them here."
        )}
      </p>
      <p style={styles.legend}>
        Hollow dot: where the stick is. Filled dot: what it reads after its dead zones. Shaded: the dead zones. Dashed ring: full lean.
      </p>
    </div>
  );
}

const R = 46; // the stick's full travel, in SVG units

function Stick({ label, zones, raw, shaped }: { label: string; zones: StickDeadZones; raw: readonly [number, number] | null; shaped: readonly [number, number] | null }) {
  const band = zones.axial * R;
  return (
    <figure style={styles.figure}>
      <svg viewBox="-50 -50 100 100" width={112} height={112} role="img" aria-label={`${label}: dead zones and position`}>
        <circle r={R} fill="var(--well)" stroke="var(--border-strong)" />
        {band > 0 && (
          <g fill="var(--muted)" opacity={0.25}>
            <rect x={-band} y={-R} width={band * 2} height={R * 2} />
            <rect x={-R} y={-band} width={R * 2} height={band * 2} />
          </g>
        )}
        {zones.radial > 0 && <circle r={zones.radial * R} fill="var(--muted)" opacity={0.35} />}
        {zones.maxInput < 1 && <circle r={zones.maxInput * R} fill="none" stroke="var(--muted)" strokeDasharray="3 3" />}
        <line x1={-R} x2={R} y1={0} y2={0} stroke="var(--border)" />
        <line y1={-R} y2={R} x1={0} x2={0} stroke="var(--border)" />
        {raw && <circle cx={clampUnit(raw[0]) * R} cy={clampUnit(raw[1]) * R} r={5} fill="none" stroke="var(--text)" strokeWidth={1.5} />}
        {shaped && <circle cx={shaped[0] * R} cy={shaped[1] * R} r={3.5} fill="var(--accent)" />}
      </svg>
      <figcaption style={styles.figcaption}>{label}</figcaption>
    </figure>
  );
}

function Trigger({ label, value, pull }: { label: string; value: number; pull: number }) {
  const on = value > 0 && value >= pull;
  return (
    <div style={{ display: "grid", gap: 2 }}>
      <span style={styles.figcaption}>
        {label} {on ? "pressed" : ""}
      </span>
      <svg viewBox="0 0 100 12" width={112} height={14} role="img" aria-label={`${label}: pulled ${Math.round(value * 100)}%, presses at ${Math.round(pull * 100)}%`}>
        <rect width={100} height={12} rx={3} fill="var(--well)" stroke="var(--border-strong)" />
        <rect width={Math.max(0, Math.min(1, value)) * 100} height={12} rx={3} fill={on ? "var(--accent)" : "var(--muted)"} />
        <line x1={pull * 100} x2={pull * 100} y1={0} y2={12} stroke="var(--text)" strokeWidth={1.5} />
      </svg>
    </div>
  );
}

const clampUnit = (v: number) => Math.max(-1, Math.min(1, v));

const styles: Record<string, CSSProperties> = {
  wrap: { padding: "8px 0", borderBottom: "1px solid var(--border)" },
  sticks: { display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" },
  figure: { margin: 0, display: "grid", justifyItems: "center", gap: 2 },
  figcaption: { fontSize: 12, color: "var(--muted)" },
  triggers: { display: "grid", gap: 10 },
  caption: { margin: "6px 0 0", fontSize: 13 },
  legend: { margin: "2px 0 0", fontSize: 12, color: "var(--faint)" },
};
