/**
 * Behaviour trees and a blackboard (AAA_PRODUCTION_ROADMAP.md K4): read from
 * the sidecar, run by the cart through cartbox.bt on the Modern core, the same
 * decisions every run, with the running node's path for the debugger.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { behaviourTreesLua, btIds, newBtNode, readBehaviourTrees, replaceBtNode, serializeMeshAsset, type BehaviourTree, type MeshAsset } from "@cartbox/editor";

const TRI: MeshAsset = { name: "t", primitives: [{ positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: null, uvs: null, indices: Uint32Array.from([0, 1, 2]), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }] };
import { parseMeshScene } from "@cartbox/player";
import { createModernCore, type ModernCoreFactory } from "../packages/modern-core/src/index";
import { decodeMeshSidecar, encodeMeshSidecar, emptyMeshSidecar, setMeshBehaviours } from "../apps/web/src/lib/meshSidecar";

/** A guard bot: chase what it sees, else patrol (walk, then wait), with a cooldown on its shout. */
const GUARD: BehaviourTree = {
  name: "guard",
  root: {
    id: "root",
    type: "selector",
    children: [
      {
        id: "chase",
        type: "sequence",
        label: "chase",
        children: [
          { id: "sees", type: "condition", key: "target", op: "truthy" },
          { id: "shout", type: "cooldown", seconds: 1, children: [{ id: "say", type: "action", action: "shout" }] },
          { id: "run", type: "action", action: "moveTo", label: "run at it" },
        ],
      },
      {
        id: "patrol",
        type: "sequence",
        label: "patrol",
        children: [
          { id: "walk", type: "action", action: "walk" },
          { id: "rest", type: "wait", seconds: 0.5, label: "rest" },
          { id: "mark", type: "set", key: "laps", value: 1 },
        ],
      },
    ],
  },
};

describe("reading trees (K4)", () => {
  it("keeps what's valid and drops unknown types, repeated ids and fields of other kinds", () => {
    const read = readBehaviourTrees([
      GUARD,
      { name: "bad", root: { id: "x", type: "explode" } },
      { name: "dup", root: { id: "a", type: "sequence", children: [{ id: "a", type: "wait" }, { id: "b", type: "wait", seconds: 2, key: "ignored" }] } },
    ]);
    expect(read.map((t) => t.name)).toEqual(["guard", "dup"]);
    expect(read[0]).toEqual(GUARD);
    expect(read[1]!.root.children).toEqual([{ id: "b", type: "wait", seconds: 2 }]);
  });

  it("round-trips through the sidecar and the scene the player reads", () => {
    const sidecar = setMeshBehaviours(emptyMeshSidecar(), [GUARD]);
    const encoded = encodeMeshSidecar(sidecar)!;
    expect(decodeMeshSidecar(encoded).behaviours).toEqual([GUARD]);
    // The player's scene (one with an object in it: an empty scene is none).
    const withObject = { ...JSON.parse(encoded), meshes: [{ id: "a", name: "a", mesh: serializeMeshAsset(TRI), transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }] };
    expect(parseMeshScene(JSON.stringify(withObject))?.behaviours).toEqual([GUARD]);
  });

  it("edits a tree: new nodes get fresh ids, and replace and remove find nodes at any depth", () => {
    const ids = btIds(GUARD.root);
    const node = newBtNode("wait", ids);
    expect(ids.has(node.id)).toBe(false);
    const added = replaceBtNode(GUARD.root, "patrol", { ...GUARD.root.children![1]!, children: [...GUARD.root.children![1]!.children!, node] });
    expect(btIds(added).has(node.id)).toBe(true);
    expect(btIds(replaceBtNode(added, "rest", null)).has("rest")).toBe(false);
  });
});

const MODERN = path.resolve(__dirname, "../packages/modern-core/dist/modern-core.js");

describe.skipIf(!existsSync(MODERN))("running a tree (K4)", () => {
  const CART = `
local log = {}
cartbox.bt.action("walk", function(agent, bb) bb.steps = (bb.steps or 0) + 1 if bb.steps % 3 == 0 then return "success" end return "running" end)
cartbox.bt.action("moveTo", function(agent, bb) return "running" end)
cartbox.bt.action("shout", function(agent, bb) bb.shouts = (bb.shouts or 0) + 1 return "success" end)
local bot = cartbox.bt.new("guard", 7)
cartbox.bt.watch(bot)
t = 0
function TIC()
  t = t + 1
  if t == 40 then bot.bb.target = 3 end
  local status = cartbox.bt.tick(bot, 0.1)
  local path, id = cartbox.bt.running(bot)
  cartbox.command(1, t, bot.bb.steps or 0, bot.bb.laps or 0, bot.bb.shouts or 0)
  if t % 10 == 0 then trace(status .. " " .. (path or "-")) end
end`;

  async function run(ticks: number) {
    const factory = (await import(pathToFileURL(MODERN).href)).default as ModernCoreFactory;
    const rows: number[][] = [];
    const traces: string[] = [];
    const c = await createModernCore(factory, { width: 320, height: 180, seed: 3, host: { command: (_op, a, b, cc, d) => rows.push([a, b, cc, d].map(Math.round)), query: () => null, trace: (text: string) => traces.push(text) } as never });
    expect(c.load(`${behaviourTreesLua([GUARD])}\n${CART}`)).toBe(true);
    for (let i = 0; i < ticks; i += 1) c.tick();
    return { rows, traces, error: c.error() };
  }

  it("patrols (walk, wait, mark), then chases once it sees a target, shouting at most once a second", async () => {
    const { rows, error } = await run(80);
    expect(error ?? "").toBe("");
    // Walking takes 3 ticks (running twice), the rest 0.5 s (5 ticks at 0.1), then the lap is marked.
    const lap = rows.findIndex((r) => r[2] === 1);
    expect(lap).toBe(6); // tick 7: walking succeeds on tick 3, and the 0.5 s rest starts that tick and ends on tick 7
    // At tick 40 it sees a target: the patrol stops (no more steps), the chase runs, shouting on the first tick.
    const steps39 = rows[38]![1]!;
    expect(rows[79]![1]).toBe(steps39);
    expect(rows[39]![3]).toBe(1);
    // The chase keeps its place on "run at it" (a sequence resumes its running child): one shout.
    expect(rows[79]![3]).toBe(1);
  });

  it("gates a branch with a cooldown, and repeats a child a set number of times", async () => {
    const tree: BehaviourTree = {
      name: "drill",
      root: {
        id: "root",
        type: "sequence",
        children: [
          { id: "three", type: "repeat", count: 3, children: [{ id: "tap", type: "action", action: "tap" }] },
          { id: "gate", type: "cooldown", seconds: 0.5, children: [{ id: "fire", type: "action", action: "fire" }] },
        ],
      },
    };
    const factory = (await import(pathToFileURL(MODERN).href)).default as ModernCoreFactory;
    const rows: number[][] = [];
    const c = await createModernCore(factory, { width: 320, height: 180, seed: 3, host: { command: (_op, a, b, cc) => rows.push([a, b, cc].map(Math.round)), query: () => null } });
    const code = `
local taps, fires = 0, 0
cartbox.bt.action("tap", function() taps = taps + 1 return "success" end)
cartbox.bt.action("fire", function() fires = fires + 1 return "success" end)
local b = cartbox.bt.new("drill", 1)
t = 0
function TIC() t = t + 1 local s = cartbox.bt.tick(b, 0.1) cartbox.command(1, t, taps, fires) end`;
    expect(c.load(`${behaviourTreesLua([tree])}\n${code}`)).toBe(true);
    for (let i = 0; i < 30; i += 1) c.tick();
    // Each pass: three taps (the repeat finishes one a tick and succeeds on the third), then a fire the same tick,
    // unless the gate is still cooling from the last (0.5 s = 5 ticks).
    expect(rows[2]).toEqual([3, 3, 1]);
    expect(rows[5]).toEqual([6, 6, 1]); // tick 6: three more taps, but the gate (open again at tick 8) fails the pass
    const fires = rows[29]![2]!;
    expect(fires).toBeGreaterThanOrEqual(3);
    expect(fires).toBeLessThanOrEqual(7); // at most once each 0.5 s over 3 s
  });

  it("decides the same every run, and shows the running node's path in the console", async () => {
    const a = await run(80);
    const b = await run(80);
    expect(a.rows).toEqual(b.rows);
    const watched = a.traces.filter((t) => t.startsWith("bt guard: "));
    expect(watched[0]).toBe("bt guard: root > patrol > walk");
    expect(watched).toContain("bt guard: root > patrol > rest");
    expect(watched[watched.length - 1]).toBe("bt guard: root > chase > run at it");
  });
});
