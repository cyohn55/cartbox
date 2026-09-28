"use client";

/**
 * 3D particle effects in the Mesh tab (HALO2_STYLE_ROADMAP.md, H5): the named
 * bursts a cart fires with `cartbox.burst(name, x, y, z, dx, dy, dz, scale)` —
 * sparks, plasma, blasts, smoke, snow, glowing trails. Start from a preset,
 * tune it, and watch it loop in the preview (the same simulation and billboards
 * the runtime draws). See particleEffects.ts / particleSystem.ts in @cartbox/editor.
 */

import { useEffect, useRef, useState } from "react";

import {
  MAX_PARTICLE_EFFECTS,
  PARTICLE_PRESETS,
  ParticleSystem,
  particlePreset,
  projectionMatrix,
  renderMeshScene,
  viewMatrix,
  type ParticleEffect,
  type ParticlePreset,
} from "@cartbox/editor";

import { setMeshEffects, type MeshSidecar } from "@/lib/meshSidecar";
import styles from "./editor.module.css";
import { RailGroup, RailHint, RangeControl, SegmentedControl } from "./railControls";

type Rgb = readonly [number, number, number];
const toHex = (c: Rgb) => `#${c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
const fromHex = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255] : [1, 1, 1];
};

const PREVIEW_W = 220;
const PREVIEW_H = 140;

/** A looping preview of one effect: a burst (or a trail across) every second or so. */
function EffectPreview({ effect }: { effect: ParticleEffect }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    const system = new ParticleSystem([effect], 7);
    const image = ctx.createImageData(PREVIEW_W, PREVIEW_H);
    const depth = new Float32Array(PREVIEW_W * PREVIEW_H);
    const view = viewMatrix([0, 1.2, 4.2], [0, 0.6, 0]);
    const projection = projectionMatrix((50 * Math.PI) / 180, PREVIEW_W / PREVIEW_H, 0.1, 100);
    const period = Math.max(0.6, Math.min(2, effect.life * 1.6));
    let frame = 0;
    let raf = 0;
    const tick = () => {
      if (frame % Math.round(period * 60) === 0) {
        if (effect.shape === "trail") system.burst(0, [-1.4, 0.4, 0], [2.8, 0.6, 0]);
        else system.burst(0, [0, 0.3, 0], [0, 1, 0.35]);
      }
      frame += 1;
      system.step(1 / 60);
      const instance = system.instanceFor([-view[2]!, -view[6]!, -view[10]!], [view[1]!, view[5]!, view[9]!]);
      renderMeshScene(instance ? [instance] : [], {
        width: PREVIEW_W,
        height: PREVIEW_H,
        out: image.data,
        depth,
        view,
        projection,
        background: [18, 22, 32, 255],
        lightDirection: [0.4, 0.8, 0.5],
        ambient: 0.5,
      });
      ctx.putImageData(image, 0, 0);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [effect]);
  return <canvas ref={canvas} width={PREVIEW_W} height={PREVIEW_H} style={{ width: "100%", borderRadius: 6, imageRendering: "pixelated" }} aria-label={`Preview of ${effect.name}`} />;
}

export function ParticleEffectsPanel({ sidecar, onChange }: { sidecar: MeshSidecar; onChange: (next: MeshSidecar) => void }) {
  const effects = sidecar.effects ?? [];
  const [selected, setSelected] = useState(0);
  const [preset, setPreset] = useState<ParticlePreset>("sparks");
  const index = Math.min(selected, effects.length - 1);
  const effect = effects[index];
  const set = (next: readonly ParticleEffect[]) => onChange(setMeshEffects(sidecar, next));
  const patch = (change: Partial<ParticleEffect>) => set(effects.map((e, i) => (i === index ? { ...e, ...change } : e)));
  const add = () => {
    let name = preset as string;
    for (let n = 2; effects.some((e) => e.name === name); n += 1) name = `${preset}${n}`;
    set([...effects, particlePreset(preset, name)]);
    setSelected(effects.length);
  };
  const range = (label: string, key: keyof ParticleEffect, min: number, max: number, step: number, unit = "") => (
    <RangeControl
      label={label}
      nested
      min={min}
      max={max}
      step={step}
      value={effect![key] as number}
      ariaLabel={`Effect ${label.toLowerCase()}`}
      display={`${(effect![key] as number).toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0)}${unit}`}
      onChange={(v) => patch({ [key]: v } as Partial<ParticleEffect>)}
    />
  );
  return (
    <RailGroup label="Particle effects" advanced>
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
        <select value={preset} aria-label="Effect preset" onChange={(e) => setPreset(e.target.value as ParticlePreset)} style={{ flex: 1, minWidth: 0 }}>
          {PARTICLE_PRESETS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button type="button" className="cbx-btn" onClick={add} disabled={effects.length >= MAX_PARTICLE_EFFECTS}>
          Add effect
        </button>
      </div>
      {effects.length > 1 && (
        <SegmentedControl label="Effect" ariaLabel="Particle effect" wrap selected={index} onSelect={setSelected} options={effects.map((e, i) => ({ id: i, label: e.name }))} />
      )}
      {effect && (
        <>
          <EffectPreview effect={effect} />
          <div className={styles.rangeRow} style={{ margin: "6px 0" }}>
            <input
              type="text"
              value={effect.name}
              aria-label="Effect name"
              onChange={(e) => patch({ name: e.target.value.replace(/[^\w-]/g, "").slice(0, 32) || effect.name })}
              style={{ flex: 1, minWidth: 0, padding: "4px 6px", borderRadius: 6 }}
            />
            <button type="button" className={styles.toolBtn} aria-label="Remove effect" onClick={() => set(effects.filter((_, i) => i !== index))}>
              ✕
            </button>
          </div>
          <SegmentedControl
            label="Shape"
            ariaLabel="Effect shape"
            selected={effect.shape}
            onSelect={(shape) => patch({ shape })}
            options={[
              { id: "burst", label: "Burst" },
              { id: "trail", label: "Trail" },
            ]}
          />
          {range("Count", "count", 1, 128, 1)}
          {range("Life", "life", 0.05, 4, 0.05, "s")}
          {range("Speed", "speed", 0, 30, 0.5)}
          {range("Spread", "spread", 0, 1, 0.05)}
          {range("Gravity", "gravity", -10, 30, 0.5)}
          {range("Drag", "drag", 0, 10, 0.1)}
          {range("Size", "size", 0.01, 2, 0.01)}
          {range("End size", "sizeEnd", 0, 3, 0.01)}
          {range("Glow", "glow", 0, 6, 0.1)}
          {range("Streak", "stretch", 0, 3, 0.05)}
          <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "6px 0" }}>
            <input type="color" value={toHex(effect.color)} aria-label="Birth colour" onChange={(e) => patch({ color: fromHex(e.target.value) })} />
            <span className={styles.hudLabel}>→</span>
            <input type="color" value={toHex(effect.colorEnd)} aria-label="Death colour" onChange={(e) => patch({ colorEnd: fromHex(e.target.value) })} />
          </div>
        </>
      )}
      <RailHint>
        Fire one from the cart: <code>cartbox.burst(&quot;{effect?.name ?? "sparks"}&quot;, x, y, z, dx, dy, dz)</code> — a burst throws along the direction; a trail
        lays itself along it. Glow above 0 emits (and blooms); 0 is lit like smoke or snow.
      </RailHint>
    </RailGroup>
  );
}
