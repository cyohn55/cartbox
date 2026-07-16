/**
 * Animated handheld skins.
 *
 * Some premade handhelds are not a still image but a short looping animation
 * that plays a classic-arcade scene — Space Invaders, Pac-Man, Asteroids or a
 * bullet-hell boss — on the console's *chassis* (a small marquee panel on the
 * lower body, well clear of the screen, which the live OS occupies). Each such
 * preset is a base two-tone scheme plus a game id; this module renders the scene
 * onto the skin frame by frame.
 *
 * The module is pure (no DOM): given a template and a preset it returns straight
 * -alpha RGBA frames, exactly as `renderHandheld` returns a single frame. The
 * asset-prep script bakes these frames into a horizontal sprite sheet the app
 * ships, and the console plays that sheet back. Keeping it pure means the same
 * code the app relies on is unit-testable without a browser.
 */

import {
  renderHandheld,
  twoTone,
  type HandheldScheme,
  type HandheldTemplate,
} from "./handheldSkin";

/**
 * The scenes a handheld chassis marquee can animate: classic-arcade vignettes
 * plus a set of "gamer HUD" marquees (an equalizer, an XP bar, a scrolling
 * gamertag and a virtual pet) that suit a personalised console.
 */
export type HandheldGameId =
  | "space-invaders"
  | "pac-man"
  | "asteroids"
  | "bullet-hell"
  | "equalizer"
  | "xp-bar"
  | "gamertag"
  | "virtual-pet";

/** A premade animated skin: a base scheme plus the scene played on its chassis. */
export interface HandheldAnimatedPreset {
  readonly id: string;
  readonly label: string;
  readonly game: HandheldGameId;
  readonly scheme: HandheldScheme;
  /** Number of animation frames (kept within the art gate's 2..8 range). */
  readonly frames: number;
  /** Per-frame duration in ms when the console plays the loop. */
  readonly durationMs: number;
}

/**
 * The premade animated skins. Each pairs a dark, arcade-cabinet chassis with the
 * scene it plays, so the little lit marquee reads well on the body.
 */
export const HANDHELD_ANIMATED_PRESETS: readonly HandheldAnimatedPreset[] = [
  { id: "anim-space-invaders", label: "Space Invaders", game: "space-invaders", scheme: twoTone("#23252e", "#63e06a"), frames: 8, durationMs: 180 },
  { id: "anim-pac-man", label: "Pac-Man", game: "pac-man", scheme: twoTone("#1c1c2e", "#ffd24a"), frames: 8, durationMs: 130 },
  { id: "anim-asteroids", label: "Asteroids", game: "asteroids", scheme: twoTone("#20242c", "#8fd3ff"), frames: 8, durationMs: 110 },
  { id: "anim-bullet-hell", label: "Bullet Hell", game: "bullet-hell", scheme: twoTone("#241826", "#ff5d8f"), frames: 8, durationMs: 100 },
  { id: "anim-equalizer", label: "Equalizer", game: "equalizer", scheme: twoTone("#181a24", "#4ad6c0"), frames: 8, durationMs: 110 },
  { id: "anim-xp-bar", label: "XP Level", game: "xp-bar", scheme: twoTone("#1a1726", "#b98cff"), frames: 8, durationMs: 150 },
  { id: "anim-gamertag", label: "Gamertag", game: "gamertag", scheme: twoTone("#14181f", "#5ce0ff"), frames: 8, durationMs: 130 },
  { id: "anim-virtual-pet", label: "Virtual Pet", game: "virtual-pet", scheme: twoTone("#201a24", "#ff9ecb"), frames: 8, durationMs: 200 },
];

/** Look up an animated preset by id, or undefined when it is not one. */
export function handheldAnimatedPreset(id: string): HandheldAnimatedPreset | undefined {
  return HANDHELD_ANIMATED_PRESETS.find((preset) => preset.id === id);
}

/**
 * Fallback marquee lane on the lower chassis, as 0..1 fractions of the device: a
 * horizontal band below every control and above the bottom edge, inset from the
 * sides so it stays on the straight part of the body. Only used when the chrome
 * has no built-in bottom panel to host the scene.
 */
const LANE = { x: 0.14, y: 0.855, w: 0.72, h: 0.095 } as const;

/** A pixel rectangle. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Find the marquee panel on the lower chassis: the largest transparent hole that
 * is fully enclosed by the device (like the screen) and sits in the lower half.
 * The template art carries a blank recessed panel there, meant to hold content —
 * exactly where the scene should play. Returns null when there is no such hole,
 * so the caller can fall back to the fractional lane.
 */
function findBottomPanel(template: HandheldTemplate): Rect | null {
  const { width, height, base } = template;
  const transparent = (i: number) => (base[i * 4 + 3] ?? 0) === 0;

  // Flood the "outside" transparent region inward from the border; any
  // transparent pixel it never reaches is an enclosed hole.
  const outside = new Uint8Array(width * height);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const i = y * width + x;
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    if (outside[i] || !transparent(i)) return;
    outside[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y);
    push(width - 1, y);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % width;
    const y = (i / width) | 0;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }

  // Bound the lower-half enclosed hole with the largest area.
  const seen = new Uint8Array(width * height);
  let best: (Rect & { area: number }) | null = null;
  for (let start = 0; start < width * height; start += 1) {
    if (seen[start] || outside[start] || !transparent(start)) continue;
    const blob = [start];
    seen[start] = 1;
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    let cy = 0;
    for (let head = 0; head < blob.length; head += 1) {
      const i = blob[head]!;
      const x = i % width;
      const y = (i / width) | 0;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      cy += y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (!seen[ni] && !outside[ni] && transparent(ni)) {
          seen[ni] = 1;
          blob.push(ni);
        }
      }
    }
    const area = blob.length;
    if (cy / area < height * 0.55) continue; // keep only lower-half holes (skip the screen)
    if (!best || area > best.area) best = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area };
  }
  return best ? { x: best.x, y: best.y, w: best.w, h: best.h } : null;
}

/** RGB triple. */
type Rgb = readonly [number, number, number];

/** A pixel sprite: rows of equal-length strings; any non-space cell is filled. */
type Sprite = readonly string[];

const PANEL_BG: Rgb = [13, 16, 32]; // near-black marquee screen
const PANEL_BORDER: Rgb = [58, 64, 96];

/**
 * A drawing surface over an RGBA buffer that only writes where `clip` is true
 * (so the scene stays inside the marquee panel). All game drawing goes through
 * it, which keeps the per-game code to sprite placement.
 */
class Canvas {
  constructor(
    private readonly buf: Uint8ClampedArray,
    private readonly width: number,
    private readonly height: number,
    private readonly clip: (x: number, y: number) => boolean,
  ) {}

  plot(x: number, y: number, color: Rgb): void {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    if (!this.clip(px, py)) return;
    const base = (py * this.width + px) * 4;
    this.buf[base] = color[0];
    this.buf[base + 1] = color[1];
    this.buf[base + 2] = color[2];
    this.buf[base + 3] = 255;
  }

  fillRect(x: number, y: number, w: number, h: number, color: Rgb): void {
    for (let row = 0; row < h; row += 1) {
      for (let col = 0; col < w; col += 1) this.plot(x + col, y + row, color);
    }
  }

  strokeRect(x: number, y: number, w: number, h: number, color: Rgb): void {
    this.fillRect(x, y, w, 1, color);
    this.fillRect(x, y + h - 1, w, 1, color);
    this.fillRect(x, y, 1, h, color);
    this.fillRect(x + w - 1, y, 1, h, color);
  }

  /** Blit a sprite with its top-left at (x, y), each cell scaled to `scale` px. */
  sprite(sprite: Sprite, x: number, y: number, scale: number, color: Rgb): void {
    for (let row = 0; row < sprite.length; row += 1) {
      const line = sprite[row] ?? "";
      for (let col = 0; col < line.length; col += 1) {
        if (line[col] === " ") continue;
        this.fillRect(x + col * scale, y + row * scale, scale, scale, color);
      }
    }
  }

  disc(cx: number, cy: number, radius: number, color: Rgb): void {
    const r2 = radius * radius;
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (dx * dx + dy * dy <= r2) this.plot(cx + dx, cy + dy, color);
      }
    }
  }
}

/**
 * The marquee lane: the chrome's built-in bottom panel when it has one, else a
 * fractional band on the lower chassis.
 */
function laneRect(template: HandheldTemplate): Rect {
  return (
    findBottomPanel(template) ?? {
      x: Math.round(LANE.x * template.width),
      y: Math.round(LANE.y * template.height),
      w: Math.round(LANE.w * template.width),
      h: Math.round(LANE.h * template.height),
    }
  );
}

// --- Sprites (kept small so they scale up crisply on any handheld size) ---

const INVADER_A: Sprite = [
  "  #   #  ",
  "   # #   ",
  "  #####  ",
  " ## # ## ",
  "#########",
  "# ##### #",
  "# #   # #",
  "   # #   ",
];
const INVADER_B: Sprite = [
  "  #   #  ",
  "#  # #  #",
  "# ##### #",
  "### # ###",
  "#########",
  " ####### ",
  "  #   #  ",
  " #     # ",
];
const CANNON: Sprite = ["   #   ", "  ###  ", "#######"];
const GHOST: Sprite = [
  " ##### ",
  "#######",
  "## # ##",
  "#######",
  "#######",
  "# # # #",
];
const SHIP: Sprite = ["  #  ", " ### ", "## ##", "#   #"];

// A small rounded creature for the virtual-pet marquee (eyes are punched out at
// draw time so they read as the panel's dark background).
const PET: Sprite = [
  " ##### ",
  "#######",
  "#######",
  "#######",
  "#######",
  " #   # ",
];
const HEART: Sprite = ["## ##", "#####", "#####", " ### ", "  #  "];

/**
 * A compact 3×5 uppercase pixel font (A–Z, 0–9, space and a few marks), used by
 * the text marquees (gamertag, XP level). Each glyph is five rows of three
 * cells; any non-space cell is filled. Unknown characters render as blank.
 */
const FONT: Record<string, Sprite> = {
  A: ["###", "# #", "###", "# #", "# #"],
  B: ["## ", "# #", "## ", "# #", "## "],
  C: ["###", "#  ", "#  ", "#  ", "###"],
  D: ["## ", "# #", "# #", "# #", "## "],
  E: ["###", "#  ", "###", "#  ", "###"],
  F: ["###", "#  ", "###", "#  ", "#  "],
  G: ["###", "#  ", "# #", "# #", "###"],
  H: ["# #", "# #", "###", "# #", "# #"],
  I: ["###", " # ", " # ", " # ", "###"],
  J: ["###", "  #", "  #", "# #", "###"],
  K: ["# #", "# #", "## ", "# #", "# #"],
  L: ["#  ", "#  ", "#  ", "#  ", "###"],
  M: ["# #", "###", "###", "# #", "# #"],
  N: ["# #", "###", "###", "###", "# #"],
  O: ["###", "# #", "# #", "# #", "###"],
  P: ["###", "# #", "###", "#  ", "#  "],
  Q: ["###", "# #", "# #", "###", "  #"],
  R: ["###", "# #", "## ", "# #", "# #"],
  S: ["###", "#  ", "###", "  #", "###"],
  T: ["###", " # ", " # ", " # ", " # "],
  U: ["# #", "# #", "# #", "# #", "###"],
  V: ["# #", "# #", "# #", "# #", " # "],
  W: ["# #", "# #", "###", "###", "# #"],
  X: ["# #", "# #", " # ", "# #", "# #"],
  Y: ["# #", "# #", " # ", " # ", " # "],
  Z: ["###", "  #", " # ", "#  ", "###"],
  "0": ["###", "# #", "# #", "# #", "###"],
  "1": [" # ", "## ", " # ", " # ", "###"],
  "2": ["###", "  #", "###", "#  ", "###"],
  "3": ["###", "  #", "###", "  #", "###"],
  "4": ["# #", "# #", "###", "  #", "  #"],
  "5": ["###", "#  ", "###", "  #", "###"],
  "6": ["###", "#  ", "###", "# #", "###"],
  "7": ["###", "  #", " # ", " # ", " # "],
  "8": ["###", "# #", "###", "# #", "###"],
  "9": ["###", "# #", "###", "  #", "###"],
  " ": ["   ", "   ", "   ", "   ", "   "],
  "-": ["   ", "   ", "###", "   ", "   "],
  "!": [" # ", " # ", " # ", "   ", " # "],
};

/** Width in cells of one glyph (3) plus the inter-glyph gap (1). */
const GLYPH_ADVANCE = 4;

/** Draw a string in the 3×5 font, top-left at (x, y), each cell `scale` px. */
function drawText(canvas: Canvas, text: string, x: number, y: number, scale: number, color: Rgb): void {
  for (let i = 0; i < text.length; i += 1) {
    const glyph = FONT[text[i]!.toUpperCase()];
    if (glyph) canvas.sprite(glyph, x + i * GLYPH_ADVANCE * scale, y, scale, color);
  }
}

// --- Per-game scene renderers -------------------------------------------------

/** Fractional phase [0,1) of the current frame within the loop. */
const phase = (frame: number, frames: number) => (frames > 0 ? frame / frames : 0);

function drawSpaceInvaders(canvas: Canvas, lane: ReturnType<typeof laneRect>, frame: number, frames: number, accent: Rgb) {
  const scale = Math.max(1, Math.round(lane.h / 12));
  const invaderW = 9 * scale;
  const invaderH = 8 * scale;
  const cols = 5;
  const rows = 2;
  const gapX = Math.max(scale, Math.round((lane.w - cols * invaderW) / (cols + 1)));
  // March: the block slides right then left across the slack, one step per frame.
  const slack = lane.w - (cols * invaderW + (cols - 1) * gapX) - 2 * scale;
  const steps = Math.max(1, frames);
  const t = frame % steps;
  const tri = t <= steps / 2 ? t : steps - t; // ping-pong
  const marchX = lane.x + scale + Math.round((slack * tri) / Math.max(1, steps / 2));
  const pose = frame % 2 === 0 ? INVADER_A : INVADER_B;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = marchX + col * (invaderW + gapX);
      const y = lane.y + scale + row * (invaderH + Math.round(gapX / 2));
      canvas.sprite(pose, x, y, scale, accent);
    }
  }
  // Player cannon tracks the swarm; a shot rises and resets each loop.
  const cannonX = lane.x + Math.round(lane.w / 2) - Math.round((7 * scale) / 2);
  const cannonY = lane.y + lane.h - 3 * scale - scale;
  canvas.sprite(CANNON, cannonX, cannonY, scale, accent);
  const shotY = cannonY - Math.round((lane.h * 0.5) * phase(frame, frames));
  canvas.fillRect(cannonX + 3 * scale, shotY, scale, 2 * scale, accent);
}

function drawPacMan(canvas: Canvas, lane: ReturnType<typeof laneRect>, frame: number, frames: number, accent: Rgb) {
  const radius = Math.max(3, Math.round(lane.h * 0.28));
  const midY = lane.y + Math.round(lane.h / 2);
  const travel = lane.w - 2 * radius - 2;
  const pacX = lane.x + radius + Math.round(travel * phase(frame, frames));
  // Pellets ahead of Pac-Man; the ones he has passed are eaten.
  const pelletR = Math.max(1, Math.round(radius / 4));
  const pelletGap = radius * 2;
  for (let x = lane.x + radius; x < lane.x + lane.w - radius; x += pelletGap) {
    if (x <= pacX + radius) continue; // eaten
    canvas.disc(x, midY, pelletR, accent);
  }
  // Pac-Man with a chomping mouth (open on even frames).
  canvas.disc(pacX, midY, radius, accent);
  if (frame % 2 === 0) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      const span = radius - Math.abs(dy); // 45-degree wedge opening right
      for (let dx = 0; dx <= span; dx += 1) canvas.plot(pacX + dx, midY + dy, PANEL_BG);
    }
  }
  // A ghost chases a few steps behind, wrapping with him.
  const ghostScale = Math.max(1, Math.round((radius * 2) / 6));
  const ghostX = lane.x + radius + Math.round(travel * ((phase(frame, frames) + 0.6) % 1));
  canvas.sprite(GHOST, ghostX - 3 * ghostScale, midY - 3 * ghostScale, ghostScale, [255, 110, 150]);
}

function drawAsteroids(canvas: Canvas, lane: ReturnType<typeof laneRect>, frame: number, frames: number, accent: Rgb) {
  const shipScale = Math.max(1, Math.round(lane.h / 10));
  const shipX = lane.x + Math.round(lane.w / 2) - Math.round((5 * shipScale) / 2);
  const shipY = lane.y + Math.round(lane.h / 2) - 2 * shipScale;
  canvas.sprite(SHIP, shipX, shipY, shipScale, accent);
  // Rocks drift across and wrap; each is an outlined blob at its own speed.
  const rockR = Math.max(3, Math.round(lane.h * 0.22));
  const rocks = [
    { start: 0.05, speed: 1.0, y: 0.3 },
    { start: 0.4, speed: -0.7, y: 0.7 },
    { start: 0.75, speed: 0.5, y: 0.5 },
  ];
  for (const rock of rocks) {
    const p = (rock.start + rock.speed * phase(frame, frames) + 1) % 1;
    const rx = lane.x + rockR + Math.round((lane.w - 2 * rockR) * p);
    const ry = lane.y + Math.round(lane.h * rock.y);
    // Outlined octagonal rock (ring only, for the vector look).
    for (let a = 0; a < 8; a += 1) {
      const ang = (a / 8) * Math.PI * 2;
      const nx = (a + 1) / 8 * Math.PI * 2;
      const steps = rockR * 2;
      for (let s = 0; s <= steps; s += 1) {
        const f = s / steps;
        const ex = Math.cos(ang) * (1 - f) + Math.cos(nx) * f;
        const ey = Math.sin(ang) * (1 - f) + Math.sin(nx) * f;
        canvas.plot(rx + ex * rockR, ry + ey * rockR, accent);
      }
    }
  }
  // A bullet streaks from the ship each loop.
  const bulletY = shipY - Math.round(lane.h * 0.4 * phase(frame, frames));
  canvas.fillRect(shipX + 2 * shipScale, bulletY, shipScale, shipScale, accent);
}

function drawBulletHell(canvas: Canvas, lane: ReturnType<typeof laneRect>, frame: number, frames: number, accent: Rgb) {
  const cx = lane.x + Math.round(lane.w / 2);
  const bossY = lane.y + Math.round(lane.h * 0.3);
  const bossR = Math.max(3, Math.round(lane.h * 0.16));
  canvas.disc(cx, bossY, bossR, accent);
  // Concentric expanding rings of bullets; each ring's radius grows with the
  // frame and the whole pattern rotates, so it reads as a bullet spray.
  const rings = 3;
  const bulletsPerRing = 10;
  const maxRadius = Math.min(lane.w, lane.h * 2.4) * 0.5;
  for (let ring = 0; ring < rings; ring += 1) {
    const t = (phase(frame, frames) + ring / rings) % 1;
    const radius = t * maxRadius;
    const spin = phase(frame, frames) * Math.PI * 2 + ring;
    for (let b = 0; b < bulletsPerRing; b += 1) {
      const ang = (b / bulletsPerRing) * Math.PI * 2 + spin;
      const bx = cx + Math.cos(ang) * radius;
      const by = bossY + Math.sin(ang) * radius * 0.5; // squashed to the lane
      canvas.disc(bx, by, 1, [255, 200, 120]);
    }
  }
  // The player dodges along the lane's bottom.
  const shipScale = Math.max(1, Math.round(lane.h / 12));
  const dodge = (Math.sin(phase(frame, frames) * Math.PI * 2) + 1) / 2;
  const shipX = lane.x + Math.round((lane.w - 5 * shipScale) * dodge);
  canvas.sprite(SHIP, shipX, lane.y + lane.h - 4 * shipScale, shipScale, accent);
}

function drawEqualizer(canvas: Canvas, lane: ReturnType<typeof laneRect>, frame: number, frames: number, accent: Rgb) {
  const bars = 7;
  const gap = Math.max(1, Math.round(lane.w / (bars * 6)));
  const barWidth = Math.max(1, Math.floor((lane.w - gap * (bars + 1)) / bars));
  const capHeight = Math.max(1, Math.round(lane.h * 0.08));
  const t = phase(frame, frames);
  for (let bar = 0; bar < bars; bar += 1) {
    // Each bar oscillates on its own phase so the row reads as a spectrum.
    const wave = (Math.sin((t + bar / bars) * Math.PI * 2) + 1) / 2;
    const barHeight = Math.max(capHeight, Math.round(lane.h * (0.18 + 0.78 * wave)));
    const x = lane.x + gap + bar * (barWidth + gap);
    const y = lane.y + lane.h - barHeight;
    canvas.fillRect(x, y, barWidth, barHeight, accent);
    // A bright cap tracks the top of each bar.
    canvas.fillRect(x, y, barWidth, capHeight, [255, 255, 255]);
  }
}

function drawXpBar(canvas: Canvas, lane: ReturnType<typeof laneRect>, frame: number, frames: number, accent: Rgb) {
  const pad = Math.max(2, Math.round(lane.w * 0.06));
  const barHeight = Math.max(2, Math.round(lane.h * 0.26));
  const barX = lane.x + pad;
  const barWidth = lane.w - 2 * pad;
  const barY = lane.y + lane.h - barHeight - Math.max(1, Math.round(lane.h * 0.14));
  const t = phase(frame, frames);

  // Level counts up as the bar fills; the label sits above the track.
  const level = 1 + Math.floor(t * 8);
  const textScale = Math.max(1, Math.round(lane.h / 12));
  drawText(canvas, `LV ${level}`, barX, lane.y + Math.max(1, Math.round(lane.h * 0.1)), textScale, accent);

  canvas.strokeRect(barX, barY, barWidth, barHeight, accent);
  const fillWidth = Math.max(0, Math.round((barWidth - 2) * t));
  canvas.fillRect(barX + 1, barY + 1, fillWidth, barHeight - 2, accent);
  // A leading edge highlight on the fill.
  if (fillWidth > 0) canvas.fillRect(barX + fillWidth - 1, barY + 1, 1, barHeight - 2, [255, 255, 255]);
}

function drawGamertag(canvas: Canvas, lane: ReturnType<typeof laneRect>, frame: number, frames: number, accent: Rgb) {
  const text = "PLAYER-1  READY  ";
  const scale = Math.max(1, Math.round(lane.h / 9));
  const textWidth = text.length * GLYPH_ADVANCE * scale;
  const y = lane.y + Math.round((lane.h - 5 * scale) / 2);
  // Scroll one full text-plus-lane span per loop so it enters and exits cleanly.
  const travel = textWidth + lane.w;
  const startX = lane.x + lane.w - Math.round(travel * phase(frame, frames));
  drawText(canvas, text, startX, y, scale, accent);
}

function drawVirtualPet(canvas: Canvas, lane: ReturnType<typeof laneRect>, frame: number, frames: number, accent: Rgb) {
  const scale = Math.max(1, Math.round(lane.h / 10));
  const bodyWidth = 7;
  const bodyHeight = 6;
  const centreX = lane.x + Math.round(lane.w / 2);
  const bob = Math.round(Math.sin(phase(frame, frames) * Math.PI * 2) * scale * 0.7);
  const x = centreX - Math.round((bodyWidth * scale) / 2);
  const y = lane.y + Math.round((lane.h - bodyHeight * scale) / 2) + bob;
  canvas.sprite(PET, x, y, scale, accent);

  // Eyes are punched out of the body; they close to a slit on the blink frame.
  const eyeY = y + 2 * scale;
  const blink = frame % 4 === 3;
  const eyeHeight = blink ? Math.max(1, Math.round(scale / 2)) : scale;
  const eyeOffset = blink ? Math.round(scale / 2) : 0;
  canvas.fillRect(x + scale, eyeY + eyeOffset, scale, eyeHeight, PANEL_BG);
  canvas.fillRect(x + 5 * scale, eyeY + eyeOffset, scale, eyeHeight, PANEL_BG);

  // A heart floats up beside the pet over the back half of the loop.
  const t = phase(frame, frames);
  if (t > 0.5) {
    const heartY = y - Math.round((t - 0.5) * 2 * lane.h * 0.4);
    canvas.sprite(HEART, x + bodyWidth * scale, heartY, Math.max(1, Math.round(scale * 0.8)), [255, 120, 150]);
  }
}

const SCENES: Record<HandheldGameId, (canvas: Canvas, lane: ReturnType<typeof laneRect>, frame: number, frames: number, accent: Rgb) => void> = {
  "space-invaders": drawSpaceInvaders,
  "pac-man": drawPacMan,
  asteroids: drawAsteroids,
  "bullet-hell": drawBulletHell,
  equalizer: drawEqualizer,
  "xp-bar": drawXpBar,
  gamertag: drawGamertag,
  "virtual-pet": drawVirtualPet,
};

/**
 * Render one animation frame of an animated preset: the recoloured skin with the
 * marquee panel and the game's scene at `frameIndex` drawn on the lower chassis.
 * Returns straight-alpha RGBA, `width * height * 4` long, like `renderHandheld`.
 */
export function renderAnimatedFrame(
  template: HandheldTemplate,
  preset: HandheldAnimatedPreset,
  frameIndex: number,
): Uint8ClampedArray {
  const out = renderHandheld(template, preset.scheme);
  const lane = laneRect(template);

  // The panel fills its whole rectangle (it is enclosed by the device, so this
  // never spills off the silhouette); the scene is then clipped to its interior.
  const withinLane = (x: number, y: number) => x >= lane.x && y >= lane.y && x < lane.x + lane.w && y < lane.y + lane.h;
  const panel = new Canvas(out, template.width, template.height, withinLane);
  const border = Math.max(1, Math.round(lane.h / 14));
  panel.fillRect(lane.x, lane.y, lane.w, lane.h, PANEL_BG);
  for (let i = 0; i < border; i += 1) panel.strokeRect(lane.x + i, lane.y + i, lane.w - 2 * i, lane.h - 2 * i, PANEL_BORDER);

  const inner: Rect = { x: lane.x + border, y: lane.y + border, w: lane.w - 2 * border, h: lane.h - 2 * border };
  const withinInner = (x: number, y: number) => x >= inner.x && y >= inner.y && x < inner.x + inner.w && y < inner.y + inner.h;
  const scene = new Canvas(out, template.width, template.height, withinInner);

  const accent: Rgb = hexToTriple(preset.scheme.buttonColor);
  const frame = ((frameIndex % preset.frames) + preset.frames) % preset.frames;
  SCENES[preset.game](scene, inner, frame, preset.frames, accent);
  return out;
}

/** Render every frame of an animated preset, in order. */
export function renderAnimatedFrames(template: HandheldTemplate, preset: HandheldAnimatedPreset): Uint8ClampedArray[] {
  return Array.from({ length: preset.frames }, (_, frame) => renderAnimatedFrame(template, preset, frame));
}

/** Parse a `#rrggbb` colour into an RGB triple (falls back to white). */
function hexToTriple(hex: string): Rgb {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return [255, 255, 255];
  const value = parseInt(match[1]!, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}
