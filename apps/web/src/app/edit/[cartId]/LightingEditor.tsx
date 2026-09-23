"use client";

/**
 * The scene lighting & skybox panel (Phase 6 — 3D authoring UX). Authors the
 * Modern-tier lighting rig the runtime replays over the mesh overlay: the skybox
 * gradient (image-based lighting), an ambient floor, tone mapping, shadows, and a
 * list of directional / point lights.
 *
 * Fully controlled: it edits the rig handed in through the pure helpers in
 * `@cartbox/editor` and reports the whole next rig (or null to clear it) through
 * {@link onChange}. A cart with no rig renders exactly as before, so the panel
 * leads with a single "Add lighting" button — opting in is explicit.
 */

import {
  addSceneLight,
  defaultProceduralSky,
  defaultSceneFog,
  defaultSceneLighting,
  patchSceneLighting,
  removeSceneLight,
  setSceneFog,
  setSceneSky,
  updateSceneEnvironment,
  updateSceneLight,
  type ProceduralSky,
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
      {lighting.lights.map((light, index) => (
        <div key={index} style={{ border: "1px solid #2a2f45", borderRadius: 8, padding: 8, marginBottom: 8 }}>
          <SegmentedControl
            ariaLabel={`Light ${index + 1} type`}
            selected={light.kind}
            onSelect={(kind) =>
              onChange(
                updateSceneLight(
                  lighting,
                  index,
                  kind === "directional"
                    ? { kind, direction: light.direction ?? [0.4, 0.8, 0.6], position: undefined, range: undefined }
                    : { kind, position: light.position ?? [0, 1, 0], range: light.range ?? 0, direction: undefined },
                ),
              )
            }
            options={[
              { id: "directional", label: "Sun" },
              { id: "point", label: "Point" },
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
      ))}

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
        </>
      )}
    </>
  );
}

function directionalLight(): SceneLight {
  return { kind: "directional", direction: [-0.4, 0.7, 0.5], color: [1, 1, 1], intensity: 1 };
}

function pointLight(): SceneLight {
  return { kind: "point", position: [0, 2, 0], color: [1, 0.9, 0.8], intensity: 2, range: 10 };
}
