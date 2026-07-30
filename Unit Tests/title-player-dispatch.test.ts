/**
 * Unit tests for which player a catalog title mounts.
 *
 * The bug these pin down: /play/[cartId] rendered WasmGamePlayer for every
 * playable title, so the five iframe-hosted runtimes asked for
 * /games/<bundle>/game.js — a path that exists for none of them. Fourteen of the
 * seventeen catalog titles failed that way while Browse linked all of them there.
 *
 * Expected values are derived from the real catalog (demoTitles.ts) rather than
 * restated, so a title added later is covered without editing this file.
 *
 * Run with: npx vitest run "Unit Tests/title-player-dispatch.test.ts"
 */

import { describe, expect, it } from "vitest";

import { DEMO_TITLES } from "../apps/web/src/lib/demoTitles";
import {
  gamePlayerRuntime,
  isIframeHostedRuntime,
  RUNTIME_IDS,
  resolveRuntime,
} from "../apps/web/src/lib/titleRuntime";

describe("gamePlayerRuntime", () => {
  it("keeps each iframe-hosted runtime as itself", () => {
    for (const runtime of ["scummvm", "supertux", "dos", "quake", "cube2"]) {
      expect(gamePlayerRuntime({ runtime })).toBe(runtime);
    }
  });

  it("routes ABI titles to the wasm-app player", () => {
    expect(gamePlayerRuntime({ runtime: "wasm-app" })).toBe("wasm-app");
  });

  it("falls back to scummvm for rows written before the runtime column", () => {
    expect(gamePlayerRuntime({ runtime: null, scummvmTarget: "sky" })).toBe("scummvm");
  });

  it("prefers an explicit runtime over the legacy scummvm target", () => {
    expect(gamePlayerRuntime({ runtime: "dos", scummvmTarget: "sky" })).toBe("dos");
  });

  it("treats an unknown or absent runtime as the ABI rather than guessing", () => {
    // Guessing an iframe runtime here would mount a player whose bundle does not
    // exist; the ABI player at least reports a missing module clearly.
    expect(gamePlayerRuntime({ runtime: undefined })).toBe("wasm-app");
    expect(gamePlayerRuntime({ runtime: "libretro" })).toBe("wasm-app");
  });
});

describe("the real catalog", () => {
  const bundled = DEMO_TITLES.filter(
    (t) => t.assetSource === "bundled" && resolveRuntime(t.runtime)?.implemented,
  );

  it("has playable titles across more than just wasm-app", () => {
    const runtimes = new Set(bundled.map((t) => gamePlayerRuntime(t)));
    expect(runtimes.size).toBeGreaterThan(1);
    expect(runtimes).toContain("wasm-app");
  });

  it("routes the majority of playable titles away from the wasm-app player", () => {
    // The regression in one number: before the fix every one of these mounted
    // WasmGamePlayer, and only the wasm-app ones could possibly work.
    const iframeHosted = bundled.filter((t) => isIframeHostedRuntime(gamePlayerRuntime(t)));
    expect(iframeHosted.length).toBeGreaterThan(bundled.length / 2);
  });

  it("gives every shared-bundle title a launch target naming its game", () => {
    // DOSBox and ScummVM host many games from one bundle, so the player has
    // nothing to boot without this.
    for (const title of bundled) {
      const runtime = gamePlayerRuntime(title);
      if (runtime !== "dos" && runtime !== "scummvm") continue;
      const target = title.dosTarget ?? title.scummvmTarget;
      expect(target, `${title.name} has no launch target`).toBeTruthy();
    }
  });

  it("gives every playable title a bundle to load", () => {
    for (const title of bundled) {
      expect(title.bundleName, `${title.name} has no bundle`).toBeTruthy();
    }
  });
});

describe("isIframeHostedRuntime", () => {
  it("separates self-hosting engines from the ABI", () => {
    expect(isIframeHostedRuntime("wasm-app")).toBe(false);
    for (const runtime of ["scummvm", "supertux", "dos", "quake", "cube2"] as const) {
      expect(isIframeHostedRuntime(runtime)).toBe(true);
    }
  });

  it("covers every implemented non-Cartbox runtime the registry declares", () => {
    // A new ported runtime must be classified here or it silently falls to the
    // ABI player — the exact failure this test exists to prevent recurring.
    const ported = RUNTIME_IDS.filter(
      (id) => !id.startsWith("cartbox-") && resolveRuntime(id)?.implemented,
    );
    for (const id of ported) {
      const runtime = gamePlayerRuntime({ runtime: id });
      expect(runtime, `${id} is not mapped to a player`).toBeTruthy();
      if (id !== "wasm-app") expect(isIframeHostedRuntime(runtime)).toBe(true);
    }
  });
});
