/**
 * The editor's control-density defaulting rule.
 *
 * `resolveGroupOpen` decides whether a foldable rail group starts open, and the
 * whole declutter leans on it getting three cases right: an explicit request
 * always wins, an advanced group otherwise tracks the Simple/Full density, and a
 * plain collapsible group rests closed. It is pure by design so the rule can be
 * asserted directly rather than only through a mounted React tree.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_DENSITY,
  resolveGroupOpen,
  type EditorDensity,
} from "../apps/web/src/app/edit/[cartId]/editorDensity";

describe("resolveGroupOpen", () => {
  it("defaults new creators to the calm, Simple density", () => {
    // The whole point of the feature: a cart opens folded, not fully unpacked.
    expect(DEFAULT_DENSITY).toBe<EditorDensity>("simple");
  });

  it("honours an explicit defaultOpen over everything else", () => {
    for (const density of ["simple", "full"] as const) {
      expect(resolveGroupOpen(density, { defaultOpen: true })).toBe(true);
      expect(resolveGroupOpen(density, { defaultOpen: false })).toBe(false);
      // Even an advanced group yields to a pinned state.
      expect(resolveGroupOpen(density, { advanced: true, defaultOpen: false })).toBe(false);
    }
  });

  it("folds advanced groups in Simple and opens them in Full", () => {
    expect(resolveGroupOpen("simple", { advanced: true })).toBe(false);
    expect(resolveGroupOpen("full", { advanced: true })).toBe(true);
  });

  it("rests a plain collapsible group closed regardless of density", () => {
    // A group that is collapsible but not advanced (the io/generate slot folds)
    // carries neither advanced nor defaultOpen, so it stays folded until clicked.
    expect(resolveGroupOpen("simple", {})).toBe(false);
    expect(resolveGroupOpen("full", {})).toBe(false);
  });
});
