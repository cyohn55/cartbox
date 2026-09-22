/**
 * First-person HUD compositing: the mesh overlay renders the 3D scene, then lays
 * the cart's 2D frame over it, keying out the near-black "void" so the world shows
 * through and only the drawn HUD lands on top. These pin the pure composite step
 * and the mailbox HUD flag that turns the mode on.
 */

import { describe, expect, it } from "vitest";

import { compositeHudOverScene } from "../packages/player/src/mesh/MeshOverlaySurface";
import { decodeMeshCamera, MESH_CAM_BASE, MESH_CAM_ACTIVE, MESH_CAM_HUD } from "../packages/player/src/mailbox";

describe("compositeHudOverScene", () => {
  it("keeps the scene under near-black HUD pixels and overwrites under bright ones", () => {
    const scene = Uint8ClampedArray.from([10, 20, 30, 255, 10, 20, 30, 255]); // 3D scene (2 px)
    const hud = Uint8Array.from([5, 7, 12, 255, 200, 40, 40, 255]); // px0 = void, px1 = HUD
    compositeHudOverScene(scene, hud, 2);
    expect(Array.from(scene.slice(0, 4))).toEqual([10, 20, 30, 255]); // void → scene shows through
    expect(Array.from(scene.slice(4, 8))).toEqual([200, 40, 40, 255]); // bright → HUD on top
  });

  it("treats pure black as fully transparent", () => {
    const scene = Uint8ClampedArray.from([1, 2, 3, 255]);
    compositeHudOverScene(scene, Uint8Array.from([0, 0, 0, 255]), 1);
    expect(Array.from(scene)).toEqual([1, 2, 3, 255]);
  });
});

describe("decodeMeshCamera HUD flag", () => {
  const base = () => {
    const w = new Uint32Array(MESH_CAM_BASE + 8);
    w[MESH_CAM_BASE] = MESH_CAM_ACTIVE; // camera active, HUD off
    return w;
  };

  it("reports hud=false when only the active bit is set", () => {
    expect(decodeMeshCamera(base())?.hud).toBe(false);
  });

  it("reports hud=true when the HUD bit is set alongside active", () => {
    const w = base();
    w[MESH_CAM_BASE] = MESH_CAM_ACTIVE | MESH_CAM_HUD;
    expect(decodeMeshCamera(w)?.hud).toBe(true);
  });
});
