/**
 * A rotatable voxel model built from pixel art.
 *
 * Where {@link renderVoxelRgba} extrudes a heightfield and draws it from one
 * fixed angle, this represents an object as a true 3D grid of cubes that can be
 * rotated to any yaw/pitch (see voxelModelRenderer.ts). A flat sprite is
 * extruded along depth into a solid slab, and only the *surface* voxels — the
 * ones with at least one exposed face — are retained, each carrying its colour,
 * a self-emissive strength (so glowing pixels keep glowing when spun), and a
 * model-space outward normal derived from which of its faces are exposed. That
 * per-voxel normal is what lets the renderer relight faces as the model turns.
 *
 * Pure and DOM-free: the same models feed the CPU renderer, the WebGPU renderer,
 * and the unit tests, and are built identically from the app's backdrop props or
 * from a sprite's authored material in the editor.
 */

/** Straight-alpha RGBA source, `width*height*4`; alpha 0 marks an empty pixel. */
export type PixelSource = Uint8ClampedArray;

/**
 * A model as parallel arrays of its surface voxels (compact and cache-friendly).
 * Positions are centred on the model origin so rotation happens about its middle.
 */
export interface VoxelModel {
  /** Bounding size in voxels along each axis. */
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  /** Number of surface voxels. */
  readonly count: number;
  /** Centred voxel-centre coordinates (x right, y up, z toward the viewer). */
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  /** Per-voxel albedo. */
  readonly r: Uint8ClampedArray;
  readonly g: Uint8ClampedArray;
  readonly b: Uint8ClampedArray;
  /** Per-voxel self-emissive strength, 0..1. */
  readonly emissive: Float32Array;
  /** Per-voxel model-space outward normal (unit vector). */
  readonly nx: Float32Array;
  readonly ny: Float32Array;
  readonly nz: Float32Array;
}

export interface ExtrudeOptions {
  /** Slab thickness in voxels along depth. Default 6. Clamped to >= 1. */
  readonly depth?: number;
  /**
   * Optional per-pixel emissive strength (`width*height`, 0..255). Defaults to
   * none. A pixel's emissive applies to its whole extruded column.
   */
  readonly emissive?: Uint8Array;
}

/** The longest straight-line span across the model's bounding box, in voxels. */
export function modelDiagonal(model: VoxelModel): number {
  return Math.hypot(model.sizeX, model.sizeY, model.sizeZ);
}

/**
 * Extrude a flat pixel image into a solid voxel slab and keep its surface shell.
 * The image's top row becomes the model's top (y is flipped to point up). A
 * voxel is kept when any of its six faces is exposed — a front/back face, or a
 * silhouette edge where the neighbouring pixel is transparent.
 */
export function extrudeSprite(
  albedo: PixelSource,
  width: number,
  height: number,
  options: ExtrudeOptions = {},
): VoxelModel {
  const depth = Math.max(1, Math.floor(options.depth ?? 6));
  const emissiveSource = options.emissive;

  // Pixel occupancy for fast neighbour lookups.
  const occupied = (x: number, y: number): boolean =>
    x >= 0 && x < width && y >= 0 && y < height && (albedo[(y * width + x) * 4 + 3] ?? 0) > 0;

  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const es: number[] = [];
  const nxs: number[] = [];
  const nys: number[] = [];
  const nzs: number[] = [];

  const halfX = (width - 1) / 2;
  const halfY = (height - 1) / 2;
  const halfZ = (depth - 1) / 2;

  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      const pi = (py * width + px) * 4;
      if ((albedo[pi + 3] ?? 0) === 0) continue;

      // Which sideways faces are exposed is the same for the whole column.
      const openRight = !occupied(px + 1, py);
      const openLeft = !occupied(px - 1, py);
      const openUp = !occupied(px, py - 1); // pixel row above = up in model space
      const openDown = !occupied(px, py + 1);
      const sideExposed = openRight || openLeft || openUp || openDown;

      const r = albedo[pi] ?? 0;
      const g = albedo[pi + 1] ?? 0;
      const b = albedo[pi + 2] ?? 0;
      const emissive = emissiveSource ? (emissiveSource[py * width + px] ?? 0) / 255 : 0;

      for (let pz = 0; pz < depth; pz += 1) {
        const front = pz === depth - 1; // toward the viewer (+z)
        const back = pz === 0;
        if (!front && !back && !sideExposed) continue; // fully interior — never seen

        // Outward normal = sum of directions of the exposed faces.
        let vnx = 0;
        let vny = 0;
        let vnz = 0;
        if (openRight) vnx += 1;
        if (openLeft) vnx -= 1;
        if (openUp) vny += 1;
        if (openDown) vny -= 1;
        if (front) vnz += 1;
        if (back) vnz -= 1;
        const len = Math.hypot(vnx, vny, vnz) || 1;

        xs.push(px - halfX);
        ys.push(height - 1 - py - halfY); // flip so the top row points up
        zs.push(pz - halfZ);
        rs.push(r);
        gs.push(g);
        bs.push(b);
        es.push(emissive);
        nxs.push(vnx / len);
        nys.push(vny / len);
        nzs.push(vnz / len);
      }
    }
  }

  return {
    sizeX: width,
    sizeY: height,
    sizeZ: depth,
    count: xs.length,
    x: Float32Array.from(xs),
    y: Float32Array.from(ys),
    z: Float32Array.from(zs),
    r: Uint8ClampedArray.from(rs),
    g: Uint8ClampedArray.from(gs),
    b: Uint8ClampedArray.from(bs),
    emissive: Float32Array.from(es),
    nx: Float32Array.from(nxs),
    ny: Float32Array.from(nys),
    nz: Float32Array.from(nzs),
  };
}
