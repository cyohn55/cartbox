/**
 * Editing material graphs (ENGINE_PARITY_ROADMAP.md EP7): what the node
 * editor does — adding, moving and removing nodes, wiring (never into a loop),
 * driving outputs, the starter graphs, and the preview sphere.
 */

import { describe, expect, it } from "vitest";

import { compileGraph, readMaterialGraph, type MaterialGraph } from "@cartbox/editor";

import { GRAPH_PRESETS, addNode, connect, disconnect, freeSpot, inputPort, moveNode, outputAt, outputPort, removeNode, renderGraphPreview, setOutput, setParams, starterGraph, NODE_HEADER, NODE_ROW, NODE_WIDTH } from "@/lib/materialGraphEdit";

describe("editing", () => {
  it("adds nodes with fresh ids and default params, and moves them", () => {
    let graph = starterGraph();
    const a = addNode(graph, "noise", { x: 10.4, y: 20.6 });
    graph = a.graph;
    const b = addNode(graph, "noise", { x: 0, y: 0 });
    graph = b.graph;
    expect([a.id, b.id]).toEqual(["noise1", "noise2"]);
    expect(graph.nodes.find((n) => n.id === "noise1")).toMatchObject({ x: 10, y: 21, params: { scale: 1, octaves: 1 } });
    expect(moveNode(graph, "noise2", 50, 60).nodes.find((n) => n.id === "noise2")).toMatchObject({ x: 50, y: 60 });
  });

  it("wires an output into an input, replaces a wire, and unwires", () => {
    let graph: MaterialGraph = { nodes: [{ id: "uv", op: "uv" }, { id: "t", op: "time" }, { id: "m", op: "multiply" }], outputs: {} };
    graph = connect(graph, "uv", "m", "a");
    expect(graph.nodes[2]!.inputs).toEqual({ a: "uv" });
    graph = connect(graph, "t", "m", "a");
    expect(graph.nodes[2]!.inputs).toEqual({ a: "t" });
    expect(connect(graph, "t", "m", "nonsense")).toBe(graph);
    expect(connect(graph, "ghost", "m", "b")).toBe(graph);
    expect(disconnect(graph, "m", "a").nodes[2]!.inputs).toEqual({});
  });

  it("refuses a wire that would close a loop", () => {
    let graph: MaterialGraph = { nodes: [{ id: "a", op: "add" }, { id: "b", op: "add" }, { id: "c", op: "add" }], outputs: {} };
    graph = connect(graph, "a", "b", "a");
    graph = connect(graph, "b", "c", "a");
    expect(connect(graph, "c", "a", "a")).toBe(graph); // a → b → c → a
    expect(connect(graph, "a", "a", "b")).toBe(graph); // into itself
    expect(connect(graph, "a", "c", "b")).not.toBe(graph); // a second path is fine
  });

  it("drives outputs, and removing a node takes its wires with it", () => {
    let graph: MaterialGraph = { nodes: [{ id: "uv", op: "uv" }, { id: "s", op: "sin", inputs: { x: "uv" } }], outputs: {} };
    graph = setOutput(graph, "baseColor", "s");
    graph = setOutput(graph, "emissive", "uv");
    expect(graph.outputs).toEqual({ baseColor: "s", emissive: "uv" });
    expect(setOutput(graph, "emissive", null).outputs).toEqual({ baseColor: "s" });
    const gone = removeNode(graph, "uv");
    expect(gone.nodes).toEqual([{ id: "s", op: "sin", inputs: {} }]);
    expect(gone.outputs).toEqual({ baseColor: "s" });
  });

  it("re-normalises params as they're edited", () => {
    const graph = addNode({ nodes: [], outputs: {} }, "noise", { x: 0, y: 0 }).graph;
    expect(setParams(graph, "noise1", { octaves: 99 }).nodes[0]!.params).toEqual({ scale: 1, octaves: 4 });
    const c = addNode(graph, "constant", { x: 0, y: 0 }).graph;
    expect(setParams(c, "constant1", { value: 0.5 }).nodes[1]!.params).toEqual({ value: [0.5, 0.5, 0.5] });
  });

  it("keeps the output node and new nodes clear of the others", () => {
    const graph = GRAPH_PRESETS["Flowing energy"]!.graph();
    const right = Math.max(...graph.nodes.map((n) => (n.x ?? 0) + NODE_WIDTH));
    expect(outputAt(graph).x).toBeGreaterThan(right);
    const spot = freeSpot(graph, { x: 20, y: 20 });
    for (const n of graph.nodes) expect(Math.abs((n.x ?? 0) - spot.x) >= NODE_WIDTH + 16 || Math.abs((n.y ?? 0) - spot.y) >= NODE_HEADER + 5 * NODE_ROW, n.id).toBe(true);
    expect(freeSpot({ nodes: [], outputs: {} }, { x: 20, y: 20 })).toEqual({ x: 20, y: 20 });
  });

  it("lays out ports on the node's edges", () => {
    const node = { id: "n", op: "mix" as const, x: 100, y: 50 };
    expect(outputPort(node)).toEqual({ x: 100 + NODE_WIDTH, y: 50 + NODE_HEADER / 2 });
    expect(inputPort(node, 2)).toEqual({ x: 100, y: 50 + NODE_HEADER + 2 * NODE_ROW + NODE_ROW / 2 });
  });
});

describe("starter graphs", () => {
  it("each compiles, drives something, and survives being stored", () => {
    for (const [name, preset] of Object.entries(GRAPH_PRESETS)) {
      const graph = preset.graph();
      const compiled = compileGraph(graph);
      expect(compiled, name).not.toBeNull();
      // Every wire in a preset points at a real node.
      const ids = new Set(graph.nodes.map((n) => n.id));
      for (const node of graph.nodes) for (const from of Object.values(node.inputs ?? {})) expect(ids.has(from!), `${name}: ${node.id}`).toBe(true);
      expect(compileGraph(readMaterialGraph(JSON.parse(JSON.stringify(graph))))!.key, name).toBe(compiled!.key);
    }
  });
});

describe("preview", () => {
  it("renders the material on a lit sphere over a checker, and the graph changes it", () => {
    const plain = renderGraphPreview({ name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 }, 48, 0);
    const centre = (px: Uint8ClampedArray) => Array.from(px.subarray((24 * 48 + 24) * 4, (24 * 48 + 24) * 4 + 3));
    expect(centre(plain)[0]).toBeGreaterThan(120);
    const red: MaterialGraph = { nodes: [{ id: "c", op: "constant", params: { value: [1, 0, 0] } }], outputs: { baseColor: "c" } };
    const tinted = renderGraphPreview({ name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1, graph: red }, 48, 0);
    const [r, g, b] = centre(tinted);
    expect(r!).toBeGreaterThan(g! + 60);
    expect(r!).toBeGreaterThan(b! + 60);
    // The corner is the checker, not the sphere.
    expect(Array.from(plain.subarray(0, 3))).toEqual([70, 70, 78]);
  });
});
