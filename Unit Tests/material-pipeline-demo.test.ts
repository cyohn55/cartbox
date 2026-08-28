/**
 * End-to-end demonstration of the "paint once, get every material map" pipeline.
 *
 * This is a *runnable proof*, not a mock: it drives the real editor objects and
 * the real runtime relight math, and asserts on values read back out of them —
 * no channel value is hard-coded independently of the swatch that produced it.
 *
 *   1. Author  — bind palette colours to material profiles (MaterialSwatches),
 *                then paint a sphere through the real MaterialBrushSurface so a
 *                single albedo write stamps normal/height/specular/roughness in
 *                the engine's material banks.
 *   2. Persist — round-trip the swatch bindings through the server-side sidecar
 *                parser (parseMaterials) that the /materials API route uses.
 *   3. Relight — read the banks back the way the player's G-buffer does, and
 *                shade with the *player package's own* lighting functions
 *                (sampleLight / normalVector / sampleNormalBilinear).
 *
 * The scene is deliberately built so the albedo is a single flat colour: every
 * facet of the sphere is a *different palette index that shares one RGB*, so the
 * unlit image is a featureless disc and all of the 3D form lives in the normals
 * the brush stamped. Relighting then reconstructs the sphere from nothing but
 * those per-colour normals — which is the whole point of the feature.
 *
 * It also renders the pipeline's output to PNGs so the result can be inspected,
 * and measures the 16-direction facet banding against the runtime's bilinear
 * normal smoothing — the "stepping" question made quantitative.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import {
  StubCartEngine,
  SpriteSheet,
  NormalMap,
  MaterialMap,
  TILE_SIZE,
  defaultMaterialSwatches,
  setMaterialProfile,
  materialProfileAt,
  type MaterialProfile,
  type MaterialSwatches,
  type SpritePage,
} from "@cartbox/editor";
import {
  NormalSurface,
  MaterialSurface,
} from "../apps/web/src/app/edit/[cartId]/paintSurface";
import { MaterialBrushSurface } from "../apps/web/src/app/edit/[cartId]/materialBrushSurface";
// The player's own per-fragment relight math (pure, DOM-free) — the exact code
// the WebGL/WebGPU shaders mirror. Imported straight from the module so the demo
// runs the runtime, not a copy of it.
import {
  normalVector,
  nearestDirection,
  sampleNormalBilinear,
  sampleScalarBilinear,
  sampleLight,
  type Vec3,
} from "../packages/player/src/lighting/lightingModel";
import type { Light } from "../packages/player/src/lighting/types";
import { parseMaterials } from "../apps/web/src/lib/materials";

// --- Scene constants --------------------------------------------------------

const PAGE: SpritePage = 0;
/** Material grid: 4x4 tiles of 8px, so the sphere has room to curve. */
const GRID = TILE_SIZE * 4; // 32
const CENTER = (GRID - 1) / 2;
const RADIUS = GRID * 0.44;
/** Upscale each material texel to this many output pixels, as a display would. */
const UPSCALE = 11;
const PANEL = GRID * UPSCALE; // 352
/** Height units the top material level maps to (mirrors the shader's HEIGHT_MAX). */
const HEIGHT_MAX = 8;
/** View direction the runtime shades against (LightingLayer's VIEW constant). */
const VIEW: Vec3 = [0, -0.34, 0.94];

/** One flat albedo for the whole sphere — the form is carried only by normals. */
const STEEL: Vec3 = [92, 128, 190];
const BACKGROUND: Vec3 = [14, 16, 22];

/** The nine facet colours: palette index (facet + 1) carries normal direction `facet`. */
const FACET_DIRECTIONS = 9; // flat (0) + eight compass (1..8)

const OUT_DIR = process.env.DEMO_OUT_DIR ?? "/tmp/material-pipeline-demo";

// --- Small vector helpers (kept local; the meaty math is the real runtime's) --

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
};
const clamp255 = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Tile index for a grid coordinate on page 0's sheet. */
function tileOf(sheet: SpriteSheet, gx: number, gy: number): number {
  return Math.floor(gy / TILE_SIZE) * sheet.sheetCols + Math.floor(gx / TILE_SIZE);
}

// --- 1. Author --------------------------------------------------------------

/** A rig of the real engine, channel views, and composite brush over them. */
function makePaintRig(swatches: () => MaterialSwatches) {
  const engine = new StubCartEngine();
  const sheet = new SpriteSheet(engine);
  const normals = new NormalMap(engine);
  const height = new MaterialMap(engine, "height");
  const specular = new MaterialMap(engine, "specular");
  const roughness = new MaterialMap(engine, "roughness");
  const emissive = new MaterialMap(engine, "emissive");

  const brush = new MaterialBrushSurface(
    sheet,
    {
      normal: new NormalSurface(normals, sheet.tileSize),
      height: new MaterialSurface(height, sheet.tileSize),
      specular: new MaterialSurface(specular, sheet.tileSize),
      roughness: new MaterialSurface(roughness, sheet.tileSize),
      emissive: new MaterialSurface(emissive, sheet.tileSize),
    },
    (index) => materialProfileAt(swatches(), index),
  );

  return { engine, sheet, normals, height, specular, roughness, emissive, brush };
}

/**
 * Build swatch bindings for the nine facet colours. Every colour shares the
 * steel albedo but stamps its own normal direction plus a glossy material, so
 * one brush stroke writes all four channels the sphere needs.
 */
function buildSphereSwatches(): MaterialSwatches {
  let swatches = defaultMaterialSwatches();
  for (let facet = 0; facet < FACET_DIRECTIONS; facet += 1) {
    const profile: MaterialProfile = {
      enabled: true,
      normal: facet, // direction index 0..8
      height: 10, // raised, so the shape catches a shadow test
      specular: 13, // glossy metal
      roughness: 4, // fairly polished
      emissive: 0,
    };
    swatches = setMaterialProfile(swatches, facet + 1, profile);
  }
  return swatches;
}

/**
 * Paint a sphere: for each covered texel, pick the palette colour whose stamped
 * normal best matches the ideal sphere normal, and paint it. The brush does the
 * rest — the caller never touches the normal/height/specular/roughness banks.
 * Returns the ideal (pre-quantisation) normal field for later comparison.
 */
function paintSphere(rig: ReturnType<typeof makePaintRig>): Map<number, Vec3> {
  const ideal = new Map<number, Vec3>();
  for (let gy = 0; gy < GRID; gy += 1) {
    for (let gx = 0; gx < GRID; gx += 1) {
      const dx = (gx - CENTER) / RADIUS;
      const dy = (gy - CENTER) / RADIUS;
      const r2 = dx * dx + dy * dy;
      if (r2 > 1) continue; // outside the sphere
      const nz = Math.sqrt(1 - r2);
      const idealNormal = norm([dx, dy, nz]);
      ideal.set(gy * GRID + gx, idealNormal);

      const facet = nearestDirection(idealNormal); // 0..8 for a front-facing sphere
      const colorIndex = facet + 1;
      const tile = tileOf(rig.sheet, gx, gy);
      // A single albedo write; MaterialBrushSurface fans it across every bank.
      rig.brush.setPixel(PAGE, tile, gx % TILE_SIZE, gy % TILE_SIZE, colorIndex);
    }
  }
  return ideal;
}

// --- 3. Relight (reads the banks exactly as the player's G-buffer does) ------

interface GBuffer {
  /** Stored normal direction index at an integer texel (clamped, flat off-sphere). */
  directionAt: (x: number, y: number) => number;
  /** Albedo RGB at an integer texel; background outside the sphere. */
  albedoAt: (x: number, y: number) => Vec3;
  heightAt: (x: number, y: number) => number;
  specularAt: (x: number, y: number) => number;
  roughnessAt: (x: number, y: number) => number;
  painted: (x: number, y: number) => boolean;
}

/** Read the material banks back out of the engine into G-buffer accessors. */
function readGBuffer(rig: ReturnType<typeof makePaintRig>): GBuffer {
  const clamp = (v: number): number => (v < 0 ? 0 : v >= GRID ? GRID - 1 : v);
  const at = <T,>(x: number, y: number, read: (tile: number, px: number, py: number) => T): T => {
    const gx = clamp(x);
    const gy = clamp(y);
    return read(tileOf(rig.sheet, gx, gy), gx % TILE_SIZE, gy % TILE_SIZE);
  };
  const painted = (x: number, y: number): boolean =>
    at(x, y, (t, px, py) => rig.sheet.getPixel(PAGE, t, px, py)) !== 0;
  return {
    painted,
    directionAt: (x, y) => at(x, y, (t, px, py) => rig.normals.getDirection(PAGE, t, px, py)),
    albedoAt: (x, y) => (painted(x, y) ? STEEL : BACKGROUND),
    heightAt: (x, y) => at(x, y, (t, px, py) => rig.height.getValue(PAGE, t, px, py)),
    specularAt: (x, y) => at(x, y, (t, px, py) => rig.specular.getValue(PAGE, t, px, py)),
    roughnessAt: (x, y) => at(x, y, (t, px, py) => rig.roughness.getValue(PAGE, t, px, py)),
  };
}

/** Shade one output pixel, mirroring the WebGL LightingLayer's per-fragment math. */
function shadePixel(gb: GBuffer, light: Light, mx: number, my: number, smooth: boolean): Vec3 {
  const ix = Math.round(mx);
  const iy = Math.round(my);
  const albedo = gb.albedoAt(ix, iy);
  if (!gb.painted(ix, iy)) return BACKGROUND;

  // Normal: faceted point-sample vs the runtime's bilinear de-banding.
  const n = smooth
    ? sampleNormalBilinear(gb.directionAt, mx, my)
    : normalVector(gb.directionAt(ix, iy));

  const heightUnits = (gb.heightAt(ix, iy) / 15) * HEIGHT_MAX;
  const specStr = gb.specularAt(ix, iy) / 15;
  const rough = gb.roughnessAt(ix, iy) / 15;

  const { toLight, attenuation } = sampleLight(light, mx, my, heightUnits);
  const diffuse = Math.max(0, dot(n, toLight));
  const half = norm([toLight[0] + VIEW[0], toLight[1] + VIEW[1], toLight[2] + VIEW[2]]);
  const shininess = mix(6, 120, 1 - rough);
  const specular = Math.pow(Math.max(0, dot(n, half)), shininess) * specStr;

  const ambient = 0.18;
  const lit = ambient + attenuation * diffuse;
  return [
    clamp255(albedo[0] * lit + 255 * attenuation * specular),
    clamp255(albedo[1] * lit + 255 * attenuation * specular),
    clamp255(albedo[2] * lit + 255 * attenuation * specular),
  ];
}

// --- PNG composition --------------------------------------------------------

type Panel = (mx: number, my: number) => Vec3;

/**
 * Render labelled panels side by side into one PNG and write it out. A no-op
 * unless DEMO_OUT_DIR is set, so the suite's assertions run in CI without ever
 * touching the filesystem; set the env var to regenerate the illustration PNGs.
 */
function writePanels(path: string, panels: readonly Panel[]): void {
  if (!process.env.DEMO_OUT_DIR) return;
  const gap = 6;
  const width = panels.length * PANEL + (panels.length - 1) * gap;
  const png = new PNG({ width, height: PANEL });
  png.data.fill(0);
  panels.forEach((panel, panelIndex) => {
    const originX = panelIndex * (PANEL + gap);
    for (let oy = 0; oy < PANEL; oy += 1) {
      for (let ox = 0; ox < PANEL; ox += 1) {
        const mx = (ox + 0.5) / UPSCALE - 0.5;
        const my = (oy + 0.5) / UPSCALE - 0.5;
        const [r, g, b] = panel(mx, my);
        const offset = (oy * width + originX + ox) * 4;
        png.data[offset] = r;
        png.data[offset + 1] = g;
        png.data[offset + 2] = b;
        png.data[offset + 3] = 255;
      }
    }
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, PNG.sync.write(png));
}

// --- The demonstration ------------------------------------------------------

describe("material pipeline: paint once -> all maps -> sidecar -> relight", () => {
  it("stamps every material channel from a single albedo brush stroke", () => {
    const swatches = buildSphereSwatches();
    const rig = makePaintRig(() => swatches);
    paintSphere(rig);

    // A painted texel at the sphere's centre must carry the profile of the
    // colour that was painted there — asserted against the profile, never a
    // literal, so the test cannot pass on stale expectations.
    const cx = Math.round(CENTER);
    const tile = tileOf(rig.sheet, cx, cx);
    const px = cx % TILE_SIZE;
    const py = cx % TILE_SIZE;
    const colorIndex = rig.sheet.getPixel(PAGE, tile, px, py);
    const profile = materialProfileAt(swatches, colorIndex);

    expect(profile.enabled).toBe(true);
    expect(rig.normals.getDirection(PAGE, tile, px, py)).toBe(profile.normal);
    expect(rig.height.getValue(PAGE, tile, px, py)).toBe(profile.height);
    expect(rig.specular.getValue(PAGE, tile, px, py)).toBe(profile.specular);
    expect(rig.roughness.getValue(PAGE, tile, px, py)).toBe(profile.roughness);
    expect(rig.emissive.getValue(PAGE, tile, px, py)).toBe(profile.emissive);
  });

  it("round-trips the swatch bindings through the server sidecar parser", () => {
    const swatches = buildSphereSwatches();
    // Simulate the PUT body: JSON out, validated back in by the API route's parser.
    const wire = JSON.parse(JSON.stringify(swatches));
    const parsed = parseMaterials(wire);

    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(swatches);
  });

  it("reconstructs the sphere's form from the stamped normals under a light", () => {
    const swatches = buildSphereSwatches();
    const rig = makePaintRig(() => swatches);
    paintSphere(rig);
    const gb = readGBuffer(rig);

    const light: Light = { x: GRID * 0.2, y: GRID * 0.15, z: 26, radius: GRID * 2.4, color: [255, 244, 224] };

    // The lit sphere must differ from its flat albedo: a bright rim toward the
    // light and a dim rim away from it. If normals did nothing, both would equal
    // the ambient-scaled albedo and the two sides would match.
    const nearLight = shadePixel(gb, light, CENTER - RADIUS * 0.6, CENTER - RADIUS * 0.6, true);
    const awayFromLight = shadePixel(gb, light, CENTER + RADIUS * 0.6, CENTER + RADIUS * 0.6, true);
    const brightness = (c: Vec3) => c[0] + c[1] + c[2];
    expect(brightness(nearLight)).toBeGreaterThan(brightness(awayFromLight) * 1.3);

    // Render the three-panel proof: flat albedo | faceted lighting | smoothed.
    const albedoPanel: Panel = (mx, my) => gb.albedoAt(Math.round(mx), Math.round(my));
    const facetedPanel: Panel = (mx, my) => shadePixel(gb, light, mx, my, false);
    const smoothPanel: Panel = (mx, my) => shadePixel(gb, light, mx, my, true);
    writePanels(`${OUT_DIR}/sphere-pipeline.png`, [albedoPanel, facetedPanel, smoothPanel]);
  });

  it("de-bands a painted specular ramp the same way (height/spec/rough smoothing)", () => {
    // A flat panel whose specular rises left-to-right through all 16 levels, each
    // level a distinct swatch colour. Every colour is painted through the real
    // brush, so its specular is stamped by the swatch — not written by hand.
    let swatches = defaultMaterialSwatches();
    for (let level = 0; level < 16; level += 1) {
      swatches = setMaterialProfile(swatches, level + 1, {
        enabled: true,
        normal: 0, // flat: isolate the specular ramp from any normal variation
        height: 0,
        specular: level,
        roughness: 6,
        emissive: 0,
      });
    }
    const rig = makePaintRig(() => swatches);
    for (let gy = 0; gy < GRID; gy += 1) {
      for (let gx = 0; gx < GRID; gx += 1) {
        const level = Math.round((gx / (GRID - 1)) * 15);
        const tile = tileOf(rig.sheet, gx, gy);
        rig.brush.setPixel(PAGE, tile, gx % TILE_SIZE, gy % TILE_SIZE, level + 1);
      }
    }

    const clampG = (v: number) => (v < 0 ? 0 : v >= GRID ? GRID - 1 : v);
    const specAt = (x: number, y: number): number => {
      const gx = clampG(x);
      const gy = clampG(y);
      return rig.specular.getValue(PAGE, tileOf(rig.sheet, gx, gy), gx % TILE_SIZE, gy % TILE_SIZE) / 15;
    };

    // A key light near the viewer: flat normals make diffuse uniform, so the
    // highlight's brightness tracks the specular level alone.
    // Direction chosen so the half-vector (L + VIEW) aligns with the flat normal,
    // putting the specular lobe at full strength — the highlight then reads the
    // specular level directly, so the ramp (and its stepping) is plainly visible.
    const light: Light = {
      x: CENTER, y: CENTER, z: 22, radius: GRID * 3,
      color: [255, 255, 255], kind: "directional", direction: [0, 0.34, 0.94],
    };
    const flat = normalVector(0);
    const highlight = (specStr: number): number => {
      const { toLight } = sampleLight(light, CENTER, CENTER, 0);
      const half = norm([toLight[0] + VIEW[0], toLight[1] + VIEW[1], toLight[2] + VIEW[2]]);
      const shininess = mix(6, 120, 1 - 6 / 15);
      return 0.12 + Math.max(0, dot(flat, half)) ** shininess * specStr;
    };
    const specPanel = (smooth: boolean): Panel => (mx, my) => {
      const s = smooth ? sampleScalarBilinear(specAt, mx, my) : specAt(Math.round(mx), Math.round(my));
      const v = clamp255(255 * highlight(s));
      return [v, clamp255(v * 0.85), clamp255(v * 0.6)]; // warm highlight
    };
    writePanels(`${OUT_DIR}/specular-ramp-debanding.png`, [specPanel(false), specPanel(true)]);

    // The stepping made quantitative: point-sampling the ramp yields at most the
    // 16 painted levels across the row; bilinear yields many more distinct values.
    const point = new Set<string>();
    const smooth = new Set<string>();
    for (let ox = 0; ox < PANEL; ox += 1) {
      const mx = (ox + 0.5) / UPSCALE - 0.5;
      point.add(specAt(Math.round(mx), CENTER).toFixed(3));
      smooth.add(sampleScalarBilinear(specAt, mx, CENTER).toFixed(3));
    }
    expect(point.size).toBeLessThanOrEqual(16);
    expect(smooth.size).toBeGreaterThan(point.size * 3);
  });

  it("measures the 16-direction facet banding against bilinear normal smoothing", () => {
    const swatches = buildSphereSwatches();
    const rig = makePaintRig(() => swatches);
    paintSphere(rig);
    const gb = readGBuffer(rig);

    // Walk the sphere's equator at output resolution and count how many distinct
    // surface normals each path produces. Faceted snapping collapses the curve
    // onto a handful of the 16 directions; bilinear blending recovers a
    // continuous sweep — the "stepping" the caller asked about, quantified.
    const key = (v: Vec3) => `${v[0].toFixed(2)},${v[1].toFixed(2)},${v[2].toFixed(2)}`;
    const faceted = new Set<string>();
    const smooth = new Set<string>();
    const row = CENTER;
    for (let ox = 0; ox < PANEL; ox += 1) {
      const mx = (ox + 0.5) / UPSCALE - 0.5;
      if (!gb.painted(Math.round(mx), Math.round(row))) continue;
      faceted.add(key(normalVector(gb.directionAt(Math.round(mx), Math.round(row)))));
      smooth.add(key(sampleNormalBilinear(gb.directionAt, mx, row)));
    }

    // Faceted is bounded by the few compass directions the equator crosses;
    // smoothing yields many more distinct normals across the same sweep.
    expect(smooth.size).toBeGreaterThan(faceted.size * 3);
  });
});
