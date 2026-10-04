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

import {
  DEFAULT_DETAIL_SCALE,
  DEFAULT_DETAIL_STRENGTH,
  builtinDetailGrain,
  updateMeshMaterial,
  type MeshAsset,
  type MeshMaterial,
} from "@cartbox/editor";

import { starterGraph } from "@/lib/materialGraphEdit";
import styles from "./editor.module.css";
import { GraphEditor } from "./GraphEditor";
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
  const [graphOpen, setGraphOpen] = useState(false);
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

      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          className={styles.toolBtn}
          title="Build this material from nodes: textures, maths, time, UVs, fresnel and noise wired into its colour, alpha, glow, metalness and roughness"
          onClick={() => {
            if (!material.graph) patch({ graph: starterGraph() });
            setGraphOpen(true);
          }}
        >
          {material.graph ? "◇ Edit graph…" : "◇ Material graph…"}
        </button>
        {material.graph && <span className={styles.hudLabel}>a graph drives {Object.keys(material.graph.outputs).length || "none"} of its inputs</span>}
      </div>
      {graphOpen && material.graph && (
        <GraphEditor
          material={material}
          onChange={(graph) => {
            patch({ graph });
            if (!graph) setGraphOpen(false);
          }}
          onClose={() => setGraphOpen(false)}
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
      <SegmentedControl
        label="Transparency"
        ariaLabel="Transparency"
        wrap
        selected={material.alphaMode ?? "opaque"}
        onSelect={(mode) =>
          patch(
            mode === "opaque"
              ? { alphaMode: undefined, alphaCutoff: undefined, softDepth: undefined }
              : { alphaMode: mode, ...(mode === "mask" ? { alphaCutoff: material.alphaCutoff ?? 0.5, softDepth: undefined } : { alphaCutoff: undefined }) },
          )
        }
        options={[
          { id: "opaque", label: "Opaque", hint: "Solid: opacity and the texture's alpha are ignored" },
          { id: "mask", label: "Cut out", hint: "Texels below the threshold are dropped (foliage, grilles)" },
          { id: "blend", label: "See-through", hint: "Blended over what's behind it by its opacity (glass, water, smoke)" },
          { id: "additive", label: "Additive", hint: "Adds its light to what's behind it (glows, energy, sparks)" },
        ]}
      />
      {material.alphaMode === "mask" && (
        <RangeControl
          label="Cut-out threshold"
          nested
          min={0}
          max={1}
          step={0.01}
          value={material.alphaCutoff ?? 0.5}
          ariaLabel="Cut-out threshold"
          display={(material.alphaCutoff ?? 0.5).toFixed(2)}
          onChange={(value) => patch({ alphaCutoff: value })}
        />
      )}
      {(material.alphaMode === "blend" || material.alphaMode === "additive") && (
        <RangeControl
          label="Soft edge"
          nested
          min={0}
          max={2}
          step={0.05}
          value={material.softDepth ?? 0}
          ariaLabel="Soft edge"
          display={material.softDepth ? `${material.softDepth.toFixed(2)} m` : "hard"}
          onChange={(value) => patch({ softDepth: value > 0 ? value : undefined })}
        />
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          type="button"
          className={styles.toolBtn}
          title="Clear, glossy and reflective"
          onClick={() => patch({ alphaMode: "blend", alphaCutoff: undefined, softDepth: undefined, baseColorFactor: [0.85, 0.93, 1, 0.22], metallicFactor: 0, roughnessFactor: 0.04, reflectivity: 1.6 })}
        >
          Glass
        </button>
        <button
          type="button"
          className={styles.toolBtn}
          title="Deep blue-green, smooth, mostly opaque, fading out at the shore"
          onClick={() => patch({ alphaMode: "blend", alphaCutoff: undefined, softDepth: 0.6, baseColorFactor: [0.1, 0.38, 0.5, 0.7], metallicFactor: 0, roughnessFactor: 0.08, reflectivity: 1.2 })}
        >
          Water
        </button>
      </div>

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

      <SurfaceEffects material={material} patch={patch} />

      <RailHint>Metallic-roughness PBR — used by the Modern render tier. Capped tiers ignore these and render unchanged.</RailHint>
    </RailGroup>
  );
}

/**
 * Surface effects (HALO2_STYLE_ROADMAP.md H3): a detail grain up close, an
 * emissive glow that scrolls and pulses, a fresnel rim, and how strongly the
 * surface reflects (optionally masked by its metallic-roughness map's alpha).
 */
function SurfaceEffects({ material, patch }: { material: MeshMaterial; patch: (change: Partial<MeshMaterial>) => void }) {
  const detailOn = !!material.detailImage;
  const pulse = material.emissivePulse ?? { rate: 0, depth: 0 };
  const scroll = material.emissiveScroll ?? [0, 0];
  const rim = material.rim ?? { color: [0.6, 0.75, 0.9] as const, power: 4, strength: 0 };
  const reflectivity = material.reflectivity ?? 1;
  const setPulse = (next: { rate: number; depth: number }) => patch({ emissivePulse: next.rate > 0 && next.depth > 0 ? next : undefined });
  const setScroll = (next: [number, number]) => patch({ emissiveScroll: next[0] !== 0 || next[1] !== 0 ? next : undefined });
  const setRim = (next: { color: readonly [number, number, number]; power: number; strength: number }) => patch({ rim: next.strength > 0 ? next : undefined });
  return (
    <>
      <div className={`${styles.groupLabel} ${styles.railSubLabel}`}>Detail grain</div>
      <SegmentedControl
        label="Detail"
        ariaLabel="Detail grain"
        selected={detailOn ? "on" : "off"}
        onSelect={(id) => patch({ detailImage: id === "on" ? builtinDetailGrain() : undefined })}
        options={[
          { id: "off", label: "Off" },
          { id: "on", label: "Grain" },
        ]}
      />
      {detailOn && (
        <>
          <RangeControl
            label="Tiling"
            nested
            min={1}
            max={32}
            step={1}
            value={material.detailScale ?? DEFAULT_DETAIL_SCALE}
            ariaLabel="Detail tiling"
            display={`×${material.detailScale ?? DEFAULT_DETAIL_SCALE}`}
            onChange={(detailScale) => patch({ detailScale })}
          />
          <RangeControl
            label="Strength"
            nested
            min={0}
            max={1}
            step={0.05}
            value={material.detailStrength ?? DEFAULT_DETAIL_STRENGTH}
            ariaLabel="Detail strength"
            display={(material.detailStrength ?? DEFAULT_DETAIL_STRENGTH).toFixed(2)}
            onChange={(detailStrength) => patch({ detailStrength })}
          />
        </>
      )}

      <div className={`${styles.groupLabel} ${styles.railSubLabel}`}>Glow animation</div>
      <RangeControl label="Pulse rate" nested min={0} max={3} step={0.05} value={pulse.rate} ariaLabel="Emissive pulse rate" display={`${pulse.rate.toFixed(2)} Hz`} onChange={(rate) => setPulse({ ...pulse, rate })} />
      <RangeControl label="Pulse depth" nested min={0} max={1} step={0.05} value={pulse.depth} ariaLabel="Emissive pulse depth" display={`${Math.round(pulse.depth * 100)}%`} onChange={(depth) => setPulse({ ...pulse, depth })} />
      <RangeControl label="Scroll U" nested min={-2} max={2} step={0.05} value={scroll[0]} ariaLabel="Emissive scroll U" display={`${scroll[0].toFixed(2)}/s`} onChange={(u) => setScroll([u, scroll[1]])} />
      <RangeControl label="Scroll V" nested min={-2} max={2} step={0.05} value={scroll[1]} ariaLabel="Emissive scroll V" display={`${scroll[1].toFixed(2)}/s`} onChange={(v) => setScroll([scroll[0], v])} />

      <div className={`${styles.groupLabel} ${styles.railSubLabel}`}>Rim &amp; reflections</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="color"
          value={toHex(rim.color as [number, number, number])}
          aria-label="Rim colour"
          onChange={(event) => setRim({ ...rim, color: fromHex(event.target.value), strength: rim.strength || 0.2 })}
          style={{ width: 40, height: 32, padding: 0, border: "none", background: "none", borderRadius: 6 }}
        />
        <span className={styles.hudLabel}>rim</span>
      </div>
      <RangeControl label="Rim strength" nested min={0} max={1} step={0.01} value={rim.strength} ariaLabel="Rim strength" display={rim.strength.toFixed(2)} onChange={(strength) => setRim({ ...rim, strength })} />
      <RangeControl label="Rim tightness" nested min={1} max={8} step={0.5} value={rim.power} ariaLabel="Rim tightness" display={rim.power.toFixed(1)} onChange={(power) => setRim({ ...rim, power })} />
      <RangeControl
        label="Reflectivity"
        nested
        min={0}
        max={2}
        step={0.05}
        value={reflectivity}
        ariaLabel="Reflectivity"
        display={reflectivity.toFixed(2)}
        onChange={(value) => patch({ reflectivity: value === 1 ? undefined : value })}
      />
      {material.metallicRoughnessImage && (
        <SegmentedControl
          label="Reflection mask"
          ariaLabel="Reflection mask"
          selected={material.reflectionMask ? "on" : "off"}
          onSelect={(id) => patch({ reflectionMask: id === "on" ? true : undefined })}
          options={[
            { id: "off", label: "Off" },
            { id: "on", label: "Map alpha" },
          ]}
        />
      )}
    </>
  );
}
