"use client";

/**
 * Terrain tools in the Mesh tab (ENGINE_PARITY_ROADMAP.md EP10): add a
 * terrain, pick a brush — raise, lower, smooth, flatten, noise, paint a layer,
 * cut or fill holes — and drag over the ground in the scene view, as Unity's
 * Terrain tools and Unreal's Landscape mode work. See terrainBrush.ts in
 * @cartbox/editor and terrainEdit.ts.
 */

import { useState } from "react";

import { type MeshSidecar } from "@/lib/meshSidecar";
import { addTerrain, findTerrain, removeTerrain, replaceTerrain, type TerrainBrushSettings, type TerrainTool } from "@/lib/terrainEdit";
import styles from "./editor.module.css";
import { RailGroup, RailHint, RangeControl } from "./railControls";

/** What the Terrain panel has up: which terrain, which tool (null = select objects as usual), and the brush. */
export interface TerrainEditState extends TerrainBrushSettings {
  readonly id: string | null;
  readonly tool: TerrainTool | null;
}

export const INITIAL_TERRAIN_EDIT: TerrainEditState = { id: null, tool: null, radius: 4, strength: 0.5 };

const SCULPT: readonly { readonly op: "raise" | "lower" | "smooth" | "flatten" | "noise"; readonly label: string; readonly glyph: string; readonly hint: string }[] = [
  { op: "raise", label: "Raise", glyph: "▲", hint: "Lift the ground under the brush" },
  { op: "lower", label: "Lower", glyph: "▼", hint: "Sink the ground under the brush" },
  { op: "smooth", label: "Smooth", glyph: "≈", hint: "Even out bumps and ridges" },
  { op: "flatten", label: "Flatten", glyph: "▬", hint: "Level the ground to the height where the stroke starts" },
  { op: "noise", label: "Noise", glyph: "⁂", hint: "Roughen the ground with bumps" },
];

const same = (a: TerrainTool | null, b: TerrainTool): boolean => JSON.stringify(a) === JSON.stringify(b);

const hex = (c: readonly number[]) => `#${c.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
const rgb = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

export function TerrainPanel({
  sidecar,
  onChange,
  edit,
  onEdit,
}: {
  sidecar: MeshSidecar;
  onChange: (next: MeshSidecar) => void;
  edit: TerrainEditState;
  onEdit: (next: TerrainEditState) => void;
}) {
  const [size, setSize] = useState(64);
  const [samples, setSamples] = useState(65);
  const stored = sidecar.terrains ?? [];
  const id = edit.id && stored.some((t) => t.id === edit.id) ? edit.id : (stored[0]?.id ?? null);
  const terrain = id ? findTerrain(sidecar, id) : null;
  const pick = (tool: TerrainTool) => onEdit({ ...edit, id, tool: same(edit.tool, tool) ? null : tool });
  const toolButton = (tool: TerrainTool, label: string, glyph: string, hint: string) => (
    <button
      key={label}
      type="button"
      className={`${styles.toolBtn} ${same(edit.tool, tool) ? styles.toolBtnActive : ""}`}
      aria-pressed={same(edit.tool, tool)}
      onClick={() => pick(tool)}
      title={hint}
    >
      <span className={styles.toolGlyph} aria-hidden>
        {glyph}
      </span>
      {label}
    </button>
  );

  const add = () => {
    const made = addTerrain(sidecar, { size, samples });
    onChange(made.sidecar);
    onEdit({ ...edit, id: made.id, tool: { kind: "sculpt", op: "raise" } });
  };

  return (
    <RailGroup label="Terrain">
      {stored.length > 1 && (
        <select aria-label="Terrain to edit" value={id ?? ""} onChange={(event) => onEdit({ ...edit, id: event.target.value })} style={{ width: "100%", marginBottom: 6 }}>
          {stored.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      {terrain ? (
        <>
          <div className={styles.toolGroup}>{SCULPT.map((s) => toolButton({ kind: "sculpt", op: s.op }, s.label, s.glyph, s.hint))}</div>
          <div className={styles.toolGroup} style={{ marginTop: 6 }}>
            {toolButton({ kind: "hole", fill: false }, "Cut hole", "◌", "Cut the ground away (a cave mouth, a pit)")}
            {toolButton({ kind: "hole", fill: true }, "Fill hole", "●", "Put cut ground back")}
          </div>
          <RangeControl label="Brush size" nested min={0.5} max={Math.max(2, Math.min(terrain.size[0], terrain.size[1]) / 3)} step={0.25} value={edit.radius} onChange={(radius) => onEdit({ ...edit, id, radius })} ariaLabel="Brush radius" display={`${edit.radius.toFixed(2)} m`} />
          <RangeControl label="Strength" nested min={0.05} max={1} step={0.05} value={edit.strength} onChange={(strength) => onEdit({ ...edit, id, strength })} ariaLabel="Brush strength" display={`${Math.round(edit.strength * 100)}%`} />

          <div style={{ fontSize: 11, opacity: 0.7, marginTop: 8 }}>Layers — pick one to paint it</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
            {terrain.layers.map((layer, k) => {
              const tool: TerrainTool = { kind: "paint", layer: k };
              const active = same(edit.tool, tool);
              return (
                <div key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="color"
                    aria-label={`${layer.material.name} colour`}
                    value={hex(layer.material.baseColorFactor)}
                    onChange={(event) => {
                      const [r, g, b] = rgb(event.target.value);
                      const layers = terrain.layers.map((l, i) => (i === k ? { ...l, material: { ...l.material, baseColorFactor: [r, g, b, l.material.baseColorFactor[3]] as [number, number, number, number] } } : l));
                      onChange(replaceTerrain(sidecar, { ...terrain, layers }));
                    }}
                    style={{ width: 28, height: 22, padding: 0, border: "none", background: "none" }}
                  />
                  <button type="button" className={`${styles.toolBtn} ${active ? styles.toolBtnActive : ""}`} aria-pressed={active} onClick={() => pick(tool)} style={{ flex: 1 }} title={`Paint ${layer.material.name}`}>
                    {layer.material.name}
                    {layer.paintOnly ? " (painted only)" : ""}
                  </button>
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            {terrain.paint && (
              <button type="button" className="cbx-btn" onClick={() => onChange(replaceTerrain(sidecar, { ...terrain, paint: undefined }))} title="Forget the painting: the layers follow their slope and height rules again">
                Clear paint
              </button>
            )}
            {terrain.holes && (
              <button type="button" className="cbx-btn" onClick={() => onChange(replaceTerrain(sidecar, { ...terrain, holes: undefined }))}>
                Fill all holes
              </button>
            )}
            <button
              type="button"
              className="cbx-btn"
              onClick={() => {
                onChange(removeTerrain(sidecar, terrain.id));
                onEdit({ ...edit, id: null, tool: null });
              }}
            >
              Delete terrain
            </button>
          </div>
          <RailHint>
            {edit.tool
              ? "Drag over the ground in the scene view to brush it. Alt-drag still orbits; click the tool again to go back to selecting."
              : "Pick a tool, then drag over the ground in the scene view."}
          </RailHint>
        </>
      ) : null}
      <details style={{ marginTop: 6 }} open={stored.length === 0}>
        <summary style={{ cursor: "pointer", fontSize: 12 }}>{stored.length === 0 ? "New terrain" : "Add another terrain"}</summary>
        <RangeControl label="Size" nested min={16} max={512} step={16} value={size} onChange={setSize} ariaLabel="New terrain size" display={`${size} m`} />
        <RangeControl label="Detail" nested min={17} max={257} step={16} value={samples} onChange={setSamples} ariaLabel="New terrain heights per side" display={`${samples} × ${samples}`} />
        <button type="button" className="cbx-btn" onClick={add} style={{ marginTop: 6 }}>
          Add terrain
        </button>
        <RailHint>A flat landscape to sculpt: rock shows on steep faces and snow up high on its own, and you can paint any layer anywhere.</RailHint>
      </details>
    </RailGroup>
  );
}
