/**
 * The Lockout arena starter — a Halo 2 Lockout homage on the Xbox 360 core,
 * playable first-person against AI bots.
 *
 * The load-bearing invariant is the camera: the cart fakes a first-person view
 * by moving the mesh renderer's *orbit target*, and its offset is relative to the
 * scene's bounding-box centre. So the centre the runtime computes MUST equal the
 * constant the cart code was generated with, or the whole view is shifted off the
 * player. That equality is pinned here, alongside the scene being drawable and the
 * code carrying the FPS hooks.
 */

import { describe, expect, it } from "vitest";

import {
  LOCKOUT_CODE,
  LOCKOUT_MESH_SIDECAR,
  LOCKOUT_LIGHTING,
  LOCKOUT_SCENE_TRIANGLES,
  LOCKOUT_CENTER_X,
  LOCKOUT_CENTER_Y,
  LOCKOUT_CENTER_Z,
  deserializeMeshAsset,
  resolveStarter,
} from "@cartbox/editor";
import { MODELS, parseMeshScene } from "@cartbox/player";

import { modelForStarter, resolveStarterId } from "../apps/web/src/lib/starter";

describe("the Lockout arena starter", () => {
  it("is registered and reachable by id", () => {
    expect(resolveStarter("lockout").id).toBe("lockout");
    expect(resolveStarter("lockout").mesh).toBe(LOCKOUT_MESH_SIDECAR);
    // A fresh cart can select it from the /edit/new URL.
    expect(resolveStarterId("lockout")).toBe("lockout");
  });

  it("brings the Xbox 360 model when the URL names only the starter", () => {
    // The cart draws at 1280x720; opened on the default Classic core (240x136) it
    // rendered as four stray sky pixels. ?starter=lockout alone must pick xbox360.
    expect(modelForStarter("lockout")).toBe("xbox360");
    expect(MODELS.xbox360.width).toBe(1280);
    // Model-agnostic starters leave the model to ?model= / the default.
    expect(modelForStarter("demo")).toBeNull();
    expect(modelForStarter(null)).toBeNull();
  });

  it("parses into a drawable scene: the map plus 7 bot instances", () => {
    const scene = parseMeshScene(LOCKOUT_MESH_SIDECAR)!;
    expect(scene).not.toBeNull();
    expect(scene.instances).toHaveLength(1 + 7); // map + 7 bots
    expect(scene.bounds.radius).toBeGreaterThan(0);
  });

  it("has a scene centre the first-person camera math can rely on", () => {
    // The cart's camera offsets are relative to (CENTER_X, CENTER_Y, CENTER_Z);
    // if the runtime's own bounds disagreed, the eye would not land on the player.
    // The map is asymmetric, so all three axes are pinned against the runtime.
    const { center } = parseMeshScene(LOCKOUT_MESH_SIDECAR)!.bounds;
    expect(Math.abs(center[0] - LOCKOUT_CENTER_X)).toBeLessThan(1e-6);
    expect(Math.abs(center[1] - LOCKOUT_CENTER_Y)).toBeLessThan(1e-6);
    expect(Math.abs(center[2] - LOCKOUT_CENTER_Z)).toBeLessThan(1e-6);
  });

  it("fits the Xbox 360 tier (unbounded budget) with a modest triangle count", () => {
    expect(MODELS.xbox360.renderCaps.polyBudget).toBe(0); // unbounded
    expect(LOCKOUT_SCENE_TRIANGLES).toBeGreaterThan(200);
    expect(LOCKOUT_SCENE_TRIANGLES).toBeLessThan(5000);
  });

  it("drives a first-person camera, poses the bots, and uses the 8-button gamepad", () => {
    expect(LOCKOUT_CODE).toContain("cartbox.worldcam"); // moves the orbit target = FP camera
    expect(LOCKOUT_CODE).toContain("cartbox.meshpose"); // repositions the 7 bots
    expect(LOCKOUT_CODE).toContain("function TIC");
    // The web player only forwards 8 gamepad buttons — no key()/mouse() — so the
    // controls must be btn()-only: tank move/turn + face buttons + auto-aim.
    expect(LOCKOUT_CODE).not.toMatch(/\bkey\(/);
    expect(LOCKOUT_CODE).not.toContain("mouse()");
    expect(LOCKOUT_CODE).toContain("btn(0)"); // move forward
    expect(LOCKOUT_CODE).toContain("btn(4)"); // Z = fire
    expect(LOCKOUT_CODE).toContain("auto_target"); // vertical auto-aim
    // Touch only exposes the D-pad + A + B (no X/Y), so the core loop must not
    // require a manual weapon swap: an empty gun reloads, then falls back to the magnum.
    expect(LOCKOUT_CODE).toContain("fall back to the magnum");
  });

  it("shows off the editor's newest 3D features: PBR materials + normal maps + emissive energy", () => {
    // The map ships glTF-style PBR maps — albedo, normal, and metallic-roughness —
    // plus a baked emissive map for the Forerunner light strips, so the panels
    // read as glossy metal that reflects the skybox.
    const map = deserializeMeshAsset(
      (JSON.parse(LOCKOUT_MESH_SIDECAR) as { meshes: { mesh: string }[] }).meshes[0]!.mesh,
    );
    const forerunner = map.primitives.find((p) => p.material.baseColorImage)!;
    expect(forerunner.material.baseColorImage?.mime).toBe("image/png");
    expect(forerunner.material.normalImage?.mime).toBe("image/png"); // normal-mapped panels
    expect(forerunner.material.metallicRoughnessImage?.mime).toBe("image/png"); // PBR metal
    expect(forerunner.material.emissiveImage?.mime).toBe("image/png"); // cyan energy channel
    // A dedicated PBR emitter carries the cyan energy trim (emissive factor, no albedo texture).
    const energy = map.primitives.find(
      (p) => !p.material.baseColorImage && (p.material.emissiveFactor?.some((c) => c > 0) ?? false),
    );
    expect(energy, "an emissive energy material").toBeTruthy();
    expect(LOCKOUT_CODE).toContain("draw_viewmodel"); // first-person weapon viewmodel
  });

  it("carries an authored scene lighting rig: skybox IBL, multiple lights, tone mapping and shadows", () => {
    // The newest editor feature: a lighting rig on the mesh sidecar the runtime
    // replays over the scene.
    expect(LOCKOUT_LIGHTING.shadows).toBe(true);
    expect(LOCKOUT_LIGHTING.tonemap).toBe(true);
    expect(LOCKOUT_LIGHTING.lights.length).toBeGreaterThanOrEqual(2);
    expect(LOCKOUT_LIGHTING.lights.some((l) => l.kind === "point")).toBe(true);
    // It round-trips through the runtime parse the player uses.
    const scene = parseMeshScene(LOCKOUT_MESH_SIDECAR)!;
    expect(scene.lighting?.shadows).toBe(true);
    expect(scene.lighting?.lights.length).toBe(LOCKOUT_LIGHTING.lights.length);
    expect(scene.lighting?.environment.sky).toEqual(LOCKOUT_LIGHTING.environment.sky);
  });

  it("ships seven game types with their rules and a mode-select menu", () => {
    for (const label of [
      "Free for All",
      "Team Slayer",
      "SWAT",
      "Team Snipers",
      "Oddball",
      "King of the Hill",
      "Juggernaut",
    ]) {
      expect(LOCKOUT_CODE).toContain(label);
    }
    expect(LOCKOUT_CODE).toContain('MODE_KEYS = {"ffa","slayer","swat","snipe","ball","koth","jugg"}');
    expect(LOCKOUT_CODE).toContain('phase = "menu"'); // start screen
    expect(LOCKOUT_CODE).toContain("start_match"); // each mode is start-able
    expect(LOCKOUT_CODE).toContain("teams=true"); // team modes
    expect(LOCKOUT_CODE).toContain("shields=false"); // SWAT drops shields
    expect(LOCKOUT_CODE).toContain("update_objective"); // objective scoring (ball/hill/jugg)
  });

  it("implements the weapon sandbox with pickups, reload, swap, headshots and zoom", () => {
    for (const weapon of ["br", "smg", "shotgun", "sniper", "magnum", "sword"]) {
      expect(LOCKOUT_CODE).toContain(`"${weapon}"`);
    }
    expect(LOCKOUT_CODE).toContain("try_pickups"); // walk-over weapon spawns
    expect(LOCKOUT_CODE).toContain("player_fire"); // per-weapon hitscan
    expect(LOCKOUT_CODE).toMatch(/dmg\s*=\s*dmg\s*\*\s*w\.hs/); // headshot multiplier
    expect(LOCKOUT_CODE).toContain("p.zoom"); // sniper zoom
    expect(LOCKOUT_CODE).toContain("fall back to the magnum"); // empty gun auto-falls back
    expect(LOCKOUT_CODE).toMatch(/swap/); // weapon switch
  });

  it("adds the deeper sandbox: grenades, melee, wall-occluded shots, motion tracker and medals", () => {
    expect(LOCKOUT_CODE).toContain("throw_grenade"); // double-tap-A frag grenades
    expect(LOCKOUT_CODE).toContain("seg_blocked"); // shots can't pass through walls
    expect(LOCKOUT_CODE).toContain("auto-melee"); // point-blank melee
    expect(LOCKOUT_CODE).toContain("draw_tracker"); // radar / motion tracker
    expect(LOCKOUT_CODE).toContain("register_kill"); // sprees + multikills + kill feed
  });
});
