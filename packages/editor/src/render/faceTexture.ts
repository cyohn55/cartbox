/**
 * Pixel-art textures for cell faces — how authored sprite art skins the 3D world.
 *
 * A flat-shaded voxel shows one colour per face; a *textured* voxel samples a
 * small square of pixels across each face instead, so the same art authored in
 * the sprite editor becomes the surface of terrain, buildings and props. Faces
 * are parallelograms and the projection is affine, so the renderer's existing
 * per-pixel parallelogram coordinates already are the face's UVs — sampling is
 * nearly free on top of the flat fill (see fillTexturedQuad in
 * voxelModelRenderer.ts).
 *
 * A {@link FaceTexture} is exactly a straight-alpha RGBA image (the same format
 * the sprite editor produces), so real authored tiles drop in unchanged; the demo
 * simply generates procedural ones. Pure data, DOM-free.
 */

/** A single square tile applied across a cell face. */
export interface FaceTexture {
  /** Edge length in texels; the data is `size * size * 4` straight-alpha RGBA. */
  readonly size: number;
  /** RGBA texels; alpha 0 marks a hole the face shows through (like a sprite). */
  readonly data: Uint8ClampedArray;
  /**
   * Optional per-texel self-emissive strength (`size * size`, 0..255). Lets a
   * texture glow in shadow (a lit screen, lava, a rune) independently of the
   * voxel's own emissive. Absent means the tile is fully lit by the scene.
   */
  readonly emissive?: Uint8Array;
  /**
   * Optional tangent-space normals, three bytes per texel (x, y, z each encoded
   * `value * 127.5 + 127.5`) — the same encoding a normal-map image uses. This is
   * what makes a flat quad of brick read as *brick* rather than as a picture of
   * brick: the light responds to the mortar lines as the view moves.
   */
  readonly normal?: Uint8Array;
  /** Optional per-texel height, 0..255. Drives parallax and self-occlusion. */
  readonly height?: Uint8Array;
  /** Optional per-texel specular strength, 0..255 (how much it glints). */
  readonly specular?: Uint8Array;
  /** Optional per-texel roughness, 0..255 (0 = mirror-tight highlight). */
  readonly roughness?: Uint8Array;
}

/**
 * A material: which tile skins a voxel's faces, chosen by each face's facing.
 * Real surfaces differ top from side from bottom — grass caps a dirt block, a log
 * shows rings on its ends and bark around its sides — so a material names a tile
 * per face group rather than one tile for the whole voxel. Each field is a tile
 * index into the atlas, or negative to leave that face flat (its voxel colour).
 */
export interface FaceMaterial {
  /** Tile for upward faces (normal.y above {@link MATERIAL_TOP_THRESHOLD}). */
  readonly top: number;
  /** Tile for sideways faces (the near-horizontal ones). */
  readonly side: number;
  /** Tile for downward faces (normal.y below the negated threshold). */
  readonly bottom: number;
}

/**
 * A set of tiles a model's voxels index into, and optional {@link FaceMaterial}s
 * that map a face to a tile. A voxel's `tile` value is an index: into `materials` when
 * that array is present (per-face skinning), otherwise straight into `tiles` (one
 * tile on every face — the original behaviour). Out-of-range or negative indices
 * fall back to the voxel's flat colour, so a partially textured model is fine.
 */
export interface TextureAtlas {
  readonly tiles: readonly FaceTexture[];
  /**
   * Optional per-material face mappings. When present, a voxel's `tile` indexes
   * this array and each face samples the material's top/side/bottom tile; when
   * absent, `tile` indexes {@link tiles} directly and skins every face alike.
   */
  readonly materials?: readonly FaceMaterial[];
}

/**
 * How steeply-up a face's model-space normal must point to count as a "top" face
 * (and, negated, as a "bottom"); everything between is a "side". Half splits a
 * cube cleanly — its top/bottom read 1/−1 and its sides 0 — while still catching
 * a hexel's slanted upper rhombi as caps.
 */
export const MATERIAL_TOP_THRESHOLD = 0.5;

/** The tile at `index`, or `undefined` when the index has no tile (draw flat). */
export function tileAt(atlas: TextureAtlas | undefined, index: number): FaceTexture | undefined {
  if (!atlas || index < 0) return undefined;
  return atlas.tiles[index];
}

/**
 * The tile a face should sample, given the voxel's `tile` index and that face's
 * model-space upward component `normalY`. With materials, the index selects a
 * material and `normalY` selects its top/side/bottom tile; without materials it
 * behaves like {@link tileAt} (one tile on every face). Returns `undefined` to
 * draw the face flat.
 */
export function faceTile(
  atlas: TextureAtlas | undefined,
  index: number,
  normalY: number,
): FaceTexture | undefined {
  if (!atlas || index < 0) return undefined;
  const materials = atlas.materials;
  if (!materials) return atlas.tiles[index];
  const material = materials[index];
  if (!material) return undefined;
  const slot =
    normalY > MATERIAL_TOP_THRESHOLD
      ? material.top
      : normalY < -MATERIAL_TOP_THRESHOLD
        ? material.bottom
        : material.side;
  return tileAt(atlas, slot);
}

/**
 * Adapt authored sprite pixels into a {@link FaceTexture} atlas slot. The sprite
 * editor already emits straight-alpha RGBA — the tile format — so this is nearly
 * an identity: it only requires the art be square (a face samples a square tile)
 * and copies the pixels so the tile owns its buffer. `emissive` is the optional
 * per-texel glow the editor's material layer produces. This is the seam that lets
 * real drawn art drop straight into the world with no renderer change.
 */
export function spriteToFaceTexture(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  emissive?: Uint8Array,
): FaceTexture {
  if (width !== height) {
    throw new Error(`a face tile must be square; got ${width}x${height}`);
  }
  if (pixels.length < width * height * 4) {
    throw new Error(`pixel buffer too small for ${width}x${height} RGBA`);
  }
  const data = pixels.slice(0, width * height * 4);
  if (emissive && emissive.some((value) => value > 0)) {
    return { size: width, data, emissive: emissive.slice(0, width * height) };
  }
  return { size: width, data };
}
