"use client";

/**
 * Modelling in the Mesh tab (LOCKOUT_MULTIPLAYER_ROADMAP.md L15): pick what
 * to select (vertices, edges or faces) and the gizmo's tool, then edit the
 * selection — by the gizmo in the preview, by numbers here, or with merge,
 * delete, loop cut, subdivide, mirror and add primitive (see meshModel.ts in
 * @cartbox/editor). Skinned meshes keep their weights through every edit, so
 * a reshaped Spartan still animates.
 */

import { useState } from "react";

import {
  SHAPE_KINDS,
  addShape,
  convertSelection,
  deleteSelection,
  emptySelection,
  loopCut,
  meshClosure,
  mergeSelection,
  mirrorSelection,
  selectAll,
  selectByJoint,
  selectLinked,
  selectionPivot,
  selectionSize,
  subdivideSelection,
  transformSelection,
  type MeshAsset,
  type MeshSelection,
  type SelectMode,
  type SelectionTransform,
  type ShapeKind,
} from "@cartbox/editor";

import styles from "./editor.module.css";
import type { GizmoTool } from "./meshOverlay";
import { RailGroup, RailHint, SegmentedControl } from "./railControls";

const field: React.CSSProperties = { width: "100%", minWidth: 0, padding: "4px 6px", borderRadius: 6 };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, marginBottom: 6 };

function Triple({ label, value, step, onChange }: { label: string; value: readonly number[]; step: number; onChange: (v: [number, number, number]) => void }) {
  return (
    <div style={row}>
      <span className={styles.hudLabel} style={{ width: 44, flex: "none" }}>
        {label}
      </span>
      {[0, 1, 2].map((k) => (
        <input
          key={k}
          type="number"
          step={step}
          value={value[k]}
          aria-label={`${label} ${"XYZ"[k]}`}
          onChange={(e) => {
            const next = [...value] as [number, number, number];
            next[k] = Number(e.target.value) || 0;
            onChange(next);
          }}
          style={field}
        />
      ))}
    </div>
  );
}

export interface ModelingPanelProps {
  mesh: MeshAsset;
  mode: SelectMode;
  onMode: (mode: SelectMode) => void;
  selection: MeshSelection;
  onSelection: (selection: MeshSelection) => void;
  tool: GizmoTool;
  onTool: (tool: GizmoTool) => void;
  /** An edited mesh; `keep` when its topology is unchanged, so the selection still applies. */
  onEdit: (next: MeshAsset, keep: boolean) => void;
}

export function ModelingPanel({ mesh, mode, onMode, selection, onSelection, tool, onTool, onEdit }: ModelingPanelProps) {
  const [move, setMove] = useState<[number, number, number]>([0, 0.05, 0]);
  const [turn, setTurn] = useState<{ axis: 0 | 1 | 2; degrees: number }>({ axis: 1, degrees: 15 });
  const [grow, setGrow] = useState<[number, number, number]>([1.1, 1.1, 1.1]);
  const [cutAt, setCutAt] = useState(0.5);
  const [mirror, setMirror] = useState<{ axis: 0 | 1 | 2; copy: boolean }>({ axis: 0, copy: true });
  const [shape, setShape] = useState<{ kind: ShapeKind; size: number; segments: number; primitive: number; joint: number }>({ kind: "cube", size: 0.1, segments: 12, primitive: 0, joint: -1 });
  const [note, setNote] = useState<string | null>(null);
  const joints = mesh.skin?.joints ?? [];
  const count = selectionSize(selection);
  const pivot = selectionPivot(mesh, selection);

  /** Run an edit, then report whether every primitive it touched is still closed. */
  const run = (label: string, next: MeshAsset, keep: boolean) => {
    if (next === mesh) {
      setNote(`${label}: nothing to do with this selection.`);
      return;
    }
    const open = next.primitives.reduce((n, p, i) => (p === mesh.primitives[i] ? n : n + meshClosure(p).openEdges), 0);
    setNote(`${label} done.${open > 0 ? ` ${open} open edge${open === 1 ? "" : "s"} left (the mesh had holes).` : ""}`);
    onEdit(next, keep);
  };
  const transform = (t: SelectionTransform) => run(t.kind === "move" ? "Move" : t.kind === "rotate" ? "Rotate" : "Scale", transformSelection(mesh, selection, t), true);
  const firstEdge = (): { primitive: number; edge: number } | null => {
    const edges = convertSelection(mesh, selection, "edge");
    for (const [primitive, ids] of edges.parts.entries()) if (ids[0] !== undefined) return { primitive, edge: ids[0] };
    return null;
  };

  return (
    <RailGroup label="Model">
      <SegmentedControl
        ariaLabel="Select"
        selected={mode}
        onSelect={(m) => {
          onSelection(convertSelection(mesh, selection, m));
          onMode(m);
        }}
        options={[
          { id: "vertex", label: "Vertex", hint: "Select vertices (1)" },
          { id: "edge", label: "Edge", hint: "Select edges (2)" },
          { id: "face", label: "Face", hint: "Select faces (3)" },
        ]}
      />
      <div style={{ height: 6 }} />
      <SegmentedControl
        ariaLabel="Gizmo"
        selected={tool}
        onSelect={onTool}
        options={[
          { id: "move", label: "Move", hint: "Drag an axis handle to move along it (G)" },
          { id: "rotate", label: "Rotate", hint: "Drag an axis handle to turn about it (R)" },
          { id: "scale", label: "Scale", hint: "Drag an axis handle to stretch along it (S)" },
        ]}
      />
      <RailHint>
        Click to select, Shift+click to add or remove, Alt+click a side for its loop (in face mode, the ring of faces it crosses); drag a box to
        select through the mesh (Shift adds, Ctrl removes). Right-drag orbits. Drag the gizmo&apos;s handles to {tool} the selection.
      </RailHint>
      <div className={styles.hudLabel} style={{ margin: "4px 0" }}>
        {count === 0 ? "Nothing selected" : `${count} ${mode === "vertex" ? "vertices" : mode === "edge" ? "edges" : "faces"} selected`}
        {pivot ? ` · centre (${pivot.map((v) => v.toFixed(2)).join(", ")})` : ""}
      </div>
      <div className={styles.toolGroup}>
        <button type="button" className={styles.toolBtn} onClick={() => onSelection(selectAll(mesh, mode))}>
          All
        </button>
        <button type="button" className={styles.toolBtn} onClick={() => onSelection(emptySelection(mode))}>
          None
        </button>
        <button type="button" className={styles.toolBtn} title="Grow to the whole pieces the selection touches" onClick={() => onSelection(selectLinked(mesh, selection))}>
          Linked
        </button>
      </div>
      {joints.length > 0 && (
        <select
          aria-label="Select by bone"
          value=""
          onChange={(e) => e.target.value !== "" && onSelection(selectByJoint(mesh, Number(e.target.value), mode))}
          style={{ ...field, marginTop: 6 }}
        >
          <option value="">Select what a bone carries…</option>
          {joints.map((j, k) => (
            <option key={j.name} value={k}>
              {j.name}
            </option>
          ))}
        </select>
      )}

      {count > 0 && (
        <>
          <div className={`${styles.groupLabel} ${styles.railSubLabel}`}>Transform</div>
          <Triple label="Move" value={move} step={0.01} onChange={setMove} />
          <button type="button" className={styles.toolBtn} onClick={() => transform({ kind: "move", offset: move })}>
            Move by
          </button>
          <div style={{ ...row, marginTop: 6 }}>
            <select aria-label="Rotate about" value={turn.axis} onChange={(e) => setTurn({ ...turn, axis: Number(e.target.value) as 0 | 1 | 2 })} style={field}>
              <option value={0}>about X</option>
              <option value={1}>about Y</option>
              <option value={2}>about Z</option>
            </select>
            <input type="number" step={5} value={turn.degrees} aria-label="Degrees" onChange={(e) => setTurn({ ...turn, degrees: Number(e.target.value) || 0 })} style={field} />
            <button type="button" className={styles.toolBtn} onClick={() => transform({ kind: "rotate", axis: turn.axis, angle: (turn.degrees * Math.PI) / 180 })}>
              Rotate
            </button>
          </div>
          <Triple label="Scale" value={grow} step={0.05} onChange={setGrow} />
          <button type="button" className={styles.toolBtn} onClick={() => transform({ kind: "scale", factor: grow })}>
            Scale by
          </button>

          <div className={`${styles.groupLabel} ${styles.railSubLabel}`}>Edit</div>
          <div className={styles.toolGroup}>
            <button type="button" className={styles.toolBtn} title="Merge the selected vertices at their centre" onClick={() => run("Merge", mergeSelection(mesh, selection), false)}>
              Merge
            </button>
            <button type="button" className={styles.toolBtn} title="Delete the selection and fill the hole it leaves" onClick={() => run("Delete", deleteSelection(mesh, selection), false)}>
              Delete
            </button>
            <button type="button" className={styles.toolBtn} title="Split the selected faces into quads round their centres" onClick={() => run("Subdivide", subdivideSelection(mesh, selection), false)}>
              Subdivide
            </button>
          </div>
          <div style={{ ...row, marginTop: 6 }}>
            <input type="number" min={0.05} max={0.95} step={0.05} value={cutAt} aria-label="Loop cut position" onChange={(e) => setCutAt(Number(e.target.value) || 0.5)} style={field} />
            <button
              type="button"
              className={styles.toolBtn}
              title="Cut a new loop across the ring of quads the first selected side runs across"
              onClick={() => {
                const e = firstEdge();
                if (e) run("Loop cut", loopCut(mesh, e.primitive, e.edge, cutAt), false);
              }}
            >
              Loop cut
            </button>
          </div>
          <div style={row}>
            <select aria-label="Mirror across" value={mirror.axis} onChange={(e) => setMirror({ ...mirror, axis: Number(e.target.value) as 0 | 1 | 2 })} style={field}>
              <option value={0}>across X = 0</option>
              <option value={1}>across Y = 0</option>
              <option value={2}>across Z = 0</option>
            </select>
            <label style={{ fontSize: 12, display: "flex", gap: 3, alignItems: "center" }}>
              <input type="checkbox" checked={mirror.copy} onChange={(e) => setMirror({ ...mirror, copy: e.target.checked })} />
              copy
            </label>
            <button type="button" className={styles.toolBtn} onClick={() => run("Mirror", mirrorSelection(mesh, selection, mirror.axis, { duplicate: mirror.copy }), false)}>
              Mirror
            </button>
          </div>
          <RailHint>Mirror works on the whole pieces the selection touches; a piece on a left bone moves to the right one.</RailHint>
        </>
      )}

      <div className={`${styles.groupLabel} ${styles.railSubLabel}`}>Add primitive</div>
      <div style={row}>
        <select aria-label="Shape" value={shape.kind} onChange={(e) => setShape({ ...shape, kind: e.target.value as ShapeKind })} style={field}>
          {SHAPE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input type="number" step={0.01} min={0.001} value={shape.size} aria-label="Shape size" onChange={(e) => setShape({ ...shape, size: Math.max(0.001, Number(e.target.value) || 0.1) })} style={field} />
        {shape.kind !== "cube" && (
          <input type="number" step={1} min={3} max={64} value={shape.segments} aria-label="Shape sides" onChange={(e) => setShape({ ...shape, segments: Number(e.target.value) || 12 })} style={field} />
        )}
      </div>
      <div style={row}>
        <select aria-label="Add to part" value={Math.min(shape.primitive, mesh.primitives.length - 1)} onChange={(e) => setShape({ ...shape, primitive: Number(e.target.value) })} style={field}>
          {mesh.primitives.map((p, i) => (
            <option key={i} value={i}>
              {p.material.name || `part ${i + 1}`}
            </option>
          ))}
        </select>
        {joints.length > 0 && (
          <select aria-label="Bind to bone" value={shape.joint} onChange={(e) => setShape({ ...shape, joint: Number(e.target.value) })} style={field}>
            <option value={-1}>nearest bones</option>
            {joints.map((j, k) => (
              <option key={j.name} value={k}>
                {j.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <button
        type="button"
        className={styles.toolBtn}
        onClick={() =>
          run(
            `Add ${shape.kind}`,
            addShape(mesh, Math.min(shape.primitive, mesh.primitives.length - 1), { kind: shape.kind, center: pivot ?? [0, 0, 0], size: shape.size, segments: shape.segments }, shape.joint >= 0 ? shape.joint : undefined),
            false,
          )
        }
      >
        Add {shape.kind} {pivot ? "at the selection" : "at the origin"}
      </button>
      {note && <RailHint>{note}</RailHint>}
    </RailGroup>
  );
}
