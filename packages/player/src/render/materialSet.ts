/**
 * The full material set's WGSL (AAA_FIDELITY_ROADMAP.md F1d) for the
 * linear-light shader, reading the uniform's F1d rows (scenePacking.ts):
 * mirrors of materialExtensions.ts in @cartbox/editor.
 *
 * - `khrUv` (`khrTransform`): KHR_texture_transform in the engine's UV space (`transformUv`).
 * - `sheenLobe`: the Charlie sheen with Neubelt's visibility, × π for the
 *   renderer's light units (`charlieD`, `neubeltV`).
 * - `iridescenceF0`: the thin film's Fresnel at N·V (`iridescenceFresnel`),
 *   which the shader takes as the surface's reflectance, as glTF's sample
 *   viewer evaluates it once a pixel.
 */

/** The parameterised functions, shared by the shader and the path-traced reference (F10b). */
export const MATERIAL_SET_FUNCTIONS_WGSL = /* wgsl */ `
// KHR_texture_transform (F1d): into glTF's V-down space, offset + rotation · (scale × uv), and back.
// xf = (scale u, scale v, cos, sin), offset = its offset.
fn khrTransform(uv: vec2<f32>, xf: vec4<f32>, offset: vec2<f32>) -> vec2<f32> {
  let g = vec2<f32>(uv.x, 1.0 - uv.y) * xf.xy;
  let t = vec2<f32>(xf.z * g.x + xf.w * g.y, -xf.w * g.x + xf.z * g.y) + offset;
  return vec2<f32>(t.x, 1.0 - t.y);
}
// The sheen's BRDF (Charlie, Neubelt) for colour c and roughness r, without the cosine.
fn sheenBrdf(c: vec3<f32>, r: f32, ndl: f32, ndv: f32, ndh: f32) -> vec3<f32> {
  if (max(c.r, max(c.g, c.b)) <= 0.0) { return vec3<f32>(0.0); }
  let alpha = max(1e-3, r * r);
  let inv = 1.0 / alpha;
  let sin2 = max(0.0, 1.0 - ndh * ndh);
  let d = (2.0 + inv) * pow(sin2, inv * 0.5) / 6.2831853;
  let v = 1.0 / (4.0 * (ndl + ndv - ndl * ndv) + 1e-6);
  return c * d * v;
}
fn ifFresnelSchlick(f0: f32, c: f32) -> f32 {
  return f0 + (1.0 - f0) * pow(1.0 - c, 5.0);
}
fn ifIorToF0(n2: f32, n1: f32) -> f32 {
  let r = (n2 - n1) / (n2 + n1);
  return r * r;
}
fn ifSensitivity(opd: f32, shift: vec3<f32>) -> vec3<f32> {
  let phase = 2.0 * 3.14159265 * opd * 1.0e-9;
  let val = vec3<f32>(5.4856e-13, 4.4201e-13, 5.2481e-13);
  let pos = vec3<f32>(1.6810e6, 1.7953e6, 2.2084e6);
  let vr = vec3<f32>(4.3278e9, 9.3046e9, 6.6121e9);
  var xyz = val * sqrt(2.0 * 3.14159265 * vr) * cos(pos * phase + shift) * exp(-phase * phase * vr);
  xyz.x = xyz.x + 9.7470e-14 * sqrt(2.0 * 3.14159265 * 4.5282e9) * cos(2.2399e6 * phase + shift.x) * exp(-4.5282e9 * phase * phase);
  xyz = xyz / 1.0685e-7;
  let m = mat3x3<f32>(vec3<f32>(3.2404542, -0.9692660, 0.0556434), vec3<f32>(-1.5371385, 1.8760108, -0.2040259), vec3<f32>(-0.4985314, 0.0415560, 1.0572252));
  return m * xyz;
}
// A thin film of index filmIor and thickness (nm) over a base of reflectance baseF0: its Fresnel at cos1 (Belcour & Barla).
fn iridescenceFresnel(cos1: f32, baseF0: vec3<f32>, filmIor: f32, thickness: f32) -> vec3<f32> {
  let t = clamp(thickness / 0.03, 0.0, 1.0);
  let film = mix(1.0, filmIor, t * t * (3.0 - 2.0 * t));
  let sin2Sq = (1.0 / film) * (1.0 / film) * (1.0 - cos1 * cos1);
  let cos2Sq = 1.0 - sin2Sq;
  if (cos2Sq < 0.0) { return vec3<f32>(1.0); }
  let cos2 = sqrt(cos2Sq);
  let r12 = ifFresnelSchlick(ifIorToF0(film, 1.0), cos1);
  let t121 = 1.0 - r12;
  let phi12 = select(0.0, 3.14159265, film < 1.0);
  let phi21 = 3.14159265 - phi12;
  let sf = sqrt(clamp(baseF0, vec3<f32>(0.0), vec3<f32>(0.9999)));
  let baseIor = (vec3<f32>(1.0) + sf) / (vec3<f32>(1.0) - sf);
  let rr = (baseIor - vec3<f32>(film)) / (baseIor + vec3<f32>(film));
  let r1 = rr * rr;
  let r23 = r1 + (vec3<f32>(1.0) - r1) * pow(1.0 - cos2, 5.0);
  let phi23 = select(vec3<f32>(0.0), vec3<f32>(3.14159265), baseIor < vec3<f32>(film));
  let opd = 2.0 * film * thickness * cos2;
  let phi = vec3<f32>(phi21) + phi23;
  let r123 = clamp(r12 * r23, vec3<f32>(1e-5), vec3<f32>(0.9999));
  let root = sqrt(r123);
  let rs = t121 * t121 * r23 / (vec3<f32>(1.0) - r123);
  var total = r12 + rs;
  var cm = (rs - vec3<f32>(t121)) * root;
  total = total + cm * 2.0 * ifSensitivity(opd, phi);
  cm = cm * root;
  total = total + cm * 2.0 * ifSensitivity(2.0 * opd, 2.0 * phi);
  return max(total, vec3<f32>(0.0));
}
`;

/** The shader's, bound to the uniform's F1d rows. */
export const MATERIAL_SET_WGSL = /* wgsl */ `${MATERIAL_SET_FUNCTIONS_WGSL}
fn khrUv(uv: vec2<f32>) -> vec2<f32> {
  if (u.irid0.w < 0.5) { return uv; }
  return khrTransform(uv, u.uvx0, u.uvx1.xy);
}
// The sheen's light from a light at N·L, N·V, N·H, in the renderer's units (× π).
fn sheenLobe(ndl: f32, ndv: f32, ndh: f32) -> vec3<f32> {
  return sheenBrdf(u.sheen0.rgb, u.sheen0.w, ndl, ndv, ndh) * 3.14159265;
}
fn iridescenceF0(cos1: f32, baseF0: vec3<f32>) -> vec3<f32> {
  return iridescenceFresnel(cos1, baseF0, u.irid0.x, u.irid0.y);
}
`;
