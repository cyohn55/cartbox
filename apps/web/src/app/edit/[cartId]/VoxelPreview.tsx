"use client";

/**
 * The voxel preview: renders the current sprite as a lit 3D object and lets you
 * relight it under different conditions.
 *
 * Two modes share the same lighting controls. The default heightfield mode
 * (renderVoxelRgba) extrudes each pixel by its height channel into a column and
 * shades it from a fixed angle. The "3D spin" mode extrudes the sprite into a
 * solid voxel model (extrudeSprite) that continuously turns and bobs
 * (renderVoxelModel) — the exact same voxel core that powers the onboarding
 * backdrop — so you can author a spinning 3D object with glowing pixels and see
 * every face relight as it rotates.
 *
 * CPU-rendered (the voxel core is pure TS) and self-contained: it composites the
 * sprite through the shared block-buffer readers, the same ones the flat lit
 * preview uses, so both previews always show the same sprite.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  renderVoxelRgba,
  renderVoxelModel,
  extrudeSprite,
  voxelCanvasSize,
  directionFromConditions,
  lightingPresetConditions,
  LIGHTING_PRESETS,
  DEFAULT_LIGHTING_PRESET_ID,
  type LightingConditions,
  type VoxelLight,
  type ModelLight,
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
const MODEL_PITCH = 0.42;
const SPIN_SPEED = 0.7; // radians/second in 3D spin mode
const BOB_SPEED = 1.3; // radians/second of the bob oscillation

/** Lighting conditions → a world-fixed model light (model y is up, so flip y). */
function conditionsToModelLight(conditions: LightingConditions): ModelLight {
  const [dx, dy, dz] = directionFromConditions(conditions);
  return { direction: [dx, -dy, dz], color: conditions.color, intensity: conditions.intensity, ambient: conditions.ambient };
}

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
  const [spin3d, setSpin3d] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [depth, setDepth] = useState(6);

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

  // Heightfield mode: a static, fixed-angle extrusion relit by the conditions.
  useEffect(() => {
    if (spin3d) return;
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
    spin3d,
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

  // 3D spin mode: extrude the sprite into a solid voxel model that turns and
  // bobs, relit each frame by the conditions — the backdrop's voxel core.
  useEffect(() => {
    if (!spin3d) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const albedo = readBlockAlbedo(sheet, page, tile, blockTiles);
    const material = readBlockMaterial(height, specular, roughness, emissive, sheet, page, tile, blockTiles);
    const emissivePlane = new Uint8Array(dim * dim);
    for (let i = 0; i < dim * dim; i += 1) emissivePlane[i] = material[i * 4 + 3] ?? 0;

    const model = extrudeSprite(albedo, dim, dim, { depth, emissive: emissivePlane });
    const size = voxelCanvasSize(model, cell);
    const bobAmplitude = Math.round(cell * 1.4);
    const light = conditionsToModelLight(conditions);
    const out = new Uint8ClampedArray(size * size * 4);
    const depthBuffer = new Float32Array(size * size);

    // A tile canvas holds one rendered frame; the visible canvas has bob
    // headroom above and below so the vertical bob has room to move.
    const tile2d = document.createElement("canvas");
    tile2d.width = size;
    tile2d.height = size;
    const tileContext = tile2d.getContext("2d");
    if (!tileContext) return;
    const image = tileContext.createImageData(size, size);

    canvas.width = size;
    canvas.height = size + bobAmplitude * 2;

    const draw = (yaw: number, bobY: number) => {
      renderVoxelModel(model, { yaw, pitch: MODEL_PITCH, cell, light, out, depthBuffer });
      image.data.set(out);
      tileContext.putImageData(image, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(tile2d, 0, Math.round(bobAmplitude - bobY));
    };

    if (!playing) {
      draw(0.6, 0); // a still 3/4 view
      return;
    }

    let frame = 0;
    const start = performance.now();
    const loop = (now: number) => {
      const seconds = (now - start) / 1000;
      draw(seconds * SPIN_SPEED, Math.sin(seconds * BOB_SPEED) * bobAmplitude);
      frame = window.requestAnimationFrame(loop);
    };
    frame = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(frame);
  }, [
    spin3d,
    playing,
    depth,
    conditions,
    dim,
    cell,
    page,
    tile,
    version,
    blockTiles,
    sheet,
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
        aria-label={`Voxel preview of sprite ${tile} under ${presetId} lighting${spin3d ? ", spinning in 3D" : ""}`}
      />

      <label className={styles.voxelRow}>
        <span className={styles.voxelLabel}>3D spin</span>
        <input
          type="checkbox"
          checked={spin3d}
          onChange={(event) => setSpin3d(event.target.checked)}
          aria-label="Render as a spinning 3D object"
        />
        {spin3d && (
          <button
            type="button"
            className={styles.langSelect}
            onClick={() => setPlaying((value) => !value)}
            aria-pressed={playing}
            style={{ flex: 1 }}
          >
            {playing ? "Pause" : "Play"}
          </button>
        )}
      </label>

      {spin3d && (
        <label className={styles.voxelRow}>
          <span className={styles.voxelLabel}>Depth</span>
          <input
            type="range"
            min={1}
            max={16}
            step={1}
            value={depth}
            onChange={(event) => setDepth(Number(event.target.value))}
            aria-label="Model depth"
          />
        </label>
      )}

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
