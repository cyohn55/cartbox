"use client";

/**
 * The voxel preview: renders the current sprite as lit 3D voxel columns and lets
 * you relight it under different conditions. Each pixel is extruded by its height
 * channel into a column; the voxel core (renderVoxelRgba) shades the tops by the
 * normal map and the exposed walls by the same directional light, so choosing a
 * preset (Noon, Sunset, Moonlight…) or dialling azimuth/elevation/colour shows
 * exactly how the pixels read under that light.
 *
 * CPU-rendered (the voxel core is pure TS) and self-contained: it composites the
 * sprite through the shared block-buffer readers, the same ones the flat lit
 * preview uses, so both previews always show the same sprite.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  renderVoxelRgba,
  directionFromConditions,
  lightingPresetConditions,
  LIGHTING_PRESETS,
  DEFAULT_LIGHTING_PRESET_ID,
  type LightingConditions,
  type VoxelLight,
  type SpriteSheet,
  type NormalMap,
  type MaterialMap,
  type SpritePage,
} from "@cartbox/editor";

import styles from "./editor.module.css";
import { readBlockAlbedo, readBlockNormal, readBlockMaterial } from "./blockBuffers";

const TARGET_PREVIEW_PX = 192;
const MIN_CELL_PX = 4;
const CUSTOM_PRESET_ID = "custom";

interface VoxelPreviewProps {
  sheet: SpriteSheet;
  normals: NormalMap;
  height: MaterialMap;
  specular: MaterialMap;
  roughness: MaterialMap;
  emissive: MaterialMap;
  page: SpritePage;
  tile: number;
  version: number;
  /** Tiles per side of the sprite block (1 = single base tile). */
  blockTiles?: number;
}

/** #rrggbb → 0..1 RGB triplet. */
function hexToUnitRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

/** 0..1 RGB triplet → #rrggbb. */
function unitRgbToHex(color: readonly [number, number, number]): string {
  const channel = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color[0])}${channel(color[1])}${channel(color[2])}`;
}

export function VoxelPreview({
  sheet,
  normals,
  height,
  specular,
  roughness,
  emissive,
  page,
  tile,
  version,
  blockTiles = 1,
}: VoxelPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [presetId, setPresetId] = useState<string>(DEFAULT_LIGHTING_PRESET_ID);
  const [conditions, setConditions] = useState<LightingConditions>(() =>
    lightingPresetConditions(DEFAULT_LIGHTING_PRESET_ID),
  );

  const dim = sheet.tileSize * blockTiles;
  const cell = Math.max(MIN_CELL_PX, Math.round(TARGET_PREVIEW_PX / dim));
  const heightScale = Math.round(cell * 2.5);

  // Selecting a preset loads its conditions; editing any field forks to "custom".
  const applyPreset = (id: string) => {
    setPresetId(id);
    setConditions(lightingPresetConditions(id));
  };
  const editConditions = (patch: Partial<LightingConditions>) => {
    setPresetId(CUSTOM_PRESET_ID);
    setConditions((current) => ({ ...current, ...patch }));
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const albedo = readBlockAlbedo(sheet, page, tile, blockTiles);
    const normal = readBlockNormal(normals, sheet, page, tile, blockTiles);
    const material = readBlockMaterial(height, specular, roughness, emissive, sheet, page, tile, blockTiles);

    const light: VoxelLight = {
      direction: directionFromConditions(conditions),
      color: conditions.color,
      intensity: conditions.intensity,
      ambient: conditions.ambient,
    };
    const image = renderVoxelRgba(albedo, normal, dim, dim, light, { material, cell, heightScale });

    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    const frame = context.createImageData(image.width, image.height);
    frame.data.set(image.data);
    context.putImageData(frame, 0, 0);
  }, [
    conditions,
    dim,
    cell,
    heightScale,
    page,
    tile,
    version,
    blockTiles,
    sheet,
    normals,
    height,
    specular,
    roughness,
    emissive,
  ]);

  const colorHex = useMemo(() => unitRgbToHex(conditions.color), [conditions.color]);

  return (
    <div className={styles.litPreview}>
      <canvas
        ref={canvasRef}
        className={styles.voxelCanvas}
        role="img"
        aria-label={`Voxel preview of sprite ${tile} under ${presetId} lighting`}
      />

      <label className={styles.voxelRow}>
        <span className={styles.voxelLabel}>Lighting</span>
        <select
          className={styles.langSelect}
          value={presetId}
          onChange={(event) => applyPreset(event.target.value)}
          aria-label="Lighting preset"
          style={{ flex: 1 }}
        >
          {LIGHTING_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
          {presetId === CUSTOM_PRESET_ID && <option value={CUSTOM_PRESET_ID}>Custom</option>}
        </select>
        <input
          type="color"
          value={colorHex}
          onChange={(event) => editConditions({ color: hexToUnitRgb(event.target.value) })}
          aria-label="Light colour"
          title="Light colour"
        />
      </label>

      <label className={styles.voxelRow}>
        <span className={styles.voxelLabel}>Azimuth</span>
        <input
          type="range"
          min={0}
          max={360}
          step={1}
          value={conditions.azimuth}
          onChange={(event) => editConditions({ azimuth: Number(event.target.value) })}
          aria-label="Light azimuth"
        />
      </label>
      <label className={styles.voxelRow}>
        <span className={styles.voxelLabel}>Elevation</span>
        <input
          type="range"
          min={-90}
          max={90}
          step={1}
          value={conditions.elevation}
          onChange={(event) => editConditions({ elevation: Number(event.target.value) })}
          aria-label="Light elevation"
        />
      </label>
      <label className={styles.voxelRow}>
        <span className={styles.voxelLabel}>Intensity</span>
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={conditions.intensity}
          onChange={(event) => editConditions({ intensity: Number(event.target.value) })}
          aria-label="Light intensity"
        />
      </label>
      <label className={styles.voxelRow}>
        <span className={styles.voxelLabel}>Ambient</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={conditions.ambient}
          onChange={(event) => editConditions({ ambient: Number(event.target.value) })}
          aria-label="Ambient light"
        />
      </label>
    </div>
  );
}
