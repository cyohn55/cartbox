"use client";

/**
 * MaterialSwatchPanel — binds the selected albedo colour to a material profile.
 * Toggling it on makes that colour a "swatch": painting with it stamps the
 * chosen normal direction and the height/specular/roughness/emissive ramp levels
 * alongside the albedo, so an author draws a lit material in one stroke. Off, the
 * colour paints albedo only. Purely edits the swatch data; the composite paint
 * surface reads it.
 */

import {
  MATERIAL_LEVELS,
  NORMAL_DIRECTION_COUNT,
  normalColorHex,
  materialProfileAt,
  setMaterialProfile,
  defaultMaterialProfile,
  type MaterialProfile,
  type MaterialSwatches,
} from "@cartbox/editor";

import styles from "./editor.module.css";

/** The greyscale ramp channels, in the order they read as a material. */
const RAMP_CHANNELS = [
  { key: "height", label: "Height" },
  { key: "specular", label: "Specular" },
  { key: "roughness", label: "Roughness" },
  { key: "emissive", label: "Emissive" },
] as const;

type RampKey = (typeof RAMP_CHANNELS)[number]["key"];

/** Greyscale swatch for a ramp level: black at 0, white at the top level. */
function rampChip(level: number): string {
  const channel = Math.round((level / (MATERIAL_LEVELS - 1)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${channel}${channel}${channel}`;
}

interface MaterialSwatchPanelProps {
  /** Palette index of the colour being bound. */
  colorIndex: number;
  /** The colour's albedo swatch, for the enable chip. */
  colorCss: string;
  swatches: MaterialSwatches;
  onChange: (next: MaterialSwatches) => void;
}

export function MaterialSwatchPanel({ colorIndex, colorCss, swatches, onChange }: MaterialSwatchPanelProps) {
  const profile = materialProfileAt(swatches, colorIndex);

  const update = (patch: Partial<MaterialProfile>) =>
    onChange(setMaterialProfile(swatches, colorIndex, { ...profile, ...patch }));
  const setRamp = (key: RampKey, value: number) => update({ [key]: value } as Partial<MaterialProfile>);

  return (
    <div>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>Material swatch</span>
        <span className={styles.panelMeta}>color {colorIndex.toString().padStart(2, "0")}</span>
      </div>

      <label className={styles.swatchToggle}>
        <input
          type="checkbox"
          checked={profile.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
        <span className={styles.hudChip} style={{ background: colorCss }} />
        <span>Stamp material when painting this colour</span>
      </label>

      {profile.enabled && (
        <div className={styles.swatchBody}>
          <div>
            <div className={styles.groupLabel}>Normal</div>
            <div className={styles.directionGrid}>
              {Array.from({ length: NORMAL_DIRECTION_COUNT }, (_unused, index) => (
                <button
                  key={index}
                  type="button"
                  className={`${styles.swatch} ${index === profile.normal ? styles.swatchActive : ""}`}
                  style={{ background: normalColorHex(index) }}
                  onClick={() => update({ normal: index })}
                  title={`Direction ${index}`}
                  aria-label={`Normal direction ${index}`}
                  aria-pressed={index === profile.normal}
                />
              ))}
            </div>
          </div>

          {RAMP_CHANNELS.map(({ key, label }) => {
            const value = profile[key];
            return (
              <div key={key}>
                <div className={styles.groupLabel}>{label}</div>
                <div className={styles.rangeRow}>
                  <span className={styles.hudChip} style={{ background: rampChip(value) }} />
                  <input
                    type="range"
                    min={0}
                    max={MATERIAL_LEVELS - 1}
                    step={1}
                    value={value}
                    onChange={(event) => setRamp(key, Number(event.target.value))}
                    aria-label={label}
                  />
                  <span className={`${styles.rangeValue} data`}>{value}</span>
                </div>
              </div>
            );
          })}

          <button
            type="button"
            className="cbx-btn"
            onClick={() =>
              onChange(setMaterialProfile(swatches, colorIndex, { ...defaultMaterialProfile(), enabled: true }))
            }
            title="Reset this colour's channels to zero"
          >
            Reset channels
          </button>
        </div>
      )}
    </div>
  );
}
