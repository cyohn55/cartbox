"use client";

/**
 * Decals in the Mesh tab (HALO2_STYLE_ROADMAP.md, H6): marks laid flat on
 * surfaces. The cart lays fading ones with `cartbox.decal(name, x, y, z, nx,
 * ny, nz, scale)` — bullet pocks, plasma scorch, grenade burns — and the scene
 * can carry permanent ones placed here: glyphs, frost streaks. The preview
 * shows the decal on a wall, drawn by the runtime's own decal system. See
 * decals.ts / decalSystem.ts in @cartbox/editor.
 */

import { useEffect, useRef, useState } from "react";

import {
  DECAL_PRESETS,
  DecalSystem,
  MAX_DECAL_DEFS,
  MAX_DECAL_MARKS,
  composeModelMatrix,
  decalPreset,
  projectionMatrix,
  renderMeshScene,
  viewMatrix,
  type DecalDef,
  type DecalMark,
  type DecalPreset,
} from "@cartbox/editor";

import { setMeshDecals, type MeshSidecar } from "@/lib/meshSidecar";
import styles from "./editor.module.css";
import { RailGroup, RailHint, RangeControl, SegmentedControl } from "./railControls";

type Rgb = readonly [number, number, number];
const toHex = (c: Rgb) => `#${c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
const fromHex = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255] : [1, 1, 1];
};

const W = 220;
const H = 120;

/** The decal on a grey wall: a fresh mark, a few scattered ones, and one fading. */
function DecalPreview({ def }: { def: DecalDef }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    const image = ctx.createImageData(W, H);
    const wall = {
      name: "wall",
      primitives: [
        {
          positions: Float32Array.from([-3, -2, 0, 3, -2, 0, 3, 2, 0, -3, 2, 0]),
          normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
          uvs: null,
          indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
          material: { name: "wall", baseColorFactor: [0.55, 0.58, 0.62, 1] as [number, number, number, number], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 },
        },
      ],
    };
    const sys = new DecalSystem([def]);
    const unit = def.size;
    const fit = Math.min(1, 1.4 / unit);
    sys.lay(0, [0, 0, 0], [0, 0, 1], fit);
    if (unit < 1) for (const [x, y] of [[-1.6, 0.6], [1.5, -0.5], [-0.9, -0.8], [1.2, 0.8]] as const) sys.lay(0, [x, y, 0], [0, 0, 1], fit * 0.8);
    const marks = sys.sceneInstance();
    const model = composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);
    renderMeshScene([{ mesh: wall, model }, ...(marks ? [marks] : [])], {
      width: W,
      height: H,
      out: image.data,
      depth: new Float32Array(W * H),
      view: viewMatrix([0, 0, 3.4], [0, 0, 0]),
      projection: projectionMatrix((50 * Math.PI) / 180, W / H, 0.1, 50),
      background: [18, 22, 32, 255],
      lightDirection: [0.3, 0.5, 1],
      ambient: 0.45,
    });
    ctx.putImageData(image, 0, 0);
  }, [def]);
  return <canvas ref={canvas} width={W} height={H} style={{ width: "100%", borderRadius: 6, imageRendering: "pixelated" }} aria-label={`Preview of ${def.name}`} />;
}

function Vec({ label, value, onChange }: { label: string; value: readonly [number, number, number]; onChange: (v: [number, number, number]) => void }) {
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 4 }}>
      <span className={styles.hudLabel} style={{ minWidth: 48 }}>
        {label}
      </span>
      {[0, 1, 2].map((a) => (
        <input
          key={a}
          type="number"
          step={0.1}
          value={value[a]}
          aria-label={`${label} ${"XYZ"[a]}`}
          onChange={(e) => {
            const next = [...value] as [number, number, number];
            const n = Number(e.target.value);
            next[a] = Number.isFinite(n) ? n : 0;
            onChange(next);
          }}
          style={{ width: "100%", minWidth: 0, padding: "3px 5px", borderRadius: 6 }}
        />
      ))}
    </div>
  );
}

export function DecalsPanel({ sidecar, onChange }: { sidecar: MeshSidecar; onChange: (next: MeshSidecar) => void }) {
  const defs = sidecar.decals ?? [];
  const marks = sidecar.decalMarks ?? [];
  const [selected, setSelected] = useState(0);
  const [preset, setPreset] = useState<DecalPreset>("pock");
  const index = Math.min(selected, defs.length - 1);
  const def = defs[index];
  const save = (nextDefs: readonly DecalDef[], nextMarks: readonly DecalMark[] = marks) => onChange(setMeshDecals(sidecar, nextDefs, nextMarks));
  const patch = (change: Partial<DecalDef>) => {
    const renamed = change.name !== undefined && def && change.name !== def.name;
    save(
      defs.map((d, i) => (i === index ? { ...d, ...change } : d)),
      renamed ? marks.map((m) => (m.decal === def!.name ? { ...m, decal: change.name! } : m)) : marks,
    );
  };
  const add = () => {
    let name = preset as string;
    for (let n = 2; defs.some((d) => d.name === name); n += 1) name = `${preset}${n}`;
    save([...defs, decalPreset(preset, name)]);
    setSelected(defs.length);
  };
  const ownMarks = def ? marks.map((m, i) => ({ m, i })).filter(({ m }) => m.decal === def.name) : [];
  const patchMark = (i: number, change: Partial<DecalMark>) => save(defs, marks.map((m, k) => (k === i ? { ...m, ...change } : m)));
  return (
    <RailGroup label="Decals" advanced>
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
        <select value={preset} aria-label="Decal preset" onChange={(e) => setPreset(e.target.value as DecalPreset)} style={{ flex: 1, minWidth: 0 }}>
          {DECAL_PRESETS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button type="button" className="cbx-btn" onClick={add} disabled={defs.length >= MAX_DECAL_DEFS}>
          Add decal
        </button>
      </div>
      {defs.length > 1 && <SegmentedControl label="Decal" ariaLabel="Decal" wrap selected={index} onSelect={setSelected} options={defs.map((d, i) => ({ id: i, label: d.name }))} />}
      {def && (
        <>
          <DecalPreview def={def} />
          <div className={styles.rangeRow} style={{ margin: "6px 0" }}>
            <input
              type="text"
              value={def.name}
              aria-label="Decal name"
              onChange={(e) => patch({ name: e.target.value.replace(/[^\w-]/g, "").slice(0, 32) || def.name })}
              style={{ flex: 1, minWidth: 0, padding: "4px 6px", borderRadius: 6 }}
            />
            <input type="color" value={toHex(def.color)} aria-label="Decal colour" onChange={(e) => patch({ color: fromHex(e.target.value) })} />
            <button type="button" className={styles.toolBtn} aria-label="Remove decal" onClick={() => save(defs.filter((_, i) => i !== index))}>
              ✕
            </button>
          </div>
          <RangeControl label="Size" nested min={0.05} max={4} step={0.05} value={def.size} ariaLabel="Decal size" display={def.size.toFixed(2)} onChange={(size) => patch({ size })} />
          <RangeControl
            label="Lasts"
            nested
            min={0}
            max={120}
            step={1}
            value={def.life}
            ariaLabel="Decal life"
            display={def.life > 0 ? `${def.life}s` : "until recycled"}
            onChange={(life) => patch({ life })}
          />
          <RangeControl label="Glow" nested min={0} max={4} step={0.1} value={def.glow} ariaLabel="Decal glow" display={def.glow.toFixed(1)} onChange={(glow) => patch({ glow })} />
          <div className={`${styles.groupLabel} ${styles.railSubLabel}`}>Placed marks</div>
          {ownMarks.map(({ m, i }) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <Vec label="At" value={m.position} onChange={(position) => patchMark(i, { position })} />
              <Vec label="Facing" value={m.normal} onChange={(normal) => patchMark(i, { normal })} />
              <div className={styles.rangeRow}>
                <RangeControl label="Turn" nested min={0} max={359} step={1} value={m.spin} ariaLabel="Mark turn" display={`${m.spin}°`} onChange={(spin) => patchMark(i, { spin })} />
                <button type="button" className={styles.toolBtn} aria-label="Remove mark" onClick={() => save(defs, marks.filter((_, k) => k !== i))}>
                  ✕
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="cbx-btn"
            disabled={marks.length >= MAX_DECAL_MARKS}
            onClick={() => save(defs, [...marks, { decal: def.name, position: [0, 1, 0], normal: [0, 0, 1], size: 0, spin: 0 }])}
          >
            Place a mark
          </button>
        </>
      )}
      <RailHint>
        Lay one from the cart: <code>cartbox.decal(&quot;{def?.name ?? "pock"}&quot;, x, y, z, nx, ny, nz)</code> — on the surface at (x, y, z) facing (nx, ny, nz). Marks the cart
        lays fade after their time; placed marks stay.
      </RailHint>
    </RailGroup>
  );
}
