"use client";

/**
 * How a preview shades a surface, and which channel it shows.
 *
 * Two orthogonal choices, shared by both GPU previews (the Map tab's 3D view and
 * the sprite lit preview) so the two never drift into offering different words
 * for the same thing.
 *
 * The vocabulary is ported from the Shade Studio shader library, where the
 * technical-illustration shaders and the AOV (arbitrary output variable) views
 * exist for the same reason they do here: judging a surface by the lit image
 * alone means judging every channel at once, through one particular light, and
 * being unable to tell which of them is wrong.
 */

/**
 * How a surface turns its inputs into colour.
 *
 * `lit` is the world's real answer and what a cart actually ships. The others
 * are authoring views: `matcap` shades from the view-space normal alone, so the
 * light never moves as you orbit and the *shape* of a model is what you are
 * looking at; `gooch` is the technical-illustration model, warm toward the light
 * and cool away from it, which keeps unlit faces readable instead of black —
 * useful precisely when the thing being judged is geometry, not lighting.
 */
export type ShadingModel = "lit" | "matcap" | "gooch";

/**
 * A single material channel, shown on its own.
 *
 * Every channel in the G-buffer is authorable — the Material layer paints all of
 * them — and until now none of them was *inspectable*: the only way to see what a
 * roughness value did was to light the scene and infer. These render the channel
 * directly, which is the difference between debugging a normal map and guessing
 * at one.
 */
export type MaterialChannelView =
  | "shaded"
  | "albedo"
  | "normal"
  | "height"
  | "specular"
  | "roughness"
  | "emissive"
  | "depth";

/** Shader-side ids. The order is the wire format and must match the WGSL. */
export const SHADING_MODEL_IDS: Readonly<Record<ShadingModel, number>> = { lit: 0, matcap: 1, gooch: 2 };

export const CHANNEL_VIEW_IDS: Readonly<Record<MaterialChannelView, number>> = {
  shaded: 0,
  albedo: 1,
  normal: 2,
  height: 3,
  specular: 4,
  roughness: 5,
  emissive: 6,
  depth: 7,
};

/** An option a picker can render, without knowing what it selects. */
export interface ShadingOption<Id extends string> {
  readonly id: Id;
  readonly label: string;
  readonly hint: string;
}

export const SHADING_MODELS: readonly ShadingOption<ShadingModel>[] = [
  { id: "lit", label: "Lit", hint: "The scene's own lighting — what the cart will show." },
  { id: "matcap", label: "Matcap", hint: "Studio light welded to the camera, for reading shape." },
  { id: "gooch", label: "Gooch", hint: "Warm-to-cool illustration shading; nothing goes black." },
];

export const CHANNEL_VIEWS: readonly ShadingOption<MaterialChannelView>[] = [
  { id: "shaded", label: "Shaded", hint: "The composed, lit image." },
  { id: "albedo", label: "Albedo", hint: "Flat colour, with no lighting at all." },
  { id: "normal", label: "Normal", hint: "Surface direction, as a normal-map colour." },
  { id: "height", label: "Height", hint: "Relief, black at the lowest point." },
  { id: "specular", label: "Specular", hint: "How strong a highlight each texel returns." },
  { id: "roughness", label: "Roughness", hint: "How broadly each texel scatters that highlight." },
  { id: "emissive", label: "Emissive", hint: "Which texels light themselves." },
  { id: "depth", label: "Depth", hint: "Distance from the eye, near white to far black." },
];

/** A rim term added on top of whichever shading model is running. */
export interface RimOptions {
  /** 0 switches it off. */
  readonly strength: number;
  /** How tightly the rim hugs the silhouette; higher is thinner. */
  readonly power: number;
}

/** The two Gooch coefficients: how much of the albedo bleeds into each tint. */
export interface GoochOptions {
  readonly cool: number;
  readonly warm: number;
}

export const DEFAULT_RIM: RimOptions = { strength: 0, power: 3 };
export const DEFAULT_GOOCH: GoochOptions = { cool: 0.25, warm: 0.5 };

/** Whether a channel view is isolating a channel rather than showing the scene. */
export function isChannelIsolated(channel: MaterialChannelView | undefined): boolean {
  return (channel ?? "shaded") !== "shaded";
}

/** The explanatory line for a shading model. */
export function shadingHint(id: ShadingModel): string {
  return SHADING_MODELS.find((option) => option.id === id)?.hint ?? "";
}

/**
 * The explanatory line for a channel view, or null when nothing is isolated —
 * so a caller can fall back to describing the shading model instead of showing
 * "the composed, lit image", which the viewer can already see.
 */
export function channelHint(id: MaterialChannelView): string | null {
  if (!isChannelIsolated(id)) return null;
  return CHANNEL_VIEWS.find((option) => option.id === id)?.hint ?? null;
}
