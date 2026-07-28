/**
 * Skin voxels with sprites drawn in the editor's own Sprites tab.
 *
 * The world's materials ship as hand-authored art (see {@link AUTHORED_TILES}),
 * but a cart's sprites are the same thing in a different store: a square of
 * indexed pixels. This module reads one out of the sprite sheet, resolves it
 * through the cart palette into the straight-alpha RGBA a {@link FaceTexture}
 * wants, and appends it to a {@link TextureAtlas} as a material — so a sprite can
 * skin a voxel exactly like `grass` or `brick` do, per face.
 *
 * Sprite-backed materials are appended *after* the base atlas's own, so the base
 * material indices a sculpt already uses never shift. Pure and DOM-free: the
 * sheet arrives as the small {@link SpritePixelSource} interface, which the real
 * `SpriteSheet` satisfies structurally and a test can supply directly.
 */

import {
  normalVector,
  spriteToFaceTexture,
  type FaceMaterial,
  type FaceTexture,
  type SpritePage,
  type TextureAtlas,
} from "@cartbox/editor";

/** The palette index the sprite tools treat as transparent (nothing drawn). */
export const TRANSPARENT_COLOR_INDEX = 0;

/** The part of a sprite sheet needed to read a sprite as pixels. */
export interface SpritePixelSource {
  /** Edge length of one sprite, in pixels. */
  readonly tileSize: number;
  /** The palette index at (x, y) of a sprite. */
  getPixel(page: SpritePage, tile: number, x: number, y: number): number;
  /** The cart palette as RGB triplets, index order. */
  paletteRgb(): ReadonlyArray<readonly [number, number, number]>;
}

/**
 * The cart's per-pixel material channels, as the Material layer authors them.
 *
 * A sprite is not only colour: the editor paints a normal direction, a height, a
 * specular level, a roughness and an emissive level onto every pixel of it. Those
 * channels are the difference between a wall that is a picture of brick and a
 * wall that *is* brick — the light has to have something to respond to. Passing
 * them here is what carries an author's material work out of the Sprites tab and
 * onto the surfaces of the world.
 *
 * Optional throughout: a sheet with no channels still skins a cell perfectly
 * well, its relief simply derived from the art instead of read from the cart.
 */
export interface SpriteChannelSource {
  /** How many levels a scalar channel has; level `levels - 1` is full. */
  readonly levels: number;
  /** Normal direction index at a pixel, resolved through the shared table. */
  normalDirection(page: SpritePage, tile: number, x: number, y: number): number;
  height(page: SpritePage, tile: number, x: number, y: number): number;
  specular(page: SpritePage, tile: number, x: number, y: number): number;
  roughness(page: SpritePage, tile: number, x: number, y: number): number;
  emissive(page: SpritePage, tile: number, x: number, y: number): number;
}

/** A sprite, addressed the way the sheet addresses it. */
export interface SpriteRef {
  readonly page: SpritePage;
  readonly tile: number;
}

/**
 * A material skinned by sprites: which sprite covers each face group. Uniform
 * materials simply name the same sprite three times (see
 * {@link uniformSpriteMaterial}).
 */
export interface SpriteMaterial {
  /** Shown in the palette; the author's label for this skin. */
  readonly name: string;
  readonly top: SpriteRef;
  readonly side: SpriteRef;
  readonly bottom: SpriteRef;
}

/** Whether a value is a usable sprite address (a real sheet slot). */
export function isSpriteRef(value: unknown): value is SpriteRef {
  if (typeof value !== "object" || value === null) return false;
  const { page, tile } = value as { page?: unknown; tile?: unknown };
  return (page === 0 || page === 1) && Number.isInteger(tile) && (tile as number) >= 0;
}

/**
 * Whether a sprite is entirely transparent — nothing drawn in it yet. Worth
 * asking before skinning a voxel with one: the renderer skips transparent texels,
 * so an empty sprite would make the face vanish rather than look wrong, which is
 * a confusing way to learn the sprite was blank.
 */
export function isBlankSprite(
  source: SpritePixelSource,
  sprite: SpriteRef,
  transparentIndex: number = TRANSPARENT_COLOR_INDEX,
): boolean {
  if (!isSpriteRef(sprite)) return true;
  for (let y = 0; y < source.tileSize; y += 1) {
    for (let x = 0; x < source.tileSize; x += 1) {
      if (source.getPixel(sprite.page, sprite.tile, x, y) !== transparentIndex) return false;
    }
  }
  return true;
}

/** A material whose three face groups all show the one sprite. */
export function uniformSpriteMaterial(name: string, sprite: SpriteRef): SpriteMaterial {
  return { name, top: sprite, side: sprite, bottom: sprite };
}

/**
 * Read a sprite as a face tile: each pixel resolved through the cart palette,
 * with the transparent index left fully transparent so the tile shows the voxel's
 * silhouette rather than a black square.
 *
 * Sprites are drawn in the cart's own colours, so — unlike the greyscale console
 * tiles — a sprite tile is true-colour art and reads as painted on a white voxel.
 */
export function spriteFaceTexture(
  source: SpritePixelSource,
  sprite: SpriteRef,
  transparentIndex: number = TRANSPARENT_COLOR_INDEX,
  channels?: SpriteChannelSource,
): FaceTexture {
  if (!isSpriteRef(sprite)) {
    throw new Error(`not a sprite address: ${JSON.stringify(sprite)}`);
  }
  const size = source.tileSize;
  const palette = source.paletteRgb();
  const pixels = new Uint8ClampedArray(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = source.getPixel(sprite.page, sprite.tile, x, y);
      const base = (y * size + x) * 4;
      if (index === transparentIndex) continue; // leave RGBA at 0 — a hole in the tile
      const colour = palette[index] ?? [255, 255, 255];
      pixels[base] = colour[0];
      pixels[base + 1] = colour[1];
      pixels[base + 2] = colour[2];
      pixels[base + 3] = 255;
    }
  }
  const texture = spriteToFaceTexture(pixels, size, size);
  return channels ? { ...texture, ...readChannels(source, sprite, channels) } : texture;
}

/**
 * Read a sprite's authored material channels into the tile's own buffers.
 *
 * A channel that is blank everywhere is left off entirely rather than written as
 * zeros, because "the author painted nothing here" and "the author painted zero
 * here" mean opposite things downstream: the first should fall back to relief
 * derived from the art, and the second is a deliberate flat, dull, unlit surface.
 */
function readChannels(
  source: SpritePixelSource,
  sprite: SpriteRef,
  channels: SpriteChannelSource,
): Partial<FaceTexture> {
  const size = source.tileSize;
  const count = size * size;
  const normal = new Uint8Array(count * 3);
  const height = new Uint8Array(count);
  const specular = new Uint8Array(count);
  const roughness = new Uint8Array(count);
  const emissive = new Uint8Array(count);
  const top = Math.max(1, channels.levels - 1);
  let paintedNormal = false;
  let paintedHeight = false;
  let paintedSpecular = false;
  let paintedRoughness = false;
  let paintedEmissive = false;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = y * size + x;
      const direction = channels.normalDirection(sprite.page, sprite.tile, x, y);
      if (direction > 0) paintedNormal = true;
      // The cart stores a screen-space normal with y running down the image, and
      // a tile's own v runs down it too, so the two agree without a flip.
      const [nx, ny, nz] = normalVector(direction);
      normal[at * 3] = Math.round(nx * 127.5 + 127.5);
      normal[at * 3 + 1] = Math.round(ny * 127.5 + 127.5);
      normal[at * 3 + 2] = Math.round(nz * 127.5 + 127.5);

      const scale = (value: number) => Math.round((Math.max(0, Math.min(top, value)) / top) * 255);
      const h = channels.height(sprite.page, sprite.tile, x, y);
      const s = channels.specular(sprite.page, sprite.tile, x, y);
      const r = channels.roughness(sprite.page, sprite.tile, x, y);
      const e = channels.emissive(sprite.page, sprite.tile, x, y);
      if (h > 0) paintedHeight = true;
      if (s > 0) paintedSpecular = true;
      if (r > 0) paintedRoughness = true;
      if (e > 0) paintedEmissive = true;
      height[at] = scale(h);
      specular[at] = scale(s);
      roughness[at] = scale(r);
      emissive[at] = scale(e);
    }
  }

  return {
    ...(paintedNormal ? { normal } : {}),
    ...(paintedHeight ? { height } : {}),
    ...(paintedSpecular ? { specular } : {}),
    ...(paintedRoughness ? { roughness } : {}),
    ...(paintedEmissive ? { emissive } : {}),
  };
}

/**
 * The material index the first sprite-backed material occupies in an atlas built
 * from `base` — i.e. how many materials the base already defines. Sprite
 * materials land at this index and upward, in list order, so
 * `firstSpriteMaterialIndex(base) + n` addresses the nth.
 */
export function firstSpriteMaterialIndex(base: TextureAtlas): number {
  return base.materials?.length ?? base.tiles.length;
}

/**
 * Extend an atlas with sprite-backed materials. The base atlas's tiles and
 * materials are carried through untouched (a base without explicit materials gets
 * the implicit one-tile-per-material mapping it already renders with), then each
 * sprite material appends its tiles — sharing a slot when two faces name the same
 * sprite — and one face map.
 *
 * The result is a plain atlas: nothing downstream needs to know some of its art
 * came from sprites.
 */
export function buildSpriteMaterialAtlas(
  base: TextureAtlas,
  materials: readonly SpriteMaterial[],
  source: SpritePixelSource,
  channels?: SpriteChannelSource,
): TextureAtlas {
  const tiles: FaceTexture[] = [...base.tiles];
  const faces: FaceMaterial[] = base.materials
    ? [...base.materials]
    : base.tiles.map((_tile, index) => ({ top: index, side: index, bottom: index }));

  // One tile per distinct sprite: a uniform material costs a single slot, and two
  // materials sharing a sprite share its tile.
  const slotBySprite = new Map<string, number>();
  const slotFor = (sprite: SpriteRef): number => {
    const key = `${sprite.page}:${sprite.tile}`;
    const existing = slotBySprite.get(key);
    if (existing !== undefined) return existing;
    const slot = tiles.length;
    tiles.push(spriteFaceTexture(source, sprite, TRANSPARENT_COLOR_INDEX, channels));
    slotBySprite.set(key, slot);
    return slot;
  };

  for (const material of materials) {
    faces.push({
      top: slotFor(material.top),
      side: slotFor(material.side),
      bottom: slotFor(material.bottom),
    });
  }
  return { tiles, materials: faces };
}
