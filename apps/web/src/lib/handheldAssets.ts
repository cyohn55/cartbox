/**
 * URLs for the shipped handheld art. The files have stable names
 * (`/handheld/base.png`, `mask.png`, `handheld-layout.json`, previews, the
 * `.aseprite` template), so browsers and the Pages CDN cache them hard. Suffix
 * every request with a revision that is bumped whenever the art is re-extracted,
 * so a redeploy actually reaches devices instead of serving a stale skin.
 */

import { withBasePath } from "./staticSite";

/**
 * Bump this whenever `apps/web/public/handheld/*` is regenerated (re-run of
 * extract-handheld / measure-handheld-layout). Any value that changes works;
 * a date-stamp keeps it legible.
 */
export const HANDHELD_ASSET_REV = "20260716a";

/** A cache-busted URL for a handheld asset (path under `/public`). */
export function handheldAssetUrl(pathFromPublic: string): string {
  const url = withBasePath(pathFromPublic);
  return `${url}${url.includes("?") ? "&" : "?"}v=${HANDHELD_ASSET_REV}`;
}
