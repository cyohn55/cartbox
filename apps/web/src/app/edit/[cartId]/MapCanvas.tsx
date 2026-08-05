"use client";

/**
 * The scrollable map grid, across all four map layers.
 *
 * This is the top-down half of the Map tab; {@link Map3DCanvas} is the other,
 * and both edit the same {@link MapVoxelSpace}. Looking straight down, a stack of
 * cells reads as a column, so that is what this draws and what its tools edit.
 *
 * The tile art is always the base: each cell draws the tile it references,
 * scaled to the current zoom with nearest-neighbour so pixels stay crisp. On a
 * column layer the height map is composited over that base — brightness carries
 * height, and hexel columns draw as diamonds so the lattice reads at a glance
 * without having to step into the 3D view.
 *
 * Painting redraws only what changed: one cell for a stamp, every cell sharing a
 * tile for a pixel edit, the whole map for a flood fill.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { faceTile, type CollisionMap, type MapVoxelSpace, type SpriteSheet, type TileFlags, type TileMap } from "@cartbox/editor";

import { buildWorldAtlas } from "@/lib/faceTextures";

import styles from "./editor.module.css";
import { blockTileIndex } from "./spriteBlock";
import type { MapBrush } from "./mapBrush";
import { isColumnLayer, type MapLayer, type MapTool } from "./maptools";
import type { PaintSurface } from "./paintSurface";

/** The tiles page the map references — the map can only stamp from page 0. */
const TILES_PAGE = 0;

/** Fill of a solid cell on the collision layer — a translucent red the tile shows through. */
const COLLISION_FILL = "rgba(255,64,64,0.45)";
/** Outline of a solid cell, so adjacent solids still read as separate cells. */
const COLLISION_STROKE = "rgba(255,96,96,0.9)";

/**
 * A distinct translucent colour per flag (0..7), so a tagged cell reads as its
 * flag at a glance. The order matches FLAG_LABELS in @cartbox/editor.
 */
const FLAG_FILLS: readonly string[] = [
  "rgba(255,96,64,0.5)", // 0 hazard — red-orange
  "rgba(120,200,90,0.5)", // 1 ladder — green
  "rgba(255,210,70,0.5)", // 2 platform — amber
  "rgba(80,170,255,0.5)", // 3 water — blue
  "rgba(210,110,255,0.5)", // 4 trigger — violet
  "rgba(255,140,200,0.5)", // 5 zone A — pink
  "rgba(120,235,220,0.5)", // 6 zone B — teal
  "rgba(200,200,210,0.5)", // 7 zone C — grey
];

/** How strongly a column's height brightens its overlay, at the tallest column. */
const HEIGHT_LIFT = 0.55;

/** Opacity of the column overlay, so the tile art still reads underneath it. */
const COLUMN_ALPHA = 0.88;

/** The atlas the column overlay samples: the same world materials the sculpts use. */
const WORLD_ATLAS = buildWorldAtlas();

/** Upward normal, so a column samples its material's *top* face — the map is top-down. */
const FACE_UP = 1;

interface MapCanvasProps {
  sheet: SpriteSheet;
  map: TileMap;
  /** The map's 3D cells. The voxel and hexel layers read them as columns. */
  space: MapVoxelSpace;
  layer: MapLayer;
  brush: MapBrush;
  tool: MapTool;
  /** Palette index painted by the pixel and column tools. */
  colorIndex: number;
  /**
   * The surface pixel edits are written through. It is the composite material
   * brush, so a stroke stamps the colour's material channels as well as albedo —
   * the same thing the Sprites tab's Material layer does.
   */
  pixels: PaintSurface;
  /** Texture material the column tools apply, or a negative value for flat colour. */
  columnMaterial: number;
  /** Height the Raise/Lower tools step by, and Flatten sets outright. */
  columnStep: number;
  /** The cart's per-cell solidity layer, painted and drawn on the collision layer. */
  collision: CollisionMap;
  /** The cart's per-cell tile-flags layer, painted and drawn on the flags layer. */
  flags: TileFlags;
  /** Which flag (0..7) the flags-layer tools act on and highlight. */
  activeFlag: number;
  cell: number;
  version: number;
  /** CSS colours of the cart palette, for drawing the column overlay. */
  palette: readonly string[];
  /** A cell edit landed; the caller re-reads derived state (tile picker, HUD). */
  onEdit: () => void;
  /** A stroke on the column layer finished — the caller persists the layer. */
  onColumnsCommitted: () => void;
  /** A stroke on the collision layer finished — the caller persists the layer. */
  onCollisionCommitted: () => void;
  /** A stroke on the flags layer finished — the caller persists the layer. */
  onFlagsCommitted: () => void;
  onHover: (cell: { x: number; y: number } | null) => void;
}

export function MapCanvas({
  sheet,
  map,
  space,
  layer,
  brush,
  tool,
  colorIndex,
  pixels,
  columnMaterial,
  columnStep,
  collision,
  flags,
  activeFlag,
  cell,
  version,
  palette,
  onEdit,
  onColumnsCommitted,
  onCollisionCommitted,
  onFlagsCommitted,
  onHover,
}: MapCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hoverRef = useRef<HTMLDivElement>(null);
  const painting = useRef(false);
  // Whether the stroke in progress changed the column layer, so pointer-up knows
  // whether to persist (one undo entry per stroke, not per sample).
  const columnsDirty = useRef(false);
  // Same, for the collision layer — one undo entry per stroke.
  const collisionDirty = useRef(false);
  // Same, for the flags layer.
  const flagsDirty = useRef(false);
  // The tallest column, which sets the overlay's brightness ramp. Cached because
  // a full scan per painted sample would cost more than the drawing does.
  const peakRef = useRef(1);

  const width = map.width * cell;
  const height = map.height * cell;
  const showColumns = isColumnLayer(layer);
  const showCollision = layer === "collision";
  const showFlags = layer === "flags";
  const pixelSize = cell / sheet.tileSize;

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
      image.data.set(sheet.renderTileRgba(TILES_PAGE, tile));
      context.putImageData(image, 0, 0);
      cache.push(canvas);
    }
    return cache;
  }, [sheet, version]);

  // A column skinned with a material draws that material's top face, which is
  // what you would actually see looking down at it. Rasterised once per
  // material, like the tile cache, so the overlay stays a blit.
  const materialCache = useMemo(() => {
    const cache = new Map<number, HTMLCanvasElement>();
    const count = WORLD_ATLAS.materials?.length ?? 0;
    for (let material = 0; material < count; material += 1) {
      const texture = faceTile(WORLD_ATLAS, material, FACE_UP);
      if (!texture) continue;
      const canvas = document.createElement("canvas");
      canvas.width = texture.size;
      canvas.height = texture.size;
      const context = canvas.getContext("2d")!;
      const image = context.createImageData(texture.size, texture.size);
      image.data.set(texture.data);
      context.putImageData(image, 0, 0);
      cache.set(material, canvas);
    }
    return cache;
  }, []);

  /** Re-rasterise one cached tile after its pixels changed. */
  const refreshTile = useCallback(
    (tile: number) => {
      const canvas = tileCache[tile];
      if (!canvas) return;
      const context = canvas.getContext("2d");
      if (!context) return;
      const image = context.createImageData(sheet.tileSize, sheet.tileSize);
      image.data.set(sheet.renderTileRgba(TILES_PAGE, tile));
      context.putImageData(image, 0, 0);
    },
    [tileCache, sheet],
  );

  /** Paint the column overlay for one cell, if it carries a column. */
  const drawColumn = useCallback(
    (context: CanvasRenderingContext2D, x: number, y: number) => {
      const column = space.columnAt(x, y);
      if (!column) return;
      const px = x * cell;
      const py = y * cell;

      const texture = column.material >= 0 ? materialCache.get(column.material) : undefined;
      context.save();
      context.globalAlpha = COLUMN_ALPHA;
      if (texture) {
        // A skinned column shows its material's art; clip it to the cell shape so
        // hexels stay diamonds.
        if (space.shape === "hexel") {
          context.beginPath();
          context.moveTo(px + cell / 2, py);
          context.lineTo(px + cell, py + cell / 2);
          context.lineTo(px + cell / 2, py + cell);
          context.lineTo(px, py + cell / 2);
          context.closePath();
          context.clip();
        }
        context.imageSmoothingEnabled = false;
        context.drawImage(texture, px, py, cell, cell);
        context.globalAlpha = (column.height / Math.max(1, peakRef.current)) * HEIGHT_LIFT;
        context.fillStyle = "#ffffff";
        context.fillRect(px, py, cell, cell);
        context.restore();
        return;
      }
      context.fillStyle = palette[column.colorIndex] ?? "#ffffff";
      if (space.shape === "hexel") {
        // Hexels close-pack on a diagonal lattice; drawing them as diamonds makes
        // that legible from the top down without stepping into the 3D view.
        context.beginPath();
        context.moveTo(px + cell / 2, py);
        context.lineTo(px + cell, py + cell / 2);
        context.lineTo(px + cell / 2, py + cell);
        context.lineTo(px, py + cell / 2);
        context.closePath();
        context.fill();
      } else {
        context.fillRect(px, py, cell, cell);
      }
      // Taller columns read as closer to the light, which is what turns a flat
      // colour field into something that looks like terrain from above.
      context.globalAlpha = (column.height / Math.max(1, peakRef.current)) * HEIGHT_LIFT;
      context.fillStyle = "#ffffff";
      context.fillRect(px, py, cell, cell);
      context.restore();
    },
    [space, cell, palette, materialCache],
  );

  /** Paint the collision overlay for one cell, when it is marked solid. */
  const drawCollision = useCallback(
    (context: CanvasRenderingContext2D, x: number, y: number) => {
      if (!collision.isSolid(x, y)) return;
      const px = x * cell;
      const py = y * cell;
      context.fillStyle = COLLISION_FILL;
      context.fillRect(px, py, cell, cell);
      context.strokeStyle = COLLISION_STROKE;
      context.lineWidth = 1;
      context.strokeRect(px + 0.5, py + 0.5, cell - 1, cell - 1);
    },
    [collision, cell],
  );

  /** Paint the flags overlay for one cell: the active flag, plus a dot per other set flag. */
  const drawFlags = useCallback(
    (context: CanvasRenderingContext2D, x: number, y: number) => {
      const px = x * cell;
      const py = y * cell;
      // The active flag fills the cell so it reads as the thing you're painting.
      if (flags.get(x, y, activeFlag)) {
        context.fillStyle = FLAG_FILLS[activeFlag] ?? COLLISION_FILL;
        context.fillRect(px, py, cell, cell);
      }
      // Other flags on this cell show as small corner dots, so a cell's full set is
      // visible without switching flags — but the active one still dominates.
      let slot = 0;
      const dot = Math.max(2, Math.floor(cell / 6));
      for (let bit = 0; bit < FLAG_FILLS.length; bit += 1) {
        if (bit === activeFlag || !flags.get(x, y, bit)) continue;
        context.fillStyle = FLAG_FILLS[bit]!;
        context.fillRect(px + 1 + slot * (dot + 1), py + 1, dot, dot);
        slot += 1;
      }
    },
    [flags, activeFlag, cell],
  );

  const drawCell = useCallback(
    (context: CanvasRenderingContext2D, x: number, y: number) => {
      const tile = tileCache[map.getCell(x, y)];
      if (tile) context.drawImage(tile, x * cell, y * cell, cell, cell);
      if (showColumns) drawColumn(context, x, y);
      if (showCollision) drawCollision(context, x, y);
      if (showFlags) drawFlags(context, x, y);
    },
    [tileCache, map, cell, showColumns, drawColumn, showCollision, drawCollision, showFlags, drawFlags],
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
    peakRef.current = Math.max(1, space.peakHeight);
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, width, height);
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        drawCell(context, x, y);
      }
    }
    drawGuides(context);
  }, [map, space, width, height, drawCell, drawGuides]);

  useEffect(() => {
    renderAll();
  }, [renderAll]);

  /** Redraw every cell that references a tile, after that tile's pixels changed. */
  const redrawTileUsers = (context: CanvasRenderingContext2D, tile: number) => {
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        if (map.getCell(x, y) === tile) drawCell(context, x, y);
      }
    }
    drawGuides(context);
  };

  /** Canvas-relative pointer position in map-pixel space, or null when outside. */
  const positionFromEvent = (event: React.PointerEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const cellFromEvent = (event: React.PointerEvent): { x: number; y: number } | null => {
    const position = positionFromEvent(event);
    if (!position) return null;
    const x = Math.floor(position.x / cell);
    const y = Math.floor(position.y / cell);
    if (x < 0 || x >= map.width || y < 0 || y >= map.height) return null;
    return { x, y };
  };

  /** The pixel within a cell's tile that the pointer is over. */
  const pixelWithinCell = (event: React.PointerEvent, target: { x: number; y: number }) => {
    const position = positionFromEvent(event);
    if (!position) return null;
    const px = Math.floor((position.x - target.x * cell) / pixelSize);
    const py = Math.floor((position.y - target.y * cell) / pixelSize);
    if (px < 0 || px >= sheet.tileSize || py < 0 || py >= sheet.tileSize) return null;
    return { px, py };
  };

  /** Apply a tile-layer tool at a cell. */
  const applyTiles = (context: CanvasRenderingContext2D, target: { x: number; y: number }) => {
    if (tool === "fill") {
      map.fill(target.x, target.y, brush.tile);
      onEdit();
      return;
    }
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

  /** Apply a pixel-layer tool, writing into the tile the cell references. */
  const applyPixels = (
    context: CanvasRenderingContext2D,
    target: { x: number; y: number },
    event: React.PointerEvent,
  ) => {
    const local = pixelWithinCell(event, target);
    if (!local) return;
    const tile = map.getCell(target.x, target.y);
    const value = tool === "eraser" ? 0 : colorIndex;
    // Through the material surface, so the fill and the pencil both carry each
    // colour's material profile into the channel banks.
    if (tool === "pixelFill") pixels.fill(TILES_PAGE, tile, local.px, local.py, value);
    else pixels.setPixel(TILES_PAGE, tile, local.px, local.py, value);
    // Tiles are shared, so one pixel edit can change many cells at once.
    refreshTile(tile);
    redrawTileUsers(context, tile);
  };

  /** Apply a column-layer tool at a cell. */
  const applyColumns = (context: CanvasRenderingContext2D, target: { x: number; y: number }) => {
    switch (tool) {
      case "raise":
        space.raise(target.x, target.y, columnStep, colorIndex, columnMaterial);
        break;
      case "lower":
        space.raise(target.x, target.y, -columnStep, colorIndex, columnMaterial);
        break;
      case "paint":
        // Painting always restyles: it is the tool for changing how a column
        // looks, so it applies the armed material (or clears it, when flat).
        space.paintColumn(target.x, target.y, colorIndex, columnMaterial);
        break;
      case "flatten":
        space.setColumn(target.x, target.y, columnStep, colorIndex, columnMaterial);
        break;
      case "eraser":
        space.clearColumn(target.x, target.y);
        break;
      default:
        return;
    }
    columnsDirty.current = true;
    // A new tallest column rescales the whole overlay's ramp, so redraw it all;
    // otherwise just the touched cell needs repainting.
    const height = space.heightAt(target.x, target.y);
    if (height > peakRef.current) {
      renderAll();
    } else {
      context.clearRect(target.x * cell, target.y * cell, cell, cell);
      drawCell(context, target.x, target.y);
      drawGuides(context);
    }
  };

  /** Apply a collision-layer tool at a cell. */
  const applyCollision = (context: CanvasRenderingContext2D, target: { x: number; y: number }) => {
    if (tool === "fill") {
      // Flood the connected run of matching cells to the opposite value, so one
      // fill both solidifies an open area and clears an enclosed solid one.
      collision.fill(target.x, target.y, !collision.isSolid(target.x, target.y));
      collisionDirty.current = true;
      renderAll();
      return;
    }
    collision.setSolid(target.x, target.y, tool === "solid");
    collisionDirty.current = true;
    context.clearRect(target.x * cell, target.y * cell, cell, cell);
    drawCell(context, target.x, target.y);
    drawGuides(context);
  };

  /** Apply a flags-layer tool at a cell, acting on the active flag. */
  const applyFlags = (context: CanvasRenderingContext2D, target: { x: number; y: number }) => {
    if (tool === "fill") {
      // Flood the connected run sharing the active flag's value to the opposite,
      // so one fill both tags an open area and clears an enclosed tagged one.
      flags.fill(target.x, target.y, activeFlag, !flags.get(target.x, target.y, activeFlag));
      flagsDirty.current = true;
      renderAll();
      return;
    }
    flags.set(target.x, target.y, activeFlag, tool === "flag");
    flagsDirty.current = true;
    context.clearRect(target.x * cell, target.y * cell, cell, cell);
    drawCell(context, target.x, target.y);
    drawGuides(context);
  };

  const apply = (target: { x: number; y: number }, event: React.PointerEvent) => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    context.imageSmoothingEnabled = false;
    if (showColumns) applyColumns(context, target);
    else if (showCollision) applyCollision(context, target);
    else if (showFlags) applyFlags(context, target);
    else if (layer === "pixels") applyPixels(context, target, event);
    else applyTiles(context, target);
  };

  const moveHover = (target: { x: number; y: number } | null) => {
    const box = hoverRef.current;
    if (box) {
      if (target) {
        // The hover box previews what the active tool will touch: the brush
        // footprint for a tile stamp, a single cell otherwise.
        const columnsWide = layer === "tiles" && tool === "stamp" ? Math.min(brush.width, map.width - target.x) : 1;
        const rows = layer === "tiles" && tool === "stamp" ? Math.min(brush.height, map.height - target.y) : 1;
        box.style.display = "block";
        box.style.width = `${columnsWide * cell}px`;
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
    apply(target, event);
  };

  const handleMove = (event: React.PointerEvent) => {
    const target = cellFromEvent(event);
    moveHover(target);
    // Flood fills are a single action; dragging them would refill continuously.
    if (painting.current && target && tool !== "fill" && tool !== "pixelFill") {
      apply(target, event);
    }
  };

  const stop = () => {
    if (!painting.current) return;
    painting.current = false;
    // One history entry per stroke: pixel, column and collision strokes report at
    // the end rather than on every sample the pointer produced.
    if (columnsDirty.current) {
      columnsDirty.current = false;
      onColumnsCommitted();
    } else if (collisionDirty.current) {
      collisionDirty.current = false;
      onCollisionCommitted();
    } else if (flagsDirty.current) {
      flagsDirty.current = false;
      onFlagsCommitted();
    } else if (layer === "pixels") {
      onEdit();
    }
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
