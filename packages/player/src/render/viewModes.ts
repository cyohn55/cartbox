/**
 * View modes (AAA_FIDELITY_ROADMAP.md F10a): the viewport shows the frame the
 * game renders ("lit"), or a diagnostic of it, on the linear-light renderer.
 *
 * Most are written by the scene's own fragment shader in place of its lit
 * colour, from the very values it shades with: the single buffers (unlit, base
 * colour, roughness, metallic, normals, AO, lighting only), the complexity
 * views (an estimate of the shading work a pixel runs, and the lights it
 * loops over), and the geometry and texture views (the LOD level drawn, texel
 * density against a target, the mip a pixel samples, and the sun's cascade).
 * Two need the whole frame: motion vectors are drawn from the prepass's
 * velocity buffer, and overdraw counts every fragment the scene shades
 * (additively, depth unwritten) before both are coloured in a resolve pass.
 *
 * A diagnostic frame skips what would change its values: temporal
 * accumulation and upscaling, reflections, the camera's effects, fog and the
 * presenter's exposure, tone map and post stack. Its colours are written as
 * linear light that encodes to the intended display colour.
 */

export type ViewMode =
  | "lit"
  | "unlit"
  | "baseColor"
  | "roughness"
  | "metallic"
  | "normals"
  | "ambientOcclusion"
  | "lightingOnly"
  | "motion"
  | "shaderComplexity"
  | "lightComplexity"
  | "overdraw"
  | "lod"
  | "texelDensity"
  | "mipLevel"
  | "cascades";

/** Each mode's code in the shader, its label, its group in a menu, and what it shows. */
export const VIEW_MODES: readonly { readonly id: ViewMode; readonly code: number; readonly label: string; readonly group: "Lighting" | "Buffers" | "Complexity" | "Geometry"; readonly hint: string }[] = [
  { id: "lit", code: 0, label: "Lit", group: "Lighting", hint: "The frame as the game renders it." },
  { id: "unlit", code: 1, label: "Unlit", group: "Lighting", hint: "Base colour and emission, with no light." },
  { id: "lightingOnly", code: 7, label: "Lighting only", group: "Lighting", hint: "The light on a white, non-metal surface: direct, sky, bakes and GI." },
  { id: "baseColor", code: 2, label: "Base colour", group: "Buffers", hint: "The albedo the surface shades with (maps, blends, detail and decals applied)." },
  { id: "roughness", code: 3, label: "Roughness", group: "Buffers", hint: "Black is mirror-smooth, white fully rough." },
  { id: "metallic", code: 4, label: "Metallic", group: "Buffers", hint: "Black is a dielectric, white a metal." },
  { id: "normals", code: 5, label: "Normals", group: "Buffers", hint: "The shading normal in world space, normal maps applied (x red, y green, z blue)." },
  { id: "ambientOcclusion", code: 6, label: "Ambient occlusion", group: "Buffers", hint: "The material's occlusion times GTAO's." },
  { id: "motion", code: 8, label: "Motion vectors", group: "Buffers", hint: "Screen motion since last frame: hue is the direction, brightness the speed." },
  { id: "shaderComplexity", code: 9, label: "Shader complexity", group: "Complexity", hint: "An estimate of the shading work each pixel runs, green to red to white." },
  { id: "lightComplexity", code: 10, label: "Light complexity", group: "Complexity", hint: "How many lights each pixel loops over." },
  { id: "overdraw", code: 11, label: "Overdraw", group: "Complexity", hint: "How many fragments shaded each pixel, depth ignored." },
  { id: "lod", code: 12, label: "LOD", group: "Geometry", hint: "The level of detail drawn: white without a chain, then red, green, blue, yellow, magenta, cyan." },
  { id: "texelDensity", code: 13, label: "Texel density", group: "Geometry", hint: "Base-colour texels per metre against the target: blue under, green on, red over." },
  { id: "mipLevel", code: 14, label: "Mip level", group: "Geometry", hint: "The base colour's mip each pixel samples: 0 green, then yellow, red, magenta." },
  { id: "cascades", code: 15, label: "Shadow cascades", group: "Geometry", hint: "The sun's cascade each pixel is shadowed from: red, green, blue, yellow." },
];

/** A mode's shader code (0 for lit or anything unknown). */
export function viewModeCode(mode: ViewMode | null | undefined): number {
  return VIEW_MODES.find((m) => m.id === mode)?.code ?? 0;
}

/** Read a stored mode defensively; "lit" when unknown. */
export function readViewMode(raw: unknown): ViewMode {
  return VIEW_MODES.some((m) => m.id === raw) ? (raw as ViewMode) : "lit";
}

/** The texel density the density view takes as on target (texels per metre), unless the draw names one. */
export const DEFAULT_TEXEL_DENSITY = 512;

/** The work a pixel of shader complexity's white stands for (in the estimate's units). */
export const SHADER_COMPLEXITY_FULL = 24;
/** The light count light complexity's white stands for. */
export const LIGHT_COMPLEXITY_FULL = 16;
/** The fragment count overdraw's white stands for. */
export const OVERDRAW_FULL = 12;

/** The heat ramp the complexity views share (0 → 1): black, blue, green, yellow, red, white; display colour. */
export function heat(t: number): [number, number, number] {
  const stops: [number, number, number][] = [[0, 0, 0], [0, 0.25, 1], [0, 0.85, 0.2], [1, 0.9, 0], [1, 0.1, 0], [1, 1, 1]];
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i]!, b = stops[i + 1]!;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/**
 * The WGSL the linear-light scene shader carries: the heat ramp (as {@link heat}),
 * a display colour into light (so it encodes back to itself), and the LOD and
 * cascade palettes.
 */
export const VIEW_MODE_WGSL = /* wgsl */ `
fn vmHeat(t: f32) -> vec3<f32> {
  var stops = array<vec3<f32>, 6>(vec3<f32>(0.0), vec3<f32>(0.0, 0.25, 1.0), vec3<f32>(0.0, 0.85, 0.2), vec3<f32>(1.0, 0.9, 0.0), vec3<f32>(1.0, 0.1, 0.0), vec3<f32>(1.0));
  let x = clamp(t, 0.0, 1.0) * 5.0;
  let i = min(4, i32(floor(x)));
  return mix(stops[i], stops[i + 1], x - f32(i));
}
// A display colour as light the frame encodes back to it (sRGB's inverse).
fn vmLight(c: vec3<f32>) -> vec3<f32> {
  let x = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
  return select(pow((x + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4)), x / 12.92, x <= vec3<f32>(0.04045));
}
fn vmPalette(i: i32) -> vec3<f32> {
  var p = array<vec3<f32>, 7>(vec3<f32>(1.0, 0.2, 0.2), vec3<f32>(0.2, 0.9, 0.2), vec3<f32>(0.25, 0.4, 1.0), vec3<f32>(1.0, 0.9, 0.1), vec3<f32>(1.0, 0.2, 1.0), vec3<f32>(0.1, 0.9, 0.9), vec3<f32>(1.0, 0.6, 0.2));
  return p[clamp(i, 0, 6)];
}
`;

/**
 * The resolve pass's WGSL (motion vectors and overdraw): binding 0 the uniforms
 * (x = the mode's code, y = overdraw's full count), 1 the scene's colour (overdraw's count in R),
 * 2 the velocity buffer, 3 the G-buffer (w = 0 where nothing drew).
 */
export const VIEW_RESOLVE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> params: vec4<f32>;
@group(0) @binding(1) var colourTex: texture_2d<f32>;
@group(0) @binding(2) var velocityTex: texture_2d<f32>;
@group(0) @binding(3) var gbufferTex: texture_2d<f32>;
${VIEW_MODE_WGSL}
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}
fn hue(h: f32) -> vec3<f32> {
  let k = vec3<f32>(5.0, 3.0, 1.0);
  return clamp(vec3<f32>(1.0) - clamp(min(fract(vec3<f32>(h) + k / 6.0) * 6.0, 4.0 - fract(vec3<f32>(h) + k / 6.0) * 6.0), vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(0.0), vec3<f32>(1.0));
}
@fragment
fn resolve(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let p = vec2<i32>(pos.xy);
  if (params.x > 10.5) {
    let n = textureLoad(colourTex, p, 0).r;
    if (n <= 0.0) { return vec4<f32>(0.0); }
    return vec4<f32>(vmLight(vmHeat(n / params.y)), 1.0);
  }
  if (textureLoad(gbufferTex, p, 0).w <= 0.0) { return vec4<f32>(0.0); }
  // Screen motion in pixels: its direction as hue, its speed (to 32 px) as brightness.
  let dims = vec2<f32>(textureDimensions(velocityTex));
  let v = textureLoad(velocityTex, p, 0).xy * dims;
  let speed = length(v);
  let angle = atan2(-v.y, v.x) / 6.2831853 + 0.5;
  let c = mix(vec3<f32>(0.08), hue(angle), clamp(speed / 32.0, 0.0, 1.0));
  return vec4<f32>(vmLight(c), 1.0);
}
`;
