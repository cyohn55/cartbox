/**
 * A pure software rasteriser for {@link MeshAsset} triangle geometry — the one
 * renderer shared by the editor's mesh preview and (in the runtime phase) the
 * player, which has no GPU triangle path of its own. It draws into caller-owned
 * RGBA + depth buffers, so the same code serves a 560px editor canvas and the
 * tiny cart framebuffer, and runs headless in the unit tests.
 *
 * The pipeline is a textbook forward rasteriser done carefully where it matters:
 *
 * - **Near-plane clipping** in view space, so triangles crossing behind the
 *   camera don't produce the classic wrap-around artefacts (the usual footgun).
 * - **Perspective-correct** interpolation: `1/w` and `attribute/w` are
 *   interpolated linearly across the triangle and divided per pixel, so textures
 *   and normals don't swim under perspective.
 * - A **depth buffer** in NDC z (linear in screen space), nearest-wins.
 * - **Two-sided** Lambert shading, so a model with inconsistent winding still
 *   lights instead of showing black back-faces — the right call for a preview of
 *   arbitrary imported geometry.
 *
 * Textures are supplied already-decoded (RGBA), one per primitive, because image
 * decoding is the browser's job; keeping it out of here is what lets the
 * rasteriser stay pure and testable. DOM-free.
 */

import { type MeshAsset, computeSmoothNormals, meshBounds } from "../model/MeshAsset";

/** A decoded texture: tightly-packed RGBA rows, `width × height`. */
export interface DecodedTexture {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** An orbit camera framing the mesh: angles around it and a distance from centre. */
export interface OrbitCamera {
  readonly yaw: number;
  readonly pitch: number;
  /** Distance from the framed centre, in world units; auto-fit if omitted. */
  readonly distance?: number;
  /** Vertical field of view in radians (default ~50°). */
  readonly fov?: number;
}

export interface RenderMeshOptions {
  readonly camera: OrbitCamera;
  /** Square viewport edge in pixels; `out`/`depth` must be `size × size`. */
  readonly size: number;
  /** RGBA output, `size × size × 4`. */
  readonly out: Uint8ClampedArray;
  /** Depth buffer, `size × size`; reset to +Infinity each call. */
  readonly depth: Float32Array;
  /** World-space direction *towards* the light (normalised internally). */
  readonly lightDirection?: readonly [number, number, number];
  /** Fill light in shadow, 0..1 (default 0.35). */
  readonly ambient?: number;
  /** Decoded base-colour texture per primitive (index-aligned), or null entries. */
  readonly textures?: readonly (DecodedTexture | null)[];
  /** Background clear colour RGBA (default transparent). */
  readonly background?: readonly [number, number, number, number];
}

// --- Column-major 4×4 matrix helpers --------------------------------------

/** A column-major 4×4 matrix (translation lives in elements 12,13,14). */
export type Mat4 = Float64Array;

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row]! * b[col * 4 + k]!;
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/** A right-handed look-at view matrix (camera looks down its local −Z). */
function lookAt(eye: readonly number[], center: readonly number[], up: readonly number[]): Mat4 {
  const fx = center[0]! - eye[0]!;
  const fy = center[1]! - eye[1]!;
  const fz = center[2]! - eye[2]!;
  const fl = Math.hypot(fx, fy, fz) || 1;
  const f = [fx / fl, fy / fl, fz / fl];
  // s = f × up, u = s × f
  let sx = f[1]! * up[2]! - f[2]! * up[1]!;
  let sy = f[2]! * up[0]! - f[0]! * up[2]!;
  let sz = f[0]! * up[1]! - f[1]! * up[0]!;
  const sl = Math.hypot(sx, sy, sz) || 1;
  sx /= sl;
  sy /= sl;
  sz /= sl;
  const ux = sy * f[2]! - sz * f[1]!;
  const uy = sz * f[0]! - sx * f[2]!;
  const uz = sx * f[1]! - sy * f[0]!;
  return Float64Array.from([
    sx, ux, -f[0]!, 0,
    sy, uy, -f[1]!, 0,
    sz, uz, -f[2]!, 0,
    -(sx * eye[0]! + sy * eye[1]! + sz * eye[2]!),
    -(ux * eye[0]! + uy * eye[1]! + uz * eye[2]!),
    f[0]! * eye[0]! + f[1]! * eye[1]! + f[2]! * eye[2]!,
    1,
  ]);
}

/** A right-handed perspective projection mapping NDC z to [−1, 1]. */
function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const t = 1 / Math.tan(fovY / 2);
  const range = 1 / (near - far);
  return Float64Array.from([
    t / aspect, 0, 0, 0,
    0, t, 0, 0,
    0, 0, (near + far) * range, -1,
    0, 0, near * far * range * 2, 0,
  ]);
}

/**
 * Build a column-major model matrix from a translation, an X→Y→Z Euler rotation
 * in degrees (matching the mesh sidecar's `MeshTransform`), and a per-axis scale.
 * Composed as T · Rz · Ry · Rx · S: scale first, then rotate X, Y, Z, then place.
 */
export function composeModelMatrix(
  position: readonly [number, number, number],
  rotationDegrees: readonly [number, number, number],
  scale: readonly [number, number, number],
): Mat4 {
  const rx = (rotationDegrees[0] * Math.PI) / 180;
  const ry = (rotationDegrees[1] * Math.PI) / 180;
  const rz = (rotationDegrees[2] * Math.PI) / 180;
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);

  // R = Rz · Ry · Rx, expanded (column-major storage).
  const r00 = cz * cy;
  const r01 = cz * sy * sx - sz * cx;
  const r02 = cz * sy * cx + sz * sx;
  const r10 = sz * cy;
  const r11 = sz * sy * sx + cz * cx;
  const r12 = sz * sy * cx - cz * sx;
  const r20 = -sy;
  const r21 = cy * sx;
  const r22 = cy * cx;

  const [sX, sY, sZ] = scale;
  return Float64Array.from([
    r00 * sX, r10 * sX, r20 * sX, 0,
    r01 * sY, r11 * sY, r21 * sY, 0,
    r02 * sZ, r12 * sZ, r22 * sZ, 0,
    position[0], position[1], position[2], 1,
  ]);
}

/** Multiply two column-major 4×4 matrices (`a · b`). Public wrapper for composing transforms. */
export function multiplyMat4(a: Mat4, b: Mat4): Mat4 {
  return multiply(a, b);
}

/** A right-handed view matrix looking from `eye` at `center`, y-up. Public wrapper over {@link lookAt}. */
export function viewMatrix(
  eye: readonly [number, number, number],
  center: readonly [number, number, number],
  up: readonly [number, number, number] = [0, 1, 0],
): Mat4 {
  return lookAt(eye, center, up);
}

/** A right-handed perspective projection. Public wrapper over {@link perspective}. */
export function projectionMatrix(fovY: number, aspect: number, near: number, far: number): Mat4 {
  return perspective(fovY, aspect, near, far);
}

/** The identity basis, used when a mesh has no model transform (normals pass through). */
const IDENTITY_3X3: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * The 3×3 basis that carries an object normal into world space: the model
 * matrix's upper-left block, kept in the same column-major layout so `drawMesh`
 * can apply it as R·n directly (`basis[0,3,6]` = column 0, etc.). Applying the
 * rotation+scale rather than its inverse-transpose is correct for rotation and
 * uniform scale; a non-uniform scale skews normals slightly, which two-sided
 * Lambert tolerates — the right trade for arbitrary imported geometry.
 */
function normalMatrix3x3(model: Mat4): readonly number[] {
  return [model[0]!, model[1]!, model[2]!, model[4]!, model[5]!, model[6]!, model[8]!, model[9]!, model[10]!];
}

/** A vertex after transforms: view-space z (for clipping) + clip-space + attributes. */
interface Vertex {
  clip: [number, number, number, number]; // clip-space position
  viewZ: number; // view-space z (negative in front of camera)
  u: number;
  v: number;
  nx: number;
  ny: number;
  nz: number;
}

const NEAR = 0.05;

/** Linear interpolation of two vertices at parameter `t` (used by near-plane clipping). */
function lerpVertex(a: Vertex, b: Vertex, t: number): Vertex {
  const mix = (x: number, y: number): number => x + (y - x) * t;
  return {
    clip: [mix(a.clip[0], b.clip[0]), mix(a.clip[1], b.clip[1]), mix(a.clip[2], b.clip[2]), mix(a.clip[3], b.clip[3])],
    viewZ: mix(a.viewZ, b.viewZ),
    u: mix(a.u, b.u),
    v: mix(a.v, b.v),
    nx: mix(a.nx, b.nx),
    ny: mix(a.ny, b.ny),
    nz: mix(a.nz, b.nz),
  };
}

/** Clip a triangle against the near plane (view z ≤ −NEAR), returning 0–2 triangles. */
function clipNear(tri: [Vertex, Vertex, Vertex]): Vertex[] {
  const inside = tri.filter((v) => v.viewZ <= -NEAR);
  if (inside.length === 3) return tri;
  if (inside.length === 0) return [];

  // Sutherland–Hodgman against the single near plane, then fan-triangulate.
  const output: Vertex[] = [];
  for (let i = 0; i < 3; i += 1) {
    const current = tri[i]!;
    const next = tri[(i + 1) % 3]!;
    const currentIn = current.viewZ <= -NEAR;
    const nextIn = next.viewZ <= -NEAR;
    if (currentIn) output.push(current);
    if (currentIn !== nextIn) {
      // Intersection parameter where view z crosses −NEAR.
      const t = (-NEAR - current.viewZ) / (next.viewZ - current.viewZ);
      output.push(lerpVertex(current, next, t));
    }
  }
  const triangles: Vertex[] = [];
  for (let i = 1; i < output.length - 1; i += 1) {
    triangles.push(output[0]!, output[i]!, output[i + 1]!);
  }
  return triangles;
}

function sampleTexture(texture: DecodedTexture, u: number, v: number): [number, number, number, number] {
  // Wrap, then nearest-sample. glTF's V origin is top-left, so flip.
  const wrap = (x: number): number => x - Math.floor(x);
  const tx = Math.min(texture.width - 1, Math.floor(wrap(u) * texture.width));
  const ty = Math.min(texture.height - 1, Math.floor(wrap(1 - v) * texture.height));
  const at = (ty * texture.width + tx) * 4;
  return [texture.data[at]!, texture.data[at + 1]!, texture.data[at + 2]!, texture.data[at + 3]!];
}

/**
 * Render a mesh into `out`/`depth`. The camera orbits the mesh's bounding-box
 * centre; `distance` defaults to a frame-filling fit. Both buffers are fully
 * overwritten (depth reset to +Infinity, colour to `background`).
 */
export function renderMesh(mesh: MeshAsset, options: RenderMeshOptions): void {
  const { size, out, depth, camera } = options;
  const ambient = options.ambient ?? 0.35;
  const background = options.background ?? [0, 0, 0, 0];
  const bounds = meshBounds(mesh);

  // Clear.
  depth.fill(Infinity);
  for (let i = 0; i < size * size; i += 1) {
    out[i * 4] = background[0];
    out[i * 4 + 1] = background[1];
    out[i * 4 + 2] = background[2];
    out[i * 4 + 3] = background[3];
  }
  if (!bounds) return;

  // Frame the bounds: orbit around its centre at a fitted distance.
  const center: [number, number, number] = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const radius = Math.max(
    1e-3,
    0.5 * Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]),
  );
  const fov = camera.fov ?? (50 * Math.PI) / 180;
  const distance = camera.distance ?? radius / Math.sin(fov / 2) + radius;
  const cosPitch = Math.cos(camera.pitch);
  const eye: [number, number, number] = [
    center[0] + distance * cosPitch * Math.sin(camera.yaw),
    center[1] + distance * Math.sin(camera.pitch),
    center[2] + distance * cosPitch * Math.cos(camera.yaw),
  ];

  const view = lookAt(eye, center, [0, 1, 0]);
  const proj = perspective(fov, 1, NEAR, distance + radius * 4);
  const viewProj = multiply(proj, view);

  // Normalise the light direction.
  const [lx, ly, lz] = options.lightDirection ?? [0.4, 0.8, 0.6];
  const ll = Math.hypot(lx, ly, lz) || 1;
  const light: [number, number, number] = [lx / ll, ly / ll, lz / ll];

  // The single mesh has no model transform, so model-view is the plain view and
  // normals need no re-basing: reuse the scene path with an identity model.
  drawMesh(mesh, viewProj, view, IDENTITY_3X3, size, size, out, depth, options.textures ?? null, light, ambient);
}

// --- Scene rendering: many placed meshes through one camera -----------------

/** A mesh placed in a shared world by a model matrix, with its own textures. */
export interface MeshSceneInstance {
  readonly mesh: MeshAsset;
  /** Column-major world transform (see {@link composeModelMatrix}). */
  readonly model: Mat4;
  /** Decoded base-colour texture per primitive (index-aligned), or null entries. */
  readonly textures?: readonly (DecodedTexture | null)[];
}

export interface RenderMeshSceneOptions {
  /** Framebuffer width in pixels; `out`/`depth` are `width × height`. */
  readonly width: number;
  /** Framebuffer height in pixels. */
  readonly height: number;
  /** RGBA output, `width × height × 4`. */
  readonly out: Uint8ClampedArray;
  /** Depth buffer, `width × height`; reset to +Infinity each call. */
  readonly depth: Float32Array;
  /** Column-major view matrix (see {@link viewMatrix}). */
  readonly view: Mat4;
  /** Column-major projection matrix (see {@link projectionMatrix}); aspect must be `width/height`. */
  readonly projection: Mat4;
  /** World-space direction *towards* the light (normalised internally). */
  readonly lightDirection?: readonly [number, number, number];
  /** Fill light in shadow, 0..1 (default 0.35). */
  readonly ambient?: number;
  /** Background clear colour RGBA (default transparent); pass null to composite over existing `out`. */
  readonly background?: readonly [number, number, number, number] | null;
}

/**
 * Rasterise many placed meshes through one shared camera into `width × height`
 * RGBA + depth buffers. This is the runtime entry point: the player poses a
 * cart's mesh sidecar with model matrices and a scene camera, and this draws
 * every instance with a single shared depth buffer so they occlude each other
 * correctly. `renderMesh` (the editor's single-mesh orbit preview) is the special
 * case of one identity-posed instance auto-framed.
 *
 * Unlike `renderMesh`, `background` may be null to composite the meshes *over*
 * whatever `out` already holds (the cart's framebuffer) — the depth buffer is
 * still reset, so the meshes form one consistent 3D layer on top of the 2D frame.
 */
export function renderMeshScene(instances: readonly MeshSceneInstance[], options: RenderMeshSceneOptions): void {
  const { width, height, out, depth, view, projection } = options;
  const ambient = options.ambient ?? 0.35;
  const viewProj = multiply(projection, view);

  depth.fill(Infinity);
  if (options.background !== null) {
    const background = options.background ?? [0, 0, 0, 0];
    for (let i = 0; i < width * height; i += 1) {
      out[i * 4] = background[0]!;
      out[i * 4 + 1] = background[1]!;
      out[i * 4 + 2] = background[2]!;
      out[i * 4 + 3] = background[3]!;
    }
  }

  const [lx, ly, lz] = options.lightDirection ?? [0.4, 0.8, 0.6];
  const ll = Math.hypot(lx, ly, lz) || 1;
  const light: [number, number, number] = [lx / ll, ly / ll, lz / ll];

  for (const instance of instances) {
    const mvp = multiply(viewProj, instance.model);
    const modelView = multiply(view, instance.model);
    const normalBasis = normalMatrix3x3(instance.model);
    drawMesh(instance.mesh, mvp, modelView, normalBasis, width, height, out, depth, instance.textures ?? null, light, ambient);
  }
}

/**
 * Draw one mesh's primitives, projecting positions by `mvp` (to clip space) and
 * `modelView` (for the view-space z the near clipper needs), and re-basing object
 * normals into world space by `normalBasis`. Shared by the single-mesh preview
 * and the scene renderer so the projection + clip + raster path is written once.
 */
function drawMesh(
  mesh: MeshAsset,
  mvp: Mat4,
  modelView: Mat4,
  normalBasis: readonly number[],
  width: number,
  height: number,
  out: Uint8ClampedArray,
  depth: Float32Array,
  textures: readonly (DecodedTexture | null)[] | null,
  light: readonly [number, number, number],
  ambient: number,
): void {
  mesh.primitives.forEach((primitive, primitiveIndex) => {
    const positions = primitive.positions;
    const objectNormals = primitive.normals ?? computeSmoothNormals(positions, primitive.indices);
    const uvs = primitive.uvs;
    const indices = primitive.indices;
    const texture = textures?.[primitiveIndex] ?? null;
    const [baseR, baseG, baseB, baseA] = primitive.material.baseColorFactor;

    const project = (i: number): Vertex => {
      const x = positions[i * 3]!;
      const y = positions[i * 3 + 1]!;
      const z = positions[i * 3 + 2]!;
      // View-space z (for near-plane clipping) from the model-view matrix.
      const viewZ = modelView[2]! * x + modelView[6]! * y + modelView[10]! * z + modelView[14]!;
      const cx = mvp[0]! * x + mvp[4]! * y + mvp[8]! * z + mvp[12]!;
      const cy = mvp[1]! * x + mvp[5]! * y + mvp[9]! * z + mvp[13]!;
      const cz = mvp[2]! * x + mvp[6]! * y + mvp[10]! * z + mvp[14]!;
      const cw = mvp[3]! * x + mvp[7]! * y + mvp[11]! * z + mvp[15]!;
      // Re-base the object normal into world space (rotation/scale only).
      const onx = objectNormals[i * 3]!;
      const ony = objectNormals[i * 3 + 1]!;
      const onz = objectNormals[i * 3 + 2]!;
      return {
        clip: [cx, cy, cz, cw],
        viewZ,
        u: uvs ? uvs[i * 2]! : 0,
        v: uvs ? uvs[i * 2 + 1]! : 0,
        nx: normalBasis[0]! * onx + normalBasis[3]! * ony + normalBasis[6]! * onz,
        ny: normalBasis[1]! * onx + normalBasis[4]! * ony + normalBasis[7]! * onz,
        nz: normalBasis[2]! * onx + normalBasis[5]! * ony + normalBasis[8]! * onz,
      };
    };

    for (let t = 0; t < indices.length; t += 3) {
      const clipped = clipNear([project(indices[t]!), project(indices[t + 1]!), project(indices[t + 2]!)]);
      for (let c = 0; c < clipped.length; c += 3) {
        rasterizeTriangle(
          clipped[c]!,
          clipped[c + 1]!,
          clipped[c + 2]!,
          width,
          height,
          out,
          depth,
          texture,
          [baseR, baseG, baseB, baseA],
          light,
          ambient,
        );
      }
    }
  });
}

/** Rasterise one clipped triangle with perspective-correct attributes + depth test. */
function rasterizeTriangle(
  a: Vertex,
  b: Vertex,
  c: Vertex,
  width: number,
  height: number,
  out: Uint8ClampedArray,
  depth: Float32Array,
  texture: DecodedTexture | null,
  base: readonly [number, number, number, number],
  light: readonly [number, number, number],
  ambient: number,
): void {
  // Perspective divide to NDC, then to screen pixels. NDC spans the full extent
  // of each axis independently, so x maps by width and y by height — a mesh drawn
  // into a non-square framebuffer (the runtime's 240×136) is undistorted as long
  // as the projection's aspect matches width/height.
  const toScreen = (v: Vertex): { x: number; y: number; z: number; invW: number } => {
    const invW = 1 / v.clip[3];
    return {
      x: (v.clip[0] * invW * 0.5 + 0.5) * width,
      y: (1 - (v.clip[1] * invW * 0.5 + 0.5)) * height,
      z: v.clip[2] * invW, // NDC z, linear in screen space → the depth value
      invW,
    };
  };
  const sa = toScreen(a);
  const sb = toScreen(b);
  const sc = toScreen(c);

  // Signed area × 2; sign tells winding. Zero-area triangles contribute nothing.
  const area = (sb.x - sa.x) * (sc.y - sa.y) - (sb.y - sa.y) * (sc.x - sa.x);
  if (Math.abs(area) < 1e-9) return;
  const invArea = 1 / area;

  const minX = Math.max(0, Math.floor(Math.min(sa.x, sb.x, sc.x)));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(sa.x, sb.x, sc.x)));
  const minY = Math.max(0, Math.floor(Math.min(sa.y, sb.y, sc.y)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(sa.y, sb.y, sc.y)));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      // Barycentric weights via edge functions (same sign as `area` when inside).
      let w0 = ((sb.x - px) * (sc.y - py) - (sb.y - py) * (sc.x - px)) * invArea;
      let w1 = ((sc.x - px) * (sa.y - py) - (sc.y - py) * (sa.x - px)) * invArea;
      let w2 = ((sa.x - px) * (sb.y - py) - (sa.y - py) * (sb.x - px)) * invArea;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;

      const zNdc = w0 * sa.z + w1 * sb.z + w2 * sc.z; // linear in screen space
      const di = y * width + x;
      if (zNdc >= depth[di]!) continue;

      // Perspective-correct attribute interpolation: weight by 1/w, then divide.
      const iw = w0 * sa.invW + w1 * sb.invW + w2 * sc.invW;
      const pw0 = (w0 * sa.invW) / iw;
      const pw1 = (w1 * sb.invW) / iw;
      const pw2 = (w2 * sc.invW) / iw;

      // Two-sided Lambert: |N·L| so inconsistent winding still lights.
      const nx = pw0 * a.nx + pw1 * b.nx + pw2 * c.nx;
      const ny = pw0 * a.ny + pw1 * b.ny + pw2 * c.ny;
      const nz = pw0 * a.nz + pw1 * b.nz + pw2 * c.nz;
      const nl = Math.abs(nx * light[0] + ny * light[1] + nz * light[2]);
      const shade = ambient + (1 - ambient) * nl;

      let r = base[0] * 255;
      let g = base[1] * 255;
      let bl = base[2] * 255;
      let al = base[3] * 255;
      if (texture) {
        const u = pw0 * a.u + pw1 * b.u + pw2 * c.u;
        const v = pw0 * a.v + pw1 * b.v + pw2 * c.v;
        const [tr, tg, tb, ta] = sampleTexture(texture, u, v);
        r = (r * tr) / 255;
        g = (g * tg) / 255;
        bl = (bl * tb) / 255;
        al = (al * ta) / 255;
      }
      if (al < 1) continue; // skip fully-transparent texels rather than blend (opaque preview)

      depth[di] = zNdc;
      out[di * 4] = r * shade;
      out[di * 4 + 1] = g * shade;
      out[di * 4 + 2] = bl * shade;
      out[di * 4 + 3] = al;
    }
  }
}
