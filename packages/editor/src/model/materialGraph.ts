/**
 * Material graphs (ENGINE_PARITY_ROADMAP.md EP7): a material's surface built
 * from nodes — the surface's inputs (UVs, position, normal, view, time, the
 * material's own colour and texture), maths, noise and fresnel — wired into
 * the PBR inputs (base colour, alpha, emissive, metallic, roughness), as
 * Unity's Shader Graph and Unreal's Material Editor do.
 *
 * One graph runs three ways, and must agree: {@link compileGraph} orders it
 * into straight-line steps, which {@link evaluateGraph} interprets per pixel
 * for the software rasteriser and {@link graphShaderCode} writes as WGSL or
 * GLSL for the GPU renderers (spliced into their fragment shaders, one
 * variant per distinct graph).
 *
 * Wear masks (HALO_INFINITE_STYLE_ROADMAP.md I4) read the relief map's
 * curvature: a "wear" node picks out convex edges (chipped paint, bare metal)
 * or cavities (grime), broken up by whatever is wired into it.
 *
 * Production grade (AAA_FIDELITY_ROADMAP.md F1e):
 * - more outputs: a tangent-space normal, a world-position offset (run in the
 *   vertex stage), a pixel depth offset, refraction and a subsurface colour;
 * - any number of texture samplers: a texture node reads the base map (slot
 *   0) or one of the graph's own images (slots 1..{@link MAX_GRAPH_IMAGES});
 * - material functions: reusable subgraphs, called by a "function" node and
 *   inlined when the graph compiles;
 * - layers: whole sets of outputs blended over the base by masks, in order,
 *   as Unreal's Material Layers blend material attributes;
 * - static switches: a "switch" node picks one of two branches by a named
 *   boolean (the graph's default, or a material instance's), resolved at
 *   compile time, so each setting is its own permutation with its own key.
 *
 * Every value is a vec3; a scalar is the same number in all three
 * components, and a scalar input reads `.x`. That keeps the graph untyped —
 * any output plugs into any input — with no conversions to infer.
 */

/** The surface inputs a material graph can drive. Unwired ones keep the material's own value. */
export type GraphOutput = "baseColor" | "alpha" | "emissive" | "metallic" | "roughness" | "normal" | "worldPositionOffset" | "pixelDepthOffset" | "refraction" | "subsurfaceColor";
export const GRAPH_OUTPUTS: readonly GraphOutput[] = ["baseColor", "alpha", "emissive", "metallic", "roughness", "normal", "worldPositionOffset", "pixelDepthOffset", "refraction", "subsurfaceColor"];
/** The outputs the fragment stage writes; the world-position offset is the vertex stage's (F1e). */
export const FRAGMENT_OUTPUTS: readonly GraphOutput[] = GRAPH_OUTPUTS.filter((o) => o !== "worldPositionOffset");

export type GraphOp =
  // Surface inputs
  | "constant"
  | "uv"
  | "position"
  | "normal"
  | "view"
  | "time"
  | "baseColor"
  | "baseAlpha"
  | "fresnel"
  | "texture"
  | "noise"
  | "curvature"
  | "occlusion"
  | "thickness"
  | "wear"
  // The material's own factors (F1e: what a layer blends over where the base leaves an output unwired)
  | "materialMetallic"
  | "materialRoughness"
  | "materialEmissive"
  // Composition (F1e): a function call and its inputs, and a static switch
  | "function"
  | "functionInput"
  | "switch"
  // Maths
  | "add"
  | "subtract"
  | "multiply"
  | "divide"
  | "min"
  | "max"
  | "power"
  | "mix"
  | "clamp"
  | "saturate"
  | "step"
  | "smoothstep"
  | "oneMinus"
  | "negate"
  | "abs"
  | "fract"
  | "floor"
  | "sin"
  | "cos"
  | "length"
  | "normalize"
  | "dot"
  | "split"
  | "combine";

export interface GraphNode {
  readonly id: string;
  readonly op: GraphOp;
  /** Each input wired to another node's output (by id); absent or null takes the input's default. */
  readonly inputs?: Readonly<Record<string, string | null>>;
  /**
   * constant: `value`; fresnel: `power`; texture: `channel` ("rgb" | "a"); noise: `scale`, `octaves`;
   * wear: `side` ("edge" | "cavity"), `amount`, `sharpness`; split: `component` (0–2).
   */
  readonly params?: Readonly<Record<string, number | string | readonly number[]>>;
  /** Where the node sits on the editor's canvas. */
  readonly x?: number;
  readonly y?: number;
}

export interface MaterialGraph {
  readonly nodes: readonly GraphNode[];
  /** Which node drives each surface input. */
  readonly outputs: Readonly<Partial<Record<GraphOutput, string>>>;
  /** Reusable subgraphs a "function" node calls by name (F1e). */
  readonly functions?: readonly MaterialFunction[];
  /** Sets of outputs blended over the base, in order, each by its mask (F1e). */
  readonly layers?: readonly GraphLayer[];
  /** The static switches' defaults (F1e); a material instance may set its own. */
  readonly switches?: Readonly<Record<string, boolean>>;
}

/** A material function (F1e): a subgraph with up to four inputs ("functionInput" nodes, by index) and one output. */
export interface MaterialFunction {
  readonly name: string;
  readonly nodes: readonly GraphNode[];
  /** The node whose value the call returns. */
  readonly output: string;
  /** The inputs' names, for the editor (in0..in3). */
  readonly inputs?: readonly string[];
}

/** A material layer (F1e): outputs of its own, blended over what is below by its mask (a node's value, 0..1). */
export interface GraphLayer {
  readonly name: string;
  readonly mask: string;
  readonly outputs: Readonly<Partial<Record<GraphOutput, string>>>;
}

/** The most images a graph's texture nodes may sample besides the base map (F1e). */
export const MAX_GRAPH_IMAGES = 8;
/** The most functions, layers and nested calls a graph holds. */
export const MAX_GRAPH_FUNCTIONS = 16;
export const MAX_GRAPH_LAYERS = 4;
const MAX_CALL_DEPTH = 4;

/** A default for an unwired input: a constant, or one of the surface inputs. */
type InputDefault = number | "uv" | "position" | "curvature";

interface NodeDef {
  readonly label: string;
  readonly category: "input" | "maths" | "pattern";
  readonly inputs: readonly (readonly [name: string, fallback: InputDefault])[];
}

/** Every node kind: its label, menu category and inputs (with what an unwired input reads). */
export const GRAPH_NODES: Readonly<Record<GraphOp, NodeDef>> = {
  constant: { label: "Value", category: "input", inputs: [] },
  uv: { label: "UV", category: "input", inputs: [] },
  position: { label: "World position", category: "input", inputs: [] },
  normal: { label: "Normal", category: "input", inputs: [] },
  view: { label: "View direction", category: "input", inputs: [] },
  time: { label: "Time", category: "input", inputs: [] },
  baseColor: { label: "Base colour", category: "input", inputs: [] },
  baseAlpha: { label: "Base alpha", category: "input", inputs: [] },
  fresnel: { label: "Fresnel", category: "pattern", inputs: [] },
  texture: { label: "Texture", category: "pattern", inputs: [["uv", "uv"]] },
  noise: { label: "Noise", category: "pattern", inputs: [["position", "position"]] },
  curvature: { label: "Curvature", category: "input", inputs: [] },
  // Baked from the mesh (I15): ambient occlusion (the occlusion map, 1 = open) and thickness (the relief map, 1 = solid).
  occlusion: { label: "Occlusion", category: "input", inputs: [] },
  thickness: { label: "Thickness", category: "input", inputs: [] },
  wear: { label: "Wear mask", category: "pattern", inputs: [["curvature", "curvature"], ["breakup", 1]] },
  materialMetallic: { label: "Material metallic", category: "input", inputs: [] },
  materialRoughness: { label: "Material roughness", category: "input", inputs: [] },
  materialEmissive: { label: "Material emissive", category: "input", inputs: [] },
  function: { label: "Function", category: "pattern", inputs: [["in0", 0], ["in1", 0], ["in2", 0], ["in3", 0]] },
  functionInput: { label: "Function input", category: "input", inputs: [] },
  switch: { label: "Static switch", category: "maths", inputs: [["on", 1], ["off", 0]] },
  add: { label: "Add", category: "maths", inputs: [["a", 0], ["b", 0]] },
  subtract: { label: "Subtract", category: "maths", inputs: [["a", 0], ["b", 0]] },
  multiply: { label: "Multiply", category: "maths", inputs: [["a", 1], ["b", 1]] },
  divide: { label: "Divide", category: "maths", inputs: [["a", 1], ["b", 1]] },
  min: { label: "Min", category: "maths", inputs: [["a", 0], ["b", 0]] },
  max: { label: "Max", category: "maths", inputs: [["a", 0], ["b", 0]] },
  power: { label: "Power", category: "maths", inputs: [["a", 1], ["b", 1]] },
  mix: { label: "Mix", category: "maths", inputs: [["a", 0], ["b", 1], ["t", 0.5]] },
  clamp: { label: "Clamp", category: "maths", inputs: [["x", 0], ["min", 0], ["max", 1]] },
  saturate: { label: "Saturate", category: "maths", inputs: [["x", 0]] },
  step: { label: "Step", category: "maths", inputs: [["edge", 0.5], ["x", 0]] },
  smoothstep: { label: "Smoothstep", category: "maths", inputs: [["low", 0], ["high", 1], ["x", 0]] },
  oneMinus: { label: "One minus", category: "maths", inputs: [["x", 0]] },
  negate: { label: "Negate", category: "maths", inputs: [["x", 0]] },
  abs: { label: "Absolute", category: "maths", inputs: [["x", 0]] },
  fract: { label: "Fraction", category: "maths", inputs: [["x", 0]] },
  floor: { label: "Floor", category: "maths", inputs: [["x", 0]] },
  sin: { label: "Sine", category: "maths", inputs: [["x", 0]] },
  cos: { label: "Cosine", category: "maths", inputs: [["x", 0]] },
  length: { label: "Length", category: "maths", inputs: [["x", 0]] },
  normalize: { label: "Normalize", category: "maths", inputs: [["x", 0]] },
  dot: { label: "Dot", category: "maths", inputs: [["a", 0], ["b", 0]] },
  split: { label: "Split", category: "maths", inputs: [["x", 0]] },
  combine: { label: "Combine", category: "maths", inputs: [["x", 0], ["y", 0], ["z", 0]] },
};

const OPS = new Set(Object.keys(GRAPH_NODES));
/** The most nodes a graph may hold (a stored graph past this is cut). */
export const MAX_GRAPH_NODES = 64;
const MAX_OCTAVES = 4;

// --- Stored form ----------------------------------------------------------------------------

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clampNum = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * A node's params, complete and in range: a constant's value as three numbers
 * (a lone number is splatted), and every other kind's defaults filled in.
 */
export function graphParams(op: GraphOp, raw: unknown): Record<string, number | string | readonly number[]> {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const params: Record<string, number | string | readonly number[]> = {};
  if (op === "constant") {
    const v = p.value;
    const c = (x: number) => clampNum(x, -1e4, 1e4);
    params.value = Array.isArray(v) && v.length === 3 && v.every(finite) ? (v as number[]).map(c) : finite(v) ? [c(v), c(v), c(v)] : [0, 0, 0];
  }
  if (op === "fresnel") params.power = finite(p.power) ? clampNum(p.power, 0.1, 16) : 5;
  if (op === "texture") {
    params.channel = p.channel === "a" ? "a" : "rgb";
    // Which map (F1e): 0 the base, 1.. the graph's own images.
    params.slot = finite(p.slot) ? Math.round(clampNum(p.slot, 0, MAX_GRAPH_IMAGES)) : 0;
  }
  if (op === "function") params.name = typeof p.name === "string" ? p.name.slice(0, 64) : "";
  if (op === "functionInput") params.index = finite(p.index) ? Math.round(clampNum(p.index, 0, 3)) : 0;
  if (op === "switch") params.name = typeof p.name === "string" ? p.name.slice(0, 64) : "switch";
  if (op === "noise") {
    params.scale = finite(p.scale) ? clampNum(p.scale, 0.001, 1000) : 1;
    params.octaves = finite(p.octaves) ? Math.round(clampNum(p.octaves, 1, MAX_OCTAVES)) : 1;
  }
  if (op === "wear") {
    params.side = p.side === "cavity" ? "cavity" : "edge";
    params.amount = finite(p.amount) ? clampNum(p.amount, 0, 1) : 0.5;
    params.sharpness = finite(p.sharpness) ? clampNum(p.sharpness, 1, 64) : 8;
  }
  if (op === "split") params.component = finite(p.component) ? Math.round(clampNum(p.component, 0, 2)) : 0;
  return params;
}

/** Read a stored graph, dropping malformed nodes, wires and params; null when nothing usable remains. */
function readNodes(raw: unknown): GraphNode[] {
  const nodes: GraphNode[] = [];
  if (!Array.isArray(raw)) return nodes;
  const ids = new Set<string>();
  for (const item of raw.slice(0, MAX_GRAPH_NODES)) {
    if (!item || typeof item !== "object") continue;
    const n = item as Record<string, unknown>;
    if (typeof n.id !== "string" || n.id === "" || ids.has(n.id) || typeof n.op !== "string" || !OPS.has(n.op)) continue;
    const op = n.op as GraphOp;
    const inputs: Record<string, string | null> = {};
    if (n.inputs && typeof n.inputs === "object") {
      for (const [name] of GRAPH_NODES[op].inputs) {
        const wire = (n.inputs as Record<string, unknown>)[name];
        if (typeof wire === "string") inputs[name] = wire;
      }
    }
    const params = graphParams(op, n.params);
    ids.add(n.id);
    nodes.push({
      id: n.id,
      op,
      ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
      ...(Object.keys(params).length > 0 ? { params } : {}),
      ...(finite(n.x) ? { x: n.x } : {}),
      ...(finite(n.y) ? { y: n.y } : {}),
    });
  }
  return nodes;
}

function readOutputs(raw: unknown, ids: ReadonlySet<string>): Partial<Record<GraphOutput, string>> {
  const outputs: Partial<Record<GraphOutput, string>> = {};
  if (raw && typeof raw === "object") {
    for (const key of GRAPH_OUTPUTS) {
      const id = (raw as Record<string, unknown>)[key];
      if (typeof id === "string" && ids.has(id)) outputs[key] = id;
    }
  }
  return outputs;
}

/** Read a stored graph, dropping malformed nodes, wires and params; null when nothing usable remains. */
export function readMaterialGraph(raw: unknown): MaterialGraph | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { nodes?: unknown; outputs?: unknown; functions?: unknown; layers?: unknown; switches?: unknown };
  if (!Array.isArray(r.nodes)) return null;
  const nodes = readNodes(r.nodes);
  if (nodes.length === 0) return null;
  const ids = new Set(nodes.map((n) => n.id));
  const functions: MaterialFunction[] = [];
  if (Array.isArray(r.functions)) {
    for (const f of r.functions.slice(0, MAX_GRAPH_FUNCTIONS)) {
      if (!f || typeof f !== "object") continue;
      const fn = f as Record<string, unknown>;
      const body = readNodes(fn.nodes);
      if (typeof fn.name !== "string" || fn.name === "" || typeof fn.output !== "string" || !body.some((n) => n.id === fn.output) || functions.some((g) => g.name === fn.name)) continue;
      const inputs = Array.isArray(fn.inputs) ? fn.inputs.filter((x): x is string => typeof x === "string").slice(0, 4) : undefined;
      functions.push({ name: fn.name.slice(0, 64), nodes: body, output: fn.output, ...(inputs ? { inputs } : {}) });
    }
  }
  const layers: GraphLayer[] = [];
  if (Array.isArray(r.layers)) {
    for (const l of r.layers.slice(0, MAX_GRAPH_LAYERS)) {
      if (!l || typeof l !== "object") continue;
      const layer = l as Record<string, unknown>;
      if (typeof layer.mask !== "string" || !ids.has(layer.mask)) continue;
      const outs = readOutputs(layer.outputs, ids);
      if (Object.keys(outs).length === 0) continue;
      layers.push({ name: typeof layer.name === "string" ? layer.name.slice(0, 64) : `layer ${layers.length + 1}`, mask: layer.mask, outputs: outs });
    }
  }
  const switches: Record<string, boolean> = {};
  if (r.switches && typeof r.switches === "object") for (const [k, v] of Object.entries(r.switches)) if (typeof v === "boolean") switches[k.slice(0, 64)] = v;
  return {
    nodes,
    outputs: readOutputs(r.outputs, ids),
    ...(functions.length > 0 ? { functions } : {}),
    ...(layers.length > 0 ? { layers } : {}),
    ...(Object.keys(switches).length > 0 ? { switches } : {}),
  };
}

// --- Composing (F1e) ------------------------------------------------------------------------

/**
 * A graph with its composition resolved, ready to order: each function call
 * inlined (its nodes prefixed by the call's id, its inputs wired to the
 * call's), each static switch replaced by the branch `switches` picks (the
 * graph's defaults, overridden by a material instance's), and each layer's
 * outputs mixed over the outputs below by its mask. A plain graph comes back as it is.
 */
export function flattenGraph(graph: MaterialGraph, switches: Readonly<Record<string, boolean>> = {}): MaterialGraph {
  if (!graph.functions?.length && !graph.layers?.length && !graph.nodes.some((n) => n.op === "switch" || n.op === "function")) return graph;
  const settings = { ...(graph.switches ?? {}), ...switches };
  const functions = new Map((graph.functions ?? []).map((f) => [f.name, f]));
  const nodes: GraphNode[] = [];
  // A node replaced by another's value: the call by its function's output, an input by the call's wire.
  const alias = new Map<string, string | null>();
  const add = (list: readonly GraphNode[], prefix: string, args: readonly (string | null)[], depth: number) => {
    const rename = (id: string | null | undefined) => (id ? `${prefix}${id}` : null);
    for (const node of list) {
      const id = `${prefix}${node.id}`;
      if (node.op === "functionInput") {
        alias.set(id, args[(node.params?.index as number | undefined) ?? 0] ?? null);
        continue;
      }
      if (node.op === "switch") {
        const name = (node.params?.name as string | undefined) ?? "switch";
        alias.set(id, rename(settings[name] === false ? node.inputs?.off : node.inputs?.on));
        continue;
      }
      if (node.op === "function") {
        const fn = functions.get((node.params?.name as string | undefined) ?? "");
        if (!fn || depth >= MAX_CALL_DEPTH) {
          alias.set(id, null);
          continue;
        }
        const callArgs = ["in0", "in1", "in2", "in3"].map((k) => rename(node.inputs?.[k]));
        add(fn.nodes, `${id}/`, callArgs, depth + 1);
        alias.set(id, `${id}/${fn.output}`);
        continue;
      }
      const inputs: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(node.inputs ?? {})) inputs[k] = rename(v);
      nodes.push({ ...node, id, inputs });
    }
  };
  add(graph.nodes, "", [], 0);
  // Follow aliases to a real node (or nothing: the input's default).
  const resolve = (id: string | null | undefined, seen = 0): string | null => {
    if (!id || seen > 64) return null;
    return alias.has(id) ? resolve(alias.get(id), seen + 1) : id;
  };
  const resolved = nodes.map((n) => ({ ...n, inputs: Object.fromEntries(Object.entries(n.inputs ?? {}).map(([k, v]) => [k, resolve(v)])) }));
  const outputs: Partial<Record<GraphOutput, string>> = {};
  for (const key of GRAPH_OUTPUTS) {
    const id = resolve(graph.outputs[key]);
    if (id) outputs[key] = id;
  }
  // Layers: each output a layer sets is mixed over what is below by the layer's mask.
  const below: Record<GraphOutput, GraphOp | null> = {
    baseColor: "baseColor",
    alpha: "baseAlpha",
    emissive: "materialEmissive",
    metallic: "materialMetallic",
    roughness: "materialRoughness",
    normal: null,
    worldPositionOffset: null,
    pixelDepthOffset: null,
    refraction: null,
    subsurfaceColor: null,
  };
  (graph.layers ?? []).forEach((layer, li) => {
    const mask = resolve(layer.mask);
    if (!mask) return;
    for (const key of GRAPH_OUTPUTS) {
      const top = resolve(layer.outputs[key]);
      if (!top) continue;
      let under = outputs[key] ?? null;
      if (!under) {
        const op = below[key];
        const id = `layer${li}.${key}.below`;
        // An output nothing below drives: the material's own value, or (for the new outputs) none.
        resolved.push(op ? { id, op, inputs: {} } : { id, op: "constant", inputs: {}, params: { value: key === "normal" ? [0, 0, 1] : [0, 0, 0] } });
        under = id;
      }
      const id = `layer${li}.${key}`;
      resolved.push({ id, op: "mix", inputs: { a: under, b: top, t: mask } });
      outputs[key] = id;
    }
  });
  return { nodes: resolved, outputs };
}

// --- Compiling ------------------------------------------------------------------------------

/** One straight-line step: an op over earlier steps' results (by index). */
export interface GraphStep {
  readonly op: GraphOp;
  readonly args: readonly number[];
  readonly params: Readonly<Record<string, number | string | readonly number[]>>;
}

export interface CompiledGraph {
  readonly steps: readonly GraphStep[];
  /** The step driving each wired output. */
  readonly outputs: Readonly<Partial<Record<GraphOutput, number>>>;
  /** Identifies the generated code: equal keys compile to the same shader. */
  readonly key: string;
  /** Whether any step reads the material's base texture (or colour), which the GPU must sample first. */
  readonly usesTexture: boolean;
}

/**
 * Order a graph into steps, each after the steps it reads. Only nodes that
 * reach an output are kept; a wire to a missing node, or one that would close
 * a loop, falls back to the input's default. Null when no output is wired.
 */
export function compileGraph(source: MaterialGraph | null | undefined, options: { readonly switches?: Readonly<Record<string, boolean>>; readonly only?: readonly GraphOutput[] } = {}): CompiledGraph | null {
  if (!source) return null;
  // Functions, switches and layers resolved first (F1e).
  const graph = flattenGraph(source, options.switches);
  const wanted = options.only ?? GRAPH_OUTPUTS;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const steps: GraphStep[] = [];
  const done = new Map<string, number>();
  const visiting = new Set<string>();
  const defaults = new Map<string, number>();
  const fallback = (value: InputDefault): number => {
    const key = String(value);
    let index = defaults.get(key);
    if (index === undefined) {
      index = steps.length;
      steps.push(typeof value === "number" ? { op: "constant", args: [], params: { value: [value, value, value] } } : { op: value, args: [], params: {} });
      defaults.set(key, index);
    }
    return index;
  };
  const visit = (id: string): number | null => {
    const known = done.get(id);
    if (known !== undefined) return known;
    const node = byId.get(id);
    if (!node || visiting.has(id)) return null;
    visiting.add(id);
    const args = GRAPH_NODES[node.op].inputs.map(([name, value]) => {
      const wire = node.inputs?.[name];
      return (wire ? visit(wire) : null) ?? fallback(value);
    });
    visiting.delete(id);
    const index = steps.length;
    steps.push({ op: node.op, args, params: graphParams(node.op, node.params) });
    done.set(id, index);
    return index;
  };
  const outputs: Partial<Record<GraphOutput, number>> = {};
  for (const key of wanted) {
    const id = graph.outputs[key];
    if (!id) continue;
    const index = visit(id);
    if (index !== null) outputs[key] = index;
  }
  if (Object.keys(outputs).length === 0) return null;
  const key = JSON.stringify([steps.map((s) => [s.op, s.args, s.params]), outputs]);
  const usesTexture = steps.some((s) => s.op === "texture");
  return { steps, outputs, key, usesTexture };
}

// --- Value noise (bit-identical hashing on the CPU and both GPU languages) -----------------

/** A cell's hash in [0, 1]: integer maths only, so float precision can't move it. */
function cellHash(ix: number, iy: number, iz: number): number {
  let h = (Math.imul(ix | 0, 0x8da6b343) ^ Math.imul(iy | 0, 0xd8163841) ^ Math.imul(iz | 0, 0xcb1ab31f)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967295;
}

/** Smooth 3D value noise in [0, 1], summed over octaves (each twice the frequency, half the weight). */
export function valueNoise(x: number, y: number, z: number, octaves = 1): number {
  let total = 0;
  let weight = 0;
  let amp = 1;
  let f = 1;
  for (let o = 0; o < octaves; o += 1) {
    const px = x * f;
    const py = y * f;
    const pz = z * f;
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const iz = Math.floor(pz);
    const fx = px - ix;
    const fy = py - iy;
    const fz = pz - iz;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const uz = fz * fz * (3 - 2 * fz);
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const n =
      lerp(
        lerp(lerp(cellHash(ix, iy, iz), cellHash(ix + 1, iy, iz), ux), lerp(cellHash(ix, iy + 1, iz), cellHash(ix + 1, iy + 1, iz), ux), uy),
        lerp(lerp(cellHash(ix, iy, iz + 1), cellHash(ix + 1, iy, iz + 1), ux), lerp(cellHash(ix, iy + 1, iz + 1), cellHash(ix + 1, iy + 1, iz + 1), ux), uy),
        uz,
      );
    total += n * amp;
    weight += amp;
    amp *= 0.5;
    f *= 2;
  }
  return total / weight;
}

// --- The CPU interpreter --------------------------------------------------------------------

/** What a graph reads at one pixel. Vectors are world space; `view` points toward the viewer. */
export interface GraphContext {
  u: number;
  v: number;
  px: number;
  py: number;
  pz: number;
  nx: number;
  ny: number;
  nz: number;
  vx: number;
  vy: number;
  vz: number;
  time: number;
  /** The relief map's curvature here, −1 (cavity) .. 1 (convex edge); 0 without one (I4). */
  curv: number;
  /** The occlusion map's ambient occlusion here, 0..1 (1 = open); 1 without one (I15). */
  ao: number;
  /** The relief map's thickness here, 0..1 (1 = solid, as without one) (I15). */
  thick: number;
  /** The material's base colour and alpha (factor × texture), 0–1. */
  br: number;
  bg: number;
  bb: number;
  ba: number;
  /** Sample the material's base texture at glTF UV (u, v): RGBA 0–1 (white when it has none). */
  sample: (u: number, v: number) => readonly [number, number, number, number];
  /** Sample one of the graph's own images (slot 1..; F1e) at glTF UV; white when absent. */
  sampleSlot?: (slot: number, u: number, v: number) => readonly [number, number, number, number];
  /** The material's own metalness, roughness and emissive colour (F1e). */
  metallic?: number;
  roughness?: number;
  emissive?: readonly [number, number, number];
}

/** A compiled graph's per-step results: 3 floats per step. */
export function graphRegisters(graph: CompiledGraph): Float64Array {
  return new Float64Array(graph.steps.length * 3);
}

/** Run a compiled graph for one pixel, leaving every step's vec3 in `regs` (see {@link graphRegisters}). */
export function evaluateGraph(graph: CompiledGraph, ctx: GraphContext, regs: Float64Array): void {
  const steps = graph.steps;
  for (let s = 0; s < steps.length; s += 1) {
    const step = steps[s]!;
    const o = s * 3;
    const a = (step.args[0] ?? 0) * 3;
    const b = (step.args[1] ?? 0) * 3;
    const c = (step.args[2] ?? 0) * 3;
    const each = (f: (x: number, y: number, z: number) => number) => {
      for (let k = 0; k < 3; k += 1) regs[o + k] = f(regs[a + k]!, regs[b + k]!, regs[c + k]!);
    };
    const splat = (value: number) => {
      regs[o] = value;
      regs[o + 1] = value;
      regs[o + 2] = value;
    };
    switch (step.op) {
      case "constant": {
        const value = step.params.value as readonly number[];
        regs[o] = value[0]!;
        regs[o + 1] = value[1]!;
        regs[o + 2] = value[2]!;
        break;
      }
      case "uv":
        regs[o] = ctx.u;
        regs[o + 1] = ctx.v;
        regs[o + 2] = 0;
        break;
      case "position":
        regs[o] = ctx.px;
        regs[o + 1] = ctx.py;
        regs[o + 2] = ctx.pz;
        break;
      case "normal":
        regs[o] = ctx.nx;
        regs[o + 1] = ctx.ny;
        regs[o + 2] = ctx.nz;
        break;
      case "view":
        regs[o] = ctx.vx;
        regs[o + 1] = ctx.vy;
        regs[o + 2] = ctx.vz;
        break;
      case "time":
        splat(ctx.time);
        break;
      case "baseColor":
        regs[o] = ctx.br;
        regs[o + 1] = ctx.bg;
        regs[o + 2] = ctx.bb;
        break;
      case "baseAlpha":
        splat(ctx.ba);
        break;
      case "fresnel": {
        const ndv = Math.min(1, Math.max(0, ctx.nx * ctx.vx + ctx.ny * ctx.vy + ctx.nz * ctx.vz));
        splat(Math.pow(1 - ndv, step.params.power as number));
        break;
      }
      case "materialMetallic":
        splat(ctx.metallic ?? 0);
        break;
      case "materialRoughness":
        splat(ctx.roughness ?? 1);
        break;
      case "materialEmissive":
        regs[o] = ctx.emissive?.[0] ?? 0;
        regs[o + 1] = ctx.emissive?.[1] ?? 0;
        regs[o + 2] = ctx.emissive?.[2] ?? 0;
        break;
      case "function":
      case "functionInput":
      case "switch":
        // Resolved before a graph compiles (flattenGraph); never a step.
        splat(0);
        break;
      case "texture": {
        const slot = (step.params.slot as number | undefined) ?? 0;
        const t = slot > 0 ? (ctx.sampleSlot?.(slot, regs[a]!, regs[a + 1]!) ?? [1, 1, 1, 1]) : ctx.sample(regs[a]!, regs[a + 1]!);
        if (step.params.channel === "a") splat(t[3]);
        else {
          regs[o] = t[0];
          regs[o + 1] = t[1];
          regs[o + 2] = t[2];
        }
        break;
      }
      case "noise": {
        const scale = step.params.scale as number;
        splat(valueNoise(regs[a]! * scale, regs[a + 1]! * scale, regs[a + 2]! * scale, step.params.octaves as number));
        break;
      }
      case "curvature":
        splat(ctx.curv);
        break;
      case "occlusion":
        splat(ctx.ao);
        break;
      case "thickness":
        splat(ctx.thick);
        break;
      case "wear": {
        const sign = step.params.side === "cavity" ? -1 : 1;
        const threshold = 1 - (step.params.amount as number);
        const sharpness = step.params.sharpness as number;
        each((c, breakup) => Math.min(Math.max((sign * c * breakup - threshold) * sharpness, 0), 1));
        break;
      }
      case "add":
        each((x, y) => x + y);
        break;
      case "subtract":
        each((x, y) => x - y);
        break;
      case "multiply":
        each((x, y) => x * y);
        break;
      case "divide":
        each((x, y) => x / y);
        break;
      case "min":
        each((x, y) => Math.min(x, y));
        break;
      case "max":
        each((x, y) => Math.max(x, y));
        break;
      case "power":
        each((x, y) => Math.pow(Math.max(x, 0), y));
        break;
      case "mix":
        each((x, y, t) => x + (y - x) * t);
        break;
      case "clamp":
        each((x, lo, hi) => Math.min(Math.max(x, lo), hi));
        break;
      case "saturate":
        each((x) => Math.min(Math.max(x, 0), 1));
        break;
      case "step":
        each((edge, x) => (x < edge ? 0 : 1));
        break;
      case "smoothstep":
        each((lo, hi, x) => {
          const t = Math.min(Math.max((x - lo) / (hi - lo), 0), 1);
          return t * t * (3 - 2 * t);
        });
        break;
      case "oneMinus":
        each((x) => 1 - x);
        break;
      case "negate":
        each((x) => -x);
        break;
      case "abs":
        each((x) => Math.abs(x));
        break;
      case "fract":
        each((x) => x - Math.floor(x));
        break;
      case "floor":
        each((x) => Math.floor(x));
        break;
      case "sin":
        each((x) => Math.sin(x));
        break;
      case "cos":
        each((x) => Math.cos(x));
        break;
      case "length":
        splat(Math.hypot(regs[a]!, regs[a + 1]!, regs[a + 2]!));
        break;
      case "normalize": {
        const len = Math.hypot(regs[a]!, regs[a + 1]!, regs[a + 2]!) || 1;
        regs[o] = regs[a]! / len;
        regs[o + 1] = regs[a + 1]! / len;
        regs[o + 2] = regs[a + 2]! / len;
        break;
      }
      case "dot":
        splat(regs[a]! * regs[b]! + regs[a + 1]! * regs[b + 1]! + regs[a + 2]! * regs[b + 2]!);
        break;
      case "split":
        splat(regs[a + (step.params.component as number)]!);
        break;
      case "combine":
        regs[o] = regs[a]!;
        regs[o + 1] = regs[b]!;
        regs[o + 2] = regs[c]!;
        break;
    }
  }
}

// --- Shader code ----------------------------------------------------------------------------

/**
 * The names a fragment shader gives the graph's inputs. `sample(uv)` is an
 * expression sampling the base texture at a glTF UV expression, returning a vec4.
 */
export interface GraphShaderInputs {
  readonly uv: string;
  readonly position: string;
  readonly normal: string;
  readonly view: string;
  readonly time: string;
  /** The relief's curvature, a float (I4). */
  readonly curvature: string;
  /** Ambient occlusion and thickness, floats 0..1 (I15). */
  readonly occlusion: string;
  readonly thickness: string;
  readonly baseColor: string;
  readonly baseAlpha: string;
  readonly sample: (uv: string) => string;
  /** One of the graph's own images (slot 1..; F1e) at a glTF UV expression, a vec4; absent reads white. */
  readonly sampleSlot?: (slot: number, uv: string) => string;
  /** The material's own metalness, roughness (floats) and emissive colour (a vec3); absent read 0, 1 and black (F1e). */
  readonly metallic?: string;
  readonly roughness?: string;
  readonly emissive?: string;
}

const num = (v: number): string => {
  const s = String(Math.fround(v));
  return /[.eE]/.test(s) ? s : `${s}.0`;
};

/** The hash and noise functions a graph's shader code calls (included once per shader that uses noise). */
export function graphNoiseSource(lang: "wgsl" | "glsl"): string {
  if (lang === "wgsl") {
    return `fn gHash(c: vec3<i32>) -> f32 {
  let q = bitcast<vec3<u32>>(c);
  var h = (q.x * 0x8da6b343u) ^ (q.y * 0xd8163841u) ^ (q.z * 0xcb1ab31fu);
  h = (h ^ (h >> 13u)) * 0x5bd1e995u;
  h = h ^ (h >> 15u);
  return f32(h) / 4294967295.0;
}
fn gNoise1(p: vec3<f32>) -> f32 {
  let i = vec3<i32>(floor(p));
  let f = p - floor(p);
  let w = f * f * (vec3<f32>(3.0) - 2.0 * f);
  let x00 = mix(gHash(i), gHash(i + vec3<i32>(1, 0, 0)), w.x);
  let x10 = mix(gHash(i + vec3<i32>(0, 1, 0)), gHash(i + vec3<i32>(1, 1, 0)), w.x);
  let x01 = mix(gHash(i + vec3<i32>(0, 0, 1)), gHash(i + vec3<i32>(1, 0, 1)), w.x);
  let x11 = mix(gHash(i + vec3<i32>(0, 1, 1)), gHash(i + vec3<i32>(1, 1, 1)), w.x);
  return mix(mix(x00, x10, w.y), mix(x01, x11, w.y), w.z);
}
fn gNoise(p: vec3<f32>, octaves: i32) -> f32 {
  var total = 0.0;
  var weight = 0.0;
  var amp = 1.0;
  var f = 1.0;
  for (var o = 0; o < octaves; o = o + 1) {
    total = total + gNoise1(p * f) * amp;
    weight = weight + amp;
    amp = amp * 0.5;
    f = f * 2.0;
  }
  return total / weight;
}
`;
  }
  return `float gHash(ivec3 c) {
  uvec3 q = uvec3(c);
  uint h = (q.x * 0x8da6b343u) ^ (q.y * 0xd8163841u) ^ (q.z * 0xcb1ab31fu);
  h = (h ^ (h >> 13u)) * 0x5bd1e995u;
  h = h ^ (h >> 15u);
  return float(h) / 4294967295.0;
}
float gNoise1(vec3 p) {
  ivec3 i = ivec3(floor(p));
  vec3 f = p - floor(p);
  vec3 w = f * f * (vec3(3.0) - 2.0 * f);
  float x00 = mix(gHash(i), gHash(i + ivec3(1, 0, 0)), w.x);
  float x10 = mix(gHash(i + ivec3(0, 1, 0)), gHash(i + ivec3(1, 1, 0)), w.x);
  float x01 = mix(gHash(i + ivec3(0, 0, 1)), gHash(i + ivec3(1, 0, 1)), w.x);
  float x11 = mix(gHash(i + ivec3(0, 1, 1)), gHash(i + ivec3(1, 1, 1)), w.x);
  return mix(mix(x00, x10, w.y), mix(x01, x11, w.y), w.z);
}
float gNoise(vec3 p, int octaves) {
  float total = 0.0;
  float weight = 0.0;
  float amp = 1.0;
  float f = 1.0;
  for (int o = 0; o < octaves; o++) {
    total += gNoise1(p * f) * amp;
    weight += amp;
    amp *= 0.5;
    f *= 2.0;
  }
  return total / weight;
}
`;
}

/**
 * A compiled graph as shader statements: each step a `g<i>` vec3, in order.
 * The caller assigns the outputs it wants from {@link CompiledGraph.outputs}
 * (as `g<index>`).
 */
export function graphShaderCode(graph: CompiledGraph, lang: "wgsl" | "glsl", inputs: GraphShaderInputs): string {
  const v3 = lang === "wgsl" ? "vec3<f32>" : "vec3";
  const lines: string[] = [];
  graph.steps.forEach((step, i) => {
    const [a, b, c] = step.args.map((n) => `g${n}`) as [string, string, string];
    let e: string;
    switch (step.op) {
      case "constant": {
        const value = step.params.value as readonly number[];
        e = `${v3}(${num(value[0]!)}, ${num(value[1]!)}, ${num(value[2]!)})`;
        break;
      }
      case "uv":
        e = `${v3}(${inputs.uv}, 0.0)`;
        break;
      case "position":
        e = inputs.position;
        break;
      case "normal":
        e = inputs.normal;
        break;
      case "view":
        e = inputs.view;
        break;
      case "time":
        e = `${v3}(${inputs.time})`;
        break;
      case "baseColor":
        e = inputs.baseColor;
        break;
      case "baseAlpha":
        e = `${v3}(${inputs.baseAlpha})`;
        break;
      case "fresnel":
        e = `${v3}(pow(1.0 - clamp(dot(${inputs.normal}, ${inputs.view}), 0.0, 1.0), ${num(step.params.power as number)}))`;
        break;
      case "texture": {
        const slot = (step.params.slot as number | undefined) ?? 0;
        const read = slot > 0 ? (inputs.sampleSlot ? inputs.sampleSlot(slot, `${a}.xy`) : `${lang === "wgsl" ? "vec4<f32>" : "vec4"}(1.0)`) : inputs.sample(`${a}.xy`);
        e = step.params.channel === "a" ? `${v3}(${read}.a)` : `${read}.rgb`;
        break;
      }
      case "materialMetallic":
        e = `${v3}(${inputs.metallic ?? "0.0"})`;
        break;
      case "materialRoughness":
        e = `${v3}(${inputs.roughness ?? "1.0"})`;
        break;
      case "materialEmissive":
        e = inputs.emissive ?? `${v3}(0.0)`;
        break;
      case "function":
      case "functionInput":
      case "switch":
        e = `${v3}(0.0)`;
        break;
      case "noise":
        e = `${v3}(gNoise(${a} * ${num(step.params.scale as number)}, ${step.params.octaves as number}))`;
        break;
      case "curvature":
        e = `${v3}(${inputs.curvature})`;
        break;
      case "occlusion":
        e = `${v3}(${inputs.occlusion})`;
        break;
      case "thickness":
        e = `${v3}(${inputs.thickness})`;
        break;
      case "wear": {
        const sign = step.params.side === "cavity" ? "-" : "";
        e = `clamp((${sign}${a} * ${b} - ${v3}(${num(1 - (step.params.amount as number))})) * ${num(step.params.sharpness as number)}, ${v3}(0.0), ${v3}(1.0))`;
        break;
      }
      case "add":
        e = `${a} + ${b}`;
        break;
      case "subtract":
        e = `${a} - ${b}`;
        break;
      case "multiply":
        e = `${a} * ${b}`;
        break;
      case "divide":
        e = `${a} / ${b}`;
        break;
      case "min":
        e = `min(${a}, ${b})`;
        break;
      case "max":
        e = `max(${a}, ${b})`;
        break;
      case "power":
        e = `pow(max(${a}, ${v3}(0.0)), ${b})`;
        break;
      case "mix":
        e = `mix(${a}, ${b}, ${c})`;
        break;
      case "clamp":
        e = `min(max(${a}, ${b}), ${c})`;
        break;
      case "saturate":
        e = `clamp(${a}, ${v3}(0.0), ${v3}(1.0))`;
        break;
      case "step":
        e = `step(${a}, ${b})`;
        break;
      case "smoothstep":
        e = `smoothstep(${a}, ${b}, ${c})`;
        break;
      case "oneMinus":
        e = `${v3}(1.0) - ${a}`;
        break;
      case "negate":
        e = `-${a}`;
        break;
      case "abs":
        e = `abs(${a})`;
        break;
      case "fract":
        e = `${a} - floor(${a})`;
        break;
      case "floor":
        e = `floor(${a})`;
        break;
      case "sin":
        e = `sin(${a})`;
        break;
      case "cos":
        e = `cos(${a})`;
        break;
      case "length":
        e = `${v3}(length(${a}))`;
        break;
      case "normalize":
        e = `${a} / max(length(${a}), 1e-30)`;
        break;
      case "dot":
        e = `${v3}(dot(${a}, ${b}))`;
        break;
      case "split":
        e = `${v3}(${a}.${"xyz"[step.params.component as number]})`;
        break;
      case "combine":
        e = `${v3}(${a}.x, ${b}.x, ${c}.x)`;
        break;
    }
    lines.push(lang === "wgsl" ? `let g${i} = ${e};` : `vec3 g${i} = ${e};`);
  });
  return lines.join("\n");
}

/** Whether a compiled graph calls the noise functions. */
export function graphUsesNoise(graph: CompiledGraph): boolean {
  return graph.steps.some((s) => s.op === "noise");
}

const compiled = new WeakMap<MaterialGraph, Map<string, CompiledGraph | null>>();
/**
 * A material's compiled graph (cached per graph object and switch setting), or
 * null when it has none that drives anything. `only` compiles the steps some
 * outputs need (the vertex stage's world-position offset, F1e).
 */
export function compiledGraphOf(material: { readonly graph?: MaterialGraph; readonly graphSwitches?: Readonly<Record<string, boolean>> }, only?: readonly GraphOutput[]): CompiledGraph | null {
  const graph = material.graph;
  if (!graph) return null;
  let byKey = compiled.get(graph);
  if (!byKey) compiled.set(graph, (byKey = new Map()));
  const key = JSON.stringify([material.graphSwitches ?? null, only ?? null]);
  let result = byKey.get(key);
  if (result === undefined) {
    result = compileGraph(graph, { ...(material.graphSwitches ? { switches: material.graphSwitches } : {}), ...(only ? { only } : {}) });
    byKey.set(key, result);
  }
  return result;
}
