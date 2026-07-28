/**
 * Cart-starter registry tests. They drive the real registry and seed functions
 * over the real StubCartEngine, asserting on observable engine state (code, map
 * cells) rather than hardcoded copies, and guard the one cross-package invariant
 * that can silently rot: the web-app's selectable-id list must match the editor
 * registry's ids.
 */

import { describe, expect, it } from "vitest";
import {
  StubCartEngine,
  CART_STARTERS,
  DEFAULT_STARTER_ID,
  STARTER_IDS,
  resolveStarter,
  applyStarter,
  DEMO_CODE,
  PARALLAX_CODE,
  PARALLAX_LAYERS,
  bandTopRow,
  silhouetteHeight,
  MAP_SCREEN_HEIGHT,
} from "@cartbox/editor";

// Web-app validator, imported directly (the file has no @/ alias imports) so the
// test can prove its id list stays in sync with the editor registry.
import { resolveStarterId, DEFAULT_STARTER_ID as WEB_DEFAULT_STARTER_ID } from "../apps/web/src/lib/starter";

describe("cart starter registry", () => {
  it("exposes ids that match its entries and defaults to the first", () => {
    expect(STARTER_IDS).toEqual(CART_STARTERS.map((starter) => starter.id));
    expect(DEFAULT_STARTER_ID).toBe(CART_STARTERS[0].id);
  });

  it("resolves known ids and falls back to the default for unknown input", () => {
    for (const starter of CART_STARTERS) {
      expect(resolveStarter(starter.id)).toBe(starter);
    }
    expect(resolveStarter("does-not-exist")).toBe(CART_STARTERS[0]);
    expect(resolveStarter(null)).toBe(CART_STARTERS[0]);
    expect(resolveStarter(undefined)).toBe(CART_STARTERS[0]);
  });
});

describe("applyStarter", () => {
  it("seeds the demo starter's code by default", () => {
    const engine = new StubCartEngine();
    applyStarter(engine, "demo");
    expect(engine.getCode()).toBe(DEMO_CODE);
    expect(engine.getLanguage()).toBe("lua");
  });

  it("seeds the parallax starter's code and stamps its near band", () => {
    const engine = new StubCartEngine();
    applyStarter(engine, "parallax");
    expect(engine.getCode()).toBe(PARALLAX_CODE);

    // The near layer is the last band; its floor row must carry the near tile,
    // proving the parallax seed (not the demo seed) shaped the map.
    const nearIndex = PARALLAX_LAYERS.length - 1;
    const nearLayer = PARALLAX_LAYERS[nearIndex];
    const bandBottom = bandTopRow(nearIndex) + MAP_SCREEN_HEIGHT - 1;
    expect(silhouetteHeight(nearLayer, 0)).toBeGreaterThan(0); // sanity: it fills
    expect(engine.getMapCell(0, bandBottom)).toBe(nearLayer.tile);
  });

  it("falls back to the default starter for an unknown id", () => {
    const engine = new StubCartEngine();
    applyStarter(engine, "bogus");
    expect(engine.getCode()).toBe(DEMO_CODE);
  });
});

describe("web starter validator stays in sync with the editor registry", () => {
  it("accepts exactly the registry's ids and shares its default", () => {
    for (const id of STARTER_IDS) {
      expect(resolveStarterId(id)).toBe(id);
    }
    expect(resolveStarterId("unknown")).toBe(DEFAULT_STARTER_ID);
    expect(WEB_DEFAULT_STARTER_ID).toBe(DEFAULT_STARTER_ID);
  });
});
