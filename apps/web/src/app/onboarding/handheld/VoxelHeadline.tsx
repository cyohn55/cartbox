"use client";

/**
 * The onboarding headline, spelled in 3D voxel letters that stand in the world in
 * front of the handhelds. Each letter is an extruded voxel model, lit by a
 * directional light and bobbing on a phase-shifted sine so the type reads as solid
 * objects catching the light rather than flat text. The headline cycles through a
 * set of arcade-zeitgeist taglines, each fading in and out.
 *
 * The models come from the reusable voxel alphabet (`@cartbox/editor`); this
 * component only lays them out, animates the bob + a gentle yaw sway, and blits
 * the lit band over the transparent canvas so the voxel world shows through.
 * A visually-hidden heading carries the real page title for assistive tech.
 */

import { useEffect, useRef } from "react";

import {
  layoutVoxelText,
  renderScene,
  type ModelLight,
  type PlacedModel,
  type Rgb,
  type VoxelTextLayout,
} from "@cartbox/editor";

import { TAGLINE_ANCHOR } from "@/lib/scene3d";
import { useSceneAnchorTransform } from "@/lib/useSceneAnchor";

import styles from "./handheld.module.css";

/** The taglines, pre-wrapped into short lines so the voxel type stays legible. */
const PHRASES: readonly string[] = [
  "PRESS [START]\nTO BEGIN",
  "A NEW\nCHALLENGER\nHAS ARRIVED",
  "INSERT COIN\nTO CONTINUE",
  "PLAYER 1:\nREADY!",
  "CHOOSE\nYOUR QUEST",
  "CHOOSE YOUR\nCHARACTER",
  "YOUR NEXT\nADVENTURE\nAWAITS",
  "BOOTING UP\nSYSTEM...",
  "TURN ON.\nTUNE IN.\nPLAY YOUR\nHEARTS OUT ♥♥♥",
  "SYSTEM\nINITIALIZED:\nWELCOME TO\nCARTBOX!",
];

/** One accent colour per tagline, cycled with it — bright arcade phosphors. */
const ACCENTS: readonly Rgb[] = [
  [122, 230, 255],
  [255, 208, 96],
  [132, 255, 170],
  [255, 150, 180],
  [186, 164, 255],
  [130, 236, 214],
  [255, 176, 96],
  [150, 235, 130],
  [255, 122, 150],
  [120, 214, 255],
];

/** The heart glyph always glows pink, whatever the line's accent. */
const HEART_COLOR: Rgb = [255, 96, 128];

const CELL_CSS = 7; // CSS pixels per voxel face (scaled by DPR for a crisp buffer)
const MAX_BUFFER = 1000; // cap on the square render buffer edge, in device pixels
const LINE_SPACING = 3; // blank rows between lines (clears the bob so lines never touch)
const DEPTH = 3; // letter thickness, in voxels
const EMISSIVE = 140; // neon self-glow so the type pops over the bright world
const BOB_AMP = 1.3; // vertical bob, in voxels
const BOB_SPEED = 1.2; // radians/second (a slow, calm bob)
const PHASE_STEP = 0.5; // bob phase advance per letter (the wave)
const SWAY_AMP = 0.16; // yaw sway amplitude, radians
const SWAY_SPEED = 0.55; // radians/second
const PITCH = 0.3; // tip toward the viewer so the tops catch light
const PHRASE_MS = 4600; // time each tagline holds
const FADE_MS = 650; // fade in/out at each end
const FRAME_INTERVAL_MS = 33; // ~30fps render cap (the bob is slow)

/** A low, warm key light; ambient lifted so shaded faces keep their colour. */
const HEADLINE_LIGHT: ModelLight = {
  direction: [0.45, 0.62, 0.65],
  color: [1, 0.98, 0.94],
  intensity: 1,
  ambient: 0.5,
};

/** Physical pixels per CSS pixel, clamped so the headline buffer stays bounded. */
function headlinePixelRatio(): number {
  return Math.min(2, Math.max(1, window.devicePixelRatio || 1));
}

/** Everything needed to render one tagline, sized to its own extent. */
interface PhraseRender {
  readonly layout: VoxelTextLayout;
  readonly cell: number; // output pixels per voxel face (DPR-scaled)
  readonly size: number; // square render buffer edge, in device pixels
  readonly bandHeight: number; // visible slice (the type + bob margin)
  readonly bandTop: number; // first row of that slice within the square
  readonly out: Uint8ClampedArray;
  readonly depth: Float32Array;
  readonly band: ImageData;
}

/** Colour a phrase's glyphs: hearts pink, everything else the phrase accent. */
function phraseColor(accent: Rgb): (line: number, col: number, char: string) => Rgb {
  return (_line, _col, char) => (char === "♥" ? HEART_COLOR : accent);
}

/**
 * Build the per-tagline render resources. The square buffer is sized to the
 * larger of the type's width/height plus a margin for the bob and tilt; the
 * visible band is the shorter slice actually holding the type, so the headline
 * element stays compact instead of reserving a full square.
 */
function buildPhrase(
  index: number,
  dpr: number,
  makeBand: (w: number, h: number) => ImageData,
): PhraseRender {
  const layout = layoutVoxelText(PHRASES[index]!, {
    depth: DEPTH,
    emissive: EMISSIVE,
    color: phraseColor(ACCENTS[index % ACCENTS.length]!),
    letterSpacing: 1,
    lineSpacing: LINE_SPACING,
  });
  const margin = BOB_AMP + DEPTH + 3;
  const spanX = layout.width + 2 * margin;
  // Voxel size in device pixels: CELL_CSS×DPR for a crisp buffer, shrunk only if
  // a long tagline would overflow the buffer cap.
  const cell = Math.max(3, Math.min(CELL_CSS * dpr, Math.floor(MAX_BUFFER / spanX)));
  const size = Math.ceil((Math.max(layout.width, layout.height) + 2 * margin) * cell);
  const bandHeight = Math.min(size, Math.ceil((layout.height + 2 * (BOB_AMP + 2) + DEPTH) * cell));
  const bandTop = Math.floor((size - bandHeight) / 2);
  return {
    layout,
    cell,
    size,
    bandHeight,
    bandTop,
    out: new Uint8ClampedArray(size * size * 4),
    depth: new Float32Array(size * size),
    band: makeBand(size, bandHeight),
  };
}

export function VoxelHeadline() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Seat the headline at its world anchor under the shared scene camera, so it is
  // positioned in 3D (up and back by default) rather than merely stacked on top.
  const anchorTransform = useSceneAnchorTransform(TAGLINE_ANCHOR, true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const makeBand = (w: number, h: number) => context.createImageData(w, h);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = headlinePixelRatio();

    let phraseIndex = 0;
    let current = buildPhrase(phraseIndex, dpr, makeBand);

    // Size the visible canvas's backing store to the tagline's band. Its on-screen
    // size comes from CSS `max-width`/`max-height` acting on the canvas's intrinsic
    // aspect (this backing store), so the headline scales to fit its header band
    // without reserving layout height or distorting — the type never pushes the
    // handhelds down.
    const fitCanvas = (render: PhraseRender) => {
      if (canvas.width !== render.size || canvas.height !== render.bandHeight) {
        canvas.width = render.size;
        canvas.height = render.bandHeight;
      }
    };
    fitCanvas(current);

    // Draw one frame of a tagline at time `seconds` with opacity `alpha`.
    const draw = (render: PhraseRender, seconds: number, alpha: number) => {
      const { layout, cell, size, out, depth, band, bandTop, bandHeight } = render;
      const yaw = SWAY_AMP * Math.sin(seconds * SWAY_SPEED);
      const models: PlacedModel[] = layout.letters.map((letter, i) => {
        const bob = BOB_AMP * Math.sin(seconds * BOB_SPEED + i * PHASE_STEP);
        return { model: letter.model, position: [letter.position[0], letter.position[1] + bob, letter.position[2]] };
      });
      renderScene(models, {
        size,
        cell,
        yaw,
        pitch: PITCH,
        origin: [0, 0, 0],
        light: HEADLINE_LIGHT,
        out,
        depthBuffer: depth,
      });
      // Copy just the central band (the type) to the visible canvas.
      band.data.set(out.subarray(bandTop * size * 4, (bandTop + bandHeight) * size * 4));
      context.putImageData(band, 0, 0);
      canvas.style.opacity = String(alpha);
    };

    // Reduced motion: a single, still, fully-opaque frame of the first tagline.
    if (reducedMotion) {
      draw(current, 0, 1);
      return () => {};
    }

    let frame = 0;
    const start = performance.now();
    let phraseStart = start;
    let lastPaint = 0;
    const loop = (now: number) => {
      // The bob is slow, so ~30fps looks identical to 60 at half the render cost.
      if (now - lastPaint < FRAME_INTERVAL_MS) {
        frame = window.requestAnimationFrame(loop);
        return;
      }
      lastPaint = now;
      const seconds = (now - start) / 1000;
      const elapsed = now - phraseStart;
      if (elapsed >= PHRASE_MS) {
        phraseIndex = (phraseIndex + 1) % PHRASES.length;
        current = buildPhrase(phraseIndex, dpr, makeBand);
        fitCanvas(current);
        phraseStart = now;
      }
      const held = now - phraseStart;
      // Ease opacity up over the first FADE_MS and back down over the last.
      const alpha = Math.min(1, held / FADE_MS, Math.max(0, (PHRASE_MS - held) / FADE_MS));
      draw(current, seconds, alpha);
      frame = window.requestAnimationFrame(loop);
    };
    frame = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <div className={styles.voxelHead} style={{ transform: anchorTransform }}>
      {/* The real heading for assistive tech + SEO; the voxel canvas is decorative. */}
      <h1 className={styles.visuallyHidden}>Choose your handheld</h1>
      <canvas ref={canvasRef} className={styles.voxelHeadCanvas} aria-hidden />
    </div>
  );
}
