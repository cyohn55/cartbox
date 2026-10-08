/**
 * Material graphs (ENGINE_PARITY_ROADMAP.md EP7): reading a stored graph,
 * compiling it to ordered steps, interpreting it on the CPU, writing it as
 * WGSL and GLSL, and its effect on what the software rasteriser draws.
 */

import { describe, expect, it } from "vitest";

import {
  GRAPH_NODES,
  compileGraph,
  composeModelMatrix,
  deserializeMeshAsset,
  evaluateGraph,
  graphNoiseSource,
  graphRegisters,
  graphShaderCode,
  projectionMatrix,
  readMaterialGraph,
  renderMeshScene,
  serializeMeshAsset,
  valueNoise,
  viewMatrix,
  type GraphContext,
  type GraphOp,
  type MaterialGraph,
  type MeshAsset,
  type MeshMaterial,
} from "@cartbox/editor";

import { sceneShader } from "../packages/player/src/render/WebgpuSceneRenderer";
import { MARBLE, SCROLL } from "./helpers/graphScenes";

function ctx(over: Partial<GraphContext> = {}): GraphContext {
  return { u: 0.25, v: 0.75, px: 1, py: 2, pz: 3, nx: 0, ny: 0, nz: 1, vx: 0, vy: 0, vz: 1, time: 2, curv: 0, br: 0.5, bg: 0.25, bb: 1, ba: 0.8, sample: () => [0.1, 0.2, 0.3, 0.4], ...over };
}

/** Evaluate one output of a graph at a context. */
function run(graph: MaterialGraph, output: keyof MaterialGraph["outputs"] = "baseColor", c = ctx()): number[] {
  const compiled = compileGraph(graph)!;
  const regs = graphRegisters(compiled);
  evaluateGraph(compiled, c, regs);
  const i = compiled.outputs[output]! * 3;
  return [regs[i]!, regs[i + 1]!, regs[i + 2]!];
}

describe("compiling", () => {
  it("orders steps after their inputs, keeps only what reaches an output, and shares defaults", () => {
    const graph: MaterialGraph = {
      nodes: [
        { id: "out", op: "add", inputs: { a: "x" } }, // b unwired: the 0 default
        { id: "x", op: "multiply", inputs: { a: "uv" } }, // b unwired: the 1 default
        { id: "uv", op: "uv" },
        { id: "orphan", op: "sin" },
      ],
      outputs: { baseColor: "out" },
    };
    const compiled = compileGraph(graph)!;
    expect(compiled.steps.map((s) => s.op)).toEqual(["uv", "constant", "multiply", "constant", "add"]);
    expect(compiled.outputs.baseColor).toBe(4);
    expect(run(graph)).toEqual([0.25, 0.75, 0]);
  });

  it("breaks a loop and ignores a wire to a missing node, falling back to defaults", () => {
    const graph: MaterialGraph = {
      nodes: [
        { id: "a", op: "add", inputs: { a: "b", b: "ghost" } },
        { id: "b", op: "add", inputs: { a: "a" } },
      ],
      outputs: { alpha: "a" },
    };
    expect(run(graph, "alpha")).toEqual([0, 0, 0]);
  });

  it("is null with no output wired, and keys equal graphs equally", () => {
    expect(compileGraph({ nodes: [{ id: "t", op: "time" }], outputs: {} })).toBeNull();
    expect(compileGraph(MARBLE)!.key).toBe(compileGraph(JSON.parse(JSON.stringify(MARBLE)))!.key);
    expect(compileGraph(MARBLE)!.key).not.toBe(compileGraph(SCROLL)!.key);
  });
});

describe("interpreting", () => {
  const unary = (op: GraphOp, value: number, params?: Record<string, number | string>) =>
    run({ nodes: [{ id: "c", op: "constant", params: { value } }, { id: "n", op, inputs: { x: "c" }, ...(params ? { params } : {}) }], outputs: { baseColor: "n" } })[0]!;
  const binary = (op: GraphOp, a: number, b: number) =>
    run({ nodes: [{ id: "a", op: "constant", params: { value: a } }, { id: "b", op: "constant", params: { value: b } }, { id: "n", op, inputs: { a: "a", b: "b" } }], outputs: { baseColor: "n" } })[0]!;

  it("does the maths", () => {
    expect(binary("add", 2, 3)).toBe(5);
    expect(binary("subtract", 2, 3)).toBe(-1);
    expect(binary("multiply", 2, 3)).toBe(6);
    expect(binary("divide", 3, 2)).toBe(1.5);
    expect(binary("min", 2, 3)).toBe(2);
    expect(binary("max", 2, 3)).toBe(3);
    expect(binary("power", 2, 3)).toBe(8);
    expect(binary("power", -2, 0.5)).toBe(0); // a negative base is clamped, as on the GPU
    expect(unary("oneMinus", 0.25)).toBe(0.75);
    expect(unary("negate", 2)).toBe(-2);
    expect(unary("abs", -2)).toBe(2);
    expect(unary("fract", 2.25)).toBe(0.25);
    expect(unary("fract", -0.25)).toBe(0.75);
    expect(unary("floor", -0.5)).toBe(-1);
    expect(unary("saturate", 3)).toBe(1);
    expect(unary("sin", Math.PI / 2)).toBeCloseTo(1);
    expect(unary("length", 1)).toBeCloseTo(Math.sqrt(3));
    expect(unary("normalize", 2)).toBeCloseTo(1 / Math.sqrt(3));
    expect(unary("split", 4, { component: 1 })).toBe(4);
  });

  it("reads the surface: UV, position, normal, view, time, base colour and alpha", () => {
    const one = (op: GraphOp) => run({ nodes: [{ id: "n", op }], outputs: { baseColor: "n" } });
    expect(one("uv")).toEqual([0.25, 0.75, 0]);
    expect(one("position")).toEqual([1, 2, 3]);
    expect(one("normal")).toEqual([0, 0, 1]);
    expect(one("view")).toEqual([0, 0, 1]);
    expect(one("time")).toEqual([2, 2, 2]);
    expect(one("baseColor")).toEqual([0.5, 0.25, 1]);
    expect(one("baseAlpha")).toEqual([0.8, 0.8, 0.8]);
  });

  it("samples the texture at a wired UV, rgb or alpha", () => {
    const seen: number[][] = [];
    const sample = (u: number, v: number) => {
      seen.push([u, v]);
      return [0.1, 0.2, 0.3, 0.4] as const;
    };
    const graph: MaterialGraph = {
      nodes: [
        { id: "uv", op: "uv" },
        { id: "two", op: "constant", params: { value: 2 } },
        { id: "m", op: "multiply", inputs: { a: "uv", b: "two" } },
        { id: "t", op: "texture", inputs: { uv: "m" } },
        { id: "ta", op: "texture", inputs: { uv: "m" }, params: { channel: "a" } },
      ],
      outputs: { baseColor: "t", alpha: "ta" },
    };
    expect(run(graph, "baseColor", ctx({ sample }))).toEqual([0.1, 0.2, 0.3]);
    expect(run(graph, "alpha", ctx({ sample }))).toEqual([0.4, 0.4, 0.4]);
    expect(seen[0]).toEqual([0.5, 1.5]);
  });

  it("shades fresnel brighter at grazing angles, and mixes, steps and smoothsteps", () => {
    const fresnel: MaterialGraph = { nodes: [{ id: "f", op: "fresnel", params: { power: 2 } }], outputs: { emissive: "f" } };
    expect(run(fresnel, "emissive", ctx({ nx: 0, ny: 0, nz: 1 }))[0]).toBe(0);
    expect(run(fresnel, "emissive", ctx({ nx: 1, ny: 0, nz: 0 }))[0]).toBe(1);
    expect(run(fresnel, "emissive", ctx({ nx: Math.SQRT1_2, ny: 0, nz: Math.SQRT1_2 }))[0]).toBeCloseTo((1 - Math.SQRT1_2) ** 2);
    const tri = (op: GraphOp, names: [string, string, string], values: [number, number, number]) =>
      run({ nodes: [...values.map((value, i) => ({ id: `c${i}`, op: "constant" as const, params: { value } })), { id: "n", op, inputs: { [names[0]]: "c0", [names[1]]: "c1", [names[2]]: "c2" } }], outputs: { baseColor: "n" } })[0];
    expect(tri("mix", ["a", "b", "t"], [2, 4, 0.25])).toBe(2.5);
    expect(tri("clamp", ["x", "min", "max"], [5, 0, 2])).toBe(2);
    expect(tri("smoothstep", ["low", "high", "x"], [0, 1, 0.5])).toBe(0.5);
    const step = (edge: number, x: number) =>
      run({ nodes: [{ id: "e", op: "constant", params: { value: edge } }, { id: "x", op: "constant", params: { value: x } }, { id: "n", op: "step", inputs: { edge: "e", x: "x" } }], outputs: { baseColor: "n" } })[0];
    expect(step(0.5, 0.4)).toBe(0);
    expect(step(0.5, 0.5)).toBe(1);
  });

  it("makes smooth, deterministic value noise in 0–1", () => {
    expect(valueNoise(1.3, 2.7, -0.4)).toBe(valueNoise(1.3, 2.7, -0.4));
    expect(Math.abs(valueNoise(1.3, 2.7, -0.4) - valueNoise(1.3001, 2.7, -0.4))).toBeLessThan(0.01);
    let lo = 1;
    let hi = 0;
    for (let i = 0; i < 400; i += 1) {
      const n = valueNoise(i * 0.37, i * 0.11, -i * 0.23, 3);
      lo = Math.min(lo, n);
      hi = Math.max(hi, n);
    }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi - lo).toBeGreaterThan(0.5); // it really varies
  });
});

describe("stored form", () => {
  it("drops unknown ops, bad wires and params, clamps params, and survives a round trip", () => {
    const raw = {
      nodes: [
        { id: "n", op: "noise", inputs: { position: "p", bogus: "x" }, params: { scale: 1e9, octaves: 9 }, x: 10, y: 20 },
        { id: "p", op: "position" },
        { id: "evil", op: "eval" },
        { id: "n", op: "time" }, // a duplicate id
        { id: "c", op: "constant", params: { value: "red" } },
      ],
      outputs: { baseColor: "n", alpha: "missing", nonsense: "c" },
    };
    const graph = readMaterialGraph(raw)!;
    expect(graph.nodes.map((n) => n.id)).toEqual(["n", "p", "c"]);
    expect(graph.nodes[0]).toMatchObject({ inputs: { position: "p" }, params: { scale: 1000, octaves: 4 }, x: 10, y: 20 });
    expect(graph.nodes[2]!.params).toEqual({ value: [0, 0, 0] });
    expect(graph.outputs).toEqual({ baseColor: "n" });
    expect(readMaterialGraph({ nodes: "no" })).toBeNull();

    const mesh: MeshAsset = {
      name: "m",
      primitives: [
        {
          positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          normals: null,
          uvs: null,
          indices: Uint32Array.from([0, 1, 2]),
          material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, graph: MARBLE },
        },
      ],
    };
    const back = deserializeMeshAsset(serializeMeshAsset(mesh)).primitives[0]!.material.graph!;
    expect(compileGraph(back)!.key).toBe(compileGraph(MARBLE)!.key);
  });

  it("lists every node kind with a label and its inputs", () => {
    for (const [op, def] of Object.entries(GRAPH_NODES)) {
      expect(def.label.length, op).toBeGreaterThan(0);
      expect(["input", "maths", "pattern"]).toContain(def.category);
    }
  });
});

describe("shader code", () => {
  it("writes each step as a vec3 in order, in WGSL and GLSL", () => {
    const compiled = compileGraph(SCROLL)!;
    const inputs = { uv: "UV", position: "P", normal: "N", view: "V", time: "T", baseColor: "B", baseAlpha: "A", sample: (p: string) => `S(${p})` };
    const wgsl = graphShaderCode(compiled, "wgsl", inputs);
    const glsl = graphShaderCode(compiled, "glsl", inputs);
    expect(wgsl.split("\n")).toHaveLength(compiled.steps.length);
    expect(wgsl).toContain("let g0 = vec3<f32>(UV, 0.0);");
    expect(glsl).toContain("vec3 g0 = vec3(UV, 0.0);");
    expect(wgsl).toMatch(/S\(g\d+\.xy\)\.rgb/);
    expect(glsl).toMatch(/vec3\(S\(g\d+\.xy\)\.a\)/);
    expect(graphNoiseSource("wgsl")).toContain("fn gNoise(");
    expect(graphNoiseSource("glsl")).toContain("float gNoise(");
  });

  it("splices a graph into the scene shader only where one is used", () => {
    expect(sceneShader()).not.toContain("gMetal");
    const marble = sceneShader(compileGraph(MARBLE));
    expect(marble).toContain("gMetal = clamp(");
    expect(marble).toContain("if (gEmis.x >= 0.0) { emis = gEmis; }");
    // The noise functions are in every scene shader (refraction's warp uses them, I5), once.
    for (const code of [sceneShader(), marble, sceneShader(compileGraph(SCROLL))]) expect(code.split("fn gNoise(").length).toBe(2);
  });
});

describe("in the software rasteriser", () => {
  const SIZE = 24;
  function draw(material: Partial<MeshMaterial>) {
    const mesh: MeshAsset = {
      name: "q",
      primitives: [
        {
          positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
          normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
          uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
          indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
          material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, ...material },
        },
      ],
    };
    const out = new Uint8ClampedArray(SIZE * SIZE * 4);
    renderMeshScene([{ mesh, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }], {
      width: SIZE,
      height: SIZE,
      out,
      depth: new Float32Array(SIZE * SIZE),
      view: viewMatrix([0, 0, 3], [0, 0, 0]),
      projection: projectionMatrix((50 * Math.PI) / 180, 1, 0.1, 100),
      ambient: 1,
      lightDirection: [0, 0, 1],
      background: [0, 0, 0, 255],
    });
    return out;
  }
  const px = (out: Uint8ClampedArray, x: number, y: number) => Array.from(out.subarray((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 4));

  it("drives the base colour from the graph — here the UVs, so it shades across the surface", () => {
    const out = draw({ graph: { nodes: [{ id: "uv", op: "uv" }], outputs: { baseColor: "uv" } } });
    const left = px(out, 6, 12);
    const right = px(out, 18, 12);
    expect(right[0]!).toBeGreaterThan(left[0]! + 80); // U rises left to right
    expect(left[2]).toBeLessThan(10); // blue is 0
  });

  it("drives alpha, cutting a see-through surface's coverage", () => {
    const graph: MaterialGraph = { nodes: [{ id: "uv", op: "uv" }, { id: "u", op: "split", inputs: { x: "uv" } }, { id: "s", op: "step", inputs: { x: "u" } }], outputs: { alpha: "s" } };
    const out = draw({ alphaMode: "blend", graph });
    expect(px(out, 6, 12)).toEqual([0, 0, 0, 255]); // alpha 0: nothing drawn over the black
    expect(px(out, 18, 12)[0]).toBeGreaterThan(200);
  });

  it("glows where the graph drives the emissive, on a material that wasn't PBR before", () => {
    const glow: MaterialGraph = { nodes: [{ id: "c", op: "constant", params: { value: [0, 1, 0] } }], outputs: { emissive: "c", baseColor: "k" } };
    const black = { ...glow, nodes: [...glow.nodes, { id: "k", op: "constant" as const, params: { value: 0 } }] };
    const p = px(draw({ graph: black }), 12, 12);
    expect(p[1]).toBeGreaterThan(200);
    expect(p[0]).toBeLessThan(20);
  });
});
