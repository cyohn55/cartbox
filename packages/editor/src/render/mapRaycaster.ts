/**
 * Standing in the map: a first-person view of a {@link MapVoxelSpace}, rendered
 * by marching one ray per pixel.
 *
 * The other views are orthographic — {@link renderVoxelModel} projects every cell
 * with the same scale and fills each face as a parallelogram. That is exactly
 * right for looking *at* a model and exactly wrong for standing *inside* one:
 * from the inside you need true perspective, and under perspective a cube face is
 * no longer a parallelogram, so the affine quad fill would warp and crack. Rather
 * than complicate a rasteriser four other surfaces depend on, this takes the
 * approach voxel worlds have always used and casts rays.
 *
 * Casting also happens to give the editor exactly what it needs for free: every
 * pixel knows the cell, the face, and the position *within* that face it struck,
 * so a click resolves to a texel with no second pass and no picking buffers to
 * keep in step with the image.
 *
 * The marcher is one algorithm over both lattices. A cell of either shape is a
 * convex polyhedron described by {@link CellGeometry}'s faces, so "where does this
 * ray leave the cell I am in, and which neighbour does it enter?" is the same
 * question for a cube and for a rhombic dodecahedron — only the face table
 * differs. Marching cell-to-cell rather than in fixed steps means the cost tracks
 * how far the ray travels, and nothing thin is ever stepped over.
 *
 * Pure and DOM-free: the browser and the unit tests drive it identically and
 * assert on real output pixels.
 */

import {
  CUBE_GEOMETRY,
  geometryFor,
  type CellGeometry,
} from "./cellGeometry";
import { faceTile, type TextureAtlas } from "./faceTexture";
import { DEFAULT_MODEL_LIGHT, type ModelLight } from "./voxelModelRenderer";
import { planeAxisOf, type MapVoxelCell, type MapVoxelSpace } from "../model/MapVoxelSpace";
import type { PaletteLookup } from "../model/MapVoxelLayer";

/** Where the viewer is and which way they are facing. */
export interface FirstPersonCamera {
  /** Eye position in cell coordinates (x = map column, y = height, z = map row). */
  readonly eye: readonly [number, number, number];
  /** Heading in radians; 0 looks along +z, increasing turns toward +x. */
  readonly yaw: number;
  /** Tilt in radians; positive looks up. */
  readonly pitch: number;
  /** Vertical field of view in radians. */
  readonly fov: number;
}

export interface FirstPersonOptions {
  readonly camera: FirstPersonCamera;
  /** How the space's palette indices become RGB. */
  readonly palette: PaletteLookup;
  /** Tiles the cells' materials sample from. Without it, cells render flat. */
  readonly atlas?: TextureAtlas;
  /** World-fixed light. Defaults to {@link DEFAULT_MODEL_LIGHT}. */
  readonly light?: ModelLight;
  readonly width: number;
  readonly height: number;
  /** How far a ray travels before giving up, in cells. Default 96. */
  readonly maxDistance?: number;
  /** Colour behind everything. Defaults to a dim night sky. */
  readonly sky?: readonly [number, number, number];
  /** Reuse these buffers (each `width * height`, `out` four times that). */
  readonly out?: Uint8ClampedArray;
  /** Flat space index of the cell each pixel struck; `-1` where the ray escaped. */
  readonly pickSite?: Int32Array;
  /** Index into the struck cell's face table — cube faces for a plane cell. */
  readonly pickFace?: Int8Array;
  /** Where on that face the ray landed, in the face's own 0..1 coordinates. */
  readonly pickU?: Float32Array;
  readonly pickV?: Float32Array;
  /** Distance in cells to what each pixel struck; `Infinity` where none. */
  readonly pickDistance?: Float32Array;
}

export interface FirstPersonRender {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly pickSite?: Int32Array;
  readonly pickFace?: Int8Array;
  readonly pickU?: Float32Array;
  readonly pickV?: Float32Array;
  readonly pickDistance?: Float32Array;
}

const DEFAULT_MAX_DISTANCE = 96;
const DEFAULT_SKY: readonly [number, number, number] = [16, 20, 34];
/**
 * A face reduced to what the marcher needs: its outward plane, the neighbour
 * across it, and the basis for turning a point on it into texture coordinates.
 *
 * The two edge vectors of a rhombic face are not perpendicular, so a point's
 * coordinates on the face cannot be found by projecting onto each edge
 * separately; the little 2x2 system that inverts the edge basis is solved once
 * here and reused per ray.
 */
interface MarchFace {
  readonly index: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** Plane offset: the face lies where `n · p == d`, in cell-local space. */
  readonly d: number;
  readonly offset: readonly [number, number, number];
  /** The face on the neighbour that this one meets. */
  opposite: number;
  /** Corner 0 and the two edge vectors from it, matching the renderer's winding. */
  readonly origin: readonly [number, number, number];
  readonly edgeU: readonly [number, number, number];
  readonly edgeV: readonly [number, number, number];
  /** Inverse of the edges' Gram matrix, for solving a point's (u, v). */
  readonly inv: readonly [number, number, number, number];
}

const MARCH_FACES = new WeakMap<CellGeometry, readonly MarchFace[]>();

function dot(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** The marching table for a cell shape, built once per geometry. */
function marchFaces(geometry: CellGeometry): readonly MarchFace[] {
  const cached = MARCH_FACES.get(geometry);
  if (cached) return cached;

  const faces: MarchFace[] = geometry.faces.map((face, index) => {
    const corners = face.corners;
    const origin = corners[0] as readonly [number, number, number];
    const next = corners[1] as readonly [number, number, number];
    const last = corners[3] as readonly [number, number, number];
    const edgeU: [number, number, number] = [next[0] - origin[0], next[1] - origin[1], next[2] - origin[2]];
    const edgeV: [number, number, number] = [last[0] - origin[0], last[1] - origin[1], last[2] - origin[2]];
    const uu = dot(edgeU, edgeU);
    const uv = dot(edgeU, edgeV);
    const vv = dot(edgeV, edgeV);
    const det = uu * vv - uv * uv || 1;
    return {
      index,
      nx: face.normal[0],
      ny: face.normal[1],
      nz: face.normal[2],
      d: dot(face.normal as readonly [number, number, number], origin),
      offset: face.offset,
      opposite: index,
      origin,
      edgeU,
      edgeV,
      inv: [vv / det, -uv / det, -uv / det, uu / det],
    };
  });

  // Pair each face with the one it meets on the neighbour across it, so entering
  // a cell knows which of its own faces was crossed.
  for (const face of faces) {
    const match = faces.find(
      (other) =>
        other.offset[0] === -face.offset[0] &&
        other.offset[1] === -face.offset[1] &&
        other.offset[2] === -face.offset[2],
    );
    face.opposite = match ? match.index : face.index;
  }

  MARCH_FACES.set(geometry, faces);
  return faces;
}

/**
 * The cell that contains a point.
 *
 * Both lattices' cells are the Voronoi regions of their sites, so this is just
 * "the nearest site". For cubes that is the rounded coordinate. For hexels the
 * rounded coordinate may be off-lattice, and the nearest valid site is then one
 * step away along whichever axis was rounded furthest — moving the axis with the
 * largest rounding error costs the least distance.
 */
export function cellContaining(
  geometry: CellGeometry,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  // `| 0` also collapses the -0 that rounding a small negative coordinate
  // produces, so a site is always a plain integer.
  const site: [number, number, number] = [Math.round(x) | 0, Math.round(y) | 0, Math.round(z) | 0];
  if (!geometry.evenParity) return site;
  if ((((site[0] + site[1] + site[2]) % 2) + 2) % 2 === 0) return site;

  const errors: [number, number, number] = [x - site[0], y - site[1], z - site[2]];
  let axis: 0 | 1 | 2 = 0;
  for (const candidate of [1, 2] as const) {
    if (Math.abs(errors[candidate]) > Math.abs(errors[axis])) axis = candidate;
  }
  site[axis] += errors[axis] >= 0 ? 1 : -1;
  return site;
}

/** The three axes of a first-person camera, in world space. */
export interface FirstPersonBasis {
  /** Where the camera looks. */
  readonly forward: readonly [number, number, number];
  /** Which way is right *on screen* — the +x direction of the image. */
  readonly right: readonly [number, number, number];
  /** Which way is up on screen. */
  readonly up: readonly [number, number, number];
}

/**
 * The camera basis for a heading and tilt.
 *
 * `forward` is the documented yaw convention: 0 looks along +z, and increasing
 * yaw swings toward +x.
 *
 * `right` is the part that has to be derived rather than guessed. The map's world
 * is right-handed — x runs east across the columns, z runs south down the rows,
 * y is up — so screen-right is fixed by the requirement that `right × up` point
 * *back* out of the screen, i.e. against `forward`. That gives `(-cos, 0, sin)`,
 * not `(cos, 0, -sin)`; the latter looks plausible and is a mirror, which is
 * invisible to any test that only asks which cells a ray struck but shows up
 * immediately as a view that swings the wrong way under the mouse and strafes
 * the wrong way under D.
 *
 * The check that this is the *same* frame the orbit view draws: the orbit camera
 * maps the world direction `(cos θ, 0, sin θ)` onto screen-right at its own yaw
 * θ, and the two headings are related by `walk = π − θ`, which turns `(-cos walk,
 * 0, sin walk)` into exactly that. Stepping between the cameras therefore
 * continues the same view rather than flipping it.
 *
 * Exported because the GPU renderer builds its view matrix from the same basis —
 * two cameras that disagree by a mirror would be far worse than one that is
 * merely wrong.
 */
export function firstPersonBasis(yaw: number, pitch: number): FirstPersonBasis {
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const forward: [number, number, number] = [sinYaw * cosPitch, sinPitch, cosYaw * cosPitch];
  const right: [number, number, number] = [-cosYaw, 0, sinYaw];
  // up = right x forward, so the image is upright rather than mirrored top to
  // bottom. (Swapping the operands negates it without changing which cells are
  // struck, so it too hides from hit-only assertions.)
  const up: [number, number, number] = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ];
  return { forward, right, up };
}

/**
 * The world direction the viewer walks when pressing "forward", and the one they
 * strafe when pressing "right" — the horizontal parts of {@link firstPersonBasis},
 * which is what keeps movement and the image in step. Exported so the walking
 * canvas cannot drift from the renderer's own idea of which way right is.
 */
export function walkAxes(yaw: number): {
  readonly forward: readonly [number, number];
  readonly right: readonly [number, number];
} {
  return { forward: [Math.sin(yaw), Math.cos(yaw)], right: [-Math.cos(yaw), Math.sin(yaw)] };
}

/** Albedo scaled by the light, floored by its own emissive glow. */
function litChannel(albedo: number, shade: number, lightColor: number, emissive: number): number {
  return Math.max(albedo * shade * lightColor, albedo * emissive);
}

/**
 * Render the space from inside it.
 *
 * One ray per pixel, marched cell to cell until it strikes something solid or
 * runs out of distance. Transparent texels do not stop a ray — that is what makes
 * a grass plane read as grass rather than as a rectangle with a hole in it.
 */
export function renderMapFirstPerson(
  space: MapVoxelSpace,
  options: FirstPersonOptions,
): FirstPersonRender {
  const width = Math.max(1, Math.floor(options.width));
  const height = Math.max(1, Math.floor(options.height));
  const data = options.out ?? new Uint8ClampedArray(width * height * 4);
  const light = options.light ?? DEFAULT_MODEL_LIGHT;
  const sky = options.sky ?? DEFAULT_SKY;
  const maxDistance = options.maxDistance ?? DEFAULT_MAX_DISTANCE;
  const geometry = geometryFor(space.shape);
  const faces = marchFaces(geometry);
  const planeFaces = marchFaces(CUBE_GEOMETRY);
  const atlas = options.atlas;

  const { pickSite, pickFace, pickU, pickV, pickDistance } = options;
  pickSite?.fill(-1);
  pickFace?.fill(-1);
  pickU?.fill(-1);
  pickV?.fill(-1);
  pickDistance?.fill(Infinity);

  const { eye, yaw, pitch, fov } = options.camera;
  const basis = firstPersonBasis(yaw, pitch);
  const { forward, right, up } = basis;
  const halfHeight = Math.tan(fov / 2);
  const halfWidth = (halfHeight * width) / height;

  const lightLength = Math.hypot(light.direction[0], light.direction[1], light.direction[2]) || 1;
  const lx = light.direction[0] / lightLength;
  const ly = light.direction[1] / lightLength;
  const lz = light.direction[2] / lightLength;

  const skyR = sky[0];
  const skyG = sky[1];
  const skyB = sky[2];

  for (let py = 0; py < height; py += 1) {
    const screenY = 1 - (2 * (py + 0.5)) / height;
    for (let px = 0; px < width; px += 1) {
      const screenX = (2 * (px + 0.5)) / width - 1;
      let dx = forward[0] + right[0] * screenX * halfWidth + up[0] * screenY * halfHeight;
      let dy = forward[1] + right[1] * screenX * halfWidth + up[1] * screenY * halfHeight;
      let dz = forward[2] + right[2] * screenX * halfWidth + up[2] * screenY * halfHeight;
      const length = Math.hypot(dx, dy, dz) || 1;
      dx /= length;
      dy /= length;
      dz /= length;

      const pixel = py * width + px;
      const out = pixel * 4;
      const struck = castRay(
        space, geometry, faces, planeFaces,
        eye[0], eye[1], eye[2], dx, dy, dz,
        maxDistance, atlas, options.palette,
      );
      if (!struck) {
        data[out] = skyR;
        data[out + 1] = skyG;
        data[out + 2] = skyB;
        data[out + 3] = 255;
        continue;
      }

      const diffuse = Math.max(0, HIT.nx * lx + HIT.ny * ly + HIT.nz * lz);
      const shade = light.ambient + (1 - light.ambient) * diffuse * light.intensity;
      data[out] = litChannel(HIT.r, shade, light.color[0], HIT.emissive);
      data[out + 1] = litChannel(HIT.g, shade, light.color[1], HIT.emissive);
      data[out + 2] = litChannel(HIT.b, shade, light.color[2], HIT.emissive);
      data[out + 3] = 255;

      if (pickSite) pickSite[pixel] = space.index(HIT.x, HIT.y, HIT.z);
      if (pickFace) pickFace[pixel] = HIT.face;
      if (pickU) pickU[pixel] = HIT.u;
      if (pickV) pickV[pixel] = HIT.v;
      if (pickDistance) pickDistance[pixel] = HIT.distance;
    }
  }

  return { data, width, height, pickSite, pickFace, pickU, pickV, pickDistance };
}

/** The columns a windowed view built, as a ray is allowed to strike them. */
export interface MapWindow {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/** Where a single cast ray landed. The same answer a pick buffer would give. */
export interface MapRayHit {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Index into the struck cell's face table — cube faces for a plane cell. */
  readonly face: number;
  /** Where on that face, in the face's own 0..1 coordinates. */
  readonly u: number;
  readonly v: number;
  /** Distance travelled in cells. */
  readonly distance: number;
}

/** Stand-in palette for picking, where nothing is drawn and colour is moot. */
const PICK_PALETTE: PaletteLookup = () => [255, 255, 255];

/**
 * How far along a ray the map begins: 0 when the start is already inside it, the
 * distance to the first face of its bounding box when it is outside, and null
 * when the ray misses the map altogether.
 *
 * The usual slab test. Cells are centred on their integer coordinates, so the box
 * runs from −½ to size−½ on each axis.
 */
function enterBounds(
  space: MapVoxelSpace,
  origin: readonly [number, number, number],
  dx: number,
  dy: number,
  dz: number,
): number | null {
  const min = [-0.5, -0.5, -0.5];
  const max = [space.width - 0.5, space.maxHeight - 0.5, space.depth - 0.5];
  const direction = [dx, dy, dz];
  let near = 0;
  let far = Infinity;

  for (let axis = 0; axis < 3; axis += 1) {
    const step = direction[axis]!;
    const start = origin[axis]!;
    if (Math.abs(step) < 1e-12) {
      if (start < min[axis]! || start > max[axis]!) return null; // parallel and outside
      continue;
    }
    const first = (min[axis]! - start) / step;
    const second = (max[axis]! - start) / step;
    near = Math.max(near, Math.min(first, second));
    far = Math.min(far, Math.max(first, second));
    if (near > far) return null;
  }
  // Step just inside. Landing exactly on the boundary rounds to the cell *past*
  // the last one, which the marcher immediately rejects as out of bounds.
  return near > 0 ? near + 1e-3 : 0;
}

/**
 * Cast one ray and report what it struck, or null for open sky.
 *
 * This is the whole of picking once the *drawing* moves to the GPU. The frame no
 * longer comes with pick buffers attached, but a pointer only ever asks about one
 * pixel, and one ray is a rounding error next to the hundred thousand a frame
 * used to cost. Sharing {@link castRay} with the CPU renderer is the point:
 * whatever subtleties the marcher has about transparent texels, plane quads and
 * hexel faces, the crosshair and the image cannot disagree about them.
 */
export function castMapRay(
  space: MapVoxelSpace,
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
  options: {
    readonly atlas?: TextureAtlas;
    readonly maxDistance?: number;
    /**
     * Column range the ray may strike, matching the window the view actually
     * built. Without it a click near the edge of the frame could name a cell that
     * is genuinely there but was never drawn — the pointer would act on something
     * invisible.
     */
    readonly bounds?: MapWindow;
  } = {},
): MapRayHit | null {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (!Number.isFinite(length) || length < 1e-9) return null;
  const dx = direction[0] / length;
  const dy = direction[1] / length;
  const dz = direction[2] / length;

  // Bring the start onto the map before marching. An orthographic pick begins
  // far outside it by construction — every ray of that camera starts on a plane
  // behind the whole scene — and the marcher stops the moment it steps out of
  // bounds, so without this the answer is always "nothing there".
  const entry = enterBounds(space, origin, dx, dy, dz);
  if (entry === null) return null;
  const maxDistance = options.maxDistance ?? DEFAULT_MAX_DISTANCE;
  if (entry > maxDistance) return null;

  const geometry = geometryFor(space.shape);
  const struck = castRay(
    space,
    geometry,
    marchFaces(geometry),
    marchFaces(CUBE_GEOMETRY),
    origin[0] + dx * entry, origin[1] + dy * entry, origin[2] + dz * entry,
    dx, dy, dz,
    maxDistance - entry,
    options.atlas,
    PICK_PALETTE,
    options.bounds,
  );
  if (!struck) return null;
  // Distance is reported from the caller's own origin, not from where the march
  // was allowed to begin.
  return { x: HIT.x, y: HIT.y, z: HIT.z, face: HIT.face, u: HIT.u, v: HIT.v, distance: HIT.distance + entry };
}

/**
 * What a ray struck.
 *
 * There is exactly one of these, reused by every ray. A frame casts hundreds of
 * thousands of rays across millions of marched cells, and allocating a record per
 * ray — let alone per step — would spend more time in the collector than in the
 * renderer. The value is consumed immediately by the caller that asked for it, so
 * sharing it is safe.
 */
interface RayHit {
  x: number;
  y: number;
  z: number;
  face: number;
  u: number;
  v: number;
  distance: number;
  r: number;
  g: number;
  b: number;
  emissive: number;
  nx: number;
  ny: number;
  nz: number;
}

const HIT: RayHit = {
  x: 0, y: 0, z: 0, face: 0, u: 0, v: 0, distance: 0,
  r: 0, g: 0, b: 0, emissive: 0, nx: 0, ny: 0, nz: 0,
};

/** Face coordinates of the last point resolved, avoiding a tuple per lookup. */
let faceU = 0;
let faceV = 0;

/**
 * Resolve a point on a face into that face's own 0..1 coordinates — the same
 * ones the rasteriser samples its tile with, so both views show a texture
 * identically. Writes {@link faceU} / {@link faceV} rather than returning a pair.
 */
function faceCoordinates(face: MarchFace, qx: number, qy: number, qz: number): void {
  const ox = qx - face.origin[0];
  const oy = qy - face.origin[1];
  const oz = qz - face.origin[2];
  const du = ox * face.edgeU[0] + oy * face.edgeU[1] + oz * face.edgeU[2];
  const dv = ox * face.edgeV[0] + oy * face.edgeV[1] + oz * face.edgeV[2];
  faceU = face.inv[0] * du + face.inv[1] * dv;
  faceV = face.inv[2] * du + face.inv[3] * dv;
}

/**
 * March one ray through the space until it strikes a surface.
 *
 * The loop is "which face of the cell I am in does this ray leave through?",
 * which names the neighbour to enter and the face of it that was crossed. A
 * transparent texel is not a surface, so the ray carries on — grass, ladders and
 * anything else drawn with holes therefore read correctly rather than as solid
 * rectangles.
 */
function castRay(
  space: MapVoxelSpace,
  geometry: CellGeometry,
  faces: readonly MarchFace[],
  planeFaces: readonly MarchFace[],
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistance: number,
  atlas: TextureAtlas | undefined,
  palette: PaletteLookup,
  bounds?: MapWindow,
): boolean {
  const start = cellContaining(geometry, ox, oy, oz);
  let sx = start[0];
  let sy = start[1];
  let sz = start[2];
  let entryFace = -1;
  let travelled = 0;

  // A cell of either shape spans about one unit, so distance bounds the steps.
  const stepLimit = Math.ceil(maxDistance * 2) + 4;
  for (let step = 0; step < stepLimit && travelled <= maxDistance; step += 1) {
    if (!space.inBounds(sx, sy, sz)) return false;
    // A windowed view only drew part of the map; a ray must not report what was
    // left out, but it still has to *travel* through that space to reach what was
    // drawn beyond it, so this skips the cell rather than ending the march.
    const outside =
      bounds !== undefined &&
      (sx < bounds.minX || sx > bounds.maxX || sz < bounds.minZ || sz > bounds.maxZ);
    const occupied = !outside && space.isFilled(sx, sy, sz);

    // Where the ray leaves this cell, and into which neighbour. The ray's origin
    // relative to the cell centre is fixed across the face loop, so it is taken
    // out of it — this is the innermost loop of the whole renderer.
    const rx = ox - sx;
    const ry = oy - sy;
    const rz = oz - sz;
    let exitT = Infinity;
    let exitFace = -1;
    for (let f = 0; f < faces.length; f += 1) {
      const face = faces[f]!;
      const denominator = face.nx * dx + face.ny * dy + face.nz * dz;
      if (denominator <= 1e-9) continue; // parallel, or heading into the face
      const t = (face.d - (face.nx * rx + face.ny * ry + face.nz * rz)) / denominator;
      if (t < exitT) {
        exitT = t;
        exitFace = f;
      }
    }
    if (exitFace < 0) return false; // numerically degenerate direction

    if (occupied) {
      const cell = space.cellAt(sx, sy, sz)!;
      if (cell.kind !== "solid") {
        if (planeHit(cell, sx, sy, sz, planeFaces, travelled, exitT, ox, oy, oz, dx, dy, dz, atlas, palette)) {
          return true;
        }
      } else if (exposedEntry(space, faces, entryFace, sx, sy, sz)) {
        // The ordinary case: the ray arrived from open space onto a face that is
        // actually drawn. A transparent texel there is not a surface, and
        // returning false carries the ray on through the cell.
        if (solidHit(cell, sx, sy, sz, faces, entryFace, travelled, ox, oy, oz, dx, dy, dz, atlas, palette)) {
          return true;
        }
      } else {
        // The ray is *inside* solid ground — free flight lets the camera go
        // there — so the face it came in through is interior and nothing draws
        // it. What is drawn, and what it must therefore strike, is the far side
        // of the terrain: the face it leaves through, once that one is exposed.
        const exit = faces[exitFace]!;
        const [ex, ey, ez] = exit.offset;
        if (!space.isFilled(sx + ex, sy + ey, sz + ez)) {
          faceCoordinates(exit, ox + dx * exitT - sx, oy + dy * exitT - sy, oz + dz * exitT - sz);
          if (shadeSurface(cell, sx, sy, sz, exit, exitT, atlas, palette)) return true;
        }
      }
    }

    travelled = exitT;
    const exit = faces[exitFace]!;
    sx += exit.offset[0];
    sy += exit.offset[1];
    sz += exit.offset[2];
    entryFace = exit.opposite;
  }
  return false;
}

/**
 * Whether the face a ray came in through is one the world actually shows: it
 * exists, and the cell across it is not itself solid. Only exposed faces are
 * meshed for the GPU, so this is the test that keeps what a pick reports and
 * what a frame draws describing the same surface.
 */
function exposedEntry(
  space: MapVoxelSpace,
  faces: readonly MarchFace[],
  entryFace: number,
  sx: number,
  sy: number,
  sz: number,
): boolean {
  const face = entryFace >= 0 ? faces[entryFace] : undefined;
  if (!face) return false;
  return !space.isFilled(sx + face.offset[0], sy + face.offset[1], sz + face.offset[2]);
}

/** Resolve a hit on a solid cell, or false when its texel is see-through. */
function solidHit(
  cell: MapVoxelCell,
  sx: number,
  sy: number,
  sz: number,
  faces: readonly MarchFace[],
  entryFace: number,
  travelled: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  atlas: TextureAtlas | undefined,
  palette: PaletteLookup,
): boolean {
  // The caller has already established that this face is one the world shows.
  const face = faces[entryFace];
  if (!face) return false;

  faceCoordinates(face, ox + dx * travelled - sx, oy + dy * travelled - sy, oz + dz * travelled - sz);
  return shadeSurface(cell, sx, sy, sz, face, travelled, atlas, palette);
}

/**
 * Resolve a hit on a plane cell: a flat quad standing in the middle of the site,
 * spanning the two axes its own does not. A cross stands two, and the nearer one
 * along the ray wins.
 */
function planeHit(
  cell: MapVoxelCell,
  sx: number,
  sy: number,
  sz: number,
  cubeFaces: readonly MarchFace[],
  enterT: number,
  exitT: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  atlas: TextureAtlas | undefined,
  palette: PaletteLookup,
): boolean {
  const first = cell.kind === "cross" ? 0 : planeAxisOf(cell.kind);
  const second = cell.kind === "cross" ? 2 : -1;
  const site = [sx, sy, sz];
  const origin = [ox, oy, oz];
  const direction = [dx, dy, dz];
  let struck = false;
  let nearest = Infinity;

  for (const axis of [first, second]) {
    if (axis < 0) continue;
    const along = direction[axis]!;
    if (Math.abs(along) < 1e-9) continue; // travelling within the quad's plane
    const t = (site[axis]! - origin[axis]!) / along;
    if (t < enterT || t > exitT || t >= nearest) continue;

    // The struck point has to be inside the quad, which spans half a cell on the
    // two axes the plane does not stand across.
    const hx = ox + dx * t - sx;
    const hy = oy + dy * t - sy;
    const hz = oz + dz * t - sz;
    const local = [hx, hy, hz];
    let inside = true;
    for (let i = 0; i < 3; i += 1) {
      if (i !== axis && Math.abs(local[i]!) > 0.5) inside = false;
    }
    if (!inside) continue;

    // A plane is drawn double-sided, so it shows whichever of its two faces is
    // turned toward the viewer — the one whose normal opposes the ray.
    const face = cubeFaces.find(
      (candidate) =>
        candidate.offset[axis] !== 0 && candidate.nx * dx + candidate.ny * dy + candidate.nz * dz < 0,
    );
    if (!face) continue;

    faceCoordinates(face, hx, hy, hz);
    if (shadeSurface(cell, sx, sy, sz, face, t, atlas, palette)) {
      struck = true;
      nearest = t;
    }
  }
  return struck;
}

/**
 * Colour a struck face into the shared {@link HIT} record, or report false when
 * the texel there is fully transparent and the ray should carry on.
 */
function shadeSurface(
  cell: MapVoxelCell,
  sx: number,
  sy: number,
  sz: number,
  face: MarchFace,
  distance: number,
  atlas: TextureAtlas | undefined,
  palette: PaletteLookup,
): boolean {
  const u = Math.min(1, Math.max(0, faceU));
  const v = Math.min(1, Math.max(0, faceV));
  const texture = cell.material >= 0 ? faceTile(atlas, cell.material, face.ny) : undefined;

  if (texture) {
    const size = texture.size;
    const tx = Math.min(size - 1, Math.floor(u * size));
    const ty = Math.min(size - 1, Math.floor(v * size));
    const texel = (ty * size + tx) * 4;
    if (texture.data[texel + 3]! === 0) return false; // see-through: carry on
    HIT.r = texture.data[texel]!;
    HIT.g = texture.data[texel + 1]!;
    HIT.b = texture.data[texel + 2]!;
    HIT.emissive = texture.emissive ? texture.emissive[ty * size + tx]! / 255 : 0;
  } else {
    const colour = palette(cell.colorIndex);
    HIT.r = colour[0];
    HIT.g = colour[1];
    HIT.b = colour[2];
    HIT.emissive = 0;
  }

  HIT.x = sx;
  HIT.y = sy;
  HIT.z = sz;
  HIT.face = face.index;
  HIT.u = u;
  HIT.v = v;
  HIT.distance = distance;
  HIT.nx = face.nx;
  HIT.ny = face.ny;
  HIT.nz = face.nz;
  return true;
}
