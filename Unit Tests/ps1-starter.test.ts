/**
 * The PS1 test scene starter.
 *
 * This cart exists to be *looked at* — whether it reads as the era is a
 * judgement no test can make. What these do is guard the properties that would
 * silently stop it being a fair test of the era: geometry that no longer fits
 * the model's budgets, a mesh the runtime cannot parse, or a texture that is not
 * a texture.
 *
 * It also pins the bug this cart found on its first run. The editor's playtest
 * mounted the player without a `modelId`, so it loaded the cart's real core and
 * then read its frames at Classic's 240x136 with Classic's render caps — every
 * Pro, Portrait and PS1 playtest was garbled, and nothing noticed because no
 * non-Classic cart had been played in the editor.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CART_STARTERS,
  PS1_CODE,
  PS1_MESH_SIDECAR,
  PS1_SCENE_TRIANGLES,
  resolveStarter,
} from "@cartbox/editor";
import { MODELS, parseMeshScene } from "@cartbox/player";

import {
  DEFAULT_STARTER_ID,
  defaultStarterForModel,
  resolveStarterId,
} from "../apps/web/src/lib/starter";

const ps1 = MODELS.ps1;

describe("the PS1 starter", () => {
  it("is registered and reachable by id", () => {
    expect(CART_STARTERS.map((s) => s.id)).toContain("ps1");
    expect(resolveStarter("ps1").id).toBe("ps1");
  });

  it("ships its geometry as a sidecar, because a mesh is not cartridge content", () => {
    // The whole premise of the 3D era models: geometry lives beside the cart.
    // Without this the starter would open on an empty 3D stage.
    expect(resolveStarter("ps1").mesh).toBe(PS1_MESH_SIDECAR);
  });

  it("parses into a scene the runtime can actually draw", () => {
    // The sidecar is hand-built in the editor package rather than by the web
    // app's encoder, so this is the check that the two agree on the envelope.
    const scene = parseMeshScene(PS1_MESH_SIDECAR)!;
    expect(scene).not.toBeNull();
    expect(scene.instances).toHaveLength(1);
    expect(scene.bounds.radius).toBeGreaterThan(0);
  });

  it("fits the model's triangle budget with room to spare", () => {
    // A test scene that only just fits would leave nothing to judge: the point
    // is to show the era's look, not to sit at the cap.
    expect(PS1_SCENE_TRIANGLES).toBeLessThan(ps1.renderCaps.polyBudget / 4);
    expect(PS1_SCENE_TRIANGLES).toBeGreaterThan(50);
  });

  it("carries one texture that fits the era's texture page", () => {
    // 64x64 is a real PS1 page size, and the cap is what stops a "test scene"
    // quietly demonstrating a modern texture budget.
    const scene = parseMeshScene(PS1_MESH_SIDECAR)!;
    const material = scene.instances[0]!.mesh.primitives[0]!.material;
    const image = material.baseColorImage!;
    expect(image.mime).toBe("image/png");

    // PNG IHDR: width and height are the two big-endian u32s after the 8-byte
    // signature and the 8-byte chunk header.
    const view = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
    expect(image.bytes.subarray(1, 4)).toEqual(new Uint8Array([0x50, 0x4e, 0x47]));
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    expect([width, height]).toEqual([64, 64]);
    expect(width * height * 4).toBeLessThanOrEqual(ps1.renderCaps.textureCacheBytes);
  });

  it("drives its own camera, which is what makes the artefacts visible", () => {
    // Affine warping and vertex snapping are motion artefacts, and the player's
    // auto-orbit frames a wide flat stage from high and far — the two angles
    // that hide them. If this call ever went away the scene would still render
    // and would stop demonstrating anything.
    expect(PS1_CODE).toContain("cartbox.meshcam");
  });
});

describe("the editor's playtest", () => {
  const runOverlay = readFileSync(
    new URL("../apps/web/src/app/edit/[cartId]/RunOverlay.tsx", import.meta.url),
    "utf8",
  );
  const workbench = readFileSync(
    new URL("../apps/web/src/app/edit/[cartId]/EditorWorkbench.tsx", import.meta.url),
    "utf8",
  );

  it("mounts the player at the cart's own model", () => {
    // The bug: `mount` defaults to Classic when given no modelId, so passing
    // only engineUrl loaded the right core and read its frames at 240x136.
    // Published carts were fine — CartridgePlayer always passed one — so this
    // only ever broke playtesting, which is where a creator sees their work.
    expect(runOverlay).toMatch(/modelId: ModelId;/);
    expect(runOverlay).toMatch(/^\s+modelId,$/m);
  });

  it("is handed that model by the workbench", () => {
    // Both halves matter: a prop the overlay accepts and nobody passes is the
    // same bug with an extra step.
    expect(workbench).toContain("modelId={modelId}");
  });
});

describe("what a fresh PS1 cart opens on", () => {
  /**
   * The bug this closes: the home page offered "Create a PS1 cartridge —
   * textured 3D" at `?model=ps1`, and a cart with no `?starter=` fell back to
   * DEFAULT_STARTER_ID — the ring-runner demo, which is *Classic's* starter. So
   * the link promising textured 3D opened a spinning 2D ring, on the right core
   * and with the right caps, but with nothing 3D in it. A blank cart has no
   * geometry, and the only starter carrying any is the PS1 one.
   */
  it("is the PS1 scene, not Classic's ring demo", () => {
    expect(defaultStarterForModel("ps1")).toBe("ps1");
    expect(defaultStarterForModel("ps1")).not.toBe(DEFAULT_STARTER_ID);
  });

  it("leaves every other model on the shared default", () => {
    // The rule is per-model, not "3D models get something else": Classic, Pro
    // and Portrait all still open on the demo they always did.
    for (const model of ["classic", "pro", "portrait", "voxel"]) {
      expect(defaultStarterForModel(model), model).toBe(DEFAULT_STARTER_ID);
    }
  });

  it("names a starter that actually exists", () => {
    // A default pointing at an unregistered id would resolve straight back to
    // the demo, reintroducing the bug silently.
    for (const model of ["classic", "pro", "portrait", "voxel", "ps1"]) {
      const id = defaultStarterForModel(model);
      expect(resolveStarter(id).id, model).toBe(id);
    }
  });

  it("still lets a creator ask for an empty PS1 cart", () => {
    // The default is a default, not a lock: ?starter=demo must survive.
    expect(resolveStarterId("demo")).toBe("demo");
  });

  it("is offered by the home page as a single link", () => {
    // Two adjacent PS1 links — one with the starter, one without — is what sent
    // a creator to the ring. One row per model, like every other model.
    const homePage = readFileSync(
      new URL("../apps/web/src/app/page.tsx", import.meta.url),
      "utf8",
    );
    expect([...homePage.matchAll(/href="\/edit\/new\?model=ps1[^"]*"/g)]).toHaveLength(1);
  });
});
