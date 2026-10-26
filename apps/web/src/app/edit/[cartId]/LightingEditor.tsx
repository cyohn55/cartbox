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
  DEFAULT_WIND,
  defaultSunShafts,
  infiniteDaylightLighting,
  INFINITE_TINTS,
  setSceneShafts,
  MAX_FOG_VOLUMES,
  type FogVolume,
  patchSceneLighting,
  removeSceneLight,
  setSceneFog,
  setSceneProbes,
  setSceneAutoExposure,
  setScenePostVolumes,
  DEFAULT_AUTO_EXPOSURE,
  type AutoExposure,
  type PostVolume,
  reflectionProbeAt,
  MAX_REFLECTION_PROBES,
  setSceneSky,
  setSceneUnits,
  ev100ToExposure,
  exposureToEv100,
  lightUnit,
  luxToUnits,
  nitsToUnits,
  unitsToLux,
  unitsToNits,
  withLightFalloff,
  WHITE_TEMPERATURE,
  updateSceneEnvironment,
  updateSceneLight,
  type ProceduralSky,
  type AtmosphereSettings,
  type VolumetricFogSettings,
  type DynamicGiSettings,
  type ScreenSpaceGiSettings,
  decodeExr,
  decodeKtx2Hdr,
  encodeRadianceHdr,
  iesProfile,
  type PhysicalCameraSettings,
  type ExposureMode,
  type MeteringMode,
  cameraEv100,
  resolvePhysicalCamera,
  type ReflectionProbe,
  type SceneFog,
  type SceneLight,
  type SceneLighting,
  type ToneMapOperator,
} from "@cartbox/editor";

import { TINT_PALETTE } from "@cartbox/player";

import styles from "./editor.module.css";
import { ChannelMask, PhysicalRange, RailGroup, RailHint, RangeControl, SegmentedControl } from "./railControls";

interface LightingEditorProps {
  lighting: SceneLighting | null;
  onChange: (lighting: SceneLighting | null) => void;
}

type Rgb = readonly [number, number, number];

/** What each tone-mapping curve (F4d) does, for the hint under the choice. */
const TONEMAPPER_HINTS: Record<Exclude<ToneMapOperator, "filmic">, string> = {
  aces: "ACES: the reference film look, highlights desaturating toward white.",
  agx: "AgX: saturated lights go to white without skewing their hue.",
  neutral: "Neutral: colours under about 0.76 show as authored; only highlights roll off.",
};

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

const AREA_SHAPE_LABEL: Record<NonNullable<SceneLight["shape"]>, string> = { rect: "Panel", disk: "Disk", tube: "Tube" };

/** An area light's shape, size and frame (F2e-2). */
function AreaShapeControls({ light, index, onPatch }: { light: SceneLight; index: number; onPatch: (patch: Partial<SceneLight>) => void }) {
  const shape = light.shape ?? "rect";
  const [w, h] = light.size ?? [1, 0.5];
  return (
    <>
      <SegmentedControl
        label="Shape"
        ariaLabel={`Light ${index + 1} shape`}
        selected={shape}
        onSelect={(next) => onPatch({ shape: next, size: next === "disk" ? [w, w] : next === "tube" ? [w, Math.min(h, 0.1)] : [w, h] })}
        options={[
          { id: "rect", label: "Panel", hint: "A glowing rectangle: a window, a light panel, a screen. It lights the side it faces" },
          { id: "disk", label: "Disk", hint: "A glowing disk: a downlight, a round lamp. It lights the side it faces" },
          { id: "tube", label: "Tube", hint: "A glowing capsule: a strip light or neon. It lights all round" },
        ]}
      />
      <RangeControl
        label={shape === "disk" ? "Diameter" : shape === "tube" ? "Length" : "Width"}
        nested
        min={0.05}
        max={10}
        step={0.05}
        value={w}
        ariaLabel={`Light ${index + 1} ${shape === "disk" ? "diameter" : shape === "tube" ? "length" : "width"}`}
        display={`${w.toFixed(2)} m`}
        onChange={(v) => onPatch({ size: shape === "disk" ? [v, v] : [v, h] })}
      />
      {shape !== "disk" && (
        <RangeControl
          label={shape === "tube" ? "Thickness" : "Height"}
          nested
          min={shape === "tube" ? 0.01 : 0.05}
          max={shape === "tube" ? 1 : 10}
          step={0.01}
          value={h}
          ariaLabel={`Light ${index + 1} ${shape === "tube" ? "thickness" : "height"}`}
          display={`${h.toFixed(2)} m`}
          onChange={(v) => onPatch({ size: [w, v] })}
        />
      )}
      {shape !== "tube" && <VectorRow label="Faces" step={0.1} value={light.direction ?? [0, -1, 0]} onChange={(direction) => onPatch({ direction })} />}
      <VectorRow label={shape === "tube" ? "Along" : "Width along"} step={0.1} value={light.tangent ?? [1, 0, 0]} onChange={(tangent) => onPatch({ tangent })} />
    </>
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
        <button type="button" className={styles.toolBtn} onClick={() => onChange(infiniteDaylightLighting())} title="A warm, strong noon sun, a bright blue sky fill, a clear dome and saturated team colours (pair it with the Infinite grading LUT in FX)">
          <span className={styles.toolGlyph} aria-hidden>
            ☀
          </span>
          Infinite daylight
        </button>
        <RailHint>Modern-tier lighting & skybox for the 3D scene. Off by default — capped tiers are unaffected.</RailHint>
      </RailGroup>
    );
  }

  const env = lighting.environment;
  const physical = lighting.units === "physical";

  return (
    <RailGroup label="Lighting" advanced defaultOpen>
      <div className={`${styles.groupLabel} ${styles.railSubLabel}`}>Skybox gradient</div>
      <ColorRow label="Sky" value={env.sky} onChange={(sky) => onChange(updateSceneEnvironment(lighting, { sky }))} />
      <ColorRow label="Horizon" value={env.horizon} onChange={(horizon) => onChange(updateSceneEnvironment(lighting, { horizon }))} />
      <ColorRow label="Ground" value={env.ground} onChange={(ground) => onChange(updateSceneEnvironment(lighting, { ground }))} />
      <SegmentedControl
        label="Units"
        ariaLabel="Light units"
        selected={physical ? "physical" : "renderer"}
        onSelect={(id) => onChange(setSceneUnits(lighting, id === "physical"))}
        options={[
          { id: "renderer", label: "Relative", hint: "The renderer's own units: 1 is the brightness the scene was authored in" },
          { id: "physical", label: "Physical", hint: "Lux for suns, candela for inverse-square lights, nits for the sky and fill, EV100 for exposure. The scene looks the same either way" },
        ]}
      />
      {physical ? (
        <PhysicalRange label="Sky luminance" unit="nt" min={1} max={200000} value={unitsToNits(env.intensity)} onChange={(nits) => onChange(updateSceneEnvironment(lighting, { intensity: nitsToUnits(nits) }))} />
      ) : (
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
      )}

      <SkyDomeControls lighting={lighting} onChange={onChange} />
      <FogControls lighting={lighting} onChange={onChange} />
      <DynamicGiControls lighting={lighting} onChange={onChange} />
      <CameraControls lighting={lighting} onChange={onChange} />
      <WindControls lighting={lighting} onChange={onChange} />
      <ShaftControls lighting={lighting} onChange={onChange} />
      <ProbeControls lighting={lighting} onChange={onChange} />
      <PostVolumeControls lighting={lighting} onChange={onChange} />
      <TintControls lighting={lighting} onChange={onChange} />

      {physical ? (
        <PhysicalRange label="Ambient fill" unit="nt" min={10} max={unitsToNits(1)} value={unitsToNits(lighting.ambient)} onChange={(nits) => onChange(patchSceneLighting(lighting, { ambient: Math.min(1, nitsToUnits(nits)) }))} />
      ) : (
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
      )}

      <SegmentedControl
        label="Tone mapping"
        ariaLabel="Tone mapping"
        selected={lighting.tonemap ? (lighting.tonemapper ?? "filmic") : "off"}
        onSelect={(id) =>
          onChange(
            id === "off"
              ? patchSceneLighting(lighting, { tonemap: false })
              : patchSceneLighting(lighting, { tonemap: true, tonemapper: id === "filmic" ? undefined : (id as ToneMapOperator) }),
          )
        }
        options={[
          { id: "off", label: "Off" },
          { id: "filmic", label: "Filmic" },
          { id: "aces", label: "ACES" },
          { id: "agx", label: "AgX" },
          { id: "neutral", label: "Neutral" },
        ]}
      />
      {lighting.tonemap && lighting.tonemapper && lighting.tonemapper !== "filmic" && (
        <RailHint>{TONEMAPPER_HINTS[lighting.tonemapper]} The AAA tier maps through it; every other tier keeps Filmic.</RailHint>
      )}
      {lighting.tonemap && (
        <>
          <SegmentedControl
            label="AAA curve"
            ariaLabel="AAA curve"
            selected={lighting.authoredCurve ? "authored" : "physical"}
            onSelect={(id) => onChange(patchSceneLighting(lighting, { authoredCurve: id === "authored" ? true : undefined }))}
            options={[
              { id: "physical", label: "Physical" },
              { id: "authored", label: "As authored" },
            ]}
          />
          <RailHint>
            {lighting.authoredCurve
              ? "The AAA tier maps the curve as every other tier's shader does: fully lit surfaces show as tuned, but on linear lighting the shade lifts further than elsewhere."
              : "The AAA tier maps the curve on the light itself, as a linear pipeline does: shadows read deeper and highlights brighter than on the other tiers."}
          </RailHint>
        </>
      )}
      {lighting.tonemap &&
        (physical ? (
          <RangeControl
            label="Exposure"
            nested
            min={-2}
            max={20}
            step={0.1}
            value={Math.round(exposureToEv100(lighting.exposure) * 10) / 10}
            ariaLabel="Exposure EV100"
            display={`EV ${exposureToEv100(lighting.exposure).toFixed(1)}`}
            onChange={(ev) => onChange(patchSceneLighting(lighting, { exposure: ev100ToExposure(ev) }))}
          />
        ) : (
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
        ))}
      {physical && !lighting.tonemap && <RailHint>Exposure (EV100) needs tone mapping on; without it the scene shows at EV 15, a sunny day.</RailHint>}
      {lighting.tonemap && <AutoExposureControls lighting={lighting} onChange={onChange} />}

      <SegmentedControl
        label="Shadows"
        ariaLabel="Shadows"
        selected={lighting.shadows ? (lighting.softShadows ? "soft" : "on") : "off"}
        onSelect={(id) => onChange(patchSceneLighting(lighting, { shadows: id !== "off", softShadows: id === "soft" ? true : undefined }))}
        options={[
          { id: "off", label: "Off" },
          { id: "on", label: "On" },
          { id: "soft", label: "Soft", hint: "Wide, soft penumbrae for a daylight sun (16 shadow-map taps a pixel instead of 4; on the AAA tier, a sun four times the real one's size)" },
        ]}
      />
      {lighting.shadows && (
        <>
          <RangeControl
            label="AAA shadow reach"
            nested
            min={0}
            max={500}
            step={5}
            value={lighting.shadowDistance ?? 0}
            display={lighting.shadowDistance ? `${lighting.shadowDistance} m` : "Fit scene"}
            onChange={(value) => onChange(patchSceneLighting(lighting, { shadowDistance: value >= 5 ? value : undefined }))}
            ariaLabel="AAA shadow reach"
          />
          <RailHint>How far from the camera the AAA tier's four sun cascades reach: nearer is sharper. The other tiers' one map covers the whole scene.</RailHint>
        </>
      )}

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
              <span aria-hidden>{light.kind === "directional" ? "☀" : light.kind === "spot" ? "◢" : light.kind === "area" ? "▭" : "●"}</span>
              <span aria-hidden style={{ width: 10, height: 10, borderRadius: 5, flex: "0 0 auto", background: `rgb(${light.color.map((c) => Math.round(c * 255)).join(",")})` }} />
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {light.kind === "directional" ? "Sun" : light.kind === "spot" ? "Spot" : light.kind === "area" ? AREA_SHAPE_LABEL[light.shape ?? "rect"] : "Point"} · {where}
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
                  {
                    // An area light's shape and frame go when it becomes another kind.
                    ...(kind === "area" ? {} : { shape: undefined, size: undefined, tangent: undefined }),
                    ...(kind === "directional"
                      ? { kind, direction: light.direction ?? [0.4, 0.8, 0.6], position: undefined, range: undefined, innerAngle: undefined, outerAngle: undefined, falloff: undefined }
                      : kind === "spot"
                        ? { kind, position: light.position ?? [0, 3, 0], range: light.range || 12, direction: [0, -1, 0], innerAngle: light.innerAngle ?? 20, outerAngle: light.outerAngle ?? 30 }
                        : kind === "area"
                          ? { kind, shape: "rect", size: [1, 0.5], position: light.position ?? [0, 3, 0], direction: [0, -1, 0], tangent: [1, 0, 0], range: light.range || 12, innerAngle: undefined, outerAngle: undefined, falloff: undefined, castShadows: undefined }
                          : { kind, position: light.position ?? [0, 1, 0], range: light.range ?? 0, direction: undefined, innerAngle: undefined, outerAngle: undefined }),
                  },
                ),
              )
            }
            options={[
              { id: "directional", label: "Sun" },
              { id: "point", label: "Point" },
              { id: "spot", label: "Spot" },
              { id: "area", label: "Area", hint: "A glowing rectangle, disk or tube: soft, shaped highlights and shading on the AAA tier, and a light from its face elsewhere" },
            ]}
          />
          <ColorRow
            label="Colour"
            value={light.color}
            onChange={(color) => onChange(updateSceneLight(lighting, index, { color }))}
          />
          <SegmentedControl
            label="Temperature"
            ariaLabel={`Light ${index + 1} temperature`}
            selected={light.temperature === undefined ? "off" : "kelvin"}
            onSelect={(v) => onChange(updateSceneLight(lighting, index, { temperature: v === "kelvin" ? light.temperature ?? WHITE_TEMPERATURE : undefined }))}
            options={[
              { id: "off", label: "Colour only" },
              { id: "kelvin", label: "Kelvin", hint: "A black body's colour over the light's: 1900 K a candle, 2700 K a household bulb, 5500 K noon sun, 6500 K white, 10 000 K blue sky. Its brightness stays" },
            ]}
          />
          {light.temperature !== undefined && (
            <RangeControl
              label="Kelvin"
              nested
              min={1700}
              max={12000}
              step={100}
              value={light.temperature}
              ariaLabel={`Light ${index + 1} kelvin`}
              display={`${light.temperature} K`}
              onChange={(temperature) => onChange(updateSceneLight(lighting, index, { temperature }))}
            />
          )}
          <ChannelMask
            label="Lights channels"
            value={light.channels ?? 1}
            allowNone
            onChange={(channels) => onChange(updateSceneLight(lighting, index, { channels: channels === 1 ? undefined : channels }))}
          />
          {physical && light.kind === "area" ? (
            <PhysicalRange
              label="Luminance"
              unit="nt"
              min={1}
              max={1e8}
              value={unitsToNits(light.intensity)}
              onChange={(value) => onChange(updateSceneLight(lighting, index, { intensity: nitsToUnits(value) }))}
            />
          ) : physical ? (
            <PhysicalRange
              label={lightUnit(light) === "cd" ? "Luminous intensity" : light.kind === "directional" ? "Illuminance" : "Illuminance at the light"}
              unit={lightUnit(light)}
              min={lightUnit(light) === "cd" ? 0.1 : 0.01}
              max={lightUnit(light) === "cd" ? 1e7 : 1e6}
              value={unitsToLux(light.intensity)}
              onChange={(value) => onChange(updateSceneLight(lighting, index, { intensity: luxToUnits(value) }))}
            />
          ) : (
            <RangeControl
              label="Intensity"
              nested
              min={0}
              max={8}
              step={0.1}
              value={light.intensity}
              ariaLabel={`Light ${index + 1} intensity`}
              display={`${light.intensity.toFixed(light.intensity < 0.1 && light.intensity > 0 ? 4 : 1)}×`}
              onChange={(intensity) => onChange(updateSceneLight(lighting, index, { intensity }))}
            />
          )}
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
              {light.kind === "area" && (
                <AreaShapeControls light={light} index={index} onPatch={(patch) => onChange(updateSceneLight(lighting, index, patch))} />
              )}
              {light.kind !== "area" && (
              <>
              <SegmentedControl
                label="Falloff"
                ariaLabel={`Light ${index + 1} falloff`}
                selected={light.falloff === "inverseSquare" ? "square" : "fade"}
                onSelect={(v) => onChange({ ...lighting, lights: lighting.lights.map((l, i) => (i === index ? withLightFalloff(l, v === "square") : l)) })}
                options={[
                  { id: "fade", label: "Fade", hint: "Flat near the light, fading to nothing at its range" },
                  { id: "square", label: "Inverse square", hint: "Physical: dims as 1/distance² (metres), so its intensity is in candela. Switching keeps it as bright halfway to its range" },
                ]}
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
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <label className={styles.toolBtn} title="A real fixture's light distribution (an IESNA LM-63 .ies file): the AAA tier shapes this light by it about its axis">
                  {light.ies ? "Replace IES…" : "IES profile…"}
                  <input
                    type="file"
                    accept=".ies"
                    style={{ display: "none" }}
                    aria-label={`Light ${index + 1} IES profile`}
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (!file) return;
                      try {
                        onChange(updateSceneLight(lighting, index, { ies: iesProfile(await file.text()) }));
                      } catch {
                        // Not a profile: leave the light as it was.
                      }
                    }}
                  />
                </label>
                {light.ies && (
                  <button type="button" className={styles.toolBtn} onClick={() => onChange(updateSceneLight(lighting, index, { ies: undefined }))}>
                    {light.ies.label ? `${light.ies.label} ✕` : "Clear IES ✕"}
                  </button>
                )}
              </div>
              </>
              )}
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

      <button type="button" className={styles.toolBtn} onClick={() => onChange({ ...infiniteDaylightLighting(), probes: lighting.probes, lightProbes: lighting.lightProbes })} title="Replace the rig with the Infinite daylight preset (keeps the probes)">
        <span className={styles.toolGlyph} aria-hidden>
          ☀
        </span>
        Infinite daylight
      </button>
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

/** The palette's names, index-aligned with the runtime's tint palette. */
const TINT_NAMES = ["", "Red", "Blue", "Green", "Orange", "Purple", "Gold", "Brown", "Pink", "White", "Black", "Steel", "Teal", "Olive", "Crimson", "Sage"];

/**
 * Team colours (I8): the armour palette carts tint their soldiers from, per
 * scene — the built-in colours, or saturated ones that hold up under a bright rig.
 */
function TintControls({ lighting, onChange }: LightingEditorProps & { lighting: SceneLighting }) {
  const tints = lighting.tints ?? [];
  const set = (k: number, rgb: Rgb | null) => {
    const next = Array.from({ length: Math.max(tints.length, k + 1) }, (_, i) => (i === k ? rgb : (tints[i] ?? null)));
    onChange(next.some((t) => t !== null) ? { ...lighting, tints: next } : { ...lighting, tints: undefined });
  };
  return (
    <details style={{ marginTop: 8 }}>
      <summary style={{ cursor: "pointer", fontSize: 12 }}>Team colours{lighting.tints ? " · custom" : ""}</summary>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 4, marginTop: 4 }}>
        {TINT_NAMES.slice(1).map((name, i) => {
          const k = i + 1;
          const value = tints[k] ?? TINT_PALETTE[k] ?? [1, 1, 1];
          return (
            <input
              key={k}
              type="color"
              aria-label={`${name} armour colour`}
              title={`${k} ${name}${tints[k] ? "" : " (built-in)"}`}
              value={toHex(value)}
              onChange={(event) => set(k, fromHex(event.target.value))}
              style={{ width: "100%", height: 22, padding: 0, border: "none", background: "none", opacity: tints[k] ? 1 : 0.55 }}
            />
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
        <button type="button" className={styles.toolBtn} onClick={() => onChange({ ...lighting, tints: INFINITE_TINTS })}>
          Saturated
        </button>
        {lighting.tints && (
          <button type="button" className={styles.toolBtn} onClick={() => onChange({ ...lighting, tints: undefined })}>
            Built-in
          </button>
        )}
      </div>
      <RailHint>The colours a cart&apos;s armour tints pick from in this scene (red and blue are the teams).</RailHint>
    </details>
  );
}

/**
 * The procedural sky dome: a baked panorama (clouds + mountain rings) drawn
 * behind a first-person view and used as the image-based light, or a physical
 * atmosphere (AAA_FIDELITY_ROADMAP.md F5a) lit by the key light. The rig stores
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
        selected={!sky ? "off" : sky.atmosphere ? "physical" : "on"}
        onSelect={(id) => {
          if (id === "off") return onChange(setSceneSky(lighting, null));
          const { atmosphere: _atmosphere, ...painted } = sky ?? defaultProceduralSky();
          onChange(setSceneSky(lighting, id === "physical" ? { ...painted, atmosphere: sky?.atmosphere ?? {} } : painted));
        }}
        options={[
          { id: "off", label: "Gradient" },
          { id: "on", label: "Mountains" },
          { id: "physical", label: "Physical", hint: "A physically based atmosphere lit by the key light, which it tints by the air between: blue at noon, orange at sunset. It lights the scene and the bake too" },
        ]}
      />
      {sky?.atmosphere && <AtmosphereControls settings={sky.atmosphere} patch={(atmosphere) => patch({ atmosphere })} />}
      {sky && !sky.atmosphere && (
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

/** A physical atmosphere's settings (F5a): each against Earth's, which is where they start. */
function AtmosphereControls({ settings, patch }: { settings: AtmosphereSettings; patch: (next: AtmosphereSettings) => void }) {
  const set = (key: keyof AtmosphereSettings, value: number) => patch({ ...settings, [key]: value });
  return (
    <>
      <RailHint>The sun is the key light: aim it and set its brightness under Lights. 1 is Earth&apos;s for each of these.</RailHint>
      <RangeControl label="Air (Rayleigh)" nested min={0} max={4} step={0.05} value={settings.rayleigh ?? 1} ariaLabel="Rayleigh scattering" display={`×${(settings.rayleigh ?? 1).toFixed(2)}`} onChange={(v) => set("rayleigh", v)} />
      <RangeControl label="Haze (Mie)" nested min={0} max={20} step={0.1} value={settings.mie ?? 1} ariaLabel="Mie scattering" display={`×${(settings.mie ?? 1).toFixed(1)}`} onChange={(v) => set("mie", v)} />
      <RangeControl label="Ozone" nested min={0} max={4} step={0.05} value={settings.ozone ?? 1} ariaLabel="Ozone" display={`×${(settings.ozone ?? 1).toFixed(2)}`} onChange={(v) => set("ozone", v)} />
      <RangeControl label="Sun glow" nested min={0} max={0.95} step={0.01} value={settings.mieAnisotropy ?? 0.8} ariaLabel="Mie anisotropy" display={(settings.mieAnisotropy ?? 0.8).toFixed(2)} onChange={(v) => set("mieAnisotropy", v)} />
      <RangeControl label="Ground albedo" nested min={0} max={1} step={0.01} value={settings.groundAlbedo ?? 0.3} ariaLabel="Ground albedo" display={(settings.groundAlbedo ?? 0.3).toFixed(2)} onChange={(v) => set("groundAlbedo", v)} />
      <RangeControl label="Altitude" nested min={0} max={8000} step={50} value={settings.altitude ?? 0} ariaLabel="Altitude" display={`${Math.round(settings.altitude ?? 0)} m`} onChange={(v) => set("altitude", v)} />
      <RangeControl label="Sun size" nested min={0.1} max={5} step={0.05} value={settings.sunSize ?? 0.545} ariaLabel="Sun angular diameter" display={`${(settings.sunSize ?? 0.545).toFixed(2)}°`} onChange={(v) => set("sunSize", v)} />
      <RangeControl label="Aerial distance" nested min={0} max={50} step={0.5} value={settings.aerialScale ?? 1} ariaLabel="Aerial perspective distance scale" display={(settings.aerialScale ?? 1) === 0 ? "Off" : `×${(settings.aerialScale ?? 1).toFixed(1)}`} onChange={(v) => set("aerialScale", v)} />
      <RangeControl label="Moon" nested min={0} max={1000} step={1} value={settings.moon ?? 1} ariaLabel="Moon brightness" display={(settings.moon ?? 1) === 0 ? "None" : `×${Math.round(settings.moon ?? 1)}`} onChange={(v) => set("moon", v)} />
      <RangeControl label="Stars" nested min={0} max={1000} step={1} value={settings.stars ?? 1} ariaLabel="Star brightness" display={(settings.stars ?? 1) === 0 ? "None" : `×${Math.round(settings.stars ?? 1)}`} onChange={(v) => set("stars", v)} />
      <RailHint>The moon stands opposite the sun (full) and lights the scene once the sun has set; ×1 is the real moon and stars, which want eye adaptation (or a raised exposure) to be seen.</RailHint>
      <RailHint>Aerial distance hazes the scene by the air between it and the eye (AAA tier). At ×1 a metre is a metre, so only kilometres haze over; more lays a landscape&apos;s haze over a small map.</RailHint>
    </>
  );
}

/** The file types a sky panorama may be, by extension. */
const PANORAMA_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", hdr: "image/vnd.radiance", exr: "image/x-exr", ktx2: "image/ktx2" };

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
            accept=".png,.jpg,.jpeg,.hdr,.exr,.ktx2"
            style={{ display: "none" }}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              const mime = PANORAMA_TYPES[file.name.split(".").pop()?.toLowerCase() ?? ""];
              if (!mime) return setError("Use a .png, .jpg, .hdr, .exr or float .ktx2 panorama.");
              let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
              let stored = mime;
              // OpenEXR and float KTX2 (F9d) travel as the Radiance HDR the sky reads.
              if (mime === "image/x-exr" || mime === "image/ktx2") {
                try {
                  bytes = encodeRadianceHdr(mime === "image/x-exr" ? await decodeExr(bytes) : decodeKtx2Hdr(bytes));
                  stored = "image/vnd.radiance";
                } catch (e) {
                  return setError(e instanceof Error ? e.message : "That panorama couldn't be read.");
                }
              }
              const data = bytesToBase64(bytes);
              if (data.length > MAX_SKY_PANORAMA_CHARS) return setError("That panorama is too large (about 6 MB at most).");
              setError(null);
              patch({ panorama: { mime: stored, data, exposure: 1, yaw: 0 } });
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

/** The scene's wind (B6): it sways foliage layers that have Sway set (Terrain panel). */
function WindControls({ lighting, onChange }: LightingEditorProps & { lighting: SceneLighting }) {
  const wind = lighting.wind ?? null;
  const patch = (next: Partial<NonNullable<SceneLighting["wind"]>>) => wind && onChange(patchSceneLighting(lighting, { wind: { ...wind, ...next } }));
  const degrees = wind ? Math.round((wind.direction * 180) / Math.PI) : 0;
  return (
    <>
      <SegmentedControl
        label="Wind"
        ariaLabel="Wind"
        selected={wind ? "on" : "off"}
        onSelect={(id) => onChange(patchSceneLighting(lighting, { wind: id === "on" ? (wind ?? DEFAULT_WIND) : null }))}
        options={[
          { id: "off", label: "Still" },
          { id: "on", label: "Breeze" },
        ]}
      />
      {wind && (
        <>
          <RangeControl label="Strength" nested min={0} max={2} step={0.05} value={wind.strength} ariaLabel="Wind strength" display={wind.strength.toFixed(2)} onChange={(strength) => patch({ strength })} />
          <RangeControl label="Gusts" nested min={0} max={1} step={0.05} value={wind.gust} ariaLabel="Wind gusts" display={`${Math.round(wind.gust * 100)}%`} onChange={(gust) => patch({ gust })} />
          <RangeControl label="Direction" nested min={-180} max={180} step={5} value={degrees} ariaLabel="Wind direction" display={`${degrees}°`} onChange={(deg) => patch({ direction: (deg * Math.PI) / 180 })} />
        </>
      )}
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
          <VolumetricFogControls fog={fog} patch={patch} />
        </>
      )}
    </>
  );
}

/**
 * Real-time GI (AAA_FIDELITY_ROADMAP.md F3e): on the AAA tier a probe volume
 * traced and relit every frame, so moving lights and a time of day bounce
 * without a bake; light-mapped surfaces take it too while it is on.
 */
function DynamicGiControls({ lighting, onChange }: LightingEditorProps & { lighting: SceneLighting }) {
  const gi = lighting.dynamicGi ?? null;
  const set = (next: Partial<DynamicGiSettings>) => gi && onChange({ ...lighting, dynamicGi: { ...gi, ...next } });
  // Screen-space GI (F3e-2): on unless the rig turns it off.
  const ssgi = lighting.screenSpaceGi ?? null;
  const ssgiOn = ssgi?.enabled !== false;
  const setSsgi = (next: Partial<ScreenSpaceGiSettings>) => onChange({ ...lighting, screenSpaceGi: { ...(ssgi ?? {}), ...next } });
  return (
    <>
      <SegmentedControl
        label="Global illumination (AAA)"
        ariaLabel="Global illumination"
        selected={gi ? "live" : "baked"}
        onSelect={(id) => onChange({ ...lighting, dynamicGi: id === "live" ? (gi ?? {}) : null })}
        options={[
          { id: "baked", label: "Baked" },
          { id: "live", label: "Real-time", hint: "On the AAA tier, probes are traced through the still scene every frame, so light that moves bounces without a bake. A baked probe volume is its starting point; light maps step aside while it is on" },
        ]}
      />
      {gi && (
        <>
          <RangeControl label="Rays per probe" nested min={16} max={256} step={16} value={gi.rays ?? 64} ariaLabel="GI rays per probe" display={`${gi.rays ?? 64}`} onChange={(rays) => set({ rays })} />
          <RangeControl label="Steadiness" nested min={0.5} max={0.99} step={0.01} value={gi.hysteresis ?? 0.97} ariaLabel="GI hysteresis" display={(gi.hysteresis ?? 0.97).toFixed(2)} onChange={(hysteresis) => set({ hysteresis })} />
          <RangeControl label="Probe spacing" nested min={1} max={10} step={0.5} value={gi.spacing ?? 3} ariaLabel="GI probe spacing" display={`${(gi.spacing ?? 3).toFixed(1)} m`} onChange={(spacing) => set({ spacing })} />
        </>
      )}
      <SegmentedControl
        label="Screen-space GI (AAA)"
        ariaLabel="Screen-space GI"
        selected={ssgiOn ? "on" : "off"}
        onSelect={(id) => setSsgi({ enabled: id === "on" })}
        options={[
          { id: "off", label: "Off" },
          { id: "on", label: "On", hint: "On the AAA tier, rays across the screen bring back the light nearby surfaces sent last frame, so a lit wall bleeds its colour onto the floor beside it. It fills in the detail the probes are too coarse to hold" },
        ]}
      />
      {ssgiOn && (
        <>
          <RangeControl label="Reach" nested min={0.5} max={16} step={0.5} value={ssgi?.radius ?? 4} ariaLabel="Screen-space GI reach" display={`${(ssgi?.radius ?? 4).toFixed(1)} m`} onChange={(radius) => setSsgi({ radius })} />
          <RangeControl label="Strength" nested min={0} max={4} step={0.05} value={ssgi?.intensity ?? 1} ariaLabel="Screen-space GI strength" display={`×${(ssgi?.intensity ?? 1).toFixed(2)}`} onChange={(intensity) => setSsgi({ intensity })} />
        </>
      )}
    </>
  );
}

/**
 * The physical camera (AAA_FIDELITY_ROADMAP.md F4c): aperture, shutter and ISO
 * set the exposure (manual) or eye adaptation's metering and compensation
 * (auto), and on the AAA tier drive bokeh depth of field and motion blur.
 */
function CameraControls({ lighting, onChange }: LightingEditorProps & { lighting: SceneLighting }) {
  const cam = lighting.camera ?? null;
  const on = cam !== null;
  const set = (next: Partial<PhysicalCameraSettings>) => onChange({ ...lighting, camera: { ...(cam ?? {}), ...next } });
  const c = resolvePhysicalCamera(cam);
  const ev = cameraEv100(c.aperture, c.shutter, c.iso);
  return (
    <>
      <SegmentedControl
        label="Physical camera"
        ariaLabel="Physical camera"
        selected={on ? "on" : "off"}
        onSelect={(id) => onChange({ ...lighting, camera: id === "on" ? (cam ?? {}) : null })}
        options={[
          { id: "off", label: "Off" },
          { id: "on", label: "On", hint: "Aperture, shutter and ISO set the exposure as a camera's do; on the AAA tier they also drive depth of field and motion blur" },
        ]}
      />
      {on && (
        <>
          <SegmentedControl
            label="Exposure"
            ariaLabel="Camera exposure mode"
            selected={c.exposure}
            onSelect={(id) => set({ exposure: id as ExposureMode })}
            options={[
              { id: "auto", label: "Auto", hint: "Eye adaptation meters the frame; compensation shifts it" },
              { id: "manual", label: "Manual", hint: `Set by aperture, shutter and ISO: EV100 ${ev.toFixed(1)}` },
            ]}
          />
          <RangeControl label="Aperture" nested min={1.2} max={22} step={0.1} value={c.aperture} ariaLabel="Camera aperture" display={`f/${c.aperture.toFixed(1)}`} onChange={(aperture) => set({ aperture })} />
          <RangeControl label="Shutter" nested min={-13} max={0} step={0.5} value={Math.log2(c.shutter)} ariaLabel="Camera shutter" display={c.shutter >= 0.5 ? `${c.shutter.toFixed(1)} s` : `1/${Math.round(1 / c.shutter)} s`} onChange={(v) => set({ shutter: 2 ** v })} />
          <RangeControl label="ISO" nested min={Math.log2(50)} max={Math.log2(12800)} step={1 / 3} value={Math.log2(c.iso)} ariaLabel="Camera ISO" display={`${Math.round(c.iso)}`} onChange={(v) => set({ iso: Math.round(2 ** v) })} />
          {c.exposure === "auto" && (
            <>
              <RangeControl label="Compensation" nested min={-4} max={4} step={0.1} value={c.compensation} ariaLabel="Exposure compensation" display={`${c.compensation >= 0 ? "+" : ""}${c.compensation.toFixed(1)} EV`} onChange={(compensation) => set({ compensation })} />
              <SegmentedControl
                label="Metering"
                ariaLabel="Camera metering"
                selected={c.metering}
                onSelect={(id) => set({ metering: id as MeteringMode })}
                options={[
                  { id: "average", label: "Average" },
                  { id: "centre", label: "Centre" },
                  { id: "spot", label: "Spot" },
                ]}
              />
            </>
          )}
          <SegmentedControl
            label="Depth of field (AAA)"
            ariaLabel="Depth of field"
            selected={c.depthOfField ? "on" : "off"}
            onSelect={(id) => set({ depthOfField: id === "on" })}
            options={[
              { id: "off", label: "Off" },
              { id: "on", label: "Bokeh", hint: "What is nearer or farther than the focus blurs as the lens and aperture make it, shaped by the aperture's blades" },
            ]}
          />
          {c.depthOfField && (
            <>
              <RangeControl label="Focus" nested min={Math.log2(0.1)} max={Math.log2(500)} step={0.05} value={Math.log2(c.focusDistance)} ariaLabel="Focus distance" display={`${c.focusDistance < 10 ? c.focusDistance.toFixed(2) : Math.round(c.focusDistance)} m`} onChange={(v) => set({ focusDistance: 2 ** v })} />
              <RangeControl label="Focal length" nested min={8} max={400} step={1} value={c.focalLength} ariaLabel="Focal length" display={`${Math.round(c.focalLength)} mm`} onChange={(focalLength) => set({ focalLength })} />
              <RangeControl label="Blades" nested min={4} max={9} step={1} value={c.blades === 0 ? 4 : c.blades} ariaLabel="Aperture blades" display={c.blades === 0 ? "round" : `${c.blades}`} onChange={(blades) => set({ blades: blades < 5 ? 0 : blades })} />
            </>
          )}
          <SegmentedControl
            label="Motion blur (AAA)"
            ariaLabel="Motion blur"
            selected={c.motionBlur ? "on" : "off"}
            onSelect={(id) => set({ motionBlur: id === "on" })}
            options={[
              { id: "off", label: "Off" },
              { id: "on", label: "On", hint: "What moves on screen blurs over the share of the frame the shutter is open" },
            ]}
          />
        </>
      )}
    </>
  );
}

/**
 * Volumetric fog (AAA_FIDELITY_ROADMAP.md F5b): on the AAA tier the densities
 * above become a medium the sun and sky light scatter in, shadowed into
 * shafts, in place of the fade toward the fog colour (which the other tiers keep).
 */
function VolumetricFogControls({ fog, patch }: { fog: SceneFog; patch: (next: Partial<SceneFog>) => void }) {
  const v = fog.volumetric ?? null;
  const set = (next: Partial<VolumetricFogSettings>) => v && patch({ volumetric: { ...v, ...next } });
  return (
    <>
      <SegmentedControl
        label="Volumetric (AAA)"
        ariaLabel="Volumetric fog"
        selected={v ? "on" : "off"}
        onSelect={(id) => patch({ volumetric: id === "on" ? (v ?? {}) : null })}
        options={[
          { id: "off", label: "Painted" },
          { id: "on", label: "Volumetric", hint: "On the AAA tier, the fog's densities become a medium lit by the sun (through its shadows, so shafts of light appear) and the sky. Start and Max don't apply to it; the other tiers keep the painted fade" },
        ]}
      />
      {v && (
        <>
          <ColorRow label="Scattering" value={v.albedo ?? [1, 1, 1]} onChange={(albedo) => set({ albedo })} />
          <RangeControl label="Toward the sun" nested min={-0.5} max={0.95} step={0.01} value={v.anisotropy ?? 0.6} ariaLabel="Fog anisotropy" display={(v.anisotropy ?? 0.6).toFixed(2)} onChange={(anisotropy) => set({ anisotropy })} />
          <RangeControl label="Reach" nested min={16} max={500} step={4} value={v.distance ?? 96} ariaLabel="Volumetric fog reach" display={`${Math.round(v.distance ?? 96)} m`} onChange={(distance) => set({ distance })} />
          <RangeControl label="Sky light" nested min={0} max={4} step={0.05} value={v.ambient ?? 1} ariaLabel="Volumetric fog sky light" display={`×${(v.ambient ?? 1).toFixed(2)}`} onChange={(ambient) => set({ ambient })} />
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
          <SegmentedControl
            label="Shape"
            ariaLabel={`Probe ${index + 1} shape`}
            selected={probe.shape === "sphere" ? "sphere" : "box"}
            onSelect={(v) => {
              if (v === "box") {
                const { shape: _shape, radius: _radius, ...rest } = probe;
                set(probes.map((p, i) => (i === index ? rest : p)));
                return;
              }
              const radius = probe.radius ?? Math.max(0.5, Math.min(...[0, 1, 2].map((a) => (probe.max[a]! - probe.min[a]!) / 2)));
              const at = (s: number) => probe.position.map((c) => c + s * radius) as [number, number, number];
              patch(index, { shape: "sphere", radius, min: at(-1), max: at(1) });
            }}
            options={[
              { id: "box", label: "Box", hint: "A room: reflections line up with its walls" },
              { id: "sphere", label: "Sphere", hint: "An open space round the capture point (the AAA tier projects onto the sphere; the other tiers take its bounds)" },
            ]}
          />
          <VectorRow
            label="Capture point"
            value={probe.position}
            step={0.5}
            onChange={(position) =>
              probe.shape === "sphere" && probe.radius
                ? patch(index, { position, min: position.map((c) => c - probe.radius!) as [number, number, number], max: position.map((c) => c + probe.radius!) as [number, number, number] })
                : patch(index, { position })
            }
          />
          {probe.shape === "sphere" ? (
            <RangeControl
              label="Radius"
              nested
              min={0.5}
              max={200}
              step={0.5}
              value={probe.radius ?? 4}
              ariaLabel={`Probe ${index + 1} radius`}
              display={`${(probe.radius ?? 4).toFixed(1)} m`}
              onChange={(radius) => patch(index, { radius, min: probe.position.map((c) => c - radius) as [number, number, number], max: probe.position.map((c) => c + radius) as [number, number, number] })}
            />
          ) : (
            <>
              <VectorRow label="Box min" value={probe.min} step={0.5} onChange={(min) => patch(index, { min })} />
              <VectorRow label="Box max" value={probe.max} step={0.5} onChange={(max) => patch(index, { max })} />
            </>
          )}
          <RangeControl
            label="Priority"
            nested
            min={-10}
            max={10}
            step={1}
            value={probe.priority ?? 0}
            ariaLabel={`Probe ${index + 1} priority`}
            display={`${probe.priority ?? 0}`}
            onChange={(priority) => patch(index, { priority: priority === 0 ? undefined : priority })}
          />
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

/** Eye adaptation (P6): the exposure follows what the camera sees, as Unreal's auto-exposure. */
function AutoExposureControls({ lighting, onChange }: LightingEditorProps & { lighting: SceneLighting }) {
  const ae = lighting.autoExposure ?? null;
  const patch = (next: Partial<AutoExposure>) => ae && onChange(setSceneAutoExposure(lighting, { ...ae, ...next }));
  return (
    <>
      <SegmentedControl
        label="Eye adaptation"
        ariaLabel="Eye adaptation"
        selected={ae ? "on" : "off"}
        onSelect={(id) => onChange(setSceneAutoExposure(lighting, id === "on" ? (ae ?? DEFAULT_AUTO_EXPOSURE) : null))}
        options={[
          { id: "off", label: "Fixed" },
          { id: "on", label: "Adapts" },
        ]}
      />
      {ae && (
        <>
          <RangeControl label="Darkest" nested min={-6} max={0} step={0.25} value={ae.min} ariaLabel="Eye adaptation darkest" display={`${ae.min.toFixed(2)} stops`} onChange={(min) => patch({ min })} />
          <RangeControl label="Brightest" nested min={0} max={6} step={0.25} value={ae.max} ariaLabel="Eye adaptation brightest" display={`+${ae.max.toFixed(2)} stops`} onChange={(max) => patch({ max })} />
          <RangeControl label="Into the dark" nested min={0.1} max={6} step={0.1} value={ae.up} ariaLabel="Eye adaptation brightening speed" display={`${ae.up.toFixed(1)} stops/s`} onChange={(up) => patch({ up })} />
          <RangeControl label="Into the light" nested min={0.1} max={10} step={0.1} value={ae.down} ariaLabel="Eye adaptation darkening speed" display={`${ae.down.toFixed(1)} stops/s`} onChange={(down) => patch({ down })} />
          <RangeControl label="Mid-grey" nested min={0.05} max={0.5} step={0.01} value={ae.key} ariaLabel="Eye adaptation mid-grey" display={ae.key.toFixed(2)} onChange={(key) => patch({ key })} />
          <RailHint>Stepping into a dark base brightens the view over a second or so; stepping back into the sun darkens it faster, as eyes do.</RailHint>
        </>
      )}
    </>
  );
}

/** The overrides a post volume may set, with their ranges and neutral values. */
const POST_FIELDS: readonly { readonly key: "exposure" | "brightness" | "contrast" | "saturation" | "bloom" | "fog" | "aperture" | "focusDistance" | "motionBlur"; readonly label: string; readonly min: number; readonly max: number; readonly step: number; readonly neutral: number }[] = [
  { key: "exposure", label: "Exposure (stops)", min: -4, max: 4, step: 0.1, neutral: 0 },
  { key: "brightness", label: "Brightness", min: 0.5, max: 1.5, step: 0.01, neutral: 1 },
  { key: "contrast", label: "Contrast", min: 0.5, max: 1.5, step: 0.01, neutral: 1 },
  { key: "saturation", label: "Saturation", min: 0, max: 2, step: 0.01, neutral: 1 },
  { key: "bloom", label: "Bloom", min: 0, max: 1.5, step: 0.01, neutral: 0.6 },
  { key: "fog", label: "Fog density", min: 0, max: 1, step: 0.01, neutral: 0.35 },
  // The physical camera's (F4c, the AAA tier): the depth of field's aperture and focus, the motion blur's strength.
  { key: "aperture", label: "Aperture (f/)", min: 1.2, max: 22, step: 0.1, neutral: 4 },
  { key: "focusDistance", label: "Focus (m)", min: 0.1, max: 200, step: 0.1, neutral: 5 },
  { key: "motionBlur", label: "Motion blur", min: 0, max: 2, step: 0.05, neutral: 1 },
];

/**
 * Post-process volumes (P6), after Unreal's: a box that changes the exposure,
 * grade, bloom and fog while the camera is in it, fading over its blend
 * distance outside — a dim, cool interior; a hazy canyon floor.
 */
function PostVolumeControls({ lighting, onChange }: LightingEditorProps & { lighting: SceneLighting }) {
  const volumes = lighting.postVolumes ?? [];
  const set = (next: readonly PostVolume[]) => onChange(setScenePostVolumes(lighting, next));
  const patch = (index: number, next: Partial<PostVolume>) => set(volumes.map((v, i) => (i === index ? { ...v, ...next } : v)));
  const unset = (index: number, key: (typeof POST_FIELDS)[number]["key"]) =>
    set(
      volumes.map((v, i) => {
        if (i !== index) return v;
        const copy = { ...v };
        delete copy[key];
        return copy;
      }),
    );
  return (
    <>
      <div className={`${styles.groupLabel} ${styles.railSubLabel}`}>Post volumes</div>
      {volumes.map((volume, index) => (
        <div key={volume.id} style={{ marginBottom: 10 }}>
          <div className={styles.rangeRow} style={{ marginBottom: 4 }}>
            <input
              type="text"
              value={volume.name}
              aria-label={`Post volume ${index + 1} name`}
              onChange={(e) => patch(index, { name: e.target.value.slice(0, 64) })}
              style={{ flex: 1, minWidth: 0, padding: "4px 6px", borderRadius: 6 }}
            />
            <button type="button" className={styles.toolBtn} aria-label={`Remove post volume ${index + 1}`} onClick={() => set(volumes.filter((_, i) => i !== index))}>
              ✕
            </button>
          </div>
          <VectorRow label="Centre" value={volume.center} step={0.5} onChange={(center) => patch(index, { center })} />
          <VectorRow label="Size" value={volume.size} step={0.5} onChange={(size) => patch(index, { size: [Math.max(0.1, size[0]), Math.max(0.1, size[1]), Math.max(0.1, size[2])] })} />
          <RangeControl label="Blend" nested min={0} max={20} step={0.5} value={volume.blend} ariaLabel={`${volume.name} blend distance`} display={`${volume.blend.toFixed(1)} m`} onChange={(blend) => patch(index, { blend })} />
          <RangeControl label="Priority" nested min={-10} max={10} step={1} value={volume.priority ?? 0} ariaLabel={`${volume.name} priority`} display={`${volume.priority ?? 0}`} onChange={(priority) => patch(index, { priority })} />
          {POST_FIELDS.map((f) =>
            volume[f.key] === undefined ? null : (
              <div key={f.key} className={styles.rangeRow}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <RangeControl
                    label={f.label}
                    nested
                    min={f.min}
                    max={f.max}
                    step={f.step}
                    value={volume[f.key]!}
                    ariaLabel={`${volume.name} ${f.label}`}
                    display={volume[f.key]!.toFixed(2)}
                    onChange={(value) => patch(index, { [f.key]: value })}
                  />
                </div>
                <button type="button" className={styles.toolBtn} aria-label={`Stop ${volume.name} setting ${f.label}`} onClick={() => unset(index, f.key)}>
                  ✕
                </button>
              </div>
            ),
          )}
          <select
            aria-label={`${volume.name}: set another value`}
            value=""
            onChange={(e) => {
              const f = POST_FIELDS.find((x) => x.key === e.target.value);
              if (f) patch(index, { [f.key]: f.neutral });
            }}
            style={{ width: "100%" }}
          >
            <option value="">Set…</option>
            {POST_FIELDS.filter((f) => volume[f.key] === undefined).map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
      ))}
      <button
        type="button"
        className={styles.toolBtn}
        disabled={volumes.length >= 64}
        onClick={() =>
          set([...volumes, { id: `pv${Date.now().toString(36)}`, name: `volume ${volumes.length + 1}`, center: [0, 2, 0], size: [8, 4, 8], blend: 2, exposure: -0.5, saturation: 0.85 }])
        }
      >
        <span className={styles.toolGlyph} aria-hidden>
          ▣
        </span>
        Add post volume
      </button>
      <RailHint>
        While the camera is inside a box (and fading over its blend distance outside), it changes how the picture is finished. Exposure needs tone mapping on;
        the grade, bloom and fog need the cart&apos;s post-FX stack. Where boxes overlap, higher priority wins.
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
