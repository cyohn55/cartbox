/**
 * Damage, abilities and tags (AAA_PRODUCTION_ROADMAP.md K6), run on the Modern
 * core: health with shields and resistances, damage events by type and zone,
 * hitboxes on a skeleton's joints, and abilities gated by cooldown, cost and tags.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { GAMEPLAY_LUA, gameplayLua } from "@cartbox/editor";
import { createModernCore, type ModernCoreFactory } from "../packages/modern-core/src/index";

const MODERN = path.resolve(__dirname, "../packages/modern-core/dist/modern-core.js");

/** Run a cart's top level once; each cartbox.command(1, …) is a row. */
async function run(code: string, ticks = 0) {
  const factory = (await import(pathToFileURL(MODERN).href)).default as ModernCoreFactory;
  const rows: number[][] = [];
  const c = await createModernCore(factory, { width: 320, height: 180, seed: 1, host: { command: (_op, ...v: number[]) => rows.push(v.map((x) => Math.round(x * 1000) / 1000)), query: () => null } });
  const ok = c.load(`${GAMEPLAY_LUA}\n${code}`);
  for (let i = 0; i < ticks; i += 1) c.tick();
  return { ok, rows, error: c.error() };
}

describe("when it's put in (K6)", () => {
  it("comes only when the cart names it", () => {
    expect(gameplayLua("function TIC() end")).toBe("");
    expect(gameplayLua("local h = cartbox.health.new{}")).toBe(GAMEPLAY_LUA);
  });
});

describe.skipIf(!existsSync(MODERN))("the gameplay framework (K6)", () => {
  it("matches tags by their hierarchy", async () => {
    const { rows, error } = await run(`
local e = {}
cartbox.tags.add(e, "state.stunned") cartbox.tags.add(e, "team.red")
local b = function(v) return v and 1 or 0 end
cartbox.command(1, b(cartbox.tags.has(e, "state")), b(cartbox.tags.has(e, "state.stunned")), b(cartbox.tags.has(e, "stat")), b(cartbox.tags.all(e, {"state", "team.red"})), b(cartbox.tags.any(e, {"team.blue", "state"})))
cartbox.tags.remove(e, "state.stunned")
cartbox.command(1, b(cartbox.tags.has(e, "state")), #cartbox.tags.list(e))`);
    expect(error ?? "").toBe("");
    expect(rows[0]!.slice(0, 5)).toEqual([1, 1, 0, 1, 1]);
    expect(rows[1]!.slice(0, 2)).toEqual([0, 1]);
  });

  it("takes damage through the shield first, by type and zone, and dies once, with its events", async () => {
    const { rows } = await run(`
local spartan = { health = cartbox.health.new{ max = 100, shield = 70, resist = { plasma = 0.5 }, zones = { head = 2 } } }
local h = spartan.health
cartbox.damage(spartan, 50, { type = "bullet", zone = "body" })   -- shield 70 -> 20
cartbox.command(1, h.shield, h.hp)
cartbox.damage(spartan, 60, { type = "plasma", zone = "head" })   -- 60 x 0.5 x 2 = 60: 20 shield, 40 health
cartbox.command(1, h.shield, h.hp)
cartbox.damage(spartan, 100, { type = "bullet", zone = "head", source = 7 })   -- 200: dies
cartbox.damage(spartan, 10)                                        -- dead: nothing
local ev = cartbox.damage.events()
local kinds = {} for _, e in ipairs(ev) do kinds[#kinds + 1] = e.kind end
cartbox.command(1, h.hp, #ev, h.dead and 1 or 0, ev[#ev].source)
cartbox.command(2, kinds[1] == "hit" and 1 or 0, kinds[3] == "shield_broken" and 1 or 0, kinds[5] == "death" and 1 or 0)`);
    expect(rows[0]!.slice(0, 2)).toEqual([20, 100]);
    expect(rows[1]!.slice(0, 2)).toEqual([0, 60]);
    expect(rows[2]!.slice(0, 4)).toEqual([0, 5, 1, 7]);
    expect(rows[3]!.slice(0, 3)).toEqual([1, 1, 1]);
  });

  it("recharges its shield after a delay without hits", async () => {
    const { rows } = await run(`
local h = cartbox.health.new{ max = 100, shield = 50, shieldDelay = 1, shieldRate = 50 }
cartbox.damage(h, 50)
function TIC() cartbox.health.update(h, 0.1) cartbox.command(1, h.shield) end`, 20);
    expect(rows[8]![0]).toBe(0); // 0.9 s: still waiting
    expect(rows[10]![0]).toBeCloseTo(5, 3); // 1.1 s: recharging at 50/s
    expect(rows[19]![0]).toBe(50);
  });

  it("finds the zone a shot hits on a skeleton's hitboxes", async () => {
    const { rows, error } = await run(`
local hb = cartbox.hitbox.new{
  { zone = "head", at = "head", r = 0.15, multiplier = 2 },
  { zone = "body", at = "pelvis", to = "neck", r = 0.25 },
}
cartbox.hitbox.place(hb, { head = {0, 1.7, 0}, neck = {0, 1.5, 0}, pelvis = {0, 0.9, 0} })
local z1, d1, m1 = cartbox.hitbox.ray(hb, -5, 1.7, 0, 1, 0, 0, 100)
local z2, d2 = cartbox.hitbox.ray(hb, -5, 1.2, 0, 1, 0, 0, 100)
local z3 = cartbox.hitbox.ray(hb, -5, 2.5, 0, 1, 0, 0, 100)
cartbox.command(1, z1 == "head" and 1 or 0, d1, m1, z2 == "body" and 1 or 0, d2, z3 == nil and 1 or 0)`);
    expect(error ?? "").toBe("");
    expect(rows[0]!.slice(0, 6)).toEqual([1, 4.85, 2, 1, 4.75, 1]);
  });

  it("gates an ability by cooldown, cost and tags, and grants its tags for its duration", async () => {
    const { rows, error } = await run(`
local p = { resources = { energy = 50 } }
cartbox.tags.add(p, "state.alive")
local dash = cartbox.ability.new{ name = "dash", cooldown = 1, cost = { energy = 20 }, requires = { "state.alive" }, blocked = { "state.stunned" }, grants = { "state.dashing" }, duration = 0.3 }
local function try() local ok, why = cartbox.ability.try(p, dash) return ok and 1 or ({ cooldown = 2, cost = 3, requires = 4, blocked = 5 })[why] end
t = 0
function TIC()
  t = t + 1
  local r = 0
  if t == 1 or t == 2 or t == 12 or t == 24 or t == 36 then r = try() end
  if t == 30 then cartbox.tags.add(p, "state.stunned") end
  cartbox.command(1, t, r, p.resources.energy, cartbox.tags.has(p, "state.dashing") and 1 or 0)
  cartbox.ability.update(p, 0.1)
end`, 40);
    expect(error ?? "").toBe("");
    const at = (t: number) => rows[t - 1]!.slice(0, 4);
    expect(at(1)).toEqual([1, 1, 30, 1]); // dashes: pays 20, dashing
    expect(at(2)).toEqual([2, 2, 30, 1]); // cooling down
    expect(at(4)[3]).toBe(0); // dashing for 0.3 s only
    expect(at(12)).toEqual([12, 1, 10, 1]); // ready again after 1 s
    expect(at(24)).toEqual([24, 3, 10, 0]); // 10 energy: can't pay

  });
});
