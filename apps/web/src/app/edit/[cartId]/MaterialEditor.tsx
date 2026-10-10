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
 *
 * Material sets and maps (LOCKOUT_MULTIPLAYER_ROADMAP.md L17): the panel edits
 * the mesh's own materials or one of its material sets (a set's part starts
 * as a copy of its own the first time it is changed), makes, renames and
 * deletes sets, and takes an uploaded image into any of a material's map
 * slots (see materialSets.ts).
 */

import { useState } from "react";

import {
  DEFAULT_CLEARCOAT_ROUGHNESS,
  MATERIAL_IMAGE_SLOTS,
  addMaterialSet,
  materialFor,
  patchMaterial,
  removeMaterialSet,
  renameMaterialSet,
  resetSetMaterial,
  setHasMaterial,
  setMaterialImage,
  DEFAULT_DETAIL_SCALE,
  DEFAULT_DETAIL_STRENGTH,
  PARALLAX_MAX_DEPTH,
  builtinDetailGrain,
  builtinPanelRelief,
  plasmaMaterial,
  type EncodedImage,
  type MaterialImageSlot,
  type MeshAsset,
  type MeshMaterial,
} from "@cartbox/editor";

import { starterGraph, wornEdgesGraph } from "@/lib/materialGraphEdit";
import styles from "./editor.module.css";
import { GraphEditor } from "./GraphEditor";
import { RailGroup, RailHint, RangeControl, SegmentedControl } from "./railControls";

interface MaterialEditorProps {
  /** The mesh whose materials are edited. */
  mesh: MeshAsset;
  /**
   * Called with the next mesh after any material edit; with `wear`, the
   * selected copy also puts on that material set (null: its own materials).
   */
  onChange: (mesh: MeshAsset, wear?: string | null) => void;
  /** The material set being edited (the one the selected copy wears), or null for the mesh's own materials. */
  set?: string | null;
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

export function MaterialEditor({ mesh, onChange, set = null }: MaterialEditorProps) {
  const [primitiveIndex, setPrimitiveIndex] = useState(0);
  const [graphOpen, setGraphOpen] = useState(false);
  const [setName, setSetName] = useState("");
  const index = primitiveIndex < mesh.primitives.length ? primitiveIndex : 0;
  const primitive = mesh.primitives[index];
  // A set the mesh no longer has edits its own materials.
  const editing = set && mesh.variants?.some((v) => v.name === set) ? set : null;
  const material = primitive ? materialFor(mesh, index, editing) : null;
  if (!primitive || !material) return null;

  const patch = (change: Partial<MeshMaterial>) => onChange(patchMaterial(mesh, index, change, editing));

  const [br, bg, bb, ba] = material.baseColorFactor;
  const emissive = material.emissiveFactor ?? [0, 0, 0];
  const metallic = material.metallicFactor ?? 1;
  const roughness = material.roughnessFactor ?? 1;

  return (
    <RailGroup label="Material" advanced defaultOpen>
      <div className={`${styles.groupLabel} ${styles.railSubLabel}`}>Material set</div>
      <select
        aria-label="Material set to edit"
        value={editing ?? ""}
        onChange={(event) => onChange(mesh, event.target.value || null)}
        style={{ width: "100%", padding: "4px 6px", borderRadius: 6, marginBottom: 6 }}
      >
        <option value="">Its own materials</option>
        {(mesh.variants ?? []).map((v) => (
          <option key={v.name} value={v.name}>
            {v.name}
          </option>
        ))}
      </select>
      <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
        <input
          aria-label="Material set name"
          placeholder={editing ? "Rename to…" : "New set's name"}
          value={setName}
          onChange={(event) => setSetName(event.target.value)}
          style={{ flex: 1, minWidth: 0, padding: "4px 6px", borderRadius: 6 }}
        />
        <button
          type="button"
          className={styles.toolBtn}
          title={editing ? `A new set starting as a copy of “${editing}”` : "A new set, wearing each part's own material until you change it"}
          onClick={() => {
            const made = addMaterialSet(mesh, setName || "New set", editing);
            if (made.name) onChange(made.mesh, made.name);
            setSetName("");
          }}
        >
          New
        </button>
        {editing && (
          <button
            type="button"
            className={styles.toolBtn}
            disabled={!setName.trim()}
            onClick={() => {
              const renamed = renameMaterialSet(mesh, editing, setName);
              onChange(renamed.mesh, renamed.name);
              setSetName("");
            }}
          >
            Rename
          </button>
        )}
        {editing && (
          <button type="button" className={styles.toolBtn} onClick={() => onChange(removeMaterialSet(mesh, editing), null)}>
            Delete
          </button>
        )}
      </div>
      {editing && (
        <RailHint>
          Editing “{editing}”, which this copy now wears.{" "}
          {setHasMaterial(mesh, editing, index) ? (
            <button type="button" className={styles.toolBtn} onClick={() => onChange(resetSetMaterial(mesh, editing, index))}>
              Use the part&apos;s own
            </button>
          ) : (
            "This part wears its own material until you change it here."
          )}
        </RailHint>
      )}
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
      {(material.alphaMode === "blend" || material.alphaMode === "additive") && (
        <>
          <RangeControl
            label="Refraction"
            nested
            min={0}
            max={1}
            step={0.05}
            value={material.refraction ?? 0}
            ariaLabel="Refraction"
            display={material.refraction ? material.refraction.toFixed(2) : "none"}
            onChange={(value) => patch({ refraction: value > 0 ? value : undefined })}
          />
          <RangeControl
            label="Shimmer"
            nested
            min={0}
            max={1}
            step={0.05}
            value={material.distortion ?? 0}
            ariaLabel="Shimmer"
            display={material.distortion ? material.distortion.toFixed(2) : "none"}
            onChange={(value) => patch({ distortion: value > 0 ? value : undefined })}
          />
        </>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          type="button"
          className={styles.toolBtn}
          title="Clear, glossy and reflective"
          onClick={() => patch({ alphaMode: "blend", alphaCutoff: undefined, softDepth: undefined, baseColorFactor: [0.85, 0.93, 1, 0.22], metallicFactor: 0, roughnessFactor: 0.04, reflectivity: 1.6, refraction: 0.5, distortion: undefined })}
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
        <button
          type="button"
          className={styles.toolBtn}
          title="Faint and additive, shimmering whatever is behind it (a vent, an engine, a plasma blade's heat)"
          onClick={() => patch({ alphaMode: "additive", alphaCutoff: undefined, softDepth: 0.4, baseColorFactor: [0.06, 0.04, 0.02, 1], metallicFactor: 0, roughnessFactor: 1, refraction: undefined, distortion: 0.6 })}
        >
          Heat haze
        </button>
        <button
          type="button"
          className={styles.toolBtn}
          title="Glowing, translucent energy: a white-hot heart cooling to blue at the edges, boiling, with a faint shimmer (an energy blade, a plasma charge)"
          onClick={() => patch(plasmaMaterial(material.name))}
        >
          Plasma
        </button>
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginTop: 6 }} title="A cart's pose tint (cartbox.meshpose … tint) recolours this part: team colours on one shared mesh">
        <input type="checkbox" checked={Boolean(material.tintable)} onChange={(event) => patch({ tintable: event.target.checked || undefined, tintMix: undefined })} />
        Takes the team colour
      </label>
      {material.tintable && (
        <RangeControl
          label="Team colour share"
          nested
          min={0}
          max={1}
          step={0.05}
          value={material.tintMix ?? 1}
          ariaLabel="Team colour share"
          display={`${Math.round((material.tintMix ?? 1) * 100)}%`}
          onChange={(value) => patch({ tintMix: value >= 1 ? undefined : value })}
        />
      )}

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

      <MaterialMaps material={material} onImage={(slot, image) => onChange(setMaterialImage(mesh, index, slot, image, editing))} />

      <SurfaceEffects material={material} patch={patch} />
      <MaterialLayers material={material} patch={patch} onWear={() => setGraphOpen(true)} />

      <RailHint>Metallic-roughness PBR — used by the Modern render tier. Capped tiers ignore these and render unchanged.</RailHint>
    </RailGroup>
  );
}

/** The size of an image's bytes, as the slot list shows it. */
const kib = (image: EncodedImage) => (image.bytes.length > 0 ? `${image.mime.replace("image/", "").toUpperCase()} ${Math.max(1, Math.round(image.bytes.length / 1024))} KB` : "streamed");

/**
 * Every map slot of the material (L17): what is in it, an image file to put
 * in it, or clear it. Painting into the base colour, metal/roughness,
 * emissive and team-colour slots is the Paint mode's.
 */
function MaterialMaps({ material, onImage }: { material: MeshMaterial; onImage: (slot: MaterialImageSlot, image: EncodedImage | null) => void }) {
  const [error, setError] = useState<string | null>(null);
  const upload = async (slot: MaterialImageSlot, file: File | undefined) => {
    if (!file) return;
    const mime = file.type || (/\.jpe?g$/i.test(file.name) ? "image/jpeg" : "image/png");
    if (!/^image\/(png|jpeg)$/.test(mime)) {
      setError("Upload a PNG or JPEG image.");
      return;
    }
    setError(null);
    onImage(slot, { mime, bytes: new Uint8Array(await file.arrayBuffer()) });
  };
  return (
    <details style={{ fontSize: 12, margin: "8px 0" }}>
      <summary className={styles.groupLabel}>Maps</summary>
      <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
        {MATERIAL_IMAGE_SLOTS.map(({ slot, label, hint }) => {
          const image = material[slot] as EncodedImage | null | undefined;
          return (
            <div key={slot} style={{ display: "flex", alignItems: "center", gap: 4 }} title={hint}>
              <span style={{ flex: 1, minWidth: 0 }}>
                {label} <span className={styles.hudLabel}>{image ? kib(image) : "none"}</span>
              </span>
              <label className={styles.toolBtn} style={{ cursor: "pointer" }}>
                Upload…
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  hidden
                  aria-label={`Upload ${label} map`}
                  onChange={(event) => {
                    void upload(slot, event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
              </label>
              {image && (
                <button type="button" className={styles.toolBtn} aria-label={`Clear ${label} map`} onClick={() => onImage(slot, null)}>
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>
      {error && <RailHint>{error}</RailHint>}
    </details>
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

/**
 * Layers and relief (HALO_INFINITE_STYLE_ROADMAP.md I4): a glossy clearcoat over
 * the base, brushed-metal anisotropy, and a relief map whose height gives panel
 * seams depth (parallax) and whose curvature drives the graph's wear masks.
 */
function MaterialLayers({ material, patch, onWear }: { material: MeshMaterial; patch: (change: Partial<MeshMaterial>) => void; onWear: () => void }) {
  const coat = material.clearcoat ?? 0;
  const aniso = material.anisotropy ?? 0;
  const turn = Math.round(((material.anisotropyRotation ?? 0) * 180) / Math.PI);
  const reliefOn = !!material.reliefImage;
  const depth = material.parallaxDepth ?? 0;
  return (
    <>
      <div className={`${styles.groupLabel} ${styles.railSubLabel}`}>Clearcoat</div>
      <RangeControl label="Coat" nested min={0} max={1} step={0.05} value={coat} ariaLabel="Clearcoat" display={coat > 0 ? coat.toFixed(2) : "none"} onChange={(value) => patch({ clearcoat: value > 0 ? value : undefined })} />
      {coat > 0 && (
        <RangeControl
          label="Coat roughness"
          nested
          min={0}
          max={1}
          step={0.01}
          value={material.clearcoatRoughness ?? DEFAULT_CLEARCOAT_ROUGHNESS}
          ariaLabel="Clearcoat roughness"
          display={(material.clearcoatRoughness ?? DEFAULT_CLEARCOAT_ROUGHNESS).toFixed(2)}
          onChange={(value) => patch({ clearcoatRoughness: value })}
        />
      )}

      <div className={`${styles.groupLabel} ${styles.railSubLabel}`}>Brushed metal</div>
      <RangeControl label="Anisotropy" nested min={-1} max={1} step={0.05} value={aniso} ariaLabel="Anisotropy" display={aniso !== 0 ? aniso.toFixed(2) : "round"} onChange={(value) => patch({ anisotropy: value !== 0 ? value : undefined })} />
      {aniso !== 0 && (
        <RangeControl label="Grain direction" nested min={-180} max={180} step={5} value={turn} ariaLabel="Anisotropy direction" display={`${turn}°`} onChange={(deg) => patch({ anisotropyRotation: deg !== 0 ? (deg * Math.PI) / 180 : undefined })} />
      )}

      <div className={`${styles.groupLabel} ${styles.railSubLabel}`}>Relief</div>
      <SegmentedControl
        label="Relief"
        ariaLabel="Relief map"
        selected={reliefOn ? "on" : "off"}
        onSelect={(id) => patch(id === "on" ? { reliefImage: builtinPanelRelief() } : { reliefImage: undefined, parallaxDepth: undefined })}
        options={[
          { id: "off", label: "Off" },
          { id: "on", label: "Panels" },
        ]}
      />
      {reliefOn && (
        <>
          <RangeControl
            label="Depth"
            nested
            min={0}
            max={PARALLAX_MAX_DEPTH}
            step={0.005}
            value={depth}
            ariaLabel="Parallax depth"
            display={depth > 0 ? `${depth.toFixed(3)} m` : "flat"}
            onChange={(value) => patch({ parallaxDepth: value > 0 ? value : undefined })}
          />
          <button
            type="button"
            className={styles.toolBtn}
            title="Wire the relief's curvature into the material graph: the colour worn to bare metal on its edges, broken up by noise, and grime in its cavities"
            onClick={() => {
              patch({ graph: wornEdgesGraph(material.graph) });
              onWear();
            }}
          >
            ◇ Add edge wear
          </button>
        </>
      )}
      <RailHint>A relief map&apos;s height gives seams depth; its curvature feeds the graph&apos;s wear masks.</RailHint>
    </>
  );
}
