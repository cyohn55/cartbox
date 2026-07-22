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
}

/**
 * A set of tiles a model's voxels index into. A voxel's `tile` value is an index
 * here; out-of-range or negative indices fall back to the voxel's flat colour, so
 * a partially textured model is fine.
 */
export interface TextureAtlas {
  readonly tiles: readonly FaceTexture[];
}

/** The tile at `index`, or `undefined` when the index has no tile (draw flat). */
export function tileAt(atlas: TextureAtlas | undefined, index: number): FaceTexture | undefined {
  if (!atlas || index < 0) return undefined;
  return atlas.tiles[index];
}
