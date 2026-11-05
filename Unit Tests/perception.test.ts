/**
 * Perception (AAA_PRODUCTION_ROADMAP.md K5): sight cones with line of sight,
 * hearing from noise events, memory with decay, written into a blackboard a
 * K4 tree reads. Run on the Modern core.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { PERCEPTION_LUA, behaviourTreesLua, perceptionLua, type BehaviourTree } from "@cartbox/editor";
import { createModernCore, type ModernCoreFactory } from "../packages/modern-core/src/index";

const MODERN = path.resolve(__dirname, "../packages/modern-core/dist/modern-core.js");

async function run(code: string, ticks: number, prelude = PERCEPTION_LUA) {
  const factory = (await import(pathToFileURL(MODERN).href)).default as ModernCoreFactory;
  const rows: (number | string)[][] = [];
  const c = await createModernCore(factory, { width: 320, height: 180, seed: 1, host: { command: (_op, ...v: number[]) => rows.push(v.map((x) => Math.round(x * 100) / 100)), query: () => null } });
  const ok = c.load(`${prelude}\n${code}`);
  for (let i = 0; i < ticks; i += 1) c.tick();
  return { ok, rows, error: c.error() };
}

describe("when it's put in (K5)", () => {
  it("comes with behaviour trees, or when the cart names cartbox.sense", () => {
    expect(perceptionLua("function TIC() end", false)).toBe("");
    expect(perceptionLua("local eyes = cartbox.sense.new()", false)).toBe(PERCEPTION_LUA);
    expect(perceptionLua(null, true)).toBe(PERCEPTION_LUA);
  });
});

describe.skipIf(!existsSync(MODERN))("seeing, hearing and remembering (K5)", () => {
  it("sees what's in its cone and in line of sight, not what's behind it or behind a wall", async () => {
    const { rows, error } = await run(`
-- A wall at x = 5 blocks the view of anything past it.
local eyes = cartbox.sense.new{ fov = 90, range = 20, los = function(ex, ey, ez, tx, ty, tz) return not (ex < 5 and tx > 5) end }
function TIC()
  local seen = cartbox.sense.look(eyes, 0, 0, 0, 1, 0, 0, {
    { id = 1, x = 4, y = 0, z = 1 },    -- ahead, in the cone
    { id = 2, x = -4, y = 0, z = 0 },   -- behind
    { id = 3, x = 3, y = 0, z = 6 },    -- ahead but 63 degrees off: outside a 90 degree cone
    { id = 4, x = 8, y = 0, z = 0 },    -- ahead, past the wall
    { id = 5, x = 30, y = 0, z = 0 },   -- out of range
  })
  cartbox.command(1, #seen, seen[1] or 0)
end`, 1);
    expect(error ?? "").toBe("");
    expect(rows[0]!.slice(0, 2)).toEqual([1, 1]);
  });

  it("hears a noise within its loudness, once, and remembers what it sensed until the memory fades", async () => {
    const { rows } = await run(`
local ears = cartbox.sense.new{ hearing = 1, memory = 1 }
local bb = {}
t = 0
function TIC()
  t = t + 1
  if t == 2 then cartbox.sense.noise(8, 0, 0, 10, 42) end   -- 8 m away, heard within 10 m
  if t == 3 then cartbox.sense.noise(50, 0, 0, 10, 43) end  -- too far
  cartbox.sense.update(ears, 0.1, 0, 0, 0, bb)
  cartbox.command(1, t, bb.target or 0, bb.alert, bb.target_seen and 1 or 0)
end`, 16);
    expect(rows[0]!.slice(0, 4)).toEqual([1, 0, 0, 0]);
    expect(rows[1]!.slice(0, 4)).toEqual([2, 42, 1, 0]); // heard: alert, not seen
    expect(rows[2]![1]).toBe(42); // the far noise isn't heard
    expect(rows[6]![2]).toBeCloseTo(0.5, 5); // fading over its 1 s memory
    expect(rows[12]![1]).toBe(0); // forgotten past it
  });

  it("feeds a behaviour tree's blackboard: the guard chases what it sees and searches where it heard", async () => {
    const tree: BehaviourTree = {
      name: "guard",
      root: {
        id: "root",
        type: "selector",
        children: [
          { id: "chase", type: "sequence", children: [{ id: "seen", type: "condition", key: "target_seen", op: "truthy" }, { id: "run", type: "action", action: "chase" }] },
          { id: "search", type: "sequence", children: [{ id: "heard", type: "condition", key: "target", op: "truthy" }, { id: "go", type: "action", action: "search" }] },
          { id: "idle", type: "action", action: "idle" },
        ],
      },
    };
    const { rows, error } = await run(`
local mode = 0
cartbox.bt.action("chase", function() mode = 3 return "running" end)
cartbox.bt.action("search", function() mode = 2 return "running" end)
cartbox.bt.action("idle", function() mode = 1 return "running" end)
local bot = cartbox.bt.new("guard", 1)
local eyes = cartbox.sense.new{ fov = 90, range = 20, memory = 2, self = 1 }
t = 0
function TIC()
  t = t + 1
  local intruder = {}
  if t >= 20 then intruder = { { id = 9, x = 5, y = 0, z = 0 } } end
  if t == 10 then cartbox.sense.noise(-3, 0, 0, 10, 9) end
  cartbox.sense.look(eyes, 0, 0, 0, 1, 0, 0, intruder)
  cartbox.sense.update(eyes, 0.1, 0, 0, 0, bot.bb)
  cartbox.bt.tick(bot, 0.1)
  cartbox.command(1, mode)
end`, 25, `${PERCEPTION_LUA}\n${behaviourTreesLua([tree])}`);
    expect(error ?? "").toBe("");
    expect(rows[5]![0]).toBe(1); // idle
    expect(rows[10]![0]).toBe(2); // heard something behind it: searching
    expect(rows[22]![0]).toBe(3); // sees it: chasing
  });
});
