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
 * WebGPU is not in this project's TS DOM lib and we do not want the
 * @webgpu/types dependency, so the handles are loosely typed — the same
 * convention the editor's GPU renderers use. Everything with real logic in it
 * (layout, packing, the parity maths) is pure and tested without a GPU.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  DEFAULT_RASTER_STYLE,
  computeSmoothNormals,
  multiplyMat4,
  type DecodedTexture,
  type Mat4,
  type MeshPrimitive,
  type MeshAsset,
  type MeshSceneInstance,
  type RasterStyle,
} from "@cartbox/editor";

import { SoftwareSceneRenderer, applyScenePasses, type SceneDraw, type SceneRenderer } from "./sceneRenderer.js";
import { webgpuCanHonour } from "./renderCaps.js";
import {
  UNIFORM_FLOATS,
  UNIFORM_STRIDE,
  alignBytesPerRow,
  UNIFORM_BYTES_USED,
  interleaveVertices,
  normalBasis3x3,
  packLights,
  resolveLight,
  resolvePbr,
  unpadRows,
  viewDirection,
  writeInstanceUniform,
} from "./scenePacking.js";

/**
 * The largest job the software rasteriser takes on while the GPU pipeline
 * fills. Warming up avoids pop-in on small scenes, but a lit arena at 720p costs
 * the CPU seconds per frame (it is fill-bound as much as triangle-bound) — a
 * freeze on a tablet — so past either limit the opening frame or two simply
 * show what is behind the scene (the sky, or the cart's own frame).
 */
const SOFTWARE_WARMUP_TRIANGLES = 20000;
const SOFTWARE_WARMUP_PIXELS = 640 * 360;

/** Triangles per mesh, counted once. */
const triangleCounts = new WeakMap<MeshAsset, number>();
function trianglesIn(instances: readonly MeshSceneInstance[]): number {
  let total = 0;
  for (const instance of instances) {
    let count = triangleCounts.get(instance.mesh);
    if (count === undefined) {
      count = instance.mesh.primitives.reduce((n, primitive) => n + primitive.indices.length / 3, 0);
      triangleCounts.set(instance.mesh, count);
    }
    total += count;
  }
  return total;
}

/** Staging buffers in flight. Three lets a readback land while two more queue. */
const READBACK_BUFFERS = 3;

// GPUShaderStage bits, spelled out because the enum is not in the TS DOM lib here.
const SHADER_STAGE_VERTEX = 0x1;
const SHADER_STAGE_FRAGMENT = 0x2;

const SHADER = /* wgsl */ `
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
  ssaoMeta: vec4<f32>,  // x = 1 when an SSAO buffer is bound, y = light count
  model: mat4x4<f32>,   // this draw's world matrix (point-light world position)
  fog: vec4<f32>,       // rgb = fog colour, w = density
  fogParams: vec4<f32>, // x = 1 when fogged, y = start distance, z = max amount
  shadow2: vec4<f32>,   // x = slope-scaled bias, y = 1 for 2x2 PCF
};

// A Modern-tier light (see packLights): d0 = dir/pos + kind, d1 = colour +
// intensity, d2.x = point range. Read from a shared storage buffer.
struct Light {
  d0: vec4<f32>,
  d1: vec4<f32>,
  d2: vec4<f32>,
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

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) lightClip: vec4<f32>,
  @location(3) worldPos: vec3<f32>,
  @location(4) eyeDepth: f32,
};

// Directional shadow test, mirroring rasterizeTriangle in meshRasterizer.ts:
// project into the light's frame, look up the nearest depth the light sees, and
// return 1 (lit) or 1−strength (occluded). The light is orthographic (w = 1).
fn shadowTap(fx: f32, fy: f32, z: f32) -> f32 {
  let size = u.shadow.y;
  let tx = i32(clamp(floor(fx), 0.0, size - 1.0));
  let ty = i32(clamp(floor(fy), 0.0, size - 1.0));
  let stored = textureLoad(shadowMap, vec2<i32>(tx, ty), 0).r;
  if (z > stored) { return 0.0; }
  return 1.0;
}
// cosL = |N.L| of the geometric normal against the key light, for the slope bias.
// Mirrors shadowVisibility in meshRasterizer.ts.
fn shadowFactor(lightClip: vec4<f32>, cosL: f32) -> f32 {
  if (u.shadow.x < 0.5) { return 1.0; }
  let ndc = lightClip.xyz / lightClip.w;
  if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0 || ndc.z < -1.0 || ndc.z > 1.0) {
    return 1.0;
  }
  let size = u.shadow.y;
  let sx = (ndc.x * 0.5 + 0.5) * size;
  let sy = (1.0 - (ndc.y * 0.5 + 0.5)) * size;
  var bias = u.shadow.z;
  if (u.shadow2.x > 0.0) {
    let c = clamp(cosL, 0.05, 1.0);
    bias = bias + u.shadow2.x * min(10.0, sqrt(1.0 - c * c) / c);
  }
  let z = ndc.z - bias;
  if (u.shadow2.y < 0.5) {
    if (shadowTap(sx, sy, z) < 0.5) { return 1.0 - u.shadow.w; }
    return 1.0;
  }
  let lit = (shadowTap(sx - 0.5, sy - 0.5, z) + shadowTap(sx + 0.5, sy - 0.5, z)
           + shadowTap(sx - 0.5, sy + 0.5, z) + shadowTap(sx + 0.5, sy + 0.5, z)) * 0.25;
  return 1.0 - u.shadow.w * (1.0 - lit);
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
) -> VSOut {
  var out: VSOut;
  out.pos = u.mvp * vec4<f32>(position, 1.0);
  out.normal = u.nrm * normal;
  out.uv = uv;
  out.lightClip = u.lightMvp * vec4<f32>(position, 1.0);
  out.worldPos = (u.model * vec4<f32>(position, 1.0)).xyz;
  out.eyeDepth = out.pos.w; // clip w = view depth, for distance fog
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  // glTF's V origin is top-left, so flip; the sampler wraps and (per era) filters.
  let uv = vec2<f32>(in.uv.x, 1.0 - in.uv.y);

  var colour = u.base;
  if (u.texflags.x > 0.5) {
    colour = colour * textureSample(tex, samp, uv);
  }
  // The CPU path skips a texel whose combined alpha is below 1/255 rather than
  // blending it, so this is a discard and not an alpha-blend state.
  if (colour.a * 255.0 < 1.0) { discard; }

  if (u.pbr.z > 0.5) {
    // --- Modern tier: metallic-roughness BRDF (Cook-Torrance) ---
    // Mirrors the software rasteriser's PBR branch (meshRasterizer.ts) term for
    // term, in the engine's non-linear byte space (a linear/HDR pipeline is a
    // later phase). Small float32-vs-float64 differences from pow/GGX are
    // expected; the fantasy path below stays byte-identical.
    var N = normalize(in.normal);
    if (dot(N, u.view.xyz) < 0.0) { N = -N; } // two-sided: flip toward the viewer
    var metallic = u.pbr.x;
    var rough = u.pbr.y;
    if (u.texflags.y > 0.5) {
      let mr = textureSample(mrTex, samp, uv);
      rough = rough * mr.g;   // glTF packs roughness in G,
      metallic = metallic * mr.b; // metallic in B
    }
    rough = clamp(rough, 0.045, 1.0); // a perfectly-smooth NDF blows up
    var ao = 1.0;
    if (u.texflags.z > 0.5) { ao = textureSample(occTex, samp, uv).r; }
    let albedo = colour.rgb;
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
      if (u.texflags.w > 0.5) { es = textureSample(emisTex, samp, uv).rgb; }
      emis = ef * es;
    }
    // Ambient / image-based lighting, mirroring the software rasteriser: with an
    // environment, a diffuse irradiance along N + a specular reflection along R
    // blurred toward the average by roughness; without one, the flat ambient.
    var amb: vec3<f32>;
    if (u.envSky.w > 0.5) {
      let irr = envColorDir(N);
      let R = 2.0 * ndv * N - V;
      let pref = mix(envColorDir(R), envAverage(), rough);
      amb = (irr * albedo * kdm + pref * f0) * ao;
    } else {
      amb = vec3<f32>(u.light.w) * albedo * ao;
    }
    // Screen-space AO darkens only the ambient fill, sampled at this fragment's
    // framebuffer pixel (matching the software path's ssao[di]).
    if (u.ssaoMeta.x > 0.5) {
      amb = amb * textureLoad(ssaoMap, vec2<i32>(in.pos.xy), 0).r;
    }
    // The direct light is what a shadow occludes; ambient/IBL still fills it.
    let sf = shadowFactor(in.lightClip, abs(dot(normalize(in.normal), u.light.xyz)));
    let lc = i32(u.ssaoMeta.y + 0.5);
    var lit: vec3<f32>;
    if (lc > 0) {
      // --- Multi-light forward accumulation (Modern tier) ---
      // Mirrors meshRasterizer.ts: each light re-evaluates the direct term with
      // shared N/ndv/f0/kdm/a2/k; point lights fall off to nothing at their range.
      var direct = vec3<f32>(0.0);
      for (var i = 0; i < lc; i = i + 1) {
        let lgt = lights[i];
        var Ld: vec3<f32>;
        var atten = 1.0;
        if (lgt.d0.w > 0.5) { // point
          let toL = lgt.d0.xyz - in.worldPos;
          let dist = max(length(toL), 1e-4);
          Ld = toL / dist;
          let range = lgt.d2.x;
          if (range > 0.0) { let t = max(0.0, 1.0 - dist / range); atten = t * t; }
        } else {
          Ld = normalize(lgt.d0.xyz);
        }
        let ndlL = max(0.0, dot(N, Ld));
        if (ndlL <= 0.0 || atten <= 0.0) { continue; }
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
        if (lgt.d0.w < 0.5) { occl = sf; } // directional lights honour the sun shadow
        let w = lgt.d1.w * atten * ndlL * occl;
        direct = direct + (kdm * (vec3<f32>(1.0) - FL) * albedo + FL * specL) * lgt.d1.rgb * w;
      }
      lit = direct + amb + emis;
    } else {
      lit = (kdm * (vec3<f32>(1.0) - F) * albedo + F * specD) * ndl * sf + amb + emis;
    }
    // HDR: expose + ACES roll-off, or write the linear colour straight through.
    var shaded = lit;
    if (u.tonemap.x > 0.5) {
      let e = u.tonemap.y;
      shaded = vec3<f32>(aces(lit.r * e), aces(lit.g * e), aces(lit.b * e));
    }
    // Distance fog in display space, mirroring fogFactor in skyDome.ts.
    if (u.fogParams.x > 0.5) {
      let d = max(0.0, in.eyeDepth - u.fogParams.y);
      let f = min(u.fogParams.z, 1.0 - exp(-d * u.fog.w));
      shaded = mix(clamp(shaded, vec3<f32>(0.0), vec3<f32>(1.0)), u.fog.rgb, f);
    }
    return vec4<f32>(shaded, colour.a);
  }

  // --- Fantasy path (byte-identical when no shadow; shadow scales the direct term) ---
  // Two-sided Lambert: abs(N·L) so inconsistent winding still lights. The normal
  // is deliberately NOT renormalised — the software rasteriser interpolates and
  // dots without normalising, and parity with it is the contract here. Both
  // therefore skew identically under non-uniform scale.
  let nl = abs(dot(in.normal, u.light.xyz));
  let shade = u.light.w + (1.0 - u.light.w) * nl * shadowFactor(in.lightClip, abs(dot(normalize(in.normal), u.light.xyz)));
  return vec4<f32>(colour.rgb * shade, colour.a);
}
`;

interface GpuPrimitive {
  vertexBuffer: any;
  indexBuffer: any;
  indexCount: number;
}

interface CachedBindGroup {
  group: any;
  /** The decoded textures this group was built against, so a swap rebuilds it. */
  source: {
    base: DecodedTexture | null;
    mr: DecodedTexture | null;
    occ: DecodedTexture | null;
    emis: DecodedTexture | null;
  };
}

/** The four material maps a primitive's bind group binds. */
interface PrimitiveTextures {
  base: DecodedTexture | null;
  mr: DecodedTexture | null;
  occ: DecodedTexture | null;
  emis: DecodedTexture | null;
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

  private constructor(
    private readonly device: any,
    private readonly width: number,
    private readonly height: number,
    private readonly pipeline: any,
    private readonly bindGroupLayout: any,
    private readonly colourTexture: any,
    private readonly depthTexture: any,
    private readonly sampler: any,
    private readonly blankTexture: any,
    /** 1x1 r32float, bound to the shadow slot when no shadow map is active. */
    private readonly blankShadow: any,
    private readonly readback: { buffer: any; busy: boolean }[],
    private readonly bytesPerRow: number,
    style: RasterStyle,
  ) {
    // The warm-up rasteriser must draw the same era as the GPU it stands in for.
    this.software = new SoftwareSceneRenderer(style);
    this.shadowTexture = blankShadow;
    this.envTexture = blankTexture; // the 1x1 white stands in until a map is bound
    this.ssaoBound = blankShadow; // the 1x1 r32float blank until an AO buffer arrives
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
      const module = device.createShaderModule({ code: SHADER });

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
        ],
      });

      const pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
        vertex: {
          module,
          entryPoint: "vs",
          buffers: [
            {
              // Interleaved position(3) + normal(3) + uv(2).
              arrayStride: 32,
              attributes: [
                { shaderLocation: 0, offset: 0, format: "float32x3" },
                { shaderLocation: 1, offset: 12, format: "float32x3" },
                { shaderLocation: 2, offset: 24, format: "float32x2" },
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
          targets: [{ format: "rgba8unorm" }],
        },
        // cullMode "none" matches the software rasteriser, which draws both
        // faces (its Lambert is two-sided for exactly this reason).
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
      });

      const colourTexture = device.createTexture({
        size: { width, height },
        format: "rgba8unorm",
        usage: 0x10 | 0x01, // RENDER_ATTACHMENT | COPY_SRC
      });
      const depthTexture = device.createTexture({
        size: { width, height },
        format: "depth24plus",
        usage: 0x10, // RENDER_ATTACHMENT
      });
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
        bindGroupLayout,
        colourTexture,
        depthTexture,
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
  private ensureShadowTexture(size: number): void {
    if (size === this.shadowMapSize) return;
    this.shadowUploaded = null; // a new texture needs a full upload
    if (size === 0) {
      if (this.shadowTexture !== this.blankShadow) this.shadowTexture = this.blankShadow;
    } else {
      destroySafely(this.shadowMapSize > 0 ? this.shadowTexture : null);
      this.shadowTexture = this.device.createTexture({
        size: { width: size, height: size },
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
    if (!map) {
      this.envTexture = this.blankTexture;
    } else {
      this.envTexture = this.device.createTexture({
        size: { width: map.width, height: map.height },
        format: "rgba8unorm",
        usage: 0x04 | 0x02, // TEXTURE_BINDING | COPY_DST
      });
      this.device.queue.writeTexture(
        { texture: this.envTexture },
        map.data,
        { bytesPerRow: map.width * 4, rowsPerImage: map.height },
        { width: map.width, height: map.height },
      );
    }
    this.envMapSource = map;
    this.bindGroups = new WeakMap(); // binding 7 changed identity
  }

  render(instances: readonly MeshSceneInstance[], draw: SceneDraw): void {
    if (this.destroyed) return;

    // LOD-select + frustum-cull once, so both the CPU warm-up and the GPU submit
    // draw the same visible set. A correct cull is output-identical.
    const visible = applyScenePasses(instances, draw);

    // Composite the newest completed GPU frame, or rasterise this one on the CPU
    // while the pipeline fills. Either way `out` is correct when this returns.
    if (this.latest) {
      this.composite(draw);
    } else if (draw.width * draw.height <= SOFTWARE_WARMUP_PIXELS && trianglesIn(visible) <= SOFTWARE_WARMUP_TRIANGLES) {
      this.software.render(visible, draw);
    } else if (draw.background !== null) {
      new Uint32Array(draw.out.buffer, draw.out.byteOffset, draw.width * draw.height).fill(packRgba(draw.background));
    }

    try {
      this.submit(visible, draw);
    } catch {
      // A lost device or an unbuildable buffer must not take the cart down: drop
      // back to software permanently by forgetting the last GPU frame.
      this.latest = null;
    }
  }

  /** Paint the last completed GPU frame over the cart's own pixels. */
  private composite(draw: SceneDraw): void {
    const count = draw.width * draw.height;
    // Whole pixels as little-endian RGBA words: a quarter of the work of
    // copying channels, which matters at 720p every frame.
    const source = new Uint32Array(this.latest!.buffer, this.latest!.byteOffset, count);
    const out = new Uint32Array(draw.out.buffer, draw.out.byteOffset, count);
    if (draw.background !== null) out.fill(packRgba(draw.background));
    // The shader discards anything below the alpha threshold, so a zero alpha
    // means "nothing drawn here" and the cart's pixel survives — the same result
    // as the software path's `background: null`.
    for (let i = 0; i < count; i += 1) {
      const word = source[i]!;
      if (word >>> 24 !== 0) out[i] = word;
    }
  }

  /** Encode and submit one frame, and start a readback if a buffer is free. */
  private submit(instances: readonly MeshSceneInstance[], draw: SceneDraw): void {
    const viewProj = multiplyMat4(draw.projection, draw.view);

    // Flatten to one draw per primitive so the uniform buffer can be written in
    // a single upload and each draw addressed by a dynamic offset.
    const draws: { primitive: MeshPrimitive; geometry: GpuPrimitive; textures: PrimitiveTextures; model: Mat4 }[] = [];
    for (const instance of instances) {
      const geometries = this.uploadMesh(instance.mesh);
      instance.mesh.primitives.forEach((primitive, index) => {
        const geometry = geometries[index];
        if (!geometry || geometry.indexCount === 0) return;
        draws.push({
          primitive,
          geometry,
          textures: {
            base: instance.textures?.[index] ?? null,
            mr: instance.mrTextures?.[index] ?? null,
            occ: instance.occlusionTextures?.[index] ?? null,
            emis: instance.emissiveTextures?.[index] ?? null,
          },
          model: instance.model,
        });
      });
    }
    if (draws.length === 0) return;

    this.ensureUniformCapacity(draws.length);
    // Resolved once: the light and view direction are per frame, not per draw, and
    // normalising them per primitive would be the same answer computed many times.
    const light = resolveLight(draw.lightDirection, draw.ambient);
    const viewDir = viewDirection(draw.view);

    // Shadow map: the CPU-generated map (renderShadowMap) uploaded as r32float so
    // the GPU samples the *same* depths the software path tests against. `size` 0
    // restores the blank when this frame casts no shadow.
    const shadow = draw.shadow ?? null;
    this.ensureShadowTexture(shadow ? shadow.size : 0);
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

    // SSAO: upload the CPU-generated AO buffer (same one the software path uses)
    // for the shader to sample per fragment.
    const ssao = draw.ssao ?? null;
    this.bindSsao(ssao);

    // Modern-tier lights: pack the list into the storage buffer for the WGSL loop.
    const sceneLights = draw.lights ?? null;
    this.uploadLights(packLights(sceneLights ?? []));
    const lightCount = sceneLights?.length ?? 0;

    draws.forEach((entry, index) => {
      const pbr = resolvePbr(
        entry.primitive.material,
        entry.textures.mr !== null,
        entry.textures.occ !== null,
        entry.textures.emis !== null,
      );
      writeInstanceUniform(this.uniformData, index, {
        mvp: multiplyMat4(viewProj, entry.model),
        normalBasis: normalBasis3x3(entry.model),
        baseColor: entry.primitive.material.baseColorFactor,
        hasTexture: entry.textures.base !== null,
        light,
        viewDir,
        pbr,
        hasMrMap: entry.textures.mr !== null,
        hasOcclusionMap: entry.textures.occ !== null,
        hasEmissiveMap: entry.textures.emis !== null,
        environment: draw.environment ?? null,
        lightMvp: shadow ? multiplyMat4(shadow.lightViewProj, entry.model) : null,
        shadow: shadowParams,
        tonemap: draw.tonemap ?? null,
        hasSsao: ssao !== null,
        model: entry.model,
        lightCount,
        fog: draw.fog ?? null,
      });
    });
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData, 0, draws.length * UNIFORM_FLOATS);

    const encoder = this.device.createCommandEncoder();
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
    });
    pass.setPipeline(this.pipeline);
    draws.forEach((entry, index) => {
      pass.setBindGroup(0, this.bindGroupFor(entry.primitive, entry.textures), [index * UNIFORM_STRIDE]);
      pass.setVertexBuffer(0, entry.geometry.vertexBuffer);
      pass.setIndexBuffer(entry.geometry.indexBuffer, "uint32");
      pass.drawIndexed(entry.geometry.indexCount);
    });
    pass.end();

    const slot = this.readback.find((entry) => !entry.busy);
    if (slot) {
      slot.busy = true;
      encoder.copyTextureToBuffer(
        { texture: this.colourTexture },
        { buffer: slot.buffer, bytesPerRow: this.bytesPerRow, rowsPerImage: this.height },
        { width: this.width, height: this.height },
      );
      this.device.queue.submit([encoder.finish()]);
      void this.drain(slot);
    } else {
      // Every staging buffer is still mapped; render anyway and read back next
      // frame rather than stalling the run loop waiting for one.
      this.device.queue.submit([encoder.finish()]);
    }
  }

  /** Await one readback and publish it as the newest frame. */
  private async drain(slot: { buffer: any; busy: boolean }): Promise<void> {
    try {
      await slot.buffer.mapAsync(0x01); // MapMode.READ
      if (this.destroyed) return;
      const padded = new Uint8Array(slot.buffer.getMappedRange());
      this.latest = unpadRows(padded, this.width, this.height, this.bytesPerRow, this.latest);
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

  /** Upload (once) a mesh's primitives as interleaved vertex + index buffers. */
  private uploadMesh(mesh: MeshAsset): GpuPrimitive[] {
    const cached = this.meshes.get(mesh);
    if (cached) return cached;

    const uploaded = mesh.primitives.map((primitive) => {
      const normals = primitive.normals ?? computeSmoothNormals(primitive.positions, primitive.indices);
      const vertices = interleaveVertices(primitive.positions, normals, primitive.uvs);
      const vertexBuffer = this.device.createBuffer({
        size: Math.max(32, vertices.byteLength),
        usage: 0x20 | 0x08, // VERTEX | COPY_DST
      });
      this.device.queue.writeBuffer(vertexBuffer, 0, vertices);

      const indexBuffer = this.device.createBuffer({
        size: Math.max(4, primitive.indices.byteLength),
        usage: 0x10 | 0x08, // INDEX | COPY_DST
      });
      this.device.queue.writeBuffer(indexBuffer, 0, primitive.indices);

      return { vertexBuffer, indexBuffer, indexCount: primitive.indices.length };
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
      cached.source.emis === textures.emis
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
    destroySafely(this.blankTexture);
    destroySafely(this.blankShadow);
    if (this.shadowTexture !== this.blankShadow) destroySafely(this.shadowTexture);
    if (this.envTexture !== this.blankTexture) destroySafely(this.envTexture);
    destroySafely(this.ssaoTexture);
    destroySafely(this.lightBuffer);
    destroySafely(this.uniformBuffer);
    for (const slot of this.readback) destroySafely(slot.buffer);
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

/** An RGBA colour as one little-endian pixel word. */
function packRgba([r, g, b, a]: readonly [number, number, number, number]): number {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}
