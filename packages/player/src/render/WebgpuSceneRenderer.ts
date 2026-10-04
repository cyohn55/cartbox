/**
 * The player's WebGPU triangle path.
 *
 * The runtime had no GPU renderer for 3D: both overlays rasterised meshes on the
 * CPU, on the main thread, every presented frame. That capped how much geometry
 * a cart could carry far below what the World and Mesh editors let people
 * author, and it is the reason no era console model beyond a 2D one was
 * possible (ERA_MODELS.md §5.1).
 *
 * This draws the same instances in hardware. For the fantasy tiers it matches
 * the software rasteriser's shading *exactly* — two-sided Lambert with an
 * ambient floor, nearest-sampled wrapped textures, glTF's flipped V, and the
 * same alpha-discard threshold. Parity is the contract there: the fallback must
 * be indistinguishable, not merely similar, or a cart looks different depending
 * on the viewer's browser.
 *
 * The Modern (AAA) tier adds a metallic-roughness Cook-Torrance BRDF, gated on
 * `pbr.z` and mirroring the software rasteriser's PBR branch term for term (see
 * `meshRasterizer.ts`). That branch cannot be *byte*-identical — GGX and `pow`
 * differ slightly between the GPU's float32 and the CPU's float64 — so the
 * contract there is a visual match, validated in-browser (and on a real device
 * by `webgpu-parity.test.ts`), not the zero-tolerance fantasy parity. Both the
 * gate and the maths that decide byte placement live in the pure, tested
 * `scenePacking.ts`. (Tangent-space normal maps and the fantasy material-map
 * specular are not yet on this GPU path — a known follow-up; the software
 * rasteriser remains the reference for those.)
 *
 * ## Why the readback, and why it lags
 *
 * `DisplaySurface.blit` is synchronous and the overlays are decorators: their
 * output has to flow onward through the lighting and post-FX stack, so this
 * cannot present to its own swapchain and be done. It must land RGBA bytes back
 * in the framebuffer. GPU readback is asynchronous, so the renderer submits work
 * for the current frame and composites the most recently *completed* readback —
 * in practice one to two frames old on the overlay only. The cart's own 2D frame
 * is never delayed. Until the first readback lands, the software rasteriser
 * draws instead, so there is no pop-in on the opening frames.
 *
 * A stale overlay is the deliberate trade for not stalling the run loop: waiting
 * on `mapAsync` inside `blit` would convert a GPU win into a pipeline bubble
 * worse than the CPU path it replaces.
 *
 * ## Instancing
 *
 * Every copy of a primitive that binds the same textures goes out as one
 * instanced draw: a forest of one tree mesh, a pool of spawned crates or a
 * level's repeated pillars costs one draw call per primitive rather than one per
 * copy. The material uniforms are shared by the batch; each copy's transforms
 * (mvp, light mvp, model, normal basis) live in a storage buffer indexed by
 * `instance_index`. They are still composed on the CPU in float64 and handed
 * over as the same float32s the per-draw uniforms carried, so batching changes
 * nothing on screen. The one ordering it does change is between exactly
 * coplanar copies (which one wins the depth tie), where draw order was already
 * an accident.
 *
 * WebGPU is not in this project's TS DOM lib and we do not want the
 * @webgpu/types dependency, so the handles are loosely typed — the same
 * convention the editor's GPU renderers use. Everything with real logic in it
 * (layout, packing, the parity maths) is pure and tested without a GPU.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  DEFAULT_RASTER_STYLE,
  DETAIL_FAR,
  DETAIL_NEAR,
  LIGHTMAP_RANGE,
  MAX_REFLECTION_PROBES,
  PROBE_FADE,
  FOG_GLOW_POWER,
  PROBE_RANGE,
  EFFECT_BAND_FREQUENCY,
  EFFECT_BAND_POWER,
  EFFECT_BAND_SPEED,
  EFFECT_CAMO_CRAWL,
  cameraPositionFromView,
  compiledGraphOf,
  computeSmoothNormals,
  NEAR_CASCADE_EDGE,
  CLUSTER_CELLS,
  CLUSTER_INDEX_CAP,
  CLUSTER_X,
  CLUSTER_Y,
  CLUSTER_Z,
  buildLightClusters,
  orderLights,
  graphNoiseSource,
  graphShaderCode,
  graphUsesNoise,
  multiplyMat4,
  type CompiledGraph,
  type DecodedTexture,
  type MeshPrimitive,
  type MeshAsset,
  type MeshSceneInstance,
  type RasterStyle,
  type ReflectionProbeSet,
} from "@cartbox/editor";

import { SoftwareSceneRenderer, applyScenePasses, type FrameState, type SceneDraw, type SceneRenderer } from "./sceneRenderer.js";
import { webgpuCanHonour } from "./renderCaps.js";
import { batchInstances, compositeFrame, presentFrame, softEdges, type PrimitiveTextures } from "./gpuFrame.js";
import { WebgpuPassTimer } from "./gpuTimer.js";
import type { RenderStats } from "../debug/profiler.js";
import {
  UNIFORM_FLOATS,
  UNIFORM_STRIDE,
  alignBytesPerRow,
  UNIFORM_BYTES_USED,
  interleaveVertices,
  normalBasis3x3,
  packLights,
  packProbes,
  resolveSurface,
  PROBE_FLOATS,
  resolveLight,
  resolvePbr,
  unpadRows,
  viewDirection,
  writeInstanceUniform,
  INSTANCE_FLOATS,
  writeInstanceTransform,
} from "./scenePacking.js";

/** One shader variant's pipelines: opaque, blended and added (EP6). */
interface PipelineSet {
  readonly opaque: any;
  readonly blend: any;
  readonly add: any;
}

/** The per-frame globals' bytes (WGSL `Frame`): cluster params and info, the near cascade's matrix and params. */
const FRAME_BYTES = 112;

/** Staging buffers in flight. Three lets a readback land while two more queue. */
const READBACK_BUFFERS = 3;

// GPUShaderStage bits, spelled out because the enum is not in the TS DOM lib here.
const SHADER_STAGE_VERTEX = 0x1;
const SHADER_STAGE_FRAGMENT = 0x2;

/**
 * A material graph's code (EP7) at its three sites in the fragment shader:
 * after the base colour (where it also sets colour and alpha), where the PBR
 * metallic and roughness settle, and after the emissive. Empty for the plain shader.
 */
function graphSites(graph: CompiledGraph | null): { fns: string; base: string; pbr: string; emis: string } {
  if (!graph) return { fns: "", base: "", pbr: "", emis: "" };
  const out = graph.outputs;
  const code = graphShaderCode(graph, "wgsl", {
    uv: "in.uv",
    position: "in.worldPos",
    normal: "gN",
    view: "u.view.xyz",
    time: "u.effect1.w",
    baseColor: "colour.rgb",
    baseAlpha: "colour.a",
    sample: (p) => `textureSample(tex, samp, vec2<f32>((${p}).x, 1.0 - (${p}).y))`,
  });
  const set = [
    out.baseColor !== undefined ? `colour = vec4<f32>(g${out.baseColor}, colour.a);` : "",
    out.alpha !== undefined ? `colour.a = clamp(g${out.alpha}.x, 0.0, 1.0);` : "",
    out.metallic !== undefined ? `gMetal = clamp(g${out.metallic}.x, 0.0, 1.0);` : "",
    out.roughness !== undefined ? `gRough = g${out.roughness}.x;` : "",
    out.emissive !== undefined ? `gEmis = max(g${out.emissive}, vec3<f32>(0.0));` : "",
  ].filter(Boolean);
  return {
    fns: graphUsesNoise(graph) ? graphNoiseSource("wgsl") : "",
    base: `  // The material graph (EP7).
  var gMetal = -1.0;
  var gRough = -1.0;
  var gEmis = vec3<f32>(-1.0);
  {
    var gN = normalize(in.normal);
    if (dot(gN, u.view.xyz) < 0.0) { gN = -gN; }
${code.split("\n").map((l) => `    ${l}`).join("\n")}
${set.map((l) => `    ${l}`).join("\n")}
  }`,
    pbr: `    if (gMetal >= 0.0) { metallic = gMetal; }
    if (gRough >= 0.0) { rough = gRough; }`,
    emis: `    if (gEmis.x >= 0.0) { emis = gEmis; }`,
  };
}

/** The scene shader, plain or with a material graph spliced in (EP7). */
export function sceneShader(graph: CompiledGraph | null = null): string {
  const g = graphSites(graph);
  return /* wgsl */ `
struct Uniforms {
  mvp: mat4x4<f32>,
  nrm: mat3x3<f32>,
  base: vec4<f32>,
  light: vec4<f32>,     // xyz = normalised direction, w = ambient floor
  view: vec4<f32>,      // xyz = direction towards the viewer (Modern PBR)
  pbr: vec4<f32>,       // x = metallic, y = roughness, z = 1 when PBR
  emissive: vec4<f32>,  // xyz = emissive factor
  texflags: vec4<f32>,  // x = base, y = mr, z = occlusion, w = emissive
  envSky: vec4<f32>,    // xyz = sky colour, w = 1 when an environment is set
  envHorizon: vec4<f32>,// xyz = horizon colour, w = intensity
  envGround: vec4<f32>, // xyz = ground colour
  lightMvp: mat4x4<f32>,// world→light-clip for shadow mapping
  shadow: vec4<f32>,    // x = 1 when shadowed, y = map size, z = bias, w = strength
  envMeta: vec4<f32>,   // xyz = env-map mean radiance, w = 1 when an env map is bound
  tonemap: vec4<f32>,   // x = 1 when tone-mapping, y = exposure
  ssaoMeta: vec4<f32>,  // x = 1 when an SSAO buffer is bound, y = light count, z = 1 when a light map is bound
  model: mat4x4<f32>,   // this draw's world matrix (point-light world position)
  fog: vec4<f32>,       // rgb = fog colour, w = density
  fogParams: vec4<f32>, // x = 1 when fogged, y = start distance, z = max amount
  shadow2: vec4<f32>,   // x = slope-scaled bias, y = 1 for 2x2 PCF
  surface0: vec4<f32>,  // x = detail scale, y = detail strength, z = reflectivity, w = 1 when MR alpha masks it
  surface1: vec4<f32>,  // xy = emissive UV offset
  surface2: vec4<f32>,  // rgb = rim colour × strength, w = rim power
  surface3: vec4<f32>,  // rgb = blend-surface colour, w = its roughness (< 0 keeps)
  fogCam: vec4<f32>,    // xyz = eye (world), w = fog volume count
  fogHeight: vec4<f32>, // x = height-fog density, y = base, z = falloff, w = glow strength
  fogGlow: vec4<f32>,   // rgb = sun-glow colour
  fogVol: array<vec4<f32>, 8>, // per volume: min xyz + density, max xyz + falloff
  effect0: vec4<f32>,   // rgb = surface effect glow, w = camo amount
  effect1: vec4<f32>,   // rgb = surface effect bands, w = time
};

// A Modern-tier light (see packLights): d0 = dir/pos + kind, d1 = colour +
// intensity, d2.x = point range. Read from a shared storage buffer.
struct Light {
  d0: vec4<f32>,
  d1: vec4<f32>,
  d2: vec4<f32>,
  d3: vec4<f32>,
};
// Per-frame globals. Clustered lights (EP8): clusterParams = tile size (px),
// near plane, slice scale; clusterInfo.x = global lights (looped by every
// fragment), .y = 1 when cells are built. The near shadow cascade (EP8b):
// world→light-clip, and nearShadow = (1 when present, bias, slope bias).
struct Frame {
  clusterParams: vec4<f32>,
  clusterInfo: vec4<f32>,
  nearMvp: mat4x4<f32>,
  nearShadow: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;
@group(0) @binding(3) var mrTex: texture_2d<f32>;
@group(0) @binding(4) var occTex: texture_2d<f32>;
@group(0) @binding(5) var emisTex: texture_2d<f32>;
// The shadow map: light-NDC depth in R, generated on the CPU by renderShadowMap
// and uploaded as r32float, so the GPU samples the *same* map the software path
// tests against. Unfilterable, read via textureLoad (nearest) — matching the
// software compare exactly.
@group(0) @binding(6) var shadowMap: texture_2d<f32>;
// The equirectangular environment map, read via textureLoad (nearest) to match
// sampleEquirectRgb in meshRasterizer.ts. Bound to a 1x1 blank when unused.
@group(0) @binding(7) var envMap: texture_2d<f32>;
// The screen-space AO buffer (CPU-generated by computeSsao, uploaded r32float),
// sampled per fragment by its framebuffer pixel — the same buffer the software
// path multiplies its ambient by. Bound to a 1x1 blank when unused.
@group(0) @binding(8) var ssaoMap: texture_2d<f32>;
// The Modern-tier light list (packLights); the uniform's ssaoMeta.y bounds the
// loop, so a spare 1-light buffer is bound when there are none.
@group(0) @binding(9) var<storage, read> lights: array<Light>;
// Per-instance transforms (see "Instancing" above), indexed by instance_index —
// which counts from the draw's firstInstance, so each batch reads its own run.
struct InstanceXf {
  mvp: mat4x4<f32>,
  lightMvp: mat4x4<f32>,
  model: mat4x4<f32>,
  nrm: mat3x3<f32>,
};
@group(0) @binding(10) var<storage, read> xf: array<InstanceXf>;
// A baked light map, sampled with the second UV set (1x1 white when none).
@group(0) @binding(11) var lmTex: texture_2d<f32>;
// Reflection probes (probeSampling.ts in @cartbox/editor): every probe's
// panorama stacked in one atlas, and each one's box, capture point and mean
// colour; the uniform's ssaoMeta.w counts them (a zeroed slot when none).
struct Probe {
  mn: vec4<f32>,
  mx: vec4<f32>,
  pos: vec4<f32>,
  avg: vec4<f32>,
};
@group(0) @binding(12) var probeAtlas: texture_2d<f32>;
@group(0) @binding(13) var<storage, read> probes: array<Probe>;
// A finely tiled detail map (materialEffects.ts; 1x1 white when none — the
// uniform's surface0.y gates it).
@group(0) @binding(14) var detailTex: texture_2d<f32>;
// The blend surface's map (terrain snow over rock), mixed by the vertex weight.
@group(0) @binding(15) var blendTex: texture_2d<f32>;
// The opaque pass's depth (EP6b), read by the see-through pass for soft edges;
// the opaque pass binds a blank in its place.
@group(1) @binding(0) var sceneDepth: texture_depth_2d;
// Clustered lights (EP8): per cell (offset, count) into the index list.
@group(1) @binding(1) var<storage, read> clusterTable: array<vec2<u32>>;
@group(1) @binding(2) var<storage, read> clusterIndex: array<u32>;
@group(1) @binding(3) var<uniform> frame: Frame;

// Optical depth of a fog layer thinning above base, along the ray from the eye
// (height cy, rise dy, length len) over t in [t0, t1] — fogLayerDepth in skyDome.ts.
fn fogLayer(d: f32, k: f32, base: f32, cy: f32, dy: f32, len: f32, t0: f32, t1: f32) -> f32 {
  if (d <= 0.0 || t1 <= t0) { return 0.0; }
  let ya = cy + dy * t0 - base;
  let yb = cy + dy * t1 - base;
  let y0 = min(ya, yb);
  let y1 = max(ya, yb);
  let span = d * len * (t1 - t0);
  let h = y1 - y0;
  if (h < 1e-5) { return span * exp(-k * max(0.0, y0)); }
  var tau = 0.0;
  if (y0 < 0.0) { tau = tau + span * (min(y1, 0.0) - y0) / h; }
  if (y1 > 0.0) {
    let lo = max(y0, 0.0);
    let above = y1 - lo;
    if (k * above < 1e-4) {
      tau = tau + span * above * exp(-k * lo) / h;
    } else {
      tau = tau + span * (exp(-k * lo) - exp(-k * y1)) / (k * h);
    }
  }
  return tau;
}

// Where the segment c → c + dir·t (t in [0, 1]) is inside a box: (t0, t1), or t0 >= t1 when it misses.
fn fogBox(mn: vec3<f32>, mx: vec3<f32>, c: vec3<f32>, dir: vec3<f32>) -> vec2<f32> {
  var t0 = 0.0;
  var t1 = 1.0;
  for (var a = 0; a < 3; a = a + 1) {
    if (abs(dir[a]) < 1e-9) {
      if (c[a] < mn[a] || c[a] > mx[a]) { return vec2<f32>(1.0, 0.0); }
    } else {
      let ta = (mn[a] - c[a]) / dir[a];
      let tb = (mx[a] - c[a]) / dir[a];
      t0 = max(t0, min(ta, tb));
      t1 = min(t1, max(ta, tb));
    }
  }
  return vec2<f32>(t0, t1);
}

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) lightClip: vec4<f32>,
  @location(3) worldPos: vec3<f32>,
  @location(4) eyeDepth: f32,
  @location(5) uv2: vec2<f32>,
  @location(6) bw: f32,
};

// Directional shadow test, mirroring rasterizeTriangle in meshRasterizer.ts:
// project into the light's frame, look up the nearest depth the light sees, and
// return 1 (lit) or 1−strength (occluded). The light is orthographic (w = 1).
fn shadowTap(fx: f32, fy: f32, z: f32, ox: f32) -> f32 {
  let size = u.shadow.y;
  let tx = i32(clamp(floor(fx), 0.0, size - 1.0) + ox);
  let ty = i32(clamp(floor(fy), 0.0, size - 1.0));
  let stored = textureLoad(shadowMap, vec2<i32>(tx, ty), 0).r;
  if (z > stored) { return 0.0; }
  return 1.0;
}
// cosL = |N.L| of the geometric normal against the key light, for the slope bias.
// Mirrors shadowVisibility in meshRasterizer.ts.
// One shadow map's test at a light-NDC point: the main map (ox 0) or the near
// cascade packed to its right (ox = size), with its own biases.
fn shadowAt(ndc: vec3<f32>, bias0: f32, slope: f32, ox: f32, cosL: f32) -> f32 {
  let size = u.shadow.y;
  let sx = (ndc.x * 0.5 + 0.5) * size;
  let sy = (1.0 - (ndc.y * 0.5 + 0.5)) * size;
  var bias = bias0;
  if (slope > 0.0) {
    let c = clamp(cosL, 0.05, 1.0);
    bias = bias + slope * min(10.0, sqrt(1.0 - c * c) / c);
  }
  let z = ndc.z - bias;
  if (u.shadow2.y < 0.5) {
    if (shadowTap(sx, sy, z, ox) < 0.5) { return 1.0 - u.shadow.w; }
    return 1.0;
  }
  let lit = (shadowTap(sx - 0.5, sy - 0.5, z, ox) + shadowTap(sx + 0.5, sy - 0.5, z, ox)
           + shadowTap(sx - 0.5, sy + 0.5, z, ox) + shadowTap(sx + 0.5, sy + 0.5, z, ox)) * 0.25;
  return 1.0 - u.shadow.w * (1.0 - lit);
}
// The sun's shadow (mirrors sunShadowVisibility): the near cascade (EP8b) when
// the point sits well inside it, else the main map.
fn shadowFactor(lightClip: vec4<f32>, worldPos: vec3<f32>, cosL: f32) -> f32 {
  if (u.shadow.x < 0.5) { return 1.0; }
  if (frame.nearShadow.x > 0.5) {
    let n = (frame.nearMvp * vec4<f32>(worldPos, 1.0)).xyz;
    if (abs(n.x) < ${NEAR_CASCADE_EDGE} && abs(n.y) < ${NEAR_CASCADE_EDGE} && abs(n.z) <= 1.0) {
      return shadowAt(n, frame.nearShadow.y, frame.nearShadow.z, u.shadow.y, cosL);
    }
  }
  let ndc = lightClip.xyz / lightClip.w;
  if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0 || ndc.z < -1.0 || ndc.z > 1.0) {
    return 1.0;
  }
  return shadowAt(ndc, u.shadow.z, u.shadow2.x, 0.0, cosL);
}

// Analytic environment (Phase 3 IBL), mirroring environmentColor /
// environmentAverage in meshRasterizer.ts: a sky/horizon/ground vertical
// gradient sampled by a direction's Y. WGSL mix(a,b,k) = a+(b-a)*k, matching the
// software helper exactly.
fn envGradient(y: f32) -> vec3<f32> {
  let t = clamp(y, -1.0, 1.0);
  var c: vec3<f32>;
  if (t >= 0.0) { c = mix(u.envHorizon.xyz, u.envSky.xyz, t); }
  else { c = mix(u.envHorizon.xyz, u.envGround.xyz, -t); }
  return c * u.envHorizon.w; // .w = intensity
}
// Sample the environment along a full direction: an equirectangular map when one
// is bound (envMeta.w), else the analytic gradient (Y only). Mirrors
// sampleEnvironmentDir in meshRasterizer.ts — nearest via textureLoad.
fn envColorDir(dir: vec3<f32>) -> vec3<f32> {
  if (u.envMeta.w < 0.5) { return envGradient(dir.y); }
  let d = normalize(dir);
  let uCoord = atan2(d.z, d.x) / (2.0 * 3.14159265) + 0.5;
  let vCoord = acos(clamp(d.y, -1.0, 1.0)) / 3.14159265;
  let dims = vec2<f32>(textureDimensions(envMap, 0));
  let wx = uCoord - floor(uCoord);
  let tx = i32(clamp(floor(wx * dims.x), 0.0, dims.x - 1.0));
  let ty = i32(clamp(floor(vCoord * dims.y), 0.0, dims.y - 1.0));
  return textureLoad(envMap, vec2<i32>(tx, ty), 0).rgb * u.envHorizon.w;
}
// Probe i's panorama along a direction, nearest — mirrors sampleProbe.
fn probeSample(i: i32, dir: vec3<f32>) -> vec3<f32> {
  let d = normalize(dir);
  let uCoord = atan2(d.z, d.x) / (2.0 * 3.14159265) + 0.5;
  let vCoord = acos(clamp(d.y, -1.0, 1.0)) / 3.14159265;
  let dims = vec2<f32>(textureDimensions(probeAtlas, 0));
  let h = floor(dims.x * 0.5);
  let tx = i32(clamp(floor((uCoord - floor(uCoord)) * dims.x), 0.0, dims.x - 1.0));
  let ty = i32(clamp(floor(vCoord * h), 0.0, h - 1.0) + f32(i) * h);
  return textureLoad(probeAtlas, vec2<i32>(tx, ty), 0).rgb * ${PROBE_RANGE.toFixed(4)};
}
// The 2×2 ordered-dither matrix [[0, 2], [3, 1]], and the crawling camo threshold (surfaceEffect.ts).
fn bayer2(x: i32, y: i32) -> f32 {
  if ((y & 1) == 1) { return select(3.0, 1.0, (x & 1) == 1); }
  return select(0.0, 2.0, (x & 1) == 1);
}
fn camoThreshold(p: vec2<f32>, time: f32) -> f32 {
  let s = i32(floor(time * ${EFFECT_CAMO_CRAWL.toFixed(1)}));
  let px = i32(floor(p.x)) + s;
  let py = i32(floor(p.y)) + s * 3;
  return (4.0 * bayer2(px, py) + bayer2(px >> 1u, py >> 1u) + 0.5) / 16.0;
}
// What reaches the framebuffer (EP6): opaque and cut-out surfaces cover the
// pixel (alpha 1); a blended one leaves premultiplied colour and its coverage
// (the pipeline blends it over what's there); an added one leaves its light
// and no coverage (the pipeline adds it). compositeFrame reads the same codes.
fn finishAlpha(rgb: vec3<f32>, a: f32) -> vec4<f32> {
  let c = clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0));
  if (u.pbr.w > 2.5) { return vec4<f32>(c * a, 0.0); }
  if (u.pbr.w > 1.5) { return vec4<f32>(c * a, a); }
  return vec4<f32>(c, 1.0);
}
// One light's direct term (Cook-Torrance), mirroring the software rasteriser's
// light loop: point and spot lights fall off to nothing at their range, a spot
// fades across its cone, and directional lights honour the sun shadow (sf).
fn lightTerm(lgt: Light, P: vec3<f32>, N: vec3<f32>, V: vec3<f32>, ndv: f32, a2: f32, k: f32, f0: vec3<f32>, kdm: f32, albedo: vec3<f32>, sf: f32) -> vec3<f32> {
  var Ld: vec3<f32>;
  var atten = 1.0;
  if (lgt.d0.w > 0.5) { // point or spot
    let toL = lgt.d0.xyz - P;
    let dist = max(length(toL), 1e-4);
    Ld = toL / dist;
    let range = lgt.d2.x;
    if (range > 0.0) { let t = max(0.0, 1.0 - dist / range); atten = t * t; }
    if (lgt.d0.w > 1.5) {
      let ct = clamp((-dot(Ld, lgt.d3.xyz) - lgt.d2.y) / (lgt.d2.z - lgt.d2.y), 0.0, 1.0);
      atten = atten * ct * ct * (3.0 - 2.0 * ct);
    }
  } else {
    Ld = normalize(lgt.d0.xyz);
  }
  let ndlL = max(0.0, dot(N, Ld));
  if (ndlL <= 0.0 || atten <= 0.0) { return vec3<f32>(0.0); }
  let Hl = normalize(Ld + V);
  let ndhL = max(0.0, dot(N, Hl));
  let vdhL = max(0.0, dot(V, Hl));
  let ddL = ndhL * ndhL * (a2 - 1.0) + 1.0;
  let DL = a2 / (3.14159265 * ddL * ddL + 1e-7);
  let GL = (ndv / (ndv * (1.0 - k) + k)) * (ndlL / (ndlL * (1.0 - k) + k));
  let fpL = pow(1.0 - vdhL, 5.0);
  let specL = (DL * GL) / (4.0 * ndlL * ndv + 1e-4);
  let FL = f0 + (vec3<f32>(1.0) - f0) * fpL;
  var occl = 1.0;
  if (lgt.d0.w < 0.5) { occl = sf; }
  let w = lgt.d1.w * atten * ndlL * occl;
  return (kdm * (vec3<f32>(1.0) - FL) * albedo + FL * specL) * lgt.d1.rgb * w;
}

fn envAverage() -> vec3<f32> {
  if (u.envMeta.w > 0.5) { return u.envMeta.xyz * u.envHorizon.w; }
  return (u.envSky.xyz + u.envHorizon.xyz + u.envGround.xyz) / 3.0 * u.envHorizon.w;
}
// ACES filmic tone map (Narkowicz), per channel, mirroring acesFilmic in
// meshRasterizer.ts. Applied only to the Modern-tier PBR radiance.
fn aces(x: f32) -> f32 {
  let v = max(0.0, x);
  return clamp((v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14), 0.0, 1.0);
}

@vertex
fn vs(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) uv2: vec2<f32>,
  @location(4) bw: f32,
  @builtin(instance_index) instance: u32,
) -> VSOut {
  var out: VSOut;
  let t = xf[instance];
  out.pos = t.mvp * vec4<f32>(position, 1.0);
  out.normal = t.nrm * normal;
  out.uv = uv;
  out.uv2 = uv2;
  out.bw = bw;
  out.lightClip = t.lightMvp * vec4<f32>(position, 1.0);
  out.worldPos = (t.model * vec4<f32>(position, 1.0)).xyz;
  out.eyeDepth = out.pos.w; // clip w = view depth, for distance fog
  return out;
}

${g.fns}
@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  // glTF's V origin is top-left, so flip; the sampler wraps and (per era) filters.
  let uv = vec2<f32>(in.uv.x, 1.0 - in.uv.y);

  var colour = u.base;
  if (u.texflags.x > 0.5) {
    colour = colour * textureSample(tex, samp, uv);
  }
${g.base}
  // The CPU path skips a texel whose combined alpha is below 1/255 rather than
  // blending it, so this is a discard and not an alpha-blend state.
  // Soft edges (EP6b): a see-through surface fades out as it meets the opaque
  // scene behind it — both depths read back as view distance (shadow2.zw).
  if (u.tonemap.z > 0.0) {
    let behind = textureLoad(sceneDepth, vec2<i32>(in.pos.xy), 0);
    colour.a *= clamp((u.shadow2.w / (behind + u.shadow2.z) - u.shadow2.w / (in.pos.z + u.shadow2.z)) / u.tonemap.z, 0.0, 1.0);
  }
  if (colour.a * 255.0 < 1.0) { discard; }
  // A cut-out surface (EP6) drops what's below its threshold.
  if (u.pbr.w > 0.5 && u.pbr.w < 1.5 && colour.a < u.view.w) { discard; }

  if (u.pbr.z > 0.5) {
    // Active Camo (H11): screen-door transparency, as the rasteriser drops pixels.
    if (u.effect0.w > 0.0 && camoThreshold(in.pos.xy, u.effect1.w) < u.effect0.w) { discard; }
    // --- Modern tier: metallic-roughness BRDF (Cook-Torrance) ---
    // Mirrors the software rasteriser's PBR branch (meshRasterizer.ts) term for
    // term, in the engine's non-linear byte space (a linear/HDR pipeline is a
    // later phase). Small float32-vs-float64 differences from pow/GGX are
    // expected; the fantasy path below stays byte-identical.
    var N = normalize(in.normal);
    if (dot(N, u.view.xyz) < 0.0) { N = -N; } // two-sided: flip toward the viewer
    var metallic = u.pbr.x;
    var rough = u.pbr.y;
    var reflectK = u.surface0.z;
    if (u.texflags.y > 0.5) {
      let mr = textureSample(mrTex, samp, uv);
      rough = rough * mr.g;   // glTF packs roughness in G,
      metallic = metallic * mr.b; // metallic in B
      if (u.surface0.w > 0.5) { reflectK = reflectK * mr.a; } // the reflection mask
    }
    // The blend surface's roughness, by the vertex weight (surface3.w < 0 keeps).
    if (u.surface1.z > 0.5 && u.surface3.w >= 0.0) { rough = mix(rough, u.surface3.w, in.bw); }
${g.pbr}
    rough = clamp(rough, 0.045, 1.0); // a perfectly-smooth NDF blows up
    var ao = 1.0;
    if (u.texflags.z > 0.5) { ao = textureSample(occTex, samp, uv).r; }
    var albedo = colour.rgb;
    // A second surface blended in by the vertex weight (snow drifting over rock).
    let blendTexel = textureSample(blendTex, samp, uv).rgb;
    if (u.surface1.z > 0.5) {
      var bc = u.surface3.rgb;
      if (u.surface1.w > 0.5) { bc = bc * blendTexel; }
      albedo = mix(albedo, bc, in.bw);
    }
    // A detail map, tiled finely and blended in up close (mid-grey neutral),
    // fading with eye depth — mirrors the software path.
    let dk = u.surface0.y * clamp((${DETAIL_FAR.toFixed(4)} - in.eyeDepth) / ${(DETAIL_FAR - DETAIL_NEAR).toFixed(4)}, 0.0, 1.0);
    let detail = textureSample(detailTex, samp, vec2<f32>(in.uv.x * u.surface0.x, 1.0 - in.uv.y * u.surface0.x)).rgb;
    if (dk > 0.0) { albedo = albedo * (vec3<f32>(1.0) + dk * (2.0 * detail - vec3<f32>(1.0))); }
    let L = u.light.xyz;
    let V = u.view.xyz;
    let H = normalize(L + V);
    let ndl = max(0.0, dot(N, L));
    let ndv = max(1e-4, dot(N, V));
    let ndh = max(0.0, dot(N, H));
    let vdh = max(0.0, dot(V, H));
    let a2 = rough * rough * rough * rough;   // (rough^2)^2 for the GGX NDF
    let dd = ndh * ndh * (a2 - 1.0) + 1.0;
    let D = a2 / (3.14159265 * dd * dd + 1e-7);
    let k = ((rough + 1.0) * (rough + 1.0)) / 8.0; // Schlick-GGX (direct)
    let G = (ndv / (ndv * (1.0 - k) + k)) * (ndl / (ndl * (1.0 - k) + k));
    let fp = pow(1.0 - vdh, 5.0);              // Fresnel-Schlick
    let specD = (D * G) / (4.0 * ndl * ndv + 1e-4);
    let f0 = vec3<f32>(0.04) + (albedo - vec3<f32>(0.04)) * metallic;
    let F = f0 + (vec3<f32>(1.0) - f0) * fp;
    let kdm = 1.0 - metallic;                  // metals have no diffuse
    var emis = vec3<f32>(0.0);
    let ef = u.emissive.xyz;
    if (ef.r > 0.0 || ef.g > 0.0 || ef.b > 0.0) {
      var es = vec3<f32>(1.0);
      if (u.texflags.w > 0.5) { es = textureSample(emisTex, samp, vec2<f32>(in.uv.x + u.surface1.x, 1.0 - (in.uv.y + u.surface1.y))).rgb; }
      emis = ef * es;
    }
${g.emis}
    // Ambient / image-based lighting, mirroring the software rasteriser: with an
    // environment, a diffuse irradiance along N + a specular reflection along R
    // blurred toward the average by roughness; without one, the flat ambient.
    var amb: vec3<f32>;
    if (u.envSky.w > 0.5) {
      let irr = envColorDir(N);
      let R = 2.0 * ndv * N - V;
      var spec = envColorDir(R);
      var specAvg = envAverage();
      // Inside a reflection probe's box (the smallest first), reflect the room
      // around it, box-projected from this point, fading to the sky at the box's
      // faces — mirroring pickProbe/boxProject in probeSampling.ts.
      let pc = i32(u.ssaoMeta.w + 0.5);
      let P = in.worldPos;
      for (var i = 0; i < pc; i = i + 1) {
        let pr = probes[i];
        let inside = min(min(min(P.x - pr.mn.x, pr.mx.x - P.x), min(P.y - pr.mn.y, pr.mx.y - P.y)), min(P.z - pr.mn.z, pr.mx.z - P.z));
        let wgt = clamp(inside / ${PROBE_FADE.toFixed(4)}, 0.0, 1.0);
        if (wgt > 0.0) {
          let Rs = select(R, vec3<f32>(1e-6), abs(R) < vec3<f32>(1e-6));
          let tf = max((pr.mx.xyz - P) / Rs, (pr.mn.xyz - P) / Rs);
          let t = max(0.0, min(min(tf.x, tf.y), tf.z));
          spec = mix(spec, probeSample(i, P + R * t - pr.pos.xyz), wgt);
          specAvg = mix(specAvg, pr.avg.xyz, wgt);
          break;
        }
      }
      let pref = mix(spec, specAvg, rough);
      amb = (irr * albedo * kdm + pref * f0 * reflectK) * ao;
    } else {
      amb = vec3<f32>(u.light.w) * albedo * ao;
    }
    // A baked light map (the second UV set) scales the sky/ambient fill by how
    // much of it reaches this point, bounce included — mirroring the CPU path.
    // Sampled unconditionally (uniform control flow), applied when bound.
    let lmUv = vec2<f32>(in.uv2.x, 1.0 - in.uv2.y);
    let lm = textureSample(lmTex, samp, lmUv).rgb * ${LIGHTMAP_RANGE};
    if (u.ssaoMeta.z > 0.5) { amb = amb * lm; }
    // Screen-space AO darkens only the ambient fill, sampled at this fragment's
    // framebuffer pixel (matching the software path's ssao[di]).
    if (u.ssaoMeta.x > 0.5) {
      amb = amb * textureLoad(ssaoMap, vec2<i32>(in.pos.xy), 0).r;
    }
    // The direct light is what a shadow occludes; ambient/IBL still fills it.
    let sf = shadowFactor(in.lightClip, in.worldPos, abs(dot(normalize(in.normal), u.light.xyz)));
    let lc = i32(u.ssaoMeta.y + 0.5);
    var lit: vec3<f32>;
    if (lc > 0) {
      // --- Multi-light forward accumulation (Modern tier) ---
      // Mirrors meshRasterizer.ts: each light re-evaluates the direct term with
      // shared N/ndv/f0/kdm/a2/k; point lights fall off to nothing at their range.
      var direct = vec3<f32>(0.0);
      // The global lights (the sun, unranged lights) reach every fragment…
      let ng = i32(frame.clusterInfo.x + 0.5);
      for (var i = 0; i < ng; i = i + 1) {
        direct = direct + lightTerm(lights[i], in.worldPos, N, V, ndv, a2, k, f0, kdm, albedo, sf);
      }
      // …the rest only the cells they touch (EP8): this fragment's cell, by pixel and depth.
      if (frame.clusterInfo.y > 0.5 && in.eyeDepth >= frame.clusterParams.z) {
        let tile = min(vec2<u32>(in.pos.xy / frame.clusterParams.xy), vec2<u32>(${CLUSTER_X - 1}u, ${CLUSTER_Y - 1}u));
        let slice = min(u32(log(in.eyeDepth / frame.clusterParams.z) * frame.clusterParams.w), ${CLUSTER_Z - 1}u);
        let cell = clusterTable[(slice * ${CLUSTER_Y}u + tile.y) * ${CLUSTER_X}u + tile.x];
        for (var j = 0u; j < cell.y; j = j + 1u) {
          direct = direct + lightTerm(lights[clusterIndex[cell.x + j]], in.worldPos, N, V, ndv, a2, k, f0, kdm, albedo, sf);
        }
      }
      lit = direct + amb + emis;
    } else {
      lit = (kdm * (vec3<f32>(1.0) - F) * albedo + F * specD) * ndl * sf + amb + emis;
    }
    // A fresnel rim, light at grazing angles (zero when the material has none).
    lit = lit + u.surface2.rgb * pow(1.0 - ndv, u.surface2.w);
    // A surface effect's glow, and its bands climbing the body (zero without one).
    let band = pow(0.5 + 0.5 * sin(in.worldPos.y * ${EFFECT_BAND_FREQUENCY.toFixed(1)} - u.effect1.w * ${EFFECT_BAND_SPEED.toFixed(1)}), ${EFFECT_BAND_POWER.toFixed(1)});
    lit = lit + u.effect0.rgb + u.effect1.rgb * band;
    // HDR: expose + ACES roll-off, or write the linear colour straight through.
    var shaded = lit;
    if (u.tonemap.x > 0.5) {
      let e = u.tonemap.y;
      shaded = vec3<f32>(aces(lit.r * e), aces(lit.g * e), aces(lit.b * e));
    }
    // Fog in display space, mirroring applyFog in skyDome.ts: distance fog by
    // eye depth, then height and volume fog along the ray from the eye, toward
    // the fog colour brightened by the sun glow.
    if (u.fogParams.x > 0.5) {
      let d = max(0.0, in.eyeDepth - u.fogParams.y);
      var f = min(u.fogParams.z, 1.0 - exp(-d * u.fog.w));
      var fc = u.fog.rgb;
      if (u.fogParams.w > 0.5) {
        let c = u.fogCam.xyz;
        let ray = in.worldPos - c;
        let len = length(ray);
        var tau = fogLayer(u.fogHeight.x, u.fogHeight.z, u.fogHeight.y, c.y, ray.y, len, 0.0, 1.0);
        let vc = i32(u.fogCam.w + 0.5);
        for (var i = 0; i < vc; i = i + 1) {
          let a = u.fogVol[i * 2];
          let b = u.fogVol[i * 2 + 1];
          let span = fogBox(a.xyz, b.xyz, c, ray);
          if (span.y > span.x) { tau = tau + fogLayer(a.w, b.w, a.y, c.y, ray.y, len, span.x, span.y); }
        }
        f = 1.0 - (1.0 - f) * exp(-tau);
        if (u.fogHeight.w > 0.0) {
          let cosv = max(0.0, dot(ray, u.light.xyz) / (max(len, 1e-6) * max(length(u.light.xyz), 1e-6)));
          fc = min(vec3<f32>(1.0), fc + u.fogGlow.rgb * (u.fogHeight.w * pow(cosv, ${FOG_GLOW_POWER.toFixed(1)})));
        }
      }
      shaded = mix(clamp(shaded, vec3<f32>(0.0), vec3<f32>(1.0)), fc, f);
    }
    return finishAlpha(shaded, colour.a);
  }

  // --- Fantasy path (byte-identical when no shadow; shadow scales the direct term) ---
  // Two-sided Lambert: abs(N·L) so inconsistent winding still lights. The normal
  // is deliberately NOT renormalised — the software rasteriser interpolates and
  // dots without normalising, and parity with it is the contract here. Both
  // therefore skew identically under non-uniform scale.
  let nl = abs(dot(in.normal, u.light.xyz));
  let shade = u.light.w + (1.0 - u.light.w) * nl * shadowFactor(in.lightClip, in.worldPos, abs(dot(normalize(in.normal), u.light.xyz)));
  return finishAlpha(colour.rgb * shade, colour.a);
}
`;
}

interface GpuPrimitive {
  vertexBuffer: any;
  indexBuffer: any;
  indexCount: number;
  /** The `dynamic.revision` last uploaded (skinned meshes rewrite their vertices each frame). */
  revision?: number;
}

interface CachedBindGroup {
  group: any;
  /** The decoded textures this group was built against, so a swap rebuilds it. */
  source: {
    base: DecodedTexture | null;
    mr: DecodedTexture | null;
    occ: DecodedTexture | null;
    emis: DecodedTexture | null;
    lm: DecodedTexture | null;
    detail: DecodedTexture | null;
    blend: DecodedTexture | null;
  };
}

export class WebgpuSceneRenderer implements SceneRenderer {
  readonly backend = "webgpu" as const;

  /** Draws the opening frames, and any frame before the first readback lands. */
  private readonly software: SoftwareSceneRenderer;

  private readonly meshes = new WeakMap<MeshAsset, GpuPrimitive[]>();
  private readonly textures = new WeakMap<DecodedTexture, any>();
  // Not readonly: a resized uniform buffer invalidates every cached group at
  // once, and WeakMap has no clear(), so the map itself is replaced.
  private bindGroups = new WeakMap<MeshPrimitive, CachedBindGroup>();

  /** Most recent completed readback, or null before the first one lands. */
  private latest: Uint8Array | null = null;
  /** Frames submitted, the one `latest` holds, and the newest that got a readback (see settle). */
  private submitted = 0;
  private latestSeq = 0;
  private readSeq = 0;
  /** The shadow depth array last uploaded in full, so a frame that changed only
   *  a region of it (its `dirty` rect) uploads just that region. */
  private shadowUploaded: Float32Array | null = null;
  private uniformCapacity = 0;
  private uniformBuffer: any = null;
  private uniformData = new Float32Array(0);
  private destroyed = false;

  /**
   * The bound shadow map — the 1x1 blank when no shadow this frame, else an
   * r32float sized to the shadow input and uploaded from the CPU-generated map.
   * Its identity only changes on a size change, so the bind-group cache holds.
   */
  private shadowTexture: any;
  private shadowMapSize = 0;
  /** Maps side by side in the shadow texture: 1, or 2 with a near cascade (EP8b). */
  private shadowCascades = 1;
  /** The near cascade's depth array last uploaded in full (as shadowUploaded is the main map's). */
  private nearUploaded: Float32Array | null = null;

  /**
   * The bound equirectangular environment map — the 1x1 blank (reusing the white
   * texture) when the frame has none, else an rgba8unorm upload of the decoded
   * panorama. Keyed by the source object so it uploads once per distinct map.
   */
  private envTexture: any;
  private envMapSource: DecodedTexture | null = null;

  /** The SSAO buffer: a lazily-created width×height r32float upload target, and
   *  what binding 8 currently references (that upload, or the 1x1 blank). */
  private ssaoTexture: any = null;
  private ssaoBound: any;

  /** The Modern-tier light storage buffer, grown as needed; always ≥ 1 light. */
  private lightBuffer: any = null;
  private lightBufferFloats = 0;

  /** The reflection-probe atlas (binding 12, the 1x1 blank when none) and its source. */
  private probeTexture: any;
  private probeSource: DecodedTexture | null = null;
  /** The probe boxes (binding 13): room for every probe a scene may carry. */
  private probeBuffer: any = null;

  /** Per-instance transforms (binding 10), grown as needed. */
  private instanceBuffer: any = null;
  private instanceCapacity = 0;
  private instanceData = new Float32Array(0);

  /** What the last submitted frame drew (for the profiler and tests); GPU time when the device can time it. */
  lastFrameStats: RenderStats = { drawCalls: 0, instances: 0, triangles: 0, gpuMs: null };
  private readonly timer: WebgpuPassTimer | null;

  private constructor(
    private readonly device: any,
    private readonly width: number,
    private readonly height: number,
    private readonly pipeline: PipelineSet,
    /** Build the pipelines for a shader variant (a material graph's, EP7). */
    private readonly pipelinesFor: (code: string) => PipelineSet,
    private readonly bindGroupLayout: any,
    private readonly colourTexture: any,
    private readonly depthTexture: any,
    /** Group 1 (EP6b): the opaque depth for the see-through pass, or a blank for the opaque one. */
    private readonly depthGroups: { readonly blank: any; readonly scene: any; readonly blankTexture: any; readonly clusters: { readonly table: any; readonly index: any; readonly params: any } },
    private readonly sampler: any,
    private readonly blankTexture: any,
    /** 1x1 r32float, bound to the shadow slot when no shadow map is active. */
    private readonly blankShadow: any,
    private readonly readback: { buffer: any; busy: boolean; seq?: number }[],
    private readonly bytesPerRow: number,
    style: RasterStyle,
  ) {
    // The warm-up rasteriser must draw the same era as the GPU it stands in for.
    this.software = new SoftwareSceneRenderer(style);
    this.shadowTexture = blankShadow;
    this.envTexture = blankTexture; // the 1x1 white stands in until a map is bound
    this.probeTexture = blankTexture;
    this.ssaoBound = blankShadow; // the 1x1 r32float blank until an AO buffer arrives
    this.timer = WebgpuPassTimer.create(device);
  }

  /**
   * Point the SSAO slot at a width×height r32float upload of `ao` (created once,
   * lazily), or the 1x1 blank when there is none; a change invalidates cached
   * bind groups (binding 8 moved).
   */
  private bindSsao(ao: Float32Array | null): void {
    if (ao) {
      if (!this.ssaoTexture) {
        this.ssaoTexture = this.device.createTexture({
          size: { width: this.width, height: this.height },
          format: "r32float",
          usage: 0x04 | 0x02, // TEXTURE_BINDING | COPY_DST
        });
      }
      this.device.queue.writeTexture(
        { texture: this.ssaoTexture },
        ao,
        { bytesPerRow: this.width * 4, rowsPerImage: this.height },
        { width: this.width, height: this.height },
      );
      if (this.ssaoBound !== this.ssaoTexture) {
        this.ssaoBound = this.ssaoTexture;
        this.bindGroups = new WeakMap();
      }
    } else if (this.ssaoBound !== this.blankShadow) {
      this.ssaoBound = this.blankShadow;
      this.bindGroups = new WeakMap();
    }
  }

  /**
   * Upload the packed light list, growing the storage buffer when it needs more
   * room (a grow changes identity, so invalidate cached bind groups). The buffer
   * always holds at least one light so binding 9 is never empty.
   */
  private uploadLights(packed: Float32Array): void {
    if (!this.lightBuffer || packed.length > this.lightBufferFloats) {
      destroySafely(this.lightBuffer);
      this.lightBufferFloats = Math.max(packed.length, this.lightBufferFloats * 2, 12);
      this.lightBuffer = this.device.createBuffer({
        size: this.lightBufferFloats * 4,
        usage: 0x80 | 0x08, // STORAGE | COPY_DST
      });
      this.bindGroups = new WeakMap();
    }
    this.device.queue.writeBuffer(this.lightBuffer, 0, packed, 0, packed.length);
  }

  /**
   * Build the renderer for one framebuffer size. Returns null on any failure, so
   * the factory falls back to software rather than the caller seeing an
   * exception mid-frame.
   */
  static async create(
    device: any,
    width: number,
    height: number,
    style: RasterStyle = DEFAULT_RASTER_STYLE,
  ): Promise<WebgpuSceneRenderer | null> {
    // Refuse a style this path cannot reproduce, so the factory falls back to
    // the software rasteriser rather than rendering a console model with the
    // wrong era's rules. See `webgpuCanHonour` for why these three are hard.
    if (!webgpuCanHonour(style)) return null;
    try {

      // An explicit layout, not "auto": a layout WebGPU infers from the shader
      // declares the uniform WITHOUT a dynamic offset, and `setBindGroup` then
      // rejects the offsets this renderer addresses its draws by. That failure
      // appears only on a real device, so the layout is spelled out here.
      // minBindingSize pins the struct size, so a change to the WGSL that does
      // not reach scenePacking.ts fails at pipeline creation rather than
      // rendering silent garbage.
      const bindGroupLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: SHADER_STAGE_VERTEX | SHADER_STAGE_FRAGMENT,
            buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: UNIFORM_BYTES_USED },
          },
          { binding: 1, visibility: SHADER_STAGE_FRAGMENT, sampler: { type: "filtering" } },
          { binding: 2, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } },
          // Modern-tier metallic-roughness maps. A non-PBR draw binds the 1x1
          // blank for all three and the shader ignores them (pbr.z = 0), so the
          // layout is one shape for every draw.
          { binding: 3, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } },
          { binding: 4, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } },
          { binding: 5, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } },
          // The shadow map is r32float — not filterable — and read via textureLoad,
          // so it declares unfilterable-float and needs no sampler.
          { binding: 6, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "unfilterable-float" } },
          // The equirectangular environment map (rgba8unorm), read via textureLoad.
          { binding: 7, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } },
          // The SSAO buffer (r32float), read per fragment via textureLoad.
          { binding: 8, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "unfilterable-float" } },
          // The Modern-tier light list, read-only storage.
          { binding: 9, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "read-only-storage" } },
          // Per-instance transforms, read by the vertex stage.
          { binding: 10, visibility: SHADER_STAGE_VERTEX, buffer: { type: "read-only-storage" } },
          { binding: 11, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } },
          // Reflection probes: the panorama atlas (read via textureLoad) and their boxes.
          { binding: 12, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } },
          { binding: 13, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "read-only-storage" } },
          // The detail map, and the blend surface's map.
          { binding: 14, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } },
          { binding: 15, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } },
        ],
      });

      // One pipeline per transparency (EP6): opaque surfaces write depth;
      // blended ones (premultiplied colour over what's there) and added ones
      // test depth without writing it, drawn after the opaque scene.
      // Group 1 is the opaque depth for soft edges (EP6b): the see-through pass
      // reads it while it is attached read-only; the opaque pass binds a blank.
      // It also carries the clustered lights (EP8): the cell table, the index list and their params.
      const depthLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "depth" } },
          { binding: 1, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "read-only-storage" } },
          { binding: 2, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "read-only-storage" } },
          { binding: 3, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "uniform" } },
        ],
      });
      const layout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout, depthLayout] });
      const pipelinesFor = (code: string): PipelineSet => {
        const module = device.createShaderModule({ code });
        const pipelineFor = (blend: unknown, depthWrite: boolean) => device.createRenderPipeline({
          layout,
          vertex: {
            module,
            entryPoint: "vs",
            buffers: [
              {
                // Interleaved position(3) + normal(3) + uv(2) + light-map uv(2).
                arrayStride: 44,
                attributes: [
                  { shaderLocation: 0, offset: 0, format: "float32x3" },
                  { shaderLocation: 1, offset: 12, format: "float32x3" },
                  { shaderLocation: 2, offset: 24, format: "float32x2" },
                  { shaderLocation: 3, offset: 32, format: "float32x2" },
                  { shaderLocation: 4, offset: 40, format: "float32" },
                ],
              },
            ],
          },
          fragment: {
            module,
            entryPoint: "fs",
            // rgba8unorm, never rgba8unorm-srgb: the framebuffer these bytes land
            // in is the same 8-bit buffer the CPU path writes, so any gamma
            // conversion here would show up as the GPU path looking washed out.
            targets: [blend ? { format: "rgba8unorm", blend } : { format: "rgba8unorm" }],
          },
          // cullMode "none" matches the software rasteriser, which draws both
          // faces (its Lambert is two-sided for exactly this reason).
          primitive: { topology: "triangle-list", cullMode: "none" },
          depthStencil: { format: "depth24plus", depthWriteEnabled: depthWrite, depthCompare: "less" },
        });
        return {
          opaque: pipelineFor(null, true),
          blend: pipelineFor({ color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } }, false),
          add: pipelineFor({ color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" } }, false),
        };
      };
      const pipeline = pipelinesFor(sceneShader());

      const colourTexture = device.createTexture({
        size: { width, height },
        format: "rgba8unorm",
        usage: 0x10 | 0x01, // RENDER_ATTACHMENT | COPY_SRC
      });
      const depthTexture = device.createTexture({
        size: { width, height },
        format: "depth24plus",
        usage: 0x10 | 0x04, // RENDER_ATTACHMENT | TEXTURE_BINDING (soft edges read it)
      });
      const blankDepth = device.createTexture({
        size: { width: 1, height: 1 },
        format: "depth24plus",
        usage: 0x10 | 0x04, // RENDER_ATTACHMENT | TEXTURE_BINDING
      });
      const clusterBuffers = {
        table: device.createBuffer({ size: CLUSTER_CELLS * 8, usage: 0x80 | 0x08 }), // STORAGE | COPY_DST
        index: device.createBuffer({ size: CLUSTER_INDEX_CAP * 4, usage: 0x80 | 0x08 }),
        params: device.createBuffer({ size: FRAME_BYTES, usage: 0x40 | 0x08 }), // UNIFORM | COPY_DST
      };
      const clusterEntries = [
        { binding: 1, resource: { buffer: clusterBuffers.table } },
        { binding: 2, resource: { buffer: clusterBuffers.index } },
        { binding: 3, resource: { buffer: clusterBuffers.params } },
      ];
      const depthGroups = {
        blank: device.createBindGroup({ layout: depthLayout, entries: [{ binding: 0, resource: blankDepth.createView() }, ...clusterEntries] }),
        scene: device.createBindGroup({ layout: depthLayout, entries: [{ binding: 0, resource: depthTexture.createView() }, ...clusterEntries] }),
        blankTexture: blankDepth,
        clusters: clusterBuffers,
      };
      // Filtering is the one era trait that is just a sampler setting. Nearest
      // gives the crunchy, aliased texels of a machine that could not filter;
      // linear gives the softness of one that could.
      const filter = style.textureFiltering === "none" ? "nearest" : "linear";
      const sampler = device.createSampler({
        magFilter: filter,
        minFilter: filter,
        addressModeU: "repeat",
        addressModeV: "repeat",
      });

      // A 1x1 opaque white stands in for "no texture", so the bind group layout
      // is the same shape whether a primitive is textured or not.
      const blankTexture = device.createTexture({
        size: { width: 1, height: 1 },
        format: "rgba8unorm",
        usage: 0x04 | 0x02, // TEXTURE_BINDING | COPY_DST
      });
      device.queue.writeTexture(
        { texture: blankTexture },
        new Uint8Array([255, 255, 255, 255]),
        { bytesPerRow: 4 },
        { width: 1, height: 1 },
      );

      // A 1x1 r32float stands in for "no shadow map", so binding 6 always has a
      // resource. A single 0 depth is never read: the uniform's shadow flag is 0.
      const blankShadow = device.createTexture({
        size: { width: 1, height: 1 },
        format: "r32float",
        usage: 0x04 | 0x02, // TEXTURE_BINDING | COPY_DST
      });
      device.queue.writeTexture(
        { texture: blankShadow },
        new Float32Array([0]),
        { bytesPerRow: 4 },
        { width: 1, height: 1 },
      );

      const bytesPerRow = alignBytesPerRow(width);
      const readback = Array.from({ length: READBACK_BUFFERS }, () => ({
        buffer: device.createBuffer({
          size: bytesPerRow * height,
          usage: 0x08 | 0x01, // MAP_READ | COPY_DST
        }),
        busy: false,
      }));

      return new WebgpuSceneRenderer(
        device,
        width,
        height,
        pipeline,
        pipelinesFor,
        bindGroupLayout,
        colourTexture,
        depthTexture,
        depthGroups,
        sampler,
        blankTexture,
        blankShadow,
        readback,
        bytesPerRow,
        style,
      );
    } catch {
      return null;
    }
  }

  /**
   * Point the shadow slot at an r32float sized to `size`, (re)creating it on a
   * size change and invalidating cached bind groups (binding 6 identity moved).
   * `size` 0 restores the 1x1 blank for a frame with no shadow.
   */
  private ensureShadowTexture(size: number, cascades = 1): void {
    if (size === this.shadowMapSize && cascades === this.shadowCascades) return;
    this.shadowCascades = cascades;
    this.shadowUploaded = null; // a new texture needs a full upload
    this.nearUploaded = null;
    if (size === 0) {
      if (this.shadowTexture !== this.blankShadow) this.shadowTexture = this.blankShadow;
    } else {
      destroySafely(this.shadowMapSize > 0 ? this.shadowTexture : null);
      this.shadowTexture = this.device.createTexture({
        size: { width: size * cascades, height: size },
        format: "r32float",
        usage: 0x04 | 0x02, // TEXTURE_BINDING | COPY_DST
      });
    }
    this.shadowMapSize = size;
    this.bindGroups = new WeakMap(); // binding 6 changed identity
  }

  /**
   * Point the env-map slot at an rgba8unorm upload of `map`, once per distinct
   * source object; null restores the 1x1 blank. A change invalidates cached bind
   * groups (binding 7 moved).
   */
  private ensureEnvTexture(map: DecodedTexture | null): void {
    if (map === this.envMapSource) return;
    if (this.envMapSource) destroySafely(this.envTexture); // release the previous upload
    this.envTexture = map ? this.uploadRgba(map) : this.blankTexture;
    this.envMapSource = map;
    this.bindGroups = new WeakMap(); // binding 7 changed identity
  }

  /** The same for the reflection-probe atlas (binding 12), plus the boxes (binding 13). */
  private ensureProbes(set: ReflectionProbeSet | null): void {
    const atlas = set?.atlas ?? null;
    if (!this.probeBuffer) {
      this.probeBuffer = this.device.createBuffer({ size: MAX_REFLECTION_PROBES * PROBE_FLOATS * 4, usage: 0x80 | 0x08 }); // STORAGE | COPY_DST
      this.bindGroups = new WeakMap();
    }
    if (atlas === this.probeSource) return;
    if (this.probeSource) destroySafely(this.probeTexture);
    this.probeTexture = atlas ? this.uploadRgba(atlas) : this.blankTexture;
    this.probeSource = atlas;
    const packed = packProbes(set);
    this.device.queue.writeBuffer(this.probeBuffer, 0, packed, 0, packed.length);
    this.bindGroups = new WeakMap(); // binding 12 changed identity
  }

  /** A one-off rgba8unorm upload of a decoded image. */
  private uploadRgba(map: DecodedTexture): any {
    const texture = this.device.createTexture({
      size: { width: map.width, height: map.height },
      format: "rgba8unorm",
      usage: 0x04 | 0x02, // TEXTURE_BINDING | COPY_DST
    });
    this.device.queue.writeTexture({ texture }, map.data, { bytesPerRow: map.width * 4, rowsPerImage: map.height }, { width: map.width, height: map.height });
    return texture;
  }

  render(instances: readonly MeshSceneInstance[], draw: SceneDraw): void {
    if (this.destroyed) return;

    // LOD-select + frustum-cull once, so both the CPU warm-up and the GPU submit
    // draw the same visible set. A correct cull is output-identical.
    const visible = applyScenePasses(instances, draw);

    // Composite the newest completed GPU frame, or rasterise this one on the CPU
    // while the pipeline fills. Either way `out` is correct when this returns.
    presentFrame(this.latest, visible, draw, this.software);

    try {
      this.submit(visible, draw);
    } catch {
      // A lost device or an unbuildable buffer must not take the cart down: drop
      // back to software permanently by forgetting the last GPU frame.
      this.latest = null;
    }
  }

  /** Whether a finished GPU frame exists to show (false until the first readback lands). */
  get ready(): boolean {
    return this.latest !== null;
  }

  settle(draw: SceneDraw): FrameState {
    if (this.destroyed) return "current";
    if (this.latest) compositeFrame(this.latest, draw);
    if (this.latestSeq >= this.submitted) return "current";
    return this.readSeq >= this.submitted ? "pending" : "stale";
  }

  /** Encode and submit one frame, and start a readback if a buffer is free. */
  private submit(instances: readonly MeshSceneInstance[], draw: SceneDraw): void {
    const viewProj = multiplyMat4(draw.projection, draw.view);

    // Batch the copies of each primitive that bind the same textures: one
    // uniform (addressed by a dynamic offset) and one instanced draw per batch.
    const { batches: draws, instanceCount } = batchInstances(instances, (mesh) => this.uploadMesh(mesh), cameraPositionFromView(draw.view));
    if (draws.length === 0) return;

    this.ensureUniformCapacity(draws.length);
    this.ensureInstanceCapacity(instanceCount);
    // Resolved once: the light and view direction are per frame, not per draw, and
    // normalising them per primitive would be the same answer computed many times.
    const light = resolveLight(draw.lightDirection, draw.ambient);
    const viewDir = viewDirection(draw.view);
    const eye = cameraPositionFromView(draw.view);

    // Shadow map: the CPU-generated map (renderShadowMap) uploaded as r32float so
    // the GPU samples the *same* depths the software path tests against. `size` 0
    // restores the blank when this frame casts no shadow.
    const shadow = draw.shadow ?? null;
    this.ensureShadowTexture(shadow ? shadow.size : 0, shadow?.near ? 2 : 1);
    if (shadow?.near) {
      // The near cascade (EP8b), to the right of the main map: its changed region, or all of it.
      const near = shadow.near;
      const dirty = near.dirty;
      if (dirty && this.nearUploaded === near.depth) {
        if (dirty.width > 0 && dirty.height > 0) {
          this.device.queue.writeTexture(
            { texture: this.shadowTexture, origin: { x: shadow.size + dirty.x, y: dirty.y } },
            near.depth,
            { offset: (dirty.y * shadow.size + dirty.x) * 4, bytesPerRow: shadow.size * 4, rowsPerImage: dirty.height },
            { width: dirty.width, height: dirty.height },
          );
        }
      } else {
        this.device.queue.writeTexture({ texture: this.shadowTexture, origin: { x: shadow.size, y: 0 } }, near.depth, { bytesPerRow: shadow.size * 4, rowsPerImage: shadow.size }, { width: shadow.size, height: shadow.size });
        this.nearUploaded = near.depth;
      }
    } else {
      this.nearUploaded = null;
    }
    if (shadow) {
      const dirty = shadow.dirty;
      if (dirty && this.shadowUploaded === shadow.depth) {
        // Only the region that changed since the last frame (the movers'
        // shadows, old and new): a few KB instead of the whole map.
        if (dirty.width > 0 && dirty.height > 0) {
          this.device.queue.writeTexture(
            { texture: this.shadowTexture, origin: { x: dirty.x, y: dirty.y } },
            shadow.depth,
            { offset: (dirty.y * shadow.size + dirty.x) * 4, bytesPerRow: shadow.size * 4, rowsPerImage: dirty.height },
            { width: dirty.width, height: dirty.height },
          );
        }
      } else {
        this.device.queue.writeTexture(
          { texture: this.shadowTexture },
          shadow.depth,
          { bytesPerRow: shadow.size * 4, rowsPerImage: shadow.size },
          { width: shadow.size, height: shadow.size },
        );
        this.shadowUploaded = shadow.depth;
      }
    }
    const shadowParams = shadow
      ? { size: shadow.size, bias: shadow.bias ?? 0.003, strength: shadow.strength ?? 1, slopeBias: shadow.slopeBias ?? 0, pcf: shadow.pcf ?? false }
      : null;

    // Env map: uploaded once per distinct decoded panorama; the uniform's
    // envMeta.w (written from environment.average) gates whether it is sampled.
    this.ensureEnvTexture(draw.environment?.map ?? null);
    this.ensureProbes(draw.environment?.probes ?? null);

    // SSAO: upload the CPU-generated AO buffer (same one the software path uses)
    // for the shader to sample per fragment.
    const ssao = draw.ssao ?? null;
    this.bindSsao(ssao);

    // Modern-tier lights: packed global-first for the WGSL loop, the rest
    // sorted into the view's cells (EP8) so each fragment shades only its own.
    const { ordered } = this.clusterLights(draw);
    this.uploadLights(packLights(ordered));
    const lightCount = ordered.length;

    let next = 0;
    draws.forEach((entry, index) => {
      entry.first = next;
      for (const model of entry.models) {
        writeInstanceTransform(this.instanceData, next, {
          mvp: multiplyMat4(viewProj, model),
          lightMvp: shadow ? multiplyMat4(shadow.lightViewProj, model) : null,
          model,
          normalBasis: normalBasis3x3(model),
        });
        next += 1;
      }
      // The batch's material uniforms. The transform fields are the first
      // copy's; the shader reads every copy's own from the instance buffer.
      const model = entry.models[0]!;
      const pbr = resolvePbr(
        entry.primitive.material,
        entry.textures.mr !== null,
        entry.textures.occ !== null,
        entry.textures.emis !== null,
      );
      writeInstanceUniform(this.uniformData, index, {
        mvp: multiplyMat4(viewProj, model),
        normalBasis: normalBasis3x3(model),
        baseColor: entry.primitive.material.baseColorFactor,
        hasTexture: entry.textures.base !== null,
        light,
        viewDir,
        pbr,
        hasMrMap: entry.textures.mr !== null,
        hasOcclusionMap: entry.textures.occ !== null,
        hasEmissiveMap: entry.textures.emis !== null,
        environment: draw.environment ?? null,
        lightMvp: shadow ? multiplyMat4(shadow.lightViewProj, model) : null,
        shadow: shadowParams,
        tonemap: draw.tonemap ?? null,
        hasSsao: ssao !== null,
        hasLightmap: entry.textures.lm !== null,
        model,
        lightCount,
        fog: draw.fog ?? null,
        eye,
        effect: entry.effect ?? null,
        time: draw.time ?? 0,
        alpha: { mode: entry.alpha, cutoff: entry.primitive.material.alphaCutoff ?? 0.5 },
        soft: softEdges(entry.primitive.material, entry.alpha, draw.projection),
        surface: resolveSurface(entry.primitive.material, draw.time ?? 0, entry.textures.detail !== null, entry.textures.mr !== null, {
          weights: entry.primitive.blend !== undefined,
          textured: entry.textures.blend !== null,
        }),
      });
    });
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData, 0, draws.length * UNIFORM_FLOATS);
    this.device.queue.writeBuffer(this.instanceBuffer, 0, this.instanceData, 0, instanceCount * INSTANCE_FLOATS);
    let triangles = 0;
    for (const entry of draws) triangles += (entry.geometry.indexCount / 3) * entry.models.length;
    this.lastFrameStats = { drawCalls: draws.length, instances: instanceCount, triangles, gpuMs: this.timer?.lastMs ?? null };

    // Soft edges (EP6b) need the opaque depth readable, so a frame that has
    // any draws its see-through batches in a second pass, with the depth
    // attached read-only and bound for the shader to sample.
    const split = draws.some((entry) => softEdges(entry.primitive.material, entry.alpha, draw.projection) !== undefined);
    const firstSeeThrough = split ? draws.findIndex((entry) => entry.alpha >= 2) : -1;
    const encoder = this.device.createCommandEncoder();
    const drawRange = (pass: any, from: number, to: number, depthGroup: any) => {
      pass.setBindGroup(1, depthGroup);
      let bound: any = null;
      for (let index = from; index < to; index += 1) {
        const entry = draws[index]!;
        const set = this.pipelinesOf(entry.primitive.material);
        const wanted = entry.alpha === 3 ? set.add : entry.alpha === 2 ? set.blend : set.opaque;
        if (wanted !== bound) {
          pass.setPipeline(wanted);
          bound = wanted;
        }
        pass.setBindGroup(0, this.bindGroupFor(entry.primitive, entry.textures), [index * UNIFORM_STRIDE]);
        pass.setVertexBuffer(0, entry.geometry.vertexBuffer);
        pass.setIndexBuffer(entry.geometry.indexBuffer, "uint32");
        pass.drawIndexed(entry.geometry.indexCount, entry.models.length, 0, 0, entry.first);
      }
    };
    const opaqueEnd = firstSeeThrough >= 0 ? firstSeeThrough : draws.length;
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.colourTexture.createView(),
          // Transparent black: every untouched pixel reads as "nothing drawn",
          // which is what lets the composite leave the cart's frame showing.
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
      ...(this.timer ? { timestampWrites: this.timer.writes(firstSeeThrough >= 0 ? "begin" : "both") } : {}),
    });
    drawRange(pass, 0, opaqueEnd, this.depthGroups.blank);
    pass.end();
    if (firstSeeThrough >= 0) {
      const seeThrough = encoder.beginRenderPass({
        colorAttachments: [{ view: this.colourTexture.createView(), loadOp: "load", storeOp: "store" }],
        depthStencilAttachment: { view: this.depthTexture.createView(), depthReadOnly: true },
        ...(this.timer ? { timestampWrites: this.timer.writes("end") } : {}),
      });
      drawRange(seeThrough, firstSeeThrough, draws.length, this.depthGroups.scene);
      seeThrough.end();
    }
    this.timer?.resolve(encoder);

    this.submitted += 1;
    const slot = this.readback.find((entry) => !entry.busy);
    if (slot) {
      slot.busy = true;
      slot.seq = this.submitted;
      this.readSeq = this.submitted;
      encoder.copyTextureToBuffer(
        { texture: this.colourTexture },
        { buffer: slot.buffer, bytesPerRow: this.bytesPerRow, rowsPerImage: this.height },
        { width: this.width, height: this.height },
      );
      this.device.queue.submit([encoder.finish()]);
      this.timer?.read();
      void this.drain(slot);
    } else {
      // Every staging buffer is still mapped; render anyway and read back next
      // frame rather than stalling the run loop waiting for one.
      this.device.queue.submit([encoder.finish()]);
      this.timer?.read();
    }
  }

  /** Shader variants by material graph (EP7), built on first use. */
  private readonly graphPipelines = new Map<string, PipelineSet>();

  /** The pipelines a material draws with: the plain shader's, or its graph's variant. */
  private pipelinesOf(material: MeshPrimitive["material"]): PipelineSet {
    const graph = compiledGraphOf(material);
    if (!graph) return this.pipeline;
    let set = this.graphPipelines.get(graph.key);
    if (!set) {
      set = this.pipelinesFor(sceneShader(graph));
      this.graphPipelines.set(graph.key, set);
    }
    return set;
  }

  /**
   * Order the frame's lights (global first), build the clustered cells, and
   * write both and their params. An orthographic view (no cells) loops every light.
   */
  private clusterLights(draw: SceneDraw) {
    const { ordered, globalCount } = orderLights(draw.lights ?? []);
    const clusters = ordered.length > globalCount ? buildLightClusters(ordered, globalCount, draw.view, draw.projection, this.width, this.height) : null;
    const buffers = this.depthGroups.clusters;
    if (clusters) {
      this.device.queue.writeBuffer(buffers.table, 0, clusters.table);
      this.device.queue.writeBuffer(buffers.index, 0, clusters.indices, 0, Math.max(4, Math.ceil(clusters.used / 4) * 4));
    }
    const near = draw.shadow?.near ?? null;
    const frame = new Float32Array(FRAME_BYTES / 4);
    frame.set(clusters?.params ?? [1, 1, 1, 1], 0);
    frame.set([clusters ? globalCount : ordered.length, clusters ? 1 : 0], 4);
    if (near) {
      frame.set(near.lightViewProj, 8);
      frame.set([1, near.bias, near.slopeBias], 24);
    }
    this.device.queue.writeBuffer(buffers.params, 0, frame);
    return { ordered, globalCount, clusters };
  }

  /** Await one readback and publish it as the newest frame. */
  private async drain(slot: { buffer: any; busy: boolean; seq?: number }): Promise<void> {
    try {
      await slot.buffer.mapAsync(0x01); // MapMode.READ
      if (this.destroyed) return;
      // Readbacks can land out of order; an older one never replaces a newer frame.
      if ((slot.seq ?? 0) >= this.latestSeq) {
        const padded = new Uint8Array(slot.buffer.getMappedRange());
        this.latest = unpadRows(padded, this.width, this.height, this.bytesPerRow, this.latest);
        this.latestSeq = slot.seq ?? 0;
      }
      slot.buffer.unmap();
    } catch {
      // A failed map just means no new frame; the previous one keeps showing.
    } finally {
      slot.busy = false;
    }
  }

  /** Grow the per-draw uniform buffer to hold at least `count` draws. */
  private ensureUniformCapacity(count: number): void {
    if (count <= this.uniformCapacity) return;
    this.uniformBuffer?.destroy?.();
    this.uniformCapacity = Math.max(count, this.uniformCapacity * 2, 8);
    this.uniformBuffer = this.device.createBuffer({
      size: this.uniformCapacity * UNIFORM_STRIDE,
      usage: 0x40 | 0x08, // UNIFORM | COPY_DST
    });
    this.uniformData = new Float32Array(this.uniformCapacity * UNIFORM_FLOATS);
    // The buffer changed identity, so every cached bind group referencing the
    // old one is stale.
    this.bindGroups = new WeakMap();
  }

  /** Grow the per-instance transform buffer to hold at least `count` instances. */
  private ensureInstanceCapacity(count: number): void {
    if (count <= this.instanceCapacity) return;
    destroySafely(this.instanceBuffer);
    this.instanceCapacity = Math.max(count, this.instanceCapacity * 2, 16);
    this.instanceBuffer = this.device.createBuffer({
      size: this.instanceCapacity * INSTANCE_FLOATS * 4,
      usage: 0x80 | 0x08, // STORAGE | COPY_DST
    });
    this.instanceData = new Float32Array(this.instanceCapacity * INSTANCE_FLOATS);
    this.bindGroups = new WeakMap(); // binding 10 changed identity
  }

  /**
   * Upload (once) a mesh's primitives as interleaved vertex + index buffers. A
   * live skinned primitive (`dynamic`) re-uploads its vertices into the same
   * buffer whenever its revision moves on.
   */
  private uploadMesh(mesh: MeshAsset): GpuPrimitive[] {
    const cached = this.meshes.get(mesh);
    if (cached) {
      mesh.primitives.forEach((primitive, i) => {
        const gpu = cached[i];
        if (!primitive.dynamic || !gpu || gpu.revision === primitive.dynamic.revision) return;
        const normals = primitive.normals ?? computeSmoothNormals(primitive.positions, primitive.indices);
        this.device.queue.writeBuffer(gpu.vertexBuffer, 0, interleaveVertices(primitive.positions, normals, primitive.uvs, primitive.uvs2 ?? null, primitive.blend ?? null));
        gpu.revision = primitive.dynamic.revision;
      });
      return cached;
    }

    const uploaded = mesh.primitives.map((primitive) => {
      const normals = primitive.normals ?? computeSmoothNormals(primitive.positions, primitive.indices);
      const vertices = interleaveVertices(primitive.positions, normals, primitive.uvs, primitive.uvs2 ?? null, primitive.blend ?? null);
      const vertexBuffer = this.device.createBuffer({
        size: Math.max(40, vertices.byteLength),
        usage: 0x20 | 0x08, // VERTEX | COPY_DST
      });
      this.device.queue.writeBuffer(vertexBuffer, 0, vertices);

      const indexBuffer = this.device.createBuffer({
        size: Math.max(4, primitive.indices.byteLength),
        usage: 0x10 | 0x08, // INDEX | COPY_DST
      });
      this.device.queue.writeBuffer(indexBuffer, 0, primitive.indices);

      return {
        vertexBuffer,
        indexBuffer,
        indexCount: primitive.indices.length,
        ...(primitive.dynamic ? { revision: primitive.dynamic.revision } : {}),
      };
    });

    this.meshes.set(mesh, uploaded);
    return uploaded;
  }

  /** The bind group for one primitive, rebuilt if any of its textures changed. */
  private bindGroupFor(primitive: MeshPrimitive, textures: PrimitiveTextures): any {
    const cached = this.bindGroups.get(primitive);
    if (
      cached &&
      cached.source.base === textures.base &&
      cached.source.mr === textures.mr &&
      cached.source.occ === textures.occ &&
      cached.source.emis === textures.emis &&
      cached.source.lm === textures.lm &&
      cached.source.detail === textures.detail &&
      cached.source.blend === textures.blend
    ) {
      return cached.group;
    }

    const view = (texture: DecodedTexture | null): any =>
      (texture ? this.uploadTexture(texture) : this.blankTexture).createView();
    const group = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: UNIFORM_STRIDE } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: view(textures.base) },
        { binding: 3, resource: view(textures.mr) },
        { binding: 4, resource: view(textures.occ) },
        { binding: 5, resource: view(textures.emis) },
        // The active shadow map (or the 1x1 blank). Its identity only moves on a
        // size change, which invalidates this whole cache, so a cached group
        // always references the current one.
        { binding: 6, resource: this.shadowTexture.createView() },
        // The active env map (or the 1x1 white blank); likewise cache-invalidated.
        { binding: 7, resource: this.envTexture.createView() },
        // The active SSAO buffer (or the 1x1 blank); likewise cache-invalidated.
        { binding: 8, resource: this.ssaoBound.createView() },
        // The light storage buffer; a grow changes identity and invalidates the cache.
        { binding: 9, resource: { buffer: this.lightBuffer } },
        // The instance transforms; a grow changes identity and invalidates the cache.
        { binding: 10, resource: { buffer: this.instanceBuffer } },
        // The baked light map (or the 1x1 white blank; the uniform flag gates it).
        { binding: 11, resource: view(textures.lm) },
        // The probe atlas (or the blank) and boxes; a change invalidates the cache.
        { binding: 12, resource: this.probeTexture.createView() },
        { binding: 13, resource: { buffer: this.probeBuffer } },
        // The detail map (or the 1x1 white blank; the uniform gates it).
        { binding: 14, resource: view(textures.detail) },
        { binding: 15, resource: view(textures.blend) },
      ],
    });
    this.bindGroups.set(primitive, { group, source: { ...textures } });
    return group;
  }

  /** Upload (once) a decoded texture. */
  private uploadTexture(source: DecodedTexture): any {
    const cached = this.textures.get(source);
    if (cached) return cached;

    const texture = this.device.createTexture({
      size: { width: source.width, height: source.height },
      format: "rgba8unorm",
      usage: 0x04 | 0x02, // TEXTURE_BINDING | COPY_DST
    });
    this.device.queue.writeTexture(
      { texture },
      source.data,
      { bytesPerRow: source.width * 4, rowsPerImage: source.height },
      { width: source.width, height: source.height },
    );
    this.textures.set(source, texture);
    return texture;
  }

  dispose(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.latest = null;
    this.software.dispose();
    destroySafely(this.colourTexture);
    destroySafely(this.depthTexture);
    destroySafely(this.depthGroups.blankTexture);
    destroySafely(this.depthGroups.clusters.table);
    destroySafely(this.depthGroups.clusters.index);
    destroySafely(this.depthGroups.clusters.params);
    destroySafely(this.blankTexture);
    destroySafely(this.blankShadow);
    if (this.shadowTexture !== this.blankShadow) destroySafely(this.shadowTexture);
    if (this.envTexture !== this.blankTexture) destroySafely(this.envTexture);
    if (this.probeTexture !== this.blankTexture) destroySafely(this.probeTexture);
    destroySafely(this.probeBuffer);
    destroySafely(this.ssaoTexture);
    destroySafely(this.lightBuffer);
    destroySafely(this.instanceBuffer);
    destroySafely(this.uniformBuffer);
    for (const slot of this.readback) destroySafely(slot.buffer);
    this.timer?.destroy();
  }
}

/** Release a GPU resource without caring whether it exists or supports destroy. */
function destroySafely(resource: any): void {
  try {
    resource?.destroy?.();
  } catch {
    // Already released, or a device that has gone away. Nothing to do.
  }
}
