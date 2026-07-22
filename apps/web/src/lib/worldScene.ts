/**
 * Assembles the /world demo scene — the first place all three world primitives
 * share one frame: hexel terrain for the ground, voxel objects for built things,
 * and pixel particles for the weather.
 *
 * It composes only *placed data* — models and their world positions, plus a snow
 * system whose flakes fall and wrap. The animation (camera orbit, the floaters'
 * bob, snow stepping) lives in the client component; keeping the assembly pure
 * lets it be unit-tested without a canvas, and lets the scene be rebuilt
 * deterministically from a seed.
 *
 * The pieces are chosen to *prove* the compositor: a monolith is sunk into the
 * terrain so nearer hexel hills occlude its base as the camera orbits (hexel over
 * voxel), while handhelds float above so they occlude the terrain behind them
 * (voxel over hexel) — the floating handhelds being the literal onboarding vision.
 */

import {
  VoxelGrid,
  voxelGridToModel,
  type VoxelModel,
  type PlacedModel,
  type TextureAtlas,
} from "@cartbox/editor";

import { buildTerrainModel } from "./hexelTerrain";
import { DEFAULT_TERRAIN_PARAMS, type TerrainParams } from "./hexelTerrainSpecs";
import { buildWorldAtlas, TILE } from "./faceTextures";
import {
  renderOsApp,
  initialOsState,
  hexToRgb,
  DEFAULT_CONFIG,
  SCREEN_W,
  SCREEN_H,
  type HandheldConfig,
} from "./cartboxOs";
import type { Particle } from "@cartbox/editor";

/** A voxel object that hovers over the terrain and gently bobs. */
export interface Floater {
  readonly model: VoxelModel;
  /** Rest position; the component adds the bob to `base[1]`. */
  readonly base: readonly [number, number, number];
  /** Phase offset so floaters don't bob in unison, radians. */
  readonly bobPhase: number;
}

/**
 * The centre handheld's live screen: the mapping from its self-emissive screen
 * voxels to pixels of the OS framebuffer, so the display can be repainted each
 * frame by writing framebuffer colours onto those voxels (see {@link applyOsScreen}).
 */
export interface HeroScreen {
  /** The hero handheld model whose screen voxels this drives (mutated in place). */
  readonly model: VoxelModel;
  /** Model-voxel index of each screen pixel. */
  readonly index: Int32Array;
  /** Framebuffer column/row each screen voxel reads from. */
  readonly fbX: Int16Array;
  readonly fbY: Int16Array;
  /** Body (chassis) voxels, recoloured by the customizer's BODY parameter. */
  readonly bodyIndex: Int32Array;
  /** Face-button voxels, recoloured by the customizer's BTNS parameter. */
  readonly buttonIndex: Int32Array;
}

export interface WorldScene {
  /** The pixel-art tiles every model in the scene samples from. */
  readonly atlas: TextureAtlas;
  /** The centre handheld's live OS screen, and the framebuffer that feeds it. */
  readonly hero: HeroScreen;
  readonly osFramebuffer: Uint8ClampedArray;
  /** The hexel ground, centred at the world origin. */
  readonly terrain: PlacedModel;
  /** Static voxel objects placed in the world (here, the sunk monolith). */
  readonly props: readonly PlacedModel[];
  /** Voxel objects that hover and bob (the handhelds). */
  readonly floaters: readonly Floater[];
  /** Snow flakes to step and draw as pixel particles. */
  readonly snow: Particle[];
  /** World-space bounds the snow falls within. */
  readonly snowBounds: SnowBounds;
  /** Largest span to frame, so the camera can fit the whole scene. */
  readonly fitSpan: number;
  /** World y the camera should look at (a little above the terrain centre). */
  readonly lookY: number;
}

export interface SnowBounds {
  readonly radiusX: number;
  readonly radiusZ: number;
  readonly minY: number;
  readonly maxY: number;
}

/** A small, fast, seedable PRNG so the scene is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A solid rectangular voxel block of one colour, optionally emissive. */
function block(
  width: number,
  height: number,
  depth: number,
  r: number,
  g: number,
  b: number,
  emissive = 0,
): VoxelGrid {
  const grid = new VoxelGrid(width, height, depth);
  for (let z = 0; z < depth; z += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        grid.set(x, y, z, r, g, b, emissive);
      }
    }
  }
  return grid;
}

/**
 * A little handheld: a coloured slab body with an emissive screen and two darker
 * face buttons on its front. A stand-in for the real skinned handheld, enough to
 * read as "a console floating in the world".
 */
function buildHandheldModel(
  bodyR: number,
  bodyG: number,
  bodyB: number,
  screenColor: readonly [number, number, number],
): VoxelModel {
  const width = 12;
  const height = 18;
  const depth = 3;
  const grid = block(width, height, depth, bodyR, bodyG, bodyB);
  const front = depth - 1;

  // Emissive screen inset in the upper two-thirds of the front face (emissive is a
  // 0..255 byte in the grid).
  for (let y = height - 15; y <= height - 5; y += 1) {
    for (let x = 2; x <= width - 3; x += 1) {
      grid.set(x, y, front, screenColor[0], screenColor[1], screenColor[2], 230);
    }
  }
  // Two dark face buttons below the screen.
  for (const bx of [width - 4, width - 3]) {
    grid.set(bx, 3, front, 30, 30, 36, 0);
  }
  // Screen cells (emissive) sample the glowing screen tile; the dark buttons stay
  // flat; every other cell is brushed metal.
  return voxelGridToModel(grid, {
    center: "content",
    tileForCell: (_x, _y, _z, cell) => {
      if (cell.emissive > 0) return TILE.screen;
      if (cell.r < 60 && cell.g < 60) return -1; // keep buttons flat-dark
      return TILE.metal;
    },
  });
}

/** Hero handheld dimensions and where its OS screen sits on the front face. */
const HERO_W = 26;
const HERO_H = 34;
const HERO_D = 3;
const SCREEN_X0 = 3;
const SCREEN_Y0 = 5;

/**
 * The centre "hero" handheld: a larger console whose front-face screen is a grid
 * of self-emissive voxels — one per OS pixel — so the Cartbox display can be
 * painted onto it each frame. The body is brushed metal tinted by `body`; the
 * screen voxels are white and flat (untextured) so the framebuffer colour shows
 * true, and marked fully emissive so the display reads as lit, not shaded.
 * Returns the model plus the {@link HeroScreen} mapping from screen voxels to
 * framebuffer pixels.
 */
function buildHeroHandheld(body: readonly [number, number, number]): { model: VoxelModel; hero: HeroScreen } {
  const grid = block(HERO_W, HERO_H, HERO_D, body[0], body[1], body[2]);
  const front = HERO_D - 1;
  for (let y = SCREEN_Y0; y < SCREEN_Y0 + SCREEN_H; y += 1) {
    for (let x = SCREEN_X0; x < SCREEN_X0 + SCREEN_W; x += 1) {
      grid.set(x, y, front, 255, 255, 255, 255); // white, self-lit screen pixel
    }
  }
  // Two dark face buttons below the screen.
  for (const bx of [HERO_W - 6, HERO_W - 5]) grid.set(bx, 2, front, 30, 30, 36, 0);

  const onScreen = (x: number, y: number, z: number): boolean =>
    z === front && x >= SCREEN_X0 && x < SCREEN_X0 + SCREEN_W && y >= SCREEN_Y0 && y < SCREEN_Y0 + SCREEN_H;

  const model = voxelGridToModel(grid, {
    center: "content",
    tileForCell: (x, y, z, cell) => {
      if (onScreen(x, y, z)) return -1; // flat voxel display, no tile
      if (cell.r < 60 && cell.g < 60) return -1; // dark buttons stay flat
      return TILE.metal;
    },
  });

  // Classify each voxel: screen pixels (mapped to the framebuffer and self-lit),
  // the dark face buttons, and everything else as recolourable body.
  const index: number[] = [];
  const fbX: number[] = [];
  const fbY: number[] = [];
  const bodyIndex: number[] = [];
  const buttonIndex: number[] = [];
  for (let v = 0; v < model.count; v += 1) {
    const gridIndex = model.gridIndex[v]!;
    const gx = gridIndex % HERO_W;
    const gy = Math.floor(gridIndex / HERO_W) % HERO_H;
    const gz = Math.floor(gridIndex / (HERO_W * HERO_H));
    if (onScreen(gx, gy, gz)) {
      index.push(v);
      fbX.push(gx - SCREEN_X0);
      fbY.push(SCREEN_H - 1 - (gy - SCREEN_Y0));
      model.emissive[v] = 1;
    } else if (model.r[v]! < 60 && model.g[v]! < 60) {
      buttonIndex.push(v); // a dark face button
    } else {
      bodyIndex.push(v); // chassis
    }
  }

  return {
    model,
    hero: {
      model,
      index: Int32Array.from(index),
      fbX: Int16Array.from(fbX),
      fbY: Int16Array.from(fbY),
      bodyIndex: Int32Array.from(bodyIndex),
      buttonIndex: Int32Array.from(buttonIndex),
    },
  };
}

/** Set every voxel in `indices` to `rgb` on the model's colour arrays. */
function paintVoxels(model: VoxelModel, indices: Int32Array, rgb: readonly [number, number, number]): void {
  for (let k = 0; k < indices.length; k += 1) {
    const v = indices[k]!;
    model.r[v] = rgb[0];
    model.g[v] = rgb[1];
    model.b[v] = rgb[2];
  }
}

/**
 * Apply the customizer's chosen colours to the hero handheld: the BODY colour
 * tints the brushed-metal chassis, the BTNS colour paints the face buttons. The
 * SCREEN colour lives in the OS framebuffer (drawn by {@link renderOsApp}), not
 * here. Mutates the model's colour arrays in place.
 */
export function applyHandheldConfig(hero: HeroScreen, config: HandheldConfig): void {
  paintVoxels(hero.model, hero.bodyIndex, hexToRgb(config.scheme.face));
  paintVoxels(hero.model, hero.buttonIndex, hexToRgb(config.scheme.buttonColor));
}

/**
 * Paint the OS framebuffer onto the hero handheld's screen voxels: each mapped
 * voxel takes the colour of its framebuffer pixel. Mutates the model's colour
 * arrays in place, so the next render shows the updated display.
 */
export function applyOsScreen(hero: HeroScreen, framebuffer: Uint8ClampedArray): void {
  for (let k = 0; k < hero.index.length; k += 1) {
    const v = hero.index[k]!;
    const fi = (hero.fbY[k]! * SCREEN_W + hero.fbX[k]!) * 4;
    hero.model.r[v] = framebuffer[fi]!;
    hero.model.g[v] = framebuffer[fi + 1]!;
    hero.model.b[v] = framebuffer[fi + 2]!;
  }
}

/** The default palette of floating handhelds. */
const HANDHELD_COLORS: ReadonlyArray<{
  readonly body: readonly [number, number, number];
  readonly screen: readonly [number, number, number];
}> = [
  { body: [210, 70, 90], screen: [120, 230, 255] },
  { body: [70, 120, 210], screen: [180, 255, 200] },
  { body: [240, 200, 70], screen: [255, 170, 220] },
];

/** Build the snow system: flakes scattered through the falling volume. */
function createSnow(count: number, bounds: SnowBounds, random: () => number): Particle[] {
  const flakes: Particle[] = [];
  for (let i = 0; i < count; i += 1) {
    const tone = 210 + Math.floor(random() * 45);
    flakes.push({
      position: [
        (random() * 2 - 1) * bounds.radiusX,
        bounds.minY + random() * (bounds.maxY - bounds.minY),
        (random() * 2 - 1) * bounds.radiusZ,
      ],
      r: tone,
      g: tone,
      b: 255,
      radius: 0,
    });
  }
  return flakes;
}

/**
 * Advance the snow by `deltaSeconds`: each flake falls and drifts, and wraps back
 * to the top of the volume (at a fresh horizontal spot) once it passes the floor.
 * Mutates the flakes' positions in place so the scene keeps one particle array.
 */
export function stepSnow(
  snow: readonly Particle[],
  bounds: SnowBounds,
  deltaSeconds: number,
  random: () => number,
): void {
  const fall = 9 * deltaSeconds;
  const drift = 2.5 * deltaSeconds;
  for (const flake of snow) {
    // `position` is typed readonly for consumers, but the system owns and moves it.
    const p = flake.position as unknown as number[];
    p[1] = (p[1] ?? 0) - fall;
    p[0] = (p[0] ?? 0) + Math.sin((p[1] ?? 0) * 0.3) * drift;
    if ((p[1] ?? 0) <= bounds.minY) {
      p[0] = (random() * 2 - 1) * bounds.radiusX;
      p[1] = bounds.maxY;
      p[2] = (random() * 2 - 1) * bounds.radiusZ;
    }
  }
}

export interface WorldSceneOptions {
  readonly terrain?: TerrainParams;
  readonly seed?: number;
  readonly snowCount?: number;
}

/**
 * Build the full demo scene. Deterministic for a given seed: the terrain, the
 * monolith, the floaters and the initial snow all derive from it.
 */
export function buildWorldScene(options: WorldSceneOptions = {}): WorldScene {
  const terrainParams = options.terrain ?? DEFAULT_TERRAIN_PARAMS;
  const seed = options.seed ?? terrainParams.seed;
  const random = mulberry32(seed);

  const atlas = buildWorldAtlas(seed);
  const terrainModel = buildTerrainModel(terrainParams);
  const halfHeight = terrainModel.sizeY / 2;
  const halfWidth = terrainModel.sizeX / 2;
  const halfDepth = terrainModel.sizeZ / 2;

  // A tall monolith sunk through the terrain so its base is buried and occluded by
  // nearer hexel hills while its rune-etched top pokes clearly into the sky. Set
  // off to the front-left so no floating handheld covers it.
  const monolithHeight = terrainModel.sizeY + 12;
  const monolith: PlacedModel = {
    model: voxelGridToModel(block(4, monolithHeight, 4, 165, 95, 250, 150), {
      center: "content",
      tileForCell: () => TILE.monolith,
    }),
    position: [-halfWidth * 0.5, 0, halfDepth * 0.35],
    atlas,
  };

  // Handhelds hover above the surface: the centre one is the larger "hero" that
  // boots the OS, the others flank it. Spacing keeps the wide hero clear of its
  // narrower siblings, and the hero sits a touch forward as the focus.
  const hoverY = halfHeight + 9;
  const centreIndex = Math.floor(HANDHELD_COLORS.length / 2);
  const spacing = 22;
  let hero: HeroScreen | null = null;
  const floaters: Floater[] = HANDHELD_COLORS.map((colors, index) => {
    const spread = (index - centreIndex) * spacing;
    if (index === centreIndex) {
      const built = buildHeroHandheld(colors.body);
      hero = built.hero;
      return { model: built.model, base: [spread, hoverY, halfDepth * 0.15 + 3], bobPhase: index * 1.9 };
    }
    return {
      model: buildHandheldModel(colors.body[0], colors.body[1], colors.body[2], colors.screen),
      base: [spread, hoverY, halfDepth * 0.15],
      bobPhase: index * 1.9,
    };
  });

  // Paint an initial menu frame and the default colours so the hero shows content
  // before the first tick.
  const osFramebuffer = new Uint8ClampedArray(SCREEN_W * SCREEN_H * 4);
  renderOsApp(osFramebuffer, initialOsState(), 2);
  applyOsScreen(hero!, osFramebuffer);
  applyHandheldConfig(hero!, DEFAULT_CONFIG);

  const snowBounds: SnowBounds = {
    radiusX: halfWidth + 4,
    radiusZ: halfDepth + 4,
    minY: -halfHeight,
    maxY: hoverY + 10,
  };
  const snow = createSnow(options.snowCount ?? 260, snowBounds, random);

  const fitSpan = Math.max(terrainModel.sizeX, terrainModel.sizeZ, hoverY * 2 + 8);

  return {
    atlas,
    hero: hero!,
    osFramebuffer,
    terrain: { model: terrainModel, position: [0, 0, 0], atlas },
    props: [monolith],
    floaters,
    snow,
    snowBounds,
    fitSpan,
    lookY: halfHeight * 0.35,
  };
}

/**
 * Flatten the scene into the placed-model list for {@link renderScene} at the
 * given time, applying each floater's bob. Kept out of the render loop's hot path
 * only in spirit — it allocates a small array per frame, which is negligible for
 * a handful of objects.
 */
export function sceneModelsAt(scene: WorldScene, seconds: number, dropSiblings = false): PlacedModel[] {
  const bobAmplitude = 1.6;
  const bobSpeed = 1.4;
  const centre = Math.floor(scene.floaters.length / 2);
  const floaters = scene.floaters
    // Once the handheld is chosen, the flanking options disappear and only the
    // hero remains, so the player can step into the world.
    .filter((_floater, index) => !dropSiblings || index === centre)
    .map((floater): PlacedModel => ({
      model: floater.model,
      position: [
        floater.base[0],
        floater.base[1] + Math.sin(seconds * bobSpeed + floater.bobPhase) * bobAmplitude,
        floater.base[2],
      ],
      atlas: scene.atlas,
    }));
  return [scene.terrain, ...scene.props, ...floaters];
}
