"use client";

/**
 * A small picture of what an asset actually is.
 *
 * Names alone make a list of assets nearly useless — "Model 3" tells you
 * nothing, and a cart with a dozen sprites is a dozen identical chips. Both
 * mediums can be drawn cheaply from data already in hand, so the browser shows
 * the art rather than describing it.
 *
 * Each kind is drawn the way its own editor draws it, so a chip and the stage
 * agree by construction: a sprite block is composited through the same
 * `readBlockAlbedo` the previews use, and a sculpt goes through the same voxel
 * renderer the sculptor's viewport does.
 *
 * Sculpt thumbnails are the expensive ones — a sculpt has to be deserialized
 * before it can be drawn — so they are memoized on the payload and rendered at a
 * deliberately tiny cell size. A payload that fails to parse draws nothing rather
 * than throwing: a corrupt asset should look empty in the list, not take the
 * editor down.
 */

import { useEffect, useMemo, useRef } from "react";
import {
  deserializeCellShape,
  deserializeVoxelGrid,
  geometryFor,
  renderVoxelModel,
  voxelGridToModel,
  type SpriteSheet,
} from "@cartbox/editor";

import { isSpriteBlockAsset, type CartAsset } from "@/lib/cartAssets";

import styles from "./editor.module.css";
import { readBlockAlbedo } from "./blockBuffers";

/** Rendered size of a thumbnail, in device pixels before CSS scaling. */
const THUMB_SIZE = 32;

/** Cell size for sculpt thumbnails — small enough that even a big model fits. */
const THUMB_CELL = 2;

/** Camera for sculpt thumbnails: the sculptor's opening three-quarter view. */
const THUMB_YAW = 0.7;
const THUMB_PITCH = 0.72;

interface AssetThumbProps {
  asset: CartAsset;
  /** Provides the pixels a sprite block names; sculpts carry their own. */
  sheet: SpriteSheet;
  /** Bumped when the sheet's pixels change, so sprite thumbs stay current. */
  version: number;
}

export function AssetThumb({ asset, sheet, version }: AssetThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Drawing a sculpt means deserializing it, which is the one costly step here,
  // so it is keyed on the payload: renaming or reordering an asset must not
  // rebuild its model.
  const sculptRender = useMemo(() => {
    if (isSpriteBlockAsset(asset)) return null;
    try {
      const grid = deserializeVoxelGrid(asset.grid);
      // Hexel sculpts must be built on their own lattice, or the thumbnail draws
      // a cube model of a rhombic one and reads as the wrong asset.
      const model = voxelGridToModel(grid, { geometry: geometryFor(deserializeCellShape(asset.grid)) });
      if (model.count === 0) return null;
      return renderVoxelModel(model, { yaw: THUMB_YAW, pitch: THUMB_PITCH, cell: THUMB_CELL, size: THUMB_SIZE });
    } catch {
      return null; // a corrupt sculpt draws empty rather than breaking the list
    }
  }, [asset]);

  // The sprite side is cheap, but it must follow the sheet: `version` is what
  // makes a chip repaint when the block's pixels are edited under it.
  const spritePixels = useMemo(() => {
    if (!isSpriteBlockAsset(asset)) return null;
    try {
      return {
        data: readBlockAlbedo(sheet, asset.page, asset.tile, asset.tilesPerSide),
        dim: sheet.tileSize * asset.tilesPerSide,
      };
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset, sheet, version]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const source = spritePixels
      ? { data: spritePixels.data, size: spritePixels.dim }
      : sculptRender
        ? { data: sculptRender.data, size: THUMB_SIZE }
        : null;

    canvas.width = source?.size ?? THUMB_SIZE;
    canvas.height = source?.size ?? THUMB_SIZE;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!source) return;

    const image = context.createImageData(source.size, source.size);
    image.data.set(source.data);
    context.putImageData(image, 0, 0);
  }, [spritePixels, sculptRender]);

  return <canvas ref={canvasRef} className={styles.assetThumb} aria-hidden />;
}
