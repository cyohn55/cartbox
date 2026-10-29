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
  FAR_TILE_SCALE,
  MACRO_OCTAVES,
  ANISOTROPY_MIN_ALPHA,
  CLEARCOAT_F0,
  PARALLAX_MIN_NDV,
  PARALLAX_STEPS,
  resolveExtensions,
  resolveLayers,
  DISTORTION_FREQUENCY,
  DISTORTION_SPEED,
  EFFECT_DISTORT_POWER,
  REFRACTION_SCALE,
  effectActive,
  resolveRefraction,
  LIGHTMAP_DIRECTION_FLOOR,
  LIGHTMAP_RANGE,
  PROBE_DEPTH_SIDE,
  PROBE_NORMAL_BIAS,
  PROBE_SH,
  PROBE_VOLUME_SLOTS,
  probeVolumeTexels,
  aerialCamera,
  fogGrid,
  fogSun,
  resolveVolumetricFog,
  type ProbeVolume,
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
  lightProbeTexels,
  type LightProbeGrid,
  LOCAL_SHADOW_BIAS,
  LOCAL_SHADOW_GRID,
  LOCAL_SHADOW_SLOPE_BIAS,
  LOCAL_SHADOW_TILE,
  MAX_LOCAL_SHADOW_TILES,
  NEAR_CASCADE_BLEND,
  NEAR_CASCADE_EDGE,
  CLUSTER_CELLS,
  CLUSTER_INDEX_CAP,
  CLUSTER_X,
  CLUSTER_Y,
  CLUSTER_Z,
  buildLightClusters,
  orderLights,
  graphNoiseSource,
  WATER_PERIOD,
  WATER_STEP,
  WATER_TILT,
  waterUniform,
  waterAlong,
  windUniform,
  graphShaderCode,
  multiplyMat4,
  type CompiledGraph,
  type DecodedTexture,
  type EnvironmentLight,
  type HdrLightmap,
  type Mat4,
  type MeshPrimitive,
  type MeshAsset,
  type MeshSceneInstance,
  type Occluder,
  type RasterStyle,
  type ReflectionProbeSet,
} from "@cartbox/editor";

import { SoftwareSceneRenderer, applyScenePasses, type FrameState, type GpuSceneDraw, type SceneDraw, type SceneRenderer, type SunShadow } from "./sceneRenderer.js";
import { webgpuCanHonour } from "./renderCaps.js";
import { batchInstances, compositeFrame, presentFrame, softEdges, type PrimitiveTextures } from "./gpuFrame.js";
import { FrameGraph, GraphTimer, TransientPool, timingSpan, type FrameResource, type PassContext } from "./frameGraph.js";
import { MAX_ANISOTROPY, MipmapGenerator, coverageMips, hasTransparency, mipLevelCount, uploadCompressed } from "./mipmaps.js";
import { compressedFormatsFor } from "../lighting/webgpuDevice.js";
import { brdfLut, brdfWgsl } from "./brdf.js";
import { MATERIAL_SET_WGSL } from "./materialSet.js";
import { PathTracer, captureReference, type CaptureOptions, type ReferenceCapture } from "./pathTracer.js";
import { IES_BASE, IES_MAX_PROFILES, IES_VEC4S, ltcTables, ltcWgsl } from "./ltc.js";
import { PROBE_FACE, ProbeCapture, packCapturedProbes } from "./probeCapture.js";
import { DECAL_BUFFER_WORDS, DECAL_TILES_AT, decalWgsl, packDecalBoxes, packDecalTiles } from "./decalBuffer.js";
import { IBL_LEVELS, IblBuilder, SH_IRRADIANCE_WGSL, environmentKey, environmentPanorama, environmentSh, toHalf } from "./ibl.js";
import { CASCADE_COUNT, CASCADE_FORMAT, CASCADE_SHADOW_WGSL, SUN_SOFTNESS, fitCascades, type Cascade } from "./cascades.js";
import { REACTIVE_MASK_WGSL, TEMPORAL_SHARPEN_WGSL, TemporalState, hdrTemporalShaderWgsl, invertMat4, temporalShaderWgsl } from "./temporal.js";
import { reflectionShaderWgsl, reflectionUniforms } from "./reflections.js";
import { CONTACT_UNIFORM_FLOATS, SCREEN_SHADING_FORMAT, contactShaderWgsl, contactUniforms } from "./contactShadows.js";
import { GTAO_UNIFORM_FLOATS, gtaoShaderWgsl, gtaoTemporalWgsl, gtaoUniforms } from "./gtao.js";
import { HIZ_MAX_ROUGHNESS, HIZ_REDUCE_WGSL, HIZ_RESOLVE_WGSL, HIZ_TEMPORAL_WGSL, HIZ_TRACE_WGSL, HIZ_UNIFORM_FLOATS, hizCopyWgsl, hizLevels, hizUniforms } from "./hizReflections.js";
import {
  VSM_MARK_WORDS,
  VSM_PAGES,
  VSM_UNIFORM_FLOATS,
  VSM_LEVELS,
  VirtualPagePool,
  localSphere,
  markedPages,
  pageTouches,
  physicalCorner,
  vsmDepthCentre,
  vsmLightBasis,
  vsmMarkWgsl,
  vsmPageViewProj,
  vsmResolveWgsl,
  vsmUniforms,
  vsmWindows,
  worldSphere,
  type PageDraw,
} from "./virtualShadows.js";
import { CAMERA_UNIFORM_FLOATS, DOF_GATHER_WGSL, MOTION_NEIGHBOURS_WGSL, MOTION_TILE, MOTION_TILES_WGSL, cameraUniforms, dofCompositeWgsl, dofPrefilterWgsl, motionGatherWgsl, type CameraEffects } from "./cameraEffects.js";
import { UPSCALE_SHARPEN_WGSL, UPSCALE_UNIFORM_FLOATS, upscaleJitterPhases, upscaleShaderWgsl, upscaleUniforms } from "./upscaler.js";
import { DEFAULT_TEXEL_DENSITY, LIGHT_COMPLEXITY_FULL, OVERDRAW_FULL, SHADER_COMPLEXITY_FULL, VIEW_MODE_WGSL, VIEW_RESOLVE_WGSL, viewModeCode } from "./viewModes.js";
import { SSGI_UNIFORM_FLOATS, ssgiResolveWgsl, ssgiTemporalWgsl, ssgiTraceWgsl, ssgiUniforms, type SsgiFrame } from "./ssgi.js";
import { AERIAL_FRAME_FLOATS, AERIAL_LUT_BYTES, AERIAL_SAMPLE_WGSL, GpuAtmosphere, packAerialFrame } from "./atmosphere.js";
import { GpuProbeGi } from "./dynamicGi.js";
import { FOG_FORMAT, FOG_FRAME_FLOATS, FOG_SAMPLE_WGSL, GpuVolumetricFog, fogCamera, packFogFrame, type FogFrame } from "./volumetricFog.js";
import {
  LOCAL_ATLAS_SIZE,
  LOCAL_CLEAR_WGSL,
  LOCAL_SHADOW_GPU_WGSL,
  LOCAL_TILE_FLOATS,
  LocalTileCache,
  MAX_GPU_LOCAL_TILES,
  localTileKey,
  packLocalTiles,
  planLocalTiles,
  reachesLight,
  type LocalTile,
} from "./localAtlas.js";
import type { RenderStats } from "../debug/profiler.js";
import {
  UNIFORM_FLOATS,
  UNIFORM_STRIDE,
  alignBytesPerRow,
  UNIFORM_BYTES_USED,
  interleaveVerticesWithTangents,
  normalBasis3x3,
  packLights,
  packProbes,
  resolveSurface,
  PROBE_FLOATS,
  resolveLight,
  resolvePbr,
  resolveMapping,
  unpadRows,
  viewDirection,
  writeInstanceUniform,
  INSTANCE_FLOATS,
  writeInstanceTransform,
  refractionCamera,
} from "./scenePacking.js";

/** The sun's GPU cascades (F2a): their depth array, its comparison sampler, each cascade's light view, and the depth-only pipeline. */
interface CascadeResources {
  /** {@link CASCADE_FORMAT}, `size`² × {@link CASCADE_COUNT} layers (1×1 until a frame casts). */
  texture: any;
  size: number;
  readonly sampler: any;
  readonly views: readonly { readonly buffer: any; readonly group: any }[];
  /**
   * Group 0 for the casters: the uniforms and instance transforms alone, since the
   * draws' own group binds the map these passes write.
   */
  readonly casterLayout: any;
  /** Group 0 for a cut-out caster (F2a-2): the casters' bindings, and its material's base map and sampler. */
  readonly cutLayout: any;
  /** Null on the byte-space renderer, which never draws them. */
  readonly pipeline: any;
  /** Cut-out casters', dropping what their material does (F2a-2); null with `pipeline`. */
  readonly cutPipeline: any;
  /** The spot/point lights' tile views (F2d), one a tile, and the depth32float pipelines that draw them. */
  readonly localViews: readonly { readonly buffer: any; readonly group: any }[];
  readonly localPipeline: any;
  readonly localCutPipeline: any;
}

/** One shader variant's pipelines: opaque, blended and added (EP6). */
interface PipelineSet {
  readonly opaque: any;
  readonly blend: any;
  readonly add: any;
  /** With a depth prepass (F0c): the prepass itself; `opaque` then tests less-or-equal against its depths. */
  readonly prepass?: any;
}

/** The thin G-buffer's format (F0c): octahedral normal, roughness, material ID. */
export const GBUFFER_FORMAT = "rgba16float";

/** The velocity buffer's format (F0c): screen motion since last frame, in UV units. */
export const VELOCITY_FORMAT = "rg16float";

/** The linear-light shader's view modes (F10a; viewModes.ts): a diagnostic of what it shades with, in place of the lit colour. */
const VIEW_MODE_SHADE = /* wgsl */ `    let vm = i32(frame.debug.x + 0.5);
    if (vm > 0) {
      // Palettes and ramps are display colours, shaded a little by the sun so the forms still read.
      let form = 0.55 + 0.45 * max(0.0, dot(N, L));
      let texels = vec2<f32>(textureDimensions(tex));
      var d = vec3<f32>(0.0);
      if (vm == 1) { d = vmAlbedo + emis; }
      else if (vm == 2) { d = vmAlbedo; }
      else if (vm == 3) { d = vmLight(vec3<f32>(rough)); }
      else if (vm == 4) { d = vmLight(vec3<f32>(vmMetallic)); }
      else if (vm == 5) { d = vmLight(N * 0.5 + vec3<f32>(0.5)); }
      else if (vm == 6) { d = vmLight(vec3<f32>(ao)); }
      else if (vm == 7) { d = lit; }
      else if (vm == 9) {
        // An estimate of the pixel's shading work: its maps, its layers and features, and its lights.
        var cost = 4.0 + u.texflags.x + u.texflags.y + u.texflags.z + u.texflags.w;
        if (u.maps0.x > 0.5) { cost = cost + 2.0; }
        if (u.layer0.w > 0.0) { cost = cost + 8.0; }
        if (u.layer0.x > 0.0) { cost = cost + 3.0; }
        if (u.layer0.z != 0.0) { cost = cost + 2.0; }
        if (u.refract0.w > 0.5) { cost = cost + 4.0; }
        if (u.surface1.z > 0.5) { cost = cost + 2.0; }
        if (u.surface0.y > 0.0) { cost = cost + 1.0; }
        if (u.terrain0.x > 0.0) { cost = cost + 4.0; }
        if (u.motion0.z > 0.5) { cost = cost + 2.0; }
        if (u.envSky.w > 0.5) { cost = cost + 2.0; }
        cost = cost + 1.5 * f32(vmLights);
        d = vmLight(vmHeat(cost / ${SHADER_COMPLEXITY_FULL.toFixed(1)}));
      }
      else if (vm == 10) { d = vmLight(vmHeat(f32(vmLights) / ${LIGHT_COMPLEXITY_FULL.toFixed(1)}) * form); }
      else if (vm == 12) { d = vmLight(select(vec3<f32>(1.0), vmPalette(i32(u.motion0.w + 0.5)), u.motion0.w > -0.5) * form); }
      else if (vm == 13) {
        // Base-colour texels per metre: the UV footprint's texels over the surface's.
        if (u.texflags.x > 0.5) {
          let uvArea = abs(duv1.x * duv2.y - duv1.y * duv2.x) * texels.x * texels.y;
          let density = sqrt(uvArea / max(length(cross(dp1, dp2)), 1e-12));
          let t = clamp(log2(density / frame.debug.y) * 0.25 + 0.5, 0.0, 1.0);
          d = vmLight(select(mix(vec3<f32>(0.0, 0.85, 0.2), vec3<f32>(1.0, 0.1, 0.0), t * 2.0 - 1.0), mix(vec3<f32>(0.1, 0.3, 1.0), vec3<f32>(0.0, 0.85, 0.2), t * 2.0), t < 0.5) * form);
        } else { d = vmLight(vec3<f32>(0.3) * form); }
      }
      else if (vm == 14) {
        // The mip the base colour samples: green at 0, then yellow, red and magenta.
        let fx = duv1 * texels;
        let fy = duv2 * texels;
        let mip = max(0.0, 0.5 * log2(max(max(dot(fx, fx), dot(fy, fy)), 1e-8)));
        var ramp = array<vec3<f32>, 4>(vec3<f32>(0.1, 0.85, 0.2), vec3<f32>(1.0, 0.9, 0.1), vec3<f32>(1.0, 0.15, 0.1), vec3<f32>(0.9, 0.2, 1.0));
        let m = min(mip, 3.0);
        let i = min(2, i32(floor(m)));
        d = select(vmLight(vec3<f32>(0.3) * form), vmLight(mix(ramp[i], ramp[i + 1], m - f32(i)) * form), u.texflags.x > 0.5);
      }
      else if (vm == 15) {
        var ci = 0;
        for (var c = 0; c < ${CASCADE_COUNT}; c = c + 1) { if (in.eyeDepth > frame.cascadeFar[c]) { ci = ci + 1; } }
        d = vmLight(select(vec3<f32>(0.3), vmPalette(ci), frame.cascadeInfo.x > 0.5 && ci < ${CASCADE_COUNT}) * form);
      }
      shaded = d;
    }
`;

/** The per-frame globals' bytes (WGSL `Frame`): cluster params and info, the near cascade's matrix and params, the sun's GPU cascades (F2a), the aerial perspective's camera (F5a-2) and the fog's (F5b). */
const FRAME_BYTES = 896;

/** Floats into `Frame` where the view mode (F10a) sits. */
const FRAME_DEBUG = 220;

/** Floats into `Frame` where the sun's GPU cascades start (F2a): four matrices, then the slices' far depths, the flags and the texels. */
const FRAME_CASCADES = 84;

/** Floats into `Frame` where the aerial perspective's camera starts (F5a-2), and the volumetric fog's (F5b). */
const FRAME_AERIAL = FRAME_CASCADES + 104;
const FRAME_FOG = FRAME_AERIAL + 16;

/** The cascades the linear-light renderer gives a caller that passes only a CPU shadow map (F2a): how far they reach, and their size. */
const FALLBACK_CASCADE_DISTANCE = 80;
const FALLBACK_CASCADE_SIZE = 2048;

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
    uv: "puv",
    position: "in.worldPos",
    normal: "gN",
    view: "u.view.xyz",
    time: "u.effect1.w",
    curvature: "gCurv",
    occlusion: "gAO",
    thickness: "gThick",
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
    // The noise functions are always in the shader (refraction's warp uses them, I5).
    fns: "",
    base: `  // The material graph (EP7).
  var gMetal = -1.0;
  var gRough = -1.0;
  var gEmis = vec3<f32>(-1.0);
  {
    var gN = normalize(sNrm);
    if (dot(gN, u.view.xyz) < 0.0) { gN = -gN; }
    // The relief's curvature for wear masks (I4): occTex's B, −1..1.
    let gCurv = select(0.0, textureSample(occTex, samp, uv).b * 2.0 - 1.0, u.layer1.z > 0.5);
    // Baked occlusion and thickness (I15): occTex's R (1 without a map) and A (1 − the relief's thinness).
    let gAO = select(1.0, textureSample(occTex, samp, uv).r, u.texflags.z > 0.5);
    let gThick = select(1.0, textureSample(occTex, samp, uv).a, u.layer1.z > 0.5);
${code.split("\n").map((l) => `    ${l}`).join("\n")}
${set.map((l) => `    ${l}`).join("\n")}
  }`,
    pbr: `    if (gMetal >= 0.0) { metallic = gMetal; }
    if (gRough >= 0.0) { rough = gRough; }`,
    emis: `    if (gEmis.x >= 0.0) { emis = gEmis; }`,
  };
}

/** The scene shader, plain or with a material graph spliced in (EP7). */
/** Samples an anti-aliased frame takes (HALO_INFINITE_STYLE_ROADMAP.md I1): 4, the count every WebGPU device supports. */
export const MSAA_SAMPLES = 4;

/** The scene shader for multisampled targets: its soft edges read the depth's first sample. */
export function multisampledDepthShader(code: string): string {
  return code.replace("var sceneDepth: texture_depth_2d;", "var sceneDepth: texture_depth_multisampled_2d;");
}

/**
 * The Modern path's tone map and fog, applied to the WGSL variable `v` in
 * place (display space, mirroring applyFog in skyDome.ts). In the linear HDR
 * variant (AAA_FIDELITY_ROADMAP.md F0b) there is no tone map here — the
 * presenter tone-maps the whole frame once — and the fog mixes in linear light,
 * unclamped.
 */
function wgslDisplay(v: string, hdr = false): string {
  if (hdr) {
    return /* wgsl */ `    if (u.fogParams.x > 0.5) {
      let d = max(0.0, in.eyeDepth - u.fogParams.y);
      var f = min(u.fogParams.z, 1.0 - exp(-d * u.fog.w));
      // The fog's colour is the display's (F11a): mixed into what the display shows, as the byte path
      // mixes it, then turned back into light. Mixed in linear light, it lifted the distance far more.
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
      ${v} = mixAsShown(${v}, fc, f);
    }
    // The volumetric fog between the surface and the eye (F5b), as the air below: dimmed, and its light added.
    if (frame.fogEye.w > 0.5) {
      let mist = fogAt(in.worldPos);
      ${v} = ${v} * mist.a + select(mist.rgb, vec3<f32>(0.0), u.pbr.w > 2.5);
    }
    // The physical sky's air between the surface and the eye (F5a-2): what lies beyond it dimmed, the light it
    // scatters toward the eye added (by coverage, as the colour is premultiplied after; an additive surface only dims).
    if (frame.aerialEye.w > 0.5) {
      let air = aerialAt(in.worldPos);
      ${v} = ${v} * air.a + select(air.rgb, vec3<f32>(0.0), u.pbr.w > 2.5);
    }`;
  }
  return /* wgsl */ `    if (u.tonemap.x > 0.5) {
      let e = u.tonemap.y;
      ${v} = vec3<f32>(aces(${v}.r * e), aces(${v}.g * e), aces(${v}.b * e));
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
      ${v} = mix(clamp(${v}, vec3<f32>(0.0), vec3<f32>(1.0)), fc, f);
    }`;
}

/**
 * The scene shader. `reflect` (HALO_INFINITE_STYLE_ROADMAP.md I3) adds the
 * reflection targets a frame with screen-space reflections writes beside the
 * colour (see reflections.ts); the colour itself is the same.
 */
export function sceneShader(graph: CompiledGraph | null = null, reflect = false, hdr = false): string {
  const g = graphSites(graph);
  const code = /* wgsl */ `
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
  tonemap: vec4<f32>,   // x = 1 when tone-mapping, y = exposure, z = soft edge, w = 1 for the curve as authored (F11a-5)
  ssaoMeta: vec4<f32>,  // x = 1 when an SSAO buffer is bound, y = light count, z = 1 when a light map is bound (2: an HDR directional one, F3d)
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
  layer0: vec4<f32>,    // x = clearcoat, y = its roughness, z = anisotropy, w = parallax depth (I4)
  layer1: vec4<f32>,    // xy = anisotropy rotation (cos, sin), z = 1 when the relief rides in occTex's G and B
  refract0: vec4<f32>,  // x = bend, y = warp, z = silhouette distortion, w = 1 when the draw refracts (I5)
  refract1: vec4<f32>,  // xyz = camera right (world), w = frame height (px)
  refract2: vec4<f32>,  // xyz = camera up (world)
  water0: vec4<f32>,    // x = ripple strength (0 = still), y = ripples per metre, z = drift phase, w = flow direction (B5)
  terrain0: vec4<f32>,  // x = triplanar repeat (0 = UVs), y = height-blend sharpness (B6)
  wind0: vec4<f32>,     // xy = wind x, z × strength, z = phase (0..1), w = gust (B6)
  maps0: vec4<f32>,     // x = 1 when a normal map is bound (P1a)
  wind1: vec4<f32>,     // the previous frame's wind0, for motion vectors (F0c)
  motion0: vec4<f32>,   // x = where this frame's motion transforms start in xf (F0c), y = the draw's lighting channels (F2e)
  // The full material set (F1d; scenePacking.ts): sheen, a dielectric's f0, transmission and volume, the film, the UV transform.
  sheen0: vec4<f32>,
  spec0: vec4<f32>,
  trans0: vec4<f32>,
  trans1: vec4<f32>,
  irid0: vec4<f32>,
  uvx0: vec4<f32>,
  uvx1: vec4<f32>,
};

// A Modern-tier light (see packLights): d0 = dir/pos + kind, d1 = colour +
// intensity, d2.x = point range. Read from a shared storage buffer.
struct Light {
  d0: vec4<f32>,
  d1: vec4<f32>,
  d2: vec4<f32>,
  d3: vec4<f32>,
  d4: vec4<f32>, // xyz = an area light's tangent (F2e-2)
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
  localShadow: vec4<f32>, // EP8c: x = 1 when spot/point shadows are on, y = bias, z = slope bias (world units)
  probeMin: vec4<f32>,    // EP9: the probe grid's corner, w = 1 when a grid is bound
  probeScale: vec4<f32>,  // world → grid units per axis: (count − 1) / (max − min)
  probeCount: vec4<f32>,  // probes per axis; w = the slots a probe takes along x (F5b-0)
  envSh: array<vec4<f32>, 9>, // F3a: the environment's L2 SH irradiance over π (linear variant)
  envInfo: vec4<f32>,         // F3a: x = the prefiltered cube's top mip
  cascadeVp: array<mat4x4<f32>, ${CASCADE_COUNT}>, // F2a: the sun's cascades, world → light clip (depth 0..1)
  cascadeFar: vec4<f32>,      // F2a: each slice's far view depth
  cascadeInfo: vec4<f32>,     // F2a: x = 1 with GPU cascades, y = map size, z = strength, w = the last cascade's far depth
  cascadeTexel: vec4<f32>,    // F2a: each cascade's texel in world units
  cascadeDepth: vec4<f32>,    // F2a-2: the world distance each cascade's depth 0..1 spans
  cascadeSoft: vec4<f32>,     // F2a-2: x = the sun's size (its angular diameter's tangent), for the penumbrae; F2c: y = 1 with contact shadows; F3c: z = 1 with GTAO; F3e-2: w = 1 with SSGI
  viewProj: mat4x4<f32>,      // F2d-3: world → clip as drawn (jittered with TAA), for marching the prepass's depths
  depthTerms: vec4<f32>,      // F2d-3: xy = view distance from depth (d = y / (z + x)); z = 1 when the depths are readable as the scene shades; F2b: w = 1 with virtual shadow maps
  aerialEye: vec4<f32>,       // F5a-2: the eye the aerial perspective was built from, w = 1 when it is on
  aerialRight: vec4<f32>,     // F5a-2: its camera's right axis, w = P[0]
  aerialUp: vec4<f32>,        // F5a-2: its up axis, w = P[5]
  aerialBack: vec4<f32>,      // F5a-2: its back axis, w = km of air per world unit
  fogEye: vec4<f32>,          // F5b: the eye the volumetric fog was built from, w = 1 when it is on
  fogRight: vec4<f32>,        // F5b: its camera's right axis, w = P[0]
  fogUp: vec4<f32>,           // F5b: its up axis, w = P[5]
  fogBack: vec4<f32>,         // F5b: its back axis, w = the volume's reach
  debug: vec4<f32>,           // F10a: x = the view mode's code (0 lit), y = the texel density on target (per metre)
};
// One spot/point shadow tile (EP8c): world→clip, and params.xy = depth→distance terms.
struct ShadowTile {
  mvp: mat4x4<f32>,
  params: vec4<f32>,
  rect: vec4<f32>, // F2d: the tile's x, y and size in the atlas (texels), on the linear-light renderer
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;
@group(0) @binding(3) var mrTex: texture_2d<f32>;
@group(0) @binding(4) var occTex: texture_2d<f32>;
@group(0) @binding(5) var emisTex: texture_2d<f32>;
${hdr
  ? `// The sun's cascades (F2a), rendered on the GPU: the linear-light renderer's shadow, in the slot the
// byte-space one gives the CPU's map.
@group(0) @binding(6) var cascadeMap: texture_depth_2d_array;`
  : `// The shadow map: light-NDC depth in R, generated on the CPU by renderShadowMap
// and uploaded as r32float, so the GPU samples the *same* map the software path
// tests against. Unfilterable, read via textureLoad (nearest) — matching the
// software compare exactly.
@group(0) @binding(6) var shadowMap: texture_2d<f32>;`}
${hdr
  ? `// The environment as a GGX-prefiltered cube (F3a, ibl.ts): mip = roughness × top mip.
@group(0) @binding(7) var envCube: texture_cube<f32>;`
  : `// The equirectangular environment map, read via textureLoad (nearest) to match
// sampleEquirectRgb in meshRasterizer.ts. Bound to a 1x1 blank when unused.
@group(0) @binding(7) var envMap: texture_2d<f32>;`}
// The screen-space AO buffer (CPU-generated by computeSsao, uploaded r32float),
// sampled per fragment by its framebuffer pixel — the same buffer the software
// path multiplies its ambient by. Bound to a 1x1 blank when unused.
// The linear variant binds an array: the screen-space shading target's two layers (F2c, F3c; F3e-2's SSGI in
// the second), or the AO buffer as one layer.
@group(0) @binding(8) var ssaoMap: ${hdr ? "texture_2d_array<f32>" : "texture_2d<f32>"};
fn ssaoTexel(p: vec2<i32>) -> vec4<f32> { return textureLoad(ssaoMap, p, ${hdr ? "0, " : ""}0); }
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
// A baked light map, sampled with the second UV set (1x1 white when none). The linear variant binds an
// array: an HDR directional map's two layers (F3d: irradiance; direction and sky visibility), or an 8-bit map's one.
@group(0) @binding(11) var lmTex: ${hdr ? "texture_2d_array<f32>" : "texture_2d<f32>"};
// Reflection probes (probeSampling.ts in @cartbox/editor): every probe's
// panorama stacked in one atlas, and each one's box, capture point and mean
// colour; the uniform's ssaoMeta.w counts them (a zeroed slot when none).
struct Probe {
  mn: vec4<f32>,
  mx: vec4<f32>,
  pos: vec4<f32>,
  avg: vec4<f32>,
};
${hdr ? "// The linear variant's probes (F3b, probeCapture.ts): each one's prefiltered cube, six layers apiece.\n@group(0) @binding(12) var probeCubes: texture_cube_array<f32>;" : "@group(0) @binding(12) var probeAtlas: texture_2d<f32>;"}
@group(0) @binding(13) var<storage, read> probes: array<Probe>;
// A finely tiled detail map (materialEffects.ts; 1x1 white when none — the
// uniform's surface0.y gates it).
@group(0) @binding(14) var detailTex: texture_2d<f32>;
// The blend surface's map (terrain snow over rock), mixed by the vertex weight.
@group(0) @binding(15) var blendTex: texture_2d<f32>;
@group(0) @binding(16) var nrmTex: texture_2d<f32>;
// The opaque pass's depth (EP6b), read by the see-through pass for soft edges;
// the opaque pass binds a blank in its place.
@group(1) @binding(0) var sceneDepth: texture_depth_2d;
// Clustered lights (EP8): per cell (offset, count) into the index list, then the list, in one buffer
// (F5b-0: the stage's eight storage buffers are all in use, so the two share one).
@group(1) @binding(1) var<storage, read> clusterData: array<u32>;
fn clusterCell(i: u32) -> vec2<u32> { return vec2<u32>(clusterData[i * 2u], clusterData[i * 2u + 1u]); }
fn clusterLight(j: u32) -> u32 { return clusterData[${CLUSTER_CELLS * 2}u + j]; }
// Light probes (EP9) and the probe volume (F3d-3): slot f's probes at x = f · nx + probe x, in a buffer
// (F5b-0: it was a 3D texture read texel by texel, and the stage's sixteen sampled textures are all in use).
@group(1) @binding(2) var<storage, read> probeData: array<vec4<f32>>;
fn probeTexel(p: vec3<i32>) -> vec4<f32> {
  let w = i32(frame.probeCount.x * frame.probeCount.w + 0.5);
  return probeData[(p.z * i32(frame.probeCount.y + 0.5) + p.y) * w + p.x];
}
@group(1) @binding(3) var<uniform> frame: Frame;
// Spot and point light shadows (EP8c): the tile atlas and each tile's view.
${hdr ? "// The spot/point lights' depth atlas, drawn on the GPU (F2d).\n@group(1) @binding(4) var localDepth: texture_depth_2d;" : "@group(1) @binding(4) var localAtlas: texture_2d<f32>;"}
@group(1) @binding(5) var<storage, read> shadowTiles: array<ShadowTile>;
// The opaque scene's colour (I5), copied as the see-through pass begins — what a
// refracting surface bends (a 1×1 blank in the opaque pass, which never reads it).
@group(1) @binding(7) var sceneColour: texture_2d<f32>;
${hdr ? `${brdfWgsl(1, 8)}${MATERIAL_SET_WGSL}// The prefiltered cube's sampler: trilinear, so a roughness between levels blends them (F3a).
@group(1) @binding(9) var envSamp: sampler;
${ltcWgsl(1, 10)}
${decalWgsl(1, 13)}
${SH_IRRADIANCE_WGSL}
// The comparison sampler that filters the cascades' tests (F2a).
@group(1) @binding(11) var cascadeSamp: sampler_comparison;
${CASCADE_SHADOW_WGSL}
// The physical sky's aerial perspective (F5a-2, atmosphere.ts): its froxels as half floats, two a vec4.
@group(1) @binding(14) var<uniform> aerialLut: array<vec4<u32>, ${AERIAL_LUT_BYTES / 16}>;
${AERIAL_SAMPLE_WGSL}
// The volumetric fog (F5b, volumetricFog.ts): its light and transmittance, integrated over the froxels.
@group(1) @binding(6) var fogVolume: texture_3d<f32>;
${FOG_SAMPLE_WGSL}` : ""}
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
  // Invariant: the depth prepass (F0c) and the passes after it test against the same depths.
  @builtin(position) @invariant pos: vec4<f32>,
  @location(0) normal: vec3<f32>,
  // Centroid (I1): a multisampled edge pixel samples its textures inside the triangle, not past its edge.
  @location(1) @interpolate(perspective, centroid) uv: vec2<f32>,
  @location(2) lightClip: vec4<f32>,
  @location(3) worldPos: vec3<f32>,
  @location(4) eyeDepth: f32,
  @location(5) @interpolate(perspective, centroid) uv2: vec2<f32>,
  @location(6) bw: f32,
  @location(7) objPos: vec3<f32>,${hdr ? "\n  // The vertex's MikkTSpace frame in world space (F1c), each unit at the vertex: its tangent (w = 0 without one) and normal.\n  @location(8) tangent: vec4<f32>,\n  @location(9) frameNormal: vec3<f32>," : ""}
};

${hdr
  ? `// The sun's shadow on the linear-light renderer: its GPU cascades (F2a), or none.
// The fragment's pixel, which turns the cascades' taps (set as fs starts).
var<private> shadowPixel: vec2<f32>;
fn shadowFactor(lightClip: vec4<f32>, worldPos: vec3<f32>, cosL: f32) -> f32 {
  if (frame.cascadeInfo.x < 0.5) { return 1.0; }
  // The virtual shadow maps (F2b) for what the prepass holds, where a page is resident; the cascades elsewhere.
  if (frame.depthTerms.w > 0.5 && u.pbr.w < 1.5) {
    let v = textureLoad(ssaoMap, vec2<i32>(shadowPixel), 2, 0).r;
    if (v >= 0.0) { return v * contactAt(shadowPixel); }
  }
  return cascadeShadow(worldPos, cosL, shadowPixel) * contactAt(shadowPixel);
}
// The sun's contact shadow at this pixel (F2c), from the pass after the prepass: an opaque or
// cut-out surface's alone, as only they are in its depths.
fn contactAt(pixel: vec2<f32>) -> f32 {
  if (frame.cascadeSoft.y < 0.5 || u.pbr.w > 1.5) { return 1.0; }
  return ssaoTexel(vec2<i32>(pixel)).g;
}
fn screenOctDecode(e: vec2<f32>) -> vec3<f32> {
  var n = vec3<f32>(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  let t = max(-n.z, 0.0);
  n.x = n.x + select(t, -t, n.x >= 0.0);
  n.y = n.y + select(t, -t, n.y >= 0.0);
  return normalize(n);
}
// GTAO at this pixel (F3c): xyz its bent normal (zero without it), w its visibility, for an opaque or
// cut-out surface (the only ones in the prepass it reads).
fn gtaoAt(pixel: vec2<f32>) -> vec4<f32> {
  if (frame.cascadeSoft.z < 0.5 || u.pbr.w > 1.5) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
  let t = ssaoTexel(vec2<i32>(pixel));
  return vec4<f32>(screenOctDecode(t.zw), t.x);
}
// SSGI at this pixel (F3e-2), from the screen-shading target's second layer: rgb the near field's light
// (irradiance over π), a the share of directions it fills; none for what isn't in the prepass.
fn ssgiAt(pixel: vec2<f32>) -> vec4<f32> {
  if (frame.cascadeSoft.w < 0.5 || u.pbr.w > 1.5) { return vec4<f32>(0.0); }
  return textureLoad(ssaoMap, vec2<i32>(pixel), 1, 0);
}
// Light bouncing between the occluders brings some back (Jimenez's fit), the more the brighter the albedo.
fn gtaoBounce(v: f32, albedo: f32) -> f32 {
  let a = 2.0404 * albedo - 0.3324;
  let b = -4.7951 * albedo + 0.6417;
  let c = 2.7552 * albedo + 0.6903;
  return max(v, ((v * a + b) * v + c) * v);
}
`
  : `// Directional shadow test, mirroring rasterizeTriangle in meshRasterizer.ts:
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
  if (u.shadow2.y < 1.5) {
    let lit = (shadowTap(sx - 0.5, sy - 0.5, z, ox) + shadowTap(sx + 0.5, sy - 0.5, z, ox)
             + shadowTap(sx - 0.5, sy + 0.5, z, ox) + shadowTap(sx + 0.5, sy + 0.5, z, ox)) * 0.25;
    return 1.0 - u.shadow.w * (1.0 - lit);
  }
  // Soft (B7): a 4×4 neighbourhood, texel-spaced round the point.
  var lit = 0.0;
  for (var j = 0; j < 4; j = j + 1) {
    for (var i = 0; i < 4; i = i + 1) { lit = lit + shadowTap(sx + f32(i) - 1.5, sy + f32(j) - 1.5, z, ox); }
  }
  return 1.0 - u.shadow.w * (1.0 - lit / 16.0);
}
// The sun's shadow (mirrors sunShadowVisibility): the near cascade (EP8b) when
// the point sits well inside it, else the main map.
fn shadowFactor(lightClip: vec4<f32>, worldPos: vec3<f32>, cosL: f32) -> f32 {
  if (u.shadow.x < 0.5) { return 1.0; }
  let ndc = lightClip.xyz / lightClip.w;
  let inMain = !(ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0 || ndc.z < -1.0 || ndc.z > 1.0);
  if (frame.nearShadow.x > 0.5) {
    let n = (frame.nearMvp * vec4<f32>(worldPos, 1.0)).xyz;
    let m = max(abs(n.x), abs(n.y));
    if (m < ${NEAR_CASCADE_EDGE} && abs(n.z) <= 1.0) {
      let v = shadowAt(n, frame.nearShadow.y, frame.nearShadow.z, u.shadow.y, cosL);
      if (m <= ${NEAR_CASCADE_BLEND}) { return v; }
      // Fading to the main map toward the cascade's edge (B7).
      var mv = 1.0;
      if (inMain) { mv = shadowAt(ndc, u.shadow.z, u.shadow2.x, 0.0, cosL); }
      return v + (mv - v) * ((m - ${NEAR_CASCADE_BLEND}) / (${NEAR_CASCADE_EDGE} - ${NEAR_CASCADE_BLEND}));
    }
  }
  if (!inMain) { return 1.0; }
  return shadowAt(ndc, u.shadow.z, u.shadow2.x, 0.0, cosL);
}
`}
// Analytic environment (Phase 3 IBL), mirroring environmentColor /
// environmentAverage in meshRasterizer.ts: a sky/horizon/ground vertical
// gradient sampled by a direction's Y. WGSL mix(a,b,k) = a+(b-a)*k, matching the
// software helper exactly.
fn envGradient(y: f32) -> vec3<f32> {
  let t = clamp(y, -1.0, 1.0);
  var c: vec3<f32>;
  if (t >= 0.0) { c = mix(u.envHorizon.xyz, u.envSky.xyz, t); }
  else { c = mix(u.envHorizon.xyz, u.envGround.xyz, -t); }
  return toLinear(c) * u.envHorizon.w; // .w = intensity
}
// Sample the environment along a full direction: an equirectangular map when one
// is bound (envMeta.w), else the analytic gradient (Y only). Mirrors
// sampleEnvironmentDir in meshRasterizer.ts — nearest via textureLoad.
fn envColorDir(dir: vec3<f32>) -> vec3<f32> {
${hdr
  ? `  // The cube's sharp level holds the panorama or the gradient, decoded and scaled (F3a).
  return textureSampleLevel(envCube, envSamp, dir, 0.0).rgb;`
  : `  if (u.envMeta.w < 0.5) { return envGradient(dir.y); }
  let d = normalize(dir);
  let uCoord = atan2(d.z, d.x) / (2.0 * 3.14159265) + 0.5;
  let vCoord = acos(clamp(d.y, -1.0, 1.0)) / 3.14159265;
  let dims = vec2<f32>(textureDimensions(envMap, 0));
  let wx = uCoord - floor(uCoord);
  let tx = i32(clamp(floor(wx * dims.x), 0.0, dims.x - 1.0));
  let ty = i32(clamp(floor(vCoord * dims.y), 0.0, dims.y - 1.0));
  return toLinear(textureLoad(envMap, vec2<i32>(tx, ty), 0).rgb) * u.envHorizon.w;`}
}
${hdr ? `// Probe i's cube along a direction, at a roughness's level (F3b).
fn probeSample(i: i32, dir: vec3<f32>, rough: f32) -> vec3<f32> {
  return textureSampleLevel(probeCubes, envSamp, dir, i, rough * frame.envInfo.x).rgb;
}` : `// Probe i's panorama along a direction, nearest — mirrors sampleProbe.
fn probeSample(i: i32, dir: vec3<f32>) -> vec3<f32> {
  let d = normalize(dir);
  let uCoord = atan2(d.z, d.x) / (2.0 * 3.14159265) + 0.5;
  let vCoord = acos(clamp(d.y, -1.0, 1.0)) / 3.14159265;
  let dims = vec2<f32>(textureDimensions(probeAtlas, 0));
  let h = floor(dims.x * 0.5);
  let tx = i32(clamp(floor((uCoord - floor(uCoord)) * dims.x), 0.0, dims.x - 1.0));
  let ty = i32(clamp(floor(vCoord * h), 0.0, h - 1.0) + f32(i) * h);
  return toLinear(textureLoad(probeAtlas, vec2<i32>(tx, ty), 0).rgb * ${PROBE_RANGE.toFixed(4)});
}`}
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
${hdr ? VIEW_MODE_WGSL : ""}
fn finishAlpha(rgb: vec3<f32>, a: f32) -> vec4<f32> {
  // Linear light (F0b) keeps what is over 1 — a highlight, the sun on water — for the presenter's tone map.
  let c = ${hdr ? "max(rgb, vec3<f32>(0.0))" : "clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0))"};
  if (u.pbr.w > 2.5) { return vec4<f32>(c * a, 0.0); }
  if (u.pbr.w > 1.5) { return vec4<f32>(c * a, a); }
  return vec4<f32>(c, 1.0);
}
${hdr
  ? LOCAL_SHADOW_GPU_WGSL
  : `// A spot/point light's shadow at P (mirrors localShadowVisibility): the tile
// that sees it (a point light's face by dominant axis), a 2×2 PCF of distance
// compares against a slope-scaled world bias.
fn localTap(fx: f32, fy: f32, ox: f32, oy: f32, own: f32, a: f32, b: f32) -> f32 {
  let size = ${LOCAL_SHADOW_TILE}.0;
  let tx = i32(clamp(floor(fx), 0.0, size - 1.0) + ox);
  let ty = i32(clamp(floor(fy), 0.0, size - 1.0) + oy);
  let stored = textureLoad(localAtlas, vec2<i32>(tx, ty), 0).r;
  if (own > b / (min(stored, 1.0) + a)) { return 0.0; }
  return 1.0;
}
fn localShadow(first: i32, lgt: Light, P: vec3<f32>, cosL: f32) -> f32 {
  var tile = first;
  if (lgt.d0.w < 1.5) {
    let d = P - lgt.d0.xyz;
    let m = abs(d);
    if (m.x >= m.y && m.x >= m.z) { tile = tile + select(1, 0, d.x >= 0.0); }
    else if (m.y >= m.z) { tile = tile + select(3, 2, d.y >= 0.0); }
    else { tile = tile + select(5, 4, d.z >= 0.0); }
  }
  let t = shadowTiles[tile];
  let c = t.mvp * vec4<f32>(P, 1.0);
  if (c.w <= 0.0) { return 1.0; }
  let n = c.xyz / c.w;
  if (n.x < -1.0 || n.x > 1.0 || n.y < -1.0 || n.y > 1.0 || n.z < -1.0 || n.z > 1.0) { return 1.0; }
  let size = ${LOCAL_SHADOW_TILE}.0;
  let sx = (n.x * 0.5 + 0.5) * size;
  let sy = (1.0 - (n.y * 0.5 + 0.5)) * size;
  let cc = clamp(cosL, 0.05, 1.0);
  let own = t.params.y / (n.z + t.params.x) - frame.localShadow.y - frame.localShadow.z * min(10.0, sqrt(1.0 - cc * cc) / cc);
  let ox = f32((tile % ${LOCAL_SHADOW_GRID}) * ${LOCAL_SHADOW_TILE});
  let oy = f32((tile / ${LOCAL_SHADOW_GRID}) * ${LOCAL_SHADOW_TILE});
  return (localTap(sx - 0.5, sy - 0.5, ox, oy, own, t.params.x, t.params.y) + localTap(sx + 0.5, sy - 0.5, ox, oy, own, t.params.x, t.params.y)
        + localTap(sx - 0.5, sy + 0.5, ox, oy, own, t.params.x, t.params.y) + localTap(sx + 0.5, sy + 0.5, ox, oy, own, t.params.x, t.params.y)) * 0.25;
}

`}
// One ambient-cube face of the probe grid at grid cell i + fraction f (trilinear).
fn probeFace(face: i32, i: vec3<i32>, f: vec3<f32>) -> vec3<f32> {
  let o = i + vec3<i32>(face * i32(frame.probeCount.x + 0.5), 0, 0);
  let x00 = mix(probeTexel(o).rgb, probeTexel(o + vec3<i32>(1, 0, 0)).rgb, f.x);
  let x10 = mix(probeTexel(o + vec3<i32>(0, 1, 0)).rgb, probeTexel(o + vec3<i32>(1, 1, 0)).rgb, f.x);
  let x01 = mix(probeTexel(o + vec3<i32>(0, 0, 1)).rgb, probeTexel(o + vec3<i32>(1, 0, 1)).rgb, f.x);
  let x11 = mix(probeTexel(o + vec3<i32>(0, 1, 1)).rgb, probeTexel(o + vec3<i32>(1, 1, 1)).rgb, f.x);
  return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
}
// The ambient scale from the probe grid at P for normal N (mirrors sampleLightProbes).
fn probeLight(P: vec3<f32>, N: vec3<f32>) -> vec3<f32> {
  let n = frame.probeCount.xyz;
  let g = clamp((P - frame.probeMin.xyz) * frame.probeScale.xyz, vec3<f32>(0.0), n - vec3<f32>(1.0));
  let i = min(vec3<i32>(floor(g)), vec3<i32>(n + vec3<f32>(0.5)) - vec3<i32>(2));
  let f = g - vec3<f32>(i);
  let nn = normalize(N);
  let w = nn * nn;
  return w.x * probeFace(select(1, 0, nn.x >= 0.0), i, f)
       + w.y * probeFace(select(3, 2, nn.y >= 0.0), i, f)
       + w.z * probeFace(select(5, 4, nn.z >= 0.0), i, f);
}
${hdr ? /* wgsl */ `
// --- The probe volume (F3d-3; probeVolume.ts, whose sampleProbeVolume this mirrors) ---
// One probe's slot of the volume texture: slots 0–8 its SH (slot 0's alpha its validity, slot 1's its sky
// visibility), slots 9–40 its octahedral depths, two texels each.
fn volumeSlot(slot: i32, i: vec3<i32>) -> vec4<f32> {
  return probeTexel(i + vec3<i32>(slot * i32(frame.probeCount.x + 0.5), 0, 0));
}
fn volumeOctTexel(d: vec3<f32>) -> i32 {
  var e = d.xz / (abs(d.x) + abs(d.y) + abs(d.z));
  if (d.y < 0.0) { e = (vec2<f32>(1.0) - abs(e.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), e >= vec2<f32>(0.0)); }
  let uv = e * 0.5 + vec2<f32>(0.5);
  let x = min(i32(uv.x * ${PROBE_DEPTH_SIDE}.0), ${PROBE_DEPTH_SIDE - 1});
  let y = min(i32(uv.y * ${PROBE_DEPTH_SIDE}.0), ${PROBE_DEPTH_SIDE - 1});
  return y * ${PROBE_DEPTH_SIDE} + x;
}
// The irradiance (over π) and sky visibility the volume gives P with normal N: the eight probes round it,
// weighed trilinearly, by a wrapped cosine toward each, and by Chebyshev's bound on each seeing P (DDGI).
// w < 0 when no probe is valid or sees it.
fn probeVolumeAt(P: vec3<f32>, N: vec3<f32>) -> vec4<f32> {
  let n = frame.probeCount.xyz;
  let spacing = 1.0 / max(frame.probeScale.xyz, vec3<f32>(1e-6));
  let Pb = P + N * (${PROBE_NORMAL_BIAS} * min(spacing.x, min(spacing.y, spacing.z)));
  let g = clamp((Pb - frame.probeMin.xyz) * frame.probeScale.xyz, vec3<f32>(0.0), n - vec3<f32>(1.0));
  let i0 = min(vec3<i32>(floor(g)), vec3<i32>(n + vec3<f32>(0.5)) - vec3<i32>(2));
  let f = g - vec3<f32>(i0);
  var sum = vec3<f32>(0.0);
  var vis = 0.0;
  var wsum = 0.0;
  for (var c = 0; c < 8; c = c + 1) {
    let o = vec3<i32>(c & 1, (c >> 1) & 1, (c >> 2) & 1);
    let i = i0 + o;
    let s0 = volumeSlot(0, i);
    if (s0.w < 0.5) { continue; }
    let tri = select(vec3<f32>(1.0) - f, f, o == vec3<i32>(1));
    let at = frame.probeMin.xyz + vec3<f32>(i) * spacing;
    let to = at - P;
    let wrap = (dot(to, N) / max(length(to), 1e-6) + 1.0) * 0.5;
    var w = wrap * wrap + 0.2;
    let off = Pb - at;
    let dist = length(off);
    if (dist > 1e-4) {
      let k = volumeOctTexel(off / dist);
      let pair = volumeSlot(${PROBE_SH} + k / 2, i);
      let m = select(pair.xy, pair.zw, (k & 1) == 1);
      if (dist > m.x) {
        let variance = max(m.y - m.x * m.x, 1e-4);
        let cheb = variance / (variance + (dist - m.x) * (dist - m.x));
        w = w * cheb * cheb * cheb;
      }
    }
    w = w * tri.x * tri.y * tri.z;
    if (w <= 1e-6) { continue; }
    let s1 = volumeSlot(1, i);
    let e = s0.xyz * 0.282095
      + (s1.xyz * N.y + volumeSlot(2, i).xyz * N.z + volumeSlot(3, i).xyz * N.x) * 0.488603
      + (volumeSlot(4, i).xyz * (N.x * N.y) + volumeSlot(5, i).xyz * (N.y * N.z) + volumeSlot(7, i).xyz * (N.x * N.z)) * 1.092548
      + volumeSlot(6, i).xyz * (0.315392 * (3.0 * N.z * N.z - 1.0))
      + volumeSlot(8, i).xyz * (0.546274 * (N.x * N.x - N.y * N.y));
    sum = sum + max(e, vec3<f32>(0.0)) * w;
    vis = vis + s1.w * w;
    wsum = wsum + w;
  }
  if (wsum <= 1e-6) { return vec4<f32>(0.0, 0.0, 0.0, -1.0); }
  return vec4<f32>(sum / wsum, vis / wsum);
}
` : ""}


// --- Layers and relief (HALO_INFINITE_STYLE_ROADMAP.md I4; materialLayers.ts) ---
// The world gradients of u and v, from screen derivatives and the normal: the
// in-plane vectors whose dot with a step across the surface is its change in
// u (and v). Mirrors uvGradients.
struct Grads {
  gu: vec3<f32>,
  gv: vec3<f32>,
};
fn uvGrads(n: vec3<f32>, dp1: vec3<f32>, dp2: vec3<f32>, duv1: vec2<f32>, duv2: vec2<f32>) -> Grads {
  let a = cross(dp2, n);
  let b = cross(n, dp1);
  let det = dot(dp1, a);
  if (abs(det) < 1e-20) { return Grads(vec3<f32>(0.0), vec3<f32>(0.0)); }
  return Grads((a * duv1.x + b * duv2.x) / det, (a * duv1.y + b * duv2.y) / det);
}
// The relief's height at a glTF UV (occTex's G, see occlusionWithRelief), at
// level 0 so it can be read inside the march.
fn reliefHeight(p: vec2<f32>) -> f32 {
  return textureSampleLevel(occTex, samp, vec2<f32>(p.x, 1.0 - p.y), 0.0).g;
}
// Parallax occlusion: where the view ray meets the relief — parallaxUv, line for line.
fn parallaxUv(uv0: vec2<f32>, rate: vec2<f32>, depth: f32) -> vec2<f32> {
  let layer = 1.0 / ${PARALLAX_STEPS}.0;
  let st = rate * depth * layer;
  var c = uv0;
  var cur = 0.0;
  var below = 1.0 - reliefHeight(c);
  for (var i = 0; i < ${PARALLAX_STEPS}; i = i + 1) {
    if (cur >= below) { break; }
    c = c + st;
    cur = cur + layer;
    below = 1.0 - reliefHeight(c);
  }
  let after = below - cur;
  let before = 1.0 - reliefHeight(c - st) - (cur - layer);
  let span = after - before;
  var w = 0.0;
  if (abs(span) > 1e-6) { w = after / span; }
  return c - st * w;
}
// A normal map's normal (P1a). In the vertex's stored MikkTSpace frame (F1c),
// decoded as it was baked: the normal and tangent unit at each vertex and
// interpolated, unnormalised (vn), the bitangent w · (vn × t). Without one
// (w = 0, and always outside the linear variant), in the triangle's frame from
// the UVs' screen derivatives — worldTangent's dP/du (Lengyel), as the
// software rasteriser does.
fn mappedNormal(n: vec3<f32>, t: vec4<f32>, vn: vec3<f32>, tn: vec3<f32>, dp1: vec3<f32>, dp2: vec3<f32>, duv1: vec2<f32>, duv2: vec2<f32>) -> vec3<f32> {
  if (t.w != 0.0) { return normalize(tn.x * t.xyz + tn.y * (t.w * cross(vn, t.xyz)) + tn.z * vn); }
  let det = duv1.x * duv2.y - duv2.x * duv1.y;
  if (!(abs(det) > 1e-20)) { return n; }
  let Ng = normalize(n);
  var T = (dp1 * duv2.y - dp2 * duv1.y) / det;
  T = T - Ng * dot(T, Ng);
  let tl = length(T);
  if (!(tl > 1e-6)) { return n; }
  T = T / tl;
  return normalize(T * tn.x + cross(Ng, T) * tn.y + Ng * tn.z);
}
// The anisotropic GGX distribution (anisotropicD).
fn anisoD(rough: f32, aniso: f32, toh: f32, boh: f32, ndh: f32) -> f32 {
  let alpha = rough * rough;
  let at = max(alpha * (1.0 + aniso), ${ANISOTROPY_MIN_ALPHA});
  let ab = max(alpha * (1.0 - aniso), ${ANISOTROPY_MIN_ALPHA});
  let a2 = at * ab;
  let d = vec3<f32>(ab * toh, at * boh, a2 * ndh);
  let b2 = a2 / (dot(d, d) + 1e-12);
  return a2 * b2 * b2 / 3.14159265;
}
// This fragment's anisotropy frame (set in fs, read by lightTerm).
var<private> aniso: f32;${hdr ? "\n// The multiple scattering a light's specular adds back (F1c; set in fs, read by lightTerm).\nvar<private> eComp: vec3<f32>;\n// What the sheen leaves the base beneath (F1d; set in fs, read by lightTerm).\nvar<private> sheenScale: f32 = 1.0;" : ""}
var<private> aT: vec3<f32>;
var<private> aB: vec3<f32>;
// The clearcoat's normal and N·V (P1a): the geometric normal, which the coat lies over the bumps with.
var<private> coatN: vec3<f32>;
var<private> coatNdv: f32;
// The clearcoat's lobe for one light (coatLobe): x = its radiance factor, y = the Fresnel dimming the base.
fn coatTerm(N: vec3<f32>, ndv: f32, Ld: vec3<f32>, H: vec3<f32>, vdh: f32) -> vec2<f32> {
  let rc = u.layer0.y;
  let ac2 = rc * rc * rc * rc;
  let kc = ((rc + 1.0) * (rc + 1.0)) / 8.0;
  let ndl = max(0.0, dot(N, Ld));
  let ndh = max(0.0, dot(N, H));
  let dd = ndh * ndh * (ac2 - 1.0) + 1.0;
  let D = ac2 / (3.14159265 * dd * dd + 1e-7);
  let G = (ndv / (ndv * (1.0 - kc) + kc)) * (ndl / (ndl * (1.0 - kc) + kc));
  let fc = ${CLEARCOAT_F0} + (1.0 - ${CLEARCOAT_F0}) * pow(1.0 - vdh, 5.0);
  return vec2<f32>(u.layer0.x * fc * (D * G) / (4.0 * ndl * ndv + 1e-4) * ndl${hdr ? " * 3.14159265" : ""}, u.layer0.x * fc);
}
// The environment's reflection along R from P, blurred toward its average by
// roughness: inside a reflection probe's box (the smallest first), the room
// around it, box-projected from this point, fading to the sky at the box's
// faces — mirroring environmentReflection and pickProbe/boxProject.
fn envReflect(P: vec3<f32>, R: vec3<f32>, rough: f32) -> vec3<f32> {
${hdr ? `  // The linear variant (F3a, F3b): the probes' prefiltered cubes, the highest
  // priority first, each taking its share of what the ones before left, and the
  // sky's lobe from its own cube the rest. A box probe is box-projected, a sphere
  // probe (pos.w its radius) sphere-projected; avg.w is 1 once it is captured.
  var spec = vec3<f32>(0.0);
  var left = 1.0;
  let pc = i32(u.ssaoMeta.w + 0.5);
  for (var i = 0; i < pc; i = i + 1) {
    let pr = probes[i];
    if (pr.avg.w < 0.5) { continue; }
    var wgt = 0.0;
    var dir = R;
    if (pr.pos.w > 0.0) {
      let o = P - pr.pos.xyz;
      let r = pr.pos.w;
      wgt = clamp((r - length(o)) / ${PROBE_FADE.toFixed(4)}, 0.0, 1.0);
      let b = dot(o, R);
      let t = -b + sqrt(max(b * b - (dot(o, o) - r * r), 0.0));
      dir = o + R * t;
    } else {
      let inside = min(min(min(P.x - pr.mn.x, pr.mx.x - P.x), min(P.y - pr.mn.y, pr.mx.y - P.y)), min(P.z - pr.mn.z, pr.mx.z - P.z));
      wgt = clamp(inside / ${PROBE_FADE.toFixed(4)}, 0.0, 1.0);
      let Rs = select(R, vec3<f32>(1e-6), abs(R) < vec3<f32>(1e-6));
      let tf = max((pr.mx.xyz - P) / Rs, (pr.mn.xyz - P) / Rs);
      let t = max(0.0, min(min(tf.x, tf.y), tf.z));
      dir = P + R * t - pr.pos.xyz;
    }
    if (wgt <= 0.0) { continue; }
    let share = wgt * left;
    spec = spec + probeSample(i, dir, rough) * share;
    left = left - share;
    if (left <= 0.001) { return spec; }
  }
  return spec + textureSampleLevel(envCube, envSamp, R, rough * frame.envInfo.x).rgb * left;
}
` : `  var spec = envColorDir(R);
  var specAvg = envAverage();
  let pc = i32(u.ssaoMeta.w + 0.5);
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
  return mix(spec, specAvg, rough);
}
`}

// One light's direct term (Cook-Torrance), mirroring the software rasteriser's
// light loop: point and spot lights fall off to nothing at their range, a spot
// fades across its cone, and directional lights honour the sun shadow (sf).
fn lightTerm(lgt: Light, P: vec3<f32>, N: vec3<f32>, V: vec3<f32>, ndv: f32, a2: f32, k: f32, f0: vec3<f32>, kdm: f32, albedo: vec3<f32>, sf: f32) -> vec3<f32> {
  // d3.w: inverse square in bit 0, the light's channels above it, which the draw's must share (F2e).
  let bits = u32(lgt.d3.w + 0.5);
  if (((bits >> 1u) & u32(u.motion0.y + 0.5)) == 0u) { return vec3<f32>(0.0); }
${hdr ? "  // An area light (F2e-2): its rectangle, disk or tube integrated with linearly transformed cosines.\n  if (lgt.d0.w > 2.5) { return areaTerm(lgt, P, N, V, ndv, sqrt(sqrt(a2)), f0, kdm, albedo); }\n" : ""}  var Ld: vec3<f32>;
  var atten = 1.0;
  if (lgt.d0.w > 0.5) { // point or spot
    let toL = lgt.d0.xyz - P;
    let dist = max(length(toL), 1e-4);
    Ld = toL / dist;
    let range = lgt.d2.x;
    if ((bits & 1u) != 0u) { // inverse square, windowed to its range
      var win = 1.0;
      if (range > 0.0) { let q = dist / range; let t = clamp(1.0 - q * q * q * q, 0.0, 1.0); win = t * t; }
      let d = max(dist, 0.01);
      atten = win / (d * d);
    } else if (range > 0.0) { let t = max(0.0, 1.0 - dist / range); atten = t * t; }
    if (lgt.d0.w > 1.5) {
      let ct = clamp((-dot(Ld, lgt.d3.xyz) - lgt.d2.y) / (lgt.d2.z - lgt.d2.y), 0.0, 1.0);
      atten = atten * ct * ct * (3.0 - 2.0 * ct);
    }${hdr ? "\n    // An IES profile (F9d): the fixture's measured distribution about its axis.\n    if (lgt.d4.w > -0.5) { atten = atten * iesFactor(u32(lgt.d4.w + 0.5), lgt.d3.xyz, -Ld); }" : ""}
  } else {
    Ld = normalize(lgt.d0.xyz);
  }
  let ndlL = max(0.0, dot(N, Ld));
  if (ndlL <= 0.0 || atten <= 0.0) { return vec3<f32>(0.0); }
  let Hl = normalize(Ld + V);
  let ndhL = max(0.0, dot(N, Hl));
  let vdhL = max(0.0, dot(V, Hl));
  let ddL = ndhL * ndhL * (a2 - 1.0) + 1.0;
  var DL = a2 / (3.14159265 * ddL * ddL + 1e-7);
  if (aniso != 0.0) { DL = anisoD(sqrt(sqrt(a2)), aniso, dot(aT, Hl), dot(aB, Hl), ndhL); }
${hdr
  ? "  // F1c: the height-correlated visibility, and π, as the diffuse is albedo rather than albedo / π.\n  let specL = DL * smithVisibility(ndlL, ndv, a2) * 3.14159265;"
  : "  let GL = (ndv / (ndv * (1.0 - k) + k)) * (ndlL / (ndlL * (1.0 - k) + k));\n  let specL = (DL * GL) / (4.0 * ndlL * ndv + 1e-4);"}
  let fpL = pow(1.0 - vdhL, 5.0);
  let FL = f0 + (vec3<f32>(1.0) - f0) * fpL;
  var occl = 1.0;
  if (lgt.d0.w < 0.5) { occl = sf; }
  else if (lgt.d2.w >= 0.0 && frame.localShadow.x > 0.5) { occl = localShadow(i32(lgt.d2.w + 0.5), lgt, P, ndlL); }
  let w = lgt.d1.w * atten * ndlL * occl;
  let lit = (kdm * (vec3<f32>(1.0) - FL) * albedo + FL * specL${hdr ? " * eComp" : ""}) * toLinear(lgt.d1.rgb) * w${hdr ? " * sheenScale + sheenLobe(ndlL, ndv, ndhL) * toLinear(lgt.d1.rgb) * w" : ""};
  if (u.layer0.x > 0.0) {
    // The clearcoat's own highlight, over a base its Fresnel dims (I4).
    let c = coatTerm(coatN, coatNdv, Ld, Hl, vdhL);
    return lit * (1.0 - c.y) + c.x * toLinear(lgt.d1.rgb) * (lgt.d1.w * atten * occl);
  }
  return lit;
}

fn envAverage() -> vec3<f32> {
  if (u.envMeta.w > 0.5) { return toLinear(u.envMeta.xyz) * u.envHorizon.w; }
  return toLinear((u.envSky.xyz + u.envHorizon.xyz + u.envGround.xyz) / 3.0) * u.envHorizon.w;
}
// Authored colour (byte space) into the light it stands for: the sRGB curve in
// the linear HDR variant (F0b), and nothing in the byte variant, whose shading
// stays in the space it was authored in.
fn toLinear(c: vec3<f32>) -> vec3<f32> {
${hdr ? "  let v = max(c, vec3<f32>(0.0));\n  return select(pow((v + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4)), v / 12.92, v <= vec3<f32>(0.04045));" : "  return c;"}
}${hdr ? `
// An HDR directional light map's irradiance at the shading normal N (F3d; mirrors directionalIrradiance in
// hdrLightmap.ts): the baked irradiance e rebalanced by a half-Lambert about its dominant direction d, exact at
// the normal it was baked for (the interpolated vertex normal, on the side N faces).
fn lightmapIrradiance(e: vec3<f32>, d: vec3<f32>, N: vec3<f32>, vn: vec3<f32>) -> vec3<f32> {
  var ng = normalize(vn);
  if (dot(ng, N) < 0.0) { ng = -ng; }
  return e * (0.5 + 0.5 * dot(N, d)) / max(${LIGHTMAP_DIRECTION_FLOOR}, 0.5 + 0.5 * dot(ng, d));
}` : ""}
// ACES filmic tone map (Narkowicz), per channel, mirroring acesFilmic in
// meshRasterizer.ts. Applied only to the Modern-tier PBR radiance.
fn aces(x: f32) -> f32 {
  let v = max(0.0, x);
  return clamp((v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14), 0.0, 1.0);
}
${hdr ? `fn srgbOf(x: vec3<f32>) -> vec3<f32> {
  let y = max(x, vec3<f32>(0.0));
  return select(1.055 * pow(y, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055), y * 12.92, y <= vec3<f32>(0.0031308));
}
// Linear light as the display shows it (F11a): exposed, through the curve, sRGB-encoded; as authored
// (F11a-5), the curve on the encoded light, as the byte path's shader maps its shading.
fn shownOf(x: vec3<f32>) -> vec3<f32> {
  let y = max(x, vec3<f32>(0.0));
  if (u.tonemap.x < 0.5) { return srgbOf(y); }
  let e = u.tonemap.y;
  if (u.tonemap.w > 0.5) { let s = srgbOf(y); return vec3<f32>(aces(s.r * e), aces(s.g * e), aces(s.b * e)); }
  return srgbOf(vec3<f32>(aces(y.r * e), aces(y.g * e), aces(y.b * e)));
}
// The curve's inverse, where it is one to one (under its white).
fn acesInverse(y: f32) -> f32 {
  let v = clamp(y, 0.0, 1.0);
  let a = 2.51 - 2.43 * v;
  let b = 0.03 - 0.59 * v;
  return (-b + sqrt(b * b + 4.0 * a * 0.14 * v)) / (2.0 * a);
}
// shownOf's inverse: what the display shows, as the linear light that shows it.
fn lightOf(d: vec3<f32>) -> vec3<f32> {
  if (u.tonemap.x < 0.5) { return toLinear(d); }
  let e = max(u.tonemap.y, 1e-6);
  if (u.tonemap.w > 0.5) { return toLinear(vec3<f32>(acesInverse(d.r), acesInverse(d.g), acesInverse(d.b)) / e); }
  let y = toLinear(d);
  return vec3<f32>(acesInverse(y.r), acesInverse(y.g), acesInverse(y.b)) / e;
}
// Light x moved toward display colour d by t as the display shows the two: exactly that mix under the
// curve's white, x itself at t = 0, and light past white keeping what it has over it.
fn mixAsShown(x: vec3<f32>, d: vec3<f32>, t: f32) -> vec3<f32> {
  let v = max(x, vec3<f32>(0.0));
  let s = shownOf(v);
  return max(v + lightOf(mix(s, d, t)) - lightOf(s), vec3<f32>(0.0));
}
` : ""}
// Wind (B6): windOffset in wind.ts, term for term — how far a vertex at (x, z) in its
// mesh's space, bending sway metres per unit of wind, moves this frame.
fn windOffsetIn(w: vec4<f32>, p: vec2<f32>, sway: f32) -> vec2<f32> {
  if (sway <= 0.0 || (w.x == 0.0 && w.y == 0.0)) { return vec2<f32>(0.0); }
  let t = w.z;
  let s = 0.5 + 0.35 * sin(6.283185307179586 * 8.0 * t + 0.7 * (p.x + p.y)) + 0.15 * sin(6.283185307179586 * 24.0 * t + 1.9 * p.x - 1.3 * p.y);
  let g = 1.0 + w.w * (0.5 + 0.5 * sin(6.283185307179586 * t + 0.05 * (p.x + p.y)));
  return w.xy * (sway * s * g);
}
fn windOffset(p: vec2<f32>, sway: f32) -> vec2<f32> { return windOffsetIn(u.wind0, p, sway); }
@vertex
fn vs(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) uv2: vec2<f32>,
  @location(4) bw: f32,
  @location(5) sway: f32,
  @location(7) tangent: vec4<f32>,
  @builtin(instance_index) instance: u32,
) -> VSOut {
  return vertexOf(position, normal, uv, uv2, bw, sway, tangent, instance);
}
fn vertexOf(position: vec3<f32>, normal: vec3<f32>, uv: vec2<f32>, uv2: vec2<f32>, bw: f32, sway: f32, tangent: vec4<f32>, instance: u32) -> VSOut {
  var out: VSOut;
  let t = xf[instance];
  var pos = position;
  let bend = windOffset(position.xz, sway);
  pos = vec3<f32>(pos.x + bend.x, pos.y, pos.z + bend.y);
  out.pos = t.mvp * vec4<f32>(pos, 1.0);
  out.normal = t.nrm * normal;
  out.uv = uv;
  out.uv2 = uv2;
  out.bw = bw;
  out.lightClip = t.lightMvp * vec4<f32>(pos, 1.0);
  out.worldPos = (t.model * vec4<f32>(pos, 1.0)).xyz;
  out.eyeDepth = out.pos.w; // clip w = view depth, for distance fog
  out.objPos = pos;
${hdr ? `  // A tangent lies in the surface, so it moves with the model's own 3×3; a mirroring one flips the bitangent.
  let m3 = mat3x3<f32>(t.model[0].xyz, t.model[1].xyz, t.model[2].xyz);
  out.tangent = vec4<f32>(normalize(m3 * tangent.xyz + vec3<f32>(1e-12, 0.0, 0.0)), tangent.w * select(1.0, -1.0, determinant(m3) < 0.0));
  out.frameNormal = normalize(out.normal);
` : ""}  return out;
}

${graphNoiseSource("wgsl")}
// --- Living terrain (BEAVER_CREEK_ROADMAP.md B6): sampleTriplanar and heightBlend, term for term ---
// A map by the UVs, or by triplanar projection in the mesh's space off the geometric normal.
fn triMap(t: texture_2d<f32>, uv: vec2<f32>, normal: vec3<f32>, objPos: vec3<f32>) -> vec4<f32> {
  if (u.terrain0.x <= 0.0) { return textureSample(t, samp, uv); }
  let n = normalize(normal);
  let a = n * n;
  var w = a * a;
  w = w / max(w.x + w.y + w.z, 1e-30);
  let p = objPos * (1.0 / u.terrain0.x);
  return textureSample(t, samp, vec2<f32>(p.z, 1.0 - p.y)) * w.x + textureSample(t, samp, vec2<f32>(p.x, 1.0 - p.z)) * w.y + textureSample(t, samp, vec2<f32>(p.x, 1.0 - p.y)) * w.z;
}
// --- Landscape materials (EDITOR_PRO_ROADMAP.md P2b): farTileBlend and macroGain, term for term ---
// The base map tiled ${1 / FAR_TILE_SCALE}× larger, by the raw UVs or triplanar projection.
fn triMapFar(t: texture_2d<f32>, p0: vec2<f32>, normal: vec3<f32>, objPos: vec3<f32>) -> vec4<f32> {
  if (u.terrain0.x <= 0.0) { return textureSample(t, samp, vec2<f32>(p0.x * ${FAR_TILE_SCALE.toFixed(4)}, 1.0 - p0.y * ${FAR_TILE_SCALE.toFixed(4)})); }
  let n = normalize(normal);
  let a = n * n;
  var w = a * a;
  w = w / max(w.x + w.y + w.z, 1e-30);
  let p = objPos * (1.0 / (u.terrain0.x / ${FAR_TILE_SCALE.toFixed(4)}));
  return textureSample(t, samp, vec2<f32>(p.z, 1.0 - p.y)) * w.x + textureSample(t, samp, vec2<f32>(p.x, 1.0 - p.z)) * w.y + textureSample(t, samp, vec2<f32>(p.x, 1.0 - p.y)) * w.z;
}
fn farTileBlend(depth: f32, distance: f32) -> f32 {
  let t = clamp((depth - distance * 0.25) / (distance * 0.75), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
fn macroGain(p: vec3<f32>) -> f32 {
  return 1.0 + u.terrain0.z * (2.0 * gNoise(p * u.terrain0.w, ${MACRO_OCTAVES}) - 1.0);
}
fn blendHeightOf(c: vec3<f32>) -> f32 { return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b; }
fn heightBlend(w: f32, base: f32, blend: f32, s: f32) -> f32 {
  return clamp((w - 0.5 + 0.5 * s * (blend - base)) / (1.0 - 0.9 * s) + 0.5, 0.0, 1.0);
}
// --- Water (BEAVER_CREEK_ROADMAP.md B5): waterTilt in materialEffects.ts, term for term ---
fn waterLayer(p: vec2<f32>, phase: f32, d: vec2<f32>) -> f32 {
  return gNoise1(vec3<f32>(p.x + d.x * phase, p.y + d.y * phase, 0.0)) + 0.5 * gNoise1(vec3<f32>(2.1 * p.x - d.y * phase * 0.7, 2.1 * p.y + d.x * phase * 0.7, 7.0));
}
fn waterHeight(q: vec2<f32>, d: vec2<f32>) -> f32 {
  let a = u.water0.z;
  let wa = 1.0 - abs(1.0 - 2.0 * a);
  return waterLayer(q, a * ${WATER_PERIOD.toFixed(1)}, d) * wa + waterLayer(q + vec2<f32>(53.0, 17.0), fract(a + 0.5) * ${WATER_PERIOD.toFixed(1)}, d) * (1.0 - wa);
}
// Water flowing along the UVs (EDITOR_PRO_ROADMAP.md P3): the fragment's UVs and
// their world gradients, set in fs before any waterNormal.
var<private> wUv: vec2<f32>;
var<private> wGu: vec3<f32>;
var<private> wGv: vec3<f32>;
// N tilted by the ripples at world point wp (N itself when the draw has no water) —
// or, flowing along the UVs, at wUv, turned into the world by wGu and wGv (waterTiltAlong).
fn waterNormal(N: vec3<f32>, wp: vec3<f32>) -> vec3<f32> {
  if (u.water0.x <= 0.0) { return N; }
  let d = vec2<f32>(cos(u.water0.w), sin(u.water0.w));
  if (u.maps0.z > 0.5) {
    let lu = length(wGu);
    let lv = length(wGv);
    if (lu <= 0.0 || lv <= 0.0) { return N; }
    let qa = wUv * u.water0.y;
    let ha = waterHeight(qa, d);
    let ka = -u.water0.x * ${(WATER_TILT / WATER_STEP).toFixed(4)};
    let su = (waterHeight(qa + vec2<f32>(${WATER_STEP.toFixed(4)}, 0.0), d) - ha) * ka;
    let sv = (waterHeight(qa + vec2<f32>(0.0, ${WATER_STEP.toFixed(4)}), d) - ha) * ka;
    return normalize(N + su * wGu / lu + sv * wGv / lv);
  }
  let q = wp.xz * u.water0.y;
  let h = waterHeight(q, d);
  let k = -u.water0.x * ${(WATER_TILT / WATER_STEP).toFixed(4)};
  return normalize(N + vec3<f32>((waterHeight(q + vec2<f32>(${WATER_STEP.toFixed(4)}, 0.0), d) - h) * k, 0.0, (waterHeight(q + vec2<f32>(0.0, ${WATER_STEP.toFixed(4)}), d) - h) * k));
}
// --- Refraction (HALO_INFINITE_STYLE_ROADMAP.md I5; refraction.ts) ---
// The offset in pixels at a fragment with geometric normal N (facing the
// viewer) at world point P — refractionOffset, term for term.
fn refractOffset(N: vec3<f32>, P: vec3<f32>) -> vec2<f32> {
  var w = vec2<f32>(0.0);
  let warp = u.refract0.y + u.refract0.z;
  if (warp > 0.0) {
    let f = ${DISTORTION_FREQUENCY.toFixed(1)};
    let qy = P.y * f - u.effect1.w * ${DISTORTION_SPEED.toFixed(4)};
    w = vec2<f32>(2.0 * gNoise1(vec3<f32>(P.x * f, qy, P.z * f)) - 1.0, 2.0 * gNoise1(vec3<f32>(P.x * f + 17.0, qy + 31.0, P.z * f + 47.0)) - 1.0) * warp;
  }
  let k = ${REFRACTION_SCALE.toFixed(4)} * u.refract1.w;
  return vec2<f32>(u.refract0.x * dot(N, u.refract1.xyz) + w.x, -u.refract0.x * dot(N, u.refract2.xyz) + w.y) * k;
}
// What a refracting fragment at screen point frag, depth z, sees (rgb, a = 1
// when it sees anything) — refractedPixel: the pushed pixel when the opaque
// scene drew it behind the fragment, else the pixel straight behind.
fn behindColour(frag: vec2<f32>, z: f32, off: vec2<f32>) -> vec4<f32> {
  let dims = vec2<f32>(textureDimensions(sceneColour, 0));
  let s = vec2<i32>(clamp(floor(frag + off), vec2<f32>(0.0), dims - vec2<f32>(1.0)));
  let c = textureLoad(sceneColour, s, 0);
  if (c.a > 0.5 && textureLoad(sceneDepth, s, 0) >= z) { return vec4<f32>(c.rgb, 1.0); }
  let o = textureLoad(sceneColour, vec2<i32>(floor(frag)), 0);
  if (o.a > 0.5) { return vec4<f32>(o.rgb, 1.0); }
  return vec4<f32>(0.0);
}
// The geometric normal facing the viewer (refraction bends by it, as the CPU does).
fn facingNormal(n: vec3<f32>) -> vec3<f32> {
  let g = normalize(n);
  return select(g, -g, dot(g, u.view.xyz) < 0.0);
}
// A refracting surface over what it bends: under a blend, added to by an
// addition, or let through at a shield's silhouette — finishAlpha with the
// bent scene for the destination, so the pixel ends covered.
fn finishRefracted(rgb: vec3<f32>, a: f32, bg: vec3<f32>, N: vec3<f32>) -> vec4<f32> {
  let c = ${hdr ? "max(rgb, vec3<f32>(0.0))" : "clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0))"};
  if (u.pbr.w > 2.5) { return vec4<f32>(c * a + bg, 1.0); }
${hdr
  ? `  // A tint authored for the display (F11a): linear light mixes it as the display shows the two, as the
  // byte path does, or a dark one (Beaver Creek's water) only dims what is behind and its colour is lost.
  if (u.pbr.w > 1.5) { return vec4<f32>(lightOf(mix(shownOf(bg), shownOf(c), a)), 1.0); }`
  : "  if (u.pbr.w > 1.5) { return vec4<f32>(c * a + bg * (1.0 - a), 1.0); }"}
  let t = u.refract0.z * pow(1.0 - max(0.0, dot(N, u.view.xyz)), ${EFFECT_DISTORT_POWER.toFixed(4)});
  return vec4<f32>(mix(c, bg, t), 1.0);
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
${hdr ? "  shadowPixel = in.pos.xy;\n  // Overdraw (F10a): every fragment shaded counts one, added up in red.\n  if (frame.debug.x > 10.5 && frame.debug.x < 11.5) { return vec4<f32>(1.0, 0.0, 0.0, 0.0); }\n" : ""}  // The surface's screen derivatives, for the UV gradients parallax and
  // anisotropy need (I4) — taken here, in uniform control flow.
  let dp1 = dpdx(in.worldPos);
  let dp2 = dpdy(in.worldPos);
  let duv1 = dpdx(in.uv);
  let duv2 = dpdy(in.uv);
  // Every map is sampled at puv: the interpolated UVs, or where the view ray
  // meets the relief (parallax occlusion, I4).
  var puv = ${hdr ? "khrUv(in.uv)" : "in.uv"};
  if (u.pbr.z > 0.5 && u.layer0.w > 0.0) {
    var pn = normalize(in.normal);
    if (dot(pn, u.view.xyz) < 0.0) { pn = -pn; }
    let pg = uvGrads(pn, dp1, dp2, duv1, duv2);
    let pv = max(${PARALLAX_MIN_NDV}, dot(pn, u.view.xyz));
    puv = parallaxUv(in.uv, -vec2<f32>(dot(pg.gu, u.view.xyz), dot(pg.gv, u.view.xyz)) / pv, u.layer0.w);
  }
  // glTF's V origin is top-left, so flip; the sampler wraps and (per era) filters.
  let uv = vec2<f32>(puv.x, 1.0 - puv.y);
  wUv = puv;
  wGu = vec3<f32>(0.0);
  wGv = vec3<f32>(0.0);
  if (u.maps0.z > 0.5) {
    let wg = uvGrads(normalize(in.normal), dp1, dp2, duv1, duv2);
    wGu = wg.gu;
    wGv = wg.gv;
  }
  // Normal mapping (EDITOR_PRO_ROADMAP.md P1a): the tangent-space normal map in
  // the vertex's stored frame on the AAA tier (F1c), else the triangle's from the
  // screen derivatives (mappedNormal). sNrm is what lights the surface; the
  // clearcoat, refraction and shadow bias keep the geometric normal.
  var sNrm = in.normal;
  let tnSample = textureSample(nrmTex, samp, uv).rgb * 2.0 - 1.0;
  if (u.maps0.x > 0.5) { sNrm = mappedNormal(in.normal, ${hdr ? "in.tangent, in.frameNormal" : "vec4<f32>(0.0), in.normal"}, tnSample, dp1, dp2, duv1, duv2); }

  var colour = u.base;
  if (u.texflags.x > 0.5) {
    var texel = triMap(tex, uv, in.normal, in.objPos);
    // Distance tiling (P2b): far off, the map blends to itself tiled larger.
    if (u.maps0.y > 0.0) { texel = mix(texel, triMapFar(tex, puv, in.normal, in.objPos), farTileBlend(in.eyeDepth, u.maps0.y)); }
    colour = colour * texel;
  }
  // Macro variation (P2b): broad lighter and darker patches over the whole surface.
  if (u.terrain0.z > 0.0) { colour = vec4<f32>(colour.rgb * macroGain(in.objPos), colour.a); }
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
    // …its dropped pixels showing the scene behind, bent (I5). Kept, not
    // returned, here: the samples below must stay in uniform control flow.
    var camoSeen = vec4<f32>(0.0);
    if (u.effect0.w > 0.0 && camoThreshold(in.pos.xy, u.effect1.w) < u.effect0.w) {
      if (u.refract0.w > 0.5) { camoSeen = behindColour(in.pos.xy, in.pos.z, refractOffset(facingNormal(in.normal), in.worldPos)); }
      if (camoSeen.a < 0.5) { discard; }
    }
    // --- Modern tier: metallic-roughness BRDF (Cook-Torrance) ---
    // Mirrors the software rasteriser's PBR branch (meshRasterizer.ts) term for
    // term, in the engine's non-linear byte space (a linear/HDR pipeline is a
    // later phase). Small float32-vs-float64 differences from pow/GGX are
    // expected; the fantasy path below stays byte-identical. The linear-light
    // variant (the AAA tier) departs from it for the AAA BRDF (F1c, brdf.ts).
    var N = normalize(sNrm);
    if (dot(N, u.view.xyz) < 0.0) { N = -N; } // two-sided: flip toward the viewer
    N = waterNormal(N, in.worldPos);
    coatN = waterNormal(facingNormal(in.normal), in.worldPos);
    coatNdv = max(1e-4, dot(coatN, u.view.xyz));
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
    // The blend surface (H4), its weight moved by the two surfaces' heights (B6).
    let blendTexel = triMap(blendTex, uv, in.normal, in.objPos).rgb;
    var bwt = in.bw;
    var bc = u.surface3.rgb;
    if (u.surface1.z > 0.5) {
      if (u.surface1.w > 0.5) { bc = bc * blendTexel; }
      if (u.terrain0.y > 0.0) { bwt = heightBlend(in.bw, blendHeightOf(colour.rgb), blendHeightOf(bc), u.terrain0.y); }
    }
    if (u.surface1.z > 0.5 && u.surface3.w >= 0.0) { rough = mix(rough, u.surface3.w, bwt); }
${g.pbr}
    rough = clamp(rough, 0.045, 1.0); // a perfectly-smooth NDF blows up
    var ao = 1.0;
    if (u.texflags.z > 0.5) { ao = textureSample(occTex, samp, uv).r; }
    // Anisotropy (I4): the grain's tangent, U's gradient laid in the surface and
    // turned about N, and the bitangent across it (round without a gradient).
    aniso = 0.0;
    if (u.layer0.z != 0.0) {
      let ag = uvGrads(N, dp1, dp2, duv1, duv2);
      let t0 = ag.gu - N * dot(ag.gu, N);
      if (length(t0) > 1e-8) {
        let tn = normalize(t0);
        aT = u.layer1.x * tn + u.layer1.y * cross(N, tn);
        aB = cross(N, aT);
        aniso = u.layer0.z;
      }
    }
    var albedo = colour.rgb;
    // A second surface blended in by the (height-blended) vertex weight (snow drifting over rock).
    if (u.surface1.z > 0.5) { albedo = mix(albedo, bc, bwt); }
    // A detail map, tiled finely and blended in up close (mid-grey neutral),
    // fading with eye depth — mirrors the software path.
    let dk = u.surface0.y * clamp((${DETAIL_FAR.toFixed(4)} - in.eyeDepth) / ${(DETAIL_FAR - DETAIL_NEAR).toFixed(4)}, 0.0, 1.0);
    let detail = textureSample(detailTex, samp, vec2<f32>(puv.x * u.surface0.x, 1.0 - puv.y * u.surface0.x)).rgb;
    if (dk > 0.0) { albedo = albedo * (vec3<f32>(1.0) + dk * (2.0 * detail - vec3<f32>(1.0))); }
    // The material's colour, built in authored space, into light (F0b's linear variant).
    albedo = toLinear(albedo);
${hdr ? `    // Projected decals (F1f): the boxes round this point, laid over the surface before it is lit.
    var decalGlow = vec3<f32>(0.0);
    if (u.motion0.z > 0.5) {
      let dc = applyDecals(in.worldPos, Decalled(albedo, rough, ao, metallic, N, vec3<f32>(0.0)));
      albedo = dc.albedo;
      rough = dc.rough;
      ao = dc.ao;
      metallic = dc.metallic;
      N = dc.N;
      decalGlow = dc.glow;
    }
    // View modes (F10a): the albedo as it shades, and lighting only's white dielectric in its place.
    let vmAlbedo = albedo;
    let vmMetallic = metallic;
    if (frame.debug.x > 6.5 && frame.debug.x < 7.5) {
      albedo = vec3<f32>(1.0);
      metallic = 0.0;
    }
` : ""}
    let L = u.light.xyz;
    let V = u.view.xyz;
    let H = normalize(L + V);
    let ndl = max(0.0, dot(N, L));
    let ndv = max(1e-4, dot(N, V));
    let ndh = max(0.0, dot(N, H));
    let vdh = max(0.0, dot(V, H));
    let a2 = rough * rough * rough * rough;   // (rough^2)^2 for the GGX NDF
    let dd = ndh * ndh * (a2 - 1.0) + 1.0;
    var D = a2 / (3.14159265 * dd * dd + 1e-7);
    if (aniso != 0.0) { D = anisoD(rough, aniso, dot(aT, H), dot(aB, H), ndh); }
    let k = ((rough + 1.0) * (rough + 1.0)) / 8.0; // Schlick-GGX (direct)
    let fp = pow(1.0 - vdh, 5.0);              // Fresnel-Schlick
${hdr
  ? `    // The AAA BRDF (F1c, brdf.ts): the height-correlated Smith visibility, the
    // specular normalised against a diffuse of albedo (π), and the split-sum
    // DFG for the environment, multiple scattering and specular occlusion.
    let specD = D * smithVisibility(ndl, ndv, a2) * 3.14159265;`
  : `    let G = (ndv / (ndv * (1.0 - k) + k)) * (ndl / (ndl * (1.0 - k) + k));
    let specD = (D * G) / (4.0 * ndl * ndv + 1e-4);`}
${hdr
  ? `    // A dielectric's reflectance from its IOR and specular (F1d), and a thin film's over it.
    var f0 = mix(u.spec0.rgb, albedo, metallic);
    if (u.trans1.w > 0.0) { f0 = mix(f0, iridescenceF0(ndv, f0), u.trans1.w); }`
  : "    let f0 = vec3<f32>(0.04) + (albedo - vec3<f32>(0.04)) * metallic;"}
    let F = f0 + (vec3<f32>(1.0) - f0) * fp;
${hdr
  ? `    // GTAO (F3c): its visibility joins the material's occlusion (diffuse and specular alike), and its
    // bent normal is where the sky's irradiance comes from.
    let gt = gtaoAt(in.pos.xy);
    let matAo = ao;
    ao = ao * gtaoBounce(gt.w, dot(albedo, vec3<f32>(0.2126, 0.7152, 0.0722)));
    // SSGI (F3e-2): the near field's own light where its rays met something, the far field's where they
    // didn't. The rays' hits already hold the occlusion GTAO measures, so the diffuse then takes only the material's.
    let ssgi = ssgiAt(in.pos.xy);
    let aoD = select(ao, matAo, frame.cascadeSoft.w > 0.5 && u.pbr.w < 1.5);
    let skyN = select(N, gt.xyz, dot(gt.xyz, gt.xyz) > 0.25);
    let dfg = dfgAt(ndv, rough);
    eComp = energyCompensation(f0, dfg);
    let specE = specularEnergy(f0, dfg);
    var specAo = specularOcclusion(ndv, ao, rough * rough);
    // The sheen (F1d) takes what it reflects from the layer beneath.
    sheenScale = 1.0 - max(u.sheen0.r, max(u.sheen0.g, u.sheen0.b)) * sheenE(ndv, u.sheen0.w);
    // An HDR directional light map (F3d) lights the diffuse in place of the sky's irradiance, and its sky
    // visibility occludes the environment's reflection. Both layers are sampled whatever is bound (uniform
    // control flow); an 8-bit map's single layer stands in for the second.
    let lmUv = vec2<f32>(in.uv2.x, 1.0 - in.uv2.y);
    let lm0 = textureSample(lmTex, samp, lmUv, 0);
    let lm1 = textureSample(lmTex, samp, lmUv, 1);
    let lmHdr = u.ssaoMeta.z > 1.5;
    // Baked diffuse light in place of the sky's: the HDR light map's, or, for a surface without a light map,
    // the probe volume's (F3d-3), with its sky visibility.
    var baked = lmHdr;
    var bakedIrr = vec3<f32>(0.0);
    if (lmHdr) {
      bakedIrr = lightmapIrradiance(lm0.rgb, lm1.xyz, N, in.normal);
      specAo = specAo * lm1.w;
    } else if (u.ssaoMeta.z < 0.5 && frame.probeMin.w > 1.5) {
      let pv = probeVolumeAt(in.worldPos, N);
      if (pv.w >= 0.0) {
        baked = true;
        bakedIrr = pv.rgb;
        specAo = specAo * pv.w;
      }
    }
    // What the environment's reflection takes, the material's reflectivity scaling it but never past all
    // the light (F11a): reflectivity over 1 (Beaver Creek's water is 1.3) mirrored more than came in at grazing.
    let specK = min(specE * reflectK, vec3<f32>(1.0));
`
  : ""}    let kdm = (1.0 - metallic)${hdr ? " * (1.0 - u.trans0.x)" : ""};                  // metals have no diffuse${hdr ? "; what is transmitted (F1d) neither" : ""}
    var emis = vec3<f32>(0.0);
    let ef = u.emissive.xyz;
    if (ef.r > 0.0 || ef.g > 0.0 || ef.b > 0.0) {
      var es = vec3<f32>(1.0);
      if (u.texflags.w > 0.5) { es = textureSample(emisTex, samp, vec2<f32>(puv.x + u.surface1.x, 1.0 - (puv.y + u.surface1.y))).rgb; }
      emis = ef * es;
    }
${g.emis}
    emis = toLinear(emis)${hdr ? " * u.irid0.z" : ""};${hdr ? "\n    emis = emis + decalGlow;" : ""}
    // Ambient / image-based lighting, mirroring the software rasteriser: with an
    // environment, a diffuse irradiance along N + a specular reflection along R
    // blurred toward the average by roughness; without one, the flat ambient.
${reflect ? "    var envSpec = vec3<f32>(0.0);\n    var envSeen = vec3<f32>(0.0);\n" : ""}    var amb: vec3<f32>;
    var coatV = 0.0;
    if (u.envSky.w > 0.5) {
      ${hdr ? `// The irradiance over the hemisphere (F3a), not the radiance along N; or the light map's (F3d).
      let irr = select(shIrradiance(skyN), bakedIrr, baked);` : "let irr = envColorDir(N);"}
      // Brushed metal (I4) reflects about a normal bent across its grain.
      var Rn = N;
      if (aniso != 0.0) {
        let ad = select(aT, aB, aniso > 0.0);
        let an = cross(cross(ad, V), ad);
        Rn = normalize(mix(N, an, abs(aniso) * min(1.0, 4.0 * rough)));
      }
      var rdv = ndv;
      if (aniso != 0.0) { rdv = dot(Rn, V); }
      let pref = envReflect(in.worldPos, 2.0 * rdv * Rn - V, rough);
${hdr
  ? "      // What the environment's reflection takes, the diffuse beneath it no longer receives.\n      amb = (irr * (1.0 - ssgi.a) + ssgi.rgb) * albedo * kdm * (vec3<f32>(1.0) - specE) * aoD + pref * specK * specAo;\n      // The sheen over it (F1d), lit by the sky's irradiance.\n      amb = amb * sheenScale + irr * u.sheen0.rgb * sheenE(ndv, u.sheen0.w) * aoD;\n"
  : "      amb = (irr * albedo * kdm + pref * f0 * reflectK) * ao;\n"}${reflect ? `      envSpec = pref * ${hdr ? "specK * specAo" : "f0 * reflectK * ao"};\n      envSeen = pref;\n` : ""}      // The clearcoat (I4) reflects the room sharply about its own normal, and
      // what it reflects the base beneath no longer receives.
      if (u.layer0.x > 0.0) {
        let prefC = envReflect(in.worldPos, 2.0 * coatNdv * coatN - V, u.layer0.y);
        coatV = u.layer0.x * (${CLEARCOAT_F0} + (1.0 - ${CLEARCOAT_F0}) * pow(1.0 - coatNdv, 5.0));
        amb = amb * (1.0 - coatV) + coatV * prefC * reflectK * ao;
${reflect ? "        envSpec = envSpec * (1.0 - coatV) + coatV * prefC * reflectK * ao;\n" : ""}      }
    } else {
      amb = ${hdr ? "(select(toLinear(vec3<f32>(u.light.w)), bakedIrr * kdm, baked) * (1.0 - ssgi.a) + ssgi.rgb * kdm) * albedo * aoD" : "toLinear(vec3<f32>(u.light.w)) * albedo * ao"};
    }
${reflect ? "    let ambRaw = amb;\n" : ""}    // A baked light map (the second UV set) scales the sky/ambient fill by how
    // much of it reaches this point, bounce included — mirroring the CPU path.
    // Sampled unconditionally (uniform control flow), applied when bound.
${hdr
  ? `    // (An HDR one, F3d, lit the fill above.)
    if (u.ssaoMeta.z > 0.5) { if (!lmHdr) { amb = amb * lm0.rgb * ${LIGHTMAP_RANGE}; } }`
  : `    let lmUv = vec2<f32>(in.uv2.x, 1.0 - in.uv2.y);
    let lm = textureSample(lmTex, samp, lmUv).rgb * ${LIGHTMAP_RANGE};
    if (u.ssaoMeta.z > 0.5) { amb = amb * lm; }`}
    else if (frame.probeMin.w > 0.5 && frame.probeMin.w < 1.5) { amb = amb * probeLight(in.worldPos, N); } // EP9: no light map, the probes light it
    // Screen-space AO darkens only the ambient fill, sampled at this fragment's
    // framebuffer pixel (matching the software path's ssao[di]).
    // (With GTAO, F3c, the slot holds its visibility instead, already in the occlusion above.)
    if (u.ssaoMeta.x > 0.5 && frame.cascadeSoft.z < 0.5) {
      amb = amb * ssaoTexel(vec2<i32>(in.pos.xy)).r;
    }
${reflect ? "    // What the light map, probes and SSAO did to the fill, they do to its reflection.\n    let occl = select(vec3<f32>(1.0), amb / max(ambRaw, vec3<f32>(1e-6)), ambRaw > vec3<f32>(1e-6));\n    envSpec = envSpec * occl;\n" : ""}    // The direct light is what a shadow occludes; ambient/IBL still fills it.
    let sf = shadowFactor(in.lightClip, in.worldPos, abs(dot(normalize(in.normal), u.light.xyz)));
    let lc = i32(u.ssaoMeta.y + 0.5);
    var lit: vec3<f32>;
    var vmLights = 0;
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
      vmLights = ng;
      // …the rest only the cells they touch (EP8): this fragment's cell, by pixel and depth.
      if (frame.clusterInfo.y > 0.5 && in.eyeDepth >= frame.clusterParams.z) {
        let tile = min(vec2<u32>(in.pos.xy / frame.clusterParams.xy), vec2<u32>(${CLUSTER_X - 1}u, ${CLUSTER_Y - 1}u));
        let slice = min(u32(log(in.eyeDepth / frame.clusterParams.z) * frame.clusterParams.w), ${CLUSTER_Z - 1}u);
        let cell = clusterCell((slice * ${CLUSTER_Y}u + tile.y) * ${CLUSTER_X}u + tile.x);
        vmLights = vmLights + i32(cell.y);
        for (var j = 0u; j < cell.y; j = j + 1u) {
          direct = direct + lightTerm(lights[clusterLight(cell.x + j)], in.worldPos, N, V, ndv, a2, k, f0, kdm, albedo, sf);
        }
      }
      lit = direct + amb + emis;
    } else if (u.layer0.x > 0.0) {
      // The clearcoat's own highlight, over a base its Fresnel dims (I4).
      let c = coatTerm(coatN, coatNdv, L, H, vdh);
      lit = (((kdm * (vec3<f32>(1.0) - F) * albedo + F * specD${hdr ? " * eComp" : ""})${hdr ? " * sheenScale + sheenLobe(ndl, ndv, ndh)" : ""}) * ndl * (1.0 - c.y) + vec3<f32>(c.x)) * sf + amb + emis;
    } else {
      lit = ((kdm * (vec3<f32>(1.0) - F) * albedo + F * specD${hdr ? " * eComp" : ""})${hdr ? " * sheenScale + sheenLobe(ndl, ndv, ndh)" : ""}) * ndl * sf + amb + emis;
    }
    // A fresnel rim, light at grazing angles (zero when the material has none).
    lit = lit + toLinear(u.surface2.rgb) * pow(1.0 - ndv, u.surface2.w);
    // A surface effect's glow, and its bands climbing the body (zero without one).
    let band = pow(0.5 + 0.5 * sin(in.worldPos.y * ${EFFECT_BAND_FREQUENCY.toFixed(1)} - u.effect1.w * ${EFFECT_BAND_SPEED.toFixed(1)}), ${EFFECT_BAND_POWER.toFixed(1)});
    lit = lit + toLinear(u.effect0.rgb) + toLinear(u.effect1.rgb) * band;
    // HDR: expose + ACES roll-off, or write the linear colour straight through.
    var shaded = lit;
${wgslDisplay("shaded", hdr)}${hdr ? VIEW_MODE_SHADE : ""}${reflect ? /* wgsl */ `
    // Reflections (I3): the same without the environment's reflection, so the pass can take it away.
    var without = lit - envSpec;
${wgslDisplay("without", hdr)}
${hdr
  ? `    // Linear light (F0b): what the reflection adds, and what it sees, unclamped.
    let contribution = max(shaded - without, vec3<f32>(0.0));
    let seen = max(envSeen, vec3<f32>(0.0));`
  : `    let contribution = max(clamp(shaded, vec3<f32>(0.0), vec3<f32>(1.0)) - clamp(without, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(0.0));
    var seen = envSeen;
    if (u.tonemap.x > 0.5) { seen = vec3<f32>(aces(seen.r * u.tonemap.y), aces(seen.g * u.tonemap.y), aces(seen.b * u.tonemap.y)); }
    seen = clamp(seen, vec3<f32>(0.0), vec3<f32>(1.0));`}
    let weight = ${hdr ? "(specK * specAo * (1.0 - coatV) + vec3<f32>(coatV * ao * reflectK)) * occl" : "(f0 * (1.0 - coatV) + vec3<f32>(coatV)) * reflectK * ao * occl"};
    reflectOut = vec4<f32>(clamp(select(weight, contribution / max(seen, vec3<f32>(1e-3)), seen > vec3<f32>(0.02)), vec3<f32>(0.0), vec3<f32>(1.0)), mix(rough, u.layer0.y, u.layer0.x));
    envOut = vec4<f32>(contribution, 1.0);` : ""}
    // Refraction (I5): what's behind is the opaque scene, bent.
    if (camoSeen.a > 0.5) { return vec4<f32>(camoSeen.rgb, 1.0); }${hdr ? `
    // Transmission (F1d): the light behind let through what the reflection leaves, tinted by the
    // base colour and by the volume's absorption over its thickness (Beer–Lambert).
    if (u.trans0.x > 0.0 && u.refract0.w > 0.5) {
      let tb = behindColour(in.pos.xy, in.pos.z, refractOffset(facingNormal(in.normal), in.worldPos));
      if (tb.a > 0.5) {
        var absorb = vec3<f32>(1.0);
        if (u.trans0.y > 0.0 && u.trans0.z > 0.0) { absorb = pow(max(u.trans1.rgb, vec3<f32>(1e-4)), vec3<f32>(u.trans0.y / u.trans0.z)); }
        let through = u.trans0.x * (1.0 - metallic) * (vec3<f32>(1.0) - specE) * albedo * absorb * tb.rgb;
        return vec4<f32>(shaded + through, 1.0);
      }
    }` : ""}
    if (u.refract0.w > 0.5) {
      let rn = waterNormal(facingNormal(in.normal), in.worldPos);
      let b = behindColour(in.pos.xy, in.pos.z, refractOffset(rn, in.worldPos));
      if (b.a > 0.5) { return finishRefracted(shaded, colour.a, b.rgb, rn); }
    }
    return finishAlpha(shaded, colour.a);
  }

  // --- Fantasy path (byte-identical when no shadow; shadow scales the direct term) ---
  // Two-sided Lambert: abs(N·L) so inconsistent winding still lights. The normal
  // is deliberately NOT renormalised — the software rasteriser interpolates and
  // dots without normalising, and parity with it is the contract here. Both
  // therefore skew identically under non-uniform scale.
  let nl = abs(dot(sNrm, u.light.xyz));
  let shade = u.light.w + (1.0 - u.light.w) * nl * shadowFactor(in.lightClip, in.worldPos, abs(dot(normalize(in.normal), u.light.xyz)));
  return finishAlpha(toLinear(colour.rgb) * shade, colour.a);
}

${hdr ? `// --- The sun's cascades (AAA_FIDELITY_ROADMAP.md F2a) ---
// A caster's depth as the sun sees it, through the cascade being drawn: the scene's
// own vertex (its copy's transform, bent by the wind) and nothing else.
@group(1) @binding(12) var<uniform> cascadeView: mat4x4<f32>;
fn casterClip(position: vec3<f32>, sway: f32, instance: u32) -> vec4<f32> {
  let bend = windOffset(position.xz, sway);
  return cascadeView * xf[instance].model * vec4<f32>(position.x + bend.x, position.y, position.z + bend.y, 1.0);
}
@vertex
fn vs_shadow(@location(0) position: vec3<f32>, @location(5) sway: f32, @builtin(instance_index) instance: u32) -> @builtin(position) vec4<f32> {
  return casterClip(position, sway, instance);
}
// A cut-out caster (F2a-2): its UVs carried through, so its fragments drop as the scene's do.
struct CutOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs_shadow_cut(@location(0) position: vec3<f32>, @location(2) uv: vec2<f32>, @location(5) sway: f32, @builtin(instance_index) instance: u32) -> CutOut {
  var out: CutOut;
  out.pos = casterClip(position, sway, instance);
  out.uv = uv;
  return out;
}
// The scene's own cut-out test: the base colour's alpha, times its map's, against the material's threshold.
@fragment
fn fs_shadow_cut(in: CutOut) {
  var a = u.base.a;
  if (u.texflags.x > 0.5) { a = a * textureSample(tex, samp, vec2<f32>(in.uv.x, 1.0 - in.uv.y)).a; }
  if (a < u.view.w) { discard; }
}
` : ""}
// --- The depth prepass and thin G-buffer (AAA_FIDELITY_ROADMAP.md F0c) ---
// A unit normal folded onto the octahedron, then the square: two signed numbers.
fn octEncode(n: vec3<f32>) -> vec2<f32> {
  let p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z >= 0.0) { return p; }
  return (vec2<f32>(1.0) - abs(p.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), p >= vec2<f32>(0.0));
}
// The prepass's vertex stage: the scene's own (vertexOf, so the depth is the
// same), plus where the vertex is on screen now and was last frame, from this
// frame's motion transforms (xf from u.motion0.x: mvp = now, lightMvp = then,
// both unjittered) and the vertex's previous position (a skinned mesh's last
// vertices; its current ones otherwise) bent by the previous frame's wind.
struct PrepassIn {
  @builtin(position) @invariant pos: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) @interpolate(perspective, centroid) uv: vec2<f32>,
  @location(2) lightClip: vec4<f32>,
  @location(3) worldPos: vec3<f32>,
  @location(4) eyeDepth: f32,
  @location(5) @interpolate(perspective, centroid) uv2: vec2<f32>,
  @location(6) bw: f32,
  @location(7) objPos: vec3<f32>,
  @location(8) clipNow: vec4<f32>,
  @location(9) clipThen: vec4<f32>,${hdr ? "\n  @location(10) tangent: vec4<f32>,\n  @location(11) frameNormal: vec3<f32>," : ""}
};
@vertex
fn vs_prepass(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) uv2: vec2<f32>,
  @location(4) bw: f32,
  @location(5) sway: f32,
  @location(6) before: vec3<f32>,
  @location(7) tangent: vec4<f32>,
  @builtin(instance_index) instance: u32,
) -> PrepassIn {
  let v = vertexOf(position, normal, uv, uv2, bw, sway, tangent, instance);
  var out: PrepassIn;
  out.pos = v.pos;
  out.normal = v.normal;
  out.uv = v.uv;
  out.lightClip = v.lightClip;
  out.worldPos = v.worldPos;
  out.eyeDepth = v.eyeDepth;
  out.uv2 = v.uv2;
  out.bw = v.bw;
  out.objPos = v.objPos;
${hdr ? "  out.tangent = v.tangent;\n  out.frameNormal = v.frameNormal;\n" : ""}  let m = xf[u32(u.motion0.x) + instance];
  let then = windOffsetIn(u.wind1, before.xz, sway);
  out.clipNow = m.mvp * vec4<f32>(v.objPos, 1.0);
  out.clipThen = m.lightMvp * vec4<f32>(before.x + then.x, before.y, before.z + then.y, 1.0);
  return out;
}
struct PrepassTargets {
  @location(0) gbuffer: vec4<f32>,
  @location(1) velocity: vec2<f32>,
};
// The prepass draws what the opaque pipeline draws, and drops exactly the
// pixels fs drops (the cut-out, the near-transparent, Active Camo's screen
// door), so the depth it leaves is the depth the opaque pass would. It writes
// the G-buffer: xy = the octahedral world normal facing the viewer (normal
// mapped), z = roughness, w = the material's ID (0 where nothing drew); and
// the velocity buffer: how far the surface moved on screen since last frame,
// in UV units (x right, y down), so a pixel's last position is uv − velocity.
@fragment
fn fs_prepass(in: PrepassIn) -> PrepassTargets {
  let dp1 = dpdx(in.worldPos);
  let dp2 = dpdy(in.worldPos);
  let duv1 = dpdx(in.uv);
  let duv2 = dpdy(in.uv);
  var puv = ${hdr ? "khrUv(in.uv)" : "in.uv"};
  if (u.pbr.z > 0.5 && u.layer0.w > 0.0) {
    var pn = normalize(in.normal);
    if (dot(pn, u.view.xyz) < 0.0) { pn = -pn; }
    let pg = uvGrads(pn, dp1, dp2, duv1, duv2);
    let pv = max(${PARALLAX_MIN_NDV}, dot(pn, u.view.xyz));
    puv = parallaxUv(in.uv, -vec2<f32>(dot(pg.gu, u.view.xyz), dot(pg.gv, u.view.xyz)) / pv, u.layer0.w);
  }
  let uv = vec2<f32>(puv.x, 1.0 - puv.y);
  var sNrm = in.normal;
  let tnSample = textureSample(nrmTex, samp, uv).rgb * 2.0 - 1.0;
  if (u.maps0.x > 0.5) { sNrm = mappedNormal(in.normal, ${hdr ? "in.tangent, in.frameNormal" : "vec4<f32>(0.0), in.normal"}, tnSample, dp1, dp2, duv1, duv2); }
  var colour = u.base;
  if (u.texflags.x > 0.5) {
    var texel = triMap(tex, uv, in.normal, in.objPos);
    if (u.maps0.y > 0.0) { texel = mix(texel, triMapFar(tex, puv, in.normal, in.objPos), farTileBlend(in.eyeDepth, u.maps0.y)); }
    colour = colour * texel;
  }
  let mr = textureSample(mrTex, samp, uv);
${g.base}
  if (colour.a * 255.0 < 1.0) { discard; }
  if (u.pbr.w > 0.5 && u.pbr.w < 1.5 && colour.a < u.view.w) { discard; }
  if (u.pbr.z > 0.5 && u.effect0.w > 0.0 && camoThreshold(in.pos.xy, u.effect1.w) < u.effect0.w) { discard; }
  var n = normalize(sNrm);
  if (dot(n, u.view.xyz) < 0.0) { n = -n; }
  var rough = u.pbr.y;
  if (u.texflags.y > 0.5) { rough = rough * mr.g; }
${graph ? "  if (gRough >= 0.0) { rough = gRough; }\n" : ""}  var velocity = vec2<f32>(0.0);
  if (in.clipNow.w > 0.0 && in.clipThen.w > 0.0) {
    velocity = (in.clipNow.xy / in.clipNow.w - in.clipThen.xy / in.clipThen.w) * vec2<f32>(0.5, -0.5);
  }
  return PrepassTargets(vec4<f32>(octEncode(n), clamp(rough, 0.0, 1.0), u.maps0.w), velocity);
}
`;
  return reflect ? withReflectionTargets(code) : code;
}

/**
 * The scene shader writing the reflection targets too (I3): the shading
 * becomes a function, and the entry point returns its colour with what it
 * left in the reflection variables. A see-through surface writes nothing but
 * its coverage there, so the blend keeps that share of what's behind it.
 */
function withReflectionTargets(code: string): string {
  const entry = "@fragment\nfn fs(in: VSOut) -> @location(0) vec4<f32> {";
  if (!code.includes(entry)) throw new Error("scene shader entry point not found");
  return code.replace(entry, "fn shade(in: VSOut) -> vec4<f32> {") + /* wgsl */ `
struct SceneOut {
  @location(0) colour: vec4<f32>,
  @location(1) reflect: vec4<f32>,
  @location(2) env: vec4<f32>,
};
var<private> reflectOut: vec4<f32>;
var<private> envOut: vec4<f32>;
@fragment
fn fs(in: VSOut) -> SceneOut {
  reflectOut = vec4<f32>(0.0);
  envOut = vec4<f32>(0.0);
  let c = shade(in);
  if (u.pbr.w > 1.5) { return SceneOut(c, vec4<f32>(0.0, 0.0, 0.0, c.a), vec4<f32>(0.0, 0.0, 0.0, c.a)); }
  return SceneOut(c, reflectOut, envOut);
}
`;
}

interface GpuPrimitive {
  vertexBuffer: any;
  indexBuffer: any;
  indexCount: number;
  /** The `dynamic.revision` last uploaded (skinned meshes rewrite their vertices each frame). */
  revision?: number;
  /** A dynamic primitive's vertices before its last upload, and the frame that upload was in (F0c's velocity). */
  previousBuffer?: any;
  movedFrame?: number;
}

/** What a frame's depth prepass leaves (F0c; see WebgpuSceneRenderer.prepassTargets). */
export interface PrepassTargets {
  readonly depth: any;
  readonly gbuffer: any;
  readonly velocity: any;
  readonly multisampled: boolean;
}

/** A normal basis the motion transforms carry but nothing reads. */
const IDENTITY_BASIS: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

interface CachedBindGroup {
  group: any;
  /** The decoded textures this group was built against, so a swap rebuilds it. */
  source: {
    base: DecodedTexture | null;
    mr: DecodedTexture | null;
    occ: DecodedTexture | null;
    emis: DecodedTexture | null;
    lm: DecodedTexture | null;
    lmHdr: HdrLightmap | null;
    detail: DecodedTexture | null;
    blend: DecodedTexture | null;
    normal: DecodedTexture | null;
  };
}

export class WebgpuSceneRenderer implements SceneRenderer {
  readonly backend = "webgpu" as const;

  /** Draws the opening frames, and any frame before the first readback lands. */
  private readonly software: SoftwareSceneRenderer;

  private readonly meshes = new WeakMap<MeshAsset, GpuPrimitive[]>();
  private readonly textures = new WeakMap<DecodedTexture, any>();
  /** With mips (F1a), colour maps upload apart: their chain is averaged in linear light. */
  private readonly colourTextures = new WeakMap<DecodedTexture, any>();
  /** HDR directional light maps (F3d), uploaded once each as two rgba16float layers. */
  private readonly hdrLightmaps = new WeakMap<HdrLightmap, any>();
  /** Draws a texture's mip chain on the GPU (F1a). */
  private readonly mipmaps: MipmapGenerator;
  /** The block-compressed formats this renderer uploads a texture's `gpu` chain in, preferred first (F1a). */
  readonly textureFormats: readonly string[];
  // Not readonly: a resized uniform buffer invalidates every cached group at
  // once, and WeakMap has no clear(), so the map itself is replaced.
  private bindGroups = new WeakMap<MeshPrimitive, CachedBindGroup>();
  /** Each cut-out caster's group 0 (F2a-2), with what it was made from, so a grown buffer or a new map remakes it. */
  private cutGroups = new WeakMap<MeshPrimitive, { readonly uniform: any; readonly instances: any; readonly base: DecodedTexture | null; readonly group: any }>();

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
  /** The path-traced reference (F10b), made the first time it is shown. */
  private pathTracer: PathTracer | null = null;

  /**
   * The bound shadow map — the 1x1 blank when no shadow this frame, else an
   * r32float sized to the shadow input and uploaded from the CPU-generated map.
   * Its identity only changes on a size change, so the bind-group cache holds.
   */
  private shadowTexture: any;
  private shadowMapSize = 0;
  /** Maps side by side in the shadow texture: 1, or 2 with a near cascade (EP8b). */
  private shadowCascades = 1;
  /** This frame's GPU sun cascades (F2a), for the frame uniform; null when it casts none. */
  private frameCascades: { readonly cascades: readonly Cascade[]; readonly size: number; readonly strength: number; readonly softness: number } | null = null;
  /** The near cascade's depth array last uploaded in full (as shadowUploaded is the main map's). */
  private nearUploaded: Float32Array | null = null;

  /**
   * The bound equirectangular environment map — the 1x1 blank (reusing the white
   * texture) when the frame has none, else an rgba8unorm upload of the decoded
   * panorama. Keyed by the source object so it uploads once per distinct map.
   */
  private envTexture: any;
  private envMapSource: DecodedTexture | null = null;
  /** The linear variant's environment (F3a): its prefiltered cube (a 1×1 black cube without one), SH, and what they were built from. */
  private ibl: IblBuilder | null = null;
  private iblKey: unknown[] | null = null;
  private iblSh: Float32Array = new Float32Array(36);

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
  /** The linear variant's GPU-captured probes (F3b), made when a frame first has some; their stand-in until then. */
  private probeCapture: ProbeCapture | null = null;
  private readonly blankProbeCubes: any = null;
  /** The probes the linear variant's shader loops over, and what was last written of them. */
  private capturedProbes = 0;
  private capturedSig = "";

  /** Per-instance transforms (binding 10), grown as needed. */
  private instanceBuffer: any = null;
  private instanceCapacity = 0;
  private instanceData = new Float32Array(0);

  /** What the last submitted frame drew (for the profiler and tests); GPU time when the device can time it. */
  lastFrameStats: RenderStats = { drawCalls: 0, instances: 0, triangles: 0, gpuMs: null };
  /** Per-pass GPU times (F0c), when the device can time them. */
  private readonly timer: GraphTimer | null;
  /** The frame graph's transient textures, kept from frame to frame. */
  private readonly transients: TransientPool;

  private constructor(
    private readonly device: any,
    private width: number,
    private height: number,
    private readonly pipeline: PipelineSet,
    /** Build the pipelines for a shader variant (a material graph's, EP7), at a sample count (I1), with a depth prepass (F0c). */
    private readonly pipelinesFor: (code: string, samples?: number, reflect?: boolean, prepass?: boolean) => PipelineSet,
    private readonly bindGroupLayout: any,
    private colourTexture: any,
    private depthTexture: any,
    /** Group 1 (EP6b): the opaque depth for the see-through pass, or a blank for the opaque one. */
    private readonly depthGroups: {
      blank: any;
      scene: any;
      /** The opaque pass after a prepass (F2d-3): the depths bound, the scene behind not. */
      opaque: any;
      readonly blankTexture: any;
      /** The opaque scene's colour for refraction (I5), the size of the frame, and its 1×1 stand-in. */
      /** The frame-sized targets the groups bind (remade on a resize): the depth, and the refraction copy. */
      readonly sized: { depth: any; behind: any };
      readonly behindBlank: any;
      readonly clusters: { readonly data: any; readonly params: any };
      readonly shadowTiles: any;
      /** The split-sum DFG table (F1c). */
      readonly dfg: any;
      /** The linearly transformed cosines' tables (F2e-2). */
      readonly ltc: any;
      /** The projected decals' boxes and tiles (F1f). */
      readonly decals: any;
      /** The physical sky's aerial perspective (F5a-2), as the linear-light shader reads it. */
      readonly aerial: any;
      /** The volume the groups bind for the volumetric fog (F5b): point it at a new one, then remake the groups. */
      readonly fogVolume: { texture: any };
      atlas: any;
      atlasBlank: boolean;
      probes: any;
      probesBlank: boolean;
      probeSource: LightProbeGrid | ProbeVolume | null;
      /** The sun's GPU cascades (F2a). */
      readonly cascades: CascadeResources;
      readonly makeGroups: (atlas: any, probes: any) => { blank: any; scene: any; opaque: any };
      /** The same groups for an anti-aliased frame: its multisampled blank and depth (I1). */
      readonly makeGroupsMs: (atlas: any, probes: any, blank: any, depth: any) => { blank: any; scene: any; opaque: any };
    },
    private readonly sampler: any,
    private readonly blankTexture: any,
    /** 1x1 r32float, bound to the shadow slot when no shadow map is active. */
    private readonly blankShadow: any,
    private readback: { buffer: any; busy: boolean; seq?: number }[],
    private bytesPerRow: number,
    style: RasterStyle,
    /** Linear HDR (F0b): half-float targets, frames kept on the GPU (renderToTexture) and never read back. */
    readonly hdr = false,
    /** Mipmapped textures (F1a): a full chain each, made on the GPU, sampled trilinearly at 16× anisotropy. */
    readonly mips = false,
  ) {
    // The warm-up rasteriser must draw the same era as the GPU it stands in for.
    this.software = new SoftwareSceneRenderer(style);
    this.shadowTexture = blankShadow;
    this.envTexture = hdr ? blankCube(device) : blankTexture; // the 1x1 white stands in until a map is bound (a black cube in the linear variant)
    this.probeTexture = blankTexture;
    if (hdr) this.blankProbeCubes = device.createTexture({ size: { width: 1, height: 1, depthOrArrayLayers: 6 }, format: "rgba16float", usage: 0x04 });
    this.ssaoBound = blankShadow; // the 1x1 r32float blank until an AO buffer arrives
    this.timer = GraphTimer.create(device);
    this.mipmaps = new MipmapGenerator(device);
    // Compressed textures need mips (F1a): the GPU can't make a compressed texture's.
    this.textureFormats = mips ? compressedFormatsFor(device) : [];
    this.transients = new TransientPool(device);
  }

  /**
   * Point the SSAO slot at a width×height r32float upload of `ao` (created once,
   * lazily), or the 1x1 blank when there is none; a change invalidates cached
   * bind groups (binding 8 moved).
   */
  private bindSsao(ao: Float32Array | null, contact = false): void {
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
    }
    // With contact shadows (F2c) the slot holds their target, which carries the AO through in red.
    const bound = contact ? this.ensureContact() : ao ? this.ssaoTexture : this.blankShadow;
    if (this.ssaoBound !== bound) {
      this.ssaoBound = bound;
      this.bindGroups = new WeakMap();
    }
  }

  /**
   * The screen-space shading target (F2c, F3c): rgba16float at the frame's size, AO in r, the sun's contact
   * in g, the bent normal in ba; in its second layer, SSGI (F3e-2): the near field's light in rgb, its share in a;
   * and in its third, the sun's light through the virtual shadow maps (F2b) in r, −1 where no page is resident.
   */
  private contactTexture: any = null;
  private ensureContact(): any {
    this.contactTexture ??= this.device.createTexture({ size: { width: this.width, height: this.height, depthOrArrayLayers: 3 }, format: SCREEN_SHADING_FORMAT, usage: 0x10 | 0x04 | 0x01 }); // RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC (for captures)
    return this.contactTexture;
  }
  /** The resolve's uniforms and pipelines (one per depth sample count), made on first use. */
  private contact: { uniforms: any; data: Float32Array<ArrayBuffer>; pipelines: [any, any] } | null = null;
  /** Whether this frame's sun takes contact shadows (F2c), for the frame uniform. */
  private frameContact = false;
  /** The frame's world → clip as drawn and its depth → distance terms, when its depths are readable as it shades (F2d-3). */
  private frameDepthView: { readonly viewProj: Mat4; readonly terms: readonly [number, number] } | null = null;
  /** Whether this frame's ambient light takes GTAO (F3c), for the frame uniform. */
  private frameGtao = false;
  /** This frame's SSGI (F3e-2), when it has one, for the frame uniform and the screen-space shading. */
  private frameSsgi: SsgiFrame | null = null;
  /**
   * SSGI's resources (F3e-2): its uniforms, the half-resolution history (two, one read and one written,
   * swapping each frame), and its pipelines.
   */
  private ssgi: { uniforms: any; data: Float32Array<ArrayBuffer>; history: [any, any]; index: number; valid: boolean; frame: number; sampler: any; trace: [any, any]; resolve: [any, any]; accumulate: any } | null = null;
  /** This frame's real-time GI (F3e), its tracer for the still scene it was made for, and the sky it traces. */
  private frameGi: GpuSceneDraw["dynamicGi"] | null = null;
  private probeGi: { readonly key: string; readonly gi: GpuProbeGi } | null = null;
  private giSky: { readonly source: object; readonly sky: ReturnType<typeof environmentPanorama> } | null = null;
  /** This frame's volumetric fog (F5b), its volumes (made when a frame first has some) and the shader's terms. */
  private frameFog: FogFrame | null = null;
  private volumetricFog: GpuVolumetricFog | null = null;
  private readonly fogTerms = new Float32Array(FOG_FRAME_FLOATS);
  /** The physical sky's LUTs (F5a-2), made when a draw first brings one, and the frame's aerial terms. */
  private atmosphere: GpuAtmosphere | null = null;
  private readonly aerialTerms = new Float32Array(AERIAL_FRAME_FLOATS);
  /**
   * GTAO's resources (F3c): its uniforms, the half-resolution history (two,
   * one read and one written, swapping each frame), and its pipelines.
   */
  private gtao: { uniforms: any; data: Float32Array<ArrayBuffer>; history: [any, any]; index: number; valid: boolean; frame: number; sampler: any; pipelines: [any, any]; accumulate: any } | null = null;

  /**
   * The screen-space shading after the prepass (F2c, F3c): GTAO at half
   * resolution accumulated over frames, then at full resolution its
   * depth-aware upsample and the sun's contact shadows, into the target the
   * scene shader reads in its SSAO slot.
   */
  private addScreenShading(
    graph: FrameGraph,
    depth: FrameResource,
    gbuffer: FrameResource | null,
    velocity: FrameResource | null,
    view: Mat4,
    projection: Mat4,
    toLight: readonly [number, number, number] | null,
    ao: boolean,
    multisampled: boolean,
  ): void {
    const device = this.device;
    const k = multisampled ? 1 : 0;
    // GTAO (F3c), when the frame has it.
    let resolvedAo: FrameResource | null = null;
    if (this.frameGtao && gbuffer && velocity) {
      const half = { width: Math.max(1, Math.ceil(this.width / 2)), height: Math.max(1, Math.ceil(this.height / 2)) };
      const made = () => device.createTexture({ size: half, format: SCREEN_SHADING_FORMAT, usage: 0x10 | 0x04 | 0x01 });
      if (!this.gtao) {
        this.gtao = {
          uniforms: device.createBuffer({ size: GTAO_UNIFORM_FLOATS * 4, usage: 0x40 | 0x08 }),
          data: new Float32Array(GTAO_UNIFORM_FLOATS),
          history: [made(), made()],
          index: 0,
          valid: false,
          frame: 0,
          sampler: device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }),
          pipelines: [null, null],
          accumulate: fullScreenPipeline(device, gtaoTemporalWgsl(), "accumulate", SCREEN_SHADING_FORMAT),
        };
      }
      const g = this.gtao;
      g.pipelines[k] ??= fullScreenPipeline(device, gtaoShaderWgsl(multisampled), "gtaoPass", SCREEN_SHADING_FORMAT);
      const pipeline = g.pipelines[k];
      const current = graph.createTexture("gtao", { format: SCREEN_SHADING_FORMAT, ...half });
      const then = graph.importTexture("gtao.then", g.history[g.index]!);
      const now = graph.importTexture("gtao.now", g.history[1 - g.index]!);
      const history = g.valid;
      device.queue.writeBuffer(g.uniforms, 0, gtaoUniforms(view, projection, g.frame, history, g.data));
      g.frame += 1;
      graph.addPass("gtao", "render", (pass) => {
        pass.read(depth);
        pass.read(gbuffer);
        pass.write(current);
        return (ctx) => {
          const encoded = ctx.encoder.beginRenderPass({
            colorAttachments: [{ view: ctx.texture(current).createView(), clearValue: { r: 0, g: 1, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
            ...ctx.timing,
          });
          encoded.setPipeline(pipeline);
          encoded.setBindGroup(0, device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: g.uniforms } },
              { binding: 1, resource: ctx.texture(depth).createView() },
              { binding: 2, resource: ctx.texture(gbuffer).createView() },
            ],
          }));
          encoded.draw(3);
          encoded.end();
        };
      });
      graph.addPass("gtao.accumulate", "render", (pass) => {
        pass.read(current);
        pass.read(then);
        pass.read(velocity);
        pass.write(now);
        pass.keep();
        return (ctx) => {
          const encoded = ctx.encoder.beginRenderPass({
            colorAttachments: [{ view: ctx.texture(now).createView(), clearValue: { r: 0, g: 1, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
            ...ctx.timing,
          });
          encoded.setPipeline(g.accumulate);
          encoded.setBindGroup(0, device.createBindGroup({
            layout: g.accumulate.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: g.uniforms } },
              { binding: 1, resource: ctx.texture(current).createView() },
              { binding: 2, resource: ctx.texture(then).createView() },
              { binding: 3, resource: ctx.texture(velocity).createView() },
              { binding: 4, resource: g.sampler },
            ],
          }));
          encoded.draw(3);
          encoded.end();
        };
      });
      g.index = 1 - g.index;
      g.valid = true;
      resolvedAo = now;
    } else if (this.gtao) {
      // A frame without it: the next one with it starts its history afresh.
      this.gtao.valid = false;
    }
    if (this.frameVsm && gbuffer) this.addVsmResolve(graph, depth, gbuffer, multisampled);
    if (this.frameSsgi && gbuffer && velocity && this.taa) this.addSsgi(graph, depth, gbuffer, velocity, view, projection, this.frameSsgi, multisampled);
    else if (this.ssgi) this.ssgi.valid = false;
    this.contact ??= { uniforms: device.createBuffer({ size: CONTACT_UNIFORM_FLOATS * 4, usage: 0x40 | 0x08 }), data: new Float32Array(CONTACT_UNIFORM_FLOATS), pipelines: [null, null] };
    const contact = this.contact;
    contact.pipelines[k] ??= fullScreenPipeline(device, contactShaderWgsl(multisampled), "contactPass", SCREEN_SHADING_FORMAT);
    const pipeline = contact.pipelines[k];
    const target = graph.importTexture("contact", this.ensureContact());
    const aoView = (ao && this.ssaoTexture ? this.ssaoTexture : this.blankShadow).createView();
    const gtaoBlank = this.gtaoBlank ??= device.createTexture({ size: { width: 1, height: 1 }, format: SCREEN_SHADING_FORMAT, usage: 0x04 | 0x02 });
    device.queue.writeBuffer(contact.uniforms, 0, contactUniforms(view, projection, toLight, ao, resolvedAo !== null, contact.data));
    graph.addPass("contact shadows", "render", (pass) => {
      pass.read(depth);
      if (resolvedAo) pass.read(resolvedAo);
      pass.write(target);
      // The scene passes read it through their group 0, which the graph doesn't see.
      pass.keep();
      return (ctx) => {
        const encoded = ctx.encoder.beginRenderPass({
          colorAttachments: [{ view: ctx.texture(target).createView({ dimension: "2d", baseArrayLayer: 0, arrayLayerCount: 1 }), clearValue: { r: 1, g: 1, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
          ...ctx.timing,
        });
        encoded.setPipeline(pipeline);
        encoded.setBindGroup(0, device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: contact.uniforms } },
            { binding: 1, resource: ctx.texture(depth).createView() },
            { binding: 2, resource: aoView },
            { binding: 3, resource: (resolvedAo ? ctx.texture(resolvedAo) : gtaoBlank).createView() },
          ],
        }));
        encoded.draw(3);
        encoded.end();
      };
    });
  }
  /** The IES profiles in the LTC buffer's slots (F9d), by identity. */
  private readonly iesHeld: (object | null)[] = Array.from({ length: IES_MAX_PROFILES }, () => null);

  /**
   * Each distinct IES profile among the frame's lights a slot (F9d), uploaded when it first takes it; the
   * light's slot, or −1 (no profile, or more profiles than slots).
   */
  private iesSlots(lights: readonly { readonly ies?: object | null }[]): (light: { readonly ies?: object | null }) => number {
    const wanted = new Set(lights.map((l) => l.ies).filter((p): p is object => Boolean(p)));
    // Free the slots of profiles no light uses now.
    this.iesHeld.forEach((p, i) => {
      if (p && !wanted.has(p)) this.iesHeld[i] = null;
    });
    for (const profile of wanted) {
      if (this.iesHeld.includes(profile)) continue;
      const slot = this.iesHeld.indexOf(null);
      if (slot < 0) break;
      this.iesHeld[slot] = profile;
      const samples = (profile as { samples?: readonly number[] }).samples ?? [];
      this.device.queue.writeBuffer(this.depthGroups.ltc, (IES_BASE + slot * IES_VEC4S) * 16, Float32Array.from(samples.slice(0, IES_VEC4S * 4)));
    }
    return (light) => (light.ies ? this.iesHeld.indexOf(light.ies) : -1);
  }

  /** A 1×1 stand-in for GTAO's history when the frame has none (F3c). */
  private gtaoBlank: any = null;

  /** This frame's virtual shadow maps (F2b): the pages it draws, when it has them. */
  private frameVsm: { readonly draws: readonly PageDraw[]; readonly basis: ReturnType<typeof vsmLightBasis>; readonly centre: number } | null = null;
  /**
   * The virtual shadow maps' resources (F2b): the physical pool and its bookkeeping, the marks and the
   * buffers they are read back through (each with the windows it was marked under), the page table, the
   * passes' uniforms, a view uniform a page drawn a frame, and the pipelines.
   */
  private vsm: {
    pool: any;
    poolSize: number;
    pages: VirtualPagePool;
    marks: any;
    staging: { buffer: any; busy: boolean; windows: [number, number][] }[];
    pending: { marks: Uint32Array; windows: [number, number][] } | null;
    needed: ReturnType<typeof markedPages>;
    table: any;
    tableData: Uint32Array;
    windowsKey: string;
    windows: [number, number][];
    uniforms: any;
    data: Float32Array<ArrayBuffer>;
    views: { buffer: any; group: any }[];
    sampler: any;
    mark: [any, any];
    resolve: [any, any];
    marking: { buffer: any; busy: boolean; windows: [number, number][] } | null;
  } | null = null;

  /** Plan the frame's virtual shadow maps (F2b): see virtualShadows.ts. */
  private planVsm(draw: GpuSceneDraw, toLight: readonly [number, number, number], strength: number, softness: number, projection: Mat4): NonNullable<WebgpuSceneRenderer["frameVsm"]> {
    const device = this.device;
    const poolSize = Math.max(VSM_PAGES, Math.floor((draw.virtualShadows?.poolSize ?? 4096) / VSM_PAGES) * VSM_PAGES);
    if (this.vsm && this.vsm.poolSize !== poolSize) this.disposeVsm();
    if (!this.vsm) {
      const capacity = (poolSize / VSM_PAGES) ** 2;
      const layout = this.depthGroups.cascades.localPipeline.getBindGroupLayout(1);
      this.vsm = {
        pool: device.createTexture({ size: { width: poolSize, height: poolSize }, format: "depth32float", usage: 0x10 | 0x04 }),
        poolSize,
        pages: new VirtualPagePool(capacity),
        marks: device.createBuffer({ size: VSM_MARK_WORDS * 4, usage: 0x80 | 0x04 | 0x08 }), // STORAGE | COPY_SRC | COPY_DST
        staging: Array.from({ length: 3 }, () => ({ buffer: device.createBuffer({ size: VSM_MARK_WORDS * 4, usage: 0x01 | 0x08 }), busy: false, windows: [] as [number, number][] })),
        pending: null,
        needed: [],
        table: device.createBuffer({ size: VSM_LEVELS * VSM_PAGES * VSM_PAGES * 4, usage: 0x80 | 0x08 }),
        tableData: new Uint32Array(VSM_LEVELS * VSM_PAGES * VSM_PAGES),
        windowsKey: "",
        windows: [],
        uniforms: device.createBuffer({ size: VSM_UNIFORM_FLOATS * 4, usage: 0x40 | 0x08 }),
        data: new Float32Array(VSM_UNIFORM_FLOATS),
        views: [],
        sampler: device.createSampler({ compare: "less-equal", magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }),
        mark: [null, null],
        resolve: [null, null],
        marking: null,
      };
      for (let i = 0; i < 48; i += 1) {
        const buffer = device.createBuffer({ size: 64, usage: 0x40 | 0x08 });
        this.vsm.views.push({ buffer, group: device.createBindGroup({ layout, entries: [{ binding: 12, resource: { buffer } }] }) });
      }
    }
    const v = this.vsm;
    const eyeM = invertMat4(draw.view) ?? draw.view;
    const eye: [number, number, number] = [eyeM[12]!, eyeM[13]!, eyeM[14]!];
    const basis = vsmLightBasis(toLight);
    const centre = vsmDepthCentre(eye, basis);
    const windows = vsmWindows(eye, basis);
    // What the newest marks read back asked for, in the windows they were marked under.
    if (v.pending) {
      v.needed = markedPages(v.pending.marks, v.pending.windows);
      v.pending = null;
    }
    const key = `${toLight.map((c) => c.toFixed(4)).join(",")}|${centre}|${draw.localShadowKey ?? `frame ${this.frameIndex}`}`;
    const movers = (draw.localShadowMoved ?? []).map((m) => worldSphere(localSphere(m.mesh), m.model));
    const draws = v.pages.update(v.needed, key, (page) => movers.some((sphere) => pageTouches(page, basis, sphere)), v.views.length);
    const windowsKey = windows.map((w) => w.join(",")).join(";");
    if (v.pages.changed || windowsKey !== v.windowsKey) {
      device.queue.writeBuffer(v.table, 0, v.pages.table(windows, v.tableData));
      v.windowsKey = windowsKey;
    }
    v.windows = windows;
    draws.forEach((d, i) => device.queue.writeBuffer(v.views[i]!.buffer, 0, vsmPageViewProj(d.level, d.gx, d.gy, basis, centre)));
    const viewProj = multiplyMat4(projection, draw.view);
    device.queue.writeBuffer(
      v.uniforms,
      0,
      vsmUniforms({ invViewProj: invertMat4(viewProj) ?? viewProj, eye, basis, centre, windows, pixelAngle: 2 / ((projection[5] || 1) * this.height), width: this.width, height: this.height, poolSize: v.poolSize, softness, strength, view: draw.view }, v.data),
    );
    return { draws, basis, centre };
  }

  /** Draw the frame's pages (F2b): each cleared, then the casters whose shadow can reach it, through its own view. */
  private addVsmPages(graph: FrameGraph, pages: readonly PageDraw[], casters: readonly any[], first: number): void {
    const v = this.vsm!;
    const res = this.depthGroups.cascades;
    const basis = this.frameVsm!.basis;
    const pool = graph.importTexture("vsm.pool", v.pool);
    const clearPipeline = this.localClearPipeline();
    graph.addPass("virtual shadows", "render", (pass) => {
      // The pages not drawn this frame keep their maps.
      pass.read(pool, "attachment");
      pass.write(pool);
      pass.keep();
      return (ctx) => {
        const group = this.device.createBindGroup({
          layout: res.casterLayout,
          entries: [
            { binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: UNIFORM_STRIDE } },
            { binding: 10, resource: { buffer: this.instanceBuffer } },
          ],
        });
        const encoded = ctx.encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: ctx.texture(pool).createView(), depthLoadOp: "load", depthStoreOp: "store" }, ...ctx.timing });
        pages.forEach((page, i) => {
          const [x, y] = physicalCorner(page.physical, v.poolSize);
          encoded.setViewport(x, y, VSM_PAGES, VSM_PAGES, 0, 1);
          encoded.setScissorRect(x, y, VSM_PAGES, VSM_PAGES);
          encoded.setPipeline(clearPipeline);
          encoded.draw(3);
          encoded.setBindGroup(1, v.views[i]!.group);
          for (const cut of [false, true]) {
            encoded.setPipeline(cut ? res.localCutPipeline : res.localPipeline);
            casters.forEach((entry, k) => {
              if ((entry.alpha === 1) !== cut) return;
              const sphere = localSphere(entry.primitive);
              if (!entry.models.some((m: Mat4) => pageTouches(page, basis, worldSphere(sphere, m)))) return;
              encoded.setBindGroup(0, cut ? this.cutGroupFor(entry.primitive, entry.textures) : group, [(first + k) * UNIFORM_STRIDE]);
              encoded.setVertexBuffer(0, entry.geometry.vertexBuffer);
              encoded.setIndexBuffer(entry.geometry.indexBuffer, "uint32");
              encoded.drawIndexed(entry.geometry.indexCount, entry.models.length, 0, 0, entry.first);
            });
          }
        });
        encoded.end();
      };
    });
  }

  /** Mark the pages the frame's pixels want (F2b), and copy the marks out to be read back. */
  private addVsmMarks(graph: FrameGraph, depth: FrameResource, multisampled: boolean): void {
    const v = this.vsm!;
    const k = multisampled ? 1 : 0;
    v.mark[k] ??= this.device.createComputePipeline({ layout: "auto", compute: { module: this.device.createShaderModule({ code: vsmMarkWgsl(multisampled) }), entryPoint: "markPages" } });
    const pipeline = v.mark[k];
    const slot = v.staging.find((s) => !s.busy) ?? null;
    if (slot) {
      slot.busy = true;
      slot.windows = v.windows;
    }
    v.marking = slot;
    graph.addPass("vsm.mark", "compute", (pass) => {
      pass.read(depth);
      pass.keep();
      return (ctx) => {
        ctx.encoder.clearBuffer(v.marks);
        const encoded = ctx.encoder.beginComputePass(ctx.timing);
        encoded.setPipeline(pipeline);
        encoded.setBindGroup(0, this.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: v.uniforms } },
            { binding: 1, resource: ctx.texture(depth).createView() },
            { binding: 2, resource: { buffer: v.marks } },
          ],
        }));
        encoded.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
        encoded.end();
        if (slot) ctx.encoder.copyBufferToBuffer(v.marks, 0, slot.buffer, 0, VSM_MARK_WORDS * 4);
      };
    });
  }

  /** The sun's light through the virtual map at each pixel (F2b), into the screen-shading target's third layer. */
  private addVsmResolve(graph: FrameGraph, depth: FrameResource, gbuffer: FrameResource, multisampled: boolean): void {
    const v = this.vsm!;
    const k = multisampled ? 1 : 0;
    v.resolve[k] ??= fullScreenPipeline(this.device, vsmResolveWgsl(multisampled), "resolve", SCREEN_SHADING_FORMAT);
    const pipeline = v.resolve[k];
    const target = graph.importTexture("vsm.target", this.ensureContact());
    const pool = graph.importTexture("vsm.sampled", v.pool);
    graph.addPass("vsm.resolve", "render", (pass) => {
      pass.read(depth);
      pass.read(gbuffer);
      pass.read(pool);
      pass.write(target);
      pass.keep();
      return (ctx) => {
        const encoded = ctx.encoder.beginRenderPass({
          colorAttachments: [{ view: ctx.texture(target).createView({ dimension: "2d", baseArrayLayer: 2, arrayLayerCount: 1 }), clearValue: { r: -1, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
          ...ctx.timing,
        });
        encoded.setPipeline(pipeline);
        encoded.setBindGroup(0, this.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: v.uniforms } },
            { binding: 1, resource: ctx.texture(depth).createView() },
            { binding: 2, resource: { buffer: v.table } },
            { binding: 3, resource: v.pool.createView() },
            { binding: 4, resource: v.sampler },
            { binding: 5, resource: ctx.texture(gbuffer).createView() },
          ],
        }));
        encoded.draw(3);
        encoded.end();
      };
    });
  }

  /** Read back the marks the frame just copied out (F2b); they reach a later frame's plan. */
  private readVsmMarks(): void {
    const v = this.vsm;
    const slot = v?.marking ?? null;
    if (!v || !slot) return;
    v.marking = null;
    void slot.buffer.mapAsync(0x01).then(
      () => {
        if (this.vsm === v) v.pending = { marks: new Uint32Array(slot.buffer.getMappedRange().slice(0)), windows: slot.windows };
        slot.buffer.unmap();
        slot.busy = false;
      },
      () => {
        slot.busy = false;
      },
    );
  }

  private disposeVsm(): void {
    const v = this.vsm;
    if (!v) return;
    for (const b of [v.pool, v.marks, v.table, v.uniforms, ...v.staging.map((s) => s.buffer), ...v.views.map((w) => w.buffer)]) destroySafely(b);
    this.vsm = null;
  }

  /** Clears a rect of a depth32float map to the far plane (F2d-2's, shared with F2b's pages). */
  private localClearPipeline(): any {
    this.localClear ??= this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: this.device.createShaderModule({ code: LOCAL_CLEAR_WGSL }), entryPoint: "vs" },
      fragment: { module: this.device.createShaderModule({ code: LOCAL_CLEAR_WGSL }), entryPoint: "clear", targets: [] },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" },
    });
    return this.localClear;
  }

  /**
   * SSGI (F3e-2): at half resolution its trace against the prepass's depths, lit by last frame's resolved
   * image (the TAA history), accumulated over frames through the velocity buffer, then filtered up to full
   * resolution into the screen-shading target's second layer.
   */
  private addSsgi(graph: FrameGraph, depth: FrameResource, gbuffer: FrameResource, velocity: FrameResource, view: Mat4, projection: Mat4, settings: SsgiFrame, multisampled: boolean): void {
    const device = this.device;
    const k = multisampled ? 1 : 0;
    const half = { width: Math.max(1, Math.ceil(this.width / 2)), height: Math.max(1, Math.ceil(this.height / 2)) };
    if (!this.ssgi) {
      const made = () => device.createTexture({ size: half, format: SCREEN_SHADING_FORMAT, usage: 0x10 | 0x04 | 0x01 });
      this.ssgi = {
        uniforms: device.createBuffer({ size: SSGI_UNIFORM_FLOATS * 4, usage: 0x40 | 0x08 }),
        data: new Float32Array(SSGI_UNIFORM_FLOATS),
        history: [made(), made()],
        index: 0,
        valid: false,
        frame: 0,
        sampler: device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }),
        trace: [null, null],
        resolve: [null, null],
        accumulate: fullScreenPipeline(device, ssgiTemporalWgsl(), "accumulate", SCREEN_SHADING_FORMAT),
      };
    }
    const gi = this.ssgi;
    gi.trace[k] ??= fullScreenPipeline(device, ssgiTraceWgsl(multisampled), "ssgiTrace", SCREEN_SHADING_FORMAT);
    gi.resolve[k] ??= fullScreenPipeline(device, ssgiResolveWgsl(multisampled), "resolve", SCREEN_SHADING_FORMAT);
    const trace = gi.trace[k];
    const resolve = gi.resolve[k];
    const current = graph.createTexture("ssgi", { format: SCREEN_SHADING_FORMAT, ...half });
    const then = graph.importTexture("ssgi.then", gi.history[gi.index]!);
    const now = graph.importTexture("ssgi.now", gi.history[1 - gi.index]!);
    // Last frame's resolved image: the TAA history it wrote, linear light before any tone map.
    const radiance = graph.importTexture("ssgi.radiance", this.taa!.history[this.taa!.index]);
    const target = graph.importTexture("ssgi.target", this.ensureContact());
    device.queue.writeBuffer(gi.uniforms, 0, ssgiUniforms(view, projection, gi.frame, gi.valid, settings, gi.data));
    gi.frame += 1;
    const draw = (ctx: any, pipeline: any, into: any, entries: { binding: number; resource: any }[]) => {
      const encoded = ctx.encoder.beginRenderPass({
        colorAttachments: [{ view: into, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
        ...ctx.timing,
      });
      encoded.setPipeline(pipeline);
      encoded.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: gi.uniforms } }, ...entries] }));
      encoded.draw(3);
      encoded.end();
    };
    graph.addPass("ssgi", "render", (pass) => {
      pass.read(depth);
      pass.read(gbuffer);
      pass.read(velocity);
      pass.read(radiance);
      pass.write(current);
      return (ctx) =>
        draw(ctx, trace, ctx.texture(current).createView(), [
          { binding: 1, resource: ctx.texture(depth).createView() },
          { binding: 2, resource: ctx.texture(gbuffer).createView() },
          { binding: 3, resource: ctx.texture(velocity).createView() },
          { binding: 4, resource: ctx.texture(radiance).createView() },
          { binding: 5, resource: gi.sampler },
        ]);
    });
    graph.addPass("ssgi.accumulate", "render", (pass) => {
      pass.read(current);
      pass.read(then);
      pass.read(velocity);
      pass.write(now);
      pass.keep();
      return (ctx) =>
        draw(ctx, gi.accumulate, ctx.texture(now).createView(), [
          { binding: 1, resource: ctx.texture(current).createView() },
          { binding: 2, resource: ctx.texture(then).createView() },
          { binding: 3, resource: ctx.texture(velocity).createView() },
          { binding: 4, resource: gi.sampler },
        ]);
    });
    graph.addPass("ssgi.resolve", "render", (pass) => {
      pass.read(depth);
      pass.read(gbuffer);
      pass.read(now);
      pass.write(target);
      // The scene passes read it through their group 0, which the graph doesn't see.
      pass.keep();
      return (ctx) =>
        draw(ctx, resolve, ctx.texture(target).createView({ dimension: "2d", baseArrayLayer: 1, arrayLayerCount: 1 }), [
          { binding: 1, resource: ctx.texture(depth).createView() },
          { binding: 2, resource: ctx.texture(gbuffer).createView() },
          { binding: 3, resource: ctx.texture(now).createView() },
        ]);
    });
    gi.index = 1 - gi.index;
    gi.valid = true;
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
    /** `hdr`: shade in linear light into half-float targets, for a GPU-presented frame (F0b; no readback). */
    options: { readonly hdr?: boolean; readonly mips?: boolean } = {},
  ): Promise<WebgpuSceneRenderer | null> {
    const hdr = options.hdr === true;
    // Mipmaps (F1a): full chains, filtered trilinearly at 16× anisotropy, where the era filters at all.
    const mips = options.mips === true && style.textureFiltering !== "none";
    const colourFormat = hdr ? "rgba16float" : "rgba8unorm";
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
          // so it declares unfilterable-float and needs no sampler. The linear-light
          // renderer binds the sun's GPU cascades here instead (F2a), compared by group 1's sampler.
          { binding: 6, visibility: SHADER_STAGE_FRAGMENT, texture: hdr ? { sampleType: "depth", viewDimension: "2d-array" } : { sampleType: "unfilterable-float" } },
          // The equirectangular environment map (rgba8unorm), read via textureLoad.
          // The environment: its panorama, or (linear variant, F3a) its prefiltered cube.
          { binding: 7, visibility: SHADER_STAGE_FRAGMENT, texture: hdr ? { sampleType: "float", viewDimension: "cube" } : { sampleType: "float" } },
          // The SSAO buffer (r32float), read per fragment via textureLoad.
          // The linear variant's is an array: the screen-space shading target's two layers (F3e-2).
          { binding: 8, visibility: SHADER_STAGE_FRAGMENT, texture: hdr ? { sampleType: "unfilterable-float", viewDimension: "2d-array" } : { sampleType: "unfilterable-float" } },
          // The Modern-tier light list, read-only storage.
          { binding: 9, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "read-only-storage" } },
          // Per-instance transforms, read by the vertex stage.
          { binding: 10, visibility: SHADER_STAGE_VERTEX, buffer: { type: "read-only-storage" } },
          // The baked light map: an array in the linear variant, for an HDR directional map's two layers (F3d).
          { binding: 11, visibility: SHADER_STAGE_FRAGMENT, texture: hdr ? { sampleType: "float", viewDimension: "2d-array" } : { sampleType: "float" } },
          // Reflection probes: the panorama atlas (read via textureLoad), or the linear variant's cube array (F3b); and their boxes.
          { binding: 12, visibility: SHADER_STAGE_FRAGMENT, texture: hdr ? { sampleType: "float", viewDimension: "cube-array" } : { sampleType: "float" } },
          { binding: 13, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "read-only-storage" } },
          // The detail map, and the blend surface's map.
          { binding: 14, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } },
          { binding: 15, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } },
          // The tangent-space normal map (P1a).
          { binding: 16, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } },
        ],
      });

      // One pipeline per transparency (EP6): opaque surfaces write depth;
      // blended ones (premultiplied colour over what's there) and added ones
      // test depth without writing it, drawn after the opaque scene.
      // Group 1 is the opaque depth for soft edges (EP6b): the see-through pass
      // reads it while it is attached read-only; the opaque pass binds a blank.
      // It also carries the clustered lights (EP8): the cell table, the index list and their params.
      // An anti-aliased frame (HALO_INFINITE_STYLE_ROADMAP.md I1) draws into
      // multisampled targets, so its soft edges read a multisampled depth: the
      // same group with binding 0 declared multisampled.
      const depthEntries = (multisampled: boolean) => [
        { binding: 0, visibility: SHADER_STAGE_FRAGMENT, texture: multisampled ? { sampleType: "depth", multisampled: true } : { sampleType: "depth" } },
        // The clustered lights' table and index list (EP8), then the probes (EP9, F3d-3), both in storage (F5b-0).
        { binding: 1, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "uniform" } },
        // The spot/point shadow atlas: the CPU's r32float distances, or the linear-light renderer's GPU depths (F2d).
        { binding: 4, visibility: SHADER_STAGE_FRAGMENT, texture: hdr ? { sampleType: "depth" } : { sampleType: "unfilterable-float" } },
        { binding: 5, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "read-only-storage" } },
        // The opaque scene's colour, for refraction (I5).
        { binding: 7, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "unfilterable-float" } },
        // The split-sum DFG table (F1c), read by the linear-light shader.
        { binding: 8, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "read-only-storage" } },
        // The prefiltered environment cube's trilinear sampler (F3a).
        { binding: 9, visibility: SHADER_STAGE_FRAGMENT, sampler: { type: "filtering" } },
        // The linearly transformed cosines' tables, for area lights (F2e-2), read by the linear-light shader.
        { binding: 10, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "read-only-storage" } },
        // The projected decals' boxes and tiles (F1f), read by the linear-light shader.
        { binding: 13, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "read-only-storage" } },
        // The comparison sampler that filters the sun's GPU cascades (F2a; group 0 binds the cascades).
        { binding: 11, visibility: SHADER_STAGE_FRAGMENT, sampler: { type: "comparison" } },
        // The physical sky's aerial perspective (F5a-2), and the volumetric fog (F5b), read by the linear-light shader.
        ...(hdr ? [{ binding: 14, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "uniform" } }, { binding: 6, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float", viewDimension: "3d" } }] : []),
      ];
      const depthLayout = device.createBindGroupLayout({ entries: depthEntries(false) });
      const depthLayoutMs = device.createBindGroupLayout({ entries: depthEntries(true) });
      const layout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout, depthLayout] });
      const layoutMs = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout, depthLayoutMs] });
      const pipelinesFor = (code: string, samples = 1, reflect = false, prepass = false): PipelineSet => {
        const multisampled = samples > 1;
        const module = device.createShaderModule({ code: multisampled ? multisampledDepthShader(code) : code });
        const pipelineFor = (blend: unknown, depthWrite: boolean, depthCompare = "less", gbuffer = false) => device.createRenderPipeline({
          layout: multisampled ? layoutMs : layout,
          ...(multisampled ? { multisample: { count: samples } } : {}),
          vertex: {
            module,
            entryPoint: gbuffer ? "vs_prepass" : "vs",
            buffers: [
              {
                // Interleaved position(3) + normal(3) + uv(2) + light-map uv(2) + blend weight(1) + sway(1) + tangent(4).
                arrayStride: 64,
                attributes: [
                  { shaderLocation: 0, offset: 0, format: "float32x3" },
                  { shaderLocation: 1, offset: 12, format: "float32x3" },
                  { shaderLocation: 2, offset: 24, format: "float32x2" },
                  { shaderLocation: 3, offset: 32, format: "float32x2" },
                  { shaderLocation: 4, offset: 40, format: "float32" },
                  { shaderLocation: 5, offset: 44, format: "float32" },
                  { shaderLocation: 7, offset: 48, format: "float32x4" },
                ],
              },
              // The prepass's velocity (F0c): the same layout's positions, from last frame's vertices.
              ...(gbuffer ? [{ arrayStride: 64, attributes: [{ shaderLocation: 6, offset: 0, format: "float32x3" }] }] : []),
            ],
          },
          fragment: {
            module,
            entryPoint: gbuffer ? "fs_prepass" : "fs",
            // rgba8unorm, never rgba8unorm-srgb: the framebuffer these bytes land
            // in is the same 8-bit buffer the CPU path writes, so any gamma
            // conversion here would show up as the GPU path looking washed out.
            // A frame with reflections (I3) writes the two reflection targets too, blended as the colour is.
            // The depth prepass (F0c) writes only the G-buffer.
            targets: gbuffer
              ? [{ format: GBUFFER_FORMAT }, { format: VELOCITY_FORMAT }]
              : [
                  blend ? { format: colourFormat, blend } : { format: colourFormat },
                  ...(reflect ? [0, 1].map(() => (blend ? { format: "rgba16float", blend } : { format: "rgba16float" })) : []),
                ],
          },
          // cullMode "none" matches the software rasteriser, which draws both
          // faces (its Lambert is two-sided for exactly this reason).
          primitive: { topology: "triangle-list", cullMode: "none" },
          depthStencil: { format: "depth24plus", depthWriteEnabled: depthWrite, depthCompare },
        });
        return {
          // After a prepass the opaque surfaces meet their own depths again: less-or-equal lets them through.
          // After a prepass the opaque pass only tests its depths (and reads them, F2d-3): it writes none.
          opaque: pipelineFor(null, !(prepass && hdr), prepass ? "less-equal" : "less"),
          ...(prepass ? { prepass: pipelineFor(null, true, "less", true) } : {}),
          blend: pipelineFor({ color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } }, false),
          add: pipelineFor({ color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" } }, false),
        };
      };
      const pipeline = pipelinesFor(sceneShader(null, false, hdr));
      // A shader the device rejects doesn't throw: its pipelines draw nothing
      // and only the sky (drawn apart from them) shows. So ask, and decline the
      // device when it reports an error — the factory then falls back to WebGL2.
      const compiled = await device.createShaderModule({ code: sceneShader(null, false, hdr) }).getCompilationInfo?.();
      if (compiled?.messages?.some((m: { type?: string }) => m.type === "error")) return null;

      const colourTexture = device.createTexture({
        size: { width, height },
        format: colourFormat,
        usage: 0x10 | 0x01 | 0x04 | 0x02, // RENDER_ATTACHMENT | COPY_SRC | TEXTURE_BINDING (the temporal resolve reads it) | COPY_DST (reflections land in it)
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
        // The cells' table, then the index list after it (F5b-0).
        data: device.createBuffer({ size: CLUSTER_CELLS * 8 + CLUSTER_INDEX_CAP * 4, usage: 0x80 | 0x08 }), // STORAGE | COPY_DST
        params: device.createBuffer({ size: FRAME_BYTES, usage: 0x40 | 0x08 }), // UNIFORM | COPY_DST
      };
      // Spot/point shadows (EP8c): the atlas (a 1×1 stand-in until a light casts) and the tiles' views.
      const shadowTiles = device.createBuffer({ size: Math.max(MAX_LOCAL_SHADOW_TILES, MAX_GPU_LOCAL_TILES) * LOCAL_TILE_FLOATS * 4, usage: 0x80 | 0x08 }); // STORAGE | COPY_DST
      // The split-sum DFG table (F1c), integrated once on the CPU.
      const dfg = brdfLut();
      const dfgBuffer = device.createBuffer({ size: dfg.byteLength, usage: 0x80 | 0x08 }); // STORAGE | COPY_DST
      device.queue.writeBuffer(dfgBuffer, 0, dfg);
      // The linearly transformed cosines' tables (F2e-2), decoded once.
      const ltc = ltcTables();
      // The IES profiles (F9d) follow the tables in the same buffer.
      const ltcBuffer = device.createBuffer({ size: ltc.byteLength + IES_MAX_PROFILES * IES_VEC4S * 16, usage: 0x80 | 0x08 }); // STORAGE | COPY_DST
      device.queue.writeBuffer(ltcBuffer, 0, ltc);
      // The projected decals (F1f): a fixed buffer, zeroed (no boxes) until a frame has some.
      const decalBuffer = device.createBuffer({ size: DECAL_BUFFER_WORDS * 4, usage: 0x80 | 0x08 }); // STORAGE | COPY_DST
      // The aerial perspective (F5a-2): written in compute for each camera, read as a uniform by the scene.
      const aerialBuffer = device.createBuffer({ size: AERIAL_LUT_BYTES, usage: 0x40 | 0x80 | 0x04 }); // UNIFORM | STORAGE | COPY_SRC (read back by its tests)
      // The volumetric fog's volume (F5b): a 1³ stand-in until a frame has fog, then the fog's own.
      const fogVolume = { texture: device.createTexture({ size: { width: 1, height: 1, depthOrArrayLayers: 1 }, dimension: "3d", format: FOG_FORMAT, usage: 0x04 }) };
      const iblSampler = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" });
      const atlasBlank = hdr
        ? device.createTexture({ size: { width: 1, height: 1 }, format: "depth32float", usage: 0x04 | 0x10 }) // TEXTURE_BINDING | RENDER_ATTACHMENT
        : device.createTexture({ size: { width: 1, height: 1 }, format: "r32float", usage: 0x04 | 0x02 });
      const probesBlank = device.createBuffer({ size: 16, usage: 0x80 | 0x08 }); // STORAGE | COPY_DST: one zeroed texel
      // Refraction (I5): the opaque scene's colour, copied (or resolved) into this as the
      // see-through pass begins; a 1×1 blank stands in for it in the opaque pass.
      const behind = device.createTexture({ size: { width, height }, format: colourFormat, usage: 0x04 | 0x02 | 0x10 }); // TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT (a resolve target)
      const behindBlank = device.createTexture({ size: { width: 1, height: 1 }, format: colourFormat, usage: 0x04 | 0x02 });
      // The frame-sized targets the groups bind: a resize swaps them and remakes the groups (F0d).
      const sized = { depth: depthTexture, behind };
      // The sun's cascades (F2a): a 1×1 stand-in until a frame casts, each cascade's light view, and the
      // depth-only pipeline that draws them (the linear-light renderer's alone).
      const cascadeLayout = device.createBindGroupLayout({ entries: [{ binding: 12, visibility: SHADER_STAGE_VERTEX, buffer: { type: "uniform" } }] });
      const cascadeViews = Array.from({ length: CASCADE_COUNT }, () => {
        const buffer = device.createBuffer({ size: 64, usage: 0x40 | 0x08 }); // UNIFORM | COPY_DST
        return { buffer, group: device.createBindGroup({ layout: cascadeLayout, entries: [{ binding: 12, resource: { buffer } }] }) };
      });
      const casterLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: SHADER_STAGE_VERTEX, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: UNIFORM_BYTES_USED } },
          { binding: 10, visibility: SHADER_STAGE_VERTEX, buffer: { type: "read-only-storage" } },
        ],
      });
      // Cut-out casters also read their material and base map (F2a-2).
      const cutLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: SHADER_STAGE_VERTEX | SHADER_STAGE_FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: UNIFORM_BYTES_USED } },
          { binding: 1, visibility: SHADER_STAGE_FRAGMENT, sampler: { type: "filtering" } },
          { binding: 2, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } },
          { binding: 10, visibility: SHADER_STAGE_VERTEX, buffer: { type: "read-only-storage" } },
        ],
      });
      const casterModule = hdr ? device.createShaderModule({ code: sceneShader(null, false, hdr) }) : null;
      // Slope-scaled bias as it rasterises, against acne on faces the sun grazes.
      const casterDepth = { format: CASCADE_FORMAT, depthWriteEnabled: true, depthCompare: "less", depthBias: 2, depthBiasSlopeScale: 1.5 };
      // The spot/point tiles (F2d) keep the full float depth a perspective map needs; their bias is the shader's, in world units.
      const localDepth = { format: "depth32float", depthWriteEnabled: true, depthCompare: "less" };
      const casterVertex = (entryPoint: string, uv: boolean) => ({
        module: casterModule,
        entryPoint,
        buffers: [
          {
            arrayStride: 64,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              ...(uv ? [{ shaderLocation: 2, offset: 24, format: "float32x2" }] : []),
              { shaderLocation: 5, offset: 44, format: "float32" },
            ],
          },
        ],
      });
      const localViews = hdr
        ? Array.from({ length: MAX_GPU_LOCAL_TILES }, () => {
            const buffer = device.createBuffer({ size: 64, usage: 0x40 | 0x08 }); // UNIFORM | COPY_DST
            return { buffer, group: device.createBindGroup({ layout: cascadeLayout, entries: [{ binding: 12, resource: { buffer } }] }) };
          })
        : [];
      const cascades: CascadeResources = {
        texture: device.createTexture({ size: { width: 1, height: 1, depthOrArrayLayers: CASCADE_COUNT }, format: CASCADE_FORMAT, usage: 0x10 | 0x04 }),
        size: 0,
        sampler: device.createSampler({ compare: "less-equal", magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }),
        views: cascadeViews,
        casterLayout,
        cutLayout,
        pipeline: casterModule
          ? device.createRenderPipeline({
              layout: device.createPipelineLayout({ bindGroupLayouts: [casterLayout, cascadeLayout] }),
              vertex: {
                module: casterModule,
                entryPoint: "vs_shadow",
                buffers: [{ arrayStride: 64, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 5, offset: 44, format: "float32" }] }],
              },
              primitive: { topology: "triangle-list", cullMode: "none" },
              depthStencil: casterDepth,
            })
          : null,
        cutPipeline: casterModule
          ? device.createRenderPipeline({
              layout: device.createPipelineLayout({ bindGroupLayouts: [cutLayout, cascadeLayout] }),
              vertex: {
                module: casterModule,
                entryPoint: "vs_shadow_cut",
                buffers: [
                  {
                    arrayStride: 64,
                    attributes: [
                      { shaderLocation: 0, offset: 0, format: "float32x3" },
                      { shaderLocation: 2, offset: 24, format: "float32x2" },
                      { shaderLocation: 5, offset: 44, format: "float32" },
                    ],
                  },
                ],
              },
              fragment: { module: casterModule, entryPoint: "fs_shadow_cut", targets: [] },
              primitive: { topology: "triangle-list", cullMode: "none" },
              depthStencil: casterDepth,
            })
          : null,
        localViews,
        localPipeline: casterModule
          ? device.createRenderPipeline({
              layout: device.createPipelineLayout({ bindGroupLayouts: [casterLayout, cascadeLayout] }),
              vertex: casterVertex("vs_shadow", false),
              primitive: { topology: "triangle-list", cullMode: "none" },
              depthStencil: localDepth,
            })
          : null,
        localCutPipeline: casterModule
          ? device.createRenderPipeline({
              layout: device.createPipelineLayout({ bindGroupLayouts: [cutLayout, cascadeLayout] }),
              vertex: casterVertex("vs_shadow_cut", true),
              fragment: { module: casterModule, entryPoint: "fs_shadow_cut", targets: [] },
              primitive: { topology: "triangle-list", cullMode: "none" },
              depthStencil: localDepth,
            })
          : null,
      };
      const makeGroups = (atlas: any, probes: any) => {
        const shared = [
          { binding: 1, resource: { buffer: clusterBuffers.data } },
          { binding: 2, resource: { buffer: probes } },
          { binding: 3, resource: { buffer: clusterBuffers.params } },
          { binding: 4, resource: atlas.createView() },
          { binding: 5, resource: { buffer: shadowTiles } },
          { binding: 8, resource: { buffer: dfgBuffer } },
          { binding: 9, resource: iblSampler },
          { binding: 10, resource: { buffer: ltcBuffer } },
          { binding: 13, resource: { buffer: decalBuffer } },
          { binding: 11, resource: cascades.sampler },
          ...(hdr ? [{ binding: 14, resource: { buffer: aerialBuffer } }, { binding: 6, resource: fogVolume.texture.createView({ dimension: "3d" }) }] : []),
        ];
        return {
          blank: device.createBindGroup({ layout: depthLayout, entries: [{ binding: 0, resource: blankDepth.createView() }, ...shared, { binding: 7, resource: behindBlank.createView() }] }),
          scene: device.createBindGroup({ layout: depthLayout, entries: [{ binding: 0, resource: sized.depth.createView() }, ...shared, { binding: 7, resource: sized.behind.createView() }] }),
          // The opaque pass after a prepass (F2d-3): the depths, but not the scene it is still drawing (and may resolve into).
          opaque: device.createBindGroup({ layout: depthLayout, entries: [{ binding: 0, resource: sized.depth.createView() }, ...shared, { binding: 7, resource: behindBlank.createView() }] }),
        };
      };
      const makeGroupsMs = (atlas: any, probes: any, blank: any, depth: any) => {
        const shared = [
          { binding: 1, resource: { buffer: clusterBuffers.data } },
          { binding: 2, resource: { buffer: probes } },
          { binding: 3, resource: { buffer: clusterBuffers.params } },
          { binding: 4, resource: atlas.createView() },
          { binding: 5, resource: { buffer: shadowTiles } },
          { binding: 8, resource: { buffer: dfgBuffer } },
          { binding: 9, resource: iblSampler },
          { binding: 10, resource: { buffer: ltcBuffer } },
          { binding: 13, resource: { buffer: decalBuffer } },
          { binding: 11, resource: cascades.sampler },
          ...(hdr ? [{ binding: 14, resource: { buffer: aerialBuffer } }, { binding: 6, resource: fogVolume.texture.createView({ dimension: "3d" }) }] : []),
        ];
        return {
          blank: device.createBindGroup({ layout: depthLayoutMs, entries: [{ binding: 0, resource: blank.createView() }, ...shared, { binding: 7, resource: behindBlank.createView() }] }),
          scene: device.createBindGroup({ layout: depthLayoutMs, entries: [{ binding: 0, resource: depth.createView() }, ...shared, { binding: 7, resource: sized.behind.createView() }] }),
          opaque: device.createBindGroup({ layout: depthLayoutMs, entries: [{ binding: 0, resource: depth.createView() }, ...shared, { binding: 7, resource: behindBlank.createView() }] }),
        };
      };
      const depthGroups = {
        ...makeGroups(atlasBlank, probesBlank),
        blankTexture: blankDepth,
        sized,
        behindBlank,
        clusters: clusterBuffers,
        shadowTiles,
        dfg: dfgBuffer,
        ltc: ltcBuffer,
        decals: decalBuffer,
        aerial: aerialBuffer,
        fogVolume,
        atlas: atlasBlank,
        atlasBlank: true,
        probes: probesBlank,
        probesBlank: true,
        probeSource: null,
        cascades,
        makeGroups,
        makeGroupsMs,
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
        // With mip chains (F1a): trilinear, and 16× anisotropic for surfaces seen at a glancing angle.
        ...(mips ? { mipmapFilter: "linear", maxAnisotropy: MAX_ANISOTROPY } : {}),
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
        hdr,
        mips,
      );
    } catch {
      return null;
    }
  }

  /** The sun's cascade maps (F2a) at `size`², made on a size change. */
  private ensureCascadeTexture(size: number): void {
    const groups = this.depthGroups;
    const res = groups.cascades;
    if (res.size === size) return;
    destroySafely(res.texture);
    res.texture = this.device.createTexture({ size: { width: size, height: size, depthOrArrayLayers: CASCADE_COUNT }, format: CASCADE_FORMAT, usage: 0x10 | 0x04 }); // RENDER_ATTACHMENT | TEXTURE_BINDING
    res.size = size;
    // Every draw's group 0 binds it (binding 6): their cached groups are stale.
    this.bindGroups = new WeakMap();
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
  private ensureEnvTexture(environment: EnvironmentLight | null): void {
    if (this.hdr) {
      this.ensureIbl(environment);
      return;
    }
    const map = environment?.map ?? null;
    if (map === this.envMapSource) return;
    if (this.envMapSource) destroySafely(this.envTexture); // release the previous upload
    this.envTexture = map ? this.uploadRgba(map) : this.blankTexture;
    this.envMapSource = map;
    this.bindGroups = new WeakMap(); // binding 7 changed identity
  }

  /**
   * The linear variant's environment (F3a): its panorama (or gradient) in
   * linear light, prefiltered into the cube at binding 7 and projected into the
   * SH the frame carries, rebuilt only when what it's made of changes.
   */
  private ensureIbl(environment: EnvironmentLight | null): void {
    const key = environment ? environmentKey(environment) : null;
    const same = key && this.iblKey ? key.length === this.iblKey.length && key.every((v, i) => v === this.iblKey![i]) : key === this.iblKey;
    if (same) return;
    destroySafely(this.envTexture);
    if (environment) {
      const pano = environmentPanorama(environment);
      this.envTexture = (this.ibl ??= new IblBuilder(this.device)).build(pano);
      this.iblSh = environmentSh(pano);
    } else {
      this.envTexture = blankCube(this.device);
      this.iblSh = new Float32Array(36);
    }
    this.iblKey = key;
    this.bindGroups = new WeakMap(); // binding 7 changed identity
  }

  /** The frame's projected decals (F1f) into their buffer: the boxes each frame they change, the tiles when they do. */
  private uploadDecals(draw: GpuSceneDraw, eye: readonly [number, number, number]): void {
    const decals = draw.decals ?? null;
    const buffer = this.depthGroups.decals;
    if (decals && decals.tiles !== this.decalTiles) {
      const tiles = packDecalTiles(decals.tiles);
      this.device.queue.writeBuffer(buffer, DECAL_TILES_AT * 4, tiles, 0, tiles.length);
      this.decalTiles = decals.tiles;
    }
    const boxes = decals ? decals.boxes : [];
    if (boxes.length === 0 && this.decalCount === 0) return;
    const head = packDecalBoxes(boxes, eye);
    this.device.queue.writeBuffer(buffer, 0, head, 0, head.length);
    this.decalCount = head[0]!;
  }
  private decalTiles: unknown = null;
  private decalCount = 0;

  /**
   * The linear variant's probes (F3b): captured on the GPU into the cube array
   * bound at 12, a probe a frame, and their boxes (13), each marked once captured.
   */
  private updateProbeCapture(draw: GpuSceneDraw): void {
    const capture = draw.reflectionCapture ?? null;
    if (!this.probeBuffer) {
      this.probeBuffer = this.device.createBuffer({ size: MAX_REFLECTION_PROBES * PROBE_FLOATS * 4, usage: 0x80 | 0x08 }); // STORAGE | COPY_DST
      this.bindGroups = new WeakMap();
    }
    if (capture && capture.probes.length > 0 && !this.probeCapture) {
      const device = this.device;
      this.probeCapture = new ProbeCapture(device, () => WebgpuSceneRenderer.create(device, PROBE_FACE, PROBE_FACE, undefined, { hdr: true }));
      this.bindGroups = new WeakMap(); // binding 12 changed identity
    }
    if (!this.probeCapture) {
      this.capturedProbes = 0;
      return;
    }
    this.probeCapture.update(capture, draw, this.envTexture);
    const packed = packCapturedProbes(this.probeCapture.current);
    const sig = packed.join(",");
    if (sig !== this.capturedSig) {
      this.device.queue.writeBuffer(this.probeBuffer, 0, packed, 0, packed.length);
      this.capturedSig = sig;
    }
    this.capturedProbes = this.probeCapture.current.length;
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
    // A linear HDR renderer keeps its frames on the GPU (renderToTexture); it has no bytes to read back.
    if (this.hdr) {
      this.software.render(applyScenePasses(instances, draw), draw);
      return;
    }

    if (draw.prepass === true) this.matchMotion(instances);
    // LOD-select + frustum-cull once, so both the CPU warm-up and the GPU submit
    // draw the same visible set. A correct cull is output-identical.
    const visible = applyScenePasses(instances, draw);

    // Composite the newest completed GPU frame, or rasterise this one on the CPU
    // while the pipeline fills. Either way `out` is correct when this returns.
    presentFrame(this.latest, visible, draw, this.software);

    // Back-pressure: with every staging buffer still waiting on the GPU, the GPU
    // is behind. Another frame could not be read back, so drawing it only queues
    // work in front of the readbacks already waited on: the backlog grows, each
    // readback lands later than the last, and the frame rate sinks the longer the
    // game runs. Skip it; the newest finished frame keeps showing. (A shadow map's
    // changed region goes unuploaded with it, so the next frame uploads it whole.)
    if (!this.readback.some((slot) => !slot.busy)) {
      this.shadowUploaded = null;
      this.nearUploaded = null;
      return;
    }
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

  get gpuDevice(): any {
    return this.device;
  }

  /** The linear-light renderer shadows the sun in its own cascades (F2a). */
  get sunCascades(): boolean {
    return this.hdr;
  }

  /** The colour targets' format: half-float in the linear HDR variant. */
  private get colourFormat(): string {
    return this.hdr ? "rgba16float" : "rgba8unorm";
  }

  /**
   * Draw the frame and leave it on the GPU (AAA_FIDELITY_ROADMAP.md F0a): the
   * same passes as {@link render}, ending in the colour texture instead of a
   * readback, so there is no lag and nothing to composite on the CPU. The
   * texture is premultiplied RGBA8 with alpha 0 where nothing drew, and holds
   * this frame until the next render.
   */
  renderToTexture(instances: readonly MeshSceneInstance[], given: GpuSceneDraw): any | null {
    if (this.destroyed) return null;
    // The path-traced reference (F10b) in place of the frame, accumulating while the view holds.
    if (this.hdr && given.viewMode === "pathTraced") {
      this.pathTracer ??= PathTracer.create(this.device);
      return this.pathTracer.render(applyScenePasses(instances, given), given, this.width, this.height);
    }
    const draw = this.hdr ? viewModeDraw(given) : given;
    if (draw.prepass === true) this.matchMotion(instances);
    const visible = applyScenePasses(instances, draw);
    try {
      this.submit(visible, draw, false);
    } catch {
      return null;
    }
    return this.frameOutput ?? this.colourTexture;
  }

  /** Samples each pixel of the path-traced reference holds (F10b); 0 when it isn't shown. */
  get referenceSamples(): number {
    return this.pathTracer?.samples ?? 0;
  }

  /** Render the path-traced reference of `instances` through `draw` at any size up to 8K (F10b; {@link captureReference}). */
  captureReference(instances: readonly MeshSceneInstance[], draw: GpuSceneDraw, options: CaptureOptions): Promise<ReferenceCapture> {
    return captureReference(this.device, applyScenePasses(instances, draw), draw, options);
  }

  settle(draw: SceneDraw): FrameState {
    if (this.destroyed) return "current";
    if (this.latest) compositeFrame(this.latest, draw);
    if (this.latestSeq >= this.submitted) return "current";
    return this.readSeq >= this.submitted ? "pending" : "stale";
  }

  /** Encode and submit one frame, and start a readback if a buffer is free (or, with `readback` false, leave it in the colour texture). */
  private submit(instances: readonly MeshSceneInstance[], draw: GpuSceneDraw, readback = true): void {
    // Temporal anti-aliasing (I2): this frame's jittered projection and the resolve's uniforms.
    // Temporal upscaling (F4b): a linear-light temporal frame with a prepass, shown larger than it renders.
    const display = this.hdr && draw.temporal === true && draw.prepass === true && draw.upscale && (draw.upscale.width > this.width || draw.upscale.height > this.height) ? { width: draw.upscale.width, height: draw.upscale.height } : null;
    const temporal = draw.temporal === true ? this.temporalState.begin(draw.view, draw.projection, this.width, this.height, display ? upscaleJitterPhases(this.width, display.width) : undefined) : null;
    if (!temporal) this.temporalState.reset();
    this.frameOutput = null;
    const viewProj = multiplyMat4(temporal ? temporal.projection : draw.projection, draw.view);

    // A new frame: a skinned mesh re-uploaded now keeps last frame's vertices for the velocity buffer (F0c).
    this.frameIndex += 1;
    const prepass = draw.prepass === true;
    // Batch the copies of each primitive that bind the same textures: one
    // uniform (addressed by a dynamic offset) and one instanced draw per batch.
    const { batches: draws, instanceCount } = batchInstances(instances, (mesh) => this.uploadMesh(mesh), cameraPositionFromView(draw.view));
    if (draws.length === 0) {
      this.prepassed = null;
      // A frame left on the GPU still has to say "nothing drew": clear it.
      if (!readback) this.clearColour();
      return;
    }

    // The sun's cascades (F2a): fitted to the camera, drawn on the GPU from everything that casts
    // (seen or not, opaque and cut-out, as the CPU map draws), and tested by the linear-light shader.
    // A caller that hands the linear-light renderer only a CPU map gets cascades of what it draws instead.
    const sun: SunShadow | null =
      this.hdr && this.depthGroups.cascades.pipeline
        ? (draw.sunShadow ??
          (draw.shadow && draw.lightDirection
            ? { casters: instances, toLight: draw.lightDirection, distance: FALLBACK_CASCADE_DISTANCE, size: FALLBACK_CASCADE_SIZE, reach: FALLBACK_CASCADE_DISTANCE, strength: draw.shadow.strength ?? 1 }
            : null))
        : null;
    // The spot and point lights' shadows (F2d) are drawn here too, from the same casters (or, given only
    // CPU tiles, from what the frame draws), into tiles sized by how much of the screen each light covers.
    const localSource = this.hdr && this.depthGroups.cascades.localPipeline ? (draw.localShadowCasters ?? (draw.localShadows ? instances : null)) : null;
    const localPlan = localSource && draw.lights?.length ? planLocalTiles(draw.lights, cameraPositionFromView(draw.view), 1 / (draw.projection[5] || 1)) : null;
    const casterSource = sun?.casters ?? (localPlan && localPlan.tiles.length > 0 ? localSource : null);
    const casting = casterSource ? batchInstances(casterSource, (mesh) => this.uploadMesh(mesh), cameraPositionFromView(draw.view)) : null;
    const casters = casting ? casting.batches.filter((entry) => entry.alpha < 2 && !entry.refract) : [];
    this.frameLocalTiles = localPlan && casters.length > 0 ? localPlan.tiles : null;
    const cascadeFit = sun && casters.length > 0 ? fitCascades({ view: draw.view, projection: draw.projection, toLight: sun.toLight, distance: sun.distance, size: sun.size, reach: sun.reach }) : null;
    this.frameCascades = cascadeFit && sun ? { cascades: cascadeFit, size: sun.size, strength: sun.strength ?? 1, softness: sun.softness ?? SUN_SOFTNESS } : null;
    if (cascadeFit && sun) this.ensureCascadeTexture(sun.size);
    // Virtual shadow maps (F2b): the pages the last marks asked for, given out and drawn as the pool allows.
    this.frameVsm = this.hdr && prepass && sun !== null && cascadeFit !== null && draw.virtualShadows ? this.planVsm(draw, sun.toLight, sun.strength ?? 1, sun.softness ?? SUN_SOFTNESS, temporal ? temporal.projection : draw.projection) : null;

    this.ensureUniformCapacity(draws.length + casters.length);
    // With a prepass, the frame's motion transforms (F0c) follow its transforms in the instance buffer; the casters' follow those.
    const casterBase = prepass ? instanceCount * 2 : instanceCount;
    this.ensureInstanceCapacity(casterBase + (casting?.instanceCount ?? 0));
    // Resolved once: the light and view direction are per frame, not per draw, and
    // normalising them per primitive would be the same answer computed many times.
    const light = resolveLight(draw.lightDirection, draw.ambient);
    const viewDir = viewDirection(draw.view);
    const eye = cameraPositionFromView(draw.view);

    // Shadow map: the CPU-generated map (renderShadowMap) uploaded as r32float so
    // the GPU samples the *same* depths the software path tests against. `size` 0
    // restores the blank when this frame casts no shadow.
    // The linear-light renderer never samples it: its sun's shadow is the GPU cascades (F2a).
    const shadow = this.hdr ? null : (draw.shadow ?? null);
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
      ? { size: shadow.size, bias: shadow.bias ?? 0.003, strength: shadow.strength ?? 1, slopeBias: shadow.slopeBias ?? 0, pcf: shadow.pcf ?? false, soft: shadow.soft ?? false }
      : null;

    // Env map: uploaded once per distinct decoded panorama; the uniform's
    // envMeta.w (written from environment.average) gates whether it is sampled.
    this.ensureEnvTexture(draw.environment ?? null);
    // The linear variant captures its own probes on the GPU (F3b); the others take the CPU's baked panoramas.
    if (this.hdr) this.updateProbeCapture(draw);
    if (this.hdr) this.uploadDecals(draw, eye);
    else this.ensureProbes(draw.environment?.probes ?? null);

    // SSAO: upload the CPU-generated AO buffer (same one the software path uses)
    // for the shader to sample per fragment.
    const ssao = draw.ssao ?? null;
    // Contact shadows (F2c) need the prepass's depths and a sun whose shadow they finish; GTAO (F3c) the depths alone.
    this.frameContact = this.hdr && prepass && this.frameCascades !== null && Boolean(draw.lightDirection);
    this.frameGtao = this.hdr && prepass && draw.ambientOcclusion !== false;
    // SSGI (F3e-2) reads last frame's resolved image: a temporal frame after another.
    this.frameSsgi = this.hdr && prepass && temporal !== null && temporal.uniforms[18] === 1 && this.taa !== null && draw.screenSpaceGi ? draw.screenSpaceGi : null;
    this.bindSsao(ssao, this.frameContact || this.frameGtao || this.frameSsgi !== null);

    // Modern-tier lights: packed global-first for the WGSL loop, the rest
    // sorted into the view's cells (EP8) so each fragment shades only its own.
    // With GPU tiles (F2d) the lights point at those, and the CPU's tiles aren't uploaded.
    // With a prepass the scene shades with its depths bound (F2d-3): how to read them.
    const drawnProjection = temporal ? temporal.projection : draw.projection;
    this.frameDepthView = this.hdr && prepass ? { viewProj, terms: [drawnProjection[10]!, drawnProjection[14]!] } : null;
    this.frameFog = this.prepareFog(draw);
    this.frameGi = this.hdr && draw.dynamicGi && draw.environment?.probeVolume ? draw.dynamicGi : null;
    const { ordered, globalCount, clusters: cells } = this.clusterLights(localPlan ? { ...draw, lights: localPlan.lights, localShadows: null } : draw);
    this.uploadLights(packLights(ordered, this.hdr, this.hdr ? this.iesSlots(ordered) : null));
    // The fog's local lights (F5b-2): as the scene's, by the same cells and tiles.
    if (this.frameFog) {
      const tiles = this.frameLocalTiles !== null && this.frameLocalTiles.length > 0;
      this.volumetricFog!.lights({ clusterParams: cells?.params ?? [1, 1, 1, 1], globalCount: cells ? globalCount : ordered.length, clustered: cells !== null, width: this.width, height: this.height, shadowBias: tiles ? LOCAL_SHADOW_BIAS : null });
    }
    const lightCount = ordered.length;

    const camera = refractionCamera(draw.view, this.height);
    // Each material its own ID in the thin G-buffer (F0c), 1 and up: 0 is "nothing drew".
    const materialIds = new Map<object, number>();
    const materialId = (material: object): number => {
      let id = materialIds.get(material);
      if (id === undefined) materialIds.set(material, (id = materialIds.size + 1));
      return id;
    };
    // Motion (F0c): each copy's clip transform now and last frame, both without
    // the temporal jitter, so a still scene under TAA has no velocity.
    const viewProjNow = multiplyMat4(draw.projection, draw.view);
    const viewProjThen = this.lastViewProj ?? viewProjNow;
    const windNow = windUniform(draw.wind, draw.time ?? 0);
    const windThen = this.lastWind ?? windNow;
    // A batch's material uniforms. The transform fields are the first
    // copy's; the shader reads every copy's own from the instance buffer.
    const uniformOf = (entry: (typeof draws)[number]) => {
      const model = entry.models[0]!;
      const pbr = resolvePbr(
        entry.primitive.material,
        entry.textures.mr !== null,
        entry.textures.occ !== null,
        entry.textures.emis !== null,
      );
      return {
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
        // With real-time GI (F3e) every surface takes the live volume's light, a light-mapped one too.
        hasLightmap: !this.frameGi && (entry.textures.lm !== null || (this.hdr && entry.textures.lmHdr !== null)),
        hdrLightmap: !this.frameGi && this.hdr && entry.textures.lmHdr !== null,
        model,
        lightCount,
        // A volumetric fog (F5b) takes the place of the painted fade.
        fog: this.frameFog ? null : (draw.fog ?? null),
        eye,
        effect: entry.effect ?? null,
        time: draw.time ?? 0,
        alpha: { mode: entry.alpha, cutoff: entry.primitive.material.alphaCutoff ?? 0.5 },
        soft: softEdges(entry.primitive.material, entry.alpha, draw.projection),
        surface: resolveSurface(entry.primitive.material, draw.time ?? 0, entry.textures.detail !== null, entry.textures.mr !== null, {
          weights: entry.primitive.blend !== undefined,
          textured: entry.textures.blend !== null,
        }),
        layers: resolveLayers(entry.primitive.material, entry.textures.relief !== null),
        extensions: resolveExtensions(entry.primitive.material),
        refraction: entry.refract ? resolveRefraction(entry.primitive.material, effectActive(entry.effect) ? entry.effect : null) : null,
        camera,
        water: waterUniform(entry.primitive.material, draw.time ?? 0),
        waterAlong: waterAlong(entry.primitive.material),
        mapping: resolveMapping(entry.primitive.material),
        hasNormalMap: entry.textures.normal !== null,
        wind: entry.primitive.sway ? windNow : null,
        materialId: materialId(entry.primitive.material),
        windBefore: entry.primitive.sway ? windThen : null,
        motionBase: prepass ? instanceCount : 0,
        lodLevel: entry.lod ?? -1,
        lightChannels: entry.channels,
        ...(this.hdr ? { probeCount: this.capturedProbes, receivesDecals: entry.alpha < 2 && !entry.refract } : {}),
      };
    };
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
        if (prepass) {
          writeInstanceTransform(this.instanceData, instanceCount + next, {
            mvp: multiplyMat4(viewProjNow, model),
            lightMvp: multiplyMat4(viewProjThen, this.motion.get(model) ?? model),
            model,
            normalBasis: IDENTITY_BASIS,
          });
        }
        next += 1;
      }
      writeInstanceUniform(this.uniformData, index, uniformOf(entry));
    });
    // The casters (F2a): each copy's model in the instance buffer after the frame's, their uniforms after the draws'.
    let nextCaster = casterBase;
    casters.forEach((entry, k) => {
      entry.first = nextCaster;
      for (const model of entry.models) {
        writeInstanceTransform(this.instanceData, nextCaster, { mvp: model, lightMvp: null, model, normalBasis: IDENTITY_BASIS });
        nextCaster += 1;
      }
      writeInstanceUniform(this.uniformData, draws.length + k, uniformOf(entry));
    });
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData, 0, (draws.length + casters.length) * UNIFORM_FLOATS);
    this.device.queue.writeBuffer(this.instanceBuffer, 0, this.instanceData, 0, nextCaster * INSTANCE_FLOATS);
    this.lastViewProj = viewProjNow;
    this.lastWind = windNow;
    let triangles = 0;
    for (const entry of draws) triangles += (entry.geometry.indexCount / 3) * entry.models.length;
    this.lastFrameStats = {
      drawCalls: draws.length,
      instances: instanceCount,
      triangles,
      gpuMs: this.timer?.lastMs ?? null,
      ...(this.timer && this.timer.lastPasses.length > 0 ? { passes: this.timer.lastPasses } : {}),
    };

    // Soft edges (EP6b) need the opaque depth readable, so a frame that has
    // any draws its see-through batches in a second pass, with the depth
    // attached read-only and bound for the shader to sample.
    // Refraction (I5) reads the opaque scene's colour the same way: copied
    // (or resolved) between the two passes.
    const refract = draws.some((entry) => entry.refract);
    // The AAA tier's TAA (F4a) masks what the see-through draws change, so it draws them apart too.
    const hdrTaa = this.hdr && temporal !== null && prepass;
    const split = refract || draws.some((entry) => softEdges(entry.primitive.material, entry.alpha, draw.projection) !== undefined) || (hdrTaa && draws.some((entry) => entry.alpha >= 2));
    const firstSeeThrough = split ? draws.findIndex((entry) => entry.alpha >= 2 || entry.refract) : -1;
    const seeThrough = firstSeeThrough >= 0;
    // Anti-aliased (I1): draw into multisampled targets and resolve into the colour texture as the last scene pass ends.
    const msaa = draw.antialias === true ? this.ensureMsaa() : null;
    const reflections = draw.reflections === true ? this.ensureReflections() : null;
    // Overdraw (F10a) adds every fragment up, depth unwritten.
    const overdraw = this.hdr && viewModeCode(draw.viewMode) === 11;
    const drawRange = (pass: any, from: number, to: number, depthGroup: any) => {
      pass.setBindGroup(1, depthGroup);
      let bound: any = null;
      for (let index = from; index < to; index += 1) {
        const entry = draws[index]!;
        const set = this.pipelinesOf(entry.primitive.material, msaa ? MSAA_SAMPLES : 1, reflections !== null, prepass);
        // A refracting draw covers what it bends (premultiplied, alpha 1), or blends or adds as usual where it bends nothing.
        const wanted = overdraw ? set.add : entry.refract ? set.blend : entry.alpha === 3 ? set.add : entry.alpha === 2 ? set.blend : set.opaque;
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
    // The prepass draws every batch the opaque pipeline does: opaque and cut-out, not refracting.
    const prepassRange = (pass: any) => {
      pass.setBindGroup(1, (msaa ? msaa.groups : this.depthGroups).blank);
      let bound: any = null;
      for (let index = 0; index < draws.length; index += 1) {
        const entry = draws[index]!;
        if (entry.refract || entry.alpha >= 2) continue;
        const wanted = this.pipelinesOf(entry.primitive.material, msaa ? MSAA_SAMPLES : 1, reflections !== null, true).prepass;
        if (wanted !== bound) {
          pass.setPipeline(wanted);
          bound = wanted;
        }
        pass.setBindGroup(0, this.bindGroupFor(entry.primitive, entry.textures), [index * UNIFORM_STRIDE]);
        pass.setVertexBuffer(0, entry.geometry.vertexBuffer);
        // Last frame's vertices: a skinned mesh's from before this frame's upload, else these.
        const moved = entry.geometry.previousBuffer && entry.geometry.movedFrame === this.frameIndex;
        pass.setVertexBuffer(1, moved ? entry.geometry.previousBuffer : entry.geometry.vertexBuffer);
        pass.setIndexBuffer(entry.geometry.indexBuffer, "uint32");
        pass.drawIndexed(entry.geometry.indexCount, entry.models.length, 0, 0, entry.first);
      }
    };

    // The frame as a graph (AAA_FIDELITY_ROADMAP.md F0c): each pass names the
    // textures it reads and writes; the graph keeps the passes the frame's
    // outputs need, makes the transient targets (and reuses them frame to
    // frame), and times every pass.
    const graph = new FrameGraph();
    const size = { width: this.width, height: this.height };
    const colour = graph.importTexture("colour", this.colourTexture);
    // The depth stays the renderer's own: the see-through pass's bind groups sample it.
    const depth = graph.importTexture("depth", msaa ? msaa.depth : this.depthTexture);
    const msColour = msaa ? graph.createTexture("colour.msaa", { format: this.colourFormat, ...size, sampleCount: MSAA_SAMPLES }) : null;
    // Reflections (I3): the ray and environment targets beside the colour, and their multisampled twins.
    const rays = reflections ? ["reflect.ray", "reflect.env"].map((name) => graph.createTexture(name, { format: "rgba16float", ...size })) : [];
    const raysMs = msaa ? rays.map((ray) => graph.createTexture(`${ray.name}.msaa`, { format: "rgba16float", ...size, sampleCount: MSAA_SAMPLES })) : [];
    // Refraction (I5) reads the opaque scene's colour, copied (or resolved) between the two scene passes.
    // The AAA tier's TAA reads it too, for its reactive mask (F4a).
    const behind = (refract || hdrTaa) && seeThrough ? graph.importTexture("behind", this.depthGroups.sized.behind) : null;
    const groups = msaa ? msaa.groups : this.depthGroups;
    const target = msColour ?? colour;
    const rayTargets = msaa ? raysMs : rays;
    const opaqueEnd = seeThrough ? firstSeeThrough : draws.length;

    // The sun's cascades (F2a): each drawn from the casters into its layer of the map, before
    // anything shades against it. The scene passes read it through group 1, so the graph keeps it.
    if (cascadeFit) {
      const res = this.depthGroups.cascades;
      cascadeFit.forEach((c, i) => this.device.queue.writeBuffer(res.views[i]!.buffer, 0, new Float32Array(c.viewProj)));
      const map = graph.importTexture("cascades", res.texture);
      graph.addPass("shadow cascades", "render", (pass) => {
        pass.write(map);
        pass.keep();
        return (ctx) => {
          const group = this.device.createBindGroup({
            layout: res.casterLayout,
            entries: [
              { binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: UNIFORM_STRIDE } },
              { binding: 10, resource: { buffer: this.instanceBuffer } },
            ],
          });
          cascadeFit.forEach((_, i) => {
            const encoded = ctx.encoder.beginRenderPass({
              colorAttachments: [],
              depthStencilAttachment: {
                view: ctx.texture(map).createView({ dimension: "2d", baseArrayLayer: i, arrayLayerCount: 1 }),
                depthClearValue: 1,
                depthLoadOp: "clear",
                depthStoreOp: "store",
              },
              ...timingSpan(ctx.timing, i, cascadeFit.length),
            });
            encoded.setBindGroup(1, res.views[i]!.group);
            // The solid casters, depth alone; then the cut-out ones, dropping what their material does (F2a-2).
            for (const cut of [false, true]) {
              encoded.setPipeline(cut ? res.cutPipeline : res.pipeline);
              casters.forEach((entry, k) => {
                if ((entry.alpha === 1) !== cut) return;
                encoded.setBindGroup(0, cut ? this.cutGroupFor(entry.primitive, entry.textures) : group, [(draws.length + k) * UNIFORM_STRIDE]);
                encoded.setVertexBuffer(0, entry.geometry.vertexBuffer);
                encoded.setIndexBuffer(entry.geometry.indexBuffer, "uint32");
                encoded.drawIndexed(entry.geometry.indexCount, entry.models.length, 0, 0, entry.first);
              });
            }
            encoded.end();
          });
        };
      });
    }

    if (this.frameVsm && this.frameVsm.draws.length > 0) this.addVsmPages(graph, this.frameVsm.draws, casters, draws.length);

    // The spot/point lights' tiles (F2d): the casters drawn through each tile's face into its rect of the atlas.
    // The atlas is kept from frame to frame (F2d-2): a tile is drawn again only when its light, rect or the
    // still casters change, or something that moves reaches its light now or did when last drawn.
    const localTiles = this.frameLocalTiles;
    const atlasTexture = localTiles && localTiles.length > 0 ? this.ensureLocalAtlas() : null;
    const statics = draw.localShadowKey ?? null;
    const movers = draw.localShadowMoved ?? [];
    const redraw =
      localTiles && localPlan
        ? localTiles.flatMap((t, i) => {
            const light = localPlan.lights[t.light]!;
            // Without a key for the still casters, nothing can be trusted to hold: every tile is drawn.
            const key = statics === null ? null : localTileKey(t, light, statics);
            const moving = movers.some((m) => reachesLight(m, light));
            if (key !== null && !this.localCache.dirty(t, key, moving)) return [];
            this.localCache.drawn(t, key ?? "uncached", moving || key === null);
            return [i];
          })
        : [];
    if (localTiles && atlasTexture && redraw.length > 0) {
      const res = this.depthGroups.cascades;
      redraw.forEach((i) => this.device.queue.writeBuffer(res.localViews[i]!.buffer, 0, new Float32Array(localTiles[i]!.drawViewProj)));
      const map = graph.importTexture("local shadows", atlasTexture);
      const clearPipeline = this.localClearPipeline();
      graph.addPass("local shadows", "render", (pass) => {
        // The tiles not drawn this frame keep their maps.
        pass.read(map, "attachment");
        pass.write(map);
        pass.keep();
        return (ctx) => {
          const group = this.device.createBindGroup({
            layout: res.casterLayout,
            entries: [
              { binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: UNIFORM_STRIDE } },
              { binding: 10, resource: { buffer: this.instanceBuffer } },
            ],
          });
          const encoded = ctx.encoder.beginRenderPass({
            colorAttachments: [],
            depthStencilAttachment: { view: ctx.texture(map).createView(), depthLoadOp: "load", depthStoreOp: "store" },
            ...ctx.timing,
          });
          redraw.forEach((i) => {
            const t = localTiles[i]!;
            encoded.setViewport(t.x, t.y, t.size, t.size, 0, 1);
            encoded.setScissorRect(t.x, t.y, t.size, t.size);
            // The rect back to the far plane, then this frame's casters.
            encoded.setPipeline(clearPipeline);
            encoded.draw(3);
            encoded.setBindGroup(1, res.localViews[i]!.group);
            for (const cut of [false, true]) {
              encoded.setPipeline(cut ? res.localCutPipeline : res.localPipeline);
              casters.forEach((entry, k) => {
                if ((entry.alpha === 1) !== cut) return;
                encoded.setBindGroup(0, cut ? this.cutGroupFor(entry.primitive, entry.textures) : group, [(draws.length + k) * UNIFORM_STRIDE]);
                encoded.setVertexBuffer(0, entry.geometry.vertexBuffer);
                encoded.setIndexBuffer(entry.geometry.indexBuffer, "uint32");
                encoded.drawIndexed(entry.geometry.indexCount, entry.models.length, 0, 0, entry.first);
              });
            }
          });
          encoded.end();
        };
      });
    }

    // The volumetric fog (F5b): its froxels lit through the cascades and the spot/point tiles just drawn, then
    // integrated, before the scene samples it.
    const fog = this.frameFog ? this.volumetricFog : null;
    if (fog) {
      const groups = this.depthGroups;
      graph.addPass("volumetric fog", "compute", (pass) => {
        pass.keep();
        return (ctx) =>
          fog.encode(ctx.encoder, { cascades: groups.cascades.texture, sampler: groups.cascades.sampler, lights: this.lightBuffer, clusters: groups.clusters.data, tiles: groups.shadowTiles, atlas: groups.atlas }, ctx.timing);
      });
    }

    // Real-time GI (F3e): the probe volume the scene reads, traced and relit before anything shades by it.
    const liveGi = this.frameGi;
    const volume = draw.environment?.probeVolume ?? null;
    if (liveGi && volume) {
      const gi = this.tracerFor(liveGi.key, liveGi.occluders);
      const env = draw.environment!;
      if (this.giSky?.source !== env) this.giSky = { source: env, sky: environmentPanorama(env) };
      const sky = this.giSky.sky;
      const groups = this.depthGroups;
      graph.addPass("dynamic gi", "compute", (pass) => {
        pass.keep();
        return (ctx) => gi.update(ctx.encoder, groups.probes, volume, liveGi.settings, draw.lights ?? [], sky, ctx.timing);
      });
    }

    // The depth prepass and thin G-buffer (F0c): the opaque depth, and the
    // G-buffer (the renderer's own, so it outlives the frame for what reads it).
    const gbuffer = prepass ? graph.importTexture("gbuffer", this.ensureGbuffer()) : null;
    const velocity = prepass ? graph.importTexture("velocity", this.ensureVelocity()) : null;
    const gbufferMs = gbuffer && msaa ? graph.createTexture("gbuffer.msaa", { format: GBUFFER_FORMAT, ...size, sampleCount: MSAA_SAMPLES }) : null;
    const velocityMs = velocity && msaa ? graph.createTexture("velocity.msaa", { format: VELOCITY_FORMAT, ...size, sampleCount: MSAA_SAMPLES }) : null;
    if (gbuffer && velocity) {
      graph.addPass("prepass", "render", (pass) => {
        pass.write(depth);
        for (const [drawn, resolved] of [[gbufferMs, gbuffer], [velocityMs, velocity]] as const) {
          pass.write(drawn ?? resolved);
          if (drawn) pass.write(resolved);
        }
        return (ctx) => {
          const target = (drawn: FrameResource | null, resolved: FrameResource) => ({
            view: ctx.texture(drawn ?? resolved).createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            ...(drawn ? { resolveTarget: ctx.texture(resolved).createView(), storeOp: "discard" } : { storeOp: "store" }),
          });
          const encoded = ctx.encoder.beginRenderPass({
            colorAttachments: [target(gbufferMs, gbuffer), target(velocityMs, velocity)],
            depthStencilAttachment: { view: ctx.texture(depth).createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
            ...ctx.timing,
          });
          prepassRange(encoded);
          encoded.end();
        };
      });
    }
    this.prepassed = prepass ? { depth: msaa ? msaa.depth : this.depthTexture, gbuffer: this.gbuffer!, velocity: this.velocity!, multisampled: msaa !== null } : null;
    // The pages the frame's pixels want (F2b), marked from the prepass's depths and read back for a later frame.
    if (this.frameVsm) this.addVsmMarks(graph, depth, msaa !== null);
    // Contact shadows (F2c), GTAO (F3c), SSGI (F3e-2) and the virtual shadow maps' sampling (F2b) read the
    // prepass's depths, before anything shades against them.
    if (this.frameContact || this.frameGtao || this.frameSsgi || this.frameVsm) {
      this.addScreenShading(graph, depth, gbuffer, velocity, draw.view, temporal ? temporal.projection : draw.projection, this.frameContact ? draw.lightDirection ?? null : null, ssao !== null, msaa !== null);
    }

    // After a prepass the linear-light renderer's opaque pass holds the depths read-only and binds them (F2d-3).
    const readDepths = prepass && this.hdr;
    const scenePass = (name: string, from: number, to: number, load: boolean, last: boolean) =>
      graph.addPass(name, "render", (pass) => {
        // The pass that ends the scene resolves the samples (and need not keep them).
        const resolving = msaa !== null && last;
        // An anti-aliased frame that refracts resolves the opaque scene for the see-through pass to read.
        const resolveBehind = msaa !== null && behind !== null && !load;
        for (const t of [target, ...rayTargets]) {
          if (load) pass.read(t, "attachment");
          pass.write(t);
        }
        if (resolving) for (const t of [colour, ...rays]) pass.write(t);
        if (resolveBehind) pass.write(behind!);
        // After a prepass the opaque pass shades against its depths rather than clearing them, and reads them
        // as it shades (F2d-3), so it holds them read-only.
        if (load || prepass) pass.read(depth, "attachment");
        if (!load && !readDepths) pass.write(depth);
        return (ctx) => {
          const attachment = (t: FrameResource, resolved: FrameResource | null) => ({
            view: ctx.texture(t).createView(),
            // Transparent black: every untouched pixel reads as "nothing drawn",
            // which is what lets the composite leave the cart's frame showing.
            ...(load ? { loadOp: "load" } : { loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 } }),
            ...(resolved ? { resolveTarget: ctx.texture(resolved).createView(), storeOp: "discard" } : { storeOp: "store" }),
          });
          const encoded = ctx.encoder.beginRenderPass({
            colorAttachments: [
              { ...attachment(target, resolving ? colour : null), ...(resolveBehind ? { resolveTarget: ctx.texture(behind!).createView() } : {}) },
              ...rayTargets.map((t, k) => attachment(t, resolving ? rays[k]! : null)),
            ],
            depthStencilAttachment: load || readDepths
              ? { view: ctx.texture(depth).createView(), depthReadOnly: true }
              : prepass
                ? { view: ctx.texture(depth).createView(), depthLoadOp: "load", depthStoreOp: "store" }
                : { view: ctx.texture(depth).createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
            ...ctx.timing,
          });
          drawRange(encoded, from, to, load ? groups.scene : readDepths ? groups.opaque : groups.blank);
          encoded.end();
        };
      });

    scenePass("opaque", 0, opaqueEnd, false, !seeThrough);
    if (behind && !msaa) {
      graph.addPass("behind", "transfer", (pass) => {
        pass.read(colour, "copySrc");
        pass.write(behind, "copyDst");
        return (ctx) => ctx.encoder.copyTextureToTexture({ texture: ctx.texture(colour) }, { texture: ctx.texture(behind) }, size);
      });
    }
    if (seeThrough) scenePass("see-through", firstSeeThrough, draws.length, true, true);
    // Before the reflections land on the opaque scene: what the see-through draws alone changed (F4a).
    const reactive = hdrTaa && seeThrough && behind ? this.addReactiveMask(graph, behind, colour) : null;
    // On the AAA tier, with the prepass's G-buffer, reflections trace the Hi-Z chain (F3f); elsewhere I3's march.
    if (reflections && this.hdr && gbuffer && velocity) this.addHizReflections(graph, colour, depth, gbuffer, velocity, rays, draw, temporal ? temporal.projection : draw.projection, msaa !== null);
    else if (reflections) this.addReflections(graph, reflections, colour, depth, rays, temporal ? temporal.projection : draw.projection, msaa !== null);
    // Motion vectors and overdraw (F10a) are coloured from the whole frame.
    const viewCode = this.hdr ? viewModeCode(draw.viewMode) : 0;
    if ((viewCode === 8 && velocity && gbuffer) || viewCode === 11) this.addViewResolve(graph, colour, velocity, gbuffer, viewCode);
    let shown = colour;
    if (temporal && display && velocity) shown = this.addUpscale(graph, temporal, colour, depth, velocity, reactive, display, msaa !== null);
    else if (temporal) this.addTemporal(graph, temporal.uniforms, colour, depth, msaa !== null, hdrTaa ? velocity : null, reactive);
    // The physical camera's depth of field and motion blur (F4c), on the resolved frame.
    if (this.hdr && draw.camera && this.frameDepthView && velocity && (draw.camera.dof || draw.camera.motionBlur)) {
      this.addCameraEffects(graph, shown, display ?? { width: this.width, height: this.height }, depth, velocity, draw.camera, this.frameDepthView.terms, msaa !== null);
    }

    const slot = readback ? this.readback.find((entry) => !entry.busy) : undefined;
    if (slot) {
      graph.addPass("readback", "transfer", (pass) => {
        pass.read(colour, "copySrc");
        pass.keep();
        return (ctx) =>
          ctx.encoder.copyTextureToBuffer(
            { texture: ctx.texture(colour) },
            { buffer: slot.buffer, bytesPerRow: this.bytesPerRow, rowsPerImage: this.height },
            size,
          );
      });
    }

    const encoder = this.device.createCommandEncoder();
    graph.run(encoder, this.transients, this.timer);
    this.device.queue.submit([encoder.finish()]);
    this.timer?.read();
    this.readVsmMarks();
    if (!readback) return;
    this.submitted += 1;
    if (slot) {
      slot.busy = true;
      slot.seq = this.submitted;
      this.readSeq = this.submitted;
      void this.drain(slot);
    }
  }

  /** Clear the colour texture to transparent black (a GPU-kept frame with nothing in it). */
  private clearColour(): void {
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.colourTexture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
    });
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /** The thin G-buffer (F0c), made on the first frame with a prepass. */
  private gbuffer: any = null;
  /** The velocity buffer (F0c), made with the G-buffer. */
  private velocity: any = null;
  /** What the last frame's prepass left, or null when it had none. */
  private prepassed: PrepassTargets | null = null;
  /** Frames submitted (a skinned mesh's previous vertices are this frame's when it moved in it). */
  private frameIndex = 0;
  /** Last frame's unjittered view-projection and wind, for motion vectors (F0c). */
  private lastViewProj: Mat4 | null = null;
  private lastWind: readonly [number, number, number, number] | null = null;
  /** Each mesh's copies' models last frame, in order, and this frame's matches: model → last frame's. */
  private lastModels = new Map<object, Mat4[]>();
  private motion = new Map<Mat4, Mat4>();

  private ensureGbuffer(): any {
    // RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC: drawn, sampled by what follows, and read back by tests.
    this.gbuffer ??= this.device.createTexture({ size: { width: this.width, height: this.height }, format: GBUFFER_FORMAT, usage: 0x10 | 0x04 | 0x01 });
    return this.gbuffer;
  }

  private ensureVelocity(): any {
    this.velocity ??= this.device.createTexture({ size: { width: this.width, height: this.height }, format: VELOCITY_FORMAT, usage: 0x10 | 0x04 | 0x01 });
    return this.velocity;
  }

  /**
   * Where each instance was last frame (F0c): its `previousModel`, or else the
   * model of the copy of its mesh (its LOD chain's first) at the same place
   * among that mesh's copies last frame. Matched before culling, so a copy
   * leaving the view doesn't shift the rest. A copy with no match hasn't moved.
   */
  private matchMotion(instances: readonly MeshSceneInstance[]): void {
    const models = new Map<object, Mat4[]>();
    const motion = new Map<Mat4, Mat4>();
    for (const instance of instances) {
      const key = instance.lod?.meshes[0] ?? instance.mesh;
      let list = models.get(key);
      if (!list) models.set(key, (list = []));
      const previous = instance.previousModel ?? this.lastModels.get(key)?.[list.length];
      if (previous) motion.set(instance.model, previous);
      list.push(instance.model);
    }
    this.lastModels = models;
    this.motion = motion;
  }

  /**
   * The last frame's depth prepass (AAA_FIDELITY_ROADMAP.md F0c), for
   * screen-space effects: its depth (multisampled in an anti-aliased frame)
   * and the thin G-buffer, an rgba16float of xy = octahedral world normal
   * facing the viewer, z = roughness and w = material ID (0 where nothing
   * opaque drew). Null when the frame had no prepass. Both hold until the next
   * frame. The velocity buffer (rg16float) is how far each opaque pixel moved
   * on screen since last frame, in UV units (x right, y down; 0 where nothing
   * drew), from the camera's motion, each object's and each skinned vertex's.
   */
  get prepassTargets(): PrepassTargets | null {
    return this.prepassed;
  }

  /** The reflection pass's uniforms and pipelines (I3), made on first use; its targets are the frame graph's. */
  private reflections: { uniforms: any; data: Float32Array<ArrayBuffer>; pipelines: [any, any] } | null = null;

  private ensureReflections(): NonNullable<WebgpuSceneRenderer["reflections"]> {
    this.reflections ??= {
      uniforms: this.device.createBuffer({ size: 160, usage: 0x40 | 0x08 }), // UNIFORM | COPY_DST
      data: new Float32Array(40),
      pipelines: [null, null],
    };
    return this.reflections;
  }

  /**
   * Swap on-screen reflections in for the probes' (HALO_INFINITE_STYLE_ROADMAP.md I3):
   * the pass reads the frame, its depth and the reflection targets and writes
   * the reflected frame, which is copied back over the colour.
   */
  private addReflections(
    graph: FrameGraph,
    reflections: NonNullable<WebgpuSceneRenderer["reflections"]>,
    colour: FrameResource,
    depth: FrameResource,
    rays: readonly FrameResource[],
    projection: Mat4,
    multisampled: boolean,
  ): void {
    const device = this.device;
    const k = multisampled ? 1 : 0;
    reflections.pipelines[k] ??= fullScreenPipeline(device, reflectionShaderWgsl(multisampled, this.hdr), "reflectPass", this.colourFormat);
    const pipeline = reflections.pipelines[k];
    const out = graph.createTexture("reflect.out", { format: this.colourFormat, width: this.width, height: this.height });
    graph.addPass("reflections", "render", (pass) => {
      pass.read(colour);
      pass.read(depth);
      for (const ray of rays) pass.read(ray);
      pass.write(out);
      return (ctx) => {
        device.queue.writeBuffer(reflections.uniforms, 0, reflectionUniforms(projection, "ndc", reflections.data));
        const encoded = ctx.encoder.beginRenderPass({
          colorAttachments: [{ view: ctx.texture(out).createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
          ...ctx.timing,
        });
        encoded.setPipeline(pipeline);
        encoded.setBindGroup(0, device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: reflections.uniforms } },
            { binding: 1, resource: ctx.texture(colour).createView() },
            { binding: 2, resource: ctx.texture(depth).createView() },
            { binding: 3, resource: ctx.texture(rays[0]!).createView() },
            { binding: 4, resource: ctx.texture(rays[1]!).createView() },
          ],
        }));
        encoded.draw(3);
        encoded.end();
      };
    });
    graph.addPass("reflections.copy", "transfer", (pass) => {
      pass.read(out, "copySrc");
      pass.write(colour, "copyDst");
      return (ctx) => ctx.encoder.copyTextureToTexture({ texture: ctx.texture(out) }, { texture: ctx.texture(colour) }, { width: this.width, height: this.height });
    });
  }

  /**
   * The AAA tier's reflections (F3f): the Hi-Z chain (sized to the frame), the accumulation's history (two,
   * swapping), the Epic trace's half-resolution target, the uniforms and the pipelines. Made on first use.
   */
  private hiz: { chain: any; levels: number; history: [any, any]; index: number; valid: boolean; frame: number; traced: any; blank: any; uniforms: any; data: Float32Array<ArrayBuffer>; sampler: any; copy: [any, any]; reduce: any; trace: any; accumulate: any; resolve: any } | null = null;

  private addHizReflections(graph: FrameGraph, colour: FrameResource, depth: FrameResource, gbuffer: FrameResource, velocity: FrameResource, rays: readonly FrameResource[], draw: GpuSceneDraw, projection: Mat4, multisampled: boolean): void {
    const device = this.device;
    const k = multisampled ? 1 : 0;
    const format = this.colourFormat;
    if (!this.hiz) {
      const levels = hizLevels(this.width, this.height);
      const full = { width: this.width, height: this.height };
      const history = () => device.createTexture({ size: full, format: "rgba16float", usage: 0x10 | 0x04 });
      this.hiz = {
        chain: device.createTexture({ size: full, format: "r32float", mipLevelCount: levels, usage: 0x10 | 0x04 | 0x01 }), // RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC (for captures)
        levels,
        history: [history(), history()],
        index: 0,
        valid: false,
        frame: 0,
        traced: null,
        blank: device.createTexture({ size: { width: 1, height: 1 }, format: "rgba16float", usage: 0x04 }),
        uniforms: device.createBuffer({ size: HIZ_UNIFORM_FLOATS * 4, usage: 0x40 | 0x08 }),
        data: new Float32Array(HIZ_UNIFORM_FLOATS),
        sampler: device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }),
        copy: [null, null],
        reduce: fullScreenPipeline(device, HIZ_REDUCE_WGSL, "reduce", "r32float"),
        trace: fullScreenPipeline(device, HIZ_TRACE_WGSL, "trace", "rgba16float"),
        accumulate: fullScreenPipeline(device, HIZ_TEMPORAL_WGSL, "accumulate", "rgba16float"),
        resolve: fullScreenPipeline(device, HIZ_RESOLVE_WGSL, "resolve", format),
      };
    }
    const hz = this.hiz;
    hz.copy[k] ??= fullScreenPipeline(device, hizCopyWgsl(multisampled), "copyDepth", "r32float");
    const copy = hz.copy[k];
    // Epic: what the screen can't show, traced through the still scene's BVH at half resolution.
    const tracer = draw.reflectionTrace ? this.tracerFor(draw.reflectionTrace.key, draw.reflectionTrace.occluders) : null;
    if (tracer && !hz.traced) hz.traced = device.createTexture({ size: { width: Math.max(1, Math.ceil(this.width / 2)), height: Math.max(1, Math.ceil(this.height / 2)) }, format: "rgba16float", usage: 0x08 | 0x04 }); // STORAGE_BINDING | TEXTURE_BINDING
    const chain = graph.importTexture("hiz", hz.chain);
    const then = graph.importTexture("hiz.then", hz.history[hz.index]);
    const now = graph.importTexture("hiz.now", hz.history[1 - hz.index]);
    const traced = tracer ? graph.importTexture("hiz.traced", hz.traced) : null;
    const traceOut = graph.createTexture("hiz.trace", { format: "rgba16float", width: this.width, height: this.height });
    const out = graph.createTexture("reflect.out", { format, width: this.width, height: this.height });
    device.queue.writeBuffer(hz.uniforms, 0, hizUniforms(draw.view, projection, hz.frame, hz.levels, tracer !== null, hz.valid, hz.data));
    hz.frame += 1;
    const fullScreen = (ctx: any, pipeline: any, into: any, entries: { binding: number; resource: any }[], uniforms = true) => {
      const encoded = ctx.encoder.beginRenderPass({ colorAttachments: [{ view: into, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }], ...ctx.timing });
      encoded.setPipeline(pipeline);
      encoded.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: uniforms ? [{ binding: 0, resource: { buffer: hz.uniforms } }, ...entries] : entries }));
      encoded.draw(3);
      encoded.end();
    };
    const mip = (level: number) => hz.chain.createView({ baseMipLevel: level, mipLevelCount: 1 });
    graph.addPass("hiz", "render", (pass) => {
      pass.read(depth);
      pass.write(chain);
      return (ctx) => {
        fullScreen(ctx, copy, mip(0), [{ binding: 0, resource: ctx.texture(depth).createView() }], false);
        for (let level = 1; level < hz.levels; level += 1) fullScreen(ctx, hz.reduce, mip(level), [{ binding: 0, resource: mip(level - 1) }], false);
      };
    });
    if (tracer && traced) {
      const env = draw.environment ?? null;
      if (env && this.giSky?.source !== env) this.giSky = { source: env, sky: environmentPanorama(env) };
      const sky = env ? this.giSky!.sky : null;
      const volume = draw.environment?.probeVolume ?? null;
      const viewProj = multiplyMat4(projection, draw.view);
      const inverse = invertMat4(viewProj) ?? viewProj;
      const eye = invertMat4(draw.view) ?? draw.view;
      const lit = this.frameGi !== null && this.probeGi?.gi === tracer;
      const groups = this.depthGroups;
      graph.addPass("reflections.bvh", "compute", (pass) => {
        pass.read(chain);
        pass.read(gbuffer);
        pass.write(traced, "storage");
        return (ctx) =>
          tracer.traceReflections(
            ctx.encoder,
            { depth: mip(0), gbuffer: ctx.texture(gbuffer).createView(), out: hz.traced.createView(), invViewProj: inverse, eye: [eye[12]!, eye[13]!, eye[14]!], width: this.width, height: this.height, maxRoughness: HIZ_MAX_ROUGHNESS },
            draw.lights ?? [],
            sky,
            volume ? { buffer: groups.probes, layout: volume } : null,
            lit,
            ctx.timing,
          );
      });
    }
    graph.addPass("reflections.trace", "render", (pass) => {
      pass.read(colour);
      pass.read(chain);
      pass.read(gbuffer);
      pass.read(rays[0]!);
      if (traced) pass.read(traced);
      pass.write(traceOut);
      return (ctx) =>
        fullScreen(ctx, hz.trace, ctx.texture(traceOut).createView(), [
          { binding: 1, resource: ctx.texture(colour).createView() },
          { binding: 2, resource: hz.chain.createView() },
          { binding: 3, resource: ctx.texture(gbuffer).createView() },
          { binding: 4, resource: ctx.texture(rays[0]!).createView() },
          { binding: 5, resource: (traced ? hz.traced : hz.blank).createView() },
        ]);
    });
    graph.addPass("reflections.accumulate", "render", (pass) => {
      pass.read(traceOut);
      pass.read(then);
      pass.read(velocity);
      pass.read(rays[0]!);
      pass.write(now);
      pass.keep();
      return (ctx) =>
        fullScreen(ctx, hz.accumulate, ctx.texture(now).createView(), [
          { binding: 1, resource: ctx.texture(traceOut).createView() },
          { binding: 2, resource: ctx.texture(then).createView() },
          { binding: 3, resource: ctx.texture(velocity).createView() },
          { binding: 4, resource: ctx.texture(rays[0]!).createView() },
          { binding: 5, resource: hz.sampler },
        ]);
    });
    graph.addPass("reflections", "render", (pass) => {
      pass.read(colour);
      pass.read(now);
      pass.read(chain);
      pass.read(gbuffer);
      for (const ray of rays) pass.read(ray);
      pass.write(out);
      return (ctx) =>
        fullScreen(ctx, hz.resolve, ctx.texture(out).createView(), [
          { binding: 1, resource: ctx.texture(colour).createView() },
          { binding: 2, resource: ctx.texture(now).createView() },
          { binding: 3, resource: hz.chain.createView() },
          { binding: 4, resource: ctx.texture(gbuffer).createView() },
          { binding: 5, resource: ctx.texture(rays[0]!).createView() },
          { binding: 6, resource: ctx.texture(rays[1]!).createView() },
        ]);
    });
    graph.addPass("reflections.copy", "transfer", (pass) => {
      pass.read(out, "copySrc");
      pass.write(colour, "copyDst");
      return (ctx) => ctx.encoder.copyTextureToTexture({ texture: ctx.texture(out) }, { texture: ctx.texture(colour) }, { width: this.width, height: this.height });
    });
    hz.index = 1 - hz.index;
    hz.valid = true;
  }

  /** The still scene's BVH tracer for `key` (F3e's, shared with the reflections' Epic trace, F3f). */
  private tracerFor(key: string, occluders: readonly Occluder[]): GpuProbeGi {
    if (!this.probeGi || this.probeGi.key !== key) {
      this.probeGi?.gi.dispose();
      this.probeGi = { key, gi: new GpuProbeGi(this.device, occluders) };
    }
    return this.probeGi.gi;
  }

  private readonly temporalState = new TemporalState("ndc");
  /**
   * The temporal resolve's resources (I2): two history images (one read, one
   * written, swapping each frame), its uniforms, sampler and pipelines. Made on
   * first use.
   */
  private taa: { history: [any, any]; index: number; uniforms: any; sampler: any; resolve: [any, any]; hdrResolve: [any, any]; sharpen: any } | null = null;
  private reactivePipeline: any = null;
  /** This frame's output when it isn't the colour texture: the upscaled frame (F4b). */
  private frameOutput: any = null;
  /** The upscaler's display-sized output and pipelines (F4b); its history is the TAA's, made at the display's size. */
  private upscaler: { output: any; width: number; height: number; uniforms: any; data: Float32Array<ArrayBuffer>; resolve: [any, any]; sharpen: any } | null = null;

  /**
   * Temporal upscaling (F4b): the render-sized frame resolved into the TAA history at the display's size (see
   * upscaler.ts), then sharpened into the upscaled output the frame returns.
   */
  private addUpscale(graph: FrameGraph, temporal: { readonly uniforms: Float32Array; readonly jitter: readonly [number, number] }, colour: FrameResource, depth: FrameResource, velocity: FrameResource, reactive: FrameResource | null, display: { width: number; height: number }, multisampled: boolean): FrameResource {
    const device = this.device;
    const size = { width: display.width, height: display.height };
    if (this.taa && (this.taa.history[0].width !== size.width || this.taa.history[0].height !== size.height)) {
      destroySafely(this.taa.history[0]);
      destroySafely(this.taa.history[1]);
      destroySafely(this.taa.uniforms);
      this.taa = null;
    }
    const fresh = !this.taa;
    if (!this.taa) {
      const history = () => device.createTexture({ size, format: "rgba16float", usage: 0x10 | 0x04 });
      this.taa = {
        history: [history(), history()],
        index: 0,
        uniforms: device.createBuffer({ size: temporal.uniforms.byteLength, usage: 0x40 | 0x08 }),
        sampler: device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }),
        resolve: [null, null],
        hdrResolve: [null, null],
        sharpen: fullScreenPipeline(device, TEMPORAL_SHARPEN_WGSL, "sharpen", this.colourFormat),
      };
    }
    if (this.upscaler && (this.upscaler.width !== size.width || this.upscaler.height !== size.height)) {
      destroySafely(this.upscaler.output);
      this.upscaler.output = device.createTexture({ size, format: this.colourFormat, usage: 0x10 | 0x04 | 0x01 | 0x02 });
      this.upscaler.width = size.width;
      this.upscaler.height = size.height;
    }
    this.upscaler ??= {
      output: device.createTexture({ size, format: this.colourFormat, usage: 0x10 | 0x04 | 0x01 | 0x02 }), // RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC | COPY_DST (F4c lands in it)
      width: size.width,
      height: size.height,
      uniforms: device.createBuffer({ size: UPSCALE_UNIFORM_FLOATS * 4, usage: 0x40 | 0x08 }),
      data: new Float32Array(UPSCALE_UNIFORM_FLOATS),
      resolve: [null, null],
      sharpen: fullScreenPipeline(device, UPSCALE_SHARPEN_WGSL, "sharpen", this.colourFormat),
    };
    const taa = this.taa;
    const ups = this.upscaler;
    const k = multisampled ? 1 : 0;
    ups.resolve[k] ??= fullScreenPipeline(device, upscaleShaderWgsl(multisampled), "resolve", "rgba16float");
    const resolve = ups.resolve[k];
    const read = graph.importTexture("taa.history", taa.history[taa.index]);
    const write = graph.importTexture("taa.next", taa.history[1 - taa.index]);
    const output = graph.importTexture("upscaled", ups.output);
    taa.index = 1 - taa.index;
    device.queue.writeBuffer(ups.uniforms, 0, upscaleUniforms(temporal.jitter, { width: this.width, height: this.height }, display, !fresh && temporal.uniforms[18] === 1, ups.data));
    const fullScreen = (ctx: PassContext, pipeline: any, target: FrameResource, entries: any[]) => {
      const encoded = ctx.encoder.beginRenderPass({
        colorAttachments: [{ view: ctx.texture(target).createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
        ...ctx.timing,
      });
      encoded.setPipeline(pipeline);
      encoded.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
      encoded.draw(3);
      encoded.end();
    };
    graph.addPass("upscale.resolve", "render", (pass) => {
      pass.read(colour);
      pass.read(read);
      pass.read(depth);
      pass.read(velocity);
      if (reactive) pass.read(reactive);
      pass.write(write);
      return (ctx) =>
        fullScreen(ctx, resolve, write, [
          { binding: 0, resource: { buffer: ups.uniforms } },
          { binding: 1, resource: ctx.texture(colour).createView() },
          { binding: 2, resource: ctx.texture(read).createView() },
          { binding: 3, resource: taa.sampler },
          { binding: 4, resource: ctx.texture(depth).createView() },
          { binding: 5, resource: ctx.texture(velocity).createView() },
          { binding: 6, resource: reactive ? ctx.texture(reactive).createView() : this.blankTexture.createView() },
        ]);
    });
    graph.addPass("upscale.sharpen", "render", (pass) => {
      pass.read(write);
      pass.write(output);
      pass.keep();
      return (ctx) =>
        fullScreen(ctx, ups.sharpen, output, [
          { binding: 0, resource: { buffer: ups.uniforms } },
          { binding: 1, resource: ctx.texture(write).createView() },
        ]);
    });
    this.frameOutput = ups.output;
    return output;
  }

  /** The view modes' resolve (F10a): its pipeline and uniforms, made on first use. */
  private viewResolve: { pipeline: any; uniforms: any } | null = null;

  /** Colour motion vectors (from the velocity buffer) or overdraw (from the count in the colour's red) over the frame (F10a). */
  private addViewResolve(graph: FrameGraph, colour: FrameResource, velocity: FrameResource | null, gbuffer: FrameResource | null, code: number): void {
    const device = this.device;
    this.viewResolve ??= { pipeline: fullScreenPipeline(device, VIEW_RESOLVE_WGSL, "resolve", this.colourFormat), uniforms: device.createBuffer({ size: 16, usage: 0x40 | 0x08 }) };
    const vr = this.viewResolve;
    device.queue.writeBuffer(vr.uniforms, 0, new Float32Array([code, OVERDRAW_FULL, 0, 0]));
    const size = { width: this.width, height: this.height };
    const out = graph.createTexture("view mode", { format: this.colourFormat, ...size });
    graph.addPass("view mode", "render", (pass) => {
      pass.read(colour);
      if (velocity) pass.read(velocity);
      if (gbuffer) pass.read(gbuffer);
      pass.write(out);
      return (ctx) => {
        const encoded = ctx.encoder.beginRenderPass({
          colorAttachments: [{ view: ctx.texture(out).createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
          ...ctx.timing,
        });
        encoded.setPipeline(vr.pipeline);
        encoded.setBindGroup(0, device.createBindGroup({
          layout: vr.pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: vr.uniforms } },
            { binding: 1, resource: ctx.texture(colour).createView() },
            { binding: 2, resource: velocity ? ctx.texture(velocity).createView() : this.blankTexture.createView() },
            { binding: 3, resource: gbuffer ? ctx.texture(gbuffer).createView() : this.blankTexture.createView() },
          ],
        }));
        encoded.draw(3);
        encoded.end();
      };
    });
    graph.addPass("view mode.copy", "transfer", (pass) => {
      pass.read(out, "copySrc");
      pass.write(colour, "copyDst");
      pass.keep();
      return (ctx) => ctx.encoder.copyTextureToTexture({ texture: ctx.texture(out) }, { texture: ctx.texture(colour) }, size);
    });
  }

  /** The physical camera's passes (F4c) and what they keep between frames: their uniforms, sampler and pipelines. */
  private camera: { uniforms: any; data: Float32Array<ArrayBuffer>; sampler: any; frame: number; pipelines: Map<string, any> } | null = null;

  /** Depth of field, then motion blur (F4c; see cameraEffects.ts), on `target` (`size`), written back into it. */
  private addCameraEffects(graph: FrameGraph, target: FrameResource, size: { width: number; height: number }, depth: FrameResource, velocity: FrameResource, effects: CameraEffects, terms: readonly [number, number], multisampled: boolean): void {
    const device = this.device;
    this.camera ??= {
      uniforms: device.createBuffer({ size: CAMERA_UNIFORM_FLOATS * 4, usage: 0x40 | 0x08 }),
      data: new Float32Array(CAMERA_UNIFORM_FLOATS),
      sampler: device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }),
      frame: 0,
      pipelines: new Map(),
    };
    const cam = this.camera;
    const k = multisampled ? "ms" : "";
    const pipeline = (name: string, code: () => string, entry: string, formats: string[]) => {
      let made = cam.pipelines.get(name + k);
      if (!made) {
        const module = device.createShaderModule({ code: code() });
        made = device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: entry, targets: formats.map((format) => ({ format })) }, primitive: { topology: "triangle-list" } });
        cam.pipelines.set(name + k, made);
      }
      return made;
    };
    device.queue.writeBuffer(cam.uniforms, 0, cameraUniforms(effects, terms, size, { width: this.width, height: this.height }, cam.frame, cam.data));
    cam.frame += 1;
    const draw = (ctx: PassContext, pipe: any, targets: FrameResource[], entries: { binding: number; resource: any }[]) => {
      const encoded = ctx.encoder.beginRenderPass({
        colorAttachments: targets.map((t) => ({ view: ctx.texture(t).createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" })),
        ...ctx.timing,
      });
      encoded.setPipeline(pipe);
      encoded.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: cam.uniforms } }, ...entries] }));
      encoded.draw(3);
      encoded.end();
    };
    const copyBack = (from: FrameResource) =>
      graph.addPass(`${from.name}.copy`, "transfer", (pass) => {
        pass.read(from, "copySrc");
        pass.write(target, "copyDst");
        return (ctx) => ctx.encoder.copyTextureToTexture({ texture: ctx.texture(from) }, { texture: ctx.texture(target) }, size);
      });
    const half = { width: Math.max(1, Math.ceil(size.width / 2)), height: Math.max(1, Math.ceil(size.height / 2)) };
    if (effects.dof) {
      const halfColour = graph.createTexture("dof.colour", { format: "rgba16float", ...half });
      const halfCoc = graph.createTexture("dof.coc", { format: "r16float", ...half });
      const blurred = graph.createTexture("dof.blurred", { format: "rgba16float", ...half });
      const near = graph.createTexture("dof.near", { format: "r16float", ...half });
      const out = graph.createTexture("dof.out", { format: this.colourFormat, ...size });
      const prefilter = pipeline("dof.prefilter", () => dofPrefilterWgsl(multisampled), "prefilter", ["rgba16float", "r16float"]);
      const gather = pipeline("dof.gather", () => DOF_GATHER_WGSL, "gather", ["rgba16float", "r16float"]);
      const composite = pipeline("dof.composite", () => dofCompositeWgsl(multisampled), "composite", [this.colourFormat]);
      graph.addPass("dof.prefilter", "render", (pass) => {
        pass.read(target);
        pass.read(depth);
        pass.write(halfColour);
        pass.write(halfCoc);
        return (ctx) => draw(ctx, prefilter, [halfColour, halfCoc], [{ binding: 1, resource: ctx.texture(depth).createView() }, { binding: 2, resource: ctx.texture(target).createView() }]);
      });
      graph.addPass("dof.gather", "render", (pass) => {
        pass.read(halfColour);
        pass.read(halfCoc);
        pass.write(blurred);
        pass.write(near);
        return (ctx) => draw(ctx, gather, [blurred, near], [{ binding: 1, resource: ctx.texture(halfColour).createView() }, { binding: 2, resource: ctx.texture(halfCoc).createView() }]);
      });
      graph.addPass("dof.composite", "render", (pass) => {
        pass.read(target);
        pass.read(depth);
        pass.read(blurred);
        pass.read(near);
        pass.read(halfCoc);
        pass.write(out);
        return (ctx) =>
          draw(ctx, composite, [out], [
            { binding: 1, resource: ctx.texture(depth).createView() },
            { binding: 2, resource: ctx.texture(target).createView() },
            { binding: 3, resource: ctx.texture(blurred).createView() },
            { binding: 4, resource: ctx.texture(near).createView() },
            { binding: 5, resource: cam.sampler },
            { binding: 6, resource: ctx.texture(halfCoc).createView() },
          ]);
      });
      copyBack(out);
    }
    if (effects.motionBlur && effects.motionBlur.fraction > 0) {
      const tileSize = { width: Math.max(1, Math.ceil(size.width / MOTION_TILE)), height: Math.max(1, Math.ceil(size.height / MOTION_TILE)) };
      const tiles = graph.createTexture("motion.tiles", { format: "rg16float", ...tileSize });
      const neighbours = graph.createTexture("motion.neighbours", { format: "rg16float", ...tileSize });
      const out = graph.createTexture("motion.out", { format: this.colourFormat, ...size });
      const tilePipe = pipeline("motion.tiles", () => MOTION_TILES_WGSL, "tiles", ["rg16float"]);
      const neighbourPipe = pipeline("motion.neighbours", () => MOTION_NEIGHBOURS_WGSL, "neighbours", ["rg16float"]);
      const gatherPipe = pipeline("motion.gather", () => motionGatherWgsl(multisampled), "gather", [this.colourFormat]);
      graph.addPass("motion.tiles", "render", (pass) => {
        pass.read(velocity);
        pass.write(tiles);
        return (ctx) => draw(ctx, tilePipe, [tiles], [{ binding: 1, resource: ctx.texture(velocity).createView() }]);
      });
      graph.addPass("motion.neighbours", "render", (pass) => {
        pass.read(tiles);
        pass.write(neighbours);
        return (ctx) => {
          const encoded = ctx.encoder.beginRenderPass({ colorAttachments: [{ view: ctx.texture(neighbours).createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }], ...ctx.timing });
          encoded.setPipeline(neighbourPipe);
          encoded.setBindGroup(0, device.createBindGroup({ layout: neighbourPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: ctx.texture(tiles).createView() }] }));
          encoded.draw(3);
          encoded.end();
        };
      });
      graph.addPass("motion.gather", "render", (pass) => {
        pass.read(target);
        pass.read(depth);
        pass.read(velocity);
        pass.read(neighbours);
        pass.write(out);
        return (ctx) =>
          draw(ctx, gatherPipe, [out], [
            { binding: 1, resource: ctx.texture(depth).createView() },
            { binding: 2, resource: ctx.texture(target).createView() },
            { binding: 3, resource: ctx.texture(velocity).createView() },
            { binding: 4, resource: ctx.texture(neighbours).createView() },
          ]);
      });
      copyBack(out);
    }
  }

  /**
   * The reactive mask (F4a): how much the see-through pass changed each pixel,
   * from the opaque scene copied before it against the frame after it.
   */
  private addReactiveMask(graph: FrameGraph, opaqueOnly: FrameResource, colour: FrameResource): FrameResource {
    const device = this.device;
    this.reactivePipeline ??= fullScreenPipeline(device, REACTIVE_MASK_WGSL, "mask", "r8unorm");
    const mask = graph.createTexture("taa.reactive", { format: "r8unorm", width: this.width, height: this.height });
    graph.addPass("taa.reactive", "render", (pass) => {
      pass.read(opaqueOnly);
      pass.read(colour);
      pass.write(mask);
      return (ctx) => {
        const encoded = ctx.encoder.beginRenderPass({
          colorAttachments: [{ view: ctx.texture(mask).createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
          ...ctx.timing,
        });
        encoded.setPipeline(this.reactivePipeline);
        encoded.setBindGroup(
          0,
          device.createBindGroup({
            layout: this.reactivePipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: ctx.texture(opaqueOnly).createView() },
              { binding: 1, resource: ctx.texture(colour).createView() },
            ],
          }),
        );
        encoded.draw(3);
        encoded.end();
      };
    });
    return mask;
  }

  /**
   * Resolve the frame into the history and sharpen it back into the colour
   * texture that is read back (HALO_INFINITE_STYLE_ROADMAP.md I2). The two
   * history images outlive the frame, so the graph imports them.
   */
  private addTemporal(graph: FrameGraph, uniforms: Float32Array, colour: FrameResource, depth: FrameResource, multisampled: boolean, velocity: FrameResource | null = null, reactive: FrameResource | null = null): void {
    const device = this.device;
    // After upscaled frames (F4b) the history is the display's size: start afresh at the frame's.
    if (this.taa && (this.taa.history[0].width !== this.width || this.taa.history[0].height !== this.height)) {
      destroySafely(this.taa.history[0]);
      destroySafely(this.taa.history[1]);
      destroySafely(this.taa.uniforms);
      this.taa = null;
    }
    if (!this.taa) {
      const size = { width: this.width, height: this.height };
      const history = () => device.createTexture({ size, format: "rgba16float", usage: 0x10 | 0x04 }); // RENDER_ATTACHMENT | TEXTURE_BINDING
      this.taa = {
        history: [history(), history()],
        index: 0,
        uniforms: device.createBuffer({ size: uniforms.byteLength, usage: 0x40 | 0x08 }), // UNIFORM | COPY_DST
        sampler: device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }),
        resolve: [null, null],
        hdrResolve: [null, null],
        sharpen: fullScreenPipeline(device, TEMPORAL_SHARPEN_WGSL, "sharpen", this.colourFormat),
      };
    }
    const taa = this.taa;
    // The resolve reads the frame's depth: plain, or a multisampled frame's first sample.
    const k = multisampled ? 1 : 0;
    // The AAA tier's (F4a) with the velocity buffer and reactive mask; else the depth-reprojected one (I2).
    const resolve = velocity
      ? (taa.hdrResolve[k] ??= fullScreenPipeline(device, hdrTemporalShaderWgsl(multisampled), "resolve", "rgba16float"))
      : (taa.resolve[k] ??= fullScreenPipeline(device, temporalShaderWgsl(multisampled), "resolve", "rgba16float"));
    const read = graph.importTexture("taa.history", taa.history[taa.index]);
    const write = graph.importTexture("taa.next", taa.history[1 - taa.index]);
    taa.index = 1 - taa.index;
    const fullScreen = (ctx: PassContext, pipeline: any, target: FrameResource, entries: any[]) => {
      const encoded = ctx.encoder.beginRenderPass({
        colorAttachments: [{ view: ctx.texture(target).createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
        ...ctx.timing,
      });
      encoded.setPipeline(pipeline);
      encoded.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
      encoded.draw(3);
      encoded.end();
    };
    graph.addPass("taa.resolve", "render", (pass) => {
      pass.read(colour);
      pass.read(read);
      pass.read(depth);
      if (velocity) pass.read(velocity);
      if (reactive) pass.read(reactive);
      pass.write(write);
      return (ctx) => {
        device.queue.writeBuffer(taa.uniforms, 0, uniforms);
        fullScreen(ctx, resolve, write, [
          { binding: 0, resource: { buffer: taa.uniforms } },
          { binding: 1, resource: ctx.texture(colour).createView() },
          { binding: 2, resource: ctx.texture(read).createView() },
          { binding: 3, resource: taa.sampler },
          { binding: 4, resource: ctx.texture(depth).createView() },
          ...(velocity
            ? [
                { binding: 5, resource: ctx.texture(velocity).createView() },
                // Nothing see-through: a 1×1 stand-in the resolve reads only at the frame's size.
                { binding: 6, resource: reactive ? ctx.texture(reactive).createView() : this.blankTexture.createView() },
              ]
            : []),
        ]);
      };
    });
    graph.addPass("taa.sharpen", "render", (pass) => {
      pass.read(write);
      pass.write(colour);
      return (ctx) =>
        fullScreen(ctx, taa.sharpen, colour, [
          { binding: 0, resource: { buffer: taa.uniforms } },
          { binding: 1, resource: ctx.texture(write).createView() },
        ]);
    });
  }

  /** Pipeline variants (material graph, sample count, reflection targets), built on first use. */
  private readonly variants = new Map<string, PipelineSet>();

  /**
   * The multisampled depth an anti-aliased frame draws with
   * (HALO_INFINITE_STYLE_ROADMAP.md I1), and the bind groups that sample it:
   * made on first use, so a renderer that never anti-aliases pays nothing for
   * them. Its colour is a frame-graph transient.
   */
  private msaa: { depth: any; blank: any; groups: { blank: any; scene: any; opaque: any } } | null = null;

  private ensureMsaa(): NonNullable<WebgpuSceneRenderer["msaa"]> {
    if (!this.msaa) {
      const size = { width: this.width, height: this.height };
      const depth = this.device.createTexture({ size, format: "depth24plus", sampleCount: MSAA_SAMPLES, usage: 0x10 | 0x04 }); // + TEXTURE_BINDING (soft edges)
      const blank = this.device.createTexture({ size: { width: 1, height: 1 }, format: "depth24plus", sampleCount: MSAA_SAMPLES, usage: 0x10 | 0x04 });
      const groups = this.depthGroups;
      this.msaa = { depth, blank, groups: groups.makeGroupsMs(groups.atlas, groups.probes, blank, depth) };
    }
    return this.msaa;
  }

  /**
   * The pipelines a material draws with: the plain shader's, or its graph's
   * variant; multisampled for an anti-aliased frame (I1); writing the
   * reflection targets for a frame with reflections (I3). Built on first use.
   */
  private pipelinesOf(material: MeshPrimitive["material"], samples = 1, reflect = false, prepass = false): PipelineSet {
    const graph = compiledGraphOf(material);
    if (!graph && samples === 1 && !reflect && !prepass) return this.pipeline;
    const key = `${graph?.key ?? ""}|${samples}|${reflect ? 1 : 0}|${prepass ? 1 : 0}`;
    let set = this.variants.get(key);
    if (!set) {
      set = this.pipelinesFor(sceneShader(graph, reflect, this.hdr), samples, reflect, prepass);
      this.variants.set(key, set);
    }
    return set;
  }

  /**
   * Order the frame's lights (global first), build the clustered cells, and
   * write both and their params. An orthographic view (no cells) loops every light.
   */
  private clusterLights(draw: GpuSceneDraw) {
    const { ordered, globalCount } = orderLights(draw.lights ?? []);
    const clusters = ordered.length > globalCount ? buildLightClusters(ordered, globalCount, draw.view, draw.projection, this.width, this.height) : null;
    const buffers = this.depthGroups.clusters;
    if (clusters) {
      this.device.queue.writeBuffer(buffers.data, 0, clusters.table);
      this.device.queue.writeBuffer(buffers.data, CLUSTER_CELLS * 8, clusters.indices, 0, Math.max(4, Math.ceil(clusters.used / 4) * 4));
    }
    const near = draw.shadow?.near ?? null;
    const frame = new Float32Array(FRAME_BYTES / 4);
    frame.set(clusters?.params ?? [1, 1, 1, 1], 0);
    frame.set([clusters ? globalCount : ordered.length, clusters ? 1 : 0], 4);
    if (near) {
      frame.set(near.lightViewProj, 8);
      frame.set([1, near.bias, near.slopeBias], 24);
    }
    const local = draw.localShadows ?? null;
    if (this.frameLocalTiles && this.frameLocalTiles.length > 0) {
      this.uploadLocalTiles(this.frameLocalTiles);
      frame.set([1, LOCAL_SHADOW_BIAS, LOCAL_SHADOW_SLOPE_BIAS], 28);
    } else if (local && local.tiles.length > 0) frame.set([1, local.bias, local.slopeBias], 28);
    // The AAA tier lights by the GPU bake's probe volume where there is one (F3d-3, probeMin.w = 2); else the ambient cubes.
    const volume = this.hdr ? (draw.environment?.probeVolume ?? null) : null;
    const grid = volume ?? draw.environment?.lightProbes ?? null;
    if (grid) {
      if (volume) this.uploadProbeTexture(volume, probeVolumeTexels(volume), PROBE_VOLUME_SLOTS);
      else this.uploadProbeTexture(grid, lightProbeTexels(grid as LightProbeGrid), 6);
      frame.set([...grid.min, volume ? 2 : 1], 32);
      frame.set([0, 1, 2].map((a) => (grid.counts[a]! - 1) / (grid.max[a]! - grid.min[a]! || 1)), 36);
      // w: the slots a probe takes along x, by which the shader strides the probe buffer (F5b-0).
      frame.set([...grid.counts, volume ? PROBE_VOLUME_SLOTS : 6], 40);
    }
    if (this.hdr) {
      frame.set(this.iblSh, 44);
      frame.set([IBL_LEVELS - 1], 80);
    }
    // The sun's cascades (F2a): each one's world → light clip, the slices' far depths, the flags and the texels.
    const sun = this.frameCascades;
    if (sun) {
      sun.cascades.forEach((c, i) => frame.set(c.viewProj, FRAME_CASCADES + i * 16));
      frame.set(sun.cascades.map((c) => c.far), FRAME_CASCADES + 64);
      frame.set([1, sun.size, sun.strength, sun.cascades[sun.cascades.length - 1]!.far], FRAME_CASCADES + 68);
      frame.set(sun.cascades.map((c) => c.texel), FRAME_CASCADES + 72);
      frame.set(sun.cascades.map((c) => c.depth), FRAME_CASCADES + 76);
    }
    frame.set([sun?.softness ?? 0, this.frameContact ? 1 : 0, this.frameGtao ? 1 : 0, this.frameSsgi ? 1 : 0], FRAME_CASCADES + 80);
    // The prepass's depths, readable as the opaque pass shades (F2d-3), for the local lights' contact shadows.
    if (this.frameDepthView) {
      frame.set(this.frameDepthView.viewProj, FRAME_CASCADES + 84);
      frame.set([this.frameDepthView.terms[0], this.frameDepthView.terms[1], 1, this.frameVsm ? 1 : 0], FRAME_CASCADES + 100);
    }
    if (this.hdr) frame.set(this.aerialFrame(draw), FRAME_AERIAL);
    if (this.hdr) frame.set(packFogFrame(this.frameFog, this.fogTerms), FRAME_FOG);
    if (this.hdr) frame.set([viewModeCode(draw.viewMode), draw.texelDensity ?? DEFAULT_TEXEL_DENSITY], FRAME_DEBUG);
    this.device.queue.writeBuffer(buffers.params, 0, frame);
    this.uploadLocalShadows(local);
    return { ordered, globalCount, clusters };
  }

  /**
   * This draw's volumetric fog (F5b), on the linear-light renderer, for a
   * perspective camera under a rig whose fog is volumetric: the grid for the
   * frame's size, the sun (shadowed by its cascades when it casts) and the
   * sky's mean radiance, and the camera, uniforms written. Null (and the
   * history dropped) otherwise.
   */
  private prepareFog(draw: GpuSceneDraw): FogFrame | null {
    const settings = this.hdr && draw.projection[15] === 0 ? resolveVolumetricFog(draw.fog) : null;
    if (!settings) {
      this.volumetricFog?.reset();
      return null;
    }
    const fog = (this.volumetricFog ??= new GpuVolumetricFog(this.device));
    // The sky's mean radiance: its L0 irradiance over π (zero without an environment).
    const sky = [0, 1, 2].map((c) => Math.max(0, this.iblSh[c]! * 0.282095));
    const cascades = this.frameCascades ? { cascades: this.frameCascades.cascades, strength: this.frameCascades.strength } : null;
    const { frame, remade } = fog.prepare(
      { fog: settings, light: { sun: fogSun(draw.lights), sky }, grid: fogGrid(this.width, this.height), camera: fogCamera(draw.view, draw.projection), cascades },
      draw.temporal === true,
    );
    if (remade) {
      const groups = this.depthGroups;
      groups.fogVolume.texture = fog.volume;
      Object.assign(groups, groups.makeGroups(groups.atlas, groups.probes));
      if (this.msaa) this.msaa.groups = groups.makeGroupsMs(groups.atlas, groups.probes, this.msaa.blank, this.msaa.depth);
    }
    return frame;
  }

  /**
   * The physical sky's aerial perspective for this draw's camera (F5a-2): its
   * froxels built in compute ahead of the frame, and the terms the shader
   * finds a fragment's with; all zero (off) without one.
   */
  private aerialFrame(draw: GpuSceneDraw): Float32Array {
    const sky = draw.atmosphere ?? null;
    const terms = packAerialFrame(sky, draw.view, draw.projection, this.aerialTerms);
    if (sky && terms[3] === 1) (this.atmosphere ??= new GpuAtmosphere(this.device)).aerial(sky, aerialCamera(draw.view, draw.projection), this.depthGroups.aerial);
    return terms;
  }

  /**
   * Upload a probe grid (EP9) or volume (F3d-3) as a 3D texture, `slots` texels
   * a probe along x, once per grid, rebuilding group 1 to point at it.
   */
  private uploadProbeTexture(grid: LightProbeGrid | ProbeVolume, texels: Float32Array, slots: number): void {
    const groups = this.depthGroups;
    if (groups.probeSource === grid) return;
    const [nx, ny, nz] = grid.counts;
    if (!groups.probesBlank) destroySafely(groups.probes);
    groups.probes = this.device.createBuffer({ size: nx * slots * ny * nz * 16, usage: 0x80 | 0x08 }); // STORAGE | COPY_DST
    groups.probesBlank = false;
    groups.probeSource = grid;
    this.device.queue.writeBuffer(groups.probes, 0, texels, 0, nx * slots * ny * nz * 4);
    Object.assign(groups, groups.makeGroups(groups.atlas, groups.probes));
    if (this.msaa) this.msaa.groups = groups.makeGroupsMs(groups.atlas, groups.probes, this.msaa.blank, this.msaa.depth);
  }

  /** This frame's GPU spot/point tiles (F2d), or null when it draws none. */
  private frameLocalTiles: readonly LocalTile[] | null = null;

  /** The GPU tiles' records (F2d), and the atlas they're drawn into, made the first time a light casts. */
  private uploadLocalTiles(tiles: readonly LocalTile[]): void {
    this.ensureLocalAtlas();
    this.device.queue.writeBuffer(this.depthGroups.shadowTiles, 0, packLocalTiles(tiles));
  }

  /** Which atlas rects hold whose map (F2d-2). */
  private readonly localCache = new LocalTileCache();
  /** Clears a tile's rect to the far plane (F2d-2), made on first use. */
  private localClear: any = null;

  private ensureLocalAtlas(): any {
    const groups = this.depthGroups;
    if (groups.atlasBlank) {
      this.localCache.clear();
      groups.atlas = this.device.createTexture({ size: { width: LOCAL_ATLAS_SIZE, height: LOCAL_ATLAS_SIZE }, format: "depth32float", usage: 0x10 | 0x04 }); // RENDER_ATTACHMENT | TEXTURE_BINDING
      groups.atlasBlank = false;
      Object.assign(groups, groups.makeGroups(groups.atlas, groups.probes));
      if (this.msaa) this.msaa.groups = groups.makeGroupsMs(groups.atlas, groups.probes, this.msaa.blank, this.msaa.depth);
    }
    return groups.atlas;
  }

  /** Upload the spot/point shadow tiles (EP8c): each tile into its atlas cell, and every tile's view. */
  private uploadLocalShadows(local: SceneDraw["localShadows"]): void {
    if (!local || local.tiles.length === 0) return;
    const groups = this.depthGroups;
    if (groups.atlasBlank) {
      const side = LOCAL_SHADOW_TILE * LOCAL_SHADOW_GRID;
      groups.atlas = this.device.createTexture({ size: { width: side, height: side }, format: "r32float", usage: 0x04 | 0x02 });
      groups.atlasBlank = false;
      Object.assign(groups, groups.makeGroups(groups.atlas, groups.probes));
      if (this.msaa) this.msaa.groups = groups.makeGroupsMs(groups.atlas, groups.probes, this.msaa.blank, this.msaa.depth);
    }
    const views = new Float32Array(MAX_LOCAL_SHADOW_TILES * LOCAL_TILE_FLOATS);
    local.tiles.slice(0, MAX_LOCAL_SHADOW_TILES).forEach((tile, i) => {
      this.device.queue.writeTexture(
        { texture: groups.atlas, origin: { x: (i % LOCAL_SHADOW_GRID) * LOCAL_SHADOW_TILE, y: Math.floor(i / LOCAL_SHADOW_GRID) * LOCAL_SHADOW_TILE } },
        tile.depth,
        { bytesPerRow: LOCAL_SHADOW_TILE * 4, rowsPerImage: LOCAL_SHADOW_TILE },
        { width: LOCAL_SHADOW_TILE, height: LOCAL_SHADOW_TILE },
      );
      views.set(tile.lightViewProj, i * LOCAL_TILE_FLOATS);
      views.set(tile.linear, i * LOCAL_TILE_FLOATS + 16);
    });
    this.device.queue.writeBuffer(groups.shadowTiles, 0, views);
  }

  /** Await one readback and publish it as the newest frame. */
  private async drain(slot: { buffer: any; busy: boolean; seq?: number }): Promise<void> {
    try {
      await slot.buffer.mapAsync(0x01); // MapMode.READ
      if (this.destroyed) return;
      // Readbacks can land out of order; an older one never replaces a newer frame.
      if ((slot.seq ?? 0) >= this.latestSeq && slot.buffer.size === this.bytesPerRow * this.height) {
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
        // A live skinned copy's tangents would stay in its bind pose: it takes the derivative frame (F1c).
        const vertices = interleaveVerticesWithTangents(primitive.positions, normals, primitive.uvs, primitive.uvs2 ?? null, primitive.blend ?? null, primitive.sway ?? null, null);
        // Keep the vertices it had (F0c): copied before this upload lands, which the queue keeps in order.
        gpu.previousBuffer ??= this.device.createBuffer({ size: Math.max(40, vertices.byteLength), usage: 0x20 | 0x08 }); // VERTEX | COPY_DST
        const encoder = this.device.createCommandEncoder();
        encoder.copyBufferToBuffer(gpu.vertexBuffer, 0, gpu.previousBuffer, 0, Math.max(40, vertices.byteLength));
        this.device.queue.submit([encoder.finish()]);
        this.device.queue.writeBuffer(gpu.vertexBuffer, 0, vertices);
        gpu.revision = primitive.dynamic.revision;
        gpu.movedFrame = this.frameIndex;
      });
      return cached;
    }

    const uploaded = mesh.primitives.map((primitive) => {
      const normals = primitive.normals ?? computeSmoothNormals(primitive.positions, primitive.indices);
      const vertices = interleaveVerticesWithTangents(primitive.positions, normals, primitive.uvs, primitive.uvs2 ?? null, primitive.blend ?? null, primitive.sway ?? null, primitive.dynamic ? null : (primitive.tangents ?? null));
      const vertexBuffer = this.device.createBuffer({
        size: Math.max(40, vertices.byteLength),
        // A dynamic one is also copied from, to keep its last vertices (F0c).
        usage: 0x20 | 0x08 | (primitive.dynamic ? 0x04 : 0), // VERTEX | COPY_DST (| COPY_SRC)
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

  /** A cut-out caster's group 0 (F2a-2): the casters' uniforms and transforms, and its base map. */
  private cutGroupFor(primitive: MeshPrimitive, textures: PrimitiveTextures): any {
    const cached = this.cutGroups.get(primitive);
    if (cached && cached.uniform === this.uniformBuffer && cached.instances === this.instanceBuffer && cached.base === textures.base) return cached.group;
    const group = this.device.createBindGroup({
      layout: this.depthGroups.cascades.cutLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: UNIFORM_STRIDE } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: (textures.base ? this.uploadTexture(textures.base, true) : this.blankTexture).createView() },
        { binding: 10, resource: { buffer: this.instanceBuffer } },
      ],
    });
    this.cutGroups.set(primitive, { uniform: this.uniformBuffer, instances: this.instanceBuffer, base: textures.base, group });
    return group;
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
      cached.source.lmHdr === textures.lmHdr &&
      cached.source.detail === textures.detail &&
      cached.source.blend === textures.blend &&
      cached.source.normal === textures.normal
    ) {
      return cached.group;
    }

    // Colour maps (the base, emissive and blend surface's) are sRGB-encoded: their mips average in linear light (F1a).
    const view = (texture: DecodedTexture | null, colour = false): any =>
      (texture ? this.uploadTexture(texture, colour) : this.blankTexture).createView();
    const group = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: UNIFORM_STRIDE } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: view(textures.base, true) },
        { binding: 3, resource: view(textures.mr) },
        { binding: 4, resource: view(textures.occ) },
        { binding: 5, resource: view(textures.emis, true) },
        // The active shadow map (or the 1x1 blank). Its identity only moves on a
        // size change, which invalidates this whole cache, so a cached group
        // always references the current one.
        { binding: 6, resource: this.hdr ? this.depthGroups.cascades.texture.createView({ dimension: "2d-array" }) : this.shadowTexture.createView() },
        // The active env map (or the 1x1 white blank); likewise cache-invalidated.
        { binding: 7, resource: this.hdr ? this.envTexture.createView({ dimension: "cube" }) : this.envTexture.createView() },
        // The active SSAO buffer (or the 1x1 blank); likewise cache-invalidated.
        { binding: 8, resource: this.hdr ? this.ssaoBound.createView({ dimension: "2d-array" }) : this.ssaoBound.createView() },
        // The light storage buffer; a grow changes identity and invalidates the cache.
        { binding: 9, resource: { buffer: this.lightBuffer } },
        // The instance transforms; a grow changes identity and invalidates the cache.
        { binding: 10, resource: { buffer: this.instanceBuffer } },
        // The baked light map (or the 1x1 white blank; the uniform flag gates it). The linear variant binds an
        // array: an HDR directional map (F3d) where there is one, else the 8-bit map as one layer.
        {
          binding: 11,
          resource: !this.hdr
            ? view(textures.lm)
            : textures.lmHdr
              ? this.uploadHdrLightmap(textures.lmHdr).createView({ dimension: "2d-array" })
              : (textures.lm ? this.uploadTexture(textures.lm) : this.blankTexture).createView({ dimension: "2d-array" }),
        },
        // The probe atlas (or the blank) and boxes; a change invalidates the cache.
        { binding: 12, resource: this.hdr ? (this.probeCapture?.cubes ?? this.blankProbeCubes).createView({ dimension: "cube-array" }) : this.probeTexture.createView() },
        { binding: 13, resource: { buffer: this.probeBuffer } },
        // The detail map (or the 1x1 white blank; the uniform gates it).
        { binding: 14, resource: view(textures.detail) },
        { binding: 15, resource: view(textures.blend, true) },
        { binding: 16, resource: view(textures.normal) },
      ],
    });
    this.bindGroups.set(primitive, { group, source: { ...textures } });
    return group;
  }

  /**
   * Upload (once) a decoded texture. With mips (F1a) it gets its full chain,
   * each level drawn from the one above on the GPU; a colour map's through an
   * sRGB view, so the averaging is in linear light and distant texels don't
   * darken. The shader reads every level as it is stored (sRGB-encoded bytes).
   * A colour map with see-through texels (a cut-out's, say a grass card's) is
   * mipped on the CPU instead, keeping its coverage: averaged alpha would
   * otherwise fall under the cutoff, and foliage would thin away with distance.
   * A texture that carries a chain in a block-compressed format this device
   * samples (a KTX2 one, F1a) uploads that instead: a quarter of the memory,
   * its mips the encoder's. A cut-out keeps the RGBA path for its coverage.
   */
  private uploadTexture(source: DecodedTexture, colour = false): any {
    const cache = this.mips && colour ? this.colourTextures : this.textures;
    const cached = cache.get(source);
    if (cached) return cached;

    const compressed = this.mips && source.gpu && this.textureFormats.includes(source.gpu.format) && !(colour && hasTransparency(source)) ? source.gpu : null;
    if (compressed) {
      const texture = uploadCompressed(this.device, source.width, source.height, compressed);
      cache.set(source, texture);
      return texture;
    }
    const levels = this.mips ? mipLevelCount(source.width, source.height) : 1;
    const texture = this.device.createTexture({
      size: { width: source.width, height: source.height },
      format: "rgba8unorm",
      // TEXTURE_BINDING | COPY_DST, and RENDER_ATTACHMENT to draw its mips into.
      usage: 0x04 | 0x02 | (levels > 1 ? 0x10 : 0),
      ...(levels > 1 ? { mipLevelCount: levels, ...(colour ? { viewFormats: ["rgba8unorm-srgb"] } : {}) } : {}),
    });
    this.device.queue.writeTexture(
      { texture },
      source.data,
      { bytesPerRow: source.width * 4, rowsPerImage: source.height },
      { width: source.width, height: source.height },
    );
    if (levels > 1 && colour && hasTransparency(source)) {
      coverageMips(source).forEach((mip, i) =>
        this.device.queue.writeTexture({ texture, mipLevel: i + 1 }, mip.data, { bytesPerRow: mip.width * 4, rowsPerImage: mip.height }, { width: mip.width, height: mip.height }),
      );
    } else if (levels > 1) {
      this.mipmaps.generate(texture, levels, colour ? "rgba8unorm-srgb" : "rgba8unorm");
    }
    cache.set(source, texture);
    return texture;
  }

  /**
   * Upload (once) an HDR directional light map (F3d, hdrLightmap.ts) as a
   * two-layer rgba16float array: the irradiance (and 1), then the dominant
   * direction and the sky's visibility. One level: a light map's texels are
   * already a few centimetres to metres apart.
   */
  private uploadHdrLightmap(map: HdrLightmap): any {
    const cached = this.hdrLightmaps.get(map);
    if (cached) return cached;
    const { width, height } = map;
    const texels = width * height;
    const halves = new Uint16Array(texels * 8);
    const one = toHalf(1);
    for (let i = 0; i < texels; i += 1) {
      for (let c = 0; c < 3; c += 1) halves[i * 4 + c] = toHalf(map.irradiance[i * 3 + c]!);
      halves[i * 4 + 3] = one;
      for (let c = 0; c < 4; c += 1) halves[(texels + i) * 4 + c] = toHalf(map.direction[i * 4 + c]!);
    }
    const texture = this.device.createTexture({ size: { width, height, depthOrArrayLayers: 2 }, format: "rgba16float", usage: 0x04 | 0x02 });
    this.device.queue.writeTexture({ texture }, halves, { bytesPerRow: width * 8, rowsPerImage: height }, { width, height, depthOrArrayLayers: 2 });
    this.hdrLightmaps.set(map, texture);
    return texture;
  }

  /** The size frames render at now. */
  get size(): { readonly width: number; readonly height: number } {
    return { width: this.width, height: this.height };
  }

  /**
   * Render at `width × height` from the next frame on (AAA_FIDELITY_ROADMAP.md
   * F0d: the AAA tier's frame follows its display, and its dynamic
   * resolution). The frame's own targets are remade at the new size: the
   * colour and depth, the refraction copy, the G-buffer and velocity, the
   * multisampled depth, the TAA history (which starts over) and the readback.
   * Meshes, textures and pipelines stay; the frame graph's transients follow
   * by themselves.
   */
  resize(width: number, height: number): void {
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    if (this.destroyed || (width === this.width && height === this.height)) return;
    const device = this.device;
    this.width = width;
    this.height = height;
    const size = { width, height };
    destroySafely(this.colourTexture);
    this.colourTexture = device.createTexture({ size, format: this.colourFormat, usage: 0x10 | 0x01 | 0x04 | 0x02 });
    destroySafely(this.depthTexture);
    this.depthTexture = device.createTexture({ size, format: "depth24plus", usage: 0x10 | 0x04 });
    const groups = this.depthGroups;
    destroySafely(groups.sized.behind);
    groups.sized.behind = device.createTexture({ size, format: this.colourFormat, usage: 0x04 | 0x02 | 0x10 });
    groups.sized.depth = this.depthTexture;
    Object.assign(groups, groups.makeGroups(groups.atlas, groups.probes));
    if (this.msaa) {
      destroySafely(this.msaa.depth);
      destroySafely(this.msaa.blank);
      this.msaa = null;
    }
    destroySafely(this.gbuffer);
    destroySafely(this.velocity);
    this.gbuffer = null;
    this.velocity = null;
    this.prepassed = null;
    if (this.ssaoTexture) {
      destroySafely(this.ssaoTexture);
      this.ssaoTexture = null;
      this.ssaoBound = this.blankShadow;
    }
    if (this.contactTexture) {
      destroySafely(this.contactTexture);
      this.contactTexture = null;
      this.ssaoBound = this.blankShadow;
    }
    if (this.gtao) {
      destroySafely(this.gtao.history[0]);
      destroySafely(this.gtao.history[1]);
      destroySafely(this.gtao.uniforms);
      this.gtao = null;
    }
    if (this.hiz) {
      for (const t of [this.hiz.chain, this.hiz.history[0], this.hiz.history[1], this.hiz.traced, this.hiz.blank, this.hiz.uniforms]) destroySafely(t);
      this.hiz = null;
    }
    if (this.ssgi) {
      destroySafely(this.ssgi.history[0]);
      destroySafely(this.ssgi.history[1]);
      destroySafely(this.ssgi.uniforms);
      this.ssgi = null;
    }
    if (this.taa) {
      destroySafely(this.taa.history[0]);
      destroySafely(this.taa.history[1]);
      destroySafely(this.taa.uniforms);
      this.taa = null;
    }
    this.temporalState.reset();
    // A readback still in flight lands at the old size and is dropped (see drain).
    for (const slot of this.readback) if (!slot.busy) destroySafely(slot.buffer);
    this.bytesPerRow = alignBytesPerRow(width);
    this.readback = Array.from({ length: READBACK_BUFFERS }, () => ({
      buffer: device.createBuffer({ size: this.bytesPerRow * height, usage: 0x08 | 0x01 }),
      busy: false,
    }));
    this.latest = null;
    this.bindGroups = new WeakMap();
  }

  dispose(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pathTracer?.destroy();
    this.pathTracer = null;
    this.latest = null;
    this.software.dispose();
    destroySafely(this.colourTexture);
    destroySafely(this.depthTexture);
    destroySafely(this.depthGroups.cascades.texture);
    for (const view of this.depthGroups.cascades.views) destroySafely(view.buffer);
    if (this.msaa) {
      destroySafely(this.msaa.depth);
      destroySafely(this.msaa.blank);
    }
    if (this.reflections) destroySafely(this.reflections.uniforms);
    destroySafely(this.gbuffer);
    destroySafely(this.velocity);
    this.transients.destroy();
    if (this.taa) {
      destroySafely(this.taa.history[0]);
      destroySafely(this.taa.history[1]);
      destroySafely(this.taa.uniforms);
    }
    destroySafely(this.depthGroups.blankTexture);
    destroySafely(this.depthGroups.sized.behind);
    destroySafely(this.depthGroups.behindBlank);
    destroySafely(this.depthGroups.clusters.data);
    destroySafely(this.depthGroups.clusters.params);
    destroySafely(this.depthGroups.shadowTiles);
    destroySafely(this.depthGroups.dfg);
    destroySafely(this.depthGroups.ltc);
    destroySafely(this.depthGroups.decals);
    destroySafely(this.depthGroups.aerial);
    destroySafely(this.depthGroups.atlas);
    destroySafely(this.depthGroups.probes);
    destroySafely(this.blankTexture);
    destroySafely(this.blankShadow);
    if (this.shadowTexture !== this.blankShadow) destroySafely(this.shadowTexture);
    if (this.envTexture !== this.blankTexture) destroySafely(this.envTexture);
    if (this.probeTexture !== this.blankTexture) destroySafely(this.probeTexture);
    this.probeCapture?.dispose();
    this.atmosphere?.dispose();
    this.volumetricFog?.dispose();
    this.probeGi?.gi.dispose();
    this.disposeVsm();
    if (this.upscaler) {
      destroySafely(this.upscaler.output);
      destroySafely(this.upscaler.uniforms);
      this.upscaler = null;
    }
    destroySafely(this.depthGroups.fogVolume.texture);
    destroySafely(this.blankProbeCubes);
    destroySafely(this.probeBuffer);
    destroySafely(this.ssaoTexture);
    destroySafely(this.lightBuffer);
    destroySafely(this.instanceBuffer);
    destroySafely(this.uniformBuffer);
    for (const slot of this.readback) destroySafely(slot.buffer);
    this.timer?.destroy();
  }
}

/** A 1×1 black cube: the linear variant's environment slot without an environment (F3a). */
function blankCube(device: any): any {
  const cube = device.createTexture({ size: { width: 1, height: 1, depthOrArrayLayers: 6 }, format: "rgba16float", usage: 0x04 | 0x02 });
  device.queue.writeTexture({ texture: cube }, new Uint16Array(24), { bytesPerRow: 8, rowsPerImage: 1 }, { width: 1, height: 1, depthOrArrayLayers: 6 });
  return cube;
}

/** A pipeline drawing one full-screen triangle (no vertex buffers) into a `format` target. */
function fullScreenPipeline(device: any, code: string, entryPoint: string, format: string): any {
  const module = device.createShaderModule({ code });
  return device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint, targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
}

/**
 * A draw as its view mode (F10a) shows it: a diagnostic frame without what would change its values
 * (temporal accumulation and upscaling, reflections, the camera's effects), with the prepass motion
 * vectors need, and without the depths overdraw ignores (nor what reads them).
 */
function viewModeDraw(draw: GpuSceneDraw): GpuSceneDraw {
  const code = viewModeCode(draw.viewMode);
  if (code === 0) return draw;
  const out: Record<string, unknown> = { ...draw };
  for (const key of ["temporal", "upscale", "reflections", "camera", "reflectionTrace"]) delete out[key];
  if (code === 8) out.prepass = true;
  if (code === 11) for (const key of ["prepass", "virtualShadows", "ambientOcclusion", "screenSpaceGi"]) delete out[key];
  return out as unknown as GpuSceneDraw;
}

/** Release a GPU resource without caring whether it exists or supports destroy. */
function destroySafely(resource: any): void {
  try {
    resource?.destroy?.();
  } catch {
    // Already released, or a device that has gone away. Nothing to do.
  }
}
