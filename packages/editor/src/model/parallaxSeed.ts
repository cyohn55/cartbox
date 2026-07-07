/**
 * Seeds a cart with a multi-layer parallax scene. Like seedDemoCart, it is
 * written against the CartEngine interface so the same content populates the
 * in-memory stub and a freshly created WASM cartridge identically.
 *
 * A single PARALLAX_LAYERS config is the source of truth: it drives both the
 * map stamping (the hill silhouettes baked into map memory) and the generated
 * Lua that scrolls each band. Because the layout and the runtime code come from
 * the same data, they can never drift apart.
 *
 * Parallax works by drawing one shared camera position (`cam`) across several
 * map bands, each offset by the camera scaled by its own depth factor. Far
 * layers (small depth) barely move; the near layer (depth 1.0) moves fastest,
 * which the eye reads as distance.
 */

import type { CartEngine } from "../engine/CartEngine";
import {
  MAP_HEIGHT,
  MAP_SCREEN_HEIGHT,
  MAP_SCREEN_WIDTH,
  MAP_WIDTH,
  TILE_SIZE,
} from "../engine/CartEngine";
import { paletteForModel, hexToRgb } from "./palette";

/** A single parallax band: its tiles, how fast it scrolls, and its hill shape. */
interface ParallaxLayer {
  /** Label used only for readability and tests. */
  readonly name: string;
  /** Tile index this layer stamps into map memory. */
  readonly tile: number;
  /** Palette index the layer's solid tile is painted with. */
  readonly colorIndex: number;
  /** Fraction of the camera this band moves by (0 = still, 1 = full speed). */
  readonly depth: number;
  /** Columns per silhouette repeat; also the seamless-loop period. */
  readonly periodColumns: number;
  /** Extra hill height, in cells, added on top of the baseline at each peak. */
  readonly amplitudeCells: number;
  /** Minimum filled height, in cells, from the bottom of the band. */
  readonly baselineCells: number;
}

/** Tile index for an empty map cell; every cart reserves tile 0 as blank. */
const EMPTY_TILE = 0;
/** Palette index the sky is cleared to each frame (Sweetie-16 light blue). */
const SKY_COLOR_INDEX = 10;
/** Palette index the on-screen hint text is drawn in (Sweetie-16 white). */
const TEXT_COLOR_INDEX = 12;
/** Base camera step per frame, in pixels, before per-layer depth scaling. */
const AUTO_SCROLL_PIXELS_PER_FRAME = 1;

/**
 * Layers are ordered far -> near so they stamp and draw back-to-front. Each
 * layer owns a horizontal band of map rows `MAP_SCREEN_HEIGHT` tall, indexed by
 * its position here (far = band 0, near = band 2).
 */
const PARALLAX_LAYERS: readonly ParallaxLayer[] = [
  {
    name: "far",
    tile: 1,
    colorIndex: 13,
    depth: 0.25,
    periodColumns: 20,
    amplitudeCells: 5,
    baselineCells: 3,
  },
  {
    name: "mid",
    tile: 2,
    colorIndex: 5,
    depth: 0.5,
    periodColumns: 12,
    amplitudeCells: 4,
    baselineCells: 4,
  },
  {
    name: "near",
    tile: 3,
    colorIndex: 6,
    depth: 1,
    periodColumns: 8,
    amplitudeCells: 3,
    baselineCells: 6,
  },
];

/** Top map row of the band belonging to the layer at `layerIndex`. */
function bandTopRow(layerIndex: number): number {
  return layerIndex * MAP_SCREEN_HEIGHT;
}

/**
 * Height, in cells, of the hill silhouette at a given column. A triangle wave
 * over the layer's period gives rolling hills that repeat exactly every
 * `periodColumns`, which is what makes the scroll loop seamlessly.
 */
function silhouetteHeight(layer: ParallaxLayer, column: number): number {
  const phase = (column % layer.periodColumns) / layer.periodColumns;
  const triangle = 1 - Math.abs(2 * phase - 1);
  const height = layer.baselineCells + Math.round(layer.amplitudeCells * triangle);
  return Math.min(height, MAP_SCREEN_HEIGHT);
}

/** Paint a tile as a flat block of one palette color across all 8x8 pixels. */
function paintSolidTile(engine: CartEngine, tile: number, colorIndex: number): void {
  for (let y = 0; y < TILE_SIZE; y += 1) {
    for (let x = 0; x < TILE_SIZE; x += 1) {
      engine.setPixel(0, tile, x, y, colorIndex);
    }
  }
}

/**
 * Stamp one layer's hills into its band. The band is cleared to the empty tile
 * first so the result is deterministic no matter what the map held before, then
 * every column across the full map width is filled up to its silhouette height
 * so the runtime can scroll without ever running off stamped cells.
 */
function stampLayerBand(engine: CartEngine, layer: ParallaxLayer, layerIndex: number): void {
  const bandTop = bandTopRow(layerIndex);
  const bandBottom = bandTop + MAP_SCREEN_HEIGHT - 1;
  for (let column = 0; column < MAP_WIDTH; column += 1) {
    for (let row = bandTop; row <= bandBottom; row += 1) {
      engine.setMapCell(column, row, EMPTY_TILE);
    }
    const height = silhouetteHeight(layer, column);
    for (let filled = 0; filled < height; filled += 1) {
      engine.setMapCell(column, bandBottom - filled, layer.tile);
    }
  }
}

/**
 * Build the Lua that scrolls the bands. One `map` call per layer, each offset
 * by the camera times its depth and wrapped at the layer's pixel period so it
 * loops seamlessly. Drawing `periodColumns + 1` extra columns covers the offset
 * so no gap opens at the right edge as content scrolls in.
 */
export function buildParallaxCode(layers: readonly ParallaxLayer[] = PARALLAX_LAYERS): string {
  const drawLines = layers
    .map((layer, layerIndex) => {
      const drawColumns = MAP_SCREEN_WIDTH + layer.periodColumns + 1;
      const periodPixels = layer.periodColumns * TILE_SIZE;
      const offset = `-((cam*${layer.depth})%${periodPixels})`;
      return ` map(0,${bandTopRow(layerIndex)},${drawColumns},${MAP_SCREEN_HEIGHT},${offset},0)`;
    })
    .join("\n");

  return `-- title:  parallax demo
-- author: cartbox
-- desc:   multi-layer parallax scroll
-- script: lua

cam=0

function TIC()
 local speed=${AUTO_SCROLL_PIXELS_PER_FRAME}
 if btn(2) then speed=-2 end
 if btn(3) then speed=3 end
 cam=cam+speed

 cls(${SKY_COLOR_INDEX})
${drawLines}
 print("PARALLAX  hold LEFT/RIGHT",6,6,${TEXT_COLOR_INDEX})
end
`;
}

/** The generated starter code for the parallax cart. */
export const PARALLAX_CODE = buildParallaxCode();

/** Populate `engine` with the parallax palette, tiles, map bands, and code. */
export function seedParallaxDemoCart(engine: CartEngine): void {
  paletteForModel(engine.model()).forEach((hex, index) => {
    const [red, green, blue] = hexToRgb(hex);
    engine.setPaletteColor(index, red, green, blue);
  });

  PARALLAX_LAYERS.forEach((layer, layerIndex) => {
    paintSolidTile(engine, layer.tile, layer.colorIndex);
    stampLayerBand(engine, layer, layerIndex);
  });

  engine.setLanguage("lua");
  engine.setCode(PARALLAX_CODE);
}

export { PARALLAX_LAYERS, silhouetteHeight, bandTopRow, type ParallaxLayer };

// Guard against a config whose bands would not fit in map memory. This is a
// load-time invariant of the layout, not a per-call check.
if (bandTopRow(PARALLAX_LAYERS.length) > MAP_HEIGHT) {
  throw new Error("parallax layers exceed map height");
}
