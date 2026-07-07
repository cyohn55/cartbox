"use client";

/**
 * A lit preview of the current sprite: its albedo shaded by its normal map and a
 * light you move with the pointer. Renders with WebGPU when available and falls
 * back to the CPU `renderLitRgba` path otherwise — both run identical Lambert
 * math, so the result matches. A small badge shows which renderer is active.
 *
 * For multi-tile sprites (blockTiles > 1) the preview composites the N×N block of
 * base tiles into one square image, matching the editing canvas.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  renderLitRgba,
  MATERIAL_LEVELS,
  type SpriteSheet,
  type NormalMap,
  type MaterialMap,
  type SpritePage,
  type Light,
  type FogOptions,
} from "@cartbox/editor";

import styles from "./editor.module.css";
import { WebGpuLitRenderer } from "./WebGpuLitRenderer";
import { blockTileIndex } from "./spriteBlock";

const TARGET_PREVIEW_PX = 192;
const MIN_CELL_PX = 4;
const LIGHT_HEIGHT = 2.2;
const AMBIENT = 0.22;
/** Warm shaft light, so the god rays read as sun through fog by default. */
const DEFAULT_SHAFT_HEX = "#ffe6b3";

type Mode = "init" | "gpu" | "cpu";

/** Parse a #rrggbb string to a 0..1 RGB triplet for the fog shaft colour. */
function hexToUnitRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

interface LitPreviewProps {
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
  /** Force the CPU path (for verifying it matches WebGPU). */
  forceCpu?: boolean;
}

/** Level (0..15) -> byte (0..255) for packing material channels into a texture. */
const LEVEL_TO_BYTE = 255 / (MATERIAL_LEVELS - 1);

/** Composite an N×N tile block's albedo into one square RGBA buffer (dim×dim). */
function readBlockAlbedo(sheet: SpriteSheet, page: SpritePage, baseTile: number, blockTiles: number): Uint8ClampedArray {
  const edge = sheet.tileSize;
  const dim = edge * blockTiles;
  const out = new Uint8ClampedArray(dim * dim * 4);
  for (let tileRow = 0; tileRow < blockTiles; tileRow += 1) {
    for (let tileColumn = 0; tileColumn < blockTiles; tileColumn += 1) {
      const subTile = blockTileIndex(baseTile, tileRow, tileColumn, sheet.sheetCols);
      const rgba = sheet.renderTileRgba(page, subTile);
      for (let y = 0; y < edge; y += 1) {
        for (let x = 0; x < edge; x += 1) {
          const source = (y * edge + x) * 4;
          const target = ((tileRow * edge + y) * dim + (tileColumn * edge + x)) * 4;
          out[target] = rgba[source] ?? 0;
          out[target + 1] = rgba[source + 1] ?? 0;
          out[target + 2] = rgba[source + 2] ?? 0;
          out[target + 3] = rgba[source + 3] ?? 255;
        }
      }
    }
  }
  return out;
}

/** Composite the block's normal vectors into one square RGBA normal buffer. */
function readBlockNormal(
  normals: NormalMap,
  sheet: SpriteSheet,
  page: SpritePage,
  baseTile: number,
  blockTiles: number,
): Uint8ClampedArray {
  const edge = sheet.tileSize;
  const dim = edge * blockTiles;
  const out = new Uint8ClampedArray(dim * dim * 4);
  for (let tileRow = 0; tileRow < blockTiles; tileRow += 1) {
    for (let tileColumn = 0; tileColumn < blockTiles; tileColumn += 1) {
      const subTile = blockTileIndex(baseTile, tileRow, tileColumn, sheet.sheetCols);
      for (let y = 0; y < edge; y += 1) {
        for (let x = 0; x < edge; x += 1) {
          const [nx, ny, nz] = normals.vector(page, subTile, x, y);
          const target = ((tileRow * edge + y) * dim + (tileColumn * edge + x)) * 4;
          out[target] = Math.round((nx * 0.5 + 0.5) * 255);
          out[target + 1] = Math.round((ny * 0.5 + 0.5) * 255);
          out[target + 2] = Math.round((nz * 0.5 + 0.5) * 255);
          out[target + 3] = 255;
        }
      }
    }
  }
  return out;
}

/** Composite the block's material into one RGBA buffer: R=height, G=specular,
 * B=roughness, A=emissive (each level scaled to a byte). */
function readBlockMaterial(
  heightMap: MaterialMap,
  specularMap: MaterialMap,
  roughnessMap: MaterialMap,
  emissiveMap: MaterialMap,
  sheet: SpriteSheet,
  page: SpritePage,
  baseTile: number,
  blockTiles: number,
): Uint8ClampedArray {
  const edge = sheet.tileSize;
  const dim = edge * blockTiles;
  const out = new Uint8ClampedArray(dim * dim * 4);
  for (let tileRow = 0; tileRow < blockTiles; tileRow += 1) {
    for (let tileColumn = 0; tileColumn < blockTiles; tileColumn += 1) {
      const subTile = blockTileIndex(baseTile, tileRow, tileColumn, sheet.sheetCols);
      for (let y = 0; y < edge; y += 1) {
        for (let x = 0; x < edge; x += 1) {
          const target = ((tileRow * edge + y) * dim + (tileColumn * edge + x)) * 4;
          out[target] = heightMap.getValue(page, subTile, x, y) * LEVEL_TO_BYTE;
          out[target + 1] = specularMap.getValue(page, subTile, x, y) * LEVEL_TO_BYTE;
          out[target + 2] = roughnessMap.getValue(page, subTile, x, y) * LEVEL_TO_BYTE;
          out[target + 3] = emissiveMap.getValue(page, subTile, x, y) * LEVEL_TO_BYTE;
        }
      }
    }
  }
  return out;
}

export function LitPreview({
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
  forceCpu,
}: LitPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gpuRef = useRef<WebGpuLitRenderer | null>(null);
  const [mode, setMode] = useState<Mode>("init");
  const [light, setLight] = useState({ col: 1.5, row: 1.5 });
  const [shaftStrength, setShaftStrength] = useState(0.4);
  const [shaftHex, setShaftHex] = useState(DEFAULT_SHAFT_HEX);

  // God-ray fog: undefined when the strength slider is at zero, so the preview
  // costs nothing until the effect is dialled in.
  const fog = useMemo<FogOptions | undefined>(
    () => (shaftStrength > 0 ? { color: hexToUnitRgb(shaftHex), density: shaftStrength } : undefined),
    [shaftStrength, shaftHex],
  );

  const dim = sheet.tileSize * blockTiles;
  const cellPx = Math.max(MIN_CELL_PX, Math.round(TARGET_PREVIEW_PX / dim));
  const size = dim * cellPx;

  // Re-center the light when the sprite dimensions change so it stays in frame.
  useEffect(() => {
    setLight({ col: dim / 2, row: dim / 2 });
  }, [dim]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;

    if (forceCpu) {
      setMode("cpu");
      return;
    }

    let active = true;
    WebGpuLitRenderer.create(canvas, dim, dim).then((renderer) => {
      if (!active) {
        renderer?.destroy();
        return;
      }
      gpuRef.current = renderer;
      setMode(renderer ? "gpu" : "cpu");
    });

    return () => {
      active = false;
      gpuRef.current?.destroy();
      gpuRef.current = null;
    };
  }, [forceCpu, dim, size]);

  useEffect(() => {
    if (mode === "init") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const albedo = readBlockAlbedo(sheet, page, tile, blockTiles);
    const normal = readBlockNormal(normals, sheet, page, tile, blockTiles);
    const material = readBlockMaterial(height, specular, roughness, emissive, sheet, page, tile, blockTiles);
    const litLight: Light = { col: light.col, row: light.row, height: LIGHT_HEIGHT, ambient: AMBIENT };

    if (mode === "gpu" && gpuRef.current) {
      gpuRef.current.render(albedo, normal, material, litLight, fog);
      return;
    }

    // CPU fallback: light at native resolution, then scale up nearest-neighbour.
    const lit = renderLitRgba(albedo, normal, dim, dim, litLight, { material, fog });
    const context = canvas.getContext("2d");
    if (!context) return;
    const tmp = document.createElement("canvas");
    tmp.width = dim;
    tmp.height = dim;
    const tmpContext = tmp.getContext("2d");
    if (!tmpContext) return;
    const image = tmpContext.createImageData(dim, dim);
    image.data.set(lit);
    tmpContext.putImageData(image, 0, 0);
    context.imageSmoothingEnabled = false;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(tmp, 0, 0, canvas.width, canvas.height);
  }, [mode, light, fog, page, tile, version, sheet, normals, height, specular, roughness, emissive, blockTiles, dim]);

  const moveLight = (event: React.PointerEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    setLight({
      col: ((event.clientX - rect.left) / rect.width) * dim,
      row: ((event.clientY - rect.top) / rect.height) * dim,
    });
  };

  return (
    <div className={styles.litPreview}>
      <canvas
        ref={canvasRef}
        style={{ width: size, height: size, imageRendering: "pixelated", borderRadius: 6, cursor: "crosshair" }}
        onPointerMove={moveLight}
        role="img"
        aria-label={`Lit preview of sprite ${tile}${blockTiles > 1 ? `, ${blockTiles} by ${blockTiles} tiles` : ""}`}
      />
      <span className={styles.litBadge} data-mode={mode}>
        {mode === "gpu" ? "WebGPU" : mode === "cpu" ? "CPU" : "…"}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
          <span>God rays</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={shaftStrength}
            onChange={(event) => setShaftStrength(Number(event.target.value))}
            style={{ flex: 1 }}
            aria-label="God-ray strength"
          />
        </label>
        <input
          type="color"
          value={shaftHex}
          onChange={(event) => setShaftHex(event.target.value)}
          aria-label="God-ray colour"
          title="Shaft colour"
        />
      </div>
    </div>
  );
}
