/**
 * Hand-authored 12×12 face tiles for the world's materials — the real pixel art
 * that skins terrain, built blocks and props, replacing the earlier procedural
 * noise. Each tile is drawn as character rows against a small palette (see
 * {@link tileFromArt}); the colour tiles are drawn true-colour and applied to
 * near-white voxels so the art shows as painted, while the console tiles (metal,
 * screen, monolith) stay greyscale so a voxel's own colour still tints them.
 *
 * These stand in for sprites drawn in the editor: same straight-alpha RGBA, same
 * {@link tileFromArt} → spriteToFaceTexture path, so a tile authored in the sprite
 * tools drops into any slot unchanged. Pure and DOM-free.
 */

import type { FaceTexture } from "@cartbox/editor";
import { tileFromArt, type ArtPalette } from "./tileArt";

/** Grass cap: a dense sward of blades in three greens. */
const GRASS_TOP: ArtPalette = {
  d: { r: 46, g: 104, b: 44 }, // shadowed blade
  g: { r: 74, g: 150, b: 68 }, // mid green
  l: { r: 108, g: 188, b: 92 }, // lit blade
  t: { r: 150, g: 214, b: 120 }, // blade tip
};
const grassTop = tileFromArt(
  [
    "glgdgllgdglg",
    "lgtglgdgltgl",
    "gdggltgggdgg",
    "gltgdglgtgld",
    "dggltgggglgg",
    "gtgggdgltggl",
    "ggldgggtgdgg",
    "lggtgltgggld",
    "gdgggdgggtgg",
    "gltggltgdglg",
    "tgdglgggglgt",
    "gglgtgdgltgg",
  ],
  GRASS_TOP,
);

/** Grass side: a green lip and hanging blades over a body of soil. */
const GRASS_SIDE: ArtPalette = {
  t: { r: 150, g: 214, b: 120 }, // lit grass lip
  g: { r: 74, g: 150, b: 68 }, // grass
  d: { r: 46, g: 104, b: 44 }, // shadowed grass
  s: { r: 120, g: 86, b: 54 }, // soil
  k: { r: 96, g: 66, b: 40 }, // dark soil
  l: { r: 150, g: 110, b: 72 }, // soil grain
};
const grassSide = tileFromArt(
  [
    "tgtgtdgtgtgt",
    "gtgggtgdgtgg",
    "dggtsgdgtggd",
    "sgdssgsgdssg",
    "ssklssslkssl",
    "lssssklsssss",
    "skssslssklss",
    "sslksssslsss",
    "lssssskssslk",
    "ssklsssslsss",
    "sslsskssslss",
    "kssslssksssl",
  ],
  GRASS_SIDE,
);

/** Bare soil: brown grain with scattered darker pebbles. */
const DIRT: ArtPalette = {
  d: { r: 120, g: 86, b: 54 },
  k: { r: 96, g: 66, b: 40 },
  l: { r: 150, g: 110, b: 72 },
  p: { r: 104, g: 92, b: 82 }, // pebble
};
const dirt = tileFromArt(
  [
    "dkddlddkdlkd",
    "dddpdddlddkd",
    "ldddkdddddld",
    "dddddldpkddd",
    "kdlddddddldd",
    "ddpdkdlddddk",
    "dldddddddpdl",
    "ddklddkdlddd",
    "pdddldddddkd",
    "dkdddpdlkddd",
    "ldddkddddldp",
    "ddlpddkdddld",
  ],
  DIRT,
);

/** Rock: cool grey speckle broken by darker cracks. */
const ROCK: ArtPalette = {
  r: { r: 108, g: 108, b: 116 },
  d: { r: 78, g: 78, b: 86 },
  l: { r: 140, g: 140, b: 148 },
};
const rock = tileFromArt(
  [
    "rrlrdrrrlrrr",
    "rdrrrlrrdrrl",
    "lrrrdrrrrdrr",
    "rrdrrlrrlrrd",
    "rlrrrdrrrrrl",
    "drrrlrrdrlrr",
    "rrlrrrrdrrrd",
    "rrdrlrrrlrrr",
    "lrrrdrlrrrdr",
    "rdrlrrrrdrrl",
    "rrrrdrlrrrrr",
    "rlrdrrrdlrrd",
  ],
  ROCK,
);

/** Sand: pale dune with faint ripple bands and a few dark specks. */
const SAND: ArtPalette = {
  s: { r: 222, g: 202, b: 150 },
  l: { r: 238, g: 222, b: 178 },
  d: { r: 200, g: 178, b: 128 },
  k: { r: 170, g: 148, b: 104 }, // grain fleck
};
const sand = tileFromArt(
  [
    "sslssssdssss",
    "lssssslsssds",
    "ssdsslsssssl",
    "ssssssssdsss",
    "dsslssssslss",
    "ssssdssslsss",
    "ssslsssssssk",
    "kssssdslssss",
    "sslssssssdss",
    "sssdslssssls",
    "lsssssssdsss",
    "ssdsslssslss",
  ],
  SAND,
);

/** Water: blue with lighter horizontal wave crests. */
const WATER: ArtPalette = {
  w: { r: 46, g: 108, b: 190 },
  d: { r: 32, g: 84, b: 158 },
  l: { r: 92, g: 158, b: 224 },
  f: { r: 150, g: 206, b: 244 }, // foam crest
};
const water = tileFromArt(
  [
    "wwdwwwwdwwww",
    "wlwwflwwwlfw",
    "wwwwwwwwwwww",
    "dwwwwdwwwdww",
    "wwlffwwwlfww",
    "wwwwwwwwwwww",
    "wwwdwwwwdwww",
    "flwwwwlffwwl",
    "wwwwwwwwwwww",
    "dwwwdwwwwdww",
    "wwlffwwlfwww",
    "wwwwwwwwwwww",
  ],
  WATER,
);

/** Brick: red courses, offset row to row, with pale mortar. */
const BRICK: ArtPalette = {
  b: { r: 168, g: 74, b: 58 },
  d: { r: 138, g: 56, b: 44 },
  m: { r: 206, g: 196, b: 178 }, // mortar
};
const brick = tileFromArt(
  [
    "bbbbbmbbbbbm",
    "bdbbbmbbdbbm",
    "mmmmmmmmmmmm",
    "bmbbbbbmbbbb",
    "bmbdbbbmbbdb",
    "mmmmmmmmmmmm",
    "bbbbbmbbbbbm",
    "bdbbbmbbdbbm",
    "mmmmmmmmmmmm",
    "bmbbbbbmbbbb",
    "bmbdbbbmbbdb",
    "mmmmmmmmmmmm",
  ],
  BRICK,
);

/** Wood planks: horizontal boards with seams and lengthwise grain. */
const PLANKS: ArtPalette = {
  p: { r: 168, g: 124, b: 76 },
  g: { r: 150, g: 108, b: 62 }, // grain
  d: { r: 120, g: 84, b: 48 }, // seam
  l: { r: 190, g: 148, b: 98 }, // highlight
};
const planks = tileFromArt(
  [
    "plppgpplpgpp",
    "ppgpppplpppg",
    "dddddddddddd",
    "pgppplppgppp",
    "ppplpppgpppl",
    "gpppgpplpppp",
    "dddddddddddd",
    "lppgpppplgpp",
    "ppgppplppppg",
    "pplpppgppplp",
    "dddddddddddd",
    "pgpplpppgppl",
  ],
  PLANKS,
);

/** Log bark: vertical streaks of brown for the sides of a wood block. */
const WOOD_BARK: ArtPalette = {
  b: { r: 122, g: 88, b: 54 },
  d: { r: 96, g: 66, b: 40 },
  l: { r: 150, g: 112, b: 72 },
};
const woodBark = tileFromArt(
  [
    "bldbldbldbld",
    "bldbldbldbld",
    "bldbldbldbld",
    "dblbdlbdlbdl",
    "dblbdlbdlbdl",
    "dblbdlbdlbdl",
    "bldbldbldbld",
    "bldbldbldbld",
    "bldbldbldbld",
    "ldbldbldbldb",
    "ldbldbldbldb",
    "ldbldbldbldb",
  ],
  WOOD_BARK,
);

/** Log end: concentric growth rings for the top/bottom of a wood block. */
const WOOD_RINGS: ArtPalette = {
  o: { r: 190, g: 150, b: 100 }, // outer wood
  r: { r: 160, g: 120, b: 74 }, // ring
  i: { r: 200, g: 164, b: 116 }, // inner wood
  c: { r: 130, g: 92, b: 56 }, // core
};
const woodRings = tileFromArt(
  [
    "oooorrrroooo",
    "oorriiiirroo",
    "oriioooiiiro",
    "oriorrrroiro",
    "riorciicroir",
    "riorccccroir",
    "riorccccroir",
    "riorciicroir",
    "oriorrrroiro",
    "oriioooiiiro",
    "oorriiiirroo",
    "oooorrrroooo",
  ],
  WOOD_RINGS,
);

/** Foliage: clustered greens with darker gaps for leafy blocks. */
const LEAVES: ArtPalette = {
  g: { r: 58, g: 130, b: 56 },
  d: { r: 40, g: 96, b: 42 },
  l: { r: 96, g: 172, b: 84 },
  k: { r: 30, g: 72, b: 34 }, // deep gap
};
const leaves = tileFromArt(
  [
    "glgdgglkglgg",
    "lgggldgglggl",
    "gdgglggldggk",
    "gglkgglgggdg",
    "lgggdgglkggl",
    "gglgggldgggg",
    "dgglkgggglgd",
    "glgggdgglkgg",
    "gklgglgggdgl",
    "gglgdgglgggl",
    "gdgglkgglggd",
    "lgggglgdgglg",
  ],
  LEAVES,
);

/** Crystal: bright cyan facets that glow, for cave gems. */
const CRYSTAL: ArtPalette = {
  c: { r: 90, g: 220, b: 235, e: 150 },
  b: { r: 150, g: 240, b: 250, e: 210 }, // bright facet
  d: { r: 54, g: 168, b: 190, e: 90 }, // facet shadow
};
const crystal = tileFromArt(
  [
    "cdccbccdccbc",
    "dccbccdccbcc",
    "ccbccdccbccd",
    "cbccdccbccdc",
    "bccdccbccdcc",
    "ccdccbccdccb",
    "cdccbccdccbc",
    "dccbccdccbcc",
    "ccbccdccbccd",
    "cbccdccbccdc",
    "bccdccbccdcc",
    "ccdccbccdccb",
  ],
  CRYSTAL,
);

/** Brushed metal: greyscale sheen with a bright band, tinted by the voxel. */
const METAL: ArtPalette = {
  m: { r: 205, g: 205, b: 205 },
  d: { r: 180, g: 180, b: 180 },
  l: { r: 235, g: 235, b: 235 },
};
const metal = tileFromArt(
  [
    "mdmmmdmmmdmm",
    "mmmdmmmdmmmd",
    "llllllllllll",
    "mmdmmmdmmmdm",
    "dmmmdmmmdmmm",
    "mmmdmmmdmmmd",
    "mdmmmdmmmdmm",
    "mmmdmmmdmmmd",
    "mmdmmmdmmmdm",
    "dmmmdmmmdmmm",
    "mmmdmmmdmmmd",
    "mdmmmdmmmdmm",
  ],
  METAL,
);

/** Screen: greyscale scanlines with a corner glint, all emissive. */
const SCREEN: ArtPalette = {
  b: { r: 200, g: 200, b: 200, e: 150 }, // bright scanline
  d: { r: 120, g: 120, b: 120, e: 80 }, // dark scanline
  g: { r: 245, g: 245, b: 245, e: 235 }, // glint
};
const screen = tileFromArt(
  [
    "bbbbbbbbbggg",
    "ddddddddddgg",
    "bbbbbbbbbbbb",
    "dddddddddddd",
    "bbbbbbbbbbbb",
    "dddddddddddd",
    "bbbbbbbbbbbb",
    "dddddddddddd",
    "bbbbbbbbbbbb",
    "dddddddddddd",
    "bbbbbbbbbbbb",
    "dddddddddddd",
  ],
  SCREEN,
);

/** Monolith stone with a glowing rune column; greyscale + emissive. */
const MONOLITH: ArtPalette = {
  s: { r: 200, g: 200, b: 200, e: 40 }, // stone
  d: { r: 168, g: 168, b: 168, e: 30 }, // shadowed stone
  r: { r: 245, g: 245, b: 245, e: 220 }, // rune
};
const monolith = tileFromArt(
  [
    "sdssssssdsss",
    "sssrrsdsssds",
    "sdssrsssssss",
    "ssssrssdssrs",
    "sdssrsssssrs",
    "ssssrrsssrrs",
    "sdssrsssssrs",
    "ssssrssdsrss",
    "sdssrssssrss",
    "ssssrrssrrss",
    "sdssssssssds",
    "ssdssssdssss",
  ],
  MONOLITH,
);

/**
 * The authored tile library, keyed by name. {@link buildWorldAtlas} lays these
 * into atlas slots and references them from materials. Named rather than indexed
 * so a material reads for what it is ("grass top over dirt sides").
 */
export const AUTHORED_TILES = {
  grassTop,
  grassSide,
  dirt,
  rock,
  sand,
  water,
  brick,
  planks,
  woodBark,
  woodRings,
  leaves,
  crystal,
  metal,
  screen,
  monolith,
} as const satisfies Record<string, FaceTexture>;

export type AuthoredTileName = keyof typeof AUTHORED_TILES;
