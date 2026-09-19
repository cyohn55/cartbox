/**
 * Rebaking a sprite-backed mesh texture.
 *
 * An era demo scene's texture is authored as an ordinary, editable region of the
 * cart's sprite sheet (see `SpriteTextureRef` and the era seeds). The runtime,
 * though, samples a mesh primitive's baked `baseColorImage`, not the sheet — so
 * for a creator's edits in the Assets tab to show in the 3D scene, the baked
 * image has to be regenerated from those sprite pixels whenever the cart is
 * playtested or saved. That regeneration is "rebaking", and this module does it.
 *
 * The read side (sprite indices + palette → RGBA) is pure and unit-tested. The
 * write side (RGBA → PNG) needs the browser's canvas, so it is injected: the
 * default encoder uses `OffscreenCanvas`, and in an environment without it
 * rebaking is skipped and the existing baked image is kept — a cart never breaks
 * for want of a rebake, it just doesn't reflect the newest pixel edit until it
 * next runs somewhere that can encode.
 */

import {
  deserializeMeshAsset,
  serializeMeshAsset,
  encodeRgbaPng,
  normalDirectionRgb,
  type MeshAsset,
} from "@cartbox/editor";

/** The slice of a sprite sheet this module reads. `SpriteSheet` satisfies it. */
export interface SheetLike {
  readonly sheetCols: number;
  readonly tileSize: number;
  getPixel(page: number, tile: number, x: number, y: number): number;
}

/** The normal directions this module reads to bake a normal map. `NormalMap`
 *  satisfies it (its `getDirection`), so a test can pass a stub. */
export interface NormalLike {
  getDirection(page: number, tile: number, x: number, y: number): number;
}

/** Encodes tightly-packed RGBA into image bytes (PNG). */
export type PngEncoder = (
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
) => Promise<Uint8Array>;

/**
 * Read a `width`×`height` region of a sprite page as straight RGBA, mapping each
 * palette index through `palette` (RGB triplets). Fully opaque — a mesh texture
 * has no alpha channel to carry. Pure: the sheet access is the only input, so a
 * test can pass a stub.
 */
export function spriteRegionToRgba(
  sheet: SheetLike,
  palette: Uint8Array,
  page: number,
  originX: number,
  originY: number,
  width: number,
  height: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  const { sheetCols, tileSize } = sheet;
  const paletteEntries = Math.floor(palette.length / 3);
  let o = 0;
  for (let py = 0; py < height; py += 1) {
    const gy = originY + py;
    const tileRow = Math.floor(gy / tileSize);
    const inY = gy % tileSize;
    for (let px = 0; px < width; px += 1) {
      const gx = originX + px;
      const tile = tileRow * sheetCols + Math.floor(gx / tileSize);
      const index = sheet.getPixel(page, tile, gx % tileSize, inY);
      const safe = index >= 0 && index < paletteEntries ? index : 0;
      out[o] = palette[safe * 3] ?? 0;
      out[o + 1] = palette[safe * 3 + 1] ?? 0;
      out[o + 2] = palette[safe * 3 + 2] ?? 0;
      out[o + 3] = 255;
      o += 4;
    }
  }
  return out;
}

/**
 * Read a `width`×`height` region of a sprite page's Normal layer as a tangent-space
 * normal map (RGBA). Each pixel's authored direction is encoded with the shared
 * `(n·0.5+0.5)·255` mapping, so an unpainted (flat) pixel is (128,128,255). Pure,
 * mirroring {@link spriteRegionToRgba}'s tiling so a test can pass stubs.
 */
export function spriteNormalRegionToRgba(
  normals: NormalLike,
  sheet: Pick<SheetLike, "sheetCols" | "tileSize">,
  page: number,
  originX: number,
  originY: number,
  width: number,
  height: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  const { sheetCols, tileSize } = sheet;
  let o = 0;
  for (let py = 0; py < height; py += 1) {
    const gy = originY + py;
    const tileRow = Math.floor(gy / tileSize);
    const inY = gy % tileSize;
    for (let px = 0; px < width; px += 1) {
      const gx = originX + px;
      const tile = tileRow * sheetCols + Math.floor(gx / tileSize);
      const direction = normals.getDirection(page, tile, gx % tileSize, inY);
      const [r, g, b] = normalDirectionRgb(direction);
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
      o += 4;
    }
  }
  return out;
}

/** Whether a normal-map RGBA buffer is entirely the flat normal (128,128,255) —
 *  i.e. nothing was painted, so no normal map is worth carrying. */
export function isFlatNormalRgba(rgba: Uint8ClampedArray): boolean {
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] !== 128 || rgba[i + 1] !== 128 || rgba[i + 2] !== 255) return false;
  }
  return true;
}

/**
 * The default encoder: the pure, deterministic PNG writer shared with the seeds'
 * initial bake. Determinism is the point — an unchanged texture rebakes to the
 * exact bytes the seed produced, so a freshly opened cart is not marked dirty the
 * first time it runs. Works in the browser and in Node (tests) alike.
 */
export const encodePng: PngEncoder = (rgba, width, height) =>
  Promise.resolve(encodeRgbaPng(rgba, width, height));

/**
 * Whether a serialized mesh sidecar has any sprite-backed texture to rebake.
 *
 * Each mesh is a nested JSON string inside the envelope, so a substring check for
 * the key is unreliable (the quotes are escaped, and every material now carries
 * `textureSprite` as `null` when absent). This parses and deserializes instead —
 * the cost is fine because rebaking runs only on Run/Save, not per frame.
 */
export function sidecarHasSpriteTexture(rawSidecar: string | null | undefined): boolean {
  if (!rawSidecar) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawSidecar);
  } catch {
    return false;
  }
  const meshes = (parsed as { meshes?: unknown }).meshes;
  if (!Array.isArray(meshes)) return false;
  for (const entry of meshes) {
    const raw = (entry as { mesh?: unknown }).mesh;
    if (typeof raw !== "string") continue;
    try {
      if (deserializeMeshAsset(raw).primitives.some((p) => p.material.textureSprite)) return true;
    } catch {
      /* skip an unparseable mesh */
    }
  }
  return false;
}

/**
 * Return a copy of the mesh sidecar with every sprite-backed primitive's
 * `baseColorImage` regenerated from the current sheet + palette. If nothing is
 * sprite-backed, or the encoder is unavailable, the original string is returned
 * unchanged so callers can use the result unconditionally.
 */
export async function rebakeMeshSidecar(
  rawSidecar: string | null | undefined,
  sheet: SheetLike,
  palette: Uint8Array,
  normals?: NormalLike,
  encode: PngEncoder = encodePng,
): Promise<string | null | undefined> {
  if (!rawSidecar || !sidecarHasSpriteTexture(rawSidecar)) return rawSidecar;

  let parsed: { version?: number; meshes?: unknown[] };
  try {
    parsed = JSON.parse(rawSidecar) as { version?: number; meshes?: unknown[] };
  } catch {
    return rawSidecar;
  }
  if (!Array.isArray(parsed.meshes)) return rawSidecar;

  const meshes = await Promise.all(
    parsed.meshes.map(async (entry) => {
      const record = entry as { mesh?: unknown };
      if (typeof record.mesh !== "string") return entry;
      let asset: MeshAsset;
      try {
        asset = deserializeMeshAsset(record.mesh);
      } catch {
        return entry;
      }
      if (!asset.primitives.some((p) => p.material.textureSprite)) return entry;

      const primitives = await Promise.all(
        asset.primitives.map(async (primitive) => {
          const ref = primitive.material.textureSprite;
          if (!ref) return primitive;
          const rgba = spriteRegionToRgba(sheet, palette, ref.page, ref.x, ref.y, ref.width, ref.height);
          let bytes: Uint8Array;
          try {
            bytes = await encode(rgba, ref.width, ref.height);
          } catch {
            return primitive; // keep the last-baked image if encoding isn't possible here
          }

          // Bake the Normal layer too (option 2), when we were handed the normals.
          // A region with no painted normals reads as flat, so it carries no map —
          // matching a seed that ships none, so a fresh cart is not marked dirty.
          let normalImage = primitive.material.normalImage ?? null;
          if (normals) {
            const nrgba = spriteNormalRegionToRgba(normals, sheet, ref.page, ref.x, ref.y, ref.width, ref.height);
            if (isFlatNormalRgba(nrgba)) {
              normalImage = null;
            } else {
              try {
                normalImage = { mime: "image/png", bytes: await encode(nrgba, ref.width, ref.height) };
              } catch {
                /* keep the last-baked normal map if encoding isn't possible here */
              }
            }
          }

          return {
            ...primitive,
            material: { ...primitive.material, baseColorImage: { mime: "image/png", bytes }, normalImage },
          };
        }),
      );
      return { ...(entry as object), mesh: serializeMeshAsset({ name: asset.name, primitives }) };
    }),
  );

  return JSON.stringify({ version: parsed.version ?? 1, meshes });
}
