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
  /** Decoded tangent-space normal map per primitive (index-aligned), or null. */
  readonly normalTextures?: readonly (DecodedTexture | null)[];
  /** Decoded material map per primitive (RGBA: R=height, G=specular, B=roughness,
   *  A=emissive), or null entries. Drives the specular highlight + emissive floor. */
  readonly materialTextures?: readonly (DecodedTexture | null)[];
  /** PBR (metallic-roughness) maps per primitive, for the Modern tier — see
   *  {@link MeshSceneInstance}. */
  readonly mrTextures?: readonly (DecodedTexture | null)[];
  readonly occlusionTextures?: readonly (DecodedTexture | null)[];
  readonly emissiveTextures?: readonly (DecodedTexture | null)[];
  /** Image-based lighting environment for PBR materials (Modern tier); when set,
   *  it replaces the flat ambient term. See {@link EnvironmentLight}. */
  readonly environment?: EnvironmentLight | null;
  /** HDR tone mapping for PBR materials (Modern tier); when set, highlights roll
   *  off instead of clipping. See {@link ToneMap}. */
  readonly tonemap?: ToneMap | null;
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

/** A 4×4 identity, for passes with no per-instance model transform (world = object). */
const IDENTITY_MAT4: Mat4 = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

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

/** Normalise a 3-vector, returning a unit +Z when it is degenerate. */
function normalizeVec3(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z);
  return len < 1e-8 ? [0, 0, 1] : [x / len, y / len, z / len];
}

/**
 * An environment for image-based lighting (Phase 3). Two forms, one type:
 *
 * - **Analytic gradient** — a three-stop vertical gradient (`sky` overhead,
 *   `horizon` at the equator, `ground` below). Cheap, deterministic, the default.
 * - **Equirectangular map** — an optional decoded panorama (`map`) sampled by the
 *   full 3D direction, so metals mirror a real scene rather than a gradient. Give
 *   its mean radiance in `average` (see {@link computeEnvironmentAverage}) for the
 *   rough-reflection fall-off; the gradient stops are then ignored.
 *
 * Both are scaled by `intensity`. Colours are in the engine's non-linear byte
 * space (0..1); a true HDR (>1) environment waits for the Phase 4 HDR pipeline,
 * so today an equirectangular `map` is an LDR panorama.
 */
export interface EnvironmentLight {
  readonly sky: readonly [number, number, number];
  readonly horizon: readonly [number, number, number];
  readonly ground: readonly [number, number, number];
  /** Overall multiplier on the environment (default 1). */
  readonly intensity: number;
  /** Optional equirectangular panorama; when set, sampling uses it, not the stops. */
  readonly map?: DecodedTexture | null;
  /** The map's mean radiance (0..1, pre-intensity); required with `map`. */
  readonly average?: readonly [number, number, number] | null;
}

/**
 * Sample the analytic gradient along a world-space direction's Y component:
 * `y = +1` is straight up (sky), `0` the horizon, `-1` straight down (ground).
 * An analytic approximation of the environment radiance — not a cosine-convolved
 * irradiance — computed identically on both backends and testable without a GPU.
 */
export function environmentColor(env: EnvironmentLight, y: number): [number, number, number] {
  const t = Math.max(-1, Math.min(1, y));
  const mix = (a: number, b: number, k: number): number => a + (b - a) * k;
  const pick = (i: number): number =>
    (t >= 0 ? mix(env.horizon[i]!, env.sky[i]!, t) : mix(env.horizon[i]!, env.ground[i]!, -t)) * env.intensity;
  return [pick(0), pick(1), pick(2)];
}

/** Nearest-sample an equirectangular map's RGB (0..1), wrapping longitude. */
function sampleEquirectRgb(map: DecodedTexture, u: number, v: number): [number, number, number] {
  const wu = u - Math.floor(u); // wrap longitude
  const cv = Math.min(1, Math.max(0, v)); // clamp latitude
  const tx = Math.min(map.width - 1, Math.floor(wu * map.width));
  const ty = Math.min(map.height - 1, Math.floor(cv * map.height));
  const at = (ty * map.width + tx) * 4;
  return [map.data[at]! / 255, map.data[at + 1]! / 255, map.data[at + 2]! / 255];
}

/**
 * Sample the environment along a full world-space direction. With a `map`, this
 * projects the direction to equirectangular UV (longitude = atan2(z, x),
 * latitude = acos(y)) and samples the panorama; without one, it falls back to the
 * gradient (which uses only Y), so a gradient environment is unchanged.
 */
export function sampleEnvironmentDir(
  env: EnvironmentLight,
  dx: number,
  dy: number,
  dz: number,
): [number, number, number] {
  if (env.map) {
    const len = Math.hypot(dx, dy, dz) || 1;
    const nx = dx / len;
    const ny = dy / len;
    const nz = dz / len;
    const u = Math.atan2(nz, nx) / (2 * Math.PI) + 0.5;
    const v = Math.acos(Math.min(1, Math.max(-1, ny))) / Math.PI; // 0 at top, 1 at bottom
    const [r, g, b] = sampleEquirectRgb(env.map, u, v);
    return [r * env.intensity, g * env.intensity, b * env.intensity];
  }
  return environmentColor(env, dy);
}

/**
 * The environment's mean radiance — the limit a fully-rough reflection converges
 * to. For a `map` it is the supplied `average`; for the gradient it is the mean
 * of the three stops.
 */
export function environmentAverage(env: EnvironmentLight): [number, number, number] {
  if (env.map && env.average) {
    return [env.average[0]! * env.intensity, env.average[1]! * env.intensity, env.average[2]! * env.intensity];
  }
  return [
    ((env.sky[0]! + env.horizon[0]! + env.ground[0]!) / 3) * env.intensity,
    ((env.sky[1]! + env.horizon[1]! + env.ground[1]!) / 3) * env.intensity,
    ((env.sky[2]! + env.horizon[2]! + env.ground[2]!) / 3) * env.intensity,
  ];
}

/**
 * HDR tone mapping for the Modern (AAA) tier (Phase 4). PBR shading accumulates
 * radiance that can exceed 1 (bright specular, emissive, a lit environment);
 * without tone mapping those channels clip flat to white. When a `ToneMap` is
 * set, the PBR branch multiplies by `exposure` and applies the ACES filmic curve,
 * so highlights roll off smoothly into the 8-bit framebuffer. Gated: absent one,
 * output is byte-identical (the fantasy tiers never tone-map).
 */
export interface ToneMap {
  /** Linear exposure multiplier applied before the curve (default 1). */
  readonly exposure: number;
}

/**
 * A light for the Modern (AAA) tier's multi-light forward path (Phase 4). The
 * fantasy tiers' lights ride the cart's 6-slot 2D mailbox, which is full (its
 * pmem block ends at the 256-word ceiling), so the Modern tier takes its lights
 * here instead — a dedicated scene channel with no fixed cap. A `directional`
 * light is the sun (parallel rays); a `point` light falls off to nothing at
 * `range`. Colours are 0..1 in the engine's byte space; `intensity` scales them.
 */
export interface SceneLight {
  readonly kind: "directional" | "point";
  /** Directional: unit direction *towards* the light. */
  readonly direction?: readonly [number, number, number];
  /** Point: world-space position. */
  readonly position?: readonly [number, number, number];
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  /** Point falloff radius in world units; ≤ 0 means no distance falloff. */
  readonly range?: number;
}

/**
 * The ACES filmic tone-map curve (Narkowicz's fit), per channel, clamped to
 * [0,1]. A cheap, widely-used approximation of the film response — the same
 * closed form on both backends, so it is testable without a GPU.
 */
export function acesFilmic(x: number): number {
  const v = Math.max(0, x);
  const mapped = (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14);
  return Math.min(1, Math.max(0, mapped));
}

/** The mean RGB (0..1) of an equirectangular map, for {@link EnvironmentLight.average}. */
export function computeEnvironmentAverage(map: DecodedTexture): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  const count = map.width * map.height;
  for (let i = 0; i < count; i += 1) {
    r += map.data[i * 4]!;
    g += map.data[i * 4 + 1]!;
    b += map.data[i * 4 + 2]!;
  }
  const denom = (count || 1) * 255;
  return [r / denom, g / denom, b / denom];
}

/**
 * Build the PBR fragment inputs for a primitive, or null when the material is
 * not PBR — in which case the rasteriser stays on the fantasy Blinn-Phong/diffuse
 * path and is byte-identical to before. A material is PBR when it carries any
 * metallic-roughness signal: a map, or an explicit metallic/roughness/emissive
 * factor (glTF import sets these; fantasy carts set none).
 */
function buildPbrFrag(
  material: MeshAsset["primitives"][number]["material"],
  mr: DecodedTexture | null,
  occ: DecodedTexture | null,
  emis: DecodedTexture | null,
): PbrFrag | null {
  const emissiveFactor = material.emissiveFactor;
  const isPbr =
    mr !== null ||
    occ !== null ||
    emis !== null ||
    material.metallicFactor !== undefined ||
    material.roughnessFactor !== undefined ||
    (emissiveFactor !== undefined && (emissiveFactor[0] > 0 || emissiveFactor[1] > 0 || emissiveFactor[2] > 0));
  if (!isPbr) return null;
  return {
    mr,
    occ,
    emis,
    metallic: material.metallicFactor ?? 1,
    roughness: material.roughnessFactor ?? 1,
    emissive: emissiveFactor ?? [0, 0, 0],
  };
}

/**
 * A directional-light shadow map (Phase 3): a depth buffer rendered from the
 * sun's orthographic view, plus that view's world→light-clip transform, so the
 * main pass can project each fragment into the light's frame and test whether
 * something nearer the sun already occupies it (a shadow). Fill it with
 * {@link renderShadowMap}; pass it to {@link renderMeshScene} to cast shadows.
 * Directional only — an orthographic light, which is what a sun is.
 */
export interface ShadowInput {
  /** Column-major world→light-clip (`lightProjection · lightView`). */
  readonly lightViewProj: Mat4;
  /** Depth map, `size × size`, light-NDC z, nearest-wins (from renderShadowMap). */
  readonly depth: Float32Array;
  /** Edge length of the square shadow map. */
  readonly size: number;
  /** Depth bias to suppress self-shadow acne (default 0.003, in light-NDC z). */
  readonly bias?: number;
  /** How dark a shadow is, 0 (none) .. 1 (black); default 1. */
  readonly strength?: number;
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
  // Light-space clip position (world→light-clip), for shadow mapping. Zero when
  // no shadow pass is active. The light is orthographic, so w = 1 and these are
  // already NDC — world-linear, so they interpolate with the same weights as UVs.
  lx: number;
  ly: number;
  lz: number;
  // World-space position, for point-light attenuation in the multi-light path.
  // Zero when no model matrix is threaded (the passes that don't need it).
  wx: number;
  wy: number;
  wz: number;
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
    lx: mix(a.lx, b.lx),
    ly: mix(a.ly, b.ly),
    lz: mix(a.lz, b.lz),
    wx: mix(a.wx, b.wx),
    wy: mix(a.wy, b.wy),
    wz: mix(a.wz, b.wz),
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

function sampleTexture(
  texture: DecodedTexture,
  u: number,
  v: number,
  filtering: RasterStyle["textureFiltering"] = "none",
): [number, number, number, number] {
  // Wrap, then sample. glTF's V origin is top-left, so flip.
  const wrap = (x: number): number => x - Math.floor(x);
  const fx = wrap(u) * texture.width;
  const fy = wrap(1 - v) * texture.height;

  if (filtering === "none") {
    const tx = Math.min(texture.width - 1, Math.floor(fx));
    const ty = Math.min(texture.height - 1, Math.floor(fy));
    const at = (ty * texture.width + tx) * 4;
    return [texture.data[at]!, texture.data[at + 1]!, texture.data[at + 2]!, texture.data[at + 3]!];
  }

  // Bilinear: sample about the texel *centre*, so a filter over a solid texture
  // returns that texture rather than blending toward its neighbours' edges.
  // Neighbours wrap, matching the repeat addressing above (and the GPU sampler).
  const cx = fx - 0.5;
  const cy = fy - 0.5;
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const tx = cx - x0;
  const ty = cy - y0;
  const wrapIndex = (value: number, size: number): number => ((value % size) + size) % size;
  const texel = (ix: number, iy: number, channel: number): number =>
    texture.data[(wrapIndex(iy, texture.height) * texture.width + wrapIndex(ix, texture.width)) * 4 + channel]!;

  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let channel = 0; channel < 4; channel += 1) {
    const top = texel(x0, y0, channel) * (1 - tx) + texel(x0 + 1, y0, channel) * tx;
    const bottom = texel(x0, y0 + 1, channel) * (1 - tx) + texel(x0 + 1, y0 + 1, channel) * tx;
    out[channel] = top * (1 - ty) + bottom * ty;
  }
  return out;
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

  // World-space direction towards the viewer (see renderMeshScene): the third
  // row of the view rotation, treated as directional.
  const viewDir = normalizeVec3(view[2]!, view[6]!, view[10]!);

  // The single mesh has no model transform, so model-view is the plain view and
  // normals need no re-basing: reuse the scene path with an identity model.
  drawMesh(
    mesh,
    viewProj,
    view,
    IDENTITY_MAT4,
    IDENTITY_3X3,
    size,
    size,
    out,
    depth,
    options.textures ?? null,
    options.normalTextures ?? null,
    options.materialTextures ?? null,
    options.mrTextures ?? null,
    options.occlusionTextures ?? null,
    options.emissiveTextures ?? null,
    light,
    viewDir,
    ambient,
    options.environment ?? null,
    null,
    null,
    options.tonemap ?? null,
    null,
    null,
  );
}

// --- Scene rendering: many placed meshes through one camera -----------------

/** A mesh placed in a shared world by a model matrix, with its own textures. */
/**
 * A level-of-detail chain for an instance (Phase 5): progressively cheaper meshes
 * chosen by camera distance. `meshes[0]` is the highest detail; `distances` are
 * ascending switch points, one fewer than `meshes` (past the last switch point
 * the coarsest mesh is used). Applied by `applyLods`; absent, `mesh` is drawn.
 */
export interface LodChain {
  readonly meshes: readonly MeshAsset[];
  readonly distances: readonly number[];
}

export interface MeshSceneInstance {
  readonly mesh: MeshAsset;
  /** Column-major world transform (see {@link composeModelMatrix}). */
  readonly model: Mat4;
  /** Optional level-of-detail chain; when set, `applyLods` swaps `mesh` by distance. */
  readonly lod?: LodChain | null;
  /** Decoded base-colour texture per primitive (index-aligned), or null entries. */
  readonly textures?: readonly (DecodedTexture | null)[];
  /**
   * Decoded tangent-space normal map per primitive (index-aligned), or null
   * entries. Where present, the fragment normal is perturbed by it (option 2);
   * where null, shading falls back to the geometric normal, unchanged.
   */
  readonly normalTextures?: readonly (DecodedTexture | null)[];
  /**
   * Decoded material map per primitive (index-aligned): RGBA where R = height,
   * G = specular strength, B = roughness, A = emissive. Where present, the
   * rasteriser adds a view-dependent specular highlight and lifts the surface to
   * at least its emissive floor (option 2, slice 5); where null, shading is the
   * plain diffuse path, unchanged.
   */
  readonly materialTextures?: readonly (DecodedTexture | null)[];
  /**
   * PBR (metallic-roughness) maps per primitive (index-aligned), for the Modern
   * tier. `mrTextures` is glTF's packed metallic-roughness (G = roughness,
   * B = metallic); `occlusionTextures` is R = AO; `emissiveTextures` is RGB.
   * When any PBR input is present the fragment is shaded with a metallic-roughness
   * BRDF; absent them, shading is byte-identical to the fantasy path.
   */
  readonly mrTextures?: readonly (DecodedTexture | null)[];
  readonly occlusionTextures?: readonly (DecodedTexture | null)[];
  readonly emissiveTextures?: readonly (DecodedTexture | null)[];
}

/**
 * How the rasteriser rasterises — the per-pixel behaviour that separates one
 * console generation from another.
 *
 * These are not quality settings. A PS1-era console is *defined* by having no
 * depth buffer and affine texture mapping; those artefacts are the era's look,
 * not defects to be tolerated. Keeping them here, rather than in the renderer
 * that calls this, is what lets the software path and the GPU path produce the
 * same picture for the same console model — see ERA_MODELS.md §4a.
 *
 * Every field defaults to what this rasteriser has always done, so an editor
 * preview that passes no style renders exactly as before.
 */
export interface RasterStyle {
  /**
   * False draws with no depth test or write, so draw order alone decides what
   * is in front. The scene path then sorts triangles back-to-front (an ordering
   * table, as the hardware without a depth buffer actually did), which is why
   * surfaces of similar depth interpenetrate and flicker.
   */
  readonly zBuffer: boolean;
  /**
   * False interpolates attributes affinely — linear in screen space rather than
   * weighted by 1/w. This is the texture "swimming" of the era: a wall's texture
   * warps as the camera slides past it.
   */
  readonly perspectiveCorrect: boolean;
  /**
   * "integer" snaps projected vertices to whole pixels, which is the
   * characteristic wobble of hardware whose transform unit had no subpixel
   * precision.
   */
  readonly vertexPrecision: "integer" | "float";
  /**
   * Texture magnification filter. "none" is nearest — crunchy, aliased texels.
   * "bilinear" is the softness of the generation that could afford to filter.
   */
  readonly textureFiltering: "none" | "bilinear";
}

/** What this rasteriser has always done: depth-buffered, correct, crisp. */
export const DEFAULT_RASTER_STYLE: RasterStyle = {
  zBuffer: true,
  perspectiveCorrect: true,
  vertexPrecision: "float",
  textureFiltering: "none",
};

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
  /** Image-based lighting environment for PBR materials (Modern tier); when set,
   *  it replaces the flat ambient term. See {@link EnvironmentLight}. */
  readonly environment?: EnvironmentLight | null;
  /** Directional shadow map (Modern tier); when set, the direct light is occluded
   *  where the light cannot see a fragment. Fill it first with
   *  {@link renderShadowMap}. See {@link ShadowInput}. */
  readonly shadow?: ShadowInput | null;
  /** HDR tone mapping for PBR materials (Modern tier). See {@link ToneMap}. */
  readonly tonemap?: ToneMap | null;
  /** Screen-space ambient-occlusion buffer (`width×height`, 0..1), or null. When
   *  set, it modulates the PBR ambient/IBL term. Build it with
   *  {@link renderGeometryBuffers} + {@link computeSsao}. */
  readonly ssao?: Float32Array | null;
  /** Multiple lights for PBR materials (Modern tier), replacing the single
   *  `lightDirection` key light. Directional + point; no fixed cap. See
   *  {@link SceneLight}. When omitted the single key light is used (unchanged). */
  readonly lights?: readonly SceneLight[] | null;
  /** Per-pixel rasterisation behaviour; defaults to {@link DEFAULT_RASTER_STYLE}. */
  readonly style?: RasterStyle;
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
  const environment = options.environment ?? null;
  const shadow = options.shadow ?? null;
  const tonemap = options.tonemap ?? null;
  const ssao = options.ssao ?? null;
  const lights = options.lights ?? null;
  const style = options.style ?? DEFAULT_RASTER_STYLE;
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

  // World-space direction from the surface *towards* the viewer, for the specular
  // half-vector. A look-at view maps this world direction to view +Z, so it is the
  // third row of the view rotation (V^T·(0,0,1)); treated as directional (camera
  // at infinity), which is what the flat 2D lit path assumes too.
  const viewDir = normalizeVec3(view[2]!, view[6]!, view[10]!);

  // With a depth buffer, order does not matter: rasterise as we project, which
  // allocates nothing. Without one, every triangle in the *whole scene* has to
  // be collected and sorted back-to-front before any of it is drawn — an
  // ordering table, which is what hardware without a depth buffer actually did.
  // Sorting per instance would not do: the artefact that defines the look is
  // triangles within and across objects resolving in the wrong order.
  const queue: PendingTriangle[] = [];
  for (const instance of instances) {
    const mvp = multiply(viewProj, instance.model);
    const modelView = multiply(view, instance.model);
    const normalBasis = normalMatrix3x3(instance.model);
    const textures = instance.textures ?? null;
    const normalTextures = instance.normalTextures ?? null;
    const materialTextures = instance.materialTextures ?? null;
    const mrTextures = instance.mrTextures ?? null;
    const occlusionTextures = instance.occlusionTextures ?? null;
    const emissiveTextures = instance.emissiveTextures ?? null;
    const lightMvp = shadow ? multiply(shadow.lightViewProj, instance.model) : null;
    if (style.zBuffer) {
      drawMesh(instance.mesh, mvp, modelView, instance.model, normalBasis, width, height, out, depth, textures, normalTextures, materialTextures, mrTextures, occlusionTextures, emissiveTextures, light, viewDir, ambient, environment, lightMvp, shadow, tonemap, ssao, lights, style);
    } else {
      eachTriangle(instance.mesh, mvp, modelView, instance.model, normalBasis, textures, normalTextures, materialTextures, mrTextures, occlusionTextures, emissiveTextures, lightMvp, (triangle) => queue.push(triangle));
    }
  }

  if (queue.length > 0) {
    // Ascending view z = farthest first, since the view looks down -z.
    queue.sort((a, b) => a.viewDepth - b.viewDepth);
    for (const triangle of queue) {
      rasterizeTriangle(
        triangle.a,
        triangle.b,
        triangle.c,
        width,
        height,
        out,
        depth,
        triangle.texture,
        triangle.normalTexture,
        triangle.tangent,
        triangle.materialTexture,
        triangle.pbr,
        triangle.base,
        light,
        viewDir,
        ambient,
        environment,
        shadow,
        tonemap,
        ssao,
        lights,
        style,
      );
    }
  }
}

/**
 * A right-handed orthographic projection mapping the box
 * `[left,right] × [bottom,top] × [near,far]` to NDC `[-1,1]³`. This is the
 * projection a directional light (a sun) casts shadows through: parallel rays,
 * no perspective, so the whole scene fits one depth map at a uniform scale.
 */
export function orthographicMatrix(
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
): Mat4 {
  const rl = 1 / (right - left);
  const tb = 1 / (top - bottom);
  const fn = 1 / (far - near);
  return Float64Array.from([
    2 * rl, 0, 0, 0,
    0, 2 * tb, 0, 0,
    0, 0, -2 * fn, 0,
    -(right + left) * rl, -(top + bottom) * tb, -(far + near) * fn, 1,
  ]);
}

/** How to render a directional-light depth map — the light's view + projection. */
export interface RenderShadowMapOptions {
  /** Column-major light view matrix (see {@link viewMatrix}). */
  readonly lightView: Mat4;
  /** Column-major light projection — orthographic (see {@link orthographicMatrix}). */
  readonly lightProjection: Mat4;
  /** Edge length of the square depth map. */
  readonly size: number;
  /** Depth output, `size × size`; reset to +Infinity each call. Reuse across frames. */
  readonly depth: Float32Array;
}

/**
 * Render the scene's depth from a directional light into `depth`, the first pass
 * of shadow mapping. Only depth is written — no shading, no colour — so it is
 * cheap. The stored value is light-NDC z (nearest-to-the-light wins), which
 * {@link renderMeshScene} then compares each fragment against via {@link ShadowInput}.
 *
 * Returns a {@link ShadowInput} wrapping the filled map and the light's
 * view-projection, ready to hand straight to `renderMeshScene`.
 */
export function renderShadowMap(
  instances: readonly MeshSceneInstance[],
  options: RenderShadowMapOptions,
): ShadowInput {
  const { lightView, lightProjection, size, depth } = options;
  const lightViewProj = multiply(lightProjection, lightView);
  depth.fill(Infinity);

  for (const instance of instances) {
    const mvp = multiply(lightViewProj, instance.model);
    const modelView = multiply(lightView, instance.model);
    // The light is the camera for this pass, so project through its mvp and write
    // depth only. No textures, normals or shadow recursion — pass nulls.
    eachTriangle(
      instance.mesh,
      mvp,
      modelView,
      instance.model,
      IDENTITY_3X3,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      (triangle) => rasterizeDepthOnly(triangle.a, triangle.b, triangle.c, size, depth),
    );
  }

  return { lightViewProj, depth, size };
}

/**
 * Rasterise one clipped triangle writing only NDC depth, nearest-wins — the
 * shadow map's inner loop. A stripped {@link rasterizeTriangle}: no attributes,
 * no shading, no perspective-correct interpolation (only z is needed, and NDC z
 * is linear in screen space).
 */
function rasterizeDepthOnly(a: Vertex, b: Vertex, c: Vertex, size: number, depth: Float32Array): void {
  const toScreen = (v: Vertex): { x: number; y: number; z: number } => {
    const invW = 1 / v.clip[3];
    return {
      x: (v.clip[0] * invW * 0.5 + 0.5) * size,
      y: (1 - (v.clip[1] * invW * 0.5 + 0.5)) * size,
      z: v.clip[2] * invW,
    };
  };
  const sa = toScreen(a);
  const sb = toScreen(b);
  const sc = toScreen(c);

  const area = (sb.x - sa.x) * (sc.y - sa.y) - (sb.y - sa.y) * (sc.x - sa.x);
  if (Math.abs(area) < 1e-9) return;
  const invArea = 1 / area;

  const minX = Math.max(0, Math.floor(Math.min(sa.x, sb.x, sc.x)));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(sa.x, sb.x, sc.x)));
  const minY = Math.max(0, Math.floor(Math.min(sa.y, sb.y, sc.y)));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(sa.y, sb.y, sc.y)));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((sb.x - px) * (sc.y - py) - (sb.y - py) * (sc.x - px)) * invArea;
      const w1 = ((sc.x - px) * (sa.y - py) - (sc.y - py) * (sa.x - px)) * invArea;
      const w2 = ((sa.x - px) * (sb.y - py) - (sa.y - py) * (sb.x - px)) * invArea;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * sa.z + w1 * sb.z + w2 * sc.z;
      const di = y * size + x;
      if (z < depth[di]!) depth[di] = z; // nearest to the light wins
    }
  }
}

// --- Screen-space ambient occlusion (Phase 4) ------------------------------

/** How to compute SSAO. All in view space (units of the scene). */
export interface SsaoOptions {
  /** Hemisphere sample radius, in view-space units (default 0.5). */
  readonly radius: number;
  /** Occlusion strength, 0 (off) .. ~2 (default 1). */
  readonly intensity: number;
  /** Depth bias to suppress self-occlusion (default 0.025). */
  readonly bias: number;
}

export const DEFAULT_SSAO: SsaoOptions = { radius: 0.5, intensity: 1, bias: 0.025 };

/** The camera-space geometry buffers SSAO reads: linear depth + view normals. */
export interface GeometryBuffers {
  /** View-space linear depth (eye distance, +ve; +Infinity where nothing drew), `width×height`. */
  readonly depth: Float32Array;
  /** View-space unit normals, 3 floats per pixel, `width×height×3`. */
  readonly normals: Float32Array;
  readonly width: number;
  readonly height: number;
}

export interface RenderGeometryOptions {
  readonly width: number;
  readonly height: number;
  readonly view: Mat4;
  readonly projection: Mat4;
}

/**
 * Render the scene's camera-space geometry — linear view depth + view-space
 * normals — the input SSAO needs. A stripped main pass (no shading, no textures):
 * the same projection + clip path, writing depth and normal instead of colour.
 */
export function renderGeometryBuffers(
  instances: readonly MeshSceneInstance[],
  options: RenderGeometryOptions,
): GeometryBuffers {
  const { width, height, view, projection } = options;
  const depth = new Float32Array(width * height).fill(Infinity);
  const normals = new Float32Array(width * height * 3);
  const viewProj = multiply(projection, view);

  for (const instance of instances) {
    const mvp = multiply(viewProj, instance.model);
    const modelView = multiply(view, instance.model);
    const normalBasis = normalMatrix3x3(instance.model);
    eachTriangle(instance.mesh, mvp, modelView, instance.model, normalBasis, null, null, null, null, null, null, null, (triangle) =>
      rasterizeGeometry(triangle.a, triangle.b, triangle.c, width, height, depth, normals, view),
    );
  }
  return { depth, normals, width, height };
}

/** Rasterise one triangle into the geometry buffers (view depth + view normal). */
function rasterizeGeometry(
  a: Vertex,
  b: Vertex,
  c: Vertex,
  width: number,
  height: number,
  depth: Float32Array,
  normals: Float32Array,
  view: Mat4,
): void {
  const toScreen = (v: Vertex): { x: number; y: number; invW: number } => {
    const invW = 1 / v.clip[3];
    return { x: (v.clip[0] * invW * 0.5 + 0.5) * width, y: (1 - (v.clip[1] * invW * 0.5 + 0.5)) * height, invW };
  };
  const sa = toScreen(a);
  const sb = toScreen(b);
  const sc = toScreen(c);
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
      const w0 = ((sb.x - px) * (sc.y - py) - (sb.y - py) * (sc.x - px)) * invArea;
      const w1 = ((sc.x - px) * (sa.y - py) - (sc.y - py) * (sa.x - px)) * invArea;
      const w2 = ((sa.x - px) * (sb.y - py) - (sa.y - py) * (sb.x - px)) * invArea;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;

      // Perspective-correct interpolation for view-space quantities.
      const iw = w0 * sa.invW + w1 * sb.invW + w2 * sc.invW;
      const pw0 = (w0 * sa.invW) / iw;
      const pw1 = (w1 * sb.invW) / iw;
      const pw2 = (w2 * sc.invW) / iw;
      const viewZ = pw0 * a.viewZ + pw1 * b.viewZ + pw2 * c.viewZ; // negative in front
      const d = -viewZ; // eye distance, positive
      const di = y * width + x;
      if (d >= depth[di]!) continue;
      depth[di] = d;

      // World normal → view space (view rotation is the upper-left 3x3).
      const wx = pw0 * a.nx + pw1 * b.nx + pw2 * c.nx;
      const wy = pw0 * a.ny + pw1 * b.ny + pw2 * c.ny;
      const wz = pw0 * a.nz + pw1 * b.nz + pw2 * c.nz;
      let vx = view[0]! * wx + view[4]! * wy + view[8]! * wz;
      let vy = view[1]! * wx + view[5]! * wy + view[9]! * wz;
      let vz = view[2]! * wx + view[6]! * wy + view[10]! * wz;
      const len = Math.hypot(vx, vy, vz) || 1;
      vx /= len;
      vy /= len;
      vz /= len;
      normals[di * 3] = vx;
      normals[di * 3 + 1] = vy;
      normals[di * 3 + 2] = vz;
    }
  }
}

/**
 * A fixed hemisphere kernel (tangent space, +Z up), lengths weighted toward the
 * origin so nearby occluders count more. Fixed (not randomly rotated) so the
 * result is deterministic and testable; the cost is faint banding, which a real
 * random-rotation noise texture would break up — a documented refinement.
 */
const SSAO_KERNEL: readonly (readonly [number, number, number])[] = (() => {
  const k: [number, number, number][] = [];
  const n = 16;
  for (let i = 0; i < n; i += 1) {
    // A deterministic spiral over the hemisphere.
    const a = i * 2.399963; // golden angle
    const r = Math.sqrt((i + 0.5) / n);
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    const z = Math.sqrt(Math.max(0, 1 - r * r));
    let scale = i / n;
    scale = 0.1 + 0.9 * scale * scale; // cluster near the origin
    k.push([x * scale, y * scale, z * scale]);
  }
  return k;
})();

/**
 * Compute a screen-space ambient-occlusion buffer (0 = fully occluded .. 1 = open)
 * from camera-space geometry buffers. For each pixel it reconstructs the view
 * position, orients the {@link SSAO_KERNEL} to the pixel normal, and counts how
 * many samples are hidden behind nearer geometry — the standard hemisphere SSAO.
 * Pure and DOM-free, so it is verifiable without a GPU.
 */
export function computeSsao(
  buffers: GeometryBuffers,
  projection: Mat4,
  options: SsaoOptions = DEFAULT_SSAO,
): Float32Array {
  const { depth, normals, width, height } = buffers;
  const ao = new Float32Array(width * height).fill(1);
  const tanHalfFovX = 1 / projection[0]!;
  const tanHalfFovY = 1 / projection[5]!;
  const { radius, intensity, bias } = options;

  // Reconstruct a view-space position from a pixel + its stored depth.
  const viewPos = (x: number, y: number, d: number): [number, number, number] => {
    const ndcX = ((x + 0.5) / width) * 2 - 1;
    const ndcY = 1 - ((y + 0.5) / height) * 2;
    return [ndcX * d * tanHalfFovX, ndcY * d * tanHalfFovY, -d];
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const di = y * width + x;
      const d = depth[di]!;
      if (!Number.isFinite(d)) continue; // background stays fully open
      const p = viewPos(x, y, d);
      const nx = normals[di * 3]!;
      const ny = normals[di * 3 + 1]!;
      const nz = normals[di * 3 + 2]!;

      // A TBN frame around the normal, T = normalize(up × N) with a deterministic
      // `up` that is never parallel to N, then B = N × T.
      const upZ = Math.abs(nz) < 0.999 ? 1 : 0;
      const upX = Math.abs(nz) < 0.999 ? 0 : 1;
      let txx = -upZ * ny;
      let tyy = upZ * nx - upX * nz;
      let tzz = upX * ny;
      const tl = Math.hypot(txx, tyy, tzz) || 1;
      txx /= tl;
      tyy /= tl;
      tzz /= tl;
      const bxx = ny * tzz - nz * tyy;
      const byy = nz * txx - nx * tzz;
      const bzz = nx * tyy - ny * txx;

      let occlusion = 0;
      for (const k of SSAO_KERNEL) {
        // Kernel sample into view space via the TBN frame.
        const sxv = txx * k[0] + bxx * k[1] + nx * k[2];
        const syv = tyy * k[0] + byy * k[1] + ny * k[2];
        const szv = tzz * k[0] + bzz * k[1] + nz * k[2];
        const spx = p[0] + sxv * radius;
        const spy = p[1] + syv * radius;
        const spz = p[2] + szv * radius;
        // Project the sample to screen.
        const clipX = projection[0]! * spx;
        const clipY = projection[5]! * spy;
        const clipW = -spz; // = proj[11]*spz, proj[11] = -1
        if (clipW <= 1e-6) continue;
        const sndcX = clipX / clipW;
        const sndcY = clipY / clipW;
        const ssx = Math.floor((sndcX * 0.5 + 0.5) * width);
        const ssy = Math.floor((1 - (sndcY * 0.5 + 0.5)) * height);
        if (ssx < 0 || ssx >= width || ssy < 0 || ssy >= height) continue;
        const storedD = depth[ssy * width + ssx]!;
        if (!Number.isFinite(storedD)) continue;
        const sampleD = -spz; // the sample's own eye distance
        // Occluded when the stored surface is nearer than the sample by > bias,
        // range-checked so distant geometry through a gap does not over-darken.
        if (storedD <= sampleD - bias) {
          const rangeCheck = radius / (Math.abs(d - storedD) + 1e-4);
          occlusion += Math.min(1, rangeCheck);
        }
      }
      ao[di] = Math.max(0, Math.min(1, 1 - (occlusion / SSAO_KERNEL.length) * intensity));
    }
  }
  return ao;
}

/**
 * Draw one mesh's primitives, projecting positions by `mvp` (to clip space) and
 * `modelView` (for the view-space z the near clipper needs), and re-basing object
 * normals into world space by `normalBasis`. Shared by the single-mesh preview
 * and the scene renderer so the projection + clip + raster path is written once.
 */
/**
 * Per-fragment PBR (metallic-roughness) inputs for a primitive, or null when the
 * material is not PBR (the fantasy-console path). Present only for Modern-tier
 * materials; when set, {@link rasterizeTriangle} shades with a metallic-roughness
 * BRDF instead of the Blinn-Phong/diffuse path.
 */
interface PbrFrag {
  /** glTF packed metallic-roughness (G = roughness, B = metallic), or null. */
  readonly mr: DecodedTexture | null;
  /** Ambient-occlusion map (R = AO), or null. */
  readonly occ: DecodedTexture | null;
  /** Emissive map (RGB), or null. */
  readonly emis: DecodedTexture | null;
  readonly metallic: number; // factor (default 1)
  readonly roughness: number; // factor (default 1)
  readonly emissive: readonly [number, number, number]; // factor (default 0,0,0)
}

/** One projected, clipped triangle ready to rasterise. */
interface PendingTriangle {
  readonly a: Vertex;
  readonly b: Vertex;
  readonly c: Vertex;
  readonly texture: DecodedTexture | null;
  /** Tangent-space normal map, or null to shade by the geometric normal. */
  readonly normalTexture: DecodedTexture | null;
  /** World-space surface tangent (constant per triangle), for the TBN frame, or
   *  null when there is no normal map or the UVs are degenerate. */
  readonly tangent: readonly [number, number, number] | null;
  /** Packed material map (specular/roughness/emissive), or null for plain diffuse. */
  readonly materialTexture: DecodedTexture | null;
  /** PBR metallic-roughness inputs (Modern tier), or null for the fantasy path. */
  readonly pbr: PbrFrag | null;
  readonly base: readonly [number, number, number, number];
  /**
   * Mean view-space z, for back-to-front ordering when there is no depth
   * buffer. The view looks down -z, so farther is more negative and ascending
   * order is farthest-first.
   */
  readonly viewDepth: number;
}

/**
 * Project, clip and hand out one mesh's triangles.
 *
 * Split out from {@link drawMesh} so a caller can either rasterise each triangle
 * as it arrives (the depth-buffered path, which needs no ordering and so
 * allocates nothing) or collect them all and sort before drawing (the path for
 * a console model with no depth buffer).
 */
function eachTriangle(
  mesh: MeshAsset,
  mvp: Mat4,
  modelView: Mat4,
  model: Mat4,
  normalBasis: readonly number[],
  textures: readonly (DecodedTexture | null)[] | null,
  normalTextures: readonly (DecodedTexture | null)[] | null,
  materialTextures: readonly (DecodedTexture | null)[] | null,
  mrTextures: readonly (DecodedTexture | null)[] | null,
  occlusionTextures: readonly (DecodedTexture | null)[] | null,
  emissiveTextures: readonly (DecodedTexture | null)[] | null,
  /** World→light-clip for shadow mapping, or null when no shadow pass is active. */
  lightMvp: Mat4 | null,
  emit: (triangle: PendingTriangle) => void,
): void {
  mesh.primitives.forEach((primitive, primitiveIndex) => {
    const positions = primitive.positions;
    const objectNormals = primitive.normals ?? computeSmoothNormals(positions, primitive.indices);
    const uvs = primitive.uvs;
    const indices = primitive.indices;
    const texture = textures?.[primitiveIndex] ?? null;
    const normalTexture = normalTextures?.[primitiveIndex] ?? null;
    const materialTexture = materialTextures?.[primitiveIndex] ?? null;
    const pbr = buildPbrFrag(
      primitive.material,
      mrTextures?.[primitiveIndex] ?? null,
      occlusionTextures?.[primitiveIndex] ?? null,
      emissiveTextures?.[primitiveIndex] ?? null,
    );
    const [baseR, baseG, baseB, baseA] = primitive.material.baseColorFactor;

    // The world-space surface tangent for one triangle, from its positions and
    // UVs (Lengyel's method), for the TBN frame a normal map is applied in. Only
    // needed when a normal map is present; null for degenerate UVs so shading
    // falls back to the geometric normal.
    const worldTangent = (i0: number, i1: number, i2: number): readonly [number, number, number] | null => {
      if (!uvs) return null;
      const e1x = positions[i1 * 3]! - positions[i0 * 3]!;
      const e1y = positions[i1 * 3 + 1]! - positions[i0 * 3 + 1]!;
      const e1z = positions[i1 * 3 + 2]! - positions[i0 * 3 + 2]!;
      const e2x = positions[i2 * 3]! - positions[i0 * 3]!;
      const e2y = positions[i2 * 3 + 1]! - positions[i0 * 3 + 1]!;
      const e2z = positions[i2 * 3 + 2]! - positions[i0 * 3 + 2]!;
      const du1 = uvs[i1 * 2]! - uvs[i0 * 2]!;
      const dv1 = uvs[i1 * 2 + 1]! - uvs[i0 * 2 + 1]!;
      const du2 = uvs[i2 * 2]! - uvs[i0 * 2]!;
      const dv2 = uvs[i2 * 2 + 1]! - uvs[i0 * 2 + 1]!;
      const denom = du1 * dv2 - du2 * dv1;
      if (Math.abs(denom) < 1e-12) return null;
      const r = 1 / denom;
      const tox = (e1x * dv2 - e2x * dv1) * r;
      const toy = (e1y * dv2 - e2y * dv1) * r;
      const toz = (e1z * dv2 - e2z * dv1) * r;
      // Re-base into world space with the same basis as the normals.
      const tx = normalBasis[0]! * tox + normalBasis[3]! * toy + normalBasis[6]! * toz;
      const ty = normalBasis[1]! * tox + normalBasis[4]! * toy + normalBasis[7]! * toz;
      const tz = normalBasis[2]! * tox + normalBasis[5]! * toy + normalBasis[8]! * toz;
      const len = Math.hypot(tx, ty, tz);
      if (len < 1e-8) return null;
      return [tx / len, ty / len, tz / len];
    };

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
      // Light-space clip for shadow mapping. The light is orthographic, so w = 1
      // and these are already NDC; world-linear, so they interpolate like UVs.
      let lx = 0;
      let ly = 0;
      let lz = 0;
      if (lightMvp) {
        lx = lightMvp[0]! * x + lightMvp[4]! * y + lightMvp[8]! * z + lightMvp[12]!;
        ly = lightMvp[1]! * x + lightMvp[5]! * y + lightMvp[9]! * z + lightMvp[13]!;
        lz = lightMvp[2]! * x + lightMvp[6]! * y + lightMvp[10]! * z + lightMvp[14]!;
      }
      return {
        clip: [cx, cy, cz, cw],
        viewZ,
        u: uvs ? uvs[i * 2]! : 0,
        v: uvs ? uvs[i * 2 + 1]! : 0,
        nx: normalBasis[0]! * onx + normalBasis[3]! * ony + normalBasis[6]! * onz,
        ny: normalBasis[1]! * onx + normalBasis[4]! * ony + normalBasis[7]! * onz,
        nz: normalBasis[2]! * onx + normalBasis[5]! * ony + normalBasis[8]! * onz,
        lx,
        ly,
        lz,
        // World-space position (model · objectPos), for point-light attenuation.
        wx: model[0]! * x + model[4]! * y + model[8]! * z + model[12]!,
        wy: model[1]! * x + model[5]! * y + model[9]! * z + model[13]!,
        wz: model[2]! * x + model[6]! * y + model[10]! * z + model[14]!,
      };
    };

    const base: readonly [number, number, number, number] = [baseR, baseG, baseB, baseA];

    for (let t = 0; t < indices.length; t += 3) {
      const i0 = indices[t]!;
      const i1 = indices[t + 1]!;
      const i2 = indices[t + 2]!;
      // The tangent is constant across the triangle, so compute it once (before
      // clipping) and share it with every clipped piece.
      const tangent = normalTexture ? worldTangent(i0, i1, i2) : null;
      const clipped = clipNear([project(i0), project(i1), project(i2)]);
      for (let c = 0; c < clipped.length; c += 3) {
        const a = clipped[c]!;
        const b = clipped[c + 1]!;
        const cc = clipped[c + 2]!;
        emit({ a, b, c: cc, texture, normalTexture, tangent, materialTexture, pbr, base, viewDepth: (a.viewZ + b.viewZ + cc.viewZ) / 3 });
      }
    }
  });
}

/** Project and rasterise one mesh straight into the buffers. */
function drawMesh(
  mesh: MeshAsset,
  mvp: Mat4,
  modelView: Mat4,
  model: Mat4,
  normalBasis: readonly number[],
  width: number,
  height: number,
  out: Uint8ClampedArray,
  depth: Float32Array,
  textures: readonly (DecodedTexture | null)[] | null,
  normalTextures: readonly (DecodedTexture | null)[] | null,
  materialTextures: readonly (DecodedTexture | null)[] | null,
  mrTextures: readonly (DecodedTexture | null)[] | null,
  occlusionTextures: readonly (DecodedTexture | null)[] | null,
  emissiveTextures: readonly (DecodedTexture | null)[] | null,
  light: readonly [number, number, number],
  viewDir: readonly [number, number, number],
  ambient: number,
  environment: EnvironmentLight | null,
  lightMvp: Mat4 | null,
  shadow: ShadowInput | null,
  tonemap: ToneMap | null,
  ssao: Float32Array | null,
  lights: readonly SceneLight[] | null,
  style: RasterStyle = DEFAULT_RASTER_STYLE,
): void {
  eachTriangle(
    mesh,
    mvp,
    modelView,
    model,
    normalBasis,
    textures,
    normalTextures,
    materialTextures,
    mrTextures,
    occlusionTextures,
    emissiveTextures,
    lightMvp,
    (triangle) => {
      rasterizeTriangle(
        triangle.a,
        triangle.b,
        triangle.c,
        width,
        height,
        out,
        depth,
        triangle.texture,
        triangle.normalTexture,
        triangle.tangent,
        triangle.materialTexture,
        triangle.pbr,
        triangle.base,
        light,
        viewDir,
        ambient,
        environment,
        shadow,
        tonemap,
        ssao,
        lights,
        style,
      );
    },
  );
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
  normalTexture: DecodedTexture | null,
  tangent: readonly [number, number, number] | null,
  materialTexture: DecodedTexture | null,
  pbr: PbrFrag | null,
  base: readonly [number, number, number, number],
  light: readonly [number, number, number],
  viewDir: readonly [number, number, number],
  ambient: number,
  environment: EnvironmentLight | null,
  shadow: ShadowInput | null,
  tonemap: ToneMap | null,
  ssao: Float32Array | null,
  lights: readonly SceneLight[] | null,
  style: RasterStyle = DEFAULT_RASTER_STYLE,
): void {
  // Perspective divide to NDC, then to screen pixels. NDC spans the full extent
  // of each axis independently, so x maps by width and y by height — a mesh drawn
  // into a non-square framebuffer (the runtime's 240×136) is undistorted as long
  // as the projection's aspect matches width/height.
  const snap = style.vertexPrecision === "integer";
  const toScreen = (v: Vertex): { x: number; y: number; z: number; invW: number } => {
    const invW = 1 / v.clip[3];
    const x = (v.clip[0] * invW * 0.5 + 0.5) * width;
    const y = (1 - (v.clip[1] * invW * 0.5 + 0.5)) * height;
    return {
      // Snapping to whole pixels is the wobble of a transform unit with no
      // subpixel precision: a vertex jumps between pixels as the camera moves
      // instead of sliding smoothly across them.
      x: snap ? Math.round(x) : x,
      y: snap ? Math.round(y) : y,
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
      const w0 = ((sb.x - px) * (sc.y - py) - (sb.y - py) * (sc.x - px)) * invArea;
      const w1 = ((sc.x - px) * (sa.y - py) - (sc.y - py) * (sa.x - px)) * invArea;
      const w2 = ((sa.x - px) * (sb.y - py) - (sa.y - py) * (sb.x - px)) * invArea;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;

      const zNdc = w0 * sa.z + w1 * sb.z + w2 * sc.z; // linear in screen space
      const di = y * width + x;
      // Without a depth buffer nothing is rejected here: draw order decides,
      // which is why the scene path sorts back-to-front when zBuffer is off.
      if (style.zBuffer && zNdc >= depth[di]!) continue;

      // Perspective-correct interpolation weights by 1/w and divides. Affine
      // (the era look) uses the screen-space weights directly, which is what
      // makes a texture swim as the camera slides past a surface.
      let pw0 = w0;
      let pw1 = w1;
      let pw2 = w2;
      if (style.perspectiveCorrect) {
        const iw = w0 * sa.invW + w1 * sb.invW + w2 * sc.invW;
        pw0 = (w0 * sa.invW) / iw;
        pw1 = (w1 * sb.invW) / iw;
        pw2 = (w2 * sc.invW) / iw;
      }

      // Interpolate the geometric normal.
      let nx = pw0 * a.nx + pw1 * b.nx + pw2 * c.nx;
      let ny = pw0 * a.ny + pw1 * b.ny + pw2 * c.ny;
      let nz = pw0 * a.nz + pw1 * b.nz + pw2 * c.nz;

      // Normal mapping (option 2): perturb the geometric normal by the sampled
      // tangent-space normal, in the TBN frame built from the surface tangent.
      // Absent a normal map or a valid tangent, this is skipped and shading is
      // exactly the geometric-normal path.
      if (normalTexture && tangent) {
        const u = pw0 * a.u + pw1 * b.u + pw2 * c.u;
        const v = pw0 * a.v + pw1 * b.v + pw2 * c.v;
        const [snr, sng, snb] = sampleTexture(normalTexture, u, v, style.textureFiltering);
        // Decode RGB -> tangent-space normal in [-1, 1].
        const tnx = (snr / 255) * 2 - 1;
        const tny = (sng / 255) * 2 - 1;
        const tnz = (snb / 255) * 2 - 1;
        // Normalise the interpolated geometric normal (N) for the frame.
        const nlen = Math.hypot(nx, ny, nz) || 1;
        const Nx = nx / nlen;
        const Ny = ny / nlen;
        const Nz = nz / nlen;
        // Gram-Schmidt the tangent (T) against N, then bitangent B = N × T.
        const td = tangent[0] * Nx + tangent[1] * Ny + tangent[2] * Nz;
        let Tx = tangent[0] - Nx * td;
        let Ty = tangent[1] - Ny * td;
        let Tz = tangent[2] - Nz * td;
        const tlen = Math.hypot(Tx, Ty, Tz);
        if (tlen > 1e-6) {
          Tx /= tlen;
          Ty /= tlen;
          Tz /= tlen;
          const Bx = Ny * Tz - Nz * Ty;
          const By = Nz * Tx - Nx * Tz;
          const Bz = Nx * Ty - Ny * Tx;
          // World normal = T*tnx + B*tny + N*tnz.
          const px2 = Tx * tnx + Bx * tny + Nx * tnz;
          const py2 = Ty * tnx + By * tny + Ny * tnz;
          const pz2 = Tz * tnx + Bz * tny + Nz * tnz;
          const plen = Math.hypot(px2, py2, pz2) || 1;
          nx = px2 / plen;
          ny = py2 / plen;
          nz = pz2 / plen;
        }
      }

      // Directional shadow map (Phase 3): project this fragment into the light's
      // orthographic frame and compare its depth against the nearest surface the
      // light sees there. `shadowLit` is 1 when lit, `1 − strength` when occluded;
      // it scales the *direct* light only (ambient/IBL still fills a shadow).
      // Absent a shadow input it stays 1, so non-Modern renders are unchanged.
      let shadowLit = 1;
      if (shadow) {
        const lxi = pw0 * a.lx + pw1 * b.lx + pw2 * c.lx;
        const lyi = pw0 * a.ly + pw1 * b.ly + pw2 * c.ly;
        const lzi = pw0 * a.lz + pw1 * b.lz + pw2 * c.lz;
        const sx = (lxi * 0.5 + 0.5) * shadow.size;
        const sy = (1 - (lyi * 0.5 + 0.5)) * shadow.size;
        if (sx >= 0 && sx < shadow.size && sy >= 0 && sy < shadow.size && lzi >= -1 && lzi <= 1) {
          const tx = Math.min(shadow.size - 1, Math.max(0, Math.floor(sx)));
          const ty = Math.min(shadow.size - 1, Math.max(0, Math.floor(sy)));
          const stored = shadow.depth[ty * shadow.size + tx]!;
          const bias = shadow.bias ?? 0.003;
          if (lzi - bias > stored) shadowLit = 1 - (shadow.strength ?? 1);
        }
      }

      // Two-sided Lambert: |N·L| so inconsistent winding still lights.
      const nl = Math.abs(nx * light[0] + ny * light[1] + nz * light[2]);
      const shade = ambient + (1 - ambient) * nl * shadowLit;

      let r = base[0] * 255;
      let g = base[1] * 255;
      let bl = base[2] * 255;
      let al = base[3] * 255;
      if (texture) {
        const u = pw0 * a.u + pw1 * b.u + pw2 * c.u;
        const v = pw0 * a.v + pw1 * b.v + pw2 * c.v;
        const [tr, tg, tb, ta] = sampleTexture(texture, u, v, style.textureFiltering);
        r = (r * tr) / 255;
        g = (g * tg) / 255;
        bl = (bl * tb) / 255;
        al = (al * ta) / 255;
      }
      if (al < 1) continue; // skip fully-transparent texels rather than blend (opaque preview)

      if (style.zBuffer) depth[di] = zNdc;

      if (pbr) {
        // --- Modern tier: metallic-roughness BRDF (Cook-Torrance) ---
        // Shaded in the engine's non-linear byte space for now; a linear/gamma-
        // correct HDR pipeline is a later phase (AAA_TIER_ROADMAP.md 2b/4). The
        // ambient term is a flat IBL stand-in until real image-based lighting
        // lands in Phase 3.
        const u = pw0 * a.u + pw1 * b.u + pw2 * c.u;
        const v = pw0 * a.v + pw1 * b.v + pw2 * c.v;
        // Normalise N and flip it toward the viewer, so imported geometry of
        // either winding lights correctly (two-sided).
        const nlen = Math.hypot(nx, ny, nz) || 1;
        let Nx = nx / nlen;
        let Ny = ny / nlen;
        let Nz = nz / nlen;
        if (Nx * viewDir[0] + Ny * viewDir[1] + Nz * viewDir[2] < 0) {
          Nx = -Nx;
          Ny = -Ny;
          Nz = -Nz;
        }
        let metallic = pbr.metallic;
        let rough = pbr.roughness;
        if (pbr.mr) {
          const [, mg, mb] = sampleTexture(pbr.mr, u, v, style.textureFiltering);
          rough *= mg / 255;
          metallic *= mb / 255;
        }
        rough = Math.min(1, Math.max(0.045, rough)); // clamp: perfectly-smooth NDF blows up
        const ao = pbr.occ ? sampleTexture(pbr.occ, u, v, style.textureFiltering)[0] / 255 : 1;
        const ar = r / 255;
        const ag = g / 255;
        const ab = bl / 255;
        // Half-vector of the directional light + view (camera-at-infinity).
        let hx = light[0] + viewDir[0];
        let hy = light[1] + viewDir[1];
        let hz = light[2] + viewDir[2];
        const hl = Math.hypot(hx, hy, hz) || 1;
        hx /= hl;
        hy /= hl;
        hz /= hl;
        const ndl = Math.max(0, Nx * light[0] + Ny * light[1] + Nz * light[2]);
        const ndv = Math.max(1e-4, Nx * viewDir[0] + Ny * viewDir[1] + Nz * viewDir[2]);
        const ndh = Math.max(0, Nx * hx + Ny * hy + Nz * hz);
        const vdh = Math.max(0, viewDir[0] * hx + viewDir[1] * hy + viewDir[2] * hz);
        const a2 = rough * rough * rough * rough; // (rough^2)^2 for the GGX NDF
        const dd = ndh * ndh * (a2 - 1) + 1;
        const D = a2 / (Math.PI * dd * dd + 1e-7);
        const k = ((rough + 1) * (rough + 1)) / 8; // Schlick-GGX (direct lighting)
        const G = (ndv / (ndv * (1 - k) + k)) * (ndl / (ndl * (1 - k) + k));
        const fp = Math.pow(1 - vdh, 5); // Fresnel-Schlick
        const specD = (D * G) / (4 * ndl * ndv + 1e-4);
        const f0r = 0.04 + (ar - 0.04) * metallic;
        const f0g = 0.04 + (ag - 0.04) * metallic;
        const f0b = 0.04 + (ab - 0.04) * metallic;
        const Fr = f0r + (1 - f0r) * fp;
        const Fg = f0g + (1 - f0g) * fp;
        const Fb = f0b + (1 - f0b) * fp;
        const kdm = 1 - metallic; // metals have no diffuse
        let er = 0;
        let eg = 0;
        let eb = 0;
        if (pbr.emissive[0] > 0 || pbr.emissive[1] > 0 || pbr.emissive[2] > 0) {
          const es = pbr.emis ? sampleTexture(pbr.emis, u, v, style.textureFiltering) : [255, 255, 255, 255];
          er = pbr.emissive[0] * (es[0]! / 255);
          eg = pbr.emissive[1] * (es[1]! / 255);
          eb = pbr.emissive[2] * (es[2]! / 255);
        }
        // Ambient / image-based lighting. With no environment this is the flat
        // ambient stand-in (byte-identical to Phase 2). With one, it becomes
        // directional: a diffuse irradiance sampled along N, plus a specular
        // reflection sampled along R and blurred toward the environment's average
        // as roughness rises — so metals mirror their surroundings and every
        // surface's fill light takes the colour of the sky it faces.
        let ambR: number;
        let ambG: number;
        let ambB: number;
        if (environment) {
          const [ir, ig, ib] = sampleEnvironmentDir(environment, Nx, Ny, Nz);
          // Reflection of the view direction about N (N already faces the viewer).
          const rx = 2 * ndv * Nx - viewDir[0];
          const ry = 2 * ndv * Ny - viewDir[1];
          const rz = 2 * ndv * Nz - viewDir[2];
          const [pr, pg, pb] = sampleEnvironmentDir(environment, rx, ry, rz);
          const [avr, avg, avb] = environmentAverage(environment);
          const specR = pr + (avr - pr) * rough;
          const specG = pg + (avg - pg) * rough;
          const specB = pb + (avb - pb) * rough;
          ambR = (ir * ar * kdm + specR * f0r) * ao;
          ambG = (ig * ag * kdm + specG * f0g) * ao;
          ambB = (ib * ab * kdm + specB * f0b) * ao;
        } else {
          ambR = ambient * ar * ao;
          ambG = ambient * ag * ao;
          ambB = ambient * ab * ao;
        }
        // Screen-space ambient occlusion darkens only the ambient/IBL fill (never
        // the direct light), matching where AO physically applies.
        if (ssao) {
          const s = ssao[di]!;
          ambR *= s;
          ambG *= s;
          ambB *= s;
        }
        // The direct light is what a shadow occludes; ambient/IBL still fills it.
        // This is the linear radiance, which can exceed 1 (bright spec/emissive/
        // environment).
        let lr: number;
        let lg: number;
        let lb: number;
        if (lights && lights.length > 0) {
          // --- Multi-light forward accumulation (Modern tier) ---
          // Each light re-evaluates the Cook-Torrance direct term with its own
          // direction + radiance; the light-independent factors (N, ndv, f0, kdm,
          // a2, k) are shared. Point lights fall off to nothing at their range.
          const wx = pw0 * a.wx + pw1 * b.wx + pw2 * c.wx;
          const wy = pw0 * a.wy + pw1 * b.wy + pw2 * c.wy;
          const wz = pw0 * a.wz + pw1 * b.wz + pw2 * c.wz;
          let dR = 0;
          let dG = 0;
          let dB = 0;
          for (const lgt of lights) {
            let Lx: number;
            let Ly: number;
            let Lz: number;
            let atten = 1;
            if (lgt.kind === "point") {
              const px = (lgt.position?.[0] ?? 0) - wx;
              const py = (lgt.position?.[1] ?? 0) - wy;
              const pz = (lgt.position?.[2] ?? 0) - wz;
              const dist = Math.hypot(px, py, pz) || 1e-4;
              Lx = px / dist;
              Ly = py / dist;
              Lz = pz / dist;
              const range = lgt.range ?? 0;
              if (range > 0) {
                const t = Math.max(0, 1 - dist / range);
                atten = t * t;
              }
            } else {
              const dir = lgt.direction ?? [0, 1, 0];
              const dl = Math.hypot(dir[0]!, dir[1]!, dir[2]!) || 1;
              Lx = dir[0]! / dl;
              Ly = dir[1]! / dl;
              Lz = dir[2]! / dl;
            }
            const ndlL = Math.max(0, Nx * Lx + Ny * Ly + Nz * Lz);
            if (ndlL <= 0 || atten <= 0) continue;
            let hxL = Lx + viewDir[0];
            let hyL = Ly + viewDir[1];
            let hzL = Lz + viewDir[2];
            const hlL = Math.hypot(hxL, hyL, hzL) || 1;
            hxL /= hlL;
            hyL /= hlL;
            hzL /= hlL;
            const ndhL = Math.max(0, Nx * hxL + Ny * hyL + Nz * hzL);
            const vdhL = Math.max(0, viewDir[0] * hxL + viewDir[1] * hyL + viewDir[2] * hzL);
            const ddL = ndhL * ndhL * (a2 - 1) + 1;
            const DL = a2 / (Math.PI * ddL * ddL + 1e-7);
            const GL = (ndv / (ndv * (1 - k) + k)) * (ndlL / (ndlL * (1 - k) + k));
            const fpL = Math.pow(1 - vdhL, 5);
            const specL = (DL * GL) / (4 * ndlL * ndv + 1e-4);
            const FrL = f0r + (1 - f0r) * fpL;
            const FgL = f0g + (1 - f0g) * fpL;
            const FbL = f0b + (1 - f0b) * fpL;
            // Directional lights are the ones the sun shadow map occludes; a point
            // light is unshadowed here (its own shadow map would be a follow-up).
            const occl = lgt.kind === "directional" ? shadowLit : 1;
            const w = lgt.intensity * atten * ndlL * occl;
            dR += (kdm * (1 - FrL) * ar + FrL * specL) * lgt.color[0]! * w;
            dG += (kdm * (1 - FgL) * ag + FgL * specL) * lgt.color[1]! * w;
            dB += (kdm * (1 - FbL) * ab + FbL * specL) * lgt.color[2]! * w;
          }
          lr = dR + ambR + er;
          lg = dG + ambG + eg;
          lb = dB + ambB + eb;
        } else {
          lr = (kdm * (1 - Fr) * ar + Fr * specD) * ndl * shadowLit + ambR + er;
          lg = (kdm * (1 - Fg) * ag + Fg * specD) * ndl * shadowLit + ambG + eg;
          lb = (kdm * (1 - Fb) * ab + Fb * specD) * ndl * shadowLit + ambB + eb;
        }
        if (tonemap) {
          // HDR: expose, then roll highlights off with the ACES curve instead of
          // clipping flat to white.
          const e = tonemap.exposure;
          out[di * 4] = acesFilmic(lr * e) * 255;
          out[di * 4 + 1] = acesFilmic(lg * e) * 255;
          out[di * 4 + 2] = acesFilmic(lb * e) * 255;
        } else {
          out[di * 4] = lr * 255;
          out[di * 4 + 1] = lg * 255;
          out[di * 4 + 2] = lb * 255;
        }
        out[di * 4 + 3] = al;
      } else {
        // --- Fantasy path (unchanged) ---
        // Material map (option 2, slice 5): a view-dependent Blinn-Phong glint
        // plus an emissive floor, the same model the 2D lit renderer uses.
        let glint = 0;
        let emissive = 0;
        if (materialTexture) {
          const u = pw0 * a.u + pw1 * b.u + pw2 * c.u;
          const v = pw0 * a.v + pw1 * b.v + pw2 * c.v;
          const [, spec, rough, emis] = sampleTexture(materialTexture, u, v, style.textureFiltering);
          const specStrength = spec / 255;
          emissive = emis / 255;
          if (specStrength > 0) {
            const nlen = Math.hypot(nx, ny, nz) || 1;
            const Nx = nx / nlen;
            const Ny = ny / nlen;
            const Nz = nz / nlen;
            let hx = light[0] + viewDir[0];
            let hy = light[1] + viewDir[1];
            let hz = light[2] + viewDir[2];
            const hlen = Math.hypot(hx, hy, hz) || 1;
            hx /= hlen;
            hy /= hlen;
            hz /= hlen;
            const nh = Math.max(0, Nx * hx + Ny * hy + Nz * hz);
            const roughness = rough / 255;
            const shininess = 6 + (120 - 6) * (1 - roughness);
            glint = 255 * Math.pow(nh, shininess) * specStrength;
          }
        }
        // A self-illuminated texel never drops below its own colour scaled by the
        // emissive level, so it stays bright when the light turns away.
        out[di * 4] = Math.max(r * shade + glint, r * emissive);
        out[di * 4 + 1] = Math.max(g * shade + glint, g * emissive);
        out[di * 4 + 2] = Math.max(bl * shade + glint, bl * emissive);
        out[di * 4 + 3] = al;
      }
    }
  }
}
