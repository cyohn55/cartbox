"use client";

/**
 * The modular kit in the Mesh tab (EDITOR_PRO_ROADMAP.md P5), after Unreal's
 * BSP brushes and Blueprints and ProBuilder: drop in a stone or Forerunner
 * kit piece or a parametric shape, change the selected shape's parameters (it
 * rebuilds), and cut, join or intersect the selected object with another —
 * a CSG brush, or any other object. See shapeGenerators.ts and csg.ts in
 * @cartbox/editor and kitEdit.ts.
 */

import { useState } from "react";

import { KIT_PIECES, PARAMETRIC_KINDS, PARAMETRIC_SHAPES, type BrushShape, type CsgOp } from "@cartbox/editor";

import { addBrush, addKitPiece, addParametric, applyBoolean, setShapeParam } from "@/lib/kitEdit";
import { type MeshSidecar } from "@/lib/meshSidecar";
import styles from "./editor.module.css";
import { RailGroup, RailHint, RangeControl } from "./railControls";

const OPS: readonly { readonly op: CsgOp; readonly label: string; readonly hint: string }[] = [
  { op: "subtract", label: "Cut out", hint: "Cut the other object out of this one (a doorway, a window, a cave mouth)" },
  { op: "union", label: "Join", hint: "Join the other object to this one, as one solid" },
  { op: "intersect", label: "Keep overlap", hint: "Keep only where the two overlap" },
];

const BRUSHES: readonly BrushShape[] = ["box", "cylinder", "wedge"];

export function KitPanel({ sidecar, onChange, selectedId, onSelect }: { sidecar: MeshSidecar; onChange: (next: MeshSidecar) => void; selectedId: string | null; onSelect: (id: string) => void }) {
  const [tool, setTool] = useState("");
  const [keepTool, setKeepTool] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const selected = selectedId ? sidecar.meshes.find((m) => m.id === selectedId) : undefined;
  const others = sidecar.meshes.filter((m) => m.id !== selectedId);
  const toolId = others.some((m) => m.id === tool) ? tool : (others.find((m) => m.name.endsWith("brush"))?.id ?? "");
  const add = (made: { sidecar: MeshSidecar; id: string } | null) => {
    if (!made) return;
    onChange(made.sidecar);
    onSelect(made.id);
  };

  return (
    <RailGroup label="Kit and CSG">
      <select
        aria-label="Add a kit piece"
        value=""
        onChange={(event) => {
          const v = event.target.value;
          if (v.startsWith("kit:")) add(addKitPiece(sidecar, v.slice(4)));
          else if (v.startsWith("shape:")) add(addParametric(sidecar, v.slice(6) as (typeof PARAMETRIC_KINDS)[number]));
        }}
        style={{ width: "100%", marginBottom: 6 }}
      >
        <option value="">Add a kit piece or shape…</option>
        <optgroup label="Stone and Forerunner kit">
          {KIT_PIECES.map((k) => (
            <option key={k.id} value={`kit:${k.id}`}>
              {k.label}
            </option>
          ))}
        </optgroup>
        <optgroup label="Plain shapes">
          {PARAMETRIC_KINDS.map((k) => (
            <option key={k} value={`shape:${k}`}>
              {PARAMETRIC_SHAPES[k].label}
            </option>
          ))}
        </optgroup>
      </select>

      {selected?.shape && (
        <>
          <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>{PARAMETRIC_SHAPES[selected.shape.kind].label}: rebuilt as you change it</div>
          {PARAMETRIC_SHAPES[selected.shape.kind].params.map((q) => (
            <RangeControl
              key={q.key}
              label={q.label}
              nested
              min={q.min}
              max={q.max}
              step={q.step}
              value={selected.shape!.params[q.key] ?? q.value}
              onChange={(v) => onChange(setShapeParam(sidecar, selected.id, q.key, v))}
              ariaLabel={`${selected.name} ${q.label}`}
              display={q.step >= 1 ? `${Math.round(selected.shape!.params[q.key] ?? q.value)}` : `${(selected.shape!.params[q.key] ?? q.value).toFixed(2)} m`}
            />
          ))}
        </>
      )}

      <div style={{ fontSize: 11, opacity: 0.7, marginTop: 8 }}>CSG brushes</div>
      <div className={styles.toolGroup} style={{ marginTop: 4 }}>
        {BRUSHES.map((b) => (
          <button key={b} type="button" className={styles.toolBtn} title={`A see-through ${b}: place it, then cut it out of (or join it to) an object`} onClick={() => add(addBrush(sidecar, b))}>
            + {b}
          </button>
        ))}
      </div>
      {selected && others.length > 0 && (
        <>
          <select aria-label="The other object" value={toolId} onChange={(event) => setTool(event.target.value)} style={{ width: "100%", marginTop: 6 }}>
            <option value="">With…</option>
            {others.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <div className={styles.toolGroup} style={{ marginTop: 4 }}>
            {OPS.map(({ op, label, hint }) => (
              <button
                key={op}
                type="button"
                className={styles.toolBtn}
                disabled={!toolId}
                title={`${hint}: "${selected.name}" takes the result`}
                onClick={() => {
                  const result = applyBoolean(sidecar, selected.id, toolId, op, keepTool);
                  if ("problem" in result) {
                    setNote(result.problem);
                    return;
                  }
                  onChange(result.sidecar);
                  setNote(result.closed ? null : "Done, but the result isn't quite a closed solid: it draws fine, though cutting it again may leave seams.");
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginTop: 4 }}>
            <input type="checkbox" checked={keepTool} onChange={(event) => setKeepTool(event.target.checked)} />
            Keep the other object afterwards
          </label>
        </>
      )}
      {note && <RailHint>{note}</RailHint>}
      {!selected && <RailHint>Select an object to change its shape or cut it.</RailHint>}
    </RailGroup>
  );
}
