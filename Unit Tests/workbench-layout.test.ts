/**
 * The workbench's cross-tab layout contract.
 *
 * The complaint these tests exist for was that the same control lived in a
 * different place depending on which tab you were in — the material picker in
 * the left rail of the sculptor and the right inspector of the map, the tile
 * navigator at opposite ends of two inspectors. The fix was to stop letting each
 * tab choose: a tab hands its controls in keyed by slot and the shared container
 * emits them in one canonical order.
 *
 * So what is worth testing is exactly that property — that the order a tab
 * *supplies* its controls in cannot change the order they come out in, and that
 * a tab which fills only some slots still lands the ones it fills in the same
 * relative positions as every other tab. These drive the real exported slot
 * orders and the real ordering function, and the material-palette assertions
 * drive the shipping options table, not fixtures: the point is that the tabs are
 * consistent, and a fixture would prove nothing about the tabs.
 */

import { describe, expect, it } from "vitest";

import { COLUMN_MATERIAL_NONE, MATERIAL_NONE } from "@cartbox/editor";

import {
  INSPECTOR_SLOTS,
  RAIL_SLOTS,
  orderedSlots,
  type InspectorSlot,
  type RailSlot,
} from "../apps/web/src/app/edit/[cartId]/workbenchLayout";
import {
  FLAT_OPTION,
  MATERIAL_OPTIONS,
  NO_MATERIAL,
  materialOptionLabel,
} from "../apps/web/src/app/edit/[cartId]/materialPalette";
import { MAP_SPRITE_MATERIAL_BASE, spriteTileMaterial } from "../apps/web/src/lib/mapAtlas";
import { BUILD_MATERIALS } from "../apps/web/src/lib/faceTextures";

/** The slots a tab filled, in the order the ordering function emitted them. */
function slotOrder<Slot extends string>(
  order: readonly Slot[],
  filled: Partial<Record<Slot, unknown>>,
): Slot[] {
  return orderedSlots(order, filled).map((entry) => entry.slot);
}

describe("slot ordering", () => {
  it("emits rail slots in canonical order however the tab supplied them", () => {
    // Supplied deliberately backwards: a tab that writes its controls out in its
    // own preferred sequence must not get that sequence back.
    const supplied: Partial<Record<RailSlot, string>> = {};
    for (const slot of [...RAIL_SLOTS].reverse()) supplied[slot] = slot;

    expect(slotOrder(RAIL_SLOTS, supplied)).toEqual([...RAIL_SLOTS]);
  });

  it("emits inspector slots in canonical order however the tab supplied them", () => {
    const supplied: Partial<Record<InspectorSlot, string>> = {};
    for (const slot of [...INSPECTOR_SLOTS].reverse()) supplied[slot] = slot;

    expect(slotOrder(INSPECTOR_SLOTS, supplied)).toEqual([...INSPECTOR_SLOTS]);
  });

  it("keeps two tabs that fill different slots in agreement on the ones they share", () => {
    // The sprite editor has no lighting and no selection group; the sculptor has
    // both. Whatever else differs, every slot they have in common must appear in
    // the same relative order in each.
    const spriteLike = slotOrder(RAIL_SLOTS, { view: 1, layer: 1, tool: 1, toolOptions: 1, io: 1 });
    const sculptorLike = slotOrder(RAIL_SLOTS, {
      view: 1,
      tool: 1,
      toolOptions: 1,
      selection: 1,
      canvas: 1,
      lighting: 1,
      io: 1,
    });

    const shared = spriteLike.filter((slot) => sculptorLike.includes(slot));
    expect(shared).toEqual(sculptorLike.filter((slot) => spriteLike.includes(slot)));
    // And specifically: the tool rail precedes its options, which precede the
    // actions that leave the tab, in both.
    for (const order of [spriteLike, sculptorLike]) {
      expect(order.indexOf("tool")).toBeLessThan(order.indexOf("toolOptions"));
      expect(order.indexOf("toolOptions")).toBeLessThan(order.indexOf("io"));
    }
  });

  it("drops slots a tab left unfilled rather than emitting a gap", () => {
    expect(slotOrder(RAIL_SLOTS, { tool: "rail", io: "actions" })).toEqual(["tool", "io"]);
  });

  it("treats a failed conditional slot as unfilled", () => {
    // `selection.size > 0 && <Group/>` evaluates to `false`, and a conditional
    // panel that resolves to null must not render an empty container either.
    expect(slotOrder(RAIL_SLOTS, { tool: "rail", selection: false, canvas: null })).toEqual(["tool"]);
  });

  it("puts the palette above the material picker in every tab", () => {
    // The user-visible half of the fix: colour and material are one decision, so
    // they are adjacent and always in the same order, in whichever tab has both.
    const palette = INSPECTOR_SLOTS.indexOf("palette");
    const material = INSPECTOR_SLOTS.indexOf("material");
    expect(palette).toBeGreaterThanOrEqual(0);
    expect(material).toBe(palette + 1);
  });

  it("closes every inspector with the hint", () => {
    expect(INSPECTOR_SLOTS[INSPECTOR_SLOTS.length - 1]).toBe("hint");
  });

  it("names each slot exactly once", () => {
    expect(new Set(RAIL_SLOTS).size).toBe(RAIL_SLOTS.length);
    expect(new Set(INSPECTOR_SLOTS).size).toBe(INSPECTOR_SLOTS.length);
  });
});

describe("shared material palette", () => {
  it("agrees with both editors' own 'no material' constants", () => {
    // The sculptor and the map each had their own name for it. One picker now
    // serves both, so the three have to be the same number.
    expect(NO_MATERIAL).toBe(MATERIAL_NONE);
    expect(NO_MATERIAL).toBe(COLUMN_MATERIAL_NONE);
  });

  it("offers flat first, then every build material, with no duplicates", () => {
    expect(MATERIAL_OPTIONS[0]).toEqual(FLAT_OPTION);
    expect(MATERIAL_OPTIONS.length).toBe(BUILD_MATERIALS.length + 1);

    const values = MATERIAL_OPTIONS.map((option) => option.material);
    expect(new Set(values).size).toBe(values.length);
  });

  it("marks only the flat chip as flat, and gives every other chip a swatch", () => {
    const flat = MATERIAL_OPTIONS.filter((option) => option.flat);
    expect(flat).toHaveLength(1);
    for (const option of MATERIAL_OPTIONS) {
      if (option.flat) expect(option.swatch).toBeNull();
      else expect(option.swatch).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("reads a build material back by name", () => {
    const grass = BUILD_MATERIALS.find((entry) => entry.name === "grass");
    expect(grass).toBeDefined();
    expect(materialOptionLabel(grass!.material, 256)).toBe("grass");
  });

  it("reads a sprite skin back as the sprite it is", () => {
    expect(materialOptionLabel(spriteTileMaterial(12), 256)).toBe("sprite #12");
  });

  it("reads no material, and an index the atlas has lost, as flat", () => {
    expect(materialOptionLabel(NO_MATERIAL, 256)).toBe("flat");
    // Between the last build material and the first sprite skin: a real index
    // once, meaningless now. A readout is not the place to fail.
    const orphan = MAP_SPRITE_MATERIAL_BASE - 1;
    expect(BUILD_MATERIALS.some((entry) => entry.material === orphan)).toBe(false);
    expect(materialOptionLabel(orphan, 256)).toBe("flat");
  });
});
