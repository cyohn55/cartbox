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
  LOCKOUT_SCENE_TRIANGLES,
  LOCKOUT_CENTER_Y,
  resolveStarter,
} from "@cartbox/editor";
import { MODELS, parseMeshScene } from "@cartbox/player";

import { resolveStarterId } from "../apps/web/src/lib/starter";

describe("the Lockout arena starter", () => {
  it("is registered and reachable by id", () => {
    expect(resolveStarter("lockout").id).toBe("lockout");
    expect(resolveStarter("lockout").mesh).toBe(LOCKOUT_MESH_SIDECAR);
    // A fresh cart can select it from the /edit/new URL.
    expect(resolveStarterId("lockout")).toBe("lockout");
  });

  it("parses into a drawable scene: the map plus 7 bot instances", () => {
    const scene = parseMeshScene(LOCKOUT_MESH_SIDECAR)!;
    expect(scene).not.toBeNull();
    expect(scene.instances).toHaveLength(1 + 7); // map + 7 bots
    expect(scene.bounds.radius).toBeGreaterThan(0);
  });

  it("has a scene centre the first-person camera math can rely on", () => {
    // The cart's camera offsets are relative to (0, CENTER_Y, 0); if the runtime
    // disagreed, the eye would not land on the player. Symmetry pins X/Z to 0.
    const { center } = parseMeshScene(LOCKOUT_MESH_SIDECAR)!.bounds;
    expect(Math.abs(center[0])).toBeLessThan(1e-6);
    expect(Math.abs(center[2])).toBeLessThan(1e-6);
    expect(Math.abs(center[1] - LOCKOUT_CENTER_Y)).toBeLessThan(1e-6);
  });

  it("fits the Xbox 360 tier (unbounded budget) with a modest triangle count", () => {
    expect(MODELS.xbox360.renderCaps.polyBudget).toBe(0); // unbounded
    expect(LOCKOUT_SCENE_TRIANGLES).toBeGreaterThan(200);
    expect(LOCKOUT_SCENE_TRIANGLES).toBeLessThan(5000);
  });

  it("drives a first-person camera, poses the bots, and reads FPS input", () => {
    expect(LOCKOUT_CODE).toContain("cartbox.worldcam"); // moves the orbit target = FP camera
    expect(LOCKOUT_CODE).toContain("cartbox.meshpose"); // repositions the 7 bots
    expect(LOCKOUT_CODE).toContain("function TIC");
    expect(LOCKOUT_CODE).toMatch(/key\(23\)/); // WASD movement
    expect(LOCKOUT_CODE).toContain("mouse()"); // mouse look
  });

  it("ships the four game types with their rules and a mode-select menu", () => {
    for (const label of ["Free for All", "Team Slayer", "SWAT", "Team Snipers"]) {
      expect(LOCKOUT_CODE).toContain(label);
    }
    expect(LOCKOUT_CODE).toContain('MODE_KEYS = {"ffa","slayer","swat","snipe"}');
    expect(LOCKOUT_CODE).toContain('phase = "menu"'); // start screen
    expect(LOCKOUT_CODE).toContain("start_match"); // each mode is start-able
    expect(LOCKOUT_CODE).toContain("teams=true"); // team modes
    expect(LOCKOUT_CODE).toContain("shields=false"); // SWAT drops shields
  });

  it("implements the Lockout weapon sandbox with pickups, swap, headshots and zoom", () => {
    for (const weapon of ["br", "smg", "shotgun", "sniper", "magnum", "sword"]) {
      expect(LOCKOUT_CODE).toContain(`"${weapon}"`);
    }
    expect(LOCKOUT_CODE).toContain("try_pickups"); // walk-over weapon spawns
    expect(LOCKOUT_CODE).toContain("player_fire"); // per-weapon hitscan
    expect(LOCKOUT_CODE).toContain("headshot"); // headshot multiplier
    expect(LOCKOUT_CODE).toContain("p.zoom"); // sniper zoom
    expect(LOCKOUT_CODE).toMatch(/swap/); // weapon switch
  });
});
