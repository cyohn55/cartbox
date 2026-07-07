"use client";

/**
 * The scrollable map grid. Each cell draws the tile it references (from the
 * tiles page), scaled to the current zoom with nearest-neighbour so pixels stay
 * crisp. Faint amber guides mark the 30x17 screen boundaries. Painting redraws
 * only the touched cell (or the whole map on a fill) to stay responsive on a
 * 240x136 grid.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { SpriteSheet, TileMap } from "@cartbox/editor";

import styles from "./editor.module.css";
import { blockTileIndex } from "./spriteBlock";
import type { MapBrush } from "./mapBrush";
import type { MapTool } from "./maptools";

interface MapCanvasProps {
  sheet: SpriteSheet;
  map: TileMap;
  brush: MapBrush;
  tool: MapTool;
  cell: number;
  version: number;
  onEdit: () => void;
  onHover: (cell: { x: number; y: number } | null) => void;
}

export function MapCanvas({ sheet, map, brush, tool, cell, version, onEdit, onHover }: MapCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hoverRef = useRef<HTMLDivElement>(null);
  const painting = useRef(false);

  const width = map.width * cell;
  const height = map.height * cell;

  // Pre-rasterise each tile once so map redraws are drawImage blits, not
  // per-pixel work across 32k cells.
  const tileCache = useMemo(() => {
    const cache: HTMLCanvasElement[] = [];
    for (let tile = 0; tile < sheet.tilesPerPage; tile += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = sheet.tileSize;
      canvas.height = sheet.tileSize;
      const context = canvas.getContext("2d")!;
      const image = context.createImageData(sheet.tileSize, sheet.tileSize);
      image.data.set(sheet.renderTileRgba(0, tile));
      context.putImageData(image, 0, 0);
      cache.push(canvas);
    }
    return cache;
  }, [sheet, version]);

  const drawCell = useCallback(
    (context: CanvasRenderingContext2D, x: number, y: number) => {
      const tile = tileCache[map.getCell(x, y)];
      if (tile) context.drawImage(tile, x * cell, y * cell, cell, cell);
    },
    [tileCache, map, cell],
  );

  const drawGuides = useCallback(
    (context: CanvasRenderingContext2D) => {
      context.strokeStyle = "rgba(246,183,74,0.28)";
      context.lineWidth = 1;
      for (let sx = map.screenWidth; sx < map.width; sx += map.screenWidth) {
        context.beginPath();
        context.moveTo(sx * cell + 0.5, 0);
        context.lineTo(sx * cell + 0.5, height);
        context.stroke();
      }
      for (let sy = map.screenHeight; sy < map.height; sy += map.screenHeight) {
        context.beginPath();
        context.moveTo(0, sy * cell + 0.5);
        context.lineTo(width, sy * cell + 0.5);
        context.stroke();
      }
    },
    [map, cell, width, height],
  );

  const renderAll = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, width, height);
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        drawCell(context, x, y);
      }
    }
    drawGuides(context);
  }, [map, width, height, drawCell, drawGuides]);

  useEffect(() => {
    renderAll();
  }, [renderAll]);

  const cellFromEvent = (event: React.PointerEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) / cell);
    const y = Math.floor((event.clientY - rect.top) / cell);
    if (x < 0 || x >= map.width || y < 0 || y >= map.height) return null;
    return { x, y };
  };

  const apply = (target: { x: number; y: number }) => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    if (tool === "fill") {
      map.fill(target.x, target.y, brush.tile);
      onEdit();
      return;
    }
    context.imageSmoothingEnabled = false;
    if (tool === "eraser") {
      map.setCell(target.x, target.y, 0);
      drawCell(context, target.x, target.y);
    } else {
      // Stamp the whole brush block anchored at the cursor, clipped to the map.
      for (let row = 0; row < brush.height; row += 1) {
        for (let column = 0; column < brush.width; column += 1) {
          const x = target.x + column;
          const y = target.y + row;
          if (x >= map.width || y >= map.height) continue;
          map.setCell(x, y, blockTileIndex(brush.tile, row, column, sheet.sheetCols));
          drawCell(context, x, y);
        }
      }
    }
    drawGuides(context);
    onEdit();
  };

  const moveHover = (target: { x: number; y: number } | null) => {
    const box = hoverRef.current;
    if (box) {
      if (target) {
        // The hover box previews the brush footprint for stamps, one cell otherwise.
        const columns = tool === "stamp" ? Math.min(brush.width, map.width - target.x) : 1;
        const rows = tool === "stamp" ? Math.min(brush.height, map.height - target.y) : 1;
        box.style.display = "block";
        box.style.width = `${columns * cell}px`;
        box.style.height = `${rows * cell}px`;
        box.style.transform = `translate(${target.x * cell}px, ${target.y * cell}px)`;
      } else {
        box.style.display = "none";
      }
    }
    onHover(target);
  };

  const handleDown = (event: React.PointerEvent) => {
    const target = cellFromEvent(event);
    if (!target) return;
    painting.current = true;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    apply(target);
  };

  const handleMove = (event: React.PointerEvent) => {
    const target = cellFromEvent(event);
    moveHover(target);
    if (painting.current && target && tool !== "fill") {
      apply(target);
    }
  };

  const stop = () => {
    painting.current = false;
  };

  return (
    <div className={styles.mapViewport}>
      <div className={styles.mapContent} style={{ width, height }}>
        <canvas
          ref={canvasRef}
          className={styles.mapCanvas}
          width={width}
          height={height}
          onPointerDown={handleDown}
          onPointerMove={handleMove}
          onPointerUp={stop}
          onPointerCancel={stop}
          onPointerLeave={() => moveHover(null)}
          role="img"
          aria-label={`Map, ${map.width} by ${map.height} tiles`}
        />
        <div ref={hoverRef} className={styles.hoverBox} style={{ display: "none" }} />
      </div>
    </div>
  );
}
