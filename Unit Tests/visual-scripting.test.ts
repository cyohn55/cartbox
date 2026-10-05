/**
 * Visual scripting (ENGINE_PARITY_ROADMAP.md EP16): node graphs that compile
 * to a component's Lua. Covers reading graphs defensively, which pins join,
 * the compiler (events, flow, variables, actions, a chain that loops back),
 * a compiled graph running as a component in the real engine, the editor's
 * graph steps and the sidecar (a graph's code is always recompiled), and
 * Lockout's Pickup being a graph.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  LOCKOUT_COMPONENTS,
  compileScriptGraph,
  componentFields,
  parseComponentDefs,
  parseScriptGraph,
  pinsConnect,
  serializeMeshAsset,
  type MeshAsset,
  type ScriptGraph,
  type ScriptNode,
  type ScriptWire,
} from "@cartbox/editor";
import { codeChunks, componentsSdkLua, injectSdk, parseMeshScene, sceneObjectsSdkLua } from "@cartbox/player";
import { appendLuaCode, prependLuaCode } from "../packages/player/src/cartseed";
import { addMesh, decodeMeshSidecar, emptyMeshSidecar, encodeMeshSidecar } from "../apps/web/src/lib/meshSidecar";
import { addVisualScript, setComponentGraph, updateComponent } from "../apps/web/src/lib/componentEdit";
import { addScriptNode, addScriptVariable, connectScriptPins, disconnectScriptInput, removeScriptNode, updateScriptVariable } from "../apps/web/src/lib/scriptGraphEdit";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

const n = (id: string, kind: ScriptNode["kind"], y = 0, extra: Partial<ScriptNode> = {}): ScriptNode => ({ id, kind, x: 0, y, ...extra });
const w = (from: string, fromPin: string, to: string, toPin: string): ScriptWire => ({ from, fromPin, to, toPin });

/**
 * A counter: on start count = 10 and sum = 1+2+3+4 (a loop); every tick
 * count += 1, and once count passes 12 big = true (a branch); every 0.05 s
 * ticks += 1 (a timer); on a collision hits += 1.
 */
const COUNTER: ScriptGraph = {
  variables: [
    { name: "count", type: "number", value: 0 },
    { name: "sum", type: "number", value: 0 },
    { name: "big", type: "bool", value: false },
    { name: "ticks", type: "number", value: 0 },
    { name: "hits", type: "number", value: 0 },
    { name: "label", type: "text", value: "hi there" },
  ],
  nodes: [
    n("start", "onStart", 0),
    n("setCount", "setVar", 0, { param: "count", values: { value: 10 } }),
    n("loop", "loop", 0, { values: { from: 1, to: 4 } }),
    n("sum", "getVar", 0, { param: "sum" }),
    n("plusI", "add", 0),
    n("setSum", "setVar", 0, { param: "sum" }),
    n("tick", "onTick", 100),
    n("count", "getVar", 100, { param: "count" }),
    n("plus1", "add", 100, { values: { b: 1 } }),
    n("setCount2", "setVar", 100, { param: "count" }),
    n("count2", "getVar", 100, { param: "count" }),
    n("gt", "greater", 100, { values: { b: 12 } }),
    n("branch", "branch", 100),
    n("setBig", "setVar", 100, { param: "big", values: { value: true } }),
    n("timer", "onTimer", 200, { param: "0.05" }),
    n("ticks", "getVar", 200, { param: "ticks" }),
    n("plus1b", "add", 200, { values: { b: 1 } }),
    n("setTicks", "setVar", 200, { param: "ticks" }),
    n("hit", "onCollision", 300),
    n("hits", "getVar", 300, { param: "hits" }),
    n("plus1c", "add", 300, { values: { b: 1 } }),
    n("setHits", "setVar", 300, { param: "hits" }),
  ],
  wires: [
    w("start", "then", "setCount", "in"),
    w("setCount", "then", "loop", "in"),
    w("loop", "body", "setSum", "in"),
    w("sum", "value", "plusI", "a"),
    w("loop", "index", "plusI", "b"),
    w("plusI", "out", "setSum", "value"),
    w("tick", "then", "setCount2", "in"),
    w("count", "value", "plus1", "a"),
    w("plus1", "out", "setCount2", "value"),
    w("setCount2", "then", "branch", "in"),
    w("count2", "value", "gt", "a"),
    w("gt", "out", "branch", "condition"),
    w("branch", "true", "setBig", "in"),
    w("timer", "then", "setTicks", "in"),
    w("ticks", "value", "plus1b", "a"),
    w("plus1b", "out", "setTicks", "value"),
    w("hit", "then", "setHits", "in"),
    w("hits", "value", "plus1c", "a"),
    w("plus1c", "out", "setHits", "value"),
  ],
};

describe("script graphs", () => {
  it("join exec to exec and values to inputs that take them", () => {
    expect(pinsConnect("exec", "exec")).toBe(true);
    expect(pinsConnect("exec", "number")).toBe(false);
    expect(pinsConnect("number", "number")).toBe(true);
    expect(pinsConnect("number", "text")).toBe(true);
    expect(pinsConnect("bool", "number")).toBe(false);
    expect(pinsConnect("any", "bool")).toBe(true);
  });

  it("read defensively: known nodes, wires between real pins that fit, one per exec output and data input, valid variables", () => {
    const g = parseScriptGraph({
      nodes: [n("a", "onStart"), n("b", "setVar", 0, { param: "x" }), n("c", "print"), { id: "d", kind: "nope" }, n("e", "number", 0, { values: { value: 3, bogus: 1 } }), n("a", "onTick")],
      wires: [
        w("a", "then", "b", "in"),
        w("a", "then", "c", "in"), // a second wire from the same exec output
        w("e", "out", "b", "value"),
        w("e", "out", "b", "value"), // a second value into the same input
        w("e", "out", "c", "in"), // a value into an exec input
        w("a", "nope", "c", "in"),
        w("d", "out", "c", "message"),
      ],
      variables: [{ name: "x", type: "number", value: 2 }, { name: "x", type: "bool" }, { name: "obj", type: "number" }, { name: "y", type: "bool", value: "no" }],
    })!;
    expect(g.nodes.map((x) => x.id)).toEqual(["a", "b", "c", "e"]);
    expect(g.nodes[3]!.values).toEqual({ value: 3 });
    expect(g.wires).toEqual([w("a", "then", "b", "in"), w("e", "out", "b", "value")]);
    expect(g.variables).toEqual([{ name: "x", type: "number", value: 2 }, { name: "y", type: "bool", value: false }]);
    expect(parseScriptGraph("nope")).toBeNull();
  });

  it("compile to a component: fields from variables, a callback per event, flow as Lua", () => {
    const lua = compileScriptGraph(COUNTER, "Counter");
    expect(componentFields(lua).map((f) => [f.name, f.type, f.default])).toEqual([
      ["count", "number", 0],
      ["sum", "number", 0],
      ["big", "bool", false],
      ["ticks", "number", 0],
      ["hits", "number", 0],
      ["label", "text", "hi there"],
    ]);
    expect(lua).toContain("function start(self)");
    expect(lua).toContain("function update(self, dt)");
    expect(lua).toContain("function collision(self, other, started)");
    expect(lua).toMatch(/for i_loop = 1, 4 do\n\s+self.sum = \(self.sum \+ i_loop\)/);
    expect(lua).toMatch(/if \(self.count > 12\) then\n\s+self.big = true\n\s+end/);
  });

  it("stops a chain that loops back on itself rather than compiling forever", () => {
    const loop: ScriptGraph = {
      variables: [],
      nodes: [n("t", "onTick"), n("a", "print"), n("b", "print")],
      wires: [w("t", "then", "a", "in"), w("a", "then", "b", "in"), w("b", "then", "a", "in")],
    };
    const lua = compileScriptGraph(loop);
    expect(lua.match(/trace\(/g)).toHaveLength(2);
  });
});

function cube(): MeshAsset {
  const p = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1].map((v) => v / 2);
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { name: "cube", primitives: [{ positions: Float32Array.from(p), normals: null, uvs: null, indices: Uint32Array.from(idx), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }] };
}

describe.skipIf(!existsSync(ENGINE))("a compiled graph in the real engine", () => {
  it("runs as a component: start, every tick, a branch, a loop and a timer", async () => {
    const mesh = serializeMeshAsset(cube());
    const tf = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const sc = parseMeshScene(JSON.stringify({ version: 2, lighting: null, meshes: [{ id: "a", name: "a", mesh, transform: tf, components: [{ name: "Counter", fields: {} }] }], components: [{ name: "Counter", graph: COUNTER }] }))!;
    const comp = componentsSdkLua(sc)!;
    const code = `
function TIC()
  local c = cartbox.component("a", "Counter")
  pmem(0, c.count) pmem(1, c.sum) pmem(2, c.big and 1 or 0) pmem(3, c.ticks) pmem(4, c.label == "hi there" and 1 or 0)
end`;
    let tic = prependLuaCode(codeChunks(new TextEncoder().encode(code)), comp.prelude);
    tic = appendLuaCode(injectSdk(prependLuaCode(tic, sceneObjectsSdkLua(sc))), comp.postlude);
    const mod = await (await import(pathToFileURL(ENGINE).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    const words = () => Array.from(new Int32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h) - 119 * 4, 5));
    mod._cbx_tick(h, 0);
    expect(words()).toEqual([11, 10, 0, 0, 1]); // start then the first tick
    mod._cbx_tick(h, 0);
    expect(words().slice(0, 3)).toEqual([12, 10, 0]);
    mod._cbx_tick(h, 0);
    expect(words().slice(0, 3)).toEqual([13, 10, 1]); // past 12: the branch set big
    for (let i = 0; i < 9; i += 1) mod._cbx_tick(h, 0);
    expect(words()[3]).toBe(4); // 12 ticks of 1/60 s: the 0.05 s timer fired 4 times
  });
});

describe("editing", () => {
  it("wires pins (replacing a taken one), unwires, renames variables through the nodes, and removes nodes with their wires", () => {
    let g: ScriptGraph = { nodes: [], wires: [], variables: [] };
    const a = addScriptNode(g, "onTick", { x: 0, y: 0 });
    const b = addScriptNode(a.graph, "print", { x: 200, y: 0 });
    const c = addScriptNode(b.graph, "print", { x: 200, y: 100 });
    g = c.graph;
    g = connectScriptPins(g, a.id, "then", b.id, "in")!;
    g = connectScriptPins(g, a.id, "then", c.id, "in")!; // an exec output leads to one place
    expect(g.wires).toEqual([w(a.id, "then", c.id, "in")]);
    expect(connectScriptPins(g, a.id, "dt", c.id, "in")).toBeNull(); // a number into an exec input
    g = connectScriptPins(g, a.id, "dt", c.id, "message")!;
    g = disconnectScriptInput(g, c.id, "message");
    expect(g.wires).toHaveLength(1);
    g = addScriptVariable(g);
    const get = addScriptNode(g, "getVar", { x: 0, y: 200 });
    g = { ...get.graph, nodes: get.graph.nodes.map((x) => (x.id === get.id ? { ...x, param: "value" } : x)) };
    g = updateScriptVariable(g, "value", { name: "score" })!;
    expect(g.nodes.find((x) => x.id === get.id)!.param).toBe("score");
    expect(updateScriptVariable(g, "score", { name: "origin" })).toBeNull();
    g = removeScriptNode(g, c.id);
    expect(g.wires).toEqual([]);
  });

  it("adds visual scripts to the sidecar, keeps their code compiled from the graph, and renames them", () => {
    let sc = addMesh(emptyMeshSidecar(), cube(), "a").sidecar;
    const made = addVisualScript(sc)!;
    expect(made.name).toBe("Script");
    sc = setComponentGraph(made.sidecar, "Script", COUNTER);
    const def = sc.components![0]!;
    expect(def.code).toBe(compileScriptGraph(COUNTER, "Script"));
    // Stored code is never trusted: it's recompiled from the graph.
    const raw = JSON.parse(encodeMeshSidecar(sc)!) as { components: { code: string }[] };
    raw.components[0]!.code = "os.exit()";
    expect(decodeMeshSidecar(JSON.stringify(raw)).components![0]!.code).toBe(def.code);
    expect(parseComponentDefs([{ name: "G", graph: COUNTER }])[0]!.code).toContain("-- G: a visual script");
    const renamed = updateComponent(sc, "Script", { name: "Counter" })!;
    expect(renamed.components![0]!.code).toContain("-- Counter: a visual script");
  });
});

describe("Lockout", () => {
  it("makes Pickup a visual script that asks the cart and places the weapon", () => {
    const pickup = LOCKOUT_COMPONENTS.find((d) => d.name === "Pickup")!;
    expect(pickup.graph).toBeDefined();
    expect(pickup.code).toBe(compileScriptGraph(pickup.graph!, "Pickup"));
    expect(pickup.code).toContain("pickup_ready(self.slot)");
    expect(pickup.code).toContain("cartbox.place(self.obj");
    expect(componentFields(pickup.code).map((f) => f.name)).toEqual(["slot", "spin", "bob", "t"]);
  });
});
