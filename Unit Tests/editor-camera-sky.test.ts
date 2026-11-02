/**
 * An editor's camera keeps a first-person cart's sky (DEMO_QUALITY_ROADMAP.md).
 * Taking the editor's camera turns the HUD off, and the sky dome went with it:
 * the cart's 2D frame, with whatever it painted behind its HUD, showed where the
 * sky should be. Every capture in captures/f11a was taken that way, so each
 * showed the cart's flat bands and stars in place of Lockout's sky.
 */

import { describe, expect, it } from "vitest";

import { defaultSceneLighting, serializeMeshAsset, type MeshAsset } from "@cartbox/editor";
import { MeshOverlaySurface, parseMeshScene, type SceneRenderer } from "@cartbox/player";

const W = 48;
const H = 32;

/** A triangle far off to one side, so the view's middle shows only what is behind the scene. */
const TRI: MeshAsset = {
  name: "t",
  primitives: [
    {
      positions: Float32Array.from([40, 0, 0, 41, 0, 0, 40, 1, 0]),
      normals: null,
      uvs: null,
      indices: Uint32Array.from([0, 1, 2]),
      material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null },
    },
  ],
};

const sceneJson = JSON.stringify({
  version: 2,
  meshes: [{ id: "a", name: "a", mesh: serializeMeshAsset(TRI), transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
  lighting: { ...defaultSceneLighting(), sky: { sunDirection: [0, 1, 0] } },
});

/** The cart's 2D frame: a flat, saturated red, which no sky dome contains. */
function cartFrame(): Uint8Array {
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i += 1) rgba.set([255, 0, 0, 255], i * 4);
  return rgba;
}

/** The share of the frame's pixels that are the cart's red. */
function redShare(rgba: Uint8Array): number {
  let red = 0;
  for (let i = 0; i < W * H; i += 1) if (rgba[i * 4] === 255 && rgba[i * 4 + 1] === 0 && rgba[i * 4 + 2] === 0) red += 1;
  return red / (W * H);
}

/** One frame through the overlay with the given modes, as it reaches the screen. */
async function frame(hud: boolean, backdrop: boolean, cart: Uint8Array = cartFrame()): Promise<Uint8Array> {
  let shown = new Uint8Array(0);
  const renderer: SceneRenderer = { backend: "software", render: () => {}, dispose: () => {} };
  const surface = await MeshOverlaySurface.create({ blit: (rgba: Uint8Array) => void (shown = rgba.slice()), destroy() {} }, W, H, parseMeshScene(sceneJson)!, renderer);
  surface.setHudMode(hud);
  surface.setSkyBackdrop(backdrop);
  surface.blit(cart);
  return shown;
}

describe("the sky behind a first-person cart's world", () => {
  it("shows the cart's frame behind the scene for a third-person cart, as before", async () => {
    expect(redShare(await frame(false, false))).toBeGreaterThan(0.9);
  });

  it("is drawn for an editor's camera, with neither the cart's frame behind nor its HUD on top", async () => {
    const shown = await frame(false, true);
    expect(redShare(shown)).toBe(0);
    // Sky, not a flat fill: the dome grades from zenith to horizon down the view.
    const row = (y: number) => shown[(y * W + W / 2) * 4]! + shown[(y * W + W / 2) * 4 + 1]! + shown[(y * W + W / 2) * 4 + 2]!;
    expect(row(1)).not.toBe(row(H - 2));
  });

  it("is the same sky the first-person view draws under its HUD", async () => {
    // A first-person cart's HUD is see-through where it is black, so a black
    // frame shows the first-person view's sky bare.
    const play = await frame(true, false, new Uint8Array(W * H * 4));
    expect(Array.from(await frame(false, true))).toEqual(Array.from(play));
  });
});
