/**
 * The player's WebGL2 triangle path (ENGINE_ROADMAP.md, Phase 4): the GPU
 * renderer for browsers without WebGPU, so they no longer drop to the software
 * rasteriser — Safari before 26, Firefox on most platforms, older Android.
 *
 * It is a port of {@link WebgpuSceneRenderer} and keeps its contract: the same
 * shading, term for term (byte-identical to the software rasteriser on the
 * fantasy tiers, a visual match on the Modern PBR branch), the same instanced
 * batching, and the same asynchronous readback — the frame composited is the
 * newest one the GPU has finished, one or two behind, with the software
 * rasteriser drawing until the first lands.
 *
 * What differs is only how WebGL2 spells it:
 *
 * - The per-draw uniforms and per-instance transforms are the very buffers the
 *   WebGPU path fills (`writeInstanceUniform`, `writeInstanceTransform`): the
 *   WGSL layouts are std140, so they bind as uniform blocks unchanged. A block
 *   holds 64 instances (16 KB is WebGL2's guaranteed block size), so a larger
 *   batch goes out as several instanced draws.
 * - The shadow map, SSAO buffer and environment map are read with `texelFetch`
 *   (nearest, like `textureLoad`); the material maps through one sampler whose
 *   filter follows the era.
 * - WebGL's window origin is bottom-left, so the vertex stage flips Y: the
 *   framebuffer then holds the image top row first — what `readPixels` returns
 *   and what the SSAO lookup by `gl_FragCoord` expects — with no CPU flip.
 * - The readback is a pixel-pack buffer guarded by a fence, polled at the start
 *   of each frame, so `readPixels` never stalls the run loop.
 * - The projection is GL's own clip convention, so near-plane clipping matches
 *   the software rasteriser's.
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
  type LightClusters,
  type MeshAsset,
  type MeshSceneInstance,
  type RasterStyle,
  type ReflectionProbeSet,
} from "@cartbox/editor";

import { batchInstances, compositeFrame, presentFrame, softEdges, type PrimitiveTextures } from "./gpuFrame.js";
import { WebglPassTimer } from "./gpuTimer.js";
import type { RenderStats } from "../debug/profiler.js";
import { webgpuCanHonour } from "./renderCaps.js";
import { SoftwareSceneRenderer, applyScenePasses, type FrameState, type SceneDraw, type SceneRenderer } from "./sceneRenderer.js";
import {
  INSTANCE_FLOATS,
  LIGHT_FLOATS,
  UNIFORM_BYTES_USED,
  UNIFORM_FLOATS,
  UNIFORM_STRIDE,
  interleaveVertices,
  normalBasis3x3,
  packLights,
  packProbes,
  resolveSurface,
  VERTEX_FLOATS,
  PROBE_FLOATS,
  resolveLight,
  resolvePbr,
  viewDirection,
  writeInstanceTransform,
  writeInstanceUniform,
} from "./scenePacking.js";

/** Instances per uniform block (and so per draw call): 64 × 240 bytes fits WebGL2's guaranteed 16 KB. */
export const WEBGL_INSTANCES_PER_DRAW = 64;
/** Modern-tier lights the shader loops over at most. */
export const WEBGL_MAX_LIGHTS = 128;
const READBACK_BUFFERS = 3;

// Texture units: the material maps, then the frame-wide buffers.
const UNIT_BASE = 0;
const UNIT_MR = 1;
const UNIT_OCC = 2;
const UNIT_EMIS = 3;
const UNIT_SHADOW = 4;
const UNIT_ENV = 5;
const UNIT_SSAO = 6;
const UNIT_LM = 7;
const UNIT_PROBES = 8;
const UNIT_DETAIL = 9;
const UNIT_BLEND = 10;
/** The opaque pass's depth, copied for soft see-through edges (EP6b). */
const UNIT_SCENE_DEPTH = 11;
/** The clustered lights' cell table and index list (EP8). */
const UNIT_CLUSTER_TABLE = 12;
const UNIT_CLUSTER_INDEX = 13;

const BLOCK_UNIFORMS = 0;
const BLOCK_INSTANCES = 1;
const BLOCK_LIGHTS = 2;

const UNIFORM_BLOCK = /* glsl */ `
layout(std140) uniform Uniforms {
  mat4 mvp;
  mat3 nrm;
  vec4 base;
  vec4 light;
  vec4 view;
  vec4 pbr;
  vec4 emissive;
  vec4 texflags;
  vec4 envSky;
  vec4 envHorizon;
  vec4 envGround;
  mat4 lightMvp;
  vec4 shadow;
  vec4 envMeta;
  vec4 tonemap;
  vec4 ssaoMeta;
  mat4 model;
  vec4 fog;
  vec4 fogParams;
  vec4 shadow2;
  vec4 surface0;
  vec4 surface1;
  vec4 surface2;
  vec4 surface3;
  vec4 fogCam;
  vec4 fogHeight;
  vec4 fogGlow;
  vec4 fogVol[8];
  vec4 effect0; // rgb = surface effect glow, w = camo amount
  vec4 effect1; // rgb = surface effect bands, w = time
} u;
`;

const VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${UNIFORM_BLOCK}
struct InstanceXf {
  mat4 mvp;
  mat4 lightMvp;
  mat4 model;
  mat3 nrm;
};
layout(std140) uniform Instances {
  InstanceXf xf[${WEBGL_INSTANCES_PER_DRAW}];
};
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
layout(location = 2) in vec2 uv;
layout(location = 3) in vec2 uv2;
layout(location = 4) in float bw;
out float vBw;
out vec3 vNormal;
out vec2 vUv;
out vec2 vUv2;
out vec4 vLightClip;
out vec3 vWorldPos;
out float vEyeDepth;
void main() {
  InstanceXf t = xf[gl_InstanceID];
  vec4 p = t.mvp * vec4(position, 1.0);
  vNormal = t.nrm * normal;
  vUv = uv;
  vUv2 = uv2;
  vBw = bw;
  vLightClip = t.lightMvp * vec4(position, 1.0);
  vWorldPos = (t.model * vec4(position, 1.0)).xyz;
  vEyeDepth = p.w;
  // Flip Y so the framebuffer's first row is the image's top row (see the file comment).
  gl_Position = vec4(p.x, -p.y, p.z, p.w);
}
`;

/**
 * A material graph's code (EP7) at its three sites in the fragment shader —
 * mirroring graphSites in WebgpuSceneRenderer.ts. Empty for the plain shader.
 */
function graphSites(graph: CompiledGraph | null): { fns: string; base: string; pbr: string; emis: string } {
  if (!graph) return { fns: "", base: "", pbr: "", emis: "" };
  const out = graph.outputs;
  const code = graphShaderCode(graph, "glsl", {
    uv: "vUv",
    position: "vWorldPos",
    normal: "gN",
    view: "u.view.xyz",
    time: "u.effect1.w",
    baseColor: "colour.rgb",
    baseAlpha: "colour.a",
    sample: (p) => `sampleMap(tex, vec2((${p}).x, 1.0 - (${p}).y))`,
  });
  const set = [
    out.baseColor !== undefined ? `colour = vec4(g${out.baseColor}, colour.a);` : "",
    out.alpha !== undefined ? `colour.a = clamp(g${out.alpha}.x, 0.0, 1.0);` : "",
    out.metallic !== undefined ? `gMetal = clamp(g${out.metallic}.x, 0.0, 1.0);` : "",
    out.roughness !== undefined ? `gRough = g${out.roughness}.x;` : "",
    out.emissive !== undefined ? `gEmis = max(g${out.emissive}, vec3(0.0));` : "",
  ].filter(Boolean);
  return {
    fns: graphUsesNoise(graph) ? graphNoiseSource("glsl") : "",
    base: `  // The material graph (EP7).
  float gMetal = -1.0;
  float gRough = -1.0;
  vec3 gEmis = vec3(-1.0);
  {
    vec3 gN = normalize(vNormal);
    if (dot(gN, u.view.xyz) < 0.0) { gN = -gN; }
${code.split("\n").map((l) => `    ${l}`).join("\n")}
${set.map((l) => `    ${l}`).join("\n")}
  }`,
    pbr: `    if (gMetal >= 0.0) { metallic = gMetal; }
    if (gRough >= 0.0) { rough = gRough; }`,
    emis: `    if (gEmis.x >= 0.0) { emis = gEmis; }`,
  };
}

const fragmentShader = (nearest: boolean, graph: CompiledGraph | null = null) => {
  const g = graphSites(graph);
  return /* glsl */ `#version 300 es
precision highp float;
precision highp int;
#define NEAREST ${nearest ? 1 : 0}
${UNIFORM_BLOCK}
struct Light {
  vec4 d0;
  vec4 d1;
  vec4 d2;
  vec4 d3;
};
// Clustered lights (EP8): per cell (offset, count) in an RG32UI table
// (x = tile, y = slice), the indices in an R32UI list 1024 wide; params = tile
// size (px), near plane, slice scale; info.x = global lights, info.y = 1 when cells are built.
uniform highp usampler2D clusterTable;
uniform highp usampler2D clusterIndex;
uniform vec4 clusterParams;
uniform vec4 clusterInfo;
layout(std140) uniform Lights {
  Light lights[${WEBGL_MAX_LIGHTS}];
};
uniform sampler2D tex;
uniform sampler2D mrTex;
uniform sampler2D occTex;
uniform sampler2D emisTex;
uniform highp sampler2D shadowMap;
uniform sampler2D envMap;
uniform highp sampler2D ssaoMap;
uniform sampler2D lmTex;
// Reflection probes (probeSampling.ts in @cartbox/editor): the panorama atlas
// and, per probe, box min / box max / capture point / mean colour; u.ssaoMeta.w
// counts them.
uniform sampler2D probeAtlas;
uniform sampler2D detailTex;
uniform sampler2D blendTex;
uniform highp sampler2D sceneDepth;
uniform vec4 probeData[${MAX_REFLECTION_PROBES * 4}];
in vec3 vNormal;
in vec2 vUv;
in vec2 vUv2;
in float vBw;
in vec4 vLightClip;
in vec3 vWorldPos;
in float vEyeDepth;
out vec4 outColor;

// Optical depth of a fog layer thinning above base (fogLayerDepth in skyDome.ts).
float fogLayer(float d, float k, float base, float cy, float dy, float len, float t0, float t1) {
  if (d <= 0.0 || t1 <= t0) return 0.0;
  float ya = cy + dy * t0 - base;
  float yb = cy + dy * t1 - base;
  float y0 = min(ya, yb);
  float y1 = max(ya, yb);
  float span = d * len * (t1 - t0);
  float h = y1 - y0;
  if (h < 1e-5) return span * exp(-k * max(0.0, y0));
  float tau = 0.0;
  if (y0 < 0.0) tau += span * (min(y1, 0.0) - y0) / h;
  if (y1 > 0.0) {
    float lo = max(y0, 0.0);
    float above = y1 - lo;
    if (k * above < 1e-4) tau += span * above * exp(-k * lo) / h;
    else tau += span * (exp(-k * lo) - exp(-k * y1)) / (k * h);
  }
  return tau;
}

// Where the segment c -> c + dir*t (t in [0, 1]) is inside a box (fogBoxSpan).
vec2 fogBox(vec3 mn, vec3 mx, vec3 c, vec3 dir) {
  float t0 = 0.0;
  float t1 = 1.0;
  for (int a = 0; a < 3; a++) {
    if (abs(dir[a]) < 1e-9) {
      if (c[a] < mn[a] || c[a] > mx[a]) return vec2(1.0, 0.0);
    } else {
      float ta = (mn[a] - c[a]) / dir[a];
      float tb = (mx[a] - c[a]) / dir[a];
      t0 = max(t0, min(ta, tb));
      t1 = min(t1, max(ta, tb));
    }
  }
  return vec2(t0, t1);
}

// A material map at uv (already V-flipped). An era without filtering picks the
// texel exactly as the software rasteriser does — floor(wrap(u) · size) —
// rather than trusting a driver's subtexel precision at texel boundaries.
vec4 sampleMap(sampler2D s, vec2 uv) {
#if NEAREST
  ivec2 size = textureSize(s, 0);
  vec2 f = (uv - floor(uv)) * vec2(size);
  return texelFetch(s, min(size - 1, ivec2(floor(f))), 0);
#else
  return texture(s, uv);
#endif
}

float shadowTap(float fx, float fy, float z) {
  float size = u.shadow.y;
  int tx = int(clamp(floor(fx), 0.0, size - 1.0));
  int ty = int(clamp(floor(fy), 0.0, size - 1.0));
  float stored = texelFetch(shadowMap, ivec2(tx, ty), 0).r;
  if (z > stored) { return 0.0; }
  return 1.0;
}
float shadowFactor(vec4 lightClip, float cosL) {
  if (u.shadow.x < 0.5) { return 1.0; }
  vec3 ndc = lightClip.xyz / lightClip.w;
  if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0 || ndc.z < -1.0 || ndc.z > 1.0) {
    return 1.0;
  }
  float size = u.shadow.y;
  float sx = (ndc.x * 0.5 + 0.5) * size;
  float sy = (1.0 - (ndc.y * 0.5 + 0.5)) * size;
  float bias = u.shadow.z;
  if (u.shadow2.x > 0.0) {
    float c = clamp(cosL, 0.05, 1.0);
    bias = bias + u.shadow2.x * min(10.0, sqrt(1.0 - c * c) / c);
  }
  float z = ndc.z - bias;
  if (u.shadow2.y < 0.5) {
    if (shadowTap(sx, sy, z) < 0.5) { return 1.0 - u.shadow.w; }
    return 1.0;
  }
  float lit = (shadowTap(sx - 0.5, sy - 0.5, z) + shadowTap(sx + 0.5, sy - 0.5, z)
             + shadowTap(sx - 0.5, sy + 0.5, z) + shadowTap(sx + 0.5, sy + 0.5, z)) * 0.25;
  return 1.0 - u.shadow.w * (1.0 - lit);
}
vec3 envGradient(float y) {
  float t = clamp(y, -1.0, 1.0);
  vec3 c;
  if (t >= 0.0) { c = mix(u.envHorizon.xyz, u.envSky.xyz, t); }
  else { c = mix(u.envHorizon.xyz, u.envGround.xyz, -t); }
  return c * u.envHorizon.w;
}
vec3 envColorDir(vec3 dir) {
  if (u.envMeta.w < 0.5) { return envGradient(dir.y); }
  vec3 d = normalize(dir);
  float uCoord = atan(d.z, d.x) / (2.0 * 3.14159265) + 0.5;
  float vCoord = acos(clamp(d.y, -1.0, 1.0)) / 3.14159265;
  vec2 dims = vec2(textureSize(envMap, 0));
  float wx = uCoord - floor(uCoord);
  int tx = int(clamp(floor(wx * dims.x), 0.0, dims.x - 1.0));
  int ty = int(clamp(floor(vCoord * dims.y), 0.0, dims.y - 1.0));
  return texelFetch(envMap, ivec2(tx, ty), 0).rgb * u.envHorizon.w;
}
vec3 probeSample(int i, vec3 dir) {
  vec3 d = normalize(dir);
  float uCoord = atan(d.z, d.x) / (2.0 * 3.14159265) + 0.5;
  float vCoord = acos(clamp(d.y, -1.0, 1.0)) / 3.14159265;
  vec2 dims = vec2(textureSize(probeAtlas, 0));
  float h = floor(dims.x * 0.5);
  int tx = int(clamp(floor((uCoord - floor(uCoord)) * dims.x), 0.0, dims.x - 1.0));
  int ty = int(clamp(floor(vCoord * h), 0.0, h - 1.0) + float(i) * h);
  return texelFetch(probeAtlas, ivec2(tx, ty), 0).rgb * ${PROBE_RANGE.toFixed(4)};
}
// The 2×2 ordered-dither matrix [[0, 2], [3, 1]], and the crawling camo threshold
// (surfaceEffect.ts). gl_FragCoord rows run top-first here (the vertex stage flips Y).
float bayer2(int x, int y) {
  if ((y & 1) == 1) { return (x & 1) == 1 ? 1.0 : 3.0; }
  return (x & 1) == 1 ? 2.0 : 0.0;
}
float camoThreshold(vec2 p, float time) {
  int s = int(floor(time * ${EFFECT_CAMO_CRAWL.toFixed(1)}));
  int px = int(floor(p.x)) + s;
  int py = int(floor(p.y)) + s * 3;
  return (4.0 * bayer2(px, py) + bayer2(px >> 1, py >> 1) + 0.5) / 16.0;
}
// What reaches the framebuffer (EP6): opaque and cut-out surfaces cover the
// pixel (alpha 1); a blended one leaves premultiplied colour and its coverage;
// an added one leaves its light and no coverage (see compositeFrame).
vec4 finishAlpha(vec3 rgb, float a) {
  vec3 c = clamp(rgb, vec3(0.0), vec3(1.0));
  if (u.pbr.w > 2.5) { return vec4(c * a, 0.0); }
  if (u.pbr.w > 1.5) { return vec4(c * a, a); }
  return vec4(c, 1.0);
}
vec3 envAverage() {
  if (u.envMeta.w > 0.5) { return u.envMeta.xyz * u.envHorizon.w; }
  return (u.envSky.xyz + u.envHorizon.xyz + u.envGround.xyz) / 3.0 * u.envHorizon.w;
}
float aces(float x) {
  float v = max(0.0, x);
  return clamp((v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14), 0.0, 1.0);
}

// One light's direct term (Cook-Torrance), mirroring the software rasteriser's
// light loop: point and spot lights fall off to nothing at their range, a spot
// fades across its cone, and directional lights honour the sun shadow (sf).
vec3 lightTerm(Light lgt, vec3 P, vec3 N, vec3 V, float ndv, float a2, float k, vec3 f0, float kdm, vec3 albedo, float sf) {
  vec3 Ld;
  float atten = 1.0;
  if (lgt.d0.w > 0.5) {
    vec3 toL = lgt.d0.xyz - P;
    float dist = max(length(toL), 1e-4);
    Ld = toL / dist;
    float range = lgt.d2.x;
    if (range > 0.0) { float t = max(0.0, 1.0 - dist / range); atten = t * t; }
    if (lgt.d0.w > 1.5) {
      float ct = clamp((-dot(Ld, lgt.d3.xyz) - lgt.d2.y) / (lgt.d2.z - lgt.d2.y), 0.0, 1.0);
      atten = atten * ct * ct * (3.0 - 2.0 * ct);
    }
  } else {
    Ld = normalize(lgt.d0.xyz);
  }
  float ndlL = max(0.0, dot(N, Ld));
  if (ndlL <= 0.0 || atten <= 0.0) { return vec3(0.0); }
  vec3 Hl = normalize(Ld + V);
  float ndhL = max(0.0, dot(N, Hl));
  float vdhL = max(0.0, dot(V, Hl));
  float ddL = ndhL * ndhL * (a2 - 1.0) + 1.0;
  float DL = a2 / (3.14159265 * ddL * ddL + 1e-7);
  float GL = (ndv / (ndv * (1.0 - k) + k)) * (ndlL / (ndlL * (1.0 - k) + k));
  float fpL = pow(1.0 - vdhL, 5.0);
  float specL = (DL * GL) / (4.0 * ndlL * ndv + 1e-4);
  vec3 FL = f0 + (vec3(1.0) - f0) * fpL;
  float occl = 1.0;
  if (lgt.d0.w < 0.5) { occl = sf; }
  float w = lgt.d1.w * atten * ndlL * occl;
  return (kdm * (vec3(1.0) - FL) * albedo + FL * specL) * lgt.d1.rgb * w;
}
${g.fns}
void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec4 colour = u.base;
  if (u.texflags.x > 0.5) {
    colour = colour * sampleMap(tex, uv);
  }
${g.base}
  // Soft edges (EP6b): a see-through surface fades out as it meets the opaque
  // scene behind it — both depths read back as view distance (shadow2.zw).
  if (u.tonemap.z > 0.0) {
    float behind = texelFetch(sceneDepth, ivec2(gl_FragCoord.xy), 0).r * 2.0 - 1.0;
    float own = gl_FragCoord.z * 2.0 - 1.0;
    colour.a *= clamp((u.shadow2.w / (behind + u.shadow2.z) - u.shadow2.w / (own + u.shadow2.z)) / u.tonemap.z, 0.0, 1.0);
  }
  if (colour.a * 255.0 < 1.0) { discard; }
  // A cut-out surface (EP6) drops what's below its threshold.
  if (u.pbr.w > 0.5 && u.pbr.w < 1.5 && colour.a < u.view.w) { discard; }

  if (u.pbr.z > 0.5) {
    // Active Camo (H11): screen-door transparency, as the rasteriser drops pixels.
    if (u.effect0.w > 0.0 && camoThreshold(gl_FragCoord.xy, u.effect1.w) < u.effect0.w) { discard; }
    vec3 N = normalize(vNormal);
    if (dot(N, u.view.xyz) < 0.0) { N = -N; }
    float metallic = u.pbr.x;
    float rough = u.pbr.y;
    float reflectK = u.surface0.z;
    if (u.texflags.y > 0.5) {
      vec4 mr = sampleMap(mrTex, uv);
      rough = rough * mr.g;
      metallic = metallic * mr.b;
      if (u.surface0.w > 0.5) { reflectK = reflectK * mr.a; }
    }
    if (u.surface1.z > 0.5 && u.surface3.w >= 0.0) { rough = mix(rough, u.surface3.w, vBw); }
${g.pbr}
    rough = clamp(rough, 0.045, 1.0);
    float ao = 1.0;
    if (u.texflags.z > 0.5) { ao = sampleMap(occTex, uv).r; }
    vec3 albedo = colour.rgb;
    if (u.surface1.z > 0.5) {
      vec3 bc = u.surface3.rgb;
      if (u.surface1.w > 0.5) { bc = bc * sampleMap(blendTex, uv).rgb; }
      albedo = mix(albedo, bc, vBw);
    }
    float dk = u.surface0.y * clamp((${DETAIL_FAR.toFixed(4)} - vEyeDepth) / ${(DETAIL_FAR - DETAIL_NEAR).toFixed(4)}, 0.0, 1.0);
    if (dk > 0.0) {
      vec3 detail = sampleMap(detailTex, vec2(vUv.x * u.surface0.x, 1.0 - vUv.y * u.surface0.x)).rgb;
      albedo = albedo * (vec3(1.0) + dk * (2.0 * detail - vec3(1.0)));
    }
    vec3 L = u.light.xyz;
    vec3 V = u.view.xyz;
    vec3 H = normalize(L + V);
    float ndl = max(0.0, dot(N, L));
    float ndv = max(1e-4, dot(N, V));
    float ndh = max(0.0, dot(N, H));
    float vdh = max(0.0, dot(V, H));
    float a2 = rough * rough * rough * rough;
    float dd = ndh * ndh * (a2 - 1.0) + 1.0;
    float D = a2 / (3.14159265 * dd * dd + 1e-7);
    float k = ((rough + 1.0) * (rough + 1.0)) / 8.0;
    float G = (ndv / (ndv * (1.0 - k) + k)) * (ndl / (ndl * (1.0 - k) + k));
    float fp = pow(1.0 - vdh, 5.0);
    float specD = (D * G) / (4.0 * ndl * ndv + 1e-4);
    vec3 f0 = vec3(0.04) + (albedo - vec3(0.04)) * metallic;
    vec3 F = f0 + (vec3(1.0) - f0) * fp;
    float kdm = 1.0 - metallic;
    vec3 emis = vec3(0.0);
    vec3 ef = u.emissive.xyz;
    if (ef.r > 0.0 || ef.g > 0.0 || ef.b > 0.0) {
      vec3 es = vec3(1.0);
      if (u.texflags.w > 0.5) { es = sampleMap(emisTex, vec2(vUv.x + u.surface1.x, 1.0 - (vUv.y + u.surface1.y))).rgb; }
      emis = ef * es;
    }
${g.emis}
    vec3 amb;
    if (u.envSky.w > 0.5) {
      vec3 irr = envColorDir(N);
      vec3 R = 2.0 * ndv * N - V;
      vec3 spec = envColorDir(R);
      vec3 specAvg = envAverage();
      // Inside a reflection probe's box, reflect the room around it, box-projected
      // (mirrors the software path and the WGSL).
      int pc = int(u.ssaoMeta.w + 0.5);
      vec3 P = vWorldPos;
      for (int i = 0; i < pc; i++) {
        vec3 mn = probeData[i * 4].xyz;
        vec3 mx = probeData[i * 4 + 1].xyz;
        float inside = min(min(min(P.x - mn.x, mx.x - P.x), min(P.y - mn.y, mx.y - P.y)), min(P.z - mn.z, mx.z - P.z));
        float wgt = clamp(inside / ${PROBE_FADE.toFixed(4)}, 0.0, 1.0);
        if (wgt > 0.0) {
          vec3 Rs = mix(R, vec3(1e-6), lessThan(abs(R), vec3(1e-6)));
          vec3 tf = max((mx - P) / Rs, (mn - P) / Rs);
          float t = max(0.0, min(min(tf.x, tf.y), tf.z));
          spec = mix(spec, probeSample(i, P + R * t - probeData[i * 4 + 2].xyz), wgt);
          specAvg = mix(specAvg, probeData[i * 4 + 3].xyz, wgt);
          break;
        }
      }
      vec3 pref = mix(spec, specAvg, rough);
      amb = (irr * albedo * kdm + pref * f0 * reflectK) * ao;
    } else {
      amb = vec3(u.light.w) * albedo * ao;
    }
    // A baked light map (the second UV set) scales the sky/ambient fill,
    // mirroring the CPU path.
    if (u.ssaoMeta.z > 0.5) {
      amb = amb * texture(lmTex, vec2(vUv2.x, 1.0 - vUv2.y)).rgb * ${LIGHTMAP_RANGE.toFixed(4)};
    }
    if (u.ssaoMeta.x > 0.5) {
      amb = amb * texelFetch(ssaoMap, ivec2(gl_FragCoord.xy), 0).r;
    }
    float sf = shadowFactor(vLightClip, abs(dot(normalize(vNormal), u.light.xyz)));
    int lc = int(u.ssaoMeta.y + 0.5);
    vec3 lit;
    if (lc > 0) {
      vec3 direct = vec3(0.0);
      // The global lights (the sun, unranged lights) reach every fragment…
      int ng = int(clusterInfo.x + 0.5);
      for (int i = 0; i < ${WEBGL_MAX_LIGHTS}; i = i + 1) {
        if (i >= ng) { break; }
        direct += lightTerm(lights[i], vWorldPos, N, V, ndv, a2, k, f0, kdm, albedo, sf);
      }
      // …the rest only the cells they touch (EP8): this fragment's cell, by pixel and depth.
      if (clusterInfo.y > 0.5 && vEyeDepth >= clusterParams.z) {
        ivec2 tile = min(ivec2(gl_FragCoord.xy / clusterParams.xy), ivec2(${CLUSTER_X - 1}, ${CLUSTER_Y - 1}));
        int slice = min(int(log(vEyeDepth / clusterParams.z) * clusterParams.w), ${CLUSTER_Z - 1});
        uvec2 cell = texelFetch(clusterTable, ivec2(tile.y * ${CLUSTER_X} + tile.x, slice), 0).xy;
        for (uint j = 0u; j < cell.y; j++) {
          uint n = cell.x + j;
          int li = int(texelFetch(clusterIndex, ivec2(int(n % 1024u), int(n / 1024u)), 0).x);
          direct += lightTerm(lights[li], vWorldPos, N, V, ndv, a2, k, f0, kdm, albedo, sf);
        }
      }
      lit = direct + amb + emis;
    } else {
      lit = (kdm * (vec3(1.0) - F) * albedo + F * specD) * ndl * sf + amb + emis;
    }
    lit = lit + u.surface2.rgb * pow(1.0 - ndv, u.surface2.w);
    // A surface effect's glow, and its bands climbing the body (zero without one).
    float band = pow(0.5 + 0.5 * sin(vWorldPos.y * ${EFFECT_BAND_FREQUENCY.toFixed(1)} - u.effect1.w * ${EFFECT_BAND_SPEED.toFixed(1)}), ${EFFECT_BAND_POWER.toFixed(1)});
    lit = lit + u.effect0.rgb + u.effect1.rgb * band;
    vec3 shaded = lit;
    if (u.tonemap.x > 0.5) {
      float e = u.tonemap.y;
      shaded = vec3(aces(lit.r * e), aces(lit.g * e), aces(lit.b * e));
    }
    if (u.fogParams.x > 0.5) {
      float d = max(0.0, vEyeDepth - u.fogParams.y);
      float f = min(u.fogParams.z, 1.0 - exp(-d * u.fog.w));
      vec3 fc = u.fog.rgb;
      if (u.fogParams.w > 0.5) {
        vec3 c = u.fogCam.xyz;
        vec3 ray = vWorldPos - c;
        float len = length(ray);
        float tau = fogLayer(u.fogHeight.x, u.fogHeight.z, u.fogHeight.y, c.y, ray.y, len, 0.0, 1.0);
        int vc = int(u.fogCam.w + 0.5);
        for (int i = 0; i < 4; i++) {
          if (i >= vc) break;
          vec4 a = u.fogVol[i * 2];
          vec4 b = u.fogVol[i * 2 + 1];
          vec2 span = fogBox(a.xyz, b.xyz, c, ray);
          if (span.y > span.x) tau += fogLayer(a.w, b.w, a.y, c.y, ray.y, len, span.x, span.y);
        }
        f = 1.0 - (1.0 - f) * exp(-tau);
        if (u.fogHeight.w > 0.0) {
          float cosv = max(0.0, dot(ray, u.light.xyz) / (max(len, 1e-6) * max(length(u.light.xyz), 1e-6)));
          fc = min(vec3(1.0), fc + u.fogGlow.rgb * (u.fogHeight.w * pow(cosv, ${FOG_GLOW_POWER.toFixed(1)})));
        }
      }
      shaded = mix(clamp(shaded, vec3(0.0), vec3(1.0)), fc, f);
    }
    outColor = finishAlpha(shaded, colour.a);
    return;
  }

  // Fantasy path: two-sided Lambert on the un-renormalised normal, as the software rasteriser does.
  float nl = abs(dot(vNormal, u.light.xyz));
  float shade = u.light.w + (1.0 - u.light.w) * nl * shadowFactor(vLightClip, abs(dot(normalize(vNormal), u.light.xyz)));
  outColor = finishAlpha(colour.rgb * shade, colour.a);
}
`;
};

interface GlPrimitive {
  vao: any;
  vertexBuffer: any;
  indexBuffer: any;
  indexCount: number;
  revision?: number;
}

interface ReadbackSlot {
  buffer: any;
  fence: any;
  /** Which submitted frame it holds. */
  seq: number;
}

/**
 * Compile and link the scene program — plain, or with a material graph spliced
 * into its fragment shader (EP7) — with its blocks and texture units bound.
 */
function buildProgram(gl: any, nearest: boolean, graph: CompiledGraph | null): any {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentShader(nearest, graph)));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`WebGL2 program failed to link: ${gl.getProgramInfoLog(program)}`);
  gl.uniformBlockBinding(program, gl.getUniformBlockIndex(program, "Uniforms"), BLOCK_UNIFORMS);
  gl.uniformBlockBinding(program, gl.getUniformBlockIndex(program, "Instances"), BLOCK_INSTANCES);
  gl.uniformBlockBinding(program, gl.getUniformBlockIndex(program, "Lights"), BLOCK_LIGHTS);
  gl.useProgram(program);
  const units: [string, number][] = [
    ["tex", UNIT_BASE],
    ["mrTex", UNIT_MR],
    ["occTex", UNIT_OCC],
    ["emisTex", UNIT_EMIS],
    ["shadowMap", UNIT_SHADOW],
    ["envMap", UNIT_ENV],
    ["ssaoMap", UNIT_SSAO],
    ["lmTex", UNIT_LM],
    ["probeAtlas", UNIT_PROBES],
    ["detailTex", UNIT_DETAIL],
    ["blendTex", UNIT_BLEND],
    ["sceneDepth", UNIT_SCENE_DEPTH],
    ["clusterTable", UNIT_CLUSTER_TABLE],
    ["clusterIndex", UNIT_CLUSTER_INDEX],
  ];
  for (const [name, unit] of units) gl.uniform1i(gl.getUniformLocation(program, name), unit);
  return program;
}

/** Makes the WebGL2 context the renderer draws with (injectable for tests); null when there is none. */
export type GlContextProvider = () => any | null;

function defaultContext(): any | null {
  try {
    const options = { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false };
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(1, 1).getContext("webgl2", options);
    if (typeof document !== "undefined") return document.createElement("canvas").getContext("webgl2", options);
  } catch {
    // No WebGL2 here.
  }
  return null;
}

function compile(gl: any, type: number, source: string): any {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`WebGL2 shader failed to compile: ${log}`);
  }
  return shader;
}

export class WebglSceneRenderer implements SceneRenderer {
  readonly backend = "webgl2" as const;

  private readonly software: SoftwareSceneRenderer;
  private readonly meshes = new WeakMap<MeshAsset, GlPrimitive[]>();
  private readonly textures = new WeakMap<DecodedTexture, any>();
  private latest: Uint8Array | null = null;
  private destroyed = false;
  /** The context was lost: the software rasteriser draws from here on. */
  private lost = false;

  private uniformBuffer: any;
  private uniformCapacity = 0;
  private uniformData = new Float32Array(0);
  private instanceBuffer: any;
  private instanceFloats = 0;
  private instanceData = new Float32Array(0);
  private readonly lightBuffer: any;

  private shadowTexture: any = null;
  private shadowSize = 0;
  private shadowUploaded: Float32Array | null = null;
  private envTexture: any = null;
  private envSource: DecodedTexture | null = null;
  private probeTexture: any = null;
  private probeSource: DecodedTexture | null = null;
  private probeData = new Float32Array(MAX_REFLECTION_PROBES * PROBE_FLOATS);
  private ssaoTexture: any = null;

  private readonly readback: ReadbackSlot[];
  /** Readbacks in flight, oldest first. */
  private readonly pending: ReadbackSlot[] = [];
  /** Frames submitted, the one `latest` holds, and the newest that got a readback (see settle). */
  private submitted = 0;
  private latestSeq = 0;
  private readSeq = 0;

  /** What the last submitted frame drew (for the profiler and tests); GPU time when the browser can time it. */
  lastFrameStats: RenderStats = { drawCalls: 0, instances: 0, triangles: 0, gpuMs: null };
  private readonly timer: WebglPassTimer | null;
  /** Whether the era samples nearest (it shapes every program variant). */
  private readonly nearest: boolean;

  private constructor(
    private readonly gl: any,
    private readonly width: number,
    private readonly height: number,
    private readonly program: any,
    private readonly framebuffer: any,
    private readonly attachments: any[],
    private readonly sampler: any,
    private readonly blankTexture: any,
    private readonly blankFloat: any,
    /** Floats between instance-block starts (the block offset alignment, in floats). */
    private readonly instanceAlignFloats: number,
    style: RasterStyle,
  ) {
    this.software = new SoftwareSceneRenderer(style);
    this.nearest = style.textureFiltering === "none";
    this.uniformBuffer = gl.createBuffer();
    this.instanceBuffer = gl.createBuffer();
    this.lightBuffer = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.lightBuffer);
    gl.bufferData(gl.UNIFORM_BUFFER, WEBGL_MAX_LIGHTS * LIGHT_FLOATS * 4, gl.DYNAMIC_DRAW);
    this.readback = Array.from({ length: READBACK_BUFFERS }, () => {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, width * height * 4, gl.STREAM_READ);
      return { buffer, fence: null, seq: 0 };
    });
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.timer = WebglPassTimer.create(gl);
  }

  /**
   * Build the renderer for one framebuffer size, or null when WebGL2 is missing,
   * the era's style needs the software rasteriser, or anything fails to build.
   */
  static create(width: number, height: number, style: RasterStyle = DEFAULT_RASTER_STYLE, contextProvider: GlContextProvider = defaultContext): WebglSceneRenderer | null {
    // The same eligibility as WebGPU: a style only the software path reproduces stays there.
    if (!webgpuCanHonour(style)) return null;
    const gl = contextProvider();
    if (!gl) return null;
    try {
      const align = gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT) as number;
      // Draw uniforms sit at a 768-byte stride; an alignment that doesn't divide it can't address them.
      if (!(align > 0) || UNIFORM_STRIDE % align !== 0) return null;
      if ((gl.getParameter(gl.MAX_UNIFORM_BLOCK_SIZE) as number) < WEBGL_INSTANCES_PER_DRAW * INSTANCE_FLOATS * 4) return null;

      const program = buildProgram(gl, style.textureFiltering === "none", null);

      const colour = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, colour);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
      const depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colour);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("WebGL2 framebuffer incomplete");

      // The era decides filtering, as for WebGPU's sampler: nearest for machines that couldn't filter.
      const filter = style.textureFiltering === "none" ? gl.NEAREST : gl.LINEAR;
      const sampler = gl.createSampler();
      gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, filter);
      gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, filter);
      gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, gl.REPEAT);

      const blankTexture = createTexture(gl, 1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
      const blankFloat = createTexture(gl, 1, 1, gl.R32F, gl.RED, gl.FLOAT, new Float32Array([0]));

      gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return new WebglSceneRenderer(gl, width, height, program, framebuffer, [colour, depth], sampler, blankTexture, blankFloat, Math.max(4, align / 4), style);
    } catch {
      return null;
    }
  }

  render(instances: readonly MeshSceneInstance[], draw: SceneDraw): void {
    if (this.destroyed) return;
    const visible = applyScenePasses(instances, draw);
    if (this.lost) {
      this.software.render(visible, draw);
      return;
    }
    this.collect();
    presentFrame(this.latest, visible, draw, this.software);
    try {
      this.submit(visible, draw);
    } catch {
      // A lost context or an unbuildable buffer must not take the cart down.
      this.latest = null;
      if (this.gl.isContextLost?.()) this.lost = true;
    }
  }

  /** Take the newest finished readback, if any (never waits). */
  private collect(): void {
    const gl = this.gl;
    while (this.pending.length > 0) {
      const slot = this.pending[0]!;
      const status = gl.clientWaitSync(slot.fence, 0, 0);
      if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) break;
      this.pending.shift();
      gl.deleteSync(slot.fence);
      slot.fence = null;
      const bytes = this.latest && this.latest.length === this.width * this.height * 4 ? this.latest : new Uint8Array(this.width * this.height * 4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, bytes);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.latest = bytes;
      this.latestSeq = slot.seq;
    }
  }

  /** Whether a finished GPU frame exists to show (false until the first readback lands). */
  get ready(): boolean {
    return this.latest !== null;
  }

  settle(draw: SceneDraw): FrameState {
    if (this.destroyed || this.lost) return "current";
    this.collect();
    if (this.latest) compositeFrame(this.latest, draw);
    if (this.latestSeq >= this.submitted) return "current";
    return this.readSeq >= this.submitted ? "pending" : "stale";
  }

  private submit(instances: readonly MeshSceneInstance[], draw: SceneDraw): void {
    const gl = this.gl;
    const viewProj = multiplyMat4(draw.projection, draw.view);
    const { batches, instanceCount } = batchInstances(instances, (mesh) => this.uploadMesh(mesh), cameraPositionFromView(draw.view));
    if (batches.length === 0) return;

    // Chunks of at most one block's worth of instances, each starting at an aligned offset.
    const chunks: { batch: number; start: number; count: number; offsetFloats: number }[] = [];
    let cursor = 0;
    batches.forEach((batch, index) => {
      for (let start = 0; start < batch.models.length; start += WEBGL_INSTANCES_PER_DRAW) {
        const count = Math.min(WEBGL_INSTANCES_PER_DRAW, batch.models.length - start);
        chunks.push({ batch: index, start, count, offsetFloats: cursor });
        cursor += Math.ceil((count * INSTANCE_FLOATS) / this.instanceAlignFloats) * this.instanceAlignFloats;
      }
    });
    // The block is declared with a full 64 instances, so the buffer must reach that far past the last start.
    this.ensureCapacity(batches.length, cursor + WEBGL_INSTANCES_PER_DRAW * INSTANCE_FLOATS);

    const light = resolveLight(draw.lightDirection, draw.ambient);
    const viewDir = viewDirection(draw.view);
    const eye = cameraPositionFromView(draw.view);
    const shadow = draw.shadow ?? null;
    this.uploadShadow(shadow);
    const shadowParams = shadow
      ? { size: shadow.size, bias: shadow.bias ?? 0.003, strength: shadow.strength ?? 1, slopeBias: shadow.slopeBias ?? 0, pcf: shadow.pcf ?? false }
      : null;
    this.uploadEnv(draw.environment?.map ?? null);
    this.uploadProbes(draw.environment?.probes ?? null);
    const ssao = draw.ssao ?? null;
    this.uploadSsao(ssao);
    // Lights packed global-first (the block holds WEBGL_MAX_LIGHTS), the rest
    // sorted into the view's cells (EP8) so each fragment shades only its own.
    const order = orderLights(draw.lights ?? []);
    const sceneLights = order.ordered.slice(0, WEBGL_MAX_LIGHTS);
    const globalCount = Math.min(order.globalCount, sceneLights.length);
    const clusters = sceneLights.length > globalCount ? buildLightClusters(sceneLights, globalCount, draw.view, draw.projection, this.width, this.height) : null;
    this.uploadClusters(clusters);
    this.clusterParams.set(clusters?.params ?? [1, 1, 1, 1]);
    this.clusterInfo[0] = clusters ? globalCount : sceneLights.length;
    this.clusterInfo[1] = clusters ? 1 : 0;
    const packed = packLights(sceneLights);
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.lightBuffer);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, packed);

    batches.forEach((batch, index) => {
      const model = batch.models[0]!;
      writeInstanceUniform(this.uniformData, index, {
        mvp: multiplyMat4(viewProj, model),
        normalBasis: normalBasis3x3(model),
        baseColor: batch.primitive.material.baseColorFactor,
        hasTexture: batch.textures.base !== null,
        light,
        viewDir,
        pbr: resolvePbr(batch.primitive.material, batch.textures.mr !== null, batch.textures.occ !== null, batch.textures.emis !== null),
        hasMrMap: batch.textures.mr !== null,
        hasOcclusionMap: batch.textures.occ !== null,
        hasEmissiveMap: batch.textures.emis !== null,
        environment: draw.environment ?? null,
        lightMvp: shadow ? multiplyMat4(shadow.lightViewProj, model) : null,
        shadow: shadowParams,
        tonemap: draw.tonemap ?? null,
        hasSsao: ssao !== null,
        hasLightmap: batch.textures.lm !== null,
        model,
        lightCount: sceneLights.length,
        fog: draw.fog ?? null,
        eye,
        effect: batch.effect ?? null,
        time: draw.time ?? 0,
        alpha: { mode: batch.alpha, cutoff: batch.primitive.material.alphaCutoff ?? 0.5 },
        soft: softEdges(batch.primitive.material, batch.alpha, draw.projection),
        surface: resolveSurface(batch.primitive.material, draw.time ?? 0, batch.textures.detail !== null, batch.textures.mr !== null, {
          weights: batch.primitive.blend !== undefined,
          textured: batch.textures.blend !== null,
        }),
      });
    });
    for (const chunk of chunks) {
      const batch = batches[chunk.batch]!;
      for (let j = 0; j < chunk.count; j += 1) {
        const model = batch.models[chunk.start + j]!;
        writeInstanceTransform(
          this.instanceData,
          j,
          { mvp: multiplyMat4(viewProj, model), lightMvp: shadow ? multiplyMat4(shadow.lightViewProj, model) : null, model, normalBasis: normalBasis3x3(model) },
          chunk.offsetFloats + j * INSTANCE_FLOATS,
        );
      }
    }
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.uniformBuffer);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.uniformData, 0, batches.length * UNIFORM_FLOATS);
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.instanceBuffer);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.instanceData, 0, cursor);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.colorMask(true, true, true, true);
    // Transparent black: an untouched pixel reads as "nothing drawn", so the cart shows through.
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);
    let program = this.program;
    gl.bindBufferBase(gl.UNIFORM_BUFFER, BLOCK_LIGHTS, this.lightBuffer);
    this.bindTexture(UNIT_SHADOW, this.shadowTexture ?? this.blankFloat);
    this.bindTexture(UNIT_ENV, this.envTexture ?? this.blankTexture);
    this.bindTexture(UNIT_PROBES, this.probeTexture ?? this.blankTexture);
    this.frameUniforms(this.program);
    this.bindTexture(UNIT_SSAO, ssao ? this.ssaoTexture : this.blankFloat);
    for (let unit = UNIT_BASE; unit <= UNIT_EMIS; unit += 1) gl.bindSampler(unit, this.sampler);
    gl.bindSampler(UNIT_LM, this.sampler);
    gl.bindSampler(UNIT_DETAIL, this.sampler);
    gl.bindSampler(UNIT_BLEND, this.sampler);
    this.bindTexture(UNIT_SCENE_DEPTH, this.blankFloat);
    gl.bindSampler(UNIT_SCENE_DEPTH, null);
    // Soft edges read the opaque depth: copied once, as the see-through batches begin.
    const soft = batches.some((batch) => softEdges(batch.primitive.material, batch.alpha, draw.projection) !== undefined);
    let depthCopied = false;

    this.timer?.begin();
    let bound: PrimitiveTextures | null = null;
    let boundBatch = -1;
    // Transparency (EP6): opaque draws write depth with no blending; blended
    // ones blend premultiplied colour over what's there, added ones add, and
    // neither writes depth. Batches come opaque first, then see-through, farthest first.
    let blendState = -1;
    const setBlend = (alpha: number) => {
      const state = alpha >= 2 ? alpha : 0;
      if (state === blendState) return;
      blendState = state;
      if (state === 0) {
        gl.disable(gl.BLEND);
        gl.depthMask(true);
      } else {
        gl.enable(gl.BLEND);
        gl.depthMask(false);
        if (state === 2) gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        else gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
      }
    };
    let triangles = 0;
    for (const chunk of chunks) {
      const batch = batches[chunk.batch]!;
      // A material graph draws with its own program (EP7); the probe data is per program.
      const wanted = this.programOf(batch.primitive.material);
      if (wanted !== program) {
        program = wanted;
        gl.useProgram(program);
        this.frameUniforms(program);
      }
      if (soft && !depthCopied && batch.alpha >= 2) {
        this.copySceneDepth();
        depthCopied = true;
      }
      setBlend(batch.alpha);
      if (chunk.batch !== boundBatch) {
        gl.bindBufferRange(gl.UNIFORM_BUFFER, BLOCK_UNIFORMS, this.uniformBuffer, chunk.batch * UNIFORM_STRIDE, UNIFORM_BYTES_USED);
        if (bound !== batch.textures) {
          this.bindTexture(UNIT_BASE, this.textureFor(batch.textures.base));
          this.bindTexture(UNIT_MR, this.textureFor(batch.textures.mr));
          this.bindTexture(UNIT_OCC, this.textureFor(batch.textures.occ));
          this.bindTexture(UNIT_EMIS, this.textureFor(batch.textures.emis));
          this.bindTexture(UNIT_LM, this.textureFor(batch.textures.lm));
          this.bindTexture(UNIT_DETAIL, this.textureFor(batch.textures.detail));
          this.bindTexture(UNIT_BLEND, this.textureFor(batch.textures.blend));
          bound = batch.textures;
        }
        gl.bindVertexArray(batch.geometry.vao);
        boundBatch = chunk.batch;
      }
      gl.bindBufferRange(gl.UNIFORM_BUFFER, BLOCK_INSTANCES, this.instanceBuffer, chunk.offsetFloats * 4, WEBGL_INSTANCES_PER_DRAW * INSTANCE_FLOATS * 4);
      gl.drawElementsInstanced(gl.TRIANGLES, batch.geometry.indexCount, gl.UNSIGNED_INT, 0, chunk.count);
      triangles += (batch.geometry.indexCount / 3) * chunk.count;
    }
    gl.bindVertexArray(null);
    // Leave the context as the next frame expects it: no blending, depth writes on.
    setBlend(0);
    this.timer?.end();
    this.lastFrameStats = { drawCalls: chunks.length, instances: instanceCount, triangles, gpuMs: this.timer?.lastMs ?? null };

    // Read back into a free pixel-pack buffer; skip this frame's readback if all are in flight.
    this.submitted += 1;
    const slot = this.readback.find((s) => s.fence === null);
    if (slot) {
      slot.seq = this.submitted;
      this.readSeq = this.submitted;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer);
      gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      slot.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      this.pending.push(slot);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.flush();
  }

  /** The clustered lights' params and info this frame (EP8; see the shader's clusterParams/clusterInfo). */
  private readonly clusterParams = new Float32Array(4);
  private readonly clusterInfo = new Float32Array(4);
  /** The cell table and index list as integer textures, made on first use. */
  private clusterTextures: { table: any; index: any } | null = null;

  /** The per-frame uniforms a program needs (probes, clusters), set when it's put to use. */
  private frameUniforms(program: any): void {
    const gl = this.gl;
    gl.uniform4fv(gl.getUniformLocation(program, "probeData"), this.probeData);
    gl.uniform4fv(gl.getUniformLocation(program, "clusterParams"), this.clusterParams);
    gl.uniform4fv(gl.getUniformLocation(program, "clusterInfo"), this.clusterInfo);
  }

  /** Upload a frame's cells (only the index rows in use), and bind both textures. */
  private uploadClusters(clusters: LightClusters | null): void {
    const gl = this.gl;
    if (!this.clusterTextures) {
      const make = (internal: number, w: number, h: number) => {
        const texture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + UNIT_CLUSTER_TABLE);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        return texture;
      };
      this.clusterTextures = { table: make(gl.RG32UI, CLUSTER_X * CLUSTER_Y, CLUSTER_Z), index: make(gl.R32UI, 1024, CLUSTER_INDEX_CAP / 1024) };
    }
    if (clusters) {
      this.bindTexture(UNIT_CLUSTER_TABLE, this.clusterTextures.table);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, CLUSTER_X * CLUSTER_Y, CLUSTER_Z, gl.RG_INTEGER, gl.UNSIGNED_INT, clusters.table);
      const rows = Math.ceil(clusters.used / 1024);
      if (rows > 0) {
        this.bindTexture(UNIT_CLUSTER_INDEX, this.clusterTextures.index);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1024, rows, gl.RED_INTEGER, gl.UNSIGNED_INT, clusters.indices.subarray(0, rows * 1024));
      }
    }
    this.bindTexture(UNIT_CLUSTER_TABLE, this.clusterTextures.table);
    this.bindTexture(UNIT_CLUSTER_INDEX, this.clusterTextures.index);
    gl.bindSampler(UNIT_CLUSTER_TABLE, null);
    gl.bindSampler(UNIT_CLUSTER_INDEX, null);
  }

  /** Programs by material graph (EP7), linked on first use. */
  private readonly graphPrograms = new Map<string, any>();

  /** The program a material draws with: the plain one, or its graph's variant. */
  private programOf(material: MeshAsset["primitives"][number]["material"]): any {
    const graph = compiledGraphOf(material);
    if (!graph) return this.program;
    let program = this.graphPrograms.get(graph.key);
    if (!program) {
      try {
        program = buildProgram(this.gl, this.nearest, graph);
      } catch {
        program = this.program; // a variant that won't build draws as the plain material
      }
      this.graphPrograms.set(graph.key, program);
    }
    return program;
  }

  /** The opaque depth, as a texture the transparent pass can read (EP6b): made on first use. */
  private sceneDepth: { texture: any; framebuffer: any } | null = null;

  /** Copy the main framebuffer's depth into {@link sceneDepth} and bind it, leaving the main framebuffer bound. */
  private copySceneDepth(): void {
    const gl = this.gl;
    if (!this.sceneDepth) {
      const texture = gl.createTexture();
      this.bindTexture(UNIT_SCENE_DEPTH, texture); // on its own unit, so no batch's texture is disturbed
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, this.width, this.height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, texture, 0);
      this.sceneDepth = { texture, framebuffer };
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.sceneDepth.framebuffer);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    this.bindTexture(UNIT_SCENE_DEPTH, this.sceneDepth.texture);
  }

  private ensureCapacity(draws: number, instanceFloats: number): void {
    const gl = this.gl;
    if (draws > this.uniformCapacity) {
      this.uniformCapacity = Math.max(draws, this.uniformCapacity * 2, 8);
      this.uniformData = new Float32Array(this.uniformCapacity * UNIFORM_FLOATS);
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.uniformBuffer);
      gl.bufferData(gl.UNIFORM_BUFFER, this.uniformData.byteLength, gl.DYNAMIC_DRAW);
    }
    if (instanceFloats > this.instanceFloats) {
      this.instanceFloats = Math.max(instanceFloats, this.instanceFloats * 2);
      this.instanceData = new Float32Array(this.instanceFloats);
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.UNIFORM_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW);
    }
  }

  private bindTexture(unit: number, texture: any): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
  }

  private textureFor(source: DecodedTexture | null): any {
    if (!source) return this.blankTexture;
    let texture = this.textures.get(source);
    if (!texture) {
      texture = createTexture(this.gl, source.width, source.height, this.gl.RGBA8, this.gl.RGBA, this.gl.UNSIGNED_BYTE, toBytes(source.data));
      this.textures.set(source, texture);
    }
    return texture;
  }

  private uploadShadow(shadow: SceneDraw["shadow"]): void {
    const gl = this.gl;
    if (!shadow) return;
    if (shadow.size !== this.shadowSize || !this.shadowTexture) {
      if (this.shadowTexture) gl.deleteTexture(this.shadowTexture);
      this.shadowTexture = createTexture(gl, shadow.size, shadow.size, gl.R32F, gl.RED, gl.FLOAT, null);
      this.shadowSize = shadow.size;
      this.shadowUploaded = null;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTexture);
    const dirty = shadow.dirty;
    if (dirty && this.shadowUploaded === shadow.depth) {
      // Only the region that changed since the last frame.
      if (dirty.width > 0 && dirty.height > 0) {
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, shadow.size);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, dirty.x);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, dirty.y);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, dirty.x, dirty.y, dirty.width, dirty.height, gl.RED, gl.FLOAT, shadow.depth);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      }
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, shadow.size, shadow.size, gl.RED, gl.FLOAT, shadow.depth);
      this.shadowUploaded = shadow.depth;
    }
  }

  private uploadEnv(map: DecodedTexture | null): void {
    if (map === this.envSource) return;
    if (this.envTexture) this.gl.deleteTexture(this.envTexture);
    this.envTexture = map ? createTexture(this.gl, map.width, map.height, this.gl.RGBA8, this.gl.RGBA, this.gl.UNSIGNED_BYTE, toBytes(map.data)) : null;
    this.envSource = map;
  }

  private uploadProbes(set: ReflectionProbeSet | null): void {
    const atlas = set?.atlas ?? null;
    if (atlas === this.probeSource) return;
    if (this.probeTexture) this.gl.deleteTexture(this.probeTexture);
    this.probeTexture = atlas ? createTexture(this.gl, atlas.width, atlas.height, this.gl.RGBA8, this.gl.RGBA, this.gl.UNSIGNED_BYTE, toBytes(atlas.data)) : null;
    this.probeSource = atlas;
    this.probeData.fill(0);
    this.probeData.set(packProbes(set).subarray(0, this.probeData.length));
  }

  private uploadSsao(ao: Float32Array | null): void {
    if (!ao) return;
    const gl = this.gl;
    if (!this.ssaoTexture) this.ssaoTexture = createTexture(gl, this.width, this.height, gl.R32F, gl.RED, gl.FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, this.ssaoTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.height, gl.RED, gl.FLOAT, ao);
  }

  /** Upload (once) a mesh's primitives; a live skinned primitive re-uploads when its revision moves on. */
  private uploadMesh(mesh: MeshAsset): GlPrimitive[] {
    const gl = this.gl;
    const cached = this.meshes.get(mesh);
    if (cached) {
      mesh.primitives.forEach((primitive, i) => {
        const g = cached[i];
        if (!primitive.dynamic || !g || g.revision === primitive.dynamic.revision) return;
        const normals = primitive.normals ?? computeSmoothNormals(primitive.positions, primitive.indices);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.vertexBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, interleaveVertices(primitive.positions, normals, primitive.uvs, primitive.uvs2 ?? null, primitive.blend ?? null));
        g.revision = primitive.dynamic.revision;
      });
      return cached;
    }
    const uploaded = mesh.primitives.map((primitive): GlPrimitive => {
      const normals = primitive.normals ?? computeSmoothNormals(primitive.positions, primitive.indices);
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vertexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, interleaveVertices(primitive.positions, normals, primitive.uvs, primitive.uvs2 ?? null, primitive.blend ?? null), primitive.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
      // Interleaved position(3) + normal(3) + uv(2) + light-map uv(2) + blend weight(1), as the WebGPU vertex layout.
      const stride = VERTEX_FLOATS * 4;
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, 32);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 40);
      const indexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, primitive.indices, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      return {
        vao,
        vertexBuffer,
        indexBuffer,
        indexCount: primitive.indices.length,
        ...(primitive.dynamic ? { revision: primitive.dynamic.revision } : {}),
      };
    });
    this.meshes.set(mesh, uploaded);
    return uploaded;
  }

  dispose(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.latest = null;
    this.software.dispose();
    const gl = this.gl;
    try {
      for (const slot of this.readback) {
        if (slot.fence) gl.deleteSync(slot.fence);
        gl.deleteBuffer(slot.buffer);
      }
      gl.deleteBuffer(this.uniformBuffer);
      gl.deleteBuffer(this.instanceBuffer);
      gl.deleteBuffer(this.lightBuffer);
      for (const t of [this.blankTexture, this.blankFloat, this.shadowTexture, this.envTexture, this.probeTexture, this.ssaoTexture]) if (t) gl.deleteTexture(t);
      gl.deleteFramebuffer(this.framebuffer);
      if (this.clusterTextures) {
        gl.deleteTexture(this.clusterTextures.table);
        gl.deleteTexture(this.clusterTextures.index);
      }
      if (this.sceneDepth) {
        gl.deleteTexture(this.sceneDepth.texture);
        gl.deleteFramebuffer(this.sceneDepth.framebuffer);
      }
      this.timer?.destroy();
      for (const rb of this.attachments) gl.deleteRenderbuffer(rb);
      gl.deleteSampler(this.sampler);
      gl.deleteProgram(this.program);
      for (const program of this.graphPrograms.values()) if (program !== this.program) gl.deleteProgram(program);
      // Meshes and material textures go with the context; release it now rather than at GC.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      // A context already gone: nothing to release.
    }
  }
}

/** A texture sampled with texelFetch or a sampler object: nearest, clamped, no mips (so a float one is complete). */
function createTexture(gl: any, width: number, height: number, internal: number, format: number, type: number, data: ArrayBufferView | null): any {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, data);
  return texture;
}

/** A decoded texture's pixels as the Uint8Array texImage2D wants. */
function toBytes(data: Uint8Array | Uint8ClampedArray): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
