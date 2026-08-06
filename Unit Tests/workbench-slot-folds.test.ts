/**
 * The wholesale slot folds layered onto the workbench layout.
 *
 * Two invariants keep the declutter honest: every folded slot must name a real
 * slot (a typo would silently fold nothing), and folding must not disturb the
 * canonical ordering a tab's controls are rendered in — the fold wraps a slot's
 * content, it does not reorder the slots.
 */

import { describe, expect, it } from "vitest";

import {
  INSPECTOR_SLOTS,
  INSPECTOR_SLOT_FOLDS,
  RAIL_SLOTS,
  RAIL_SLOT_FOLDS,
  orderedSlots,
} from "../apps/web/src/app/edit/[cartId]/workbenchLayout";

describe("slot folds", () => {
  it("only fold slots that exist in the canonical order", () => {
    for (const slot of Object.keys(RAIL_SLOT_FOLDS)) {
      expect(RAIL_SLOTS).toContain(slot);
    }
    for (const slot of Object.keys(INSPECTOR_SLOT_FOLDS)) {
      expect(INSPECTOR_SLOTS).toContain(slot);
    }
  });

  it("give every folded slot a non-empty heading", () => {
    for (const fold of [...Object.values(RAIL_SLOT_FOLDS), ...Object.values(INSPECTOR_SLOT_FOLDS)]) {
      expect(fold?.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("tie preview-only lighting to the density but leave import/export always foldable", () => {
    // Lighting never touches the saved cart, so it follows Simple/Full; io is a
    // rare verb the creator reaches for deliberately, so it rests folded either way.
    expect(RAIL_SLOT_FOLDS.lighting?.advanced).toBe(true);
    expect(RAIL_SLOT_FOLDS.io?.advanced).toBeFalsy();
  });

  it("do not change the order slots render in", () => {
    // A tab filling io (folded) and tool (not) still gets tool before io, exactly
    // as the canonical order dictates — the fold is a wrapper, not a reordering.
    const ordered = orderedSlots(RAIL_SLOTS, { io: "leave", tool: "draw", view: "vantage" });
    expect(ordered.map((entry) => entry.slot)).toEqual(["view", "tool", "io"]);
  });
});
