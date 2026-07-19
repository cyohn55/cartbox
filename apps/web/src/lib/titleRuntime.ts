/**
 * Runtime registry for catalog titles.
 *
 * A catalog entry names the player implementation that runs it. Rather than
 * branching on that string wherever a title is played, each runtime registers a
 * descriptor here and the title page dispatches through one interface. This is
 * the extensibility seam the later Browse phases plug into: bundled open-source
 * games (Phase 2) and user-supplied-asset source ports (Phase 3) add runtimes
 * without touching the pages that host them.
 *
 * Descriptors are metadata only — deliberately free of DOM or WASM imports — so
 * server components can read them while the heavy player module stays lazy.
 */

import type { ConsoleModelId } from "@cartbox/editor";

/** Every player implementation the catalog can dispatch to. */
export const RUNTIME_IDS = [
  "cartbox-classic",
  "cartbox-pro",
  "wasm-app",
  "scummvm",
  "supertux",
  "dos",
  "libretro",
] as const;

export type RuntimeId = (typeof RUNTIME_IDS)[number];

/** Where a title's playable data comes from. */
export type AssetSource = "bundled" | "user-supplied" | "freeware-fetch";

/** Content tier; see the roadmap's distribution rule. */
export type ContentTier = "A" | "B" | "C";

export interface RuntimeDescriptor {
  id: RuntimeId;
  /** Shown on the Browse filter chips. */
  label: string;
  /**
   * Whether the runtime is implemented today. Phase 1 ships the registry and the
   * Cartbox runtimes that already exist; the rest are declared so catalog rows
   * and filters can be authored and tested before their players land.
   */
  implemented: boolean;
  /**
   * The Cartbox console model this runtime maps to, when it is one of ours.
   * Non-Cartbox runtimes have no console model.
   */
  consoleModel?: ConsoleModelId;
}

const DESCRIPTORS: Record<RuntimeId, RuntimeDescriptor> = {
  "cartbox-classic": {
    id: "cartbox-classic",
    label: "Cartbox Classic",
    implemented: true,
    consoleModel: "classic",
  },
  "cartbox-pro": {
    id: "cartbox-pro",
    label: "Cartbox Pro",
    implemented: true,
    consoleModel: "pro",
  },
  "wasm-app": { id: "wasm-app", label: "Open source", implemented: true },
  scummvm: { id: "scummvm", label: "Adventure", implemented: true },
  supertux: { id: "supertux", label: "Platformer", implemented: true },
  dos: { id: "dos", label: "DOS", implemented: false },
  libretro: { id: "libretro", label: "Console", implemented: false },
};

export function isRuntimeId(value: string): value is RuntimeId {
  return (RUNTIME_IDS as readonly string[]).includes(value);
}

/**
 * Resolves a runtime id from untrusted input (a URL query param or a database
 * column). Returns undefined rather than a fallback: an unknown runtime must
 * surface as "cannot play this" instead of silently booting the wrong engine.
 */
export function resolveRuntime(value: string | null | undefined): RuntimeDescriptor | undefined {
  return value && isRuntimeId(value) ? DESCRIPTORS[value] : undefined;
}

export function runtimeDescriptors(): RuntimeDescriptor[] {
  return RUNTIME_IDS.map((id) => DESCRIPTORS[id]);
}

/** Runtimes that can actually be played today — the rest are declared-only. */
export function implementedRuntimes(): RuntimeDescriptor[] {
  return runtimeDescriptors().filter((runtime) => runtime.implemented);
}

/**
 * Whether playing this title requires the user to supply their own game data.
 * Tier C ships the engine only, so the title page must route to the asset-supply
 * flow (Phase 3) instead of straight to the player.
 */
export function requiresUserAssets(assetSource: AssetSource): boolean {
  return assetSource === "user-supplied";
}
