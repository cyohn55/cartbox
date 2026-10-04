/**
 * Runs in a real browser page (bundled by webgl-parity.test.ts): renders test
 * scenes with the WebGL2 renderer and the software rasteriser and reports how
 * far apart the two frames are.
 */

import {
  composeModelMatrix,
  orthographicMatrix,
  projectionMatrix,
  renderShadowMap,
  viewMatrix,
  type DecodedTexture,
  type MeshAsset,
  type MeshSceneInstance,
  type SceneLight,
} from "@cartbox/editor";

import { SoftwareSceneRenderer, type SceneDraw } from "../../packages/player/src/render/sceneRenderer";
import { graphInstances } from "./graphScenes";
import { WebglSceneRenderer } from "../../packages/player/src/render/WebglSceneRenderer";

const W = 64;
const H = 48;

function quad(material: Partial<MeshAsset["primitives"][number]["material"]> = {}): MeshAsset {
  return {
    name: "q",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [0.9, 0.4, 0.2, 1], baseColorImage: null, ...material },
      },
    ],
  };
}

function floor(h: number, y: number): MeshAsset {
  return {
    name: "floor",
    primitives: [
      {
        positions: Float32Array.from([-h, y, -h, h, y, -h, h, y, h, -h, y, h]),
        normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [0.8, 0.8, 0.8, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 },
      },
    ],
  };
}

function texture(): DecodedTexture {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < 16; i += 1) data.set([(i * 17) & 255, (255 - i * 13) & 255, (i * 31) & 255, 255], i * 4);
  return { width: 4, height: 4, data };
}

/** A 4×4 texture whose texels alternate opaque and nearly clear, for a cut-out surface. */
function halfAlpha(): DecodedTexture {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < 16; i += 1) data.set([255, 255, 255, (i + (i >> 2)) % 2 === 0 ? 255 : 40], i * 4);
  return { width: 4, height: 4, data };
}

function baseDraw(): SceneDraw {
  return {
    width: W,
    height: H,
    out: new Uint8ClampedArray(W * H * 4),
    depth: new Float32Array(W * H),
    view: viewMatrix([0, 0, 4], [0, 0, 0]),
    projection: projectionMatrix((60 * Math.PI) / 180, W / H, 0.1, 100),
    background: [0, 0, 0, 255],
  };
}

interface Scene {
  instances: MeshSceneInstance[];
  draw: () => SceneDraw;
}

function scenes(): Record<string, Scene> {
  const tex = texture();
  const shared = quad();
  const copies = (n: number, spread: number): MeshSceneInstance[] => {
    const columns = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / columns);
    return Array.from({ length: n }, (_, i) => ({
      mesh: shared,
      model: composeModelMatrix(
        [((i % columns) - (columns - 1) / 2) * spread, (Math.floor(i / columns) - (rows - 1) / 2) * spread * 0.8, -0.05 * (i % 7)],
        [7 * i, 11 * (i % 5) - 20, 3 * i],
        [spread * 0.4, spread * 0.4, spread * 0.4],
      ),
      textures: i % 3 === 0 ? [tex] : null,
    }));
  };
  const lit = (): SceneDraw => ({ ...baseDraw(), view: viewMatrix([0, 4, 7], [0, 0, 0]) });
  const lights: SceneLight[] = [
    { kind: "directional", direction: [0.3, 1, 0.2], color: [1, 0.9, 0.8], intensity: 1 },
    { kind: "point", position: [1, 1.5, 1], color: [0.2, 0.5, 1], intensity: 2, range: 5 },
  ];
  return {
    fantasy: {
      instances: [
        { mesh: quad(), model: composeModelMatrix([0, 0, 0], [0, 30, 0], [1.4, 1.4, 1.4]), textures: null },
        { mesh: quad(), model: composeModelMatrix([0.8, 0.3, -0.6], [15, -40, 0], [0.9, 0.9, 0.9]), textures: null },
        { mesh: quad(), model: composeModelMatrix([-0.9, -0.2, 0.5], [-20, 55, 10], [0.8, 0.8, 0.8]), textures: [tex] },
        { mesh: quad(), model: composeModelMatrix([0.2, -0.7, 0.9], [40, 10, -25], [0.6, 0.6, 0.6]), textures: [tex] },
      ],
      draw: baseDraw,
    },
    instanced: { instances: copies(9, 0.9), draw: baseDraw },
    // More copies than one uniform block holds, so a batch splits into several draws.
    chunked: { instances: copies(150, 0.3), draw: baseDraw },
    pbr: {
      instances: [
        { mesh: quad({ metallicFactor: 1, roughnessFactor: 0.15 }), model: composeModelMatrix([-0.9, 0, 0], [0, 15, 0], [1.1, 1.1, 1.1]) },
        { mesh: quad({ metallicFactor: 0, roughnessFactor: 0.8 }), model: composeModelMatrix([0.9, 0, 0], [0, -15, 0], [1.1, 1.1, 1.1]) },
      ],
      draw: baseDraw,
    },
    // Transparency (EP6): an opaque wall, a blended pane and an added glow in front of
    // it (drawn after it, farthest first, without writing depth), and a cut-out quad.
    transparent: {
      instances: [
        { mesh: quad({ metallicFactor: 0, roughnessFactor: 0.8 }), model: composeModelMatrix([0, 0, -1], [0, 0, 0], [2.2, 1.6, 1]) },
        { mesh: quad({ baseColorFactor: [0.2, 0.6, 1, 0.4], metallicFactor: 0, roughnessFactor: 0.2, alphaMode: "blend" }), model: composeModelMatrix([-0.5, 0, 0.3], [0, 20, 0], [0.9, 0.9, 1]) },
        { mesh: quad({ baseColorFactor: [1, 0.3, 0.1, 0.7], alphaMode: "additive" }), model: composeModelMatrix([0.6, 0.2, 0.6], [0, -15, 0], [0.6, 0.6, 1]) },
        { mesh: quad({ baseColorFactor: [0.3, 1, 0.3, 1], alphaMode: "mask", alphaCutoff: 0.5 }), model: composeModelMatrix([0.3, -0.6, 0.2], [0, 0, 0], [0.6, 0.6, 1]), textures: [halfAlpha()] },
      ],
      draw: baseDraw,
    },
    // Soft edges (EP6b): a blended and an added quad standing through the
    // floor fade out as they meet it, reading the opaque depth back as distance.
    soft: {
      instances: [
        { mesh: floor(3, 0), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) },
        { mesh: quad({ baseColorFactor: [0.2, 0.6, 1, 0.8], metallicFactor: 0, roughnessFactor: 1, alphaMode: "blend", softDepth: 0.8 }), model: composeModelMatrix([-0.7, 0.4, 0], [0, 10, 0], [0.8, 0.8, 1]) },
        { mesh: quad({ baseColorFactor: [1, 0.4, 0.1, 0.9], alphaMode: "additive", softDepth: 0.5 }), model: composeModelMatrix([0.8, 0.3, 0.5], [0, -20, 0], [0.6, 0.6, 1]) },
      ],
      draw: () => ({ ...baseDraw(), view: viewMatrix([0, 4, 7], [0, 0, 0]) }),
    },
    // Material graphs (EP7): noise, fresnel, UV and maths into every PBR input,
    // and a scrolling texture's alpha into a see-through surface's coverage.
    graph: { instances: graphInstances(quad), draw: () => ({ ...baseDraw(), time: 0.7 }) },
    // Shield effects (H11): rim, glow and bands within rounding, and the camo dither dropping the very same pixels.
    effects: {
      instances: [
        { mesh: quad({ metallicFactor: 1, roughnessFactor: 0.15 }), model: composeModelMatrix([-0.9, 0, 0], [0, 15, 0], [1.1, 1.1, 1.1]), effect: { rim: [1.2, 0.9, 0.3], rimPower: 1.5, glow: [0.2, 0.15, 0.05] } },
        { mesh: quad({ metallicFactor: 0, roughnessFactor: 0.8 }), model: composeModelMatrix([0.9, 0, 0], [0, -15, 0], [1.1, 1.1, 1.1]), effect: { bands: [0.8, 0.7, 0.4], camo: 0.5, rim: [0.2, 0.3, 0.5], rimPower: 3 } },
      ],
      draw: () => ({ ...baseDraw(), time: 0.37 }),
    },
    lights: {
      instances: [{ mesh: floor(3, 0), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }],
      draw: () => ({ ...lit(), lights }),
    },
    // A floor under an occluder with a CPU-built shadow map: PBR, then the fantasy path.
    shadow: shadowScene(true),
    shadowFantasy: shadowScene(false),
    fog: {
      instances: [{ mesh: floor(4, 0), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }],
      draw: () => ({ ...lit(), fog: { color: [0.6, 0.7, 0.8], density: 0.2, start: 2, max: 0.9 } }),
    },
  };
}

function shadowScene(pbr: boolean): Scene {
  const plain = (m: MeshAsset): MeshAsset =>
    pbr ? m : { ...m, primitives: m.primitives.map((p) => ({ ...p, material: { name: "m", baseColorFactor: [0.8, 0.8, 0.8, 1], baseColorImage: null } })) };
  const instances: MeshSceneInstance[] = [
    { mesh: plain(floor(5, 0)), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) },
    { mesh: plain(floor(1.2, 3)), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) },
  ];
  const shadow = renderShadowMap(instances, {
    lightView: viewMatrix([0, 10, 0], [0, 0, 0], [0, 0, -1]),
    lightProjection: orthographicMatrix(-6, 6, -6, 6, 0.1, 20),
    size: 256,
    depth: new Float32Array(256 * 256),
  });
  return { instances, draw: () => ({ ...baseDraw(), view: viewMatrix([0, 7, 8], [0, 0, 0]), lightDirection: [0, 1, 0], shadow }) };
}

async function run(name: string): Promise<{ drawn: number; differing: number; maxDelta: number; coverage: number; stats: unknown; backend: string; diffs: string[] } | { error: string }> {
  const scene = scenes()[name];
  if (!scene) return { error: `no scene ${name}` };
  const renderer = WebglSceneRenderer.create(W, H);
  if (!renderer) return { error: "WebGL2 renderer did not build" };
  renderer.render(scene.instances, scene.draw());
  for (let i = 0; i < 100 && !(renderer as unknown as { latest: Uint8Array | null }).latest; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    renderer.render(scene.instances, scene.draw());
  }
  if (!(renderer as unknown as { latest: Uint8Array | null }).latest) return { error: "no GPU frame arrived" };
  // The frame composited now is the newest finished GPU frame of the same scene.
  const gpu = scene.draw();
  renderer.render(scene.instances, gpu);
  const software = scene.draw();
  new SoftwareSceneRenderer().render(scene.instances, software);
  let drawn = 0;
  let differing = 0;
  let maxDelta = 0;
  let coverage = 0;
  const diffs: string[] = [];
  for (let p = 0; p < W * H; p += 1) {
    const a = Array.from(gpu.out.subarray(p * 4, p * 4 + 4));
    const b = Array.from(software.out.subarray(p * 4, p * 4 + 4));
    if (diffs.length < 8 && a.some((v, c) => v !== b[c])) diffs.push(`${p % W},${Math.floor(p / W)} gpu=${a} sw=${b}`);
  }
  for (let i = 0; i < W * H * 4; i += 1) {
    if (i % 4 === 0 && (software.out[i]! | software.out[i + 1]! | software.out[i + 2]!) !== 0) drawn += 1;
    if (i % 4 === 3 && (gpu.out[i] === 0) !== (software.out[i] === 0)) coverage += 1;
    const delta = Math.abs(gpu.out[i]! - software.out[i]!);
    if (delta > 0) {
      differing += 1;
      maxDelta = Math.max(maxDelta, delta);
    }
  }
  const stats = renderer.lastFrameStats;
  renderer.dispose();
  return { drawn, differing, maxDelta, coverage, stats, backend: renderer.backend, diffs };
}

/** The rasteriser the page's WebGL2 runs on (unmasked where the browser allows). */
function glRenderer(): string {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl) return "none";
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
}

/**
 * Render a scene once, then only settle (never submitting again) until the
 * renderer says the newest frame is shown — the scene viewport's loop — and
 * compare that frame with the software rasteriser's.
 */
async function settleOnce(name: string): Promise<{ states: string[]; differing: number; drawn: number } | { error: string }> {
  const scene = scenes()[name];
  if (!scene) return { error: `no scene ${name}` };
  const renderer = WebglSceneRenderer.create(W, H);
  if (!renderer) return { error: "WebGL2 renderer did not build" };
  const gpu = scene.draw();
  renderer.render(scene.instances, gpu);
  const states: string[] = [];
  for (let i = 0; i < 200; i += 1) {
    const state = renderer.settle(gpu);
    if (states.at(-1) !== state) states.push(state);
    if (state === "current") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const software = scene.draw();
  new SoftwareSceneRenderer().render(scene.instances, software);
  let differing = 0;
  let drawn = 0;
  for (let i = 0; i < W * H * 4; i += 1) {
    if (gpu.out[i] !== software.out[i]) differing += 1;
    if (i % 4 === 3 && software.out[i] !== 0) drawn += 1;
  }
  renderer.dispose();
  return { states, differing, drawn };
}

(globalThis as unknown as { settleOnce: typeof settleOnce }).settleOnce = settleOnce;
(globalThis as unknown as { runParity: typeof run; glRenderer: typeof glRenderer }).runParity = run;
(globalThis as unknown as { glRenderer: typeof glRenderer }).glRenderer = glRenderer;
