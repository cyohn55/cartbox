/**
 * Editing a material graph (ENGINE_PARITY_ROADMAP.md EP7), as the node editor
 * does it: adding, moving and removing nodes, wiring an output into an input
 * (refusing a wire that would close a loop), driving the material's outputs,
 * starter graphs, and a lit preview sphere. Pure: every edit returns a new graph.
 */

import {
  GRAPH_NODES,
  composeModelMatrix,
  graphParams,
  projectionMatrix,
  renderMeshScene,
  viewMatrix,
  type GraphNode,
  type GraphOp,
  type GraphOutput,
  type MaterialGraph,
  type MeshAsset,
  type MeshMaterial,
} from "@cartbox/editor";

/** Layout shared by the editor's canvas and its wires: a node's width, header and row heights. */
export const NODE_WIDTH = 156;
export const NODE_HEADER = 26;
export const NODE_ROW = 22;
/** The tallest a node gets (its header, inputs and param rows), for keeping new nodes clear of others. */
const NODE_TALL = NODE_HEADER + 5 * NODE_ROW;

/** Where the output node sits on the canvas: clear of every node, to their right. */
export function outputAt(graph: MaterialGraph): { x: number; y: number } {
  const right = graph.nodes.reduce((max, n) => Math.max(max, (n.x ?? 0) + NODE_WIDTH), 0);
  return { x: Math.max(420, right + 80), y: 30 };
}

/**
 * A spot near `want` where a new node overlaps none already there: stepping
 * down, then across, until it's clear.
 */
export function freeSpot(graph: MaterialGraph, want: { x: number; y: number }): { x: number; y: number } {
  const out = outputAt(graph);
  const overlaps = (x: number, y: number) =>
    graph.nodes.some((n) => Math.abs((n.x ?? 0) - x) < NODE_WIDTH + 16 && Math.abs((n.y ?? 0) - y) < NODE_TALL) ||
    (Math.abs(out.x - x) < NODE_WIDTH + 16 && Math.abs(out.y - y) < NODE_TALL + 40);
  for (let col = 0; col < 8; col += 1) {
    for (let row = 0; row < 12; row += 1) {
      const x = want.x + col * (NODE_WIDTH + 24);
      const y = want.y + row * 40;
      if (!overlaps(x, y)) return { x, y };
    }
  }
  return want;
}

/** Where a node's output port is, and its `i`th input port (canvas coordinates). */
export function outputPort(node: GraphNode): { x: number; y: number } {
  return { x: (node.x ?? 0) + NODE_WIDTH, y: (node.y ?? 0) + NODE_HEADER / 2 };
}
export function inputPort(node: GraphNode, i: number): { x: number; y: number } {
  return { x: node.x ?? 0, y: (node.y ?? 0) + NODE_HEADER + i * NODE_ROW + NODE_ROW / 2 };
}
/** The output node's port for each material output, with the output node at `at`. */
export function materialPort(output: GraphOutput, outputs: readonly GraphOutput[], at: { x: number; y: number }): { x: number; y: number } {
  return { x: at.x, y: at.y + NODE_HEADER + outputs.indexOf(output) * NODE_ROW + NODE_ROW / 2 };
}

/** A new graph: the material's own base colour, wired through. */
export function starterGraph(): MaterialGraph {
  return { nodes: [{ id: "base", op: "baseColor", x: 40, y: 40 }], outputs: { baseColor: "base" } };
}

/**
 * Edge wear (HALO_INFINITE_STYLE_ROADMAP.md I4) added to a graph (or a new one):
 * whatever drives the base colour now — the material's own colour when nothing
 * does — worn to bright bare metal along the relief's convex edges, broken up
 * by noise so it chips, with grime settled in its cavities. The new nodes sit to
 * the right of the existing ones; the base colour output moves to their result.
 */
export function wornEdgesGraph(graph: MaterialGraph | undefined): MaterialGraph {
  let g = graph ?? starterGraph();
  const right = g.nodes.reduce((x, n) => Math.max(x, (n.x ?? 0) + NODE_WIDTH), 0) + 40;
  const add = (op: GraphOp, x: number, y: number, params: Record<string, number | string | readonly number[]> = {}, inputs: Record<string, string> = {}): string => {
    const placed = addNode(g, op, { x: right + x, y: 40 + y });
    g = placed.graph;
    if (Object.keys(params).length > 0) g = setParams(g, placed.id, params);
    for (const [name, from] of Object.entries(inputs)) g = connect(g, from, placed.id, name);
    return placed.id;
  };
  let paint = g.outputs.baseColor;
  if (!paint) paint = add("baseColor", 0, 0);
  const pos = add("position", 0, 90);
  const noise = add("noise", 190, 90, { scale: 5, octaves: 3 }, { position: pos });
  const lo = add("constant", 190, 190, { value: [-0.4, -0.4, -0.4] });
  const hi = add("constant", 190, 260, { value: [2, 2, 2] });
  const breakup = add("mix", 380, 150, {}, { a: lo, b: hi, t: noise });
  const edge = add("wear", 570, 90, { side: "edge", amount: 0.5, sharpness: 6 }, { breakup });
  const cavity = add("wear", 570, 230, { side: "cavity", amount: 0.55, sharpness: 3 });
  const bare = add("constant", 570, 0, { value: [0.93, 0.95, 0.98] });
  const chipped = add("mix", 760, 40, {}, { a: paint, b: bare, t: edge });
  const clean = add("constant", 570, 340, { value: [1, 1, 1] });
  const grime = add("constant", 570, 410, { value: [0.55, 0.55, 0.55] });
  const dirt = add("mix", 760, 280, {}, { a: clean, b: grime, t: cavity });
  const colour = add("multiply", 950, 150, {}, { a: chipped, b: dirt });
  return setOutput(g, "baseColor", colour);
}

function freshId(graph: MaterialGraph, op: GraphOp): string {
  const ids = new Set(graph.nodes.map((n) => n.id));
  let i = 1;
  while (ids.has(`${op}${i}`)) i += 1;
  return `${op}${i}`;
}

/** Add a node of `op` at a canvas point, with its default params. */
export function addNode(graph: MaterialGraph, op: GraphOp, at: { x: number; y: number }): { graph: MaterialGraph; id: string } {
  const id = freshId(graph, op);
  const params = graphParams(op, {});
  const node: GraphNode = { id, op, x: Math.round(at.x), y: Math.round(at.y), ...(Object.keys(params).length > 0 ? { params } : {}) };
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, id };
}

/** Remove a node and every wire to it. */
export function removeNode(graph: MaterialGraph, id: string): MaterialGraph {
  const nodes = graph.nodes
    .filter((n) => n.id !== id)
    .map((n) => {
      if (!n.inputs || !Object.values(n.inputs).includes(id)) return n;
      const inputs = Object.fromEntries(Object.entries(n.inputs).filter(([, from]) => from !== id));
      return { ...n, inputs };
    });
  const outputs = Object.fromEntries(Object.entries(graph.outputs).filter(([, from]) => from !== id)) as MaterialGraph["outputs"];
  return { nodes, outputs };
}

/** Move a node on the canvas. */
export function moveNode(graph: MaterialGraph, id: string, x: number, y: number): MaterialGraph {
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === id ? { ...n, x: Math.round(x), y: Math.round(y) } : n)) };
}

/** Change some of a node's params (re-normalised, so a bad value can't stick). */
export function setParams(graph: MaterialGraph, id: string, change: Record<string, number | string | readonly number[]>): MaterialGraph {
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === id ? { ...n, params: graphParams(n.op, { ...n.params, ...change }) } : n)) };
}

/** Whether `node` reads `target`, directly or through other nodes. */
function dependsOn(graph: MaterialGraph, node: string, target: string): boolean {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack = [node];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const from of Object.values(byId.get(id)?.inputs ?? {})) if (from) stack.push(from);
  }
  return false;
}

/**
 * Wire `from`'s output into `to`'s input `name`, replacing what was there.
 * A wire that would close a loop (or an unknown input) leaves the graph as it was.
 */
export function connect(graph: MaterialGraph, from: string, to: string, name: string): MaterialGraph {
  const target = graph.nodes.find((n) => n.id === to);
  if (!target || !graph.nodes.some((n) => n.id === from)) return graph;
  if (!GRAPH_NODES[target.op].inputs.some(([input]) => input === name)) return graph;
  if (dependsOn(graph, from, to)) return graph;
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === to ? { ...n, inputs: { ...n.inputs, [name]: from } } : n)) };
}

/** Unwire `to`'s input `name` (it takes its default again). */
export function disconnect(graph: MaterialGraph, to: string, name: string): MaterialGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === to && n.inputs?.[name] ? { ...n, inputs: Object.fromEntries(Object.entries(n.inputs).filter(([k]) => k !== name)) } : n)),
  };
}

/** Drive a material output from a node, or (null) give it back to the material. */
export function setOutput(graph: MaterialGraph, output: GraphOutput, from: string | null): MaterialGraph {
  const outputs = { ...graph.outputs };
  if (from && graph.nodes.some((n) => n.id === from)) outputs[output] = from;
  else delete outputs[output];
  return { ...graph, outputs };
}

/** Starter graphs, each a complete look to adapt. */
export const GRAPH_PRESETS: Readonly<Record<string, { readonly hint: string; readonly graph: () => MaterialGraph }>> = {
  "Worn edges": {
    hint: "Paint chipped to bare metal on the relief's edges, grime in its cavities (needs a relief map)",
    graph: (): MaterialGraph => wornEdgesGraph(undefined),
  },
  "Flowing energy": {
    hint: "Bands of light running across the surface over time",
    graph: (): MaterialGraph => ({
      nodes: [
        { id: "pos", op: "position", x: 20, y: 20 },
        { id: "axis", op: "constant", params: { value: [3, 0, 3] }, x: 20, y: 100 },
        { id: "along", op: "dot", inputs: { a: "pos", b: "axis" }, x: 210, y: 40 },
        { id: "time", op: "time", x: 20, y: 190 },
        { id: "speed", op: "constant", params: { value: 4 }, x: 20, y: 250 },
        { id: "shift", op: "multiply", inputs: { a: "time", b: "speed" }, x: 210, y: 170 },
        { id: "phase", op: "subtract", inputs: { a: "along", b: "shift" }, x: 400, y: 80 },
        { id: "wave", op: "sin", inputs: { x: "phase" }, x: 400, y: 170 },
        { id: "lo", op: "constant", params: { value: 0.65 }, x: 210, y: 270 },
        { id: "hi", op: "constant", params: { value: 1 }, x: 210, y: 340 },
        { id: "k", op: "mix", inputs: { a: "lo", b: "hi", t: "wave" }, x: 400, y: 260 },
        { id: "colour", op: "constant", params: { value: [0.5, 1.7, 1.9] }, x: 210, y: 420 },
        { id: "glow", op: "multiply", inputs: { a: "colour", b: "k" }, x: 420, y: 400 },
      ],
      outputs: { emissive: "glow" },
    }),
  },
  Marble: {
    hint: "Two colours swirled by layered noise",
    graph: (): MaterialGraph => ({
      nodes: [
        { id: "pos", op: "position", x: 20, y: 20 },
        { id: "n", op: "noise", inputs: { position: "pos" }, params: { scale: 2.5, octaves: 3 }, x: 210, y: 20 },
        { id: "a", op: "constant", params: { value: [0.88, 0.85, 0.8] }, x: 210, y: 140 },
        { id: "b", op: "constant", params: { value: [0.25, 0.27, 0.35] }, x: 210, y: 230 },
        { id: "col", op: "mix", inputs: { a: "a", b: "b", t: "n" }, x: 410, y: 80 },
        { id: "rough", op: "constant", params: { value: 0.25 }, x: 410, y: 220 },
      ],
      outputs: { baseColor: "col", roughness: "rough" },
    }),
  },
  "Fresnel glow": {
    hint: "Edges light up where the surface turns away from you",
    graph: (): MaterialGraph => ({
      nodes: [
        { id: "base", op: "baseColor", x: 20, y: 20 },
        { id: "f", op: "fresnel", params: { power: 3 }, x: 20, y: 110 },
        { id: "tint", op: "constant", params: { value: [0.3, 0.7, 1.4] }, x: 20, y: 200 },
        { id: "glow", op: "multiply", inputs: { a: "f", b: "tint" }, x: 230, y: 140 },
      ],
      outputs: { baseColor: "base", emissive: "glow" },
    }),
  },
  Dissolve: {
    hint: "Noise eats the surface away as time passes (set it see-through or cut out)",
    graph: (): MaterialGraph => ({
      nodes: [
        { id: "pos", op: "position", x: 20, y: 20 },
        { id: "n", op: "noise", inputs: { position: "pos" }, params: { scale: 3, octaves: 2 }, x: 210, y: 20 },
        { id: "time", op: "time", x: 20, y: 140 },
        { id: "s", op: "sin", inputs: { x: "time" }, x: 210, y: 140 },
        { id: "half", op: "constant", params: { value: 0.5 }, x: 20, y: 220 },
        { id: "zero", op: "constant", params: { value: 0 }, x: 210, y: 240 },
        { id: "edge", op: "mix", inputs: { a: "half", b: "zero", t: "s" }, x: 400, y: 140 },
        { id: "keep", op: "step", inputs: { edge: "edge", x: "n" }, x: 400, y: 30 },
        { id: "base", op: "baseColor", x: 400, y: 260 },
      ],
      outputs: { alpha: "keep", baseColor: "base" },
    }),
  },
  "Scrolling texture": {
    hint: "The material's texture, tiled and sliding across the surface",
    graph: (): MaterialGraph => ({
      nodes: [
        { id: "uv", op: "uv", x: 20, y: 20 },
        { id: "tile", op: "constant", params: { value: 2 }, x: 20, y: 90 },
        { id: "tiled", op: "multiply", inputs: { a: "uv", b: "tile" }, x: 210, y: 30 },
        { id: "time", op: "time", x: 20, y: 170 },
        { id: "speed", op: "constant", params: { value: [0.2, 0, 0] }, x: 20, y: 240 },
        { id: "shift", op: "multiply", inputs: { a: "time", b: "speed" }, x: 210, y: 170 },
        { id: "pan", op: "add", inputs: { a: "tiled", b: "shift" }, x: 400, y: 90 },
        { id: "tex", op: "texture", inputs: { uv: "pan" }, x: 590, y: 280 },
      ],
      outputs: { baseColor: "tex" },
    }),
  },
};

let sphere: MeshAsset | null = null;
/** A smooth unit sphere for the preview (built once). */
function previewSphere(): MeshAsset {
  if (sphere) return sphere;
  const segments = 32;
  const rings = 20;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let r = 0; r <= rings; r += 1) {
    const v = (r / rings) * Math.PI;
    for (let s = 0; s <= segments; s += 1) {
      const u = (s / segments) * Math.PI * 2;
      positions.push(Math.sin(v) * Math.cos(u), Math.cos(v), Math.sin(v) * Math.sin(u));
      uvs.push(s / segments, r / rings);
    }
  }
  for (let r = 0; r < rings; r += 1) {
    for (let s = 0; s < segments; s += 1) {
      const a = r * (segments + 1) + s;
      indices.push(a, a + segments + 1, a + 1, a + 1, a + segments + 1, a + segments + 2);
    }
  }
  sphere = {
    name: "preview",
    primitives: [
      {
        positions: Float32Array.from(positions),
        normals: Float32Array.from(positions),
        uvs: Float32Array.from(uvs),
        indices: Uint32Array.from(indices),
        material: { name: "preview", baseColorFactor: [1, 1, 1, 1], baseColorImage: null },
      },
    ],
  };
  return sphere;
}

/** Render a material (graph and all) on a lit sphere over a checker, `size`² RGBA. */
export function renderGraphPreview(material: MeshMaterial, size: number, time: number): Uint8ClampedArray {
  const base = previewSphere();
  const mesh: MeshAsset = { ...base, primitives: [{ ...base.primitives[0]!, material: { ...material, baseColorImage: null } }] };
  const out = new Uint8ClampedArray(size * size * 4);
  // A checker behind, so see-through and cut-out surfaces read as such.
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const v = ((x >> 3) + (y >> 3)) % 2 === 0 ? 70 : 40;
      out.set([v, v, v + 8, 255], (y * size + x) * 4);
    }
  }
  renderMeshScene([{ mesh, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }], {
    width: size,
    height: size,
    out,
    depth: new Float32Array(size * size),
    view: viewMatrix([0, 0.4, 3.2], [0, 0, 0]),
    projection: projectionMatrix((45 * Math.PI) / 180, 1, 0.1, 20),
    lightDirection: [0.5, 0.7, 0.6],
    ambient: 0.35,
    background: null,
    time,
  });
  return out;
}
