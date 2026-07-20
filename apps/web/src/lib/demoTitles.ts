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
   * catalogued but not yet ported. ScummVM titles set it to the shared engine
   * directory ("scummvm") so the Browse grid lists them as playable.
   */
  bundleName?: string;
  /** ScummVM launch target (its game id, e.g. "sky") for the scummvm runtime. */
  scummvmTarget?: string;
  /**
   * DOS launch target for the dos runtime: "<bundle>:<exe>" (e.g.
   * "cdogs:CDOGS.EXE"), naming the game zip under public/dosbox and the
   * executable DOSBox runs.
   */
  dosTarget?: string;
  /** Native resolution the game is initialised at. */
  width?: number;
  height?: number;
  /** Drives the newest-first merge with carts. */
  releasedAt: string;
}

export const DEMO_TITLES: readonly DemoTitle[] = [
  {
    id: "00000000-0000-4000-9000-000000000006",
    slug: "c-dogs",
    name: "C-Dogs",
    description:
      "Ronny Wester's 1997 top-down run-and-gun, running authentically in DOSBox. Fight through three campaigns of elite-soldier mayhem: arrows move, A fires, B changes weapon, X toggles the automap. The source is GPL and the assets are CC-BY, so the whole game ships with the console.",
    runtime: "dos",
    assetSource: "bundled",
    tier: "A",
    // Code is GPL-2 (Ronny Wester released the source in 2002); the game assets
    // are CC-BY (released 2016). The stricter of the two governs redistribution
    // of the title as a whole, and the original 1997 release already granted free
    // unmodified redistribution — which is how the game is bundled here, intact.
    license: "gpl-2.0",
    sourceUrl: "https://www.dosgamesarchive.com/download/c-dogs/",
    releasedAt: "2026-07-19T00:00:00.000Z",
    // DOS titles share one engine directory (public/dosbox); the game zip and its
    // executable are named by dosTarget.
    bundleName: "dosbox",
    dosTarget: "cdogs:CDOGS.EXE",
    width: 320,
    height: 200,
  },
  {
    id: "00000000-0000-4000-9000-00000000000d",
    slug: "wolfenstein-3d",
    name: "Wolfenstein 3D",
    description:
      "id Software's 1992 original — the game that launched the first-person shooter. Blast your way out of Castle Wolfenstein through the shareware episode, Escape from Wolfenstein, running authentically in DOSBox. Arrows move, A fires, B opens doors, X confirms menus.",
    runtime: "dos",
    assetSource: "bundled",
    tier: "B",
    // id gave the shareware episode free redistribution; the shipped data is the
    // shareware .WL1 files (not the registered .WL6 episodes). The code is id's
    // proprietary shareware binary, so this is proprietary-freeware / Tier B —
    // unlike C-Dogs, whose GPL code and CC-BY assets make it Tier A.
    license: "proprietary-freeware",
    sourceUrl: "https://archive.org/details/wolf3dsw",
    // DOS titles share the dosbox engine directory; the game zip and exe are
    // named by dosTarget. Bindings for the "wolf3d" bundle are the arrow-key
    // default in dosRuntime.ts.
    bundleName: "dosbox",
    dosTarget: "wolf3d:WOLF3D.EXE",
    width: 320,
    height: 200,
    releasedAt: "2026-07-20T00:00:01.000Z",
  },
  {
    id: "00000000-0000-4000-9000-00000000000e",
    slug: "descent",
    name: "Descent",
    description:
      "Parallax's 1995 six-degrees-of-freedom shooter — fly through the twisting mines of a sabotaged mining colony in the shareware demo, running authentically in DOSBox. The d-pad steers, A fires, B fires secondary, X confirms menus.",
    runtime: "dos",
    assetSource: "bundled",
    tier: "B",
    // Interplay/Parallax gave the shareware free redistribution; the shipped data
    // is the 7-level shareware HOG (not the ~7MB registered game). Proprietary
    // shareware code, so proprietary-freeware / Tier B.
    license: "proprietary-freeware",
    sourceUrl: "https://archive.org/details/msdos_Descent_1995",
    // DOS titles share the dosbox engine directory. The archive nests files under
    // Descent/, so the exe path in the dosTarget is Descent\descent.exe. Uses the
    // arrow-key default bindings in dosRuntime.ts.
    bundleName: "dosbox",
    dosTarget: "descent:Descent\\descent.exe",
    width: 320,
    height: 200,
    releasedAt: "2026-07-20T00:00:02.000Z",
  },
  {
    id: "00000000-0000-4000-9000-00000000000f",
    slug: "elder-scrolls-arena",
    name: "The Elder Scrolls: Arena",
    description:
      "The 1994 game that started The Elder Scrolls — a vast first-person open-world RPG across the whole of Tamriel, released as freeware by Bethesda and running authentically in DOSBox. The d-pad moves and turns, A/B act, X confirms, Y opens the menu.",
    runtime: "dos",
    assetSource: "bundled",
    tier: "B",
    // Bethesda released the full game (v1.06) as freeware for the series' 10th
    // anniversary; proprietary code, so proprietary-freeware / Tier B. Launched
    // via ARENA.BAT (which passes the Sound Blaster args A.EXE needs). See
    // games/arena/README.md for provenance.
    license: "proprietary-freeware",
    sourceUrl: "https://archive.org/details/ElderScrollsArena",
    bundleName: "dosbox",
    dosTarget: "arena:ARENA.BAT",
    width: 320,
    height: 200,
    releasedAt: "2026-07-20T00:00:03.000Z",
  },
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
    id: "00000000-0000-4000-9000-00000000000c",
    slug: "chex-quest",
    name: "Chex Quest",
    description:
      "The 1996 cereal-box promotion that became a cult classic: a non-violent total conversion of Doom where you zorch slimy aliens back to their own dimension. Runs on the same free Doom engine as Doom, with the original Chex Quest levels and art. Arrows move, A fires, B opens doors.",
    runtime: "wasm-app",
    assetSource: "bundled",
    tier: "B",
    // The doomgeneric engine is GPL-2; the Chex Quest data is freeware by the
    // rightsholder's long-standing custom (a free promotional giveaway) rather
    // than an explicit licence — hence proprietary-freeware and Tier B, unlike
    // Doom's BSD-licensed Freedoom assets. See scripts/fetch-chex.mjs.
    license: "proprietary-freeware",
    sourceUrl: "https://doomwiki.org/wiki/Chex_Quest",
    bundleName: "chex",
    width: 320,
    height: 200,
    releasedAt: "2026-07-20T00:00:00.000Z",
  },
  {
    id: "00000000-0000-4000-9000-000000000001",
    slug: "supertux",
    name: "SuperTux",
    description:
      "A classic 2D side-scrolling platformer starring the Linux mascot. Free software with free assets, so the whole game ships with the console. Arrow keys run, A jumps, B shoots.",
    runtime: "supertux",
    assetSource: "bundled",
    tier: "A",
    license: "gpl-3.0",
    sourceUrl: "https://github.com/SuperTux/supertux",
    releasedAt: "2026-07-10T00:00:00.000Z",
    // The engine lives at public/supertux; SuperTux boots to its own title
    // screen, so there is no launch target.
    bundleName: "supertux",
    width: 1280,
    height: 800,
  },
  {
    id: "00000000-0000-4000-9000-000000000002",
    slug: "beneath-a-steel-sky",
    name: "Beneath a Steel Sky",
    description:
      "Revolution's cyberpunk point-and-click adventure, released as freeware by its authors and playable through the ScummVM runtime. The d-pad moves the cursor; A interacts and B examines.",
    runtime: "scummvm",
    assetSource: "bundled",
    tier: "B",
    license: "proprietary-freeware",
    sourceUrl: "https://www.scummvm.org/games/",
    releasedAt: "2026-07-08T00:00:00.000Z",
    // The engine lives at public/scummvm; "sky" is the ScummVM game id.
    bundleName: "scummvm",
    scummvmTarget: "sky",
    width: 320,
    height: 200,
  },
  {
    id: "00000000-0000-4000-9000-000000000007",
    slug: "flight-of-the-amazon-queen",
    name: "Flight of the Amazon Queen",
    description:
      "A comic 1995 jungle adventure — pilot Joe King crash-lands in the Amazon and stumbles into a plot of Amazons, dinosaurs and a mad scientist. Released as freeware by its authors and played through the ScummVM runtime. The d-pad moves the cursor; A interacts and B examines.",
    runtime: "scummvm",
    assetSource: "bundled",
    tier: "B",
    license: "proprietary-freeware",
    sourceUrl: "https://www.scummvm.org/games/",
    // Shared ScummVM engine at public/scummvm; "queen" is the ScummVM game id.
    bundleName: "scummvm",
    scummvmTarget: "queen",
    width: 320,
    height: 200,
    releasedAt: "2026-07-19T00:00:03.000Z",
  },
  {
    id: "00000000-0000-4000-9000-000000000008",
    slug: "lure-of-the-temptress",
    name: "Lure of the Temptress",
    description:
      "Revolution Software's 1992 fantasy adventure, notable for its Virtual Theatre engine of characters who go about their lives independently. Released as freeware and played through the ScummVM runtime. The d-pad moves the cursor; A interacts and B examines.",
    runtime: "scummvm",
    assetSource: "bundled",
    tier: "B",
    license: "proprietary-freeware",
    sourceUrl: "https://www.scummvm.org/games/",
    bundleName: "scummvm",
    scummvmTarget: "lure",
    width: 320,
    height: 200,
    releasedAt: "2026-07-19T00:00:02.000Z",
  },
  {
    id: "00000000-0000-4000-9000-00000000000a",
    slug: "soltys",
    name: "Soltys",
    description:
      "A Polish point-and-click comedy adventure by Lech Sokolowski, released as freeware by its author and played through the ScummVM runtime. The d-pad moves the cursor; A interacts and B examines.",
    runtime: "scummvm",
    assetSource: "bundled",
    tier: "B",
    license: "proprietary-freeware",
    sourceUrl: "https://www.scummvm.org/games/",
    bundleName: "scummvm",
    scummvmTarget: "soltys",
    width: 320,
    height: 200,
    releasedAt: "2026-07-19T00:00:01.000Z",
  },
  {
    id: "00000000-0000-4000-9000-000000000009",
    slug: "dreamweb",
    name: "DreamWeb",
    description:
      "A dark cyberpunk point-and-click thriller (1994) with a top-down view and a full voice cast — you are Ryan, compelled by visions to hunt seven people before an ancient evil awakens. Released as freeware and played through the ScummVM runtime. The d-pad moves the cursor; A interacts and B examines.",
    runtime: "scummvm",
    assetSource: "bundled",
    tier: "B",
    license: "proprietary-freeware",
    sourceUrl: "https://www.scummvm.org/games/",
    bundleName: "scummvm",
    scummvmTarget: "dreamweb",
    width: 320,
    height: 200,
    releasedAt: "2026-07-19T00:00:04.000Z",
  },
  {
    id: "00000000-0000-4000-9000-00000000000b",
    slug: "drascula",
    name: "Drascula: The Vampire Strikes Back",
    description:
      "A slapstick horror-comedy adventure (1996) in the LucasArts mould — estate agent John Hacker takes on Count Drascula to rescue the kidnapped Von Braun. Released as freeware and played through the ScummVM runtime. The d-pad moves the cursor; A interacts and B examines.",
    runtime: "scummvm",
    assetSource: "bundled",
    tier: "B",
    license: "proprietary-freeware",
    sourceUrl: "https://www.scummvm.org/games/",
    bundleName: "scummvm",
    scummvmTarget: "drascula",
    width: 320,
    height: 200,
    releasedAt: "2026-07-19T00:00:05.000Z",
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
