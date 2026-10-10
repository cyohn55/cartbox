"use client";

/**
 * Blockout editing in the Mesh tab (HALO_INFINITE_STYLE_ROADMAP.md I14): click
 * a face in the preview, then extrude, inset or bevel it (see meshEdit.ts in
 * @cartbox/editor). The face stays selected after an edit, so an inset can be
 * followed by an extrude of the face it leaves. Skinned meshes too (L15): what
 * an edit grows rides the bones its face did. In the Model edit mode, the face
 * is the first selected one.
 */

import { useState } from "react";

import { editMeshFace, faceAt, type FaceEdit, type MeshAsset } from "@cartbox/editor";

import { RailGroup, RailHint } from "./railControls";

export interface PickedFace {
  readonly primitive: number;
  readonly triangle: number;
}

const field: React.CSSProperties = { width: 64, padding: "4px 6px", borderRadius: 6 };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" };

function NumberInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
      {label}
      <input type="number" step={0.05} value={value} onChange={(e) => onChange(Number(e.target.value) || 0)} style={field} aria-label={label} />
    </label>
  );
}

export function FaceEditPanel({ mesh, picked, onEdit }: { mesh: MeshAsset; picked: PickedFace | null; onEdit: (next: MeshAsset) => void }) {
  const [distance, setDistance] = useState(0.5);
  const [amount, setAmount] = useState(0.2);
  const [width, setWidth] = useState(0.15);
  const [depth, setDepth] = useState(0.1);
  const [error, setError] = useState<string | null>(null);
  const primitive = picked ? mesh.primitives[picked.primitive] : undefined;
  const face = primitive && picked ? faceAt(primitive, picked.triangle) : null;
  const apply = (edit: FaceEdit) => {
    if (!picked) return;
    try {
      setError(null);
      onEdit(editMeshFace(mesh, picked.primitive, picked.triangle, edit));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <RailGroup label="Edit faces">
      {!face ? (
        <RailHint>Click a face in the preview to select it; drag to orbit.</RailHint>
      ) : (
        <>
          <RailHint>
            Face of {face.triangles.length} triangle{face.triangles.length === 1 ? "" : "s"}, {face.area.toFixed(2)} m², facing ({face.normal.map((v) => v.toFixed(2)).join(", ")}).
          </RailHint>
          <div style={row}>
            <NumberInput label="Distance" value={distance} onChange={setDistance} />
            <button type="button" onClick={() => apply({ kind: "extrude", distance })}>
              Extrude
            </button>
          </div>
          <div style={row}>
            <NumberInput label="Amount" value={amount} onChange={setAmount} />
            <button type="button" onClick={() => apply({ kind: "inset", amount })}>
              Inset
            </button>
          </div>
          <div style={row}>
            <NumberInput label="Width" value={width} onChange={setWidth} />
            <NumberInput label="Depth" value={depth} onChange={setDepth} />
            <button type="button" onClick={() => apply({ kind: "bevel", width, depth })}>
              Bevel
            </button>
          </div>
          <RailHint>A negative distance or depth cuts in: a recess, or a sunken channel for a light strip.</RailHint>
          {error && <RailHint>{error}</RailHint>}
        </>
      )}
    </RailGroup>
  );
}
