/**
 * Which editor tabs a cart actually gets.
 *
 * The tab list used to be a flat constant, so every cart was offered every tab:
 * a 240x136, 16-colour Classic cart opened with World and Mesh editors beside
 * its sprite sheet. Those two tabs author 3D scenes, which is a later console
 * model's job — see ERA_MODELS.md — and showing them on a 2D model makes the
 * fantasy console read as a general 3D engine that happens to have a sprite
 * editor.
 *
 * Gating them on the model alone would strand data, because carts saved before
 * this existed may already carry mesh or world sidecars. So a spatial tab shows
 * when the *model* renders 3D, or when the *cart* already has content for it.
 * A Classic cart with a saved mesh keeps its Mesh tab and can still empty it;
 * once emptied and reloaded, the tab is gone. Nothing becomes unreachable.
 *
 * The Files tab is gated the same way for the same reason. It uploads content
 * that lives *beside* the cart rather than inside it, which only a model with a
 * non-zero `assetBudgetBytes` can have — so on every cartridge-only model the
 * tab would be an upload button whose every upload the server refuses. It still
 * appears when the cart already carries assets, so a cart whose model changed
 * can always reach what it is storing.
 *
 * Pure and prop-free so the rule is unit-testable without mounting the editor.
 */

import type { RasterKind } from "@cartbox/editor";

export const ALL_TABS = [
  "Code",
  "Assets",
  "Map",
  "World",
  "Scene",
  "Mesh",
  "Anim",
  "Weather",
  "FX",
  "Files",
  "SFX",
  "Music",
] as const;
export type Tab = (typeof ALL_TABS)[number];

/**
 * Display metadata for a tab: the label a creator reads, and a small glyph that
 * gives an otherwise all-text strip a visual anchor.
 *
 * This is deliberately separate from the tab *id* (the ALL_TABS string), which
 * is what every bit of logic keys off — the gating above, the canonical order,
 * the Ctrl+1..9 shortcuts, and the editor-tabs tests. So the wording can be made
 * friendlier without touching any of that: the five spatially adjacent concepts
 * a newcomer cannot tell apart — Map, Scene, World, Mesh — are the ones that earn
 * a clearer name (`Scene` reads as "Backdrop"; `World` as "3D World") as well as
 * a glyph.
 */
export const TAB_META: Record<Tab, { label: string; icon: string }> = {
  Code: { label: "Code", icon: "⌨" },
  Assets: { label: "Assets", icon: "▧" },
  Map: { label: "Map", icon: "▦" },
  World: { label: "3D World", icon: "⬢" },
  Scene: { label: "Backdrop", icon: "▤" },
  Mesh: { label: "Mesh", icon: "◈" },
  Anim: { label: "Anim", icon: "▷" },
  Weather: { label: "Weather", icon: "☁" },
  FX: { label: "FX", icon: "✦" },
  Files: { label: "Files", icon: "⭳" },
  SFX: { label: "SFX", icon: "♪" },
  Music: { label: "Music", icon: "♫" },
};

/**
 * The everyday five sit on the bar; the cinematic/3D set — reached rarely, and
 * never before there is art to dress — tucks into a "More" menu so a cart opens
 * looking like a fantasy-console editor, not a flight deck.
 */
const PRIMARY: readonly Tab[] = ["Code", "Assets", "Map", "SFX", "Music"];
const MORE: readonly Tab[] = ["World", "Scene", "Mesh", "Anim", "Weather", "FX", "Files"];

/**
 * Tabs that author a 3D scene, keyed to the sidecar that holds their content.
 * These are the ones a 2D model hides. The remaining "More" tabs (Scene, Anim,
 * Weather, FX) dress a 2D frame — a parallax backdrop, a sprite animation,
 * weather over the playfield, a post-process pass — so they stay everywhere.
 */
const SPATIAL: Readonly<Record<"World" | "Mesh", "world" | "mesh">> = {
  World: "world",
  Mesh: "mesh",
};

/**
 * Content a cart can hold that is not part of the tab's own sidecar: the
 * uploaded assets stored beside the cart and referenced by hash.
 *
 * This is a different thing from the Assets tab, which authors sprites and
 * sculpts *inside* the cartridge. These are files too big for a cartridge to
 * hold at all — see ERA_MODELS.md §5.2 — and only a model with an asset budget
 * can have any.
 */
export type CartContent = "world" | "mesh" | "assets";

/** Tabs whose stage is a 3D viewport with its own orbit camera. */
export const SPATIAL_TABS: ReadonlySet<Tab> = new Set<Tab>(
  Object.keys(SPATIAL) as Tab[],
);

export interface VisibleTabs {
  primary: readonly Tab[];
  more: readonly Tab[];
  /** Ctrl+1..9 order: the bar, then the More menu, as displayed. */
  order: readonly Tab[];
}

/**
 * Resolves the tab set for one cart.
 *
 * @param kind              The model's rasteriser family; anything but
 *                          `raster2d` authors 3D and keeps the spatial tabs
 *                          unconditionally.
 * @param hasContent        Whether the cart already carries a given kind of
 *                          content.
 * @param assetBudgetBytes  The model's asset allowance. Zero on every
 *                          cartridge-only model, which is most of them.
 */
export function visibleTabs(
  kind: RasterKind,
  hasContent: (content: CartContent) => boolean,
  assetBudgetBytes = 0,
): VisibleTabs {
  const spatial = kind !== "raster2d";
  const more = MORE.filter((tab) => {
    if (tab === "Files") return assetBudgetBytes > 0 || hasContent("assets");
    const sidecar = SPATIAL[tab as keyof typeof SPATIAL];
    return sidecar === undefined || spatial || hasContent(sidecar);
  });
  return { primary: PRIMARY, more, order: [...PRIMARY, ...more] };
}
