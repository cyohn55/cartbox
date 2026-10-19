/**
 * The AAA tier as a console model of its own (AAA_FIDELITY_ROADMAP.md F0d): it
 * runs its carts on the dedicated Modern core (ENGINE_PARITY_ROADMAP.md
 * EP20b) by default, its 2D layer is the HD cores' 1280x720 frame (which the
 * dedicated core lays out byte for byte as they do), exports carry that core,
 * and a fresh cart of the tier opens on its own starter.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { CONSOLE_MODELS, arenaMap, resolveStarter } from "@cartbox/editor";
import { DIRECT_CORE_URL, MODELS, RAM_LAYOUTS, codeChunks, createDirectConsole, directCoreBeside, getModel, runsOnDirectCore } from "@cartbox/player";
import { wrapModernCore } from "@cartbox/modern-core";
import { defaultStarterForModel, modelForStarter, resolveStarterId } from "../apps/web/src/lib/starter";
import { standaloneNeeds } from "../apps/web/src/lib/standaloneExport";

const CORE = path.resolve(__dirname, "../packages/modern-core/dist/modern-core.js");

describe("which core a cart runs on", () => {
  it("the AAA tier's own unless asked not to; the other HD tiers' only when asked; no other model's ever", () => {
    expect(runsOnDirectCore("aaa", undefined)).toBe(true);
    expect(runsOnDirectCore("aaa", "direct")).toBe(true);
    expect(runsOnDirectCore("aaa", "tic80")).toBe(false);
    for (const id of ["modern", "xbox360"]) {
      expect(runsOnDirectCore(id, undefined)).toBe(false);
      expect(runsOnDirectCore(id, "direct")).toBe(true);
    }
    for (const id of ["classic", "pro", "portrait", "ps1", "n64"]) expect(runsOnDirectCore(id, "direct")).toBe(false);
  });

  it("finds the core beside the engine it is given, behind any base path", () => {
    expect(directCoreBeside("/cartbox/engine/xbox360/engine.js")).toBe("/cartbox/engine/modern-core/modern-core.js");
    expect(directCoreBeside("https://cdn.example/site/engine/tic80.js")).toBe("https://cdn.example/site/engine/modern-core/modern-core.js");
    expect(directCoreBeside(undefined)).toBe(DIRECT_CORE_URL);
    expect(directCoreBeside("blob:https://x/1234")).toBe(DIRECT_CORE_URL);
  });

  it("an exported AAA game carries the dedicated core", () => {
    expect(standaloneNeeds({ mesh: null, modelId: "aaa" }).direct).toBe(true);
    expect(standaloneNeeds({ mesh: null, modelId: "xbox360" }).direct).toBe(false);
    expect(standaloneNeeds({ mesh: '{"core":"direct"}', modelId: "modern" }).direct).toBe(true);
  });
});

describe("the tier's 2D layer", () => {
  it("is the HD cores' frame and layout, in the player and the editor", () => {
    const aaa = getModel("aaa");
    expect([aaa.width, aaa.height]).toEqual([1280, 720]);
    expect([aaa.width, aaa.height]).toEqual([MODELS.xbox360.width, MODELS.xbox360.height]);
    expect(RAM_LAYOUTS.aaa).toBe(RAM_LAYOUTS.xbox360);
    expect(aaa.engineUrl).toBe(DIRECT_CORE_URL);
    const spec = CONSOLE_MODELS.aaa;
    expect([spec.width, spec.height, spec.mapWidth, spec.screenWidth]).toEqual([1280, 720, 1280, 160]);
    expect(spec.id).toBe("aaa");
  });
});

describe.skipIf(!existsSync(CORE))("on the dedicated core", () => {
  it("boots at the tier's 2D size and draws into it (at the 1080p it declared before, the HD layout does not fit)", async () => {
    const mod = await (await import(pathToFileURL(CORE).href)).default();
    const console = createDirectConsole(mod, getModel("aaa"));
    const code = `function TIC() cls(1) rect(1270, 710, 10, 10, 12) end`;
    expect(console.loadCartridge(codeChunks(new TextEncoder().encode(code)))).toBe(true);
    console.tick(0);
    const frame = console.readFramebuffer();
    expect(frame.length).toBe(1280 * 720 * 4);
    const at = (x: number, y: number) => Array.from(frame.slice((y * 1280 + x) * 4, (y * 1280 + x) * 4 + 3));
    // The bottom-right corner is the rectangle's colour, the rest the cleared one: a 1280-wide frame, row for row.
    expect(at(1275, 715)).not.toEqual(at(10, 10));
    expect(at(1269, 715)).toEqual(at(10, 10));
    const again = await (await import(pathToFileURL(CORE).href)).default();
    const layout = RAM_LAYOUTS.aaa;
    expect(() =>
      wrapModernCore(again, { width: 1920, height: 1080, ram: { size: layout.ramSize, pmem: layout.pmemAddress }, host: { command: () => {}, query: () => null } }),
    ).toThrow();
  });
});

describe("a fresh AAA cart", () => {
  it("opens on Beaver Creek, on the tier", () => {
    expect(defaultStarterForModel("aaa")).toBe("aaa");
    expect(resolveStarterId("aaa")).toBe("aaa");
    expect(modelForStarter("aaa")).toBe("aaa");
    const starter = resolveStarter("aaa");
    expect(starter.id).toBe("aaa");
    expect(starter.mesh).toBe(arenaMap("beaver").sidecar());
  });
});
