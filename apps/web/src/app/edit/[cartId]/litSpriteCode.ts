/**
 * Gap #7 bridge — turn a normal-mapped sprite authored in the Assets tab into a
 * runnable, lit cart scaffold.
 *
 * Authoring a sprite's normals/material and *seeing* it relit in the Lit preview
 * is only half the job: to ship it, a creator still has to hand-write the code
 * that draws the sprite and emits lights each frame. This module writes that code
 * for them — a minimal `TIC()` that draws the exact sprite block and lights it
 * with the runtime light kinds (see [[runtime-light-types]]): a directional key
 * plus, optionally, a movable point fill. Paste it into the Code tab and the
 * engine relights the sprite's authored normals immediately.
 *
 * Pure and DOM-free so it is unit-testable and backs the one-click "Copy cart
 * code" button in the Lit preview panel (SpriteEditor.tsx).
 */

/** TIC-80 pages hold this many sprite tiles each (mirrors editor TILES_PER_PAGE). */
export const TILES_PER_PAGE = 256;

/** The palette index the sprite tools treat as transparent (the spr colorkey). */
export const TRANSPARENT_COLOR_INDEX = 0;

/** Which primary "key" light the scaffold sets up. */
export type KeyLight = "sun" | "spot" | "none";

export interface LitSpriteCodeOptions {
  /** Sprite page: 0 (foreground, ids 0..255) or 1 (background, 256..511). */
  page: 0 | 1;
  /** Index of the block's top-left tile within the page. */
  tile: number;
  /** Block size in tiles per side (1 = a single 8×8 tile). */
  tilesPerSide: number;
  /** Asset name, used only for a leading comment. */
  name?: string;
  /** True when the sprite has an authored emissive channel worth mentioning. */
  emissive?: boolean;
  /** Where to draw the block, in framebuffer pixels. Defaults to a tidy spot. */
  x?: number;
  y?: number;
  /** The key light kind. Default "sun" (a distant directional). */
  key?: KeyLight;
  /** Add a warm point fill light. Default true (false leaves only the key). */
  fill?: boolean;
}

/** The TIC-80 `spr()` id for a page + tile (id = page*256 + tile). */
export function spriteId(page: number, tile: number): number {
  return page * TILES_PER_PAGE + tile;
}

/** Lua for the chosen key light, or "" for none. */
function keyLightLua(key: KeyLight): string {
  switch (key) {
    case "sun":
      // Points TOWARD the light: a cool moon high in the upper-left.
      return "  cartbox.sun(-0.5, -0.4, 0.75, 150, 175, 230, 0.9)\n";
    case "spot":
      // A cone from the upper-right aimed down-left across the sprite.
      return "  cartbox.spot(X + N * 12, Y - N * 8, 80, -0.5, 0.7, -0.2, 220, 24, 255, 210, 150, 1.4)\n";
    case "none":
    default:
      return "";
  }
}

/**
 * Generate a runnable Lua cart that draws one authored sprite block, relit.
 *
 * The result assumes the platform mounts the cart with lighting on (the play
 * route does) and that the sprite carries authored normals/material — otherwise
 * it still runs, it simply lights a flat sprite.
 */
export function litSpriteCode(options: LitSpriteCodeOptions): string {
  const { page, tile, tilesPerSide, name, emissive } = options;
  const key: KeyLight = options.key ?? "sun";
  const fill = options.fill ?? true;
  const id = spriteId(page, tile);
  const tiles = Math.max(1, Math.trunc(tilesPerSide));
  const px = Math.trunc(options.x ?? 112);
  const py = Math.trunc(options.y ?? 60);

  const title = name ? `-- ${name} — normal-mapped sprite, relit by the engine.` : "-- Normal-mapped sprite, relit by the engine.";
  const centre = "N * 4"; // half of an N-tile block, in pixels (tile = 8px)

  const lines: string[] = [
    title,
    "-- Author the Normal + Material layers in the Assets tab; the runtime lights",
    "-- the sprite's authored normals from the lights you emit below each frame.",
    "",
    `local SPR = ${id}   -- sprite id (page ${page}, tile ${tile})`,
    `local N = ${tiles}   -- tiles per side`,
    `local X, Y = ${px}, ${py}`,
    "",
    "function TIC()",
    "  cls(0)",
    "  cartbox.clearlights()",
  ];

  const keyLua = keyLightLua(key);
  if (keyLua) lines.push(keyLua.replace(/\n$/, ""));
  if (fill) {
    lines.push(
      `  -- a warm point fill on the sprite (move X/Y or track a character with it)`,
      `  cartbox.light(X + ${centre}, Y + ${centre}, 90, 255, 190, 120, 24, 1.2)`,
    );
  }
  if (emissive) {
    lines.push("  -- this sprite has emissive pixels: they glow on their own, even unlit.");
  }
  lines.push(
    `  -- spr(id, x, y, colorkey, scale, flip, rotate, w, h)`,
    `  spr(SPR, X, Y, ${TRANSPARENT_COLOR_INDEX}, 1, 0, 0, N, N)`,
    "end",
    "",
  );
  return lines.join("\n");
}
