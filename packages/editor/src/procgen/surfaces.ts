/**
 * The semantic surfaces a generator can produce — "this cell is grass", "this
 * one is bedrock" — and the vocabulary that lets a caller texture them.
 *
 * Generators must not know about any particular texture atlas: procgen is pure
 * and the atlas lives in the app. So a generator says only *what a cell is*, and
 * the caller supplies a {@link MaterialResolver} that turns that into whatever
 * material index its atlas uses. A caller with no atlas passes nothing and gets
 * flat colours, exactly as before.
 *
 * This is the same separation the class mapping already uses for tiles and
 * colours, applied to the third channel: generation decides meaning, the editor
 * decides appearance.
 */

/** A generated cell's surface. Stable string ids so an atlas can map them. */
export type SurfaceId =
  | "grass"
  | "forest"
  | "dirt"
  | "rock"
  | "sand"
  | "water"
  | "snow"
  | "brick"
  | "planks";

/** Every surface a generator may emit, for building and testing a resolver. */
export const SURFACE_IDS: readonly SurfaceId[] = [
  "grass",
  "forest",
  "dirt",
  "rock",
  "sand",
  "water",
  "snow",
  "brick",
  "planks",
];

/**
 * Turns a surface into a texture-material index for the caller's atlas. Return
 * a negative value to leave that cell flat — the right answer for a surface the
 * atlas has no art for.
 */
export type MaterialResolver = (surface: SurfaceId) => number;

/** The material index meaning "no material — render the flat colour". */
export const NO_MATERIAL = -1;

/** Resolve a surface, tolerating a missing resolver and a stray return value. */
export function resolveMaterial(resolver: MaterialResolver | undefined, surface: SurfaceId): number {
  if (!resolver) return NO_MATERIAL;
  const material = resolver(surface);
  return Number.isInteger(material) && material >= 0 ? material : NO_MATERIAL;
}
