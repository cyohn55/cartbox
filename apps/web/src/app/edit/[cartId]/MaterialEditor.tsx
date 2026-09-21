"use client";

/**
 * The PBR material panel (Phase 6 — 3D authoring UX). Edits one primitive's
 * metallic-roughness material — base colour, metalness, roughness, and emissive —
 * on the selected mesh, mirroring glTF 2.0's material model so an authored surface
 * and an imported one are edited the same way.
 *
 * Purely presentational and fully controlled: it holds only the primitive
 * selection (which face-group is being edited), and every value comes from the
 * mesh handed in. Each edit runs the pure {@link updateMeshMaterial} and reports
 * the whole next mesh through {@link onChange}, which the Mesh tab re-serialises
 * into the sidecar and re-previews — the editor never mutates the asset in place.
 *
 * These fields are additive: a fantasy-console material that sets none renders
 * exactly as before, so touching them here never regresses a capped tier (see
 * AAA_TIER_ROADMAP.md).
 */

import { useState } from "react";

import { updateMeshMaterial, type MeshAsset, type MeshMaterial } from "@cartbox/editor";

import styles from "./editor.module.css";
import { RailGroup, RailHint, RangeControl, SegmentedControl } from "./railControls";

interface MaterialEditorProps {
  /** The mesh whose materials are edited. */
  mesh: MeshAsset;
  /** Called with the next mesh after any material edit. */
  onChange: (mesh: MeshAsset) => void;
}

/** Clamp a channel to 0..1 and quantise to a byte, matching an 8-bit colour input. */
function toHex(rgb: readonly [number, number, number]): string {
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return `#${[byte(rgb[0]), byte(rgb[1]), byte(rgb[2])].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/** Parse `#rrggbb` back into a 0..1 triple; a malformed value yields black. */
function fromHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255];
}

export function MaterialEditor({ mesh, onChange }: MaterialEditorProps) {
  const [primitiveIndex, setPrimitiveIndex] = useState(0);
  const index = primitiveIndex < mesh.primitives.length ? primitiveIndex : 0;
  const primitive = mesh.primitives[index];
  if (!primitive) return null;
  const material = primitive.material;

  const patch = (change: Partial<MeshMaterial>) => onChange(updateMeshMaterial(mesh, index, change));

  const [br, bg, bb, ba] = material.baseColorFactor;
  const emissive = material.emissiveFactor ?? [0, 0, 0];
  const metallic = material.metallicFactor ?? 1;
  const roughness = material.roughnessFactor ?? 1;

  return (
    <RailGroup label="Material" advanced defaultOpen>
      {mesh.primitives.length > 1 && (
        <SegmentedControl
          label="Part"
          ariaLabel="Material part"
          wrap
          selected={index}
          onSelect={setPrimitiveIndex}
          options={mesh.primitives.map((p, i) => ({ id: i, label: p.material.name || `#${i + 1}`, hint: p.material.name }))}
        />
      )}

      <div className={`${styles.groupLabel} ${styles.railSubLabel}`}>Base colour</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="color"
          value={toHex([br, bg, bb])}
          aria-label="Base colour"
          onChange={(event) => {
            const [r, g, b] = fromHex(event.target.value);
            patch({ baseColorFactor: [r, g, b, ba] });
          }}
          style={{ width: 40, height: 32, padding: 0, border: "none", background: "none", borderRadius: 6 }}
        />
        {material.baseColorImage ? (
          <span className={styles.hudLabel}>× texture</span>
        ) : (
          <span className={styles.hudLabel}>flat</span>
        )}
      </div>
      <RangeControl
        label="Opacity"
        nested
        min={0}
        max={1}
        step={0.01}
        value={ba}
        ariaLabel="Base colour opacity"
        display={ba.toFixed(2)}
        onChange={(value) => patch({ baseColorFactor: [br, bg, bb, value] })}
      />

      <RangeControl
        label="Metallic"
        nested
        min={0}
        max={1}
        step={0.01}
        value={metallic}
        ariaLabel="Metallic"
        display={metallic.toFixed(2)}
        onChange={(value) => patch({ metallicFactor: value })}
      />
      <RangeControl
        label="Roughness"
        nested
        min={0}
        max={1}
        step={0.01}
        value={roughness}
        ariaLabel="Roughness"
        display={roughness.toFixed(2)}
        onChange={(value) => patch({ roughnessFactor: value })}
      />

      <div className={`${styles.groupLabel} ${styles.railSubLabel}`}>Emissive</div>
      <input
        type="color"
        value={toHex(emissive as [number, number, number])}
        aria-label="Emissive colour"
        onChange={(event) => patch({ emissiveFactor: fromHex(event.target.value) })}
        style={{ width: 40, height: 32, padding: 0, border: "none", background: "none", borderRadius: 6 }}
      />

      <RailHint>Metallic-roughness PBR — used by the Modern render tier. Capped tiers ignore these and render unchanged.</RailHint>
    </RailGroup>
  );
}
