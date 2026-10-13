"use client";

/**
 * Splines in the Mesh tab (EDITOR_PRO_ROADMAP.md P3), after Unreal's Landscape
 * and Water splines: add a river, path or wall; place its points by clicking
 * the ground in the scene view; set each point's width and height; then
 * apply it — a river carves its bed and lays flowing water and foam, a path
 * levels and paints the ground, a wall bends an object along itself. See
 * splines.ts in @cartbox/editor and splineEdit.ts.
 */

import { useState } from "react";

import type { Spline, SplineKind, SplinePoint } from "@cartbox/editor";

import { type MeshSidecar } from "@/lib/meshSidecar";
import { SPLINE_PROP, addSpline, applySpline, findSpline, removeSpline, replaceSpline } from "@/lib/splineEdit";
import { findTerrain } from "@/lib/terrainEdit";
import styles from "./editor.module.css";
import { RailHint, RangeControl } from "./railControls";
import type { TerrainEditState } from "./TerrainPanel";

const KINDS: readonly { readonly kind: SplineKind; readonly label: string; readonly hint: string }[] = [
  { kind: "river", label: "River", hint: "Carves its bed and banks, and lays water that flows along it, with foam at its edges" },
  { kind: "path", label: "Path", hint: "Levels the ground along it and paints a layer on it" },
  { kind: "wall", label: "Wall", hint: "Bends an object along it, repeated end to end (a fence, a wall, a ledge)" },
];

const number = (v: number) => Math.round(v * 100) / 100;

export function SplinePanel({ sidecar, onChange, edit, onEdit }: { sidecar: MeshSidecar; onChange: (next: MeshSidecar) => void; edit: TerrainEditState; onEdit: (next: TerrainEditState) => void }) {
  const splines = sidecar.splines ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const spline = (selected && findSpline(sidecar, selected)) || splines[0] || null;
  const placing = spline !== null && edit.tool?.kind === "spline" && edit.tool.id === spline.id;
  const set = (patch: Partial<Spline>) => spline && onChange(replaceSpline(sidecar, { ...spline, ...patch }));
  const setPoint = (k: number, patch: Partial<SplinePoint>) => spline && set({ points: spline.points.map((p, i) => (i === k ? { ...p, ...patch } : p)) });
  const terrain = spline?.terrain ? findTerrain(sidecar, spline.terrain) : null;
  const made = spline ? sidecar.meshes.find((m) => m.props?.[SPLINE_PROP] === spline.id) : undefined;

  return (
    <>
      <div style={{ fontSize: 11, opacity: 0.7, marginTop: 10 }}>Splines</div>
      <div className={styles.toolGroup} style={{ marginTop: 4 }}>
        {KINDS.map(({ kind, label, hint }) => (
          <button
            key={kind}
            type="button"
            className={styles.toolBtn}
            title={hint}
            onClick={() => {
              const added = addSpline(sidecar, kind);
              onChange(added.sidecar);
              setSelected(added.id);
              // Start placing its points straight away.
              const ground = added.sidecar.splines!.find((s) => s.id === added.id)!.terrain ?? edit.id;
              onEdit({ ...edit, id: ground ?? edit.id, tool: { kind: "spline", id: added.id } });
            }}
          >
            + {label}
          </button>
        ))}
      </div>
      {splines.length > 1 && (
        <select aria-label="Spline to edit" value={spline?.id ?? ""} onChange={(event) => setSelected(event.target.value)} style={{ width: "100%", marginTop: 6 }}>
          {splines.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      {spline && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
          <input aria-label="Spline name" value={spline.name} onChange={(event) => set({ name: event.target.value.slice(0, 64) })} style={{ padding: "3px 6px", borderRadius: 6 }} />
          <button
            type="button"
            className={`${styles.toolBtn} ${placing ? styles.toolBtnActive : ""}`}
            aria-pressed={placing}
            title="Click the ground in the scene view to put points down; the end nearer the click grows"
            onClick={() => onEdit({ ...edit, id: spline.terrain ?? edit.id, tool: placing ? null : { kind: "spline", id: spline.id } })}
          >
            {placing ? "Placing points… (click to stop)" : "Place points"}
          </button>
          {spline.points.map((pt, k) => (
            <div key={k} style={{ display: "flex", gap: 3, alignItems: "center", fontSize: 11 }}>
              <span style={{ width: 16, opacity: 0.6 }}>{k + 1}</span>
              {(["x", "y", "z"] as const).map((axis, a) => (
                <input
                  key={axis}
                  type="number"
                  step={0.1}
                  aria-label={`Point ${k + 1} ${axis}`}
                  title={axis === "y" ? (spline.kind === "river" ? "The water's height here" : "The ground's height here") : undefined}
                  value={number(pt.p[a]!)}
                  onChange={(event) => {
                    const v = Number(event.target.value);
                    if (!Number.isFinite(v)) return;
                    const p: [number, number, number] = [pt.p[0], pt.p[1], pt.p[2]];
                    p[a] = v;
                    setPoint(k, { p });
                  }}
                  style={{ width: 52 }}
                />
              ))}
              <input
                type="number"
                step={0.1}
                min={0.1}
                aria-label={`Point ${k + 1} width`}
                title="Width here"
                value={number(pt.width)}
                onChange={(event) => {
                  const v = Number(event.target.value);
                  if (Number.isFinite(v) && v > 0) setPoint(k, { width: Math.min(200, v) });
                }}
                style={{ width: 44 }}
              />
              <button type="button" className={styles.toolBtn} aria-label={`Remove point ${k + 1}`} onClick={() => set({ points: spline.points.filter((_, i) => i !== k) })}>
                ×
              </button>
            </div>
          ))}
          {spline.kind !== "wall" && (sidecar.terrains?.length ?? 0) > 1 && (
            <select aria-label="Terrain the spline shapes" value={spline.terrain ?? ""} onChange={(event) => set({ terrain: event.target.value })}>
              {(sidecar.terrains ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
          {spline.kind === "river" && (
            <RangeControl label="Depth" nested min={0.2} max={6} step={0.1} value={spline.depth ?? 1} onChange={(depth) => set({ depth })} ariaLabel="River bed depth below the water" display={`${(spline.depth ?? 1).toFixed(1)} m`} />
          )}
          {spline.kind !== "wall" && (
            <RangeControl
              label={spline.kind === "river" ? "Banks" : "Shoulders"}
              nested
              min={0.5}
              max={20}
              step={0.25}
              value={spline.bank ?? (spline.points[0]?.width ?? 4) / 2}
              onChange={(bank) => set({ bank })}
              ariaLabel="How far the banks reach each side"
              display={`${(spline.bank ?? (spline.points[0]?.width ?? 4) / 2).toFixed(2)} m`}
            />
          )}
          {spline.kind !== "wall" && terrain && (
            <select
              aria-label={spline.kind === "river" ? "Layer painted on the banks" : "Layer painted on the path"}
              value={spline.layer ?? -1}
              onChange={(event) => {
                const layer = Number(event.target.value);
                const { layer: _old, ...rest } = spline;
                void _old;
                onChange(replaceSpline(sidecar, layer >= 0 ? { ...rest, layer } : rest));
              }}
            >
              <option value={-1}>{spline.kind === "river" ? "Banks: leave unpainted" : "Tread: leave unpainted"}</option>
              {terrain.layers.map((l, k) => (
                <option key={k} value={k}>
                  {spline.kind === "river" ? "Wet banks: " : "Tread: "}
                  {l.material.name}
                </option>
              ))}
            </select>
          )}
          {spline.kind === "wall" && (
            <select aria-label="Object bent along the wall" value={spline.mesh ?? ""} onChange={(event) => set({ mesh: event.target.value || undefined })}>
              <option value="">Pick the object to bend…</option>
              {sidecar.meshes
                .filter((m) => m.props?.[SPLINE_PROP] === undefined)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </select>
          )}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              className="cbx-btn"
              title={spline.kind === "river" ? "Carve the bed and banks, and lay the water and foam" : spline.kind === "path" ? "Level and paint the ground along it" : "Bend the object along it"}
              onClick={() => {
                const result = applySpline(sidecar, spline.id);
                if ("problem" in result) setProblem(result.problem);
                else {
                  setProblem(null);
                  onChange(result.sidecar);
                }
              }}
            >
              {made ? "Apply again" : "Apply"}
            </button>
            <button
              type="button"
              className="cbx-btn"
              title="Remove the spline and the object it made (the ground it shaped stays)"
              onClick={() => {
                onChange(removeSpline(sidecar, spline.id));
                if (placing) onEdit({ ...edit, tool: null });
                setSelected(null);
              }}
            >
              Delete spline
            </button>
          </div>
          {problem && <RailHint>{problem}</RailHint>}
        </div>
      )}
    </>
  );
}
