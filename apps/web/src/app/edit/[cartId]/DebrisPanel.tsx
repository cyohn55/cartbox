"use client";

/**
 * Debris in the Mesh tab (HALO2_STYLE_ROADMAP.md, H10): props the cart throws
 * with `cartbox.debris(name, x, y, z, vx, vy, vz, scale)` — spent casings, a
 * dropped weapon — that bounce, tumble and settle, then fade. Each copies the
 * look of a scene object or a prefab (optionally leaving some parts off, like a
 * first-person weapon's hands). The preview throws a few onto a floor with the
 * runtime's own simulation. See debris.ts / debrisSystem.ts in @cartbox/editor.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import {
  DebrisSystem,
  MAX_DEBRIS_DEFS,
  MAX_DEBRIS_PER_DEF,
  debrisDefaults,
  deserializeMeshAsset,
  meshBounds,
  projectionMatrix,
  renderMeshScene,
  viewMatrix,
  type DebrisDef,
  type MeshAsset,
} from "@cartbox/editor";

import { readMeshEntry, setMeshDebris, type MeshSidecar } from "@/lib/meshSidecar";
import styles from "./editor.module.css";
import { RailGroup, RailHint, RangeControl, SegmentedControl } from "./railControls";

const W = 220;
const H = 130;

/** The mesh a definition wears: a scene object's by that name, else a prefab root's; minus its left-off parts. */
function sourceMesh(sidecar: MeshSidecar, def: DebrisDef): MeshAsset | null {
  let mesh: MeshAsset | null = null;
  try {
    const entry = sidecar.meshes.find((m) => m.name === def.source);
    if (entry) mesh = readMeshEntry(entry);
    else {
      const prefab = (sidecar.prefabs ?? []).find((p) => p.name === def.source);
      const root = prefab?.nodes.find((n) => !n.parent);
      if (root) mesh = deserializeMeshAsset(root.mesh);
    }
  } catch {
    return null;
  }
  if (!mesh) return null;
  const leave = new Set(def.without ?? []);
  const kept = mesh.primitives.filter((p) => !leave.has(p.material.name));
  return kept.length > 0 ? { ...mesh, primitives: kept } : null;
}

/** A few copies thrown onto a floor and left to settle, drawn by the software rasteriser. */
function DebrisPreview({ def, mesh, run }: { def: DebrisDef; mesh: MeshAsset; run: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    const b = meshBounds(mesh);
    if (!ctx || !b) return;
    const size = Math.max(1e-3, b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    // Framed to the prop's size: a casing's floor is centimetres across, a rifle's a metre.
    const k = size * 4;
    const floor = [{ center: [0, -0.5 * k, 0] as const, half: [k * 20, 0.5 * k, k * 20] as const }];
    const sys = new DebrisSystem([{ ...def, life: 60 }], [mesh]);
    const copies = Math.min(5, def.max);
    for (let i = 0; i < copies; i += 1) {
      const a = (i / copies) * Math.PI * 2;
      sys.throw(0, [Math.cos(a) * k * 0.15, k * 0.5 + i * size * 0.6, Math.sin(a) * k * 0.15], [Math.cos(a) * size * 3, 0, Math.sin(a) * size * 3], 1);
    }
    const view = viewMatrix([k * 0.9, k * 0.75, k * 1.1], [0, 0, 0]);
    const projection = projectionMatrix((45 * Math.PI) / 180, W / H, k * 0.01, k * 50);
    const floorMesh: MeshAsset = {
      name: "floor",
      primitives: [
        {
          positions: Float32Array.from([-k, 0, -k, k, 0, -k, k, 0, k, -k, 0, k]),
          normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
          uvs: null,
          indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
          material: { name: "floor", baseColorFactor: [0.45, 0.48, 0.52, 1], baseColorImage: null },
        },
      ],
    };
    const identity = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const image = ctx.createImageData(W, H);
    const depth = new Float32Array(W * H);
    let raf = 0;
    let frame = 0;
    const draw = () => {
      sys.step(1 / 60, floor);
      renderMeshScene([{ mesh: floorMesh, model: identity }, ...sys.instances()], {
        width: W,
        height: H,
        out: image.data,
        depth,
        view,
        projection,
        background: [18, 22, 32, 255],
        lightDirection: [0.3, 0.8, 0.5],
        ambient: 0.4,
      });
      ctx.putImageData(image, 0, 0);
      frame += 1;
      if (frame < 150) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [def, mesh, run]);
  return <canvas ref={canvas} width={W} height={H} style={{ width: "100%", borderRadius: 6 }} aria-label={`Preview of ${def.name}`} />;
}

export function DebrisPanel({ sidecar, onChange }: { sidecar: MeshSidecar; onChange: (next: MeshSidecar) => void }) {
  const defs = sidecar.debris ?? [];
  const [selected, setSelected] = useState(0);
  const [run, setRun] = useState(0);
  const index = Math.min(selected, defs.length - 1);
  const def = defs[index];
  const sources = useMemo(
    () => [...new Set([...(sidecar.prefabs ?? []).map((p) => p.name), ...sidecar.meshes.map((m) => m.name)])],
    [sidecar.prefabs, sidecar.meshes],
  );
  const mesh = useMemo(() => (def ? sourceMesh(sidecar, def) : null), [sidecar, def]);
  const save = (next: readonly DebrisDef[]) => onChange(setMeshDebris(sidecar, next));
  const patch = (change: Partial<DebrisDef>) => save(defs.map((d, i) => (i === index ? { ...d, ...change } : d)));
  const add = () => {
    const source = sources[0] ?? "";
    if (!source) return;
    let name = "debris";
    for (let n = 2; defs.some((d) => d.name === name); n += 1) name = `debris${n}`;
    save([...defs, debrisDefaults(name, source)]);
    setSelected(defs.length);
  };
  return (
    <RailGroup label="Debris" advanced>
      <button type="button" className="cbx-btn" onClick={add} disabled={defs.length >= MAX_DEBRIS_DEFS || sources.length === 0}>
        Add debris
      </button>
      {defs.length > 1 && <SegmentedControl label="Debris" ariaLabel="Debris" wrap selected={index} onSelect={setSelected} options={defs.map((d, i) => ({ id: i, label: d.name }))} />}
      {def && (
        <>
          {mesh ? (
            <>
              <DebrisPreview def={def} mesh={mesh} run={run} />
              <button type="button" className={styles.toolBtn} onClick={() => setRun((r) => r + 1)}>
                ↻ Throw again
              </button>
            </>
          ) : (
            <RailHint>No object or prefab named “{def.source}” (or every part of it is left off).</RailHint>
          )}
          <div className={styles.rangeRow} style={{ margin: "6px 0" }}>
            <input
              type="text"
              value={def.name}
              aria-label="Debris name"
              onChange={(e) => patch({ name: e.target.value.replace(/[^\w-]/g, "").slice(0, 32) || def.name })}
              style={{ flex: 1, minWidth: 0, padding: "4px 6px", borderRadius: 6 }}
            />
            <button type="button" className={styles.toolBtn} aria-label="Remove debris" onClick={() => save(defs.filter((_, i) => i !== index))}>
              ✕
            </button>
          </div>
          <label className={styles.hudLabel} style={{ display: "grid", gap: 4, marginBottom: 6 }}>
            Looks like
            <select value={def.source} aria-label="Debris source" onChange={(e) => patch({ source: e.target.value })}>
              {[...new Set([def.source, ...sources])].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.hudLabel} style={{ display: "grid", gap: 4, marginBottom: 6 }}>
            Leave off parts (material names)
            <input
              type="text"
              value={(def.without ?? []).join(", ")}
              aria-label="Debris parts left off"
              placeholder="e.g. glove, sleeve"
              onChange={(e) => {
                const without = e.target.value.split(",").map((w) => w.trim()).filter(Boolean);
                patch({ without: without.length > 0 ? without : undefined });
              }}
              style={{ padding: "4px 6px", borderRadius: 6 }}
            />
          </label>
          <RangeControl label="Lasts" nested min={0.5} max={60} step={0.5} value={def.life} ariaLabel="Debris life" display={`${def.life}s`} onChange={(life) => patch({ life })} />
          <RangeControl label="Bounce" nested min={0} max={1} step={0.05} value={def.bounce} ariaLabel="Debris bounce" display={def.bounce.toFixed(2)} onChange={(bounce) => patch({ bounce })} />
          <RangeControl label="Friction" nested min={0} max={1} step={0.05} value={def.friction} ariaLabel="Debris friction" display={def.friction.toFixed(2)} onChange={(friction) => patch({ friction })} />
          <RangeControl label="At once" nested min={1} max={MAX_DEBRIS_PER_DEF} step={1} value={def.max} ariaLabel="Debris at once" display={String(def.max)} onChange={(max) => patch({ max })} />
        </>
      )}
      <RailHint>
        Throw one from the cart: <code>cartbox.debris(&quot;{def?.name ?? "debris"}&quot;, x, y, z, vx, vy, vz)</code>. It lands on static bodies and the
        ragdoll colliders, and is simulated on each player&apos;s machine only, so it never affects online play. A prefab makes a good source: its mesh
        never sits in the level.
      </RailHint>
    </RailGroup>
  );
}
