/**
 * Baked-in catalog titles for the static "demo" build.
 *
 * Mirrors what the `titles` table holds, the way demoCatalog.ts mirrors `carts`.
 * The static build has no server, so Browse reads this list instead of Supabase
 * when `isStaticExport` is set.
 *
 * These seed rows are Tier A/B entries whose runtimes are declared but not yet
 * implemented (Phase 2 builds the players). They exist so the unified grid, the
 * runtime filter, and the title page's "runtime not available" path are exercised
 * by real data before any game is packaged.
 */

import type { CatalogEntry } from "./catalog";
import { withBasePath } from "./staticSite";
import type { AssetSource, ContentTier, RuntimeId } from "./titleRuntime";

export interface DemoTitle {
  id: string;
  slug: string;
  name: string;
  description: string;
  runtime: RuntimeId;
  assetSource: AssetSource;
  tier: ContentTier;
  license: string;
  sourceUrl: string;
  /**
   * Directory under public/games holding the compiled game (game.js + game.wasm),
   * for bundled titles the console can run today. Absent while a title is
   * catalogued but not yet ported.
   */
  bundleName?: string;
  /** Native resolution the game is initialised at. */
  width?: number;
  height?: number;
  /** Drives the newest-first merge with carts. */
  releasedAt: string;
}

export const DEMO_TITLES: readonly DemoTitle[] = [
  {
    id: "00000000-0000-4000-9000-000000000004",
    slug: "collector",
    name: "Collector",
    description:
      "A compact arcade game built directly against the Cartbox Game ABI: gather the green pickups, avoid the red hazards. Ships with the console, source included.",
    runtime: "wasm-app",
    assetSource: "bundled",
    tier: "A",
    license: "mit",
    sourceUrl: "https://github.com/cyohn55/cartbox",
    releasedAt: "2026-07-16T00:00:00.000Z",
    bundleName: "reference",
    width: 320,
    height: 180,
  },
  {
    id: "00000000-0000-4000-9000-000000000005",
    slug: "doom",
    name: "Doom",
    description:
      "The 1993 shooter that defined the genre, running on the original id Software engine with Freedoom's own freely licensed levels, monsters and weapons. Engine and assets are both free software, so the whole game ships with the console.",
    runtime: "wasm-app",
    assetSource: "bundled",
    tier: "A",
    // The engine is GPL-2 (doomgeneric, from id's own source release); the
    // assets are Freedoom's, which are BSD-3-Clause. The stricter of the two
    // governs what the title as a whole may be redistributed under.
    license: "gpl-2.0",
    sourceUrl: "https://github.com/ozkl/doomgeneric",
    releasedAt: "2026-07-18T00:00:00.000Z",
    bundleName: "doom",
    width: 320,
    height: 200,
  },
  {
    id: "00000000-0000-4000-9000-000000000001",
    slug: "supertux",
    name: "SuperTux",
    description:
      "A classic 2D side-scrolling platformer starring the Linux mascot. Free software with free assets, so the whole game ships with the console.",
    runtime: "wasm-app",
    assetSource: "bundled",
    tier: "A",
    license: "gpl-3.0",
    sourceUrl: "https://github.com/SuperTux/supertux",
    releasedAt: "2026-07-10T00:00:00.000Z",
  },
  {
    id: "00000000-0000-4000-9000-000000000002",
    slug: "beneath-a-steel-sky",
    name: "Beneath a Steel Sky",
    description:
      "Revolution's cyberpunk point-and-click adventure, released as freeware by its authors and playable through the ScummVM runtime.",
    runtime: "scummvm",
    assetSource: "bundled",
    tier: "B",
    license: "proprietary-freeware",
    sourceUrl: "https://www.scummvm.org/games/",
    releasedAt: "2026-07-08T00:00:00.000Z",
  },
  {
    id: "00000000-0000-4000-9000-000000000003",
    slug: "openmw",
    name: "OpenMW",
    description:
      "An open-source reimplementation of the Morrowind engine. The engine is free software; bring your own copy of the game data to play.",
    runtime: "wasm-app",
    assetSource: "user-supplied",
    tier: "C",
    license: "gpl-3.0",
    sourceUrl: "https://gitlab.com/OpenMW/openmw",
    releasedAt: "2026-07-06T00:00:00.000Z",
  },
];

export function findDemoTitle(titleId: string): DemoTitle | undefined {
  return DEMO_TITLES.find((title) => title.id === titleId);
}

/** Cover art for a demo title, honouring the site base path. */
export function demoTitleThumbUrl(titleId: string): string {
  return withBasePath(`/demo/titles/${titleId}.png`);
}

/**
 * Demo titles are always free: pricing requires a verified rightsholder claim,
 * and the static build has no claim records because it has no server.
 */
export function demoTitleToEntry(title: DemoTitle): CatalogEntry {
  return {
    kind: "title",
    id: title.id,
    name: title.name,
    description: title.description,
    runtime: title.runtime,
    priceCents: 0,
    plays: 0,
    thumbUrl: null,
    href: `/play/${title.id}`,
    createdAt: new Date(title.releasedAt),
    tier: title.tier,
    assetSource: title.assetSource,
  };
}
