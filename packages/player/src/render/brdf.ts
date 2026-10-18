/**
 * The AAA tier's BRDF (AAA_FIDELITY_ROADMAP.md F1c): what the linear-light
 * shader adds over the Modern tier's Cook-Torrance, which mirrors the software
 * rasteriser term for term and so keeps its simplifications.
 *
 * - **A height-correlated Smith visibility** (Heitz 2014) in place of the
 *   separable Schlick-GGX: the shadowing and masking of one microsurface are
 *   not independent, and treating them as such darkens rough grazing light.
 * - **The split-sum DFG** (Karis 2013): the environment's specular reflection
 *   weighted by the integral of the BRDF over the hemisphere, f0·A + B, in
 *   place of f0 alone, so a dielectric's reflection rises toward grazing
 *   (Fresnel on ambient) and a rough one's falls (its lost energy).
 * - **Multiple scattering** (Kulla-Conty 2017, in Fdez-Agüera's 2019 closed
 *   form): single-scatter GGX loses the light that bounces more than once
 *   between microfacets, two thirds of it head-on at full roughness. It is added back, for
 *   the environment as a lobe of its own and for each light as a scale on the
 *   specular, so a rough metal in a white furnace stays white.
 * - **Specular occlusion** from the ambient occlusion (Lagarde 2014): an
 *   occluded crevice reflects less of the sky, by an amount that narrows with
 *   a smoother lobe.
 *
 * The DFG table is integrated here once, on the CPU, by GGX importance
 * sampling with the same visibility the shader uses, and read by the shader
 * from a storage buffer: the fragment stage's sampled textures are all bound.
 */

/** The table's resolution: N·V across, roughness down, cell-centred. */
export const DFG_SIZE = 32;
/** Samples per cell. */
const DFG_SAMPLES = 512;
/** The smallest perceptual roughness the shader shades (its NDF blows up below). */
export const MIN_ROUGHNESS = 0.045;

/** The height-correlated Smith visibility, G₂ / (4 N·L N·V), for α² = `a2`. */
export function smithVisibility(ndl: number, ndv: number, a2: number): number {
  const gv = ndl * Math.sqrt(ndv * ndv * (1 - a2) + a2);
  const gl = ndv * Math.sqrt(ndl * ndl * (1 - a2) + a2);
  return 0.5 / (gv + gl + 1e-7);
}

/** The i-th of n Hammersley points. */
function hammersley(i: number, n: number): [number, number] {
  let bits = i;
  bits = ((bits << 16) | (bits >>> 16)) >>> 0;
  bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
  bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
  bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
  bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
  return [i / n, bits / 4294967296];
}

/**
 * The split-sum's two terms at one N·V and perceptual roughness: the BRDF's
 * hemispherical integral is f0·A + B, with Schlick's Fresnel. With f0 = 1 it
 * is A + B, the share of light one scattering event returns.
 */
export function integrateDfg(ndv: number, roughness: number, samples = DFG_SAMPLES): [number, number] {
  const alpha = Math.max(MIN_ROUGHNESS, roughness) ** 2;
  const a2 = alpha * alpha;
  // V in the tangent frame, N = +z, in the xz plane (H's y never meets it).
  const vx = Math.sqrt(Math.max(0, 1 - ndv * ndv));
  const vz = ndv;
  let a = 0;
  let b = 0;
  for (let i = 0; i < samples; i += 1) {
    const [u1, u2] = hammersley(i, samples);
    // A half vector by the GGX distribution of normals.
    const phi = 2 * Math.PI * u1;
    const cosT = Math.sqrt((1 - u2) / (1 + (a2 - 1) * u2));
    const sinT = Math.sqrt(1 - cosT * cosT);
    const hx = sinT * Math.cos(phi);
    const hz = cosT;
    const vdh = vx * hx + vz * hz;
    // L, V reflected about H.
    const lz = 2 * vdh * hz - vz;
    if (lz <= 0 || vdh <= 0) continue;
    const ndl = lz;
    const ndh = hz;
    // The estimator: BRDF·N·L / pdf, with pdf = D·N·H / (4 V·H).
    const g = (smithVisibility(ndl, ndv, a2) * 4 * ndl * vdh) / ndh;
    const fc = (1 - vdh) ** 5;
    a += (1 - fc) * g;
    b += fc * g;
  }
  return [a / samples, b / samples];
}

let table: Float32Array | null = null;

/**
 * The DFG table the shader reads: `DFG_SIZE²` pairs (A, B), row by roughness
 * and column by N·V, each at its cell's centre. Integrated once and kept.
 */
export function dfgTable(): Float32Array {
  if (table) return table;
  const out = new Float32Array(DFG_SIZE * DFG_SIZE * 2);
  for (let r = 0; r < DFG_SIZE; r += 1) {
    for (let v = 0; v < DFG_SIZE; v += 1) {
      const [a, b] = integrateDfg((v + 0.5) / DFG_SIZE, (r + 0.5) / DFG_SIZE);
      out[(r * DFG_SIZE + v) * 2] = a;
      out[(r * DFG_SIZE + v) * 2 + 1] = b;
    }
  }
  table = out;
  return out;
}

/** The table read as the shader reads it: bilinearly between cell centres, clamped at the edges. */
export function dfgAt(lut: Float32Array, ndv: number, roughness: number): [number, number] {
  const x = Math.min(DFG_SIZE - 1, Math.max(0, ndv * DFG_SIZE - 0.5));
  const y = Math.min(DFG_SIZE - 1, Math.max(0, roughness * DFG_SIZE - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, DFG_SIZE - 1);
  const y1 = Math.min(y0 + 1, DFG_SIZE - 1);
  const fx = x - x0;
  const fy = y - y0;
  const at = (cx: number, cy: number, k: number) => lut[(cy * DFG_SIZE + cx) * 2 + k]!;
  const lerp = (p: number, q: number, t: number) => p + (q - p) * t;
  const read = (k: number) => lerp(lerp(at(x0, y0, k), at(x1, y0, k), fx), lerp(at(x0, y1, k), at(x1, y1, k), fx), fy);
  return [read(0), read(1)];
}

/**
 * The environment's specular weight for one f0 channel, single and multiple
 * scattering together (Fdez-Agüera): what the shader multiplies the
 * prefiltered reflection by. The diffuse keeps the rest, 1 − it.
 */
export function specularEnergy(f0: number, dfg: readonly [number, number]): number {
  const [a, b] = dfg;
  const ess = a + b;
  const fssEss = f0 * a + b;
  const ems = 1 - ess;
  const favg = f0 + (1 - f0) / 21;
  const fms = (fssEss * favg) / (1 - ems * favg);
  return fssEss + fms * ems;
}

/** The scale on a light's specular that adds back its multiple scattering (Kulla-Conty, as Filament applies it). */
export function energyCompensation(f0: number, dfg: readonly [number, number]): number {
  return 1 + f0 * (1 / Math.max(1e-4, dfg[0] + dfg[1]) - 1);
}

/** Specular occlusion from ambient occlusion (Lagarde, "Moving Frostbite to PBR"), for α = roughness². */
export function specularOcclusion(ndv: number, ao: number, alpha: number): number {
  return Math.min(1, Math.max(0, (ndv + ao) ** (2 ** (-16 * alpha - 1)) - 1 + ao));
}

/**
 * The WGSL the linear-light shader declares: the DFG table's binding and the
 * functions mirroring the ones above.
 */
export function brdfWgsl(group: number, binding: number): string {
  const n = DFG_SIZE;
  return /* wgsl */ `
// The split-sum DFG table (F1c, brdf.ts): (A, B) by roughness row and N·V column.
@group(${group}) @binding(${binding}) var<storage, read> dfgLut: array<vec2<f32>>;
fn dfgAt(ndv: f32, rough: f32) -> vec2<f32> {
  let x = clamp(ndv * ${n}.0 - 0.5, 0.0, ${n - 1}.0);
  let y = clamp(rough * ${n}.0 - 0.5, 0.0, ${n - 1}.0);
  let x0 = u32(x);
  let y0 = u32(y);
  let x1 = min(x0 + 1u, ${n - 1}u);
  let y1 = min(y0 + 1u, ${n - 1}u);
  let fx = x - f32(x0);
  let fy = y - f32(y0);
  let top = mix(dfgLut[y0 * ${n}u + x0], dfgLut[y0 * ${n}u + x1], fx);
  let bottom = mix(dfgLut[y1 * ${n}u + x0], dfgLut[y1 * ${n}u + x1], fx);
  return mix(top, bottom, fy);
}
// The height-correlated Smith visibility, G2 / (4 N·L N·V), for alpha² = a2.
fn smithVisibility(ndl: f32, ndv: f32, a2: f32) -> f32 {
  let gv = ndl * sqrt(ndv * ndv * (1.0 - a2) + a2);
  let gl = ndv * sqrt(ndl * ndl * (1.0 - a2) + a2);
  return 0.5 / (gv + gl + 1e-7);
}
// The environment's specular weight, single and multiple scattering (Fdez-Agüera).
fn specularEnergy(f0: vec3<f32>, dfg: vec2<f32>) -> vec3<f32> {
  let ess = dfg.x + dfg.y;
  let fssEss = f0 * dfg.x + vec3<f32>(dfg.y);
  let ems = 1.0 - ess;
  let favg = f0 + (vec3<f32>(1.0) - f0) / 21.0;
  let fms = fssEss * favg / (vec3<f32>(1.0) - ems * favg);
  return fssEss + fms * ems;
}
// The scale on a light's specular that adds back its multiple scattering (Kulla-Conty).
fn energyCompensation(f0: vec3<f32>, dfg: vec2<f32>) -> vec3<f32> {
  return vec3<f32>(1.0) + f0 * (1.0 / max(1e-4, dfg.x + dfg.y) - 1.0);
}
// Specular occlusion from ambient occlusion (Lagarde), for alpha = roughness².
fn specularOcclusion(ndv: f32, ao: f32, alpha: f32) -> f32 {
  return clamp(pow(ndv + ao, exp2(-16.0 * alpha - 1.0)) - 1.0 + ao, 0.0, 1.0);
}
`;
}
