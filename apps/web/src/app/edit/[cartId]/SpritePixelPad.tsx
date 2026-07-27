"use client";

/**
 * A pixel pad for one sprite, embedded in the Voxel tab.
 *
 * Voxels can be skinned with sprites, which means the look of a sculpt is partly
 * a *pixel* problem — and having to leave for the Sprites tab to nudge one texel
 * breaks the loop badly, because the whole point is judging the texture on the
 * model. This pad edits the sprite in place: paint here, and the preview
 * re-textures on the next render.
 *
 * It writes through the same {@link SpriteSheet} the Sprites tab uses, so edits
 * land in the cart and on the shared undo timeline like any other pixel edit.
 */

import { useCallback, useEffect, useRef } from "react";
import type { SpritePage, SpriteSheet } from "@cartbox/editor";

import styles from "./editor.module.css";

/** On-screen size of the pad, in CSS pixels. */
const PAD_SIZE = 160;

interface SpritePixelPadProps {
  sheet: SpriteSheet;
  page: SpritePage;
  /** Sprite being edited. */
  tile: number;
  onTileChange: (tile: number) => void;
  /** Palette index the pad paints with (right-click always erases to 0). */
  colorIndex: number;
  /** Bumped by the caller when the sheet changed elsewhere, to force a redraw. */
  version: number;
  /** A pixel was painted; the caller re-renders anything showing this sprite. */
  onEdit: () => void;
}

export function SpritePixelPad({
  sheet,
  page,
  tile,
  onTileChange,
  colorIndex,
  version,
  onEdit,
}: SpritePixelPadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const painting = useRef(false);
  // Which button started the stroke, so a right-drag keeps erasing.
  const erasing = useRef(false);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    canvas.width = sheet.tileSize;
    canvas.height = sheet.tileSize;
    const image = context.createImageData(sheet.tileSize, sheet.tileSize);
    image.data.set(sheet.renderTileRgba(page, tile));
    context.putImageData(image, 0, 0);
  }, [sheet, page, tile]);

  useEffect(() => {
    redraw();
  }, [redraw, version]);

  /** The sprite pixel under the pointer, or null when outside the pad. */
  const pixelFromEvent = (event: React.PointerEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * sheet.tileSize);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * sheet.tileSize);
    if (x < 0 || y < 0 || x >= sheet.tileSize || y >= sheet.tileSize) return null;
    return { x, y };
  };

  const paint = (event: React.PointerEvent) => {
    const target = pixelFromEvent(event);
    if (!target) return;
    sheet.setPixel(page, tile, target.x, target.y, erasing.current ? 0 : colorIndex);
    redraw();
    onEdit();
  };

  const handleDown = (event: React.PointerEvent) => {
    event.preventDefault();
    painting.current = true;
    erasing.current = event.button === 2;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    paint(event);
  };

  return (
    <div>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>Pixels</span>
        <span className={styles.panelMeta}>sprite #{tile.toString().padStart(3, "0")}</span>
      </div>
      <div className={styles.pixelPadRow}>
        <label className={styles.classField}>
          <span className={styles.classFieldLabel}>#</span>
          <input
            type="number"
            min={0}
            max={sheet.tilesPerPage - 1}
            value={tile}
            onChange={(event) => onTileChange(Number(event.target.value))}
            aria-label="Sprite to edit"
          />
        </label>
      </div>
      <canvas
        ref={canvasRef}
        className={styles.pixelPad}
        style={{ width: PAD_SIZE, height: PAD_SIZE }}
        onPointerDown={handleDown}
        onPointerMove={(event) => {
          if (painting.current) paint(event);
        }}
        onPointerUp={() => {
          painting.current = false;
        }}
        onPointerCancel={() => {
          painting.current = false;
        }}
        onContextMenu={(event) => event.preventDefault()}
        role="img"
        aria-label={`Sprite ${tile} pixels`}
      />
      <p className={styles.pickerHint}>
        Click to paint with the selected colour, right-click to erase. Edits land on the sprite itself, so the
        sculpt&apos;s skin and the Sprites tab update together.
      </p>
    </div>
  );
}
