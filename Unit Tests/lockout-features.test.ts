/**
 * Lockout on the editor's newer features: the match intro is a timeline (a
 * camera flyover the cart plays when an offline match starts, skippable), and
 * the soldiers aim with their bodies through look-at on the skeleton. The
 * intro's camera must stay over the deck, above the terrain and out of every
 * structure the whole way.
 */

import { describe, expect, it } from "vitest";

import { LOCKOUT_CODE, LOCKOUT_INTRO, lockoutMeshSidecar, lockoutTerrain, sampleCamera, terrainHeight } from "@cartbox/editor";
import { parseMeshScene } from "@cartbox/player";

/** Read a `local NAME = {…}` numeric table out of the shipped cart code. */
function luaTable(name: string): number[] {
  const m = new RegExp(`local ${name}\\s*=\\s*\\{([^}]*)\\}`).exec(LOCKOUT_CODE);
  if (!m) throw new Error(`no ${name} table`);
  return m[1]!.split(",").map(Number);
}

describe("the match intro", () => {
  it("ships as a timeline on the scene, played by the cart when an offline match starts", () => {
    const scene = parseMeshScene(lockoutMeshSidecar())!;
    expect(scene.timelines?.map((t) => t.name)).toEqual(["Intro"]);
    expect(scene.timelines![0]!.autoplay).toBe(false);
    expect(LOCKOUT_CODE).toContain('cartbox.playtimeline("Intro")');
    expect(LOCKOUT_CODE).toContain("intro = NETMODE == 0 and 0 or nil"); // online matches start at once
    expect(LOCKOUT_CODE).toContain("cartbox.stoptimeline()"); // Z skips it
    expect(LOCKOUT_CODE).toContain("if play_intro() then return end"); // the match waits for it
  });

  it("keeps the camera above the terrain and out of every structure", () => {
    const t = lockoutTerrain();
    const COL = luaTable("COL");
    const boxes = Array.from({ length: COL.length / 6 }, (_, i) => COL.slice(i * 6, i * 6 + 6));
    for (let s = 0; s <= LOCKOUT_INTRO.duration; s += 0.05) {
      const cam = sampleCamera(LOCKOUT_INTRO, s)!;
      const [x, y, z] = cam.eye;
      const ground = terrainHeight(t, x, z);
      expect(ground === null || ground < y - 3, `at ${s.toFixed(2)}s the eye (${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)}) is under the terrain (${ground})`).toBe(true);
      for (const [x0, y0, z0, x1, y1, z1] of boxes) {
        const inside = x > x0! - 0.5 && x < x1! + 0.5 && y > y0! - 0.5 && y < y1! + 0.5 && z > z0! - 0.5 && z < z1! + 0.5;
        expect(inside, `at ${s.toFixed(2)}s the eye is inside a structure`).toBe(false);
      }
    }
  });
});

describe("aiming with the body", () => {
  it("turns each soldier's chest and head toward its target, and lets go without one", () => {
    expect(LOCKOUT_CODE).toContain('cartbox.lookat(i, "chest", tg.x, tg.y + 1.2, tg.z, 0.8, 40)');
    expect(LOCKOUT_CODE).toContain('cartbox.lookat(i, "head", tg.x, tg.y + 1.5, tg.z, 1, 60)');
    expect(LOCKOUT_CODE).toContain('cartbox.lookat(i, "chest", 0, 0, 0, 0)');
    // The joints exist on the soldier's skeleton.
    const scene = parseMeshScene(lockoutMeshSidecar())!;
    const joints = scene.instances[1]!.mesh.skin!.joints.map((j) => j.name);
    expect(joints).toContain("chest");
    expect(joints).toContain("head");
  });
});
