/**
 * The material graph, production grade (AAA_FIDELITY_ROADMAP.md F1e):
 * functions, layers and static switches resolved as a graph compiles, the new
 * outputs and samplers, their stored form, and, on a real device (Dawn), a
 * world-position offset, a pixel depth offset, a graph's own image, and
 * permutations compiled in the background.
 */

import { describe, expect, it } from "vitest";

import {
  compileGraph,
  compiledGraphOf,
  composeModelMatrix,
  deserializeMaterial,
  evaluateGraph,
  flattenGraph,
  graphRegisters,
  graphShaderCode,
  projectionMatrix,
  readMaterialGraph,
  serializeMaterial,
  viewMatrix,
  type DecodedTexture,
  type GraphContext,
  type GraphOutput,
  type MaterialGraph,
  type MeshAsset,
  type MeshMaterial,
  type MeshSceneInstance,
} from "@cartbox/editor";
import { MODELS, WebgpuSceneRenderer, rasterStyleFor } from "@cartbox/player";

import { sceneShader } from "../packages/player/src/render/WebgpuSceneRenderer";
import { readLinearTexture } from "../packages/player/src/render/lookDevCheck";

function ctx(over: Partial<GraphContext> = {}): GraphContext {
  return { u: 0.25, v: 0.75, px: 1, py: 2, pz: 3, nx: 0, ny: 0, nz: 1, vx: 0, vy: 0, vz: 1, time: 2, curv: 0, ao: 1, thick: 1, br: 0.5, bg: 0.25, bb: 1, ba: 0.8, sample: () => [0.1, 0.2, 0.3, 0.4], ...over };
}
function run(graph: MaterialGraph, output: GraphOutput = "baseColor", c = ctx(), switches?: Record<string, boolean>): number[] {
  const compiled = compileGraph(graph, switches ? { switches } : {})!;
  const regs = graphRegisters(compiled);
  evaluateGraph(compiled, c, regs);
  const i = compiled.outputs[output]! * 3;
  return [regs[i]!, regs[i + 1]!, regs[i + 2]!];
}
const k = (id: string, value: number | number[]) => ({ id, op: "constant" as const, params: { value } });

/** A function that doubles its first input. */
const DOUBLE = { name: "double", output: "m", nodes: [{ id: "x", op: "functionInput" as const, params: { index: 0 } }, k("two", 2), { id: "m", op: "multiply" as const, inputs: { a: "x", b: "two" } }] };

describe("composition", () => {
  it("inlines a function call, its inputs wired to the call's", () => {
    const graph: MaterialGraph = { nodes: [k("three", 3), { id: "f", op: "function", inputs: { in0: "three" }, params: { name: "double" } }], outputs: { baseColor: "f" }, functions: [DOUBLE] };
    expect(run(graph)).toEqual([6, 6, 6]);
    const flat = flattenGraph(graph);
    expect(flat.nodes.some((n) => n.op === "function" || n.op === "functionInput")).toBe(false);
    expect(flat.nodes.map((n) => n.id)).toContain("f/m");
  });

  it("nests calls, and reads a missing function or input as the default", () => {
    const quad = { name: "quad", output: "c", nodes: [{ id: "x", op: "functionInput" as const, params: { index: 0 } }, { id: "a", op: "function" as const, inputs: { in0: "x" }, params: { name: "double" } }, { id: "c", op: "function" as const, inputs: { in0: "a" }, params: { name: "double" } }] };
    const graph: MaterialGraph = { nodes: [k("one", 1), { id: "f", op: "function", inputs: { in0: "one" }, params: { name: "quad" } }], outputs: { baseColor: "f" }, functions: [DOUBLE, quad] };
    expect(run(graph)).toEqual([4, 4, 4]);
    const missing: MaterialGraph = { nodes: [{ id: "f", op: "function", params: { name: "nope" } }, { id: "add", op: "add", inputs: { a: "f" } }], outputs: { baseColor: "add" } };
    expect(run(missing)).toEqual([0, 0, 0]);
  });

  it("resolves static switches by the graph's defaults or a material's, each its own permutation", () => {
    const graph: MaterialGraph = { nodes: [k("red", [1, 0, 0]), k("blue", [0, 0, 1]), { id: "s", op: "switch", inputs: { on: "red", off: "blue" }, params: { name: "wet" } }], outputs: { baseColor: "s" }, switches: { wet: false } };
    expect(run(graph)).toEqual([0, 0, 1]);
    expect(run(graph, "baseColor", ctx(), { wet: true })).toEqual([1, 0, 0]);
    const a = compiledGraphOf({ graph })!;
    const b = compiledGraphOf({ graph, graphSwitches: { wet: true } })!;
    expect(a.key).not.toBe(b.key);
    expect(compiledGraphOf({ graph })).toBe(a);
  });

  it("blends layers over the base by their masks, over the material's own where the base sets nothing", () => {
    const graph: MaterialGraph = {
      nodes: [k("white", 1), k("rust", [0.6, 0.2, 0.1]), k("quarter", 0.25), k("rough", 0.9)],
      outputs: { baseColor: "white" },
      layers: [{ name: "rust", mask: "quarter", outputs: { baseColor: "rust", roughness: "rough" } }],
    };
    run(graph).forEach((v, i) => expect(v).toBeCloseTo([0.9, 0.8, 0.775][i]!, 6));
    // Roughness: the material's own 0.5 under it, a quarter of the way to 0.9.
    expect(run(graph, "roughness", ctx({ roughness: 0.5 }))[0]).toBeCloseTo(0.6, 6);
  });

  it("reads functions, layers and switches back, dropping what is malformed", () => {
    const graph = readMaterialGraph({
      nodes: [k("a", 1), { id: "t", op: "texture", params: { slot: 3, channel: "rgb" } }],
      outputs: { baseColor: "a", worldPositionOffset: "a", pixelDepthOffset: "missing" },
      functions: [DOUBLE, { name: "bad", output: "nowhere", nodes: [] }],
      layers: [{ name: "l", mask: "a", outputs: { baseColor: "t" } }, { name: "x", mask: "missing", outputs: { baseColor: "a" } }],
      switches: { wet: true, broken: "yes" },
    })!;
    expect(graph.functions!.map((f) => f.name)).toEqual(["double"]);
    expect(graph.layers!.map((l) => l.name)).toEqual(["l"]);
    expect(graph.switches).toEqual({ wet: true });
    expect(graph.outputs).toEqual({ baseColor: "a", worldPositionOffset: "a" });
    expect(graph.nodes[1]!.params!.slot).toBe(3);
  });
});

describe("outputs and samplers", () => {
  it("samples the graph's own images by slot", () => {
    const graph: MaterialGraph = { nodes: [{ id: "uv", op: "uv" }, { id: "t", op: "texture", inputs: { uv: "uv" }, params: { slot: 2 } }], outputs: { baseColor: "t" } };
    expect(run(graph, "baseColor", ctx({ sampleSlot: (slot) => [slot / 10, 0.5, 0.25, 1] }))).toEqual([0.2, 0.5, 0.25]);
    expect(run(graph)).toEqual([1, 1, 1]);
    const code = graphShaderCode(compileGraph(graph)!, "wgsl", { uv: "uv", position: "p", normal: "n", view: "v", time: "t", curvature: "c", occlusion: "o", thickness: "h", baseColor: "b", baseAlpha: "a", sample: (p) => `S(${p})`, sampleSlot: (slot, p) => `L${slot}(${p})` });
    expect(code).toContain("L2(");
  });

  it("compiles the world-position offset apart, for the vertex stage", () => {
    const graph: MaterialGraph = { nodes: [k("up", [0, 1, 0]), k("red", [1, 0, 0]), { id: "n", op: "noise" }], outputs: { baseColor: "red", worldPositionOffset: "up", roughness: "n" } };
    const vertex = compiledGraphOf({ graph }, ["worldPositionOffset"])!;
    expect(Object.keys(vertex.outputs)).toEqual(["worldPositionOffset"]);
    expect(vertex.steps.some((s) => s.op === "noise")).toBe(false);
    const shader = sceneShader(compiledGraphOf({ graph }), false, true, vertex);
    expect(shader).toContain("wpoObj = inverse3(m3)");
    const pdo = sceneShader(compileGraph({ nodes: [k("d", 0.5)], outputs: { pixelDepthOffset: "d", subsurfaceColor: "d", refraction: "d" } }), false, true);
    expect(pdo).toContain("@builtin(frag_depth) depth: f32");
    expect(pdo).toContain("sssTint = clamp(");
    expect(pdo).toContain("refractBend = max(");
  });

  it("stores a material's graph images and switch settings", () => {
    const image = { mime: "image/png", bytes: new Uint8Array([1, 2, 3]) };
    const material = { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, graph: { nodes: [k("a", 1)], outputs: { baseColor: "a" } }, graphSwitches: { wet: true }, graphImages: [image, null] } as MeshMaterial;
    const back = deserializeMaterial(JSON.parse(JSON.stringify(serializeMaterial(material))));
    expect(back.graphSwitches).toEqual({ wet: true });
    expect(Array.from(back.graphImages![0]!.bytes)).toEqual([1, 2, 3]);
    expect(back.graphImages![1]).toBeNull();
  });
});

async function realDevice(): Promise<any | null> {
  try {
    const module = (await import(/* @vite-ignore */ "@kmamal/gpu")) as any;
    const instance = (module.default ?? module).create([]);
    const adapter = await instance.requestAdapter();
    return adapter ? await adapter.requestDevice() : null;
  } catch {
    return null;
  }
}
const device = await realDevice();

async function settled<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 4000 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    device.tick?.();
  }
  return promise;
}

const W = 32;
const H = 32;

function quad(name: string, material: Partial<MeshMaterial> = {}): MeshAsset {
  return {
    name,
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name, baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1, ...material },
      },
    ],
  } as unknown as MeshAsset;
}

describe.skipIf(!device)("the graph on a real device", { timeout: 300_000 }, () => {
  const camera = { view: viewMatrix([0, 0, 3], [0, 0, 0]), projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50) };
  const dark = { ambient: 0, lightDirection: [0, 0, -1] };
  let renderer: WebgpuSceneRenderer;
  async function frame(instances: MeshSceneInstance[], draw: Record<string, unknown> = dark): Promise<Float32Array> {
    renderer ??= (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    device.pushErrorScope("validation");
    const texture = renderer.renderToTexture!(instances, { width: W, height: H, ...camera, environment: null, lights: [], ...draw } as any);
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    return (await readLinearTexture(device, texture, W, H, settled)).data;
  }
  const at = (data: Float32Array, x: number, y: number) => [0, 1, 2, 3].map((c) => data[(y * W + x) * 4 + c]!);
  const glowing = (graph: MaterialGraph, extra: Partial<MeshMaterial> = {}) => quad("g", { baseColorFactor: [0, 0, 0, 1], emissiveFactor: [1, 1, 1], graph, ...extra });

  it("moves vertices by the world-position offset", async () => {
    const plain = await frame([{ mesh: glowing({ nodes: [k("e", [1, 1, 1])], outputs: { emissive: "e" } }), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }] as unknown as MeshSceneInstance[]);
    // A metre toward the eye: the quad fills more of the frame.
    const moved = await frame([{ mesh: glowing({ nodes: [k("e", [1, 1, 1]), k("o", [0, 0, 1])], outputs: { emissive: "e", worldPositionOffset: "o" } }), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }] as unknown as MeshSceneInstance[]);
    const x = Math.round(W / 2 + 0.72 * (W / 2));
    expect(at(plain, x, H / 2)[3]).toBe(0);
    expect(at(moved, x, H / 2)[3]).toBe(1);
  });

  it("pushes a surface's depth back by the pixel depth offset", async () => {
    const back = { mesh: quad("back", { baseColorFactor: [0, 0, 0, 1], emissiveFactor: [0, 1, 0] }), model: composeModelMatrix([0, 0, -1], [0, 0, 0], [1, 1, 1]) };
    const front = (graph: MaterialGraph) => ({ mesh: glowing(graph), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) });
    const red: MaterialGraph = { nodes: [k("e", [1, 0, 0])], outputs: { emissive: "e" } };
    const ahead = await frame([back, front(red)] as unknown as MeshSceneInstance[], { ...dark, prepass: true, ambientOcclusion: false });
    expect(at(ahead, W / 2, H / 2)[0]!).toBeGreaterThan(0.5);
    // Two metres back: behind the green plane.
    const pushed = await frame([back, front({ nodes: [k("e", [1, 0, 0]), k("d", 2)], outputs: { emissive: "e", pixelDepthOffset: "d" } })] as unknown as MeshSceneInstance[], { ...dark, prepass: true, ambientOcclusion: false });
    expect(at(pushed, W / 2, H / 2)[1]!).toBeGreaterThan(0.5);
    expect(at(pushed, W / 2, H / 2)[0]!).toBeLessThan(0.1);
  });

  it("samples a graph's own image", async () => {
    const image: DecodedTexture = { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(255).map((v, i) => (i % 4 === 1 ? 0 : v)) } as DecodedTexture;
    const graph: MaterialGraph = { nodes: [{ id: "uv", op: "uv" }, { id: "t", op: "texture", inputs: { uv: "uv" }, params: { slot: 1 } }], outputs: { emissive: "t" } };
    const shot = await frame([{ mesh: glowing(graph), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]), graphTextures: [[image]] }] as unknown as MeshSceneInstance[]);
    const c = at(shot, W / 2, H / 2);
    // Magenta: the image's colour, emitted.
    expect(c[0]!).toBeGreaterThan(0.9);
    expect(c[1]!).toBeLessThan(0.05);
    expect(c[2]!).toBeGreaterThan(0.9);
  });

  it("draws a permutation still compiling as the plain material, then as its graph", async () => {
    const material = { name: "p", baseColorFactor: [0, 0, 0, 1], baseColorImage: null, emissiveFactor: [0, 0, 1], graph: { nodes: [k("e", [1, 0, 0]), k("salt", 0.123)], outputs: { emissive: "e", metallic: "salt" } } } as MeshMaterial;
    const mesh = { name: "p", primitives: [{ ...quad("p").primitives[0]!, material }] } as unknown as MeshAsset;
    renderer ??= (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    const ready = renderer.prepareMaterials([material]);
    const early = at(await frame([{ mesh, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }] as unknown as MeshSceneInstance[]), W / 2, H / 2);
    await settled(ready);
    const late = at(await frame([{ mesh, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }] as unknown as MeshSceneInstance[]), W / 2, H / 2);
    // The plain material emits its own blue; the graph's red once compiled.
    expect(early[2]!).toBeGreaterThan(0.5);
    expect(late[0]!).toBeGreaterThan(0.5);
    expect(late[2]!).toBeLessThan(0.1);
  });
});
