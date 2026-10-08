"use client";

/**
 * The scene lighting & skybox panel (Phase 6 — 3D authoring UX). Authors the
 * Modern-tier lighting rig the runtime replays over the mesh overlay: the skybox
 * gradient (image-based lighting), an ambient floor, tone mapping, shadows, and a
 * list of directional / point / spot lights.
 *
 * Fully controlled: it edits the rig handed in through the pure helpers in
 * `@cartbox/editor` and reports the whole next rig (or null to clear it) through
 * {@link onChange}. A cart with no rig renders exactly as before, so the panel
 * leads with a single "Add lighting" button — opting in is explicit.
 */

import { useState } from "react";

import {
  MAX_CLOUD_LAYERS,
  MAX_SKY_OBJECTS,
  MAX_SKY_PANORAMA_CHARS,
  bytesToBase64,
  type SkyCloudLayer,
  type SkyObject,
  addSceneLight,
  defaultProceduralSky,
  defaultSceneFog,
  defaultSceneLighting,
  defaultSunShafts,
  setSceneShafts,
  MAX_FOG_VOLUMES,
  type FogVolume,
  patchSceneLighting,
  removeSceneLight,
  setSceneFog,
  setSceneProbes,
  reflectionProbeAt,
  MAX_REFLECTION_PROBES,
  setSceneSky,
  updateSceneEnvironment,
  updateSceneLight,
  type ProceduralSky,
  type ReflectionProbe,
  type SceneFog,
  type SceneLight,
  type SceneLighting,
} from "@cartbox/editor";

import styles from "./editor.module.css";
import { RailGroup, RailHint, RangeControl, SegmentedControl } from "./railControls";

interface LightingEditorProps {
  lighting: SceneLighting | null;
  onChange: (lighting: SceneLighting | null) => void;
}

type Rgb = readonly [number, number, number];

/** A 0..1 RGB triple as `#rrggbb`. */
function toHex(rgb: Rgb): string {
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return `#${[byte(rgb[0]), byte(rgb[1]), byte(rgb[2])].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/** Parse `#rrggbb` back into a 0..1 triple; a malformed value yields black. */
function fromHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255];
}

/** A labelled colour swatch row. */
function ColorRow({ label, value, onChange }: { label: string; value: Rgb; onChange: (rgb: [number, number, number]) => void }) {
  return (
    <div className={styles.rangeRow} style={{ marginBottom: 6 }}>
      <span className={styles.groupLabel}>{label}</span>
      <input type="color" value={toHex(value)} aria-label={label} onChange={(e) => onChange(fromHex(e.target.value))} />
    </div>
  );
}

/** Three numeric inputs editing a world-space vector (direction or position). */
function VectorRow({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: Rgb;
  step: number;
  onChange: (v: [number, number, number]) => void;
}) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div className={`${styles.groupLabel} ${styles.railSubLabel}`} style={{ marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        {[0, 1, 2].map((axis) => (
          <input
            key={axis}
            type="number"
            step={step}
            value={value[axis]}
            aria-label={`${label} ${["X", "Y", "Z"][axis]}`}
            onChange={(e) => {
              const next = [...value] as [number, number, number];
              const parsed = Number(e.target.value);
              next[axis] = Number.isFinite(parsed) ? parsed : 0;
              onChange(next);
            }}
            style={{ width: "100%", minWidth: 0, padding: "4px 6px", borderRadius: 6 }}
          />
        ))}
      </div>
    </div>
  );
}

export function LightingEditor({ lighting, onChange }: LightingEditorProps) {
  // A big rig (EP8: dozens of lights) lists each light as one row, opened one at a time.
  const [openLight, setOpenLight] = useState<number | null>(null);
  if (!lighting) {
    return (
      <RailGroup label="Lighting" advanced defaultOpen>
        <button type="button" className={styles.toolBtn} onClick={() => onChange(defaultSceneLighting())}>
          <span className={styles.toolGlyph} aria-hidden>
            ☀
          </span>
          Add scene lighting
        </button>
        <RailHint>Modern-tier lighting & skybox for the 3D scene. Off by default — capped tiers are unaffected.</RailHint>
      </RailGroup>
    );
  }

  const env = lighting.environment;

  return (
    <RailGroup label="Lighting" advanced defaultOpen>
      <div className={`${styles.groupLabel} ${styles.railSubLabel}`}>Skybox gradient</div>
      <ColorRow label="Sky" value={env.sky} onChange={(sky) => onChange(updateSceneEnvironment(lighting, { sky }))} />
      <ColorRow label="Horizon" value={env.horizon} onChange={(horizon) => onChange(updateSceneEnvironment(lighting, { horizon }))} />
      <ColorRow label="Ground" value={env.ground} onChange={(ground) => onChange(updateSceneEnvironment(lighting, { ground }))} />
      <RangeControl
        label="Sky intensity"
        nested
        min={0}
        max={4}
        step={0.05}
        value={env.intensity}
        ariaLabel="Sky intensity"
        display={`${env.intensity.toFixed(2)}×`}
        onChange={(intensity) => onChange(updateSceneEnvironment(lighting, { intensity }))}
      />

      <SkyDomeControls lighting={lighting} onChange={onChange} />
      <FogControls lighting={lighting} onChange={onChange} />
      <ShaftControls lighting={lighting} onChange={onChange} />
      <ProbeControls lighting={lighting} onChange={onChange} />

      <RangeControl
        label="Ambient fill"
        nested
        min={0}
        max={1}
        step={0.01}
        value={lighting.ambient}
        ariaLabel="Ambient fill"
        display={lighting.ambient.toFixed(2)}
        onChange={(ambient) => onChange(patchSceneLighting(lighting, { ambient }))}
      />

      <SegmentedControl
        label="Tone mapping"
        ariaLabel="Tone mapping"
        selected={lighting.tonemap ? "on" : "off"}
        onSelect={(id) => onChange(patchSceneLighting(lighting, { tonemap: id === "on" }))}
        options={[
          { id: "off", label: "Off" },
          { id: "on", label: "ACES" },
        ]}
      />
      {lighting.tonemap && (
        <RangeControl
          label="Exposure"
          nested
          min={0.1}
          max={4}
          step={0.05}
          value={lighting.exposure}
          ariaLabel="Exposure"
          display={`${lighting.exposure.toFixed(2)}×`}
          onChange={(exposure) => onChange(patchSceneLighting(lighting, { exposure }))}
        />
      )}

      <SegmentedControl
        label="Shadows"
        ariaLabel="Shadows"
        selected={lighting.shadows ? "on" : "off"}
        onSelect={(id) => onChange(patchSceneLighting(lighting, { shadows: id === "on" }))}
        options={[
          { id: "off", label: "Off" },
          { id: "on", label: "On" },
        ]}
      />

      <div className={`${styles.groupLabel} ${styles.railSubLabel}`} style={{ marginTop: 8 }}>
        Lights · {lighting.lights.length}
      </div>
      {lighting.lights.map((light, index) => {
        const compact = lighting.lights.length > 3;
        if (compact && openLight !== index) {
          const where = light.kind === "directional" ? "from the sky" : (light.position ?? [0, 0, 0]).map((v) => v.toFixed(1)).join(", ");
          return (
            <button
              key={index}
              type="button"
              className={styles.toolBtn}
              onClick={() => setOpenLight(index)}
              title="Edit this light"
              style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", marginBottom: 3, textAlign: "left" }}
            >
              <span aria-hidden>{light.kind === "directional" ? "☀" : light.kind === "spot" ? "◢" : "●"}</span>
              <span aria-hidden style={{ width: 10, height: 10, borderRadius: 5, flex: "0 0 auto", background: `rgb(${light.color.map((c) => Math.round(c * 255)).join(",")})` }} />
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {light.kind === "directional" ? "Sun" : light.kind === "spot" ? "Spot" : "Point"} · {where}
              </span>
            </button>
          );
        }
        return (
        <div key={index} style={{ border: "1px solid #2a2f45", borderRadius: 8, padding: 8, marginBottom: 8 }}>
          {compact && (
            <button type="button" className={styles.toolBtn} onClick={() => setOpenLight(null)} style={{ marginBottom: 4 }}>
              ▾ Light {index + 1} of {lighting.lights.length}
            </button>
          )}
          <SegmentedControl
            ariaLabel={`Light ${index + 1} type`}
            selected={light.kind}
            onSelect={(kind) =>
              onChange(
                updateSceneLight(
                  lighting,
                  index,
                  kind === "directional"
                    ? { kind, direction: light.direction ?? [0.4, 0.8, 0.6], position: undefined, range: undefined, innerAngle: undefined, outerAngle: undefined }
                    : kind === "spot"
                      ? { kind, position: light.position ?? [0, 3, 0], range: light.range || 12, direction: [0, -1, 0], innerAngle: light.innerAngle ?? 20, outerAngle: light.outerAngle ?? 30 }
                      : { kind, position: light.position ?? [0, 1, 0], range: light.range ?? 0, direction: undefined, innerAngle: undefined, outerAngle: undefined },
                ),
              )
            }
            options={[
              { id: "directional", label: "Sun" },
              { id: "point", label: "Point" },
              { id: "spot", label: "Spot" },
            ]}
          />
          <ColorRow
            label="Colour"
            value={light.color}
            onChange={(color) => onChange(updateSceneLight(lighting, index, { color }))}
          />
          <RangeControl
            label="Intensity"
            nested
            min={0}
            max={8}
            step={0.1}
            value={light.intensity}
            ariaLabel={`Light ${index + 1} intensity`}
            display={`${light.intensity.toFixed(1)}×`}
            onChange={(intensity) => onChange(updateSceneLight(lighting, index, { intensity }))}
          />
          {light.kind === "directional" ? (
            <VectorRow
              label="Direction"
              step={0.1}
              value={light.direction ?? [0.4, 0.8, 0.6]}
              onChange={(direction) => onChange(updateSceneLight(lighting, index, { direction }))}
            />
          ) : (
            <>
              <VectorRow
                label="Position"
                step={0.5}
                value={light.position ?? [0, 1, 0]}
                onChange={(position) => onChange(updateSceneLight(lighting, index, { position }))}
              />
              <RangeControl
                label="Range"
                nested
                min={0}
                max={100}
                step={1}
                value={light.range ?? 0}
                ariaLabel={`Light ${index + 1} range`}
                display={light.range ? `${light.range}` : "∞"}
                onChange={(range) => onChange(updateSceneLight(lighting, index, { range }))}
              />
              <SegmentedControl
                label="Shadows"
                ariaLabel={`Light ${index + 1} shadows`}
                selected={light.castShadows ? "on" : "off"}
                onSelect={(v) => onChange(updateSceneLight(lighting, index, { castShadows: v === "on" ? true : undefined, range: v === "on" && !light.range ? 10 : light.range }))}
                options={[
                  { id: "off", label: "Off" },
                  { id: "on", label: "Cast", hint: "This light throws shadows (it needs a range); a spot takes one shadow map, a point light six" },
                ]}
              />
              {light.kind === "spot" && (
                <>
                  <VectorRow
                    label="Aim"
                    step={0.1}
                    value={light.direction ?? [0, -1, 0]}
                    onChange={(direction) => onChange(updateSceneLight(lighting, index, { direction }))}
                  />
                  <RangeControl
                    label="Cone"
                    nested
                    min={1}
                    max={89}
                    step={1}
                    value={light.outerAngle ?? 30}
                    ariaLabel={`Light ${index + 1} cone angle`}
                    display={`${light.outerAngle ?? 30}°`}
                    onChange={(outerAngle) => onChange(updateSceneLight(lighting, index, { outerAngle, innerAngle: Math.min(light.innerAngle ?? outerAngle * 0.75, outerAngle) }))}
                  />
                  <RangeControl
                    label="Soft edge"
                    nested
                    min={0}
                    max={100}
                    step={1}
                    value={Math.round(100 * (1 - (light.innerAngle ?? 22.5) / (light.outerAngle ?? 30)))}
                    ariaLabel={`Light ${index + 1} cone softness`}
                    display={`${Math.round(100 * (1 - (light.innerAngle ?? 22.5) / (light.outerAngle ?? 30)))}%`}
                    onChange={(soft) => onChange(updateSceneLight(lighting, index, { innerAngle: (light.outerAngle ?? 30) * (1 - soft / 100) }))}
                  />
                </>
              )}
            </>
          )}
          <button
            type="button"
            className={styles.toolBtn}
            onClick={() => onChange(removeSceneLight(lighting, index))}
            title="Remove this light"
          >
            <span className={styles.toolGlyph} aria-hidden>
              ✕
            </span>
            Remove light
          </button>
        </div>
        );
      })}

      <div className={styles.toolGroup}>
        <button
          type="button"
          className={styles.toolBtn}
          onClick={() => onChange(addSceneLight(lighting, directionalLight()))}
        >
          <span className={styles.toolGlyph} aria-hidden>
            ＋
          </span>
          Add sun
        </button>
        <button type="button" className={styles.toolBtn} onClick={() => onChange(addSceneLight(lighting, pointLight()))}>
          <span className={styles.toolGlyph} aria-hidden>
            ＋
          </span>
          Add point light
        </button>
        <button type="button" className={styles.toolBtn} onClick={() => onChange(addSceneLight(lighting, spotLight()))}>
          <span className={styles.toolGlyph} aria-hidden>
            ＋
          </span>
          Add spot light
        </button>
      </div>

      <button type="button" className={styles.toolBtn} onClick={() => onChange(null)} title="Remove the whole lighting rig">
        <span className={styles.toolGlyph} aria-hidden>
          🗑
        </span>
        Clear lighting
      </button>
      <RailHint>Lights and the skybox shade Modern-tier (PBR) materials. Capped tiers ignore them.</RailHint>
    </RailGroup>
  );
}

/**
 * The procedural sky dome: a baked panorama (clouds + mountain rings) drawn
 * behind a first-person view and used as the image-based light. The rig stores
 * only these parameters; the runtime bakes the pixels at load.
 */
function SkyDomeControls({ lighting, onChange }: LightingEditorProps & { lighting: SceneLighting }) {
  const sky = lighting.sky ?? null;
  const patch = (next: Partial<ProceduralSky>) => sky && onChange(setSceneSky(lighting, { ...sky, ...next }));
  const tallest = sky?.mountains.reduce((m, r) => Math.max(m, r.height), 0) ?? 0;
  return (
    <>
      <SegmentedControl
        label="Sky dome"
        ariaLabel="Sky dome"
        selected={sky ? "on" : "off"}
        onSelect={(id) => onChange(setSceneSky(lighting, id === "on" ? (sky ?? defaultProceduralSky()) : null))}
        options={[
          { id: "off", label: "Gradient" },
          { id: "on", label: "Mountains" },
        ]}
      />
      {sky && (
        <>
          <ColorRow label="Zenith" value={sky.zenith} onChange={(zenith) => patch({ zenith })} />
          <ColorRow label="Sky horizon" value={sky.horizon} onChange={(horizon) => patch({ horizon })} />
          <ColorRow label="Valley mist" value={sky.below} onChange={(below) => patch({ below })} />
          <RangeControl
            label="Cloud cover"
            nested
            min={0}
            max={1}
            step={0.01}
            value={sky.clouds}
            ariaLabel="Cloud cover"
            display={`${Math.round(sky.clouds * 100)}%`}
            onChange={(clouds) => patch({ clouds })}
          />
          <RangeControl
            label="Peak height"
            nested
            min={0}
            max={40}
            step={1}
            value={tallest}
            ariaLabel="Peak height"
            display={`${tallest.toFixed(0)}°`}
            onChange={(height) =>
              // Scale every ring together, keeping their relative heights.
              patch({
                mountains: sky.mountains.map((range) => ({
                  ...range,
                  height: tallest > 0 ? (range.height / tallest) * height : height,
                })),
              })
            }
          />
          <RangeControl
            label="Snow line"
            nested
            min={0}
            max={1}
            step={0.01}
            value={sky.mountains[0]?.snowLine ?? 0.4}
            ariaLabel="Snow line"
            display={(sky.mountains[0]?.snowLine ?? 0.4).toFixed(2)}
            onChange={(snowLine) => patch({ mountains: sky.mountains.map((range) => ({ ...range, snowLine })) })}
          />
          <RangeControl
            label="Variation"
            nested
            min={0}
            max={99}
            step={1}
            value={sky.seed}
            ariaLabel="Sky variation seed"
            display={`#${sky.seed}`}
            onChange={(seed) => patch({ seed: Math.round(seed) })}
          />
          <SkyPanoramaControls sky={sky} patch={patch} />
          <SkyObjectControls sky={sky} patch={patch} />
          <CloudLayerControls sky={sky} patch={patch} />
        </>
      )}
    </>
  );
}

/** The file types a sky panorama may be, by extension. */
const PANORAMA_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", hdr: "image/vnd.radiance" };

/**
 * An imported sky (HALO_INFINITE_STYLE_ROADMAP.md I6): an equirectangular PNG,
 * JPEG or Radiance HDR in place of the procedural sky, turned and brightened.
 */
function SkyPanoramaControls({ sky, patch }: { sky: ProceduralSky; patch: (next: Partial<ProceduralSky>) => void }) {
  const [error, setError] = useState<string | null>(null);
  const panorama = sky.panorama ?? null;
  return (
    <>
      <div className={`${styles.groupLabel} ${styles.railSubLabel}`}>Imported sky</div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <label className={styles.toolBtn} title="An equirectangular (2:1) panorama — PNG, JPEG or Radiance .hdr — in place of the painted sky; it lights the scene and fills the reflections too">
          {panorama ? "Replace panorama…" : "Import panorama…"}
          <input
            type="file"
            accept=".png,.jpg,.jpeg,.hdr"
            style={{ display: "none" }}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              const mime = PANORAMA_TYPES[file.name.split(".").pop()?.toLowerCase() ?? ""];
              if (!mime) return setError("Use a .png, .jpg or .hdr panorama.");
              const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
              if (data.length > MAX_SKY_PANORAMA_CHARS) return setError("That panorama is too large (about 6 MB at most).");
              setError(null);
              patch({ panorama: { mime, data, exposure: 1, yaw: 0 } });
            }}
          />
        </label>
        {panorama && (
          <button type="button" className={styles.toolBtn} onClick={() => patch({ panorama: null })}>
            Back to the painted sky
          </button>
        )}
      </div>
      {error && <RailHint>{error}</RailHint>}
      {panorama && (
        <>
          <RangeControl label="Exposure" nested min={0.1} max={8} step={0.05} value={panorama.exposure} ariaLabel="Panorama exposure" display={`×${panorama.exposure.toFixed(2)}`} onChange={(exposure) => patch({ panorama: { ...panorama, exposure } })} />
          <RangeControl label="Turn" nested min={0} max={359} step={1} value={panorama.yaw} ariaLabel="Panorama turn" display={`${Math.round(panorama.yaw)}°`} onChange={(yaw) => patch({ panorama: { ...panorama, yaw } })} />
        </>
      )}
    </>
  );
}

/** Things in the sky at infinity (I6): a ring arching over the scene, a planet. */
function SkyObjectControls({ sky, patch }: { sky: ProceduralSky; patch: (next: Partial<ProceduralSky>) => void }) {
  const objects = sky.objects ?? [];
  const set = (next: SkyObject[]) => patch({ objects: next });
  const full = objects.length >= MAX_SKY_OBJECTS;
  return (
    <>
      <div className={`${styles.groupLabel} ${styles.railSubLabel}`}>In the sky</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button type="button" className={styles.toolBtn} disabled={full} onClick={() => set([...objects, { kind: "ring", axis: [0.8, 0.35, 0.45], width: 4, color: [0.5, 0.62, 0.55], edge: [0.86, 0.88, 0.92], haze: 0.5, seed: objects.length + 1 }])}>
          + Ring
        </button>
        <button type="button" className={styles.toolBtn} disabled={full} onClick={() => set([...objects, { kind: "planet", direction: [-0.6, 0.3, 0.7], radius: 6, color: [0.72, 0.62, 0.5], atmosphere: [0.6, 0.72, 0.95], seed: objects.length + 1 }])}>
          + Planet
        </button>
      </div>
      {objects.map((object, i) => {
        const update = (change: Partial<SkyObject>) => set(objects.map((o, j) => (j === i ? ({ ...o, ...change } as SkyObject) : o)));
        const remove = () => set(objects.filter((_, j) => j !== i));
        return (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className={styles.hudLabel}>{object.kind === "ring" ? "Ring" : "Planet"}</span>
              <button type="button" className={styles.toolBtn} onClick={remove} aria-label={`Remove ${object.kind} ${i + 1}`}>
                ×
              </button>
            </div>
            <ColorRow label="Colour" value={object.color} onChange={(color) => update({ color })} />
            {object.kind === "ring" ? (
              <>
                <RangeControl label="Width" nested min={0.5} max={15} step={0.25} value={object.width} ariaLabel="Ring width" display={`${object.width.toFixed(1)}°`} onChange={(width) => update({ width })} />
                <RangeControl label="Tilt" nested min={0} max={80} step={1} value={Math.round((Math.asin(Math.max(-1, Math.min(1, object.axis[1] / (Math.hypot(...object.axis) || 1)))) * 180) / Math.PI)} ariaLabel="Ring tilt" display={`${Math.round((Math.asin(Math.max(-1, Math.min(1, object.axis[1] / (Math.hypot(...object.axis) || 1)))) * 180) / Math.PI)}°`} onChange={(tilt) => {
                  const flat = Math.hypot(object.axis[0], object.axis[2]) || 1;
                  const t = (tilt * Math.PI) / 180;
                  update({ axis: [(object.axis[0] / flat) * Math.cos(t), Math.sin(t), (object.axis[2] / flat) * Math.cos(t)] });
                }} />
              </>
            ) : (
              <RangeControl label="Size" nested min={0.5} max={30} step={0.5} value={object.radius} ariaLabel="Planet size" display={`${object.radius.toFixed(1)}°`} onChange={(radius) => update({ radius })} />
            )}
          </div>
        );
      })}
    </>
  );
}

/** Cloud layers that drift on the wind (I6). */
function CloudLayerControls({ sky, patch }: { sky: ProceduralSky; patch: (next: Partial<ProceduralSky>) => void }) {
  const layers = sky.cloudLayers ?? [];
  const set = (next: SkyCloudLayer[]) => patch({ cloudLayers: next });
  return (
    <>
      <div className={`${styles.groupLabel} ${styles.railSubLabel}`}>Drifting clouds</div>
      <button
        type="button"
        className={styles.toolBtn}
        disabled={layers.length >= MAX_CLOUD_LAYERS}
        onClick={() => set([...layers, { cover: 0.35, scale: 0.35, wind: [0.02, 0.008], color: [0.94, 0.96, 0.99], opacity: 0.7, seed: 40 + layers.length }])}
      >
        + Cloud layer
      </button>
      {layers.map((layer, i) => {
        const update = (change: Partial<SkyCloudLayer>) => set(layers.map((l, j) => (j === i ? { ...l, ...change } : l)));
        const speed = Math.hypot(layer.wind[0], layer.wind[1]);
        const heading = Math.atan2(layer.wind[1], layer.wind[0]);
        return (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className={styles.hudLabel}>Layer {i + 1}</span>
              <button type="button" className={styles.toolBtn} onClick={() => set(layers.filter((_, j) => j !== i))} aria-label={`Remove cloud layer ${i + 1}`}>
                ×
              </button>
            </div>
            <RangeControl label="Cover" nested min={0} max={1} step={0.05} value={layer.cover} ariaLabel="Cloud cover" display={`${Math.round(layer.cover * 100)}%`} onChange={(cover) => update({ cover })} />
            <RangeControl label="Size" nested min={0.05} max={2} step={0.05} value={layer.scale} ariaLabel="Cloud size" display={layer.scale < 0.3 ? "large" : layer.scale < 0.8 ? "medium" : "small"} onChange={(scale) => update({ scale })} />
            <RangeControl label="Wind" nested min={0} max={0.2} step={0.005} value={speed} ariaLabel="Cloud wind speed" display={speed.toFixed(3)} onChange={(v) => update({ wind: [Math.cos(heading) * v, Math.sin(heading) * v] })} />
            <RangeControl label="Opacity" nested min={0} max={1} step={0.05} value={layer.opacity} ariaLabel="Cloud opacity" display={`${Math.round(layer.opacity * 100)}%`} onChange={(opacity) => update({ opacity })} />
          </div>
        );
      })}
    </>
  );
}

/** Distance fog over PBR geometry, faded in display space after tone mapping. */
function FogControls({ lighting, onChange }: LightingEditorProps & { lighting: SceneLighting }) {
  const fog = lighting.fog ?? null;
  const patch = (next: Partial<SceneFog>) => fog && onChange(setSceneFog(lighting, { ...fog, ...next }));
  return (
    <>
      <SegmentedControl
        label="Distance fog"
        ariaLabel="Distance fog"
        selected={fog ? "on" : "off"}
        onSelect={(id) =>
          onChange(
            setSceneFog(
              lighting,
              id === "on" ? (fog ?? { ...defaultSceneFog(), color: lighting.sky?.horizon ?? defaultSceneFog().color }) : null,
            ),
          )
        }
        options={[
          { id: "off", label: "Off" },
          { id: "on", label: "On" },
        ]}
      />
      {fog && (
        <>
          <ColorRow label="Fog colour" value={fog.color} onChange={(color) => patch({ color })} />
          <RangeControl
            label="Density"
            nested
            min={0}
            max={0.2}
            step={0.005}
            value={fog.density}
            ariaLabel="Fog density"
            display={fog.density.toFixed(3)}
            onChange={(density) => patch({ density })}
          />
          <RangeControl
            label="Start"
            nested
            min={0}
            max={50}
            step={0.5}
            value={fog.start}
            ariaLabel="Fog start distance"
            display={fog.start.toFixed(1)}
            onChange={(start) => patch({ start })}
          />
          <RangeControl
            label="Max"
            nested
            min={0}
            max={1}
            step={0.01}
            value={fog.max}
            ariaLabel="Fog maximum"
            display={`${Math.round(fog.max * 100)}%`}
            onChange={(max) => patch({ max })}
          />
          <FogLayerControls fog={fog} patch={patch} />
        </>
      )}
    </>
  );
}

/** A new fog volume: a low box of mist around the origin. */
function fogVolume(): FogVolume {
  return { min: [-4, -2, -4], max: [4, 1, 4], density: 0.4, falloff: 0.8 };
}

/**
 * The volumetric fog layers (HALO2_STYLE_ROADMAP.md, H7): height fog hugging
 * the ground, boxes of mist, and a glow toward the sun.
 */
function FogLayerControls({ fog, patch }: { fog: SceneFog; patch: (next: Partial<SceneFog>) => void }) {
  const height = fog.height ?? null;
  const glow = fog.glow ?? null;
  const volumes = fog.volumes ?? [];
  const setVolumes = (next: readonly FogVolume[]) => patch({ volumes: next.length > 0 ? next : undefined });
  const patchVolume = (index: number, next: Partial<FogVolume>) => setVolumes(volumes.map((v, i) => (i === index ? { ...v, ...next } : v)));
  return (
    <>
      <SegmentedControl
        label="Height fog"
        ariaLabel="Height fog"
        selected={height ? "on" : "off"}
        onSelect={(id) => patch({ height: id === "on" ? height ?? { base: 0, density: 0.08, falloff: 0.4 } : null })}
        options={[
          { id: "off", label: "Off" },
          { id: "on", label: "On" },
        ]}
      />
      {height && (
        <>
          <RangeControl
            label="Base height"
            nested
            min={-40}
            max={40}
            step={0.5}
            value={height.base}
            ariaLabel="Height fog base"
            display={height.base.toFixed(1)}
            onChange={(base) => patch({ height: { ...height, base } })}
          />
          <RangeControl
            label="Thickness"
            nested
            min={0}
            max={1}
            step={0.01}
            value={height.density}
            ariaLabel="Height fog density"
            display={height.density.toFixed(2)}
            onChange={(density) => patch({ height: { ...height, density } })}
          />
          <RangeControl
            label="Thins upward"
            nested
            min={0}
            max={3}
            step={0.05}
            value={height.falloff}
            ariaLabel="Height fog falloff"
            display={height.falloff.toFixed(2)}
            onChange={(falloff) => patch({ height: { ...height, falloff } })}
          />
        </>
      )}
      <SegmentedControl
        label="Sun glow"
        ariaLabel="Fog sun glow"
        selected={glow ? "on" : "off"}
        onSelect={(id) => patch({ glow: id === "on" ? glow ?? { color: [1, 0.9, 0.7], strength: 0.6 } : null })}
        options={[
          { id: "off", label: "Off" },
          { id: "on", label: "On" },
        ]}
      />
      {glow && (
        <>
          <ColorRow label="Glow colour" value={glow.color} onChange={(color) => patch({ glow: { ...glow, color } })} />
          <RangeControl
            label="Glow"
            nested
            min={0}
            max={2}
            step={0.05}
            value={glow.strength}
            ariaLabel="Fog sun glow strength"
            display={glow.strength.toFixed(2)}
            onChange={(strength) => patch({ glow: { ...glow, strength } })}
          />
        </>
      )}
      <div className={`${styles.groupLabel} ${styles.railSubLabel}`}>Fog volumes</div>
      {volumes.map((volume, index) => (
        <div key={index} style={{ marginBottom: 10 }}>
          <div className={styles.rangeRow} style={{ marginBottom: 4 }}>
            <span className={styles.hudLabel} style={{ flex: 1 }}>
              Volume {index + 1}
            </span>
            <button type="button" className={styles.toolBtn} aria-label={`Remove fog volume ${index + 1}`} onClick={() => setVolumes(volumes.filter((_, i) => i !== index))}>
              ✕
            </button>
          </div>
          <VectorRow label="Box min" value={volume.min} step={0.5} onChange={(min) => patchVolume(index, { min })} />
          <VectorRow label="Box max" value={volume.max} step={0.5} onChange={(max) => patchVolume(index, { max })} />
          <RangeControl
            label="Thickness"
            nested
            min={0}
            max={2}
            step={0.01}
            value={volume.density}
            ariaLabel={`Fog volume ${index + 1} density`}
            display={volume.density.toFixed(2)}
            onChange={(density) => patchVolume(index, { density })}
          />
          <RangeControl
            label="Thins upward"
            nested
            min={0}
            max={3}
            step={0.05}
            value={volume.falloff}
            ariaLabel={`Fog volume ${index + 1} falloff`}
            display={volume.falloff.toFixed(2)}
            onChange={(falloff) => patchVolume(index, { falloff })}
          />
        </div>
      ))}
      <button type="button" className={styles.toolBtn} disabled={volumes.length >= MAX_FOG_VOLUMES} onClick={() => setVolumes([...volumes, fogVolume()])}>
        <span className={styles.toolGlyph} aria-hidden>
          ▭
        </span>
        Add fog volume
      </button>
      <RailHint>
        Height fog is thick below its base and thins going up. A fog volume is a box of mist, densest at its floor: fit one to a chasm or a valley. Sun glow
        brightens the fog looking toward the sun. Up to {MAX_FOG_VOLUMES} volumes.
      </RailHint>
    </>
  );
}

/** Sun shafts (H7): beams from the sun through gaps in the scene. They need the sky dome. */
function ShaftControls({ lighting, onChange }: LightingEditorProps & { lighting: SceneLighting }) {
  const shafts = lighting.shafts ?? null;
  if (!lighting.sky && !shafts) return null;
  return (
    <>
      <SegmentedControl
        label="Sun shafts"
        ariaLabel="Sun shafts"
        selected={shafts ? "on" : "off"}
        onSelect={(id) => onChange(setSceneShafts(lighting, id === "on" ? shafts ?? defaultSunShafts() : null))}
        options={[
          { id: "off", label: "Off" },
          { id: "on", label: "On" },
        ]}
      />
      {shafts && (
        <>
          <RangeControl
            label="Brightness"
            nested
            min={0}
            max={2}
            step={0.05}
            value={shafts.strength}
            ariaLabel="Sun shaft brightness"
            display={shafts.strength.toFixed(2)}
            onChange={(strength) => onChange(setSceneShafts(lighting, { ...shafts, strength }))}
          />
          <RangeControl
            label="Length"
            nested
            min={0.05}
            max={1}
            step={0.05}
            value={shafts.length}
            ariaLabel="Sun shaft length"
            display={`${Math.round(shafts.length * 100)}%`}
            onChange={(length) => onChange(setSceneShafts(lighting, { ...shafts, length }))}
          />
          <RailHint>Beams from the sun through gaps between walls and towers, in first-person views over the sky dome.</RailHint>
        </>
      )}
    </>
  );
}

/**
 * Reflection probes (HALO2_STYLE_ROADMAP.md, H2): each captures the scene from
 * its point when the scene loads, and shiny surfaces inside its box reflect
 * that — lined up with the box's walls — instead of the sky.
 */
function ProbeControls({ lighting, onChange }: LightingEditorProps & { lighting: SceneLighting }) {
  const probes = lighting.probes ?? [];
  const set = (next: readonly ReflectionProbe[]) => onChange(setSceneProbes(lighting, next));
  const patch = (index: number, next: Partial<ReflectionProbe>) => set(probes.map((p, i) => (i === index ? { ...p, ...next } : p)));
  return (
    <>
      <div className={`${styles.groupLabel} ${styles.railSubLabel}`}>Reflection probes</div>
      {probes.map((probe, index) => (
        <div key={index} style={{ marginBottom: 10 }}>
          <div className={styles.rangeRow} style={{ marginBottom: 4 }}>
            <input
              type="text"
              value={probe.name}
              aria-label={`Probe ${index + 1} name`}
              onChange={(e) => patch(index, { name: e.target.value.slice(0, 64) })}
              style={{ flex: 1, minWidth: 0, padding: "4px 6px", borderRadius: 6 }}
            />
            <button type="button" className={styles.toolBtn} aria-label={`Remove probe ${index + 1}`} onClick={() => set(probes.filter((_, i) => i !== index))}>
              ✕
            </button>
          </div>
          <VectorRow label="Capture point" value={probe.position} step={0.5} onChange={(position) => patch(index, { position })} />
          <VectorRow label="Box min" value={probe.min} step={0.5} onChange={(min) => patch(index, { min })} />
          <VectorRow label="Box max" value={probe.max} step={0.5} onChange={(max) => patch(index, { max })} />
        </div>
      ))}
      <button
        type="button"
        className={styles.toolBtn}
        disabled={probes.length >= MAX_REFLECTION_PROBES}
        onClick={() => set([...probes, reflectionProbeAt([0, 2, 0], [8, 4, 8], `probe ${probes.length + 1}`)])}
      >
        <span className={styles.toolGlyph} aria-hidden>
          ◎
        </span>
        Add reflection probe
      </button>
      <RailHint>
        Shiny surfaces inside a probe&apos;s box reflect the scene around the capture point instead of the sky. Fit the box to the room. Up to{" "}
        {MAX_REFLECTION_PROBES}; the smallest box wins where they overlap.
      </RailHint>
    </>
  );
}

function directionalLight(): SceneLight {
  return { kind: "directional", direction: [-0.4, 0.7, 0.5], color: [1, 1, 1], intensity: 1 };
}

function spotLight(): SceneLight {
  return { kind: "spot", position: [0, 4, 0], direction: [0, -1, 0], color: [1, 0.95, 0.85], intensity: 3, range: 12, innerAngle: 20, outerAngle: 30 };
}

function pointLight(): SceneLight {
  return { kind: "point", position: [0, 2, 0], color: [1, 0.9, 0.8], intensity: 2, range: 10 };
}
