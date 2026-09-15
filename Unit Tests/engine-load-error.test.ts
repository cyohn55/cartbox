/**
 * Engine load failures name the engine that failed.
 *
 * The regression this pins cost a debugging session. A dynamic import that
 * cannot fetch its module rejects with the platform's bare network error —
 * WebKit's is literally `TypeError: Type error` — and the player rethrew it
 * untouched. The editor then showed "Failed to load: Type error", which says
 * nothing about *what* failed, and the report came from an iPad whose console
 * could not be opened. Several wrong theories followed.
 *
 * `fetchCartridge` had wrapped its own network errors with the URL from the
 * start. This is the other half of the load finally doing the same.
 */

import { describe, expect, it } from "vitest";

import { EngineLoadError, loadEngineModule } from "@cartbox/player";

describe("loadEngineModule", () => {
  it("names the engine and its URL when the module cannot be fetched", async () => {
    // A URL no import can resolve, standing in for the 404 or offline case.
    const url = "https://localhost.invalid/engine/nope/engine.js";
    const error = await loadEngineModule(url).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(EngineLoadError);
    expect((error as EngineLoadError).message).toContain(url);
    // The bare platform message on its own is what made this undebuggable.
    expect((error as EngineLoadError).message).not.toMatch(/^Type error$/);
  });

  it("keeps the original failure as `cause`, so nothing is lost", () => {
    // Wrapping must add context, not replace it: the platform's own error still
    // carries the distinction between a 404, an offline device and a parse
    // failure.
    const original = new TypeError("Type error");
    const wrapped = new EngineLoadError("Failed to load the engine module at /x.js", original);
    expect(wrapped.cause).toBe(original);
    expect(wrapped.name).toBe("EngineLoadError");
  });

  it("lets a later attempt retry rather than caching the failure", async () => {
    // The module cache is keyed by URL; a cached rejected promise would make one
    // transient network blip permanent for the life of the page.
    const url = "https://localhost.invalid/engine/retry/engine.js";
    const first = await loadEngineModule(url).catch((e: unknown) => e);
    const second = await loadEngineModule(url).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(EngineLoadError);
    expect(second).toBeInstanceOf(EngineLoadError);
    expect(second).not.toBe(first); // a fresh attempt, not the cached rejection
  });
});
