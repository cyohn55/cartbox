/**
 * Web-app console-model helpers: validate an untrusted model id (URL param or
 * DB column) and map it to the WASM engine that serves it. Kept in the web app
 * (not imported from @cartbox/editor) so server components and API routes stay
 * free of the editor package's client/DOM code; only the ConsoleModelId *type*
 * is borrowed, and types are erased at compile time.
 */

import type { ConsoleModelId } from "@cartbox/editor";

import { withBasePath } from "./staticSite";

/**
 * Models a user can actually author in today. "voxel" is a defined spec but has
 * no built engine, so it is deliberately excluded — an unknown or unsupported
 * value resolves to "classic".
 */
export const SELECTABLE_MODEL_IDS: readonly ConsoleModelId[] = ["classic", "pro", "portrait"];

export function resolveModelId(value: string | null | undefined): ConsoleModelId {
  return SELECTABLE_MODEL_IDS.includes(value as ConsoleModelId) ? (value as ConsoleModelId) : "classic";
}

/**
 * Short badge naming a cart's model on a grid card. Derived from the model id
 * rather than tested against one of them, so a new model shows its own name
 * instead of silently reading as Classic.
 */
const MODEL_BADGES: Record<ConsoleModelId, string> = {
  classic: "CLASSIC",
  pro: "PRO",
  portrait: "PORTRAIT",
  voxel: "VOXEL",
};

export function modelBadge(value: string | null | undefined): string {
  return MODEL_BADGES[resolveModelId(value)];
}

/**
 * The WASM engine URL for each model. Each model runs on its own core (the
 * side-by-side compatibility architecture), so the editor loads a different
 * binary per model. Overridable via env for non-default deployments.
 */
export const ENGINE_URL_BY_MODEL: Record<ConsoleModelId, string> = {
  classic: withBasePath(process.env.NEXT_PUBLIC_ENGINE_URL ?? "/engine/tic80.js"),
  pro: withBasePath(process.env.NEXT_PUBLIC_PRO_ENGINE_URL ?? "/engine/pro/engine.js"),
  // Portrait is Pro's spec transposed, but the dimensions are compile-time
  // constants in the core, so it is a separate binary rather than a mode of pro.
  portrait: withBasePath(
    process.env.NEXT_PUBLIC_PORTRAIT_ENGINE_URL ?? "/engine/portrait/engine.js",
  ),
  // No voxel engine yet; falls back to classic so the type stays total.
  voxel: withBasePath(process.env.NEXT_PUBLIC_ENGINE_URL ?? "/engine/tic80.js"),
};
