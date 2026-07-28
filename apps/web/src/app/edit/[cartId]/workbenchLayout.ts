/**
 * Where a control goes, decided once for every tab.
 *
 * The workbench has always had the same three zones — tool rail, stage,
 * inspector — but nothing said *what belongs in which*, so each tab answered
 * independently and the answers disagreed. The voxel sculptor put its material
 * picker in the left rail while the map editor put the same picker in the right
 * inspector; the sprite editor's tile navigator sat at the top of its inspector
 * while the map's sat at the bottom; "Zoom" appeared second-from-last in one tab
 * and not at all in another. Every one of those is a small decision made twice,
 * and the cost lands on the person switching tabs, who has to re-learn where
 * things are.
 *
 * So the order is data, not convention. A tab hands its controls in as a record
 * keyed by slot and gets them back in canonical order — it cannot render them in
 * its own order, because it never controls the order at all. Adding a control is
 * choosing its slot; the position follows.
 *
 * Pure data and one ordering function: no React, no DOM, so the contract every
 * tab is held to can be asserted directly.
 */

/**
 * The rail answers "how am I editing?" — the verbs and their modifiers, in the
 * order the hand reaches for them: pick a vantage, pick a layer, pick a tool,
 * adjust it, act on what you selected, then the surroundings.
 */
export const RAIL_SLOTS = [
  /** The vantage or lattice the surface is shown in — page, 2D/3D, cube/hex. */
  "view",
  /** Which channel or layer of the surface the tools write to. */
  "layer",
  /** The tool rail itself. */
  "tool",
  /** Settings the active tool drives: brush size, tolerance, shape, step. */
  "toolOptions",
  /** Actions on the current selection. Absent when nothing is selected. */
  "selection",
  /** The surface's own settings rather than the tool's: grid size, zoom, camera. */
  "canvas",
  /** Preview lighting. Never affects what is saved. */
  "lighting",
  /** Import, export, publish, clear — the actions that leave the tab. */
  "io",
] as const;

export type RailSlot = (typeof RAIL_SLOTS)[number];

/**
 * The inspector answers "what am I editing with?" — the nouns, narrowing from
 * the art you are pointed at, to what you paint it with, to what it looks like.
 * The hint is last everywhere because it explains the rest.
 */
export const INSPECTOR_SLOTS = [
  /** The art the tools draw from or into: tile navigator, sprite pad. */
  "source",
  /** The colour palette. Present in every tab that paints anything. */
  "palette",
  /** The material or surface profile painted alongside the colour. */
  "material",
  /** Lit and dimensional previews of the work. */
  "preview",
  /** Procedural generation. */
  "generate",
  /** Tab-specific extras with no counterpart elsewhere — the character rig. */
  "extras",
  /** One paragraph explaining what the active tool does here. */
  "hint",
] as const;

export type InspectorSlot = (typeof INSPECTOR_SLOTS)[number];

/** A tab's contributions, by slot. Every slot is optional — most tabs fill few. */
export type SlotContent<Slot extends string, Content> = Partial<Record<Slot, Content>>;

/**
 * Whether a slot was left empty.
 *
 * `null` and `false` count as empty alongside a missing key, because that is
 * what a conditional slot (`selection.size > 0 && <SelectionGroup/>`) evaluates
 * to when its condition fails. Deliberately not a type predicate: narrowing a
 * generic by these values leaves the caller unable to prove what survived, and
 * the caller already knows — it is whatever it put in.
 */
function isEmptySlot(content: unknown): boolean {
  return content === undefined || content === null || content === false;
}

/** A slot that a tab actually filled, paired with what went in it. */
export interface FilledSlot<Slot extends string, Content> {
  readonly slot: Slot;
  readonly content: Content;
}

/**
 * The filled slots, in canonical order.
 *
 * Empty slots are dropped rather than rendered blank, so a tab that has no
 * lighting simply has no lighting group — and the groups it does have still sit
 * in the same relative order as every other tab's. See {@link isEmptySlot} for
 * what counts as empty.
 */
export function orderedSlots<Slot extends string, Content>(
  order: readonly Slot[],
  filled: SlotContent<Slot, Content>,
): FilledSlot<Slot, Content>[] {
  const result: FilledSlot<Slot, Content>[] = [];
  for (const slot of order) {
    const content = filled[slot];
    if (content === undefined || isEmptySlot(content)) continue;
    result.push({ slot, content });
  }
  return result;
}
