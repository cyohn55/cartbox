"use client";

/**
 * The map's 3D view, drawn on the GPU.
 *
 * Both 3D cameras used to be software renderers on the main thread: the orbit
 * view projects and fills every exposed face per frame, and the walking view
 * casts a ray per pixel. Both are correct, and both are why a generated landscape
 * brings the page to a halt — a 224-pixel-square frame is fifty thousand marched
 * rays, and it was upscaled almost four times to fill the stage, which is also
 * why the result looked so coarse.
 *
 * This uploads the surface once per edit and redraws it per frame in hardware, so
 * the frame is full resolution, and then spends what that saves on making the
 * world legible:
 *
 * - **Real materials.** Each texel carries a tangent-space normal, a height, a
 *   specular level and a roughness — the same channels the editor's Material
 *   layer authors — so brick catches light along its mortar and metal glints
 *   where stone does not, and the response changes as you walk past.
 * - **Parallax.** The height channel offsets the lookup along the view vector, so
 *   relief has depth at a glancing angle instead of sliding flat.
 * - **Glowing pixels light the scene.** Emissive texels keep their colour in
 *   shadow and feed a bloom pass, which is what makes a lamp read as a lamp.
 * - **Crisp at any distance.** Magnification is nearest — a texel is a hard
 *   square, as pixel art must be — while minification is trilinear over an
 *   alpha-weighted mip chain, so distant ground stops crawling. The frame is
 *   rendered at twice the canvas resolution and boxed down, which cleans the
 *   geometry edges without softening the texels inside them.
 *
 * `create` returns null whenever WebGPU is missing or anything at all fails, and
 * every caller keeps its CPU path — this is an upgrade, never a blank screen.
 *
 * WebGPU is not in this project's TS DOM lib and we do not want the @webgpu/types
 * dependency, so the handles are loosely typed. Everything with real logic in it
 * — the mesh, the atlas packing, the camera — is pure and tested without a GPU.
 */

import {
  packAtlasTexture,
  voxelModelToMesh,
  VOXEL_MESH_STRIDE,
  type AtlasTexture,
  type CameraBasis,
  type Projection,
  type SurfaceFinish,
  type TextureAtlas,
  type VoxelModel,
} from "@cartbox/editor";

import {
  CHANNEL_VIEW_IDS,
  DEFAULT_GOOCH,
  DEFAULT_RIM,
  SHADING_MODEL_IDS,
  isChannelIsolated,
  type GoochOptions,
  type MaterialChannelView,
  type RimOptions,
  type ShadingModel,
} from "./shadingModes";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** GPUTextureUsage, spelled out because the enum is not in the TS DOM lib. */
const TEXTURE_COPY_DST = 0x02;
const TEXTURE_BINDING = 0x04;
const TEXTURE_RENDER_ATTACHMENT = 0x10;

/** GPUBufferUsage, likewise. */
const BUFFER_INDEX = 0x0010;
const BUFFER_VERTEX = 0x0020;
const BUFFER_UNIFORM = 0x0040;
const BUFFER_COPY_DST = 0x0008;

/** How much bigger the internal frame is than the canvas, on each axis. */
const SUPERSAMPLE = 2;

/** Beyond this the supersampled target would cost more than it returns. */
const MAX_FRAME_PIXELS = 3400 * 2100;

/** Colour format of the scene pass, so emissive can exceed 1 before the bloom. */
const HDR_FORMAT = "rgba16float";

/** Array layers every WebGPU device guarantees, and what this renderer wants. */
const DEFAULT_ARRAY_LAYERS = 256;
const DESIRED_ARRAY_LAYERS = 1024;

/** How the world is lit. Mirrors the CPU renderers' light so the views agree. */
export interface MapGpuLight {
  readonly direction: readonly [number, number, number];
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  readonly ambient: number;
}

export interface MapGpuFrame {
  /** Where the eye is, in the same space as the model's vertices. */
  readonly eye: readonly [number, number, number];
  readonly basis: CameraBasis;
  readonly projection: Projection;
  readonly light: MapGpuLight;
  /** Colour behind everything, and what distance fades toward; each 0..1. */
  readonly sky: readonly [number, number, number];
  /** Distance at which the fade reaches full, in world units. 0 disables it. */
  readonly fogDistance: number;
  /** How much light the emissive channel bleeds into its surroundings, 0..1. */
  readonly bloom: number;
  /** Shading model; defaults to `lit`. */
  readonly shading?: ShadingModel;
  /** Channel to isolate; defaults to `shaded` (the composed image). */
  readonly channel?: MaterialChannelView;
  readonly rim?: RimOptions;
  readonly gooch?: GoochOptions;
}

const SCENE_SHADER = /* wgsl */ `
struct Camera {
  eye: vec4<f32>,
  right: vec4<f32>,
  up: vec4<f32>,
  forward: vec4<f32>,
  // scaleX, scaleY, depthScale, depthBias
  projection: vec4<f32>,
  // perspective, fogDistance, bloom, unused
  options: vec4<f32>,
  // xyz light direction, w intensity
  light: vec4<f32>,
  // rgb light colour, a ambient
  lightColor: vec4<f32>,
  sky: vec4<f32>,
  // shadingMode, channelView, rimStrength, rimPower
  view: vec4<f32>,
  // goochCool, goochWarm, matcapRim, depthRange
  stylize: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var albedoTex: texture_2d_array<f32>;
@group(0) @binding(2) var surfaceTex: texture_2d_array<f32>;
@group(0) @binding(3) var finishTex: texture_2d_array<f32>;
@group(0) @binding(4) var tileSampler: sampler;

struct VSOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) tangent: vec3<f32>,
  @location(3) tint: vec3<f32>,
  @location(4) @interpolate(flat) layer: i32,
  @location(5) handedness: f32,
  @location(6) emissive: f32,
  @location(7) toEye: vec3<f32>,
  @location(8) depth: f32,
};

@vertex
fn vs(
  @location(0) position: vec4<f32>,
  @location(1) normal: vec4<f32>,
  @location(2) tangent: vec4<f32>,
  @location(3) tint: vec4<f32>,
  @location(4) uv: vec4<f32>,
) -> VSOut {
  let rel = position.xyz - camera.eye.xyz;
  let cx = dot(rel, camera.right.xyz);
  let cy = dot(rel, camera.up.xyz);
  let cz = dot(rel, camera.forward.xyz);

  var out: VSOut;
  out.clip = vec4<f32>(
    cx * camera.projection.x,
    cy * camera.projection.y,
    cz * camera.projection.z + camera.projection.w,
    mix(1.0, cz, camera.options.x),
  );
  out.uv = uv.xy;
  out.normal = normal.xyz;
  out.tangent = tangent.xyz;
  out.tint = tint.xyz;
  out.layer = i32(round(position.w));
  out.handedness = tangent.w;
  out.emissive = normal.w;
  out.toEye = -rel;
  out.depth = cz;
  return out;
}

/** How far the height channel may shift a lookup, in tile widths. */
const PARALLAX: f32 = 0.055;
/** Below this the view is nearly edge-on and the parallax step would explode. */
const PARALLAX_LIMIT: f32 = 0.2;

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  // A face is drawn double-sided (a plane cell has two), so the shading normal
  // turns to meet the viewer — otherwise a grass quad is black from one side.
  let eyeDir = normalize(in.toEye);
  var basisN = normalize(in.normal);
  if (dot(basisN, eyeDir) < 0.0) { basisN = -basisN; }
  let basisT = normalize(in.tangent - basisN * dot(in.tangent, basisN));
  let basisB = cross(basisN, basisT) * in.handedness;

  // Every texture read happens here, unconditionally and before any branch: a
  // sampler needs uniform control flow, and "which cells are textured" varies
  // per fragment. Untextured faces sample layer 0 and then discard the result.
  let layer = max(in.layer, 0);
  let tangentEye = vec3<f32>(dot(eyeDir, basisT), dot(eyeDir, basisB), dot(eyeDir, basisN));
  let firstHeight = textureSample(surfaceTex, tileSampler, in.uv, layer).a;
  let towards = select(-1.0, 1.0, tangentEye.z >= 0.0);
  let slope = max(abs(tangentEye.z), PARALLAX_LIMIT) * towards;
  let uv = in.uv - (tangentEye.xy / slope) * (firstHeight - 0.5) * PARALLAX;

  let sampled = textureSample(albedoTex, tileSampler, uv, layer);
  let packed = textureSample(surfaceTex, tileSampler, uv, layer);
  let finish = textureSample(finishTex, tileSampler, uv, layer);

  let textured = in.layer >= 0;
  // Tinting is how one grey tile serves every colour: albedo = art x cell colour.
  let albedo = select(in.tint, sampled.rgb * in.tint, textured);
  let alpha = select(1.0, sampled.a, textured);
  let tangentNormal = normalize(packed.xyz * 2.0 - 1.0);
  let mapped = normalize(basisT * tangentNormal.x + basisB * tangentNormal.y + basisN * tangentNormal.z);
  let normal = select(basisN, mapped, textured);
  let specular = select(0.05, finish.r, textured);
  let roughness = clamp(select(0.9, finish.g, textured), 0.04, 1.0);
  let glow = max(select(0.0, finish.b, textured), in.emissive);

  if (alpha < 0.5) { discard; }

  // Channel views short-circuit everything below: the point of isolating a
  // channel is to see the authored value, so lighting it would defeat the view.
  // Every texture read is already done, so returning here keeps control flow
  // uniform for the sampler.
  let channelView = i32(round(camera.view.y));
  if (channelView > 0) {
    var probe = vec3<f32>(0.0);
    if (channelView == 1) { probe = albedo; }
    else if (channelView == 2) { probe = normal * 0.5 + 0.5; }
    else if (channelView == 3) { probe = vec3<f32>(packed.a); }
    else if (channelView == 4) { probe = vec3<f32>(specular); }
    else if (channelView == 5) { probe = vec3<f32>(roughness); }
    else if (channelView == 6) { probe = albedo * glow; }
    else { probe = vec3<f32>(clamp(in.depth / max(camera.stylize.w, 1.0), 0.0, 1.0)); }
    // Alpha 0: a channel view has nothing to bloom, whatever the frame asked for.
    return vec4<f32>(probe, 0.0);
  }

  let toLight = normalize(camera.light.xyz);
  let diffuse = max(0.0, dot(normal, toLight));
  let ambient = camera.lightColor.a;
  let shade = ambient + (1.0 - ambient) * diffuse * camera.light.w;

  // Blinn-Phong, with roughness widening the lobe. Cheap, stable, and it reads
  // the way a pixel artist expects a highlight to read.
  let halfway = normalize(toLight + eyeDir);
  let highlight = pow(max(0.0, dot(normal, halfway)), mix(160.0, 4.0, roughness))
    * specular * step(0.001, diffuse);

  let shadingMode = i32(round(camera.view.x));
  var lit = albedo * shade * camera.lightColor.rgb + vec3<f32>(highlight);

  if (shadingMode == 1) {
    // Matcap: shade from the *view-space* normal alone, so the lighting is
    // welded to the camera and orbiting reveals silhouette and curvature rather
    // than moving the highlights around. Built analytically as a studio-lit
    // sphere — key, fill, and a rim at the limb — rather than sampled from a
    // matcap image, so it needs no asset and no extra binding.
    let viewNormal = vec3<f32>(
      dot(normal, camera.right.xyz),
      dot(normal, camera.up.xyz),
      dot(normal, camera.forward.xyz)
    );
    let key = max(0.0, dot(viewNormal, normalize(vec3<f32>(-0.5, 0.6, -0.6))));
    let fill = max(0.0, dot(viewNormal, normalize(vec3<f32>(0.5, -0.4, -0.7))));
    let limb = pow(1.0 - abs(viewNormal.z), 3.0) * camera.stylize.z;
    let studio = key * 0.85 + fill * 0.25 + limb;
    lit = albedo * (0.15 + studio)
      + vec3<f32>(pow(key, mix(160.0, 8.0, roughness)) * specular);
  } else if (shadingMode == 2) {
    // Gooch: a cool tint away from the light and a warm one toward it, each
    // carrying some of the albedo. Nothing goes to black, which is the whole
    // point — an unlit face still shows its form.
    let cool = vec3<f32>(0.0, 0.0, 0.55) + camera.stylize.x * albedo;
    let warm = vec3<f32>(0.4, 0.4, 0.0) + camera.stylize.y * albedo;
    lit = mix(cool, warm, (1.0 + dot(normal, toLight)) * 0.5) + vec3<f32>(highlight);
  }

  // Rim light, on top of whichever model ran: brighten where the surface turns
  // away from the eye, which separates a silhouette from whatever is behind it.
  if (camera.view.z > 0.0) {
    let rim = pow(1.0 - max(0.0, dot(normal, eyeDir)), max(camera.view.w, 0.1));
    lit = lit + camera.lightColor.rgb * rim * camera.view.z;
  }

  // Emissive is a floor, not an addition: a glowing texel keeps its own colour
  // in shadow rather than washing out toward white.
  var colour = max(lit, albedo * glow);

  // Distance fade toward the sky, so the built window ends in haze rather than
  // in a cliff edge with black behind it.
  if (camera.options.y > 0.0) {
    let fade = clamp(in.depth / camera.options.y, 0.0, 1.0);
    colour = mix(colour, camera.sky.rgb, fade * fade);
  }

  // Alpha carries how much this pixel should bloom, so the bright pass follows
  // what the author marked as glowing rather than anything merely pale.
  return vec4<f32>(colour, glow * camera.options.z);
}
`;

const POST_SHADER = /* wgsl */ `
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var corners = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  let xy = corners[vi];
  var out: VSOut;
  out.pos = vec4<f32>(xy, 0.0, 1.0);
  out.uv = vec2<f32>((xy.x + 1.0) * 0.5, 1.0 - (xy.y + 1.0) * 0.5);
  return out;
}

// xy = the step to take per tap, z and w unused.
struct Post { step: vec4<f32> };
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var<uniform> post: Post;

/** Bright pass: keep only what the scene marked as emissive. */
@fragment
fn bright(in: VSOut) -> @location(0) vec4<f32> {
  var total = vec3<f32>(0.0);
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      let uv = in.uv + vec2<f32>(f32(x), f32(y)) * post.step.xy;
      let texel = textureSample(source, linearSampler, uv);
      total = total + texel.rgb * texel.a;
    }
  }
  return vec4<f32>(total / 9.0, 1.0);
}

/** One half of a separable blur; the direction comes in as the step. */
@fragment
fn blur(in: VSOut) -> @location(0) vec4<f32> {
  var weights = array<f32, 5>(0.227027, 0.194594, 0.121621, 0.054054, 0.016216);
  var total = textureSample(source, linearSampler, in.uv).rgb * weights[0];
  for (var i = 1; i < 5; i = i + 1) {
    let offset = post.step.xy * f32(i);
    total = total + textureSample(source, linearSampler, in.uv + offset).rgb * weights[i];
    total = total + textureSample(source, linearSampler, in.uv - offset).rgb * weights[i];
  }
  return vec4<f32>(total, 1.0);
}
`;

const RESOLVE_SHADER = /* wgsl */ `
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var corners = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  let xy = corners[vi];
  var out: VSOut;
  out.pos = vec4<f32>(xy, 0.0, 1.0);
  out.uv = vec2<f32>((xy.x + 1.0) * 0.5, 1.0 - (xy.y + 1.0) * 0.5);
  return out;
}

// xy = one texel of the supersampled scene, z = bloom strength.
struct Resolve { texel: vec4<f32> };
@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var bloomTex: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<uniform> resolve: Resolve;

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  // Box down the supersampled frame: four taps at the half-texel diagonals. This
  // is what cleans the jagged silhouettes, and it touches nothing inside a face —
  // the texels there are already flat, so averaging four of them changes nothing.
  let half = resolve.texel.xy * 0.5;
  var colour = textureSample(scene, linearSampler, in.uv + vec2<f32>(-half.x, -half.y)).rgb;
  colour = colour + textureSample(scene, linearSampler, in.uv + vec2<f32>(half.x, -half.y)).rgb;
  colour = colour + textureSample(scene, linearSampler, in.uv + vec2<f32>(-half.x, half.y)).rgb;
  colour = colour + textureSample(scene, linearSampler, in.uv + vec2<f32>(half.x, half.y)).rgb;
  colour = colour * 0.25;

  colour = colour + textureSample(bloomTex, linearSampler, in.uv).rgb * resolve.texel.z;

  // Roll off only what is actually over-bright, and leave everything else exactly
  // as authored. A global tone curve (Reinhard over the whole range) desaturates
  // and darkens every ordinary texel to make room for highlights that mostly are
  // not there — which on pixel art means the palette you chose is not the palette
  // you see. Here a bloomed lamp compresses and the ground beside it does not.
  let peak = max(colour.r, max(colour.g, colour.b));
  let rolled = select(peak, 1.0 + log(peak) * 0.4, peak > 1.0);
  colour = colour * (rolled / max(peak, 1.0e-5));
  return vec4<f32>(clamp(colour, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
`;

interface FrameTargets {
  readonly width: number;
  readonly height: number;
  readonly bloomWidth: number;
  readonly bloomHeight: number;
  readonly textures: readonly any[];
  readonly sceneView: any;
  readonly depthView: any;
  readonly bloomAView: any;
  readonly bloomBView: any;
}

/** The four post passes, in the order they run. */
interface PostChain {
  readonly bright: any;
  readonly blurHorizontal: any;
  readonly blurVertical: any;
  readonly blurAgain: any;
  readonly resolve: any;
}

export class MapGpuRenderer {
  private mesh: { vertexBuffer: any; indexBuffer: any; indexCount: number } | null = null;
  private atlasBinding: { albedo: any; surface: any; finish: any; sampler: any } | null = null;
  private targets: FrameTargets | null = null;
  private post: PostChain | null = null;
  private sceneBindGroup: any = null;
  private destroyed = false;

  private constructor(
    private readonly device: any,
    private readonly context: any,
    private readonly canvas: HTMLCanvasElement,
    private readonly scenePipeline: any,
    private readonly brightPipeline: any,
    private readonly blurPipeline: any,
    private readonly resolvePipeline: any,
    private readonly cameraBuffer: any,
    private readonly brightUniform: any,
    private readonly blurHUniform: any,
    private readonly blurVUniform: any,
    private readonly resolveUniform: any,
    private readonly linearSampler: any,
    /** Array layers this device granted; the atlas is trimmed to fit. */
    private readonly maxLayers: number,
  ) {}

  static async create(canvas: HTMLCanvasElement): Promise<MapGpuRenderer | null> {
    try {
      const gpu = (navigator as unknown as { gpu?: any }).gpu;
      if (!gpu) return null;
      const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) return null;

      // The atlas needs one array layer per tile, and a cart's sprite page alone
      // is 256 of them — past the 256 a device grants by default once the world's
      // own materials are added. Adapters offer far more (2048 is typical) but
      // only if asked, so ask; `setAtlas` still trims to whatever is granted.
      const wanted = Math.min(DESIRED_ARRAY_LAYERS, adapter.limits?.maxTextureArrayLayers ?? DEFAULT_ARRAY_LAYERS);
      const device = await adapter.requestDevice(
        wanted > DEFAULT_ARRAY_LAYERS ? { requiredLimits: { maxTextureArrayLayers: wanted } } : {},
      );
      // A driver-side validation failure is asynchronous and does not throw, so
      // without this a broken pipeline is simply a black canvas with no
      // explanation anywhere. Falling back silently is right; falling back
      // silently *and* unexplainably is not.
      device.addEventListener?.("uncapturederror", (event: any) =>
        console.warn("[map-gpu]", event?.error?.message ?? event),
      );
      const context = canvas.getContext("webgpu") as any;
      if (!context) return null;

      const format = gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: "opaque" });

      const sceneModule = device.createShaderModule({ code: SCENE_SHADER });
      const postModule = device.createShaderModule({ code: POST_SHADER });
      const resolveModule = device.createShaderModule({ code: RESOLVE_SHADER });

      const scenePipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module: sceneModule,
          entryPoint: "vs",
          buffers: [
            {
              arrayStride: VOXEL_MESH_STRIDE * 4,
              attributes: [0, 1, 2, 3, 4].map((slot) => ({
                shaderLocation: slot,
                offset: slot * 16,
                format: "float32x4",
              })),
            },
          ],
        },
        fragment: { module: sceneModule, entryPoint: "fs", targets: [{ format: HDR_FORMAT }] },
        // No culling: a plane cell is a single quad that must be visible from
        // both sides, and solid cells only ever emit faces that are exposed.
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
      });

      const screenPipeline = (module: any, entryPoint: string, target: string) =>
        device.createRenderPipeline({
          layout: "auto",
          vertex: { module, entryPoint: "vs" },
          fragment: { module, entryPoint, targets: [{ format: target }] },
          primitive: { topology: "triangle-list" },
        });

      const uniform = (size: number) =>
        device.createBuffer({ size, usage: BUFFER_UNIFORM | BUFFER_COPY_DST });

      return new MapGpuRenderer(
        device,
        context,
        canvas,
        scenePipeline,
        screenPipeline(postModule, "bright", HDR_FORMAT),
        screenPipeline(postModule, "blur", HDR_FORMAT),
        screenPipeline(resolveModule, "fs", format),
        // 11 vec4s: the camera block through to the stylization controls.
        uniform(11 * 16),
        uniform(16),
        uniform(16),
        uniform(16),
        uniform(16),
        device.createSampler({
          magFilter: "linear",
          minFilter: "linear",
          addressModeU: "clamp-to-edge",
          addressModeV: "clamp-to-edge",
        }),
        device.limits?.maxTextureArrayLayers ?? DEFAULT_ARRAY_LAYERS,
      );
    } catch {
      return null;
    }
  }

  /**
   * Upload the atlas as three layered, mipped textures. Called when the cart's
   * art changes — a repaint of one sprite, not every frame.
   */
  setAtlas(atlas: TextureAtlas, finishFor?: (tile: number) => SurfaceFinish): AtlasTexture | null {
    if (this.destroyed) return null;
    try {
      const packed = packAtlasTexture(atlas, { finishFor, maxLayers: this.maxLayers });
      const create = () =>
        this.device.createTexture({
          size: [packed.size, packed.size, packed.layers],
          format: "rgba8unorm",
          dimension: "2d",
          mipLevelCount: packed.levels.length,
          usage: TEXTURE_BINDING | TEXTURE_COPY_DST,
        });
      const albedo = create();
      const surface = create();
      const finish = create();

      packed.levels.forEach((level, mipLevel) => {
        const write = (texture: any, data: Uint8Array) =>
          this.device.queue.writeTexture(
            { texture, mipLevel },
            data,
            { bytesPerRow: level.size * 4, rowsPerImage: level.size },
            { width: level.size, height: level.size, depthOrArrayLayers: packed.layers },
          );
        write(albedo, level.albedo);
        write(surface, level.surface);
        write(finish, level.finish);
      });

      this.releaseAtlas();
      this.atlasBinding = {
        albedo,
        surface,
        finish,
        // Nearest magnification keeps a texel a hard square up close; trilinear
        // minification stops the distant ground crawling as the camera moves.
        // (No anisotropy: WebGPU only permits it when *every* filter is linear,
        // and blurring a texel up close would defeat the whole point.)
        sampler: this.device.createSampler({
          magFilter: "nearest",
          minFilter: "linear",
          mipmapFilter: "linear",
          addressModeU: "repeat",
          addressModeV: "repeat",
        }),
      };
      this.sceneBindGroup = null;
      return packed;
    } catch (error) {
      console.warn("[map-gpu] atlas upload failed", error);
      return null;
    }
  }

  /** Upload the surface to draw. Returns its triangle count, or 0 on failure. */
  setModel(model: VoxelModel, faceLayer?: Int32Array): number {
    if (this.destroyed) return 0;
    try {
      const mesh = voxelModelToMesh(model, { faceLayer });
      this.releaseMesh();
      if (mesh.triangleCount === 0) return 0;

      const vertexBuffer = this.device.createBuffer({
        size: mesh.vertices.byteLength,
        usage: BUFFER_VERTEX | BUFFER_COPY_DST,
      });
      const indexBuffer = this.device.createBuffer({
        size: mesh.indices.byteLength,
        usage: BUFFER_INDEX | BUFFER_COPY_DST,
      });
      this.device.queue.writeBuffer(vertexBuffer, 0, mesh.vertices);
      this.device.queue.writeBuffer(indexBuffer, 0, mesh.indices);
      this.mesh = { vertexBuffer, indexBuffer, indexCount: mesh.indices.length };
      return mesh.triangleCount;
    } catch (error) {
      console.warn("[map-gpu] surface upload failed", error);
      this.mesh = null;
      return 0;
    }
  }

  /** Whether an atlas has been uploaded and the renderer can draw at all. */
  get ready(): boolean {
    return !this.destroyed && this.atlasBinding !== null;
  }

  /**
   * Draw one frame at the canvas's current size. Returns false if the frame could
   * not be produced, which tells the caller to fall back for good.
   */
  render(frame: MapGpuFrame): boolean {
    if (this.destroyed || !this.atlasBinding) return false;
    try {
      const targets = this.ensureTargets();
      const post = this.post!;
      this.device.queue.writeBuffer(this.cameraBuffer, 0, cameraUniform(frame));

      const encoder = this.device.createCommandEncoder();
      // A channel view clears to black rather than to sky: the background is not
      // part of the channel being inspected, and tinting it would invite reading
      // the sky's blue as a normal or a roughness value.
      const clearSky = isChannelIsolated(frame.channel) ? [0, 0, 0] : frame.sky;
      const scenePass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: targets.sceneView,
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: clearSky[0]!, g: clearSky[1]!, b: clearSky[2]!, a: 0 },
          },
        ],
        depthStencilAttachment: {
          view: targets.depthView,
          depthLoadOp: "clear",
          depthStoreOp: "store",
          depthClearValue: 1,
        },
      });
      if (this.mesh) {
        scenePass.setPipeline(this.scenePipeline);
        scenePass.setBindGroup(0, this.ensureSceneBindGroup());
        scenePass.setVertexBuffer(0, this.mesh.vertexBuffer);
        scenePass.setIndexBuffer(this.mesh.indexBuffer, "uint32");
        scenePass.drawIndexed(this.mesh.indexCount);
      }
      scenePass.end();

      this.runBloom(encoder, targets, post, frame.bloom);

      const finalPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.context.getCurrentTexture().createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });
      finalPass.setPipeline(this.resolvePipeline);
      finalPass.setBindGroup(0, post.resolve);
      finalPass.draw(3);
      finalPass.end();

      this.device.queue.submit([encoder.finish()]);
      return true;
    } catch (error) {
      console.warn("[map-gpu] frame failed", error);
      return false;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.device.destroy();
    } catch {
      // already gone
    }
  }

  /**
   * Bright pass then three separable blur passes, all at a quarter of the frame.
   * Blurring twice horizontally is deliberate: a wide, soft halo at low cost,
   * which is what a glow wants, rather than a tight ring.
   */
  private runBloom(encoder: any, targets: FrameTargets, post: PostChain, bloom: number): void {
    const strength = Math.max(0, bloom);
    this.device.queue.writeBuffer(
      this.resolveUniform,
      0,
      new Float32Array([1 / targets.width, 1 / targets.height, strength, 0]),
    );

    const run = (pipeline: any, bindGroup: any, view: any) => {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
    };

    if (strength <= 0) {
      // Still clear the bloom target, or the last frame's glow would linger.
      const clear = encoder.beginRenderPass({
        colorAttachments: [
          { view: targets.bloomAView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } },
        ],
      });
      clear.end();
      return;
    }

    run(this.brightPipeline, post.bright, targets.bloomBView);
    run(this.blurPipeline, post.blurHorizontal, targets.bloomAView);
    run(this.blurPipeline, post.blurVertical, targets.bloomBView);
    run(this.blurPipeline, post.blurAgain, targets.bloomAView);
  }

  private ensureSceneBindGroup(): any {
    if (this.sceneBindGroup) return this.sceneBindGroup;
    const atlas = this.atlasBinding!;
    this.sceneBindGroup = this.device.createBindGroup({
      layout: this.scenePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: atlas.albedo.createView({ dimension: "2d-array" }) },
        { binding: 2, resource: atlas.surface.createView({ dimension: "2d-array" }) },
        { binding: 3, resource: atlas.finish.createView({ dimension: "2d-array" }) },
        { binding: 4, resource: atlas.sampler },
      ],
    });
    return this.sceneBindGroup;
  }

  /** Size the internal targets to the canvas, reallocating only when it changes. */
  private ensureTargets(): FrameTargets {
    const canvasWidth = Math.max(1, this.canvas.width);
    const canvasHeight = Math.max(1, this.canvas.height);
    let scale = SUPERSAMPLE;
    while (scale > 1 && canvasWidth * scale * canvasHeight * scale > MAX_FRAME_PIXELS) scale -= 1;
    const width = canvasWidth * scale;
    const height = canvasHeight * scale;
    if (this.targets && this.targets.width === width && this.targets.height === height) {
      return this.targets;
    }

    this.releaseTargets();
    const colour = (w: number, h: number) =>
      this.device.createTexture({
        size: [Math.max(1, w), Math.max(1, h)],
        format: HDR_FORMAT,
        usage: TEXTURE_RENDER_ATTACHMENT | TEXTURE_BINDING,
      });
    const scene = colour(width, height);
    const depth = this.device.createTexture({
      size: [width, height],
      format: "depth24plus",
      usage: TEXTURE_RENDER_ATTACHMENT,
    });
    const bloomWidth = Math.max(1, width >> 2);
    const bloomHeight = Math.max(1, height >> 2);
    const bloomA = colour(bloomWidth, bloomHeight);
    const bloomB = colour(bloomWidth, bloomHeight);

    const targets: FrameTargets = {
      width,
      height,
      bloomWidth,
      bloomHeight,
      textures: [scene, depth, bloomA, bloomB],
      sceneView: scene.createView(),
      depthView: depth.createView(),
      bloomAView: bloomA.createView(),
      bloomBView: bloomB.createView(),
    };
    this.targets = targets;
    this.post = this.buildPostChain(targets);
    return targets;
  }

  /**
   * The post passes' bind groups, built with the targets rather than per frame —
   * a bind group per pass per frame is a real cost at sixty frames a second.
   */
  private buildPostChain(targets: FrameTargets): PostChain {
    const bloomStep = [1 / targets.bloomWidth, 1 / targets.bloomHeight];
    this.device.queue.writeBuffer(
      this.brightUniform,
      0,
      new Float32Array([1 / targets.width, 1 / targets.height, 0, 0]),
    );
    this.device.queue.writeBuffer(this.blurHUniform, 0, new Float32Array([bloomStep[0]!, 0, 0, 0]));
    this.device.queue.writeBuffer(this.blurVUniform, 0, new Float32Array([0, bloomStep[1]!, 0, 0]));

    const screenGroup = (pipeline: any, source: any, uniform: any) =>
      this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: source },
          { binding: 1, resource: this.linearSampler },
          { binding: 2, resource: { buffer: uniform } },
        ],
      });

    return {
      bright: screenGroup(this.brightPipeline, targets.sceneView, this.brightUniform),
      blurHorizontal: screenGroup(this.blurPipeline, targets.bloomBView, this.blurHUniform),
      blurVertical: screenGroup(this.blurPipeline, targets.bloomAView, this.blurVUniform),
      blurAgain: screenGroup(this.blurPipeline, targets.bloomBView, this.blurHUniform),
      resolve: this.device.createBindGroup({
        layout: this.resolvePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: targets.sceneView },
          { binding: 1, resource: targets.bloomAView },
          { binding: 2, resource: this.linearSampler },
          { binding: 3, resource: { buffer: this.resolveUniform } },
        ],
      }),
    };
  }

  private releaseTargets(): void {
    for (const texture of this.targets?.textures ?? []) destroySafely(texture);
    this.targets = null;
    this.post = null;
  }

  private releaseMesh(): void {
    destroySafely(this.mesh?.vertexBuffer);
    destroySafely(this.mesh?.indexBuffer);
    this.mesh = null;
  }

  private releaseAtlas(): void {
    destroySafely(this.atlasBinding?.albedo);
    destroySafely(this.atlasBinding?.surface);
    destroySafely(this.atlasBinding?.finish);
    this.atlasBinding = null;
  }
}

function destroySafely(resource: any): void {
  try {
    resource?.destroy?.();
  } catch {
    // already gone
  }
}

/** How far the depth channel view ramps from black to white when fog is off. */
const DEFAULT_DEPTH_RANGE = 64;

/** How brightly the procedural matcap lights its limb. */
const MATCAP_RIM = 0.35;

/** The camera block, laid out to match the shader's `Camera` struct exactly. */
function cameraUniform(frame: MapGpuFrame): Float32Array {
  const { eye, basis, projection, light, sky } = frame;
  const length = Math.hypot(light.direction[0], light.direction[1], light.direction[2]) || 1;
  const rim = frame.rim ?? DEFAULT_RIM;
  const gooch = frame.gooch ?? DEFAULT_GOOCH;
  // The depth view needs a range to normalise against. Fog distance is the
  // frame's own idea of "far" when it has one, so the two views agree.
  const depthRange = frame.fogDistance > 0 ? frame.fogDistance : DEFAULT_DEPTH_RANGE;
  return new Float32Array([
    eye[0], eye[1], eye[2], 0,
    basis.right[0], basis.right[1], basis.right[2], 0,
    basis.up[0], basis.up[1], basis.up[2], 0,
    basis.forward[0], basis.forward[1], basis.forward[2], 0,
    projection.scaleX, projection.scaleY, projection.depthScale, projection.depthBias,
    projection.perspective, frame.fogDistance, frame.bloom, 0,
    light.direction[0] / length, light.direction[1] / length, light.direction[2] / length, light.intensity,
    light.color[0], light.color[1], light.color[2], light.ambient,
    sky[0], sky[1], sky[2], 1,
    SHADING_MODEL_IDS[frame.shading ?? "lit"], CHANNEL_VIEW_IDS[frame.channel ?? "shaded"], rim.strength, rim.power,
    gooch.cool, gooch.warm, MATCAP_RIM, depthRange,
  ]);
}
