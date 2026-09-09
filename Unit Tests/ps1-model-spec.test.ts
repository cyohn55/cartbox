/**
 * PS1 model — hardware-spec consistency and era fidelity.
 *
 * Like the Pro spec tests, these do not re-assert the literals (which would
 * just duplicate the spec). They prove the numbers satisfy the *relationships*
 * the core build and the renderer depend on, and — the part that is new here —
 * that the model actually encodes its era rather than merely being labelled
 * with it.
 *
 * That second half matters because `RenderCaps` is now enforced. A PS1 model
 * whose caps quietly matched the modern defaults would render like every other
 * model while claiming to be a period machine, and nothing else would notice.
 */

import { describe, expect, it } from "vitest";

import { PS1_MODEL, type ConsoleModelSpec } from "@cartbox/editor";
import { MODELS, SOFTWARE_RASTER_CAPS, framebufferBytes, getModel } from "@cartbox/player";

const ps1 = MODELS.ps1;

describe("the PS1 frame", () => {
  it("is the era's 4:3 NTSC resolution", () => {
    // 4:3 rather than the 16:9 the Pro models use: the aspect ratio is as much
    // a period signal as the pixels are, and a widescreen PS1 game reads as a
    // remaster rather than as the era.
    expect(ps1.width / ps1.height).toBeCloseTo(4 / 3, 10);
    expect(ps1.width).toBe(320);
    expect(ps1.height).toBe(240);
  });

  it("divides the 8px tile grid exactly in both dimensions", () => {
    // A partial cell at the edge would make the map editor's last column and
    // row unaddressable.
    expect(ps1.width % 8).toBe(0);
    expect(ps1.height % 8).toBe(0);
    expect(PS1_MODEL.screenWidth).toBe(ps1.width / 8);
    expect(PS1_MODEL.screenHeight).toBe(ps1.height / 8);
  });

  it("fits inside the 512-wide overscan buffer the core build declares", () => {
    // build-ps1-wasm.sh sets TIC80_FULLWIDTH_BITS=9. If the visible frame ever
    // exceeded 2^9 the core would write past its own buffer.
    expect(ps1.width).toBeLessThanOrEqual(2 ** 9);
  });

  it("agrees between the runtime and authoring specs", () => {
    // Two packages describe the same machine; a divergence means the editor is
    // drawing at a size the engine will not present.
    const authoring: ConsoleModelSpec = PS1_MODEL;
    expect([authoring.width, authoring.height]).toEqual([ps1.width, ps1.height]);
    expect(authoring.paletteSize).toBe(ps1.paletteSize);
    expect(authoring.id).toBe(ps1.id);
    expect(authoring.kind).toBe(ps1.kind);
  });

  it("has a palette an 8-bit CLUT can hold", () => {
    // 8bpp tiles (tilePixelBits) and a 256-colour palette have to agree, or the
    // editor offers colours the cart format cannot store.
    expect(PS1_MODEL.tilePixelBits).toBe(8);
    expect(ps1.paletteSize).toBe(2 ** PS1_MODEL.tilePixelBits);
  });

  it("is resolvable by id like every other model", () => {
    expect(getModel("ps1")).toBe(ps1);
    expect(framebufferBytes(ps1)).toBe(320 * 240 * 4);
  });
});

describe("the PS1 era, as RenderCaps", () => {
  it("declares every trait that makes the era look like itself", () => {
    // These are artefacts, not defects: whole-triangle sorting, swimming
    // textures, wobbling vertices and crunchy texels are what the generation
    // is remembered for.
    expect(ps1.renderCaps.zBuffer).toBe(false);
    expect(ps1.renderCaps.perspectiveCorrect).toBe(false);
    expect(ps1.renderCaps.vertexPrecision).toBe("integer");
    expect(ps1.renderCaps.textureFiltering).toBe("none");
  });

  it("differs from the modern defaults, so the label means something", () => {
    // The failure this guards: caps that quietly match SOFTWARE_RASTER_CAPS
    // would render identically to every other model while claiming an era.
    expect(ps1.renderCaps).not.toEqual(SOFTWARE_RASTER_CAPS);
  });

  it("bounds a texture to one 8-bit page", () => {
    // 256x256 at one byte per texel. This is the cause of the era's tiny,
    // heavily-reused textures — the cap enforces the look rather than asking
    // artists to remember it.
    expect(ps1.renderCaps.textureCacheBytes).toBe(256 * 256);
  });

  it("bounds geometry per frame", () => {
    // The poly budget is why those games ran at 30fps. This model keeps 60 and
    // constrains the geometry instead: the frame rate was a consequence of the
    // budget, not a design goal, so the cause is modelled and not the symptom.
    expect(ps1.renderCaps.polyBudget).toBeGreaterThan(0);
    expect(ps1.fps).toBe(60);
  });

  it("grants no programmable shaders", () => {
    // The line between a fantasy console and a general engine. A fixed-function
    // era model must never cross it.
    expect(ps1.renderCaps.programmableShaders).toBe(false);
  });
});

describe("the PS1 asset budget", () => {
  it("is the first model allowed content beyond its cartridge", () => {
    // The whole reason a 3D era model is possible: geometry and textures do not
    // fit in a cartridge at any resolution, so they live in the asset store.
    expect(ps1.assetBudgetBytes).toBeGreaterThan(0);
    for (const model of Object.values(MODELS)) {
      if (model.id === "ps1") continue;
      expect(model.assetBudgetBytes, `${model.id} should still be cartridge-only`).toBe(0);
    }
  });

  it("is a CD-ROM, because that is what the era shipped on", () => {
    // The disc is the defining physical fact about this generation: it is why
    // its games have full-motion video, streamed audio and textured worlds
    // where the cartridge eras did not. Picking a smaller number to keep
    // pressure on the artist would be inventing a constraint the hardware did
    // not have, which is the opposite of how every other figure in this spec
    // was chosen.
    expect(ps1.assetBudgetBytes).toBe(660 * 1024 * 1024);
  });

  it("keeps its creative pressure in the per-frame caps, not the disc", () => {
    // With a disc-sized budget, nothing about the *look* of the era comes from
    // storage. It comes from the texture page and the triangle budget, which
    // bind on every frame where the disc only ever bound on the whole game.
    // If these ever went unbounded, a PS1 cart could look like anything.
    expect(ps1.renderCaps.textureCacheBytes).toBeGreaterThan(0);
    expect(ps1.renderCaps.polyBudget).toBeGreaterThan(0);
  });

  it("keeps its cartridge small, because the cartridge is not where the game is", () => {
    // Code, HUD art and sound only. If this crept up toward the asset budget it
    // would mean geometry was being smuggled back into the cart.
    expect(ps1.cartSizeBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(ps1.assetBudgetBytes).toBeGreaterThan(ps1.cartSizeBytes * 8);
  });
});

describe("the PS1 model's place in the family", () => {
  it("is the first model whose games are triangle scenes", () => {
    expect(ps1.kind).toBe("poly3d");
    // And it is the only one: adding a second without noticing would mean two
    // eras sharing one spec by accident.
    const poly = Object.values(MODELS).filter((m) => m.kind === "poly3d");
    expect(poly.map((m) => m.id)).toEqual(["ps1"]);
  });

  it("keeps the 8-bit model untouched", () => {
    // The whole premise of the family: Classic stays byte-compatible with
    // TIC-80 as one member, rather than being stretched to cover 3D.
    expect(MODELS.classic.kind).toBe("raster2d");
    expect(MODELS.classic.renderCaps).toEqual(SOFTWARE_RASTER_CAPS);
    expect(MODELS.classic.width).toBe(240);
    expect(MODELS.classic.height).toBe(136);
  });
});
