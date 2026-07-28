/**
 * Nested handheld-OS tests — the Cartbox "Make · Play · Share" console booted on
 * the centre handheld's screen and its in-OS customizer over the *real* handheld
 * parameters (the recolour regions of the scheme plus screen/phosphor/scanlines/
 * marquee). They drive the pure state machine, the framebuffer renderer, the
 * scene's screen mapping, and the save translation, asserting on produced pixels
 * and structure: boot differs from menu, the menu lights pixels, the reducer
 * navigates menu → customize → done and applies real scheme/setting changes, the
 * hero screen maps voxels to in-range framebuffer pixels, config recolours the
 * hero body, and a config saves to a stored handheld. No internals are inspected.
 */

import { describe, expect, it } from "vitest";
import {
  renderOsApp,
  osReduce,
  initialOsState,
  hexToRgb,
  PALETTE,
  PARAMS,
  DEFAULT_CONFIG,
  SCREEN_W,
  SCREEN_H,
  type OsState,
} from "../apps/web/src/lib/cartboxOs";
import { applyHandheldConfig, applyOsScreen, buildWorldScene } from "../apps/web/src/lib/worldScene";
import { buildStoredHandheld } from "../apps/web/src/lib/handheldChoice";

const SMALL = {
  terrain: { sizeX: 12, sizeZ: 12, sizeY: 12, baseHeight: 5, amplitude: 3, hillScale: 6, caveScale: 4, caveThreshold: 0.6, crust: 2, seed: 7 },
  snowCount: 10,
} as const;

function frame(): Uint8ClampedArray {
  return new Uint8ClampedArray(SCREEN_W * SCREEN_H * 4);
}

function litPixels(buffer: Uint8ClampedArray): number {
  let count = 0;
  for (let i = 0; i < SCREEN_W * SCREEN_H; i += 1) {
    if (buffer[i * 4]! > 40 || buffer[i * 4 + 1]! > 40 || buffer[i * 4 + 2]! > 60) count += 1;
  }
  return count;
}

/** Apply a sequence of buttons to the initial state. */
function run(...buttons: Parameters<typeof osReduce>[1][]): OsState {
  return buttons.reduce((state, button) => osReduce(state, button), initialOsState());
}

/** The index of the first colour (region) parameter, and a non-colour one. */
const firstRegion = PARAMS.findIndex((param) => param.kind === "color");
const scanlinesParam = PARAMS.findIndex((param) => param.kind === "scanlines");

describe("renderOsApp", () => {
  it("fills the whole buffer opaque every frame", () => {
    const buffer = frame();
    renderOsApp(buffer, initialOsState(), 2);
    for (let i = 0; i < SCREEN_W * SCREEN_H; i += 1) expect(buffer[i * 4 + 3]).toBe(255);
  });

  it("draws a different image while booting than in the menu", () => {
    const boot = frame();
    const menu = frame();
    renderOsApp(boot, initialOsState(), 0.2);
    renderOsApp(menu, initialOsState(), 2);
    expect(Array.from(boot)).not.toEqual(Array.from(menu));
  });

  it("lights menu pixels once booted", () => {
    const menu = frame();
    renderOsApp(menu, initialOsState(), 2);
    expect(litPixels(menu)).toBeGreaterThan(30);
  });

  it("draws the customizer differently from the menu", () => {
    const menu = frame();
    const custom = frame();
    renderOsApp(menu, initialOsState(), 2);
    renderOsApp(custom, run("a"), 2);
    expect(Array.from(menu)).not.toEqual(Array.from(custom));
  });
});

describe("osReduce", () => {
  it("exposes the full parameter set (regions + screen/phosphor/scanlines/marquee)", () => {
    expect(PARAMS.filter((param) => param.kind === "color").length).toBeGreaterThanOrEqual(10);
    expect(PARAMS.some((param) => param.kind === "screen")).toBe(true);
    expect(PARAMS.some((param) => param.kind === "marquee")).toBe(true);
  });

  it("opens the customizer from the menu with A or Start", () => {
    expect(osReduce(initialOsState(), "a").mode).toBe("customize");
    expect(osReduce(initialOsState(), "start").mode).toBe("customize");
  });

  it("cycles parameters with the selector, wrapping", () => {
    const start = run("a");
    expect(osReduce(start, "right").paramIndex).toBe(start.paramIndex + 1);
    expect(osReduce(start, "left").paramIndex).toBe(PARAMS.length - 1);
  });

  it("applies a palette swatch to the focused region's scheme colour", () => {
    // a: open · down: focus panel · right: cursor 1 · a: apply.
    const applied = run("a", "down", "right", "a");
    const region = PARAMS[firstRegion]!.regionId!;
    expect(applied.config.scheme[region]).toBe(PALETTE[1]);
    // A different region is untouched.
    const otherRegion = PARAMS.find((p, i) => p.kind === "color" && i !== firstRegion)!.regionId!;
    expect(applied.config.scheme[otherRegion]).toBe(DEFAULT_CONFIG.scheme[otherRegion]);
  });

  it("applies a non-colour setting (scanlines OFF) from its option list", () => {
    // Jump to the scanlines param, focus its list, move to OFF (index 1), apply.
    const atScanlines: OsState = { ...run("a"), paramIndex: scanlinesParam, focus: "panel", cursor: 0 };
    const off = osReduce(osReduce(atScanlines, "down"), "a"); // down → OFF, a → apply
    expect(off.config.osScanlines).toBe(false);
  });

  it("confirms to done from the PICK button", () => {
    const atConfirm: OsState = { ...run("a"), focus: "confirm" };
    expect(osReduce(atConfirm, "a").mode).toBe("done");
  });

  it("backs out of the customizer to the menu with B", () => {
    expect(run("a", "b").mode).toBe("menu");
  });
});

describe("hero screen + config", () => {
  it("maps screen voxels to in-range framebuffer pixels", () => {
    const scene = buildWorldScene(SMALL);
    expect(scene.hero.index.length).toBeGreaterThan(0);
    for (let k = 0; k < scene.hero.index.length; k += 1) {
      expect(scene.hero.fbX[k]).toBeGreaterThanOrEqual(0);
      expect(scene.hero.fbX[k]).toBeLessThan(SCREEN_W);
      expect(scene.hero.fbY[k]).toBeGreaterThanOrEqual(0);
      expect(scene.hero.fbY[k]).toBeLessThan(SCREEN_H);
    }
  });

  it("uses the same model instance the scene renders", () => {
    const scene = buildWorldScene(SMALL);
    const centre = Math.floor(scene.floaters.length / 2);
    expect(scene.hero.model).toBe(scene.floaters[centre]!.model);
  });

  it("paints framebuffer colours onto the screen voxels", () => {
    const scene = buildWorldScene(SMALL);
    const buffer = frame();
    for (let i = 0; i < SCREEN_W * SCREEN_H; i += 1) {
      buffer[i * 4] = 12;
      buffer[i * 4 + 1] = 200;
      buffer[i * 4 + 2] = 60;
      buffer[i * 4 + 3] = 255;
    }
    applyOsScreen(scene.hero, buffer);
    const v = scene.hero.index[0]!;
    expect([scene.hero.model.r[v], scene.hero.model.g[v], scene.hero.model.b[v]]).toEqual([12, 200, 60]);
  });

  it("recolours the hero body from the scheme's chassis colour", () => {
    const scene = buildWorldScene(SMALL);
    expect(scene.hero.bodyIndex.length).toBeGreaterThan(0);
    const config = { ...DEFAULT_CONFIG, scheme: { ...DEFAULT_CONFIG.scheme, face: "#ff8000" } };
    applyHandheldConfig(scene.hero, config);
    const v = scene.hero.bodyIndex[0]!;
    expect([scene.hero.model.r[v], scene.hero.model.g[v], scene.hero.model.b[v]]).toEqual(hexToRgb("#ff8000"));
  });
});

describe("buildStoredHandheld", () => {
  it("translates a config into a custom stored handheld carrying the scheme", () => {
    const config = { ...DEFAULT_CONFIG, scheme: { ...DEFAULT_CONFIG.scheme, face: "#123456" } };
    const stored = buildStoredHandheld(config);
    expect(stored.scheme.face).toBe("#123456");
    expect(stored.presetId).toBeTruthy();
  });
});
