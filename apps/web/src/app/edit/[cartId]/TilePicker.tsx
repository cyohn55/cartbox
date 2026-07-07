"use client";

/**
 * The tile navigator: all 256 tiles of the active page as a grid of thumbnails.
 * Each thumbnail is a tiny canvas rasterised from the SpriteSheet, so it always
 * reflects the current pixels. Selecting a tile promotes it to the canvas.
 *
 * When onSelectBrush is provided (map editor), dragging across the grid selects
 * a rectangular block of tiles as a multi-tile stamp brush.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { SpriteSheet, SpritePage } from "@cartbox/editor";

import styles from "./editor.module.css";
import { blockTileIndices } from "./spriteBlock";
import { brushFromCorners, brushTileIndices, singleTileBrush, type MapBrush } from "./mapBrush";

interface TilePickerProps {
  sheet: SpriteSheet;
  page: SpritePage;
  selected: number;
  version: number;
  onSelect: (tile: number) => void;
  /** Tiles per side of the selected sprite block (1 = single tile). */
  blockTiles?: number;
  /** Enables drag-to-select: called with the rectangle of tiles spanned by a drag. */
  onSelectBrush?: (brush: MapBrush) => void;
  /** The active multi-tile brush, highlighted like a sprite block. */
  brush?: MapBrush;
}

export function TilePicker({
  sheet,
  page,
  selected,
  version,
  onSelect,
  blockTiles = 1,
  onSelectBrush,
  brush,
}: TilePickerProps) {
  // A drag in progress across the grid (multi-tile brush selection only).
  const [drag, setDrag] = useState<{ anchor: number; current: number } | null>(null);

  // The tiles highlighted as part of the current selection: the in-progress
  // drag rectangle, else the active brush block, else the sprite block.
  const blockMembers = useMemo(() => {
    if (drag) return new Set(brushTileIndices(brushFromCorners(drag.anchor, drag.current, sheet.sheetCols), sheet.sheetCols));
    if (brush) return new Set(brushTileIndices(brush, sheet.sheetCols));
    return new Set(blockTileIndices(selected, blockTiles, sheet.sheetCols));
  }, [drag, brush, selected, blockTiles, sheet.sheetCols]);

  const tileFromEvent = (event: React.PointerEvent): number | null => {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const cell = element?.closest<HTMLElement>("[data-tile]");
    if (!cell?.dataset.tile) return null;
    const tile = Number(cell.dataset.tile);
    return Number.isInteger(tile) ? tile : null;
  };

  const handlePointerDown = (event: React.PointerEvent) => {
    if (!onSelectBrush) return;
    const tile = tileFromEvent(event);
    if (tile === null) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setDrag({ anchor: tile, current: tile });
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (!drag) return;
    const tile = tileFromEvent(event);
    if (tile !== null && tile !== drag.current) setDrag({ anchor: drag.anchor, current: tile });
  };

  const handlePointerUp = () => {
    if (!drag || !onSelectBrush) return;
    const result = brushFromCorners(drag.anchor, drag.current, sheet.sheetCols);
    onSelect(result.tile);
    onSelectBrush(result);
    setDrag(null);
  };

  const brushSize = drag
    ? brushFromCorners(drag.anchor, drag.current, sheet.sheetCols)
    : brush ?? (blockTiles > 1 ? { tile: selected, width: blockTiles, height: blockTiles } : null);

  return (
    <div>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>Sprites</span>
        <span className={`${styles.panelMeta} data`}>
          #{selected.toString().padStart(3, "0")}
          {brushSize && brushSize.width * brushSize.height > 1 ? ` · ${brushSize.width}×${brushSize.height}` : ""}
        </span>
      </div>
      {onSelectBrush && <div className={styles.pickerHint}>Drag to select a block of tiles</div>}
      <div
        className={styles.tileGrid}
        style={onSelectBrush ? { touchAction: "none" } : undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => setDrag(null)}
      >
        {Array.from({ length: sheet.tilesPerPage }, (_unused, tile) => {
          const highlight =
            tile === selected ? styles.tileCellActive : blockMembers.has(tile) ? styles.tileCellBlock : "";
          return (
            <button
              key={tile}
              type="button"
              data-tile={tile}
              className={`${styles.tileCell} ${highlight}`}
              onClick={() => {
                onSelect(tile);
                onSelectBrush?.(singleTileBrush(tile));
              }}
              title={`Sprite ${tile}`}
              aria-label={`Sprite ${tile}`}
              aria-pressed={tile === selected}
            >
              <TileThumb sheet={sheet} page={page} tile={tile} version={version} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TileThumb({
  sheet,
  page,
  tile,
  version,
}: {
  sheet: SpriteSheet;
  page: SpritePage;
  tile: number;
  version: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const image = context.createImageData(sheet.tileSize, sheet.tileSize);
    image.data.set(sheet.renderTileRgba(page, tile));
    context.putImageData(image, 0, 0);
  }, [sheet, page, tile, version]);

  return <canvas ref={ref} width={sheet.tileSize} height={sheet.tileSize} />;
}
