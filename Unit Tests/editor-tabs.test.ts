/**
 * Editor tab gating.
 *
 * The tab list was a flat constant, so a 240x136 16-colour Classic cart opened
 * with World and Mesh editors beside its sprite sheet. Those author 3D scenes —
 * a later console model's job (see ERA_MODELS.md) — so a 2D model now hides
 * them.
 *
 * The rule that makes that safe is the one worth pinning: carts saved before
 * the gate existed may already carry mesh or world sidecars, so a spatial tab
 * also shows whenever the *cart* has content for it. These tests prove both
 * halves, and that the Ctrl+1..9 order can never address a hidden tab.
 *
 * The Files tab is gated on a second axis — the model's asset budget — and the
 * bottom half of this file covers it. It follows the same stranding rule for the
 * same reason: a cart that is already storing uploads has to be able to reach
 * them even when its model would no longer allow any.
 */

import { describe, expect, it } from "vitest";

import { ALL_TABS, SPATIAL_TABS, visibleTabs } from "../apps/web/src/app/edit/[cartId]/editorTabs";

/** No sidecar has content — a freshly created cart. */
const empty = () => false;

describe("visibleTabs", () => {
  it("hides the 3D authoring tabs on a 2D model with an empty cart", () => {
    const tabs = visibleTabs("raster2d", empty);
    expect(tabs.more).not.toContain("World");
    expect(tabs.more).not.toContain("Mesh");
  });

  it("keeps the 2D dressing tabs on a 2D model", () => {
    // Scene, Anim, Weather and FX dress a 2D frame (parallax backdrop, sprite
    // animation, weather over the playfield, a post-process pass), so they are
    // not gated — only the two that open an orbit camera are.
    const tabs = visibleTabs("raster2d", empty);
    expect(tabs.more).toEqual(["Scene", "Anim", "Weather", "FX"]);
  });

  it("shows every tab on a 3D model", () => {
    const tabs = visibleTabs("voxel3d", empty);
    expect(tabs.more).toContain("World");
    expect(tabs.more).toContain("Mesh");
  });

  it("keeps a spatial tab on a 2D model when that cart already has its data", () => {
    // The stranding case: a Classic cart saved before the gate existed. Losing
    // the tab would leave saved content with no way to reach or clear it.
    const withMesh = visibleTabs("raster2d", (sidecar) => sidecar === "mesh");
    expect(withMesh.more).toContain("Mesh");
    expect(withMesh.more).not.toContain("World");

    const withWorld = visibleTabs("raster2d", (sidecar) => sidecar === "world");
    expect(withWorld.more).toContain("World");
    expect(withWorld.more).not.toContain("Mesh");
  });

  it("preserves display order regardless of which tabs survive the gate", () => {
    const all = visibleTabs("voxel3d", empty);
    const gated = visibleTabs("raster2d", empty);
    // Filtering must not reorder: the More menu reads in a fixed order, and the
    // numeric shortcuts are assigned from that order.
    expect(gated.more).toEqual(all.more.filter((tab) => gated.more.includes(tab)));
  });

  it("orders shortcuts as the bar then the menu, so Ctrl+N never hits a hidden tab", () => {
    for (const kind of ["raster2d", "voxel3d"] as const) {
      const tabs = visibleTabs(kind, empty);
      expect(tabs.order).toEqual([...tabs.primary, ...tabs.more]);
      // Every addressable tab is one that actually renders.
      for (const tab of tabs.order.slice(0, 9)) {
        expect([...tabs.primary, ...tabs.more]).toContain(tab);
      }
    }
  });

  it("never hides a primary tab", () => {
    // The everyday five are what makes this a cart editor; no model drops them.
    const gated = visibleTabs("raster2d", empty);
    expect(gated.primary).toEqual(["Code", "Assets", "Map", "SFX", "Music"]);
  });

  it("accounts for every declared tab, given a model that unlocks all of them", () => {
    // Guards the failure where a tab is added to ALL_TABS but wired into
    // neither the bar nor the menu, so it exists in the type and renders never.
    //
    // A 3D model with an asset budget is the configuration that unlocks
    // everything. Both dimensions have to be exercised: gating Files on the
    // budget means a kind alone no longer shows the whole list, and checking
    // only the kind would let a budget-gated tab be unreachable and unnoticed.
    const shown = new Set(visibleTabs("voxel3d", empty, 1).order);
    for (const tab of ALL_TABS) {
      expect(shown.has(tab), tab).toBe(true);
    }
  });

  it("gates exactly the tabs that declare a 3D viewport", () => {
    // SPATIAL_TABS drives the small-screen notice and the workbench's
    // data-spatial attribute. If the two lists drifted apart, a tab would be
    // gated without the layout knowing, or vice versa.
    // Same budget on both sides, so the only difference is the rasteriser kind.
    const all = new Set(visibleTabs("voxel3d", empty, 1).order);
    const gated = new Set(visibleTabs("raster2d", empty, 1).order);
    const hidden = [...all].filter((tab) => !gated.has(tab));
    expect(new Set(hidden)).toEqual(SPATIAL_TABS);
  });
});

describe("the Files tab", () => {
  /**
   * Files uploads content that lives beside the cart rather than inside it, and
   * only a model with a non-zero asset budget can have any. On every
   * cartridge-only model the server refuses every upload, so offering the tab
   * would be offering a button that cannot work.
   */
  it("is hidden on a model with no asset budget", () => {
    expect(visibleTabs("raster2d", empty, 0).more).not.toContain("Files");
    expect(visibleTabs("voxel3d", empty, 0).more).not.toContain("Files");
  });

  it("appears once the model has a budget to spend", () => {
    expect(visibleTabs("raster2d", empty, 1).more).toContain("Files");
  });

  it("is keyed to the budget rather than to 3D", () => {
    // The gate is storage, not geometry. A 3D model with no budget has nowhere
    // to put an upload, and a 2D model with one does.
    expect(visibleTabs("voxel3d", empty, 0).more).not.toContain("Files");
    expect(visibleTabs("raster2d", empty, 1).more).toContain("Files");
  });

  it("stays reachable for a cart that already stores assets", () => {
    // The same stranding rule the spatial tabs follow. A cart whose model
    // changed, or whose budget was withdrawn, must still be able to see what it
    // is storing and remove it — otherwise it keeps paying for bytes it cannot
    // reach.
    const stranded = visibleTabs("raster2d", (content) => content === "assets", 0);
    expect(stranded.more).toContain("Files");
    // And only that tab: having assets says nothing about having a mesh.
    expect(stranded.more).not.toContain("Mesh");
    expect(stranded.more).not.toContain("World");
  });

  it("does not appear merely because a spatial sidecar has content", () => {
    // The content predicate now answers three questions, and wiring one to
    // another would show an upload panel on a cart that has never uploaded.
    const withMesh = visibleTabs("raster2d", (content) => content === "mesh", 0);
    expect(withMesh.more).toContain("Mesh");
    expect(withMesh.more).not.toContain("Files");
  });
});
