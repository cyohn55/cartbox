/**
 * Asset-prep: enlarge the handheld's glass by thinning the bezel and pushing the
 * frame out to the chassis envelope.
 *
 * WHY THIS IS A SEPARATE STEP, NOT AN EDIT TO template.aseprite:
 * the source art stays the single point of truth for the chassis *design*; this
 * script is a deterministic geometric transform applied on top of it. Editing the
 * .aseprite instead would mean round-tripping 3MB of layered art through the
 * encoder and re-deriving the region group, for a change that is pure geometry.
 *
 * PIPELINE ORDER — this runs BETWEEN extract and measure, because extract
 * regenerates base.png/mask.png from the .aseprite and would discard the reshape:
 *   node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" \
 *        apps/web/scripts/extract-handheld.mjs
 *   node apps/web/scripts/reshape-handheld-glass.mjs
 *   node apps/web/scripts/measure-handheld-layout.mjs
 *
 * The layout JSON is NOT written here: measure-handheld-layout.mjs already derives
 * the screen rect by flood-filling the enclosed transparent hole, so it picks the
 * new glass up automatically.
 *
 * Safe to re-run: it detects an already-reshaped asset and exits without work.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(here, "../public/handheld");

// ---------------------------------------------------------------------------
// Design constants
//
// Every value below is either a measurement of the shipped art or a deliberate
// design choice, and is named so the intent survives the next revision. The art
// is drawn on a 12px grid, so all thicknesses are multiples of 12.
// ---------------------------------------------------------------------------

/** The art's drawing grid. Bezel bands are whole multiples of this. */
const GRID = 12;

/**
 * New bezel: lip + bezel + outline + skirt, outward from the glass. The original
 * was 80px (sides) / 90px (top); 48px is the thin-bezel target that frees the
 * width and height the glass gains.
 */
const SIDE_BANDS = [GRID, GRID, GRID, GRID]; // 48px total

/**
 * The bottom band keeps its original 60px profile. It is NOT thinned and the
 * glass does NOT grow downward: the scroll-wheel housing is drawn up inside this
 * band, and the shoulder pills start 11px below it. There is no room here.
 */
const BOTTOM_BANDS = [GRID, GRID * 2, GRID, GRID]; // 60px total

/** Face left visible between the chassis edge bevel and the new frame. */
const FACE_MARGIN = 24;

/** Clearance between the lifted chrome row and the top of the frame. */
const CHROME_GAP = GRID;

/**
 * How far the LED / speaker grille / POWER cluster slides up. The chassis carries
 * ~70px of empty face above the cluster; 48px reclaims most of it while leaving a
 * 22px margin under the top bevel.
 */
const CHROME_LIFT = 48;

/** Corner chamfer: three 12px stair steps, matching the original hole's corners. */
const CHAMFER_STEPS = 3;

/**
 * Fixed chrome colours sampled from the shipped art, per side (the bezel is lit
 * from the top-left, so each side carries its own tone). These pixels are mask id
 * 0 — they do not recolour with the chassis scheme.
 */
const BAND_COLORS = {
  left: [[57, 54, 49], [39, 39, 36], [0, 0, 0], [55, 50, 36]],
  right: [[57, 54, 49], [39, 39, 36], [0, 0, 0], [71, 64, 45]],
  top: [[28, 27, 25], [26, 25, 18], [0, 0, 0], [55, 50, 36]],
  bottom: [[82, 75, 60], [47, 43, 37], [0, 0, 0], [142, 124, 87]],
};

/** Chassis face colour in the un-recoloured art, and its mask region id. */
const FACE_COLOR = [138, 111, 48];
const FACE_REGION_ID = 1;

/**
 * Search window for the movable chrome above the glass — the LED, the speaker
 * grille, and the POWER dot + label. Chrome is found by *difference* from each
 * row's background rather than by fixed boxes, because the LED and the power dot
 * carry dark outlines a colour-derived box misses, which would otherwise be left
 * behind as residue. The window is inset from the chassis edges so the top bevel's
 * own vertical structure is not mistaken for chrome.
 */
const CHROME_BAND = { x0: 160, x1: 1500, y0: 122, y1: 210 };

/**
 * A column of pure chassis (no chrome) used to sample what sits *behind* the
 * chrome on each row. Falls in the gap between the grille and the power dot.
 */
const CLEAN_COLUMN = 800;

/**
 * The scroll-wheel housing, drawn up inside the bottom band. Preserved verbatim:
 * the glass keeps its original horizontal centre so the housing stays aligned.
 */
const WHEEL_HOUSING = { x0: 662, x1: 1081, y0: 1788, y1: 1847 };

// ---------------------------------------------------------------------------
// Pixel helpers
// ---------------------------------------------------------------------------

class Surface {
  constructor(png) {
    this.png = png;
    this.width = png.width;
    this.height = png.height;
    this.data = png.data;
  }

  index(x, y) {
    return (y * this.width + x) * 4;
  }

  get(x, y) {
    const i = this.index(x, y);
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }

  set(x, y, [r, g, b, a]) {
    const i = this.index(x, y);
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
    this.data[i + 3] = a;
  }

  isTransparent(x, y) {
    return this.data[this.index(x, y) + 3] < 40;
  }
}

/** Region id lives in the mask's red channel; 0 means "fixed chrome". */
const readRegion = (mask, x, y) => mask.data[mask.index(x, y)];
const writeRegion = (mask, x, y, id) => mask.set(x, y, [id, id, id, 255]);

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * The glass is the largest enclosed transparent hole in the upper half of the art
 * (the surrounding background is transparent too, but it touches the border; the
 * cart slot is enclosed but sits low). Same rule measure-handheld-layout.mjs uses.
 */
function findGlassBox(base) {
  const seen = new Uint8Array(base.width * base.height);
  let best = null;

  for (let y = 0; y < base.height; y += 1) {
    for (let x = 0; x < base.width; x += 1) {
      const start = y * base.width + x;
      if (seen[start] || !base.isTransparent(x, y)) continue;

      const box = { x0: base.width, y0: base.height, x1: -1, y1: -1 };
      let area = 0;
      let touchesEdge = false;
      const stack = [start];
      seen[start] = 1;

      while (stack.length) {
        const p = stack.pop();
        const px = p % base.width;
        const py = (p / base.width) | 0;
        if (px === 0 || py === 0 || px === base.width - 1 || py === base.height - 1) touchesEdge = true;
        if (px < box.x0) box.x0 = px;
        if (py < box.y0) box.y0 = py;
        if (px > box.x1) box.x1 = px;
        if (py > box.y1) box.y1 = py;
        area += 1;

        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= base.width || ny >= base.height) continue;
          const np = ny * base.width + nx;
          if (!seen[np] && base.isTransparent(nx, ny)) {
            seen[np] = 1;
            stack.push(np);
          }
        }
      }

      if (touchesEdge) continue;
      const centreY = (box.y0 + box.y1) / 2;
      if (centreY > base.height * 0.6) continue; // the cart slot, not the screen
      if (!best || area > best.area) best = { ...box, area };
    }
  }

  if (!best) throw new Error("Could not locate the glass cutout in base.png.");
  return best;
}

/** Horizontal extent of the chassis face on a given row, used to place the frame. */
function faceSpan(mask, y, width) {
  let x0 = -1;
  let x1 = -1;
  for (let x = 0; x < width; x += 1) {
    if (readRegion(mask, x, y) !== FACE_REGION_ID) continue;
    if (x0 < 0) x0 = x;
    x1 = x;
  }
  return { x0, x1 };
}

/**
 * Where the new glass lands. Derived, not hard-coded: the sides sit a fixed face
 * margin inside the chassis face band, the top clears the lifted chrome, and the
 * bottom is pinned by the wheel housing. The horizontal centre is preserved so the
 * housing stays aligned under the glass.
 */
function planGlass(base, mask, current, chrome) {
  const sideThickness = SIDE_BANDS.reduce((a, b) => a + b, 0);
  const face = faceSpan(mask, Math.round((current.y0 + current.y1) / 2), base.width);

  const left = face.x0 + FACE_MARGIN + sideThickness;
  const centreX2 = current.x0 + current.x1; // 2x the centre, kept exactly
  const right = centreX2 - left;

  const chromeBottom = chrome.reduce((lowest, pixel) => Math.max(lowest, pixel.y), 0);
  const top = chromeBottom - CHROME_LIFT + CHROME_GAP + sideThickness;

  return { x0: left, x1: right, y0: top, y1: current.y1 };
}

/**
 * Inside test for the chamfered glass rect. The chamfer is a stair of
 * CHAMFER_STEPS 12px treads, reproducing the original corner shape.
 */
function makeGlassTest(glass) {
  const chamfer = CHAMFER_STEPS * GRID;
  return (x, y) => {
    if (x < glass.x0 || x > glass.x1 || y < glass.y0 || y > glass.y1) return false;
    // Distance into the rect from each edge, capped at the chamfer depth.
    const fromLeft = x - glass.x0;
    const fromRight = glass.x1 - x;
    const fromTop = y - glass.y0;
    const fromBottom = glass.y1 - y;
    const nearX = Math.min(fromLeft, fromRight);
    const nearY = Math.min(fromTop, fromBottom);
    if (nearX >= chamfer || nearY >= chamfer) return true;
    // Inside a corner zone: the stair cuts the diagonal.
    const stepX = Math.floor(nearX / GRID);
    const stepY = Math.floor(nearY / GRID);
    return stepX + stepY >= CHAMFER_STEPS;
  };
}

/** Which side of the glass a ring pixel belongs to, for its colour ramp. */
function sideFor(x, y, glass) {
  const overLeft = glass.x0 - x;
  const overRight = x - glass.x1;
  const overTop = glass.y0 - y;
  const overBottom = y - glass.y1;
  const sideTotal = SIDE_BANDS.reduce((a, b) => a + b, 0);
  const bottomTotal = BOTTOM_BANDS.reduce((a, b) => a + b, 0);

  // Normalised penetration, so the mitre lands correctly where bands differ in
  // thickness (the bottom band is 60px against the sides' 48px).
  const horizontal = Math.max(overLeft, overRight, 0) / sideTotal;
  const vertical = Math.max(overTop, overBottom, 0) / (overBottom > 0 ? bottomTotal : sideTotal);

  if (vertical >= horizontal) return overTop > 0 ? "top" : "bottom";
  return overLeft > 0 ? "left" : "right";
}

/** Index of the band a given distance-from-glass falls in, or -1 if beyond the ring. */
function bandIndex(distance, bands) {
  let edge = 0;
  for (let i = 0; i < bands.length; i += 1) {
    edge += bands[i];
    if (distance <= edge) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Transform steps
// ---------------------------------------------------------------------------

/**
 * Every chrome pixel in the search window: those differing from their row's
 * background, sampled from a column of bare chassis. Comparing per row is what
 * keeps the chassis' horizontal shading bands in place — they match their own
 * row's sample and are never picked up as chrome.
 */
function findChromePixels(base, mask) {
  const found = [];
  for (let y = CHROME_BAND.y0; y <= CHROME_BAND.y1; y += 1) {
    const background = base.get(CLEAN_COLUMN, y);
    const backgroundRegion = readRegion(mask, CLEAN_COLUMN, y);

    for (let x = CHROME_BAND.x0; x <= CHROME_BAND.x1; x += 1) {
      const pixel = base.get(x, y);
      const isBackground =
        pixel[0] === background[0] && pixel[1] === background[1] && pixel[2] === background[2] && pixel[3] === background[3];
      if (isBackground) continue;
      found.push({ x, y, color: pixel, region: readRegion(mask, x, y), background, backgroundRegion });
    }
  }
  return found;
}

/** Slide the detected chrome cluster up, healing the rows it vacates. */
function liftChrome(base, mask, chrome) {
  for (const { x, y, background, backgroundRegion } of chrome) {
    base.set(x, y, background);
    writeRegion(mask, x, y, backgroundRegion);
  }
  for (const { x, y, color, region } of chrome) {
    base.set(x, y - CHROME_LIFT, color);
    writeRegion(mask, x, y - CHROME_LIFT, region);
  }
  return chrome.length;
}

/**
 * Punch the new glass and draw the bezel ring around it. Everything the old frame
 * occupied falls inside the new glass, so nothing needs repainting back to face.
 */
function drawGlassAndBezel(base, mask, glass) {
  const insideGlass = makeGlassTest(glass);
  const bottomTotal = BOTTOM_BANDS.reduce((a, b) => a + b, 0);
  const sideTotal = SIDE_BANDS.reduce((a, b) => a + b, 0);

  const bounds = {
    x0: glass.x0 - sideTotal,
    x1: glass.x1 + sideTotal,
    y0: glass.y0 - sideTotal,
    y1: glass.y1 + bottomTotal,
  };

  let glassPixels = 0;
  for (let y = bounds.y0; y <= bounds.y1; y += 1) {
    for (let x = bounds.x0; x <= bounds.x1; x += 1) {
      // The wheel housing is drawn inside the bottom band; keep it verbatim.
      const inHousing =
        x >= WHEEL_HOUSING.x0 && x <= WHEEL_HOUSING.x1 && y >= WHEEL_HOUSING.y0 && y <= WHEEL_HOUSING.y1;
      if (inHousing) continue;

      if (insideGlass(x, y)) {
        base.set(x, y, [0, 0, 0, 0]);
        writeRegion(mask, x, y, 0);
        glassPixels += 1;
        continue;
      }

      const side = sideFor(x, y, glass);
      const bands = side === "bottom" ? BOTTOM_BANDS : SIDE_BANDS;
      const distance = Math.max(glass.x0 - x, x - glass.x1, glass.y0 - y, y - glass.y1);
      const band = bandIndex(distance, bands);
      if (band < 0) continue; // beyond the ring: leave the chassis face alone

      base.set(x, y, [...BAND_COLORS[side][band], 255]);
      writeRegion(mask, x, y, 0);
    }
  }

  return glassPixels;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const basePng = PNG.sync.read(fs.readFileSync(path.join(DIR, "base.png")));
  const maskPng = PNG.sync.read(fs.readFileSync(path.join(DIR, "mask.png")));
  if (basePng.width !== maskPng.width || basePng.height !== maskPng.height) {
    throw new Error("base.png and mask.png differ in size; re-run extract-handheld.mjs.");
  }

  const base = new Surface(basePng);
  const mask = new Surface(maskPng);

  const current = findGlassBox(base);
  const currentWidth = current.x1 - current.x0 + 1;
  const currentHeight = current.y1 - current.y0 + 1;

  const chrome = findChromePixels(base, mask);
  const glass = planGlass(base, mask, current, chrome);
  const targetWidth = glass.x1 - glass.x0 + 1;
  const targetHeight = glass.y1 - glass.y0 + 1;

  if (currentWidth >= targetWidth && currentHeight >= targetHeight) {
    console.log(`Glass is already ${currentWidth}x${currentHeight}; nothing to do.`);
    return;
  }

  const chromePixels = liftChrome(base, mask, chrome);
  const glassPixels = drawGlassAndBezel(base, mask, glass);

  fs.writeFileSync(path.join(DIR, "base.png"), PNG.sync.write(basePng));
  fs.writeFileSync(path.join(DIR, "mask.png"), PNG.sync.write(maskPng));

  const before = currentWidth * currentHeight;
  const after = targetWidth * targetHeight;
  console.log(`glass  ${currentWidth}x${currentHeight} -> ${targetWidth}x${targetHeight}`);
  console.log(`       x ${current.x0}..${current.x1} -> ${glass.x0}..${glass.x1}`);
  console.log(`       y ${current.y0}..${current.y1} -> ${glass.y0}..${glass.y1}`);
  console.log(`area   +${(((after - before) / before) * 100).toFixed(1)}%  (${glassPixels} transparent px)`);
  console.log(`chrome lifted ${CHROME_LIFT}px (${chromePixels} px moved)`);
  console.log("Now run: node apps/web/scripts/measure-handheld-layout.mjs");
}

main();
