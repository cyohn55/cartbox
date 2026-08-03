"use client";

/**
 * Weather tab: authors the cart's particle/weather system.
 *
 * A weather system is a small set of emitters — rain, snow, drifting embers, or
 * rolling fog — which the player composites over each frame from a stateless field
 * (see @cartbox/player's ParticleOverlaySurface). This tab lets the author add
 * emitters and tune the handful of knobs each exposes (count, opacity, size,
 * fall/rise speed, wind, colour), judged against a live preview that runs the exact
 * `simulateEmitter` field the runtime uses, over a dark stand-in sky.
 *
 * The spec is owned by the workbench: it persists with the cart on Save and is
 * applied by the player on Run and on the public play page. Every mutation goes
 * through the pure reducers in particlesAuthoring so this component holds no model
 * logic of its own.
 */

import { useEffect, useRef, useState } from "react";
import { PARTICLE_KINDS, simulateEmitter, type ParticleKind, type ParticleSpec } from "@cartbox/player";

import styles from "./editor.module.css";
import { RailGroup, RailHint, RangeControl } from "./railControls";
import {
  InspectorHint,
  WorkbenchInspector,
  WorkbenchRail,
  type InspectorSlots,
  type RailSlots,
} from "./workbenchPanels";
import { MAX_EMITTERS, withEmitterAdded, withEmitterRemoved, withEmitterUpdated } from "./particlesAuthoring";

interface ParticlesEditorProps {
  /** The cart's screen size, so the preview matches the runtime overlay. */
  width: number;
  height: number;
  particles: ParticleSpec | null;
  onParticlesChange: (particles: ParticleSpec | null) => void;
}

/** Human labels for the weather kinds, in the picker's order. */
const KIND_LABEL: Record<ParticleKind, string> = {
  rain: "Rain",
  snow: "Snow",
  embers: "Embers",
  fog: "Fog",
};

/** An 0..255 RGB triplet as a "#rrggbb" string for a colour input. */
function toHex([r, g, b]: readonly number[]): string {
  const channel = (value: number) => Math.round(value).toString(16).padStart(2, "0");
  return `#${channel(r ?? 0)}${channel(g ?? 0)}${channel(b ?? 0)}`;
}

/** Parse a "#rrggbb" colour input value back to an 0..255 RGB triplet. */
function fromHex(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16) || 0,
    parseInt(hex.slice(3, 5), 16) || 0,
    parseInt(hex.slice(5, 7), 16) || 0,
  ];
}

export function ParticlesEditor({ width, height, particles, onParticlesChange }: ParticlesEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selected, setSelected] = useState(0);

  const emitterCount = particles?.emitters.length ?? 0;
  const activeIndex = emitterCount === 0 ? -1 : Math.min(selected, emitterCount - 1);
  const activeEmitter = activeIndex >= 0 ? particles!.emitters[activeIndex]! : null;

  // Live preview: run the real particle field each frame over a dark sky, so the
  // motion and density read exactly as they will at runtime.
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    canvas.width = width;
    canvas.height = height;

    const emitters = particles?.emitters ?? [];
    let frame = 0;
    let raf = 0;
    const draw = () => {
      context.fillStyle = "#0c0a14";
      context.fillRect(0, 0, width, height);
      for (const emitter of emitters) {
        for (const particle of simulateEmitter(emitter, frame, width, height)) {
          context.globalAlpha = particle.alpha;
          context.fillStyle = `rgb(${particle.color[0]}, ${particle.color[1]}, ${particle.color[2]})`;
          const size = Math.max(1, Math.round(particle.size));
          if (particle.streak > 0) {
            context.fillRect(Math.round(particle.x), Math.round(particle.y), size, Math.round(particle.streak) + 1);
          } else {
            context.fillRect(Math.round(particle.x - size / 2), Math.round(particle.y - size / 2), size, size);
          }
        }
      }
      context.globalAlpha = 1;
      frame += 1;
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [particles, width, height]);

  const rail: RailSlots = {
    layer: (
      <RailGroup label="Weather">
        <div className={styles.toolGroup}>
          {(particles?.emitters ?? []).map((emitter, index) => (
            <button
              key={index}
              type="button"
              className={`${styles.toolBtn} ${index === activeIndex ? styles.toolBtnActive : ""}`}
              onClick={() => setSelected(index)}
              aria-pressed={index === activeIndex}
            >
              <span className={styles.toolGlyph} aria-hidden>
                ❄
              </span>
              {KIND_LABEL[emitter.kind]} · {emitter.count}
            </button>
          ))}
        </div>
        <RailHint>Layer up to {MAX_EMITTERS} emitters. Each is drawn in front of the scene and finished by the FX stack.</RailHint>
        <div className={styles.toolGroup} role="group" aria-label="Add an emitter">
          {PARTICLE_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className={styles.toolBtn}
              onClick={() => {
                const next = withEmitterAdded(particles, kind);
                onParticlesChange(next);
                setSelected(next.emitters.length - 1);
              }}
              disabled={emitterCount >= MAX_EMITTERS}
              title={emitterCount >= MAX_EMITTERS ? `A cart holds at most ${MAX_EMITTERS} emitters` : `Add ${KIND_LABEL[kind]}`}
            >
              <span className={styles.toolGlyph} aria-hidden>
                ＋
              </span>
              {KIND_LABEL[kind]}
            </button>
          ))}
        </div>
      </RailGroup>
    ),
    toolOptions: activeEmitter ? (
      <RailGroup label={`${KIND_LABEL[activeEmitter.kind]} emitter`}>
        <RangeControl
          label="Count"
          min={1}
          max={600}
          value={activeEmitter.count}
          onChange={(count) => onParticlesChange(withEmitterUpdated(particles, activeIndex, { count }))}
          ariaLabel="Particle count"
          display={`${activeEmitter.count}`}
        />
        <RangeControl
          label="Opacity"
          min={0}
          max={100}
          value={Math.round(activeEmitter.opacity * 100)}
          onChange={(percent) => onParticlesChange(withEmitterUpdated(particles, activeIndex, { opacity: percent / 100 }))}
          ariaLabel="Particle opacity"
          display={`${Math.round(activeEmitter.opacity * 100)}%`}
        />
        <RangeControl
          label="Size"
          min={1}
          max={8}
          value={activeEmitter.size}
          onChange={(size) => onParticlesChange(withEmitterUpdated(particles, activeIndex, { size }))}
          ariaLabel="Particle size in pixels"
          display={`${activeEmitter.size}px`}
        />
        <RangeControl
          label="Speed"
          min={0}
          max={120}
          value={Math.round(activeEmitter.speed * 10)}
          onChange={(value) => onParticlesChange(withEmitterUpdated(particles, activeIndex, { speed: value / 10 }))}
          ariaLabel="Particle speed"
          display={`${activeEmitter.speed.toFixed(1)}`}
        />
        <RangeControl
          label="Wind"
          min={-60}
          max={60}
          value={Math.round(activeEmitter.wind * 10)}
          onChange={(value) => onParticlesChange(withEmitterUpdated(particles, activeIndex, { wind: value / 10 }))}
          ariaLabel="Horizontal wind drift"
          display={`${activeEmitter.wind.toFixed(1)}`}
        />
        <div className={styles.rangeRow}>
          <label htmlFor="particle-color" className={styles.groupLabel}>
            Colour
          </label>
          <input
            id="particle-color"
            type="color"
            value={toHex(activeEmitter.color)}
            onChange={(event) => onParticlesChange(withEmitterUpdated(particles, activeIndex, { color: fromHex(event.target.value) }))}
            aria-label="Particle colour"
          />
        </div>
        <button
          type="button"
          className={styles.toolBtn}
          style={{ marginTop: 8 }}
          onClick={() => {
            onParticlesChange(withEmitterRemoved(particles, activeIndex));
            setSelected((current) => Math.max(0, current - 1));
          }}
          title="Remove this emitter"
        >
          <span className={styles.toolGlyph} aria-hidden>
            ✕
          </span>
          Remove emitter
        </button>
      </RailGroup>
    ) : undefined,
    io: particles ? (
      <RailGroup label="System">
        <button type="button" className={styles.toolBtn} onClick={() => onParticlesChange(null)} title="Remove all weather">
          <span className={styles.toolGlyph} aria-hidden>
            🗑
          </span>
          Clear weather
        </button>
      </RailGroup>
    ) : undefined,
  };

  const inspector: InspectorSlots = {
    hint: (
      <InspectorHint>
        Weather is composited over the whole frame at runtime — in front of the cart and its backdrop, and graded and
        bloomed by the FX stack. The field is deterministic, so the preview matches playback exactly.
      </InspectorHint>
    ),
  };

  return (
    <div className={styles.body}>
      <WorkbenchRail slots={rail} />

      <section className={styles.stage}>
        <div className={styles.canvasPanel}>
          {particles ? (
            <canvas
              ref={canvasRef}
              className={styles.fxCanvas}
              style={{ imageRendering: "pixelated" }}
              role="img"
              aria-label="Weather preview"
            />
          ) : (
            <div className={styles.fxNote}>No weather yet. Add an emitter from the rail — rain, snow, embers, or fog.</div>
          )}
        </div>
        {particles && (
          <div className={styles.hud}>
            <span className={styles.hudItem}>
              <span className={styles.hudLabel}>Emitters</span>
              <span className={`${styles.hudValue} data`}>{emitterCount}</span>
            </span>
            <span className={styles.hudItem}>
              <span className={styles.hudLabel}>Particles</span>
              <span className={`${styles.hudValue} data`}>
                {(particles?.emitters ?? []).reduce((sum, emitter) => sum + emitter.count, 0)}
              </span>
            </span>
          </div>
        )}
      </section>

      <WorkbenchInspector slots={inspector} />
    </div>
  );
}
