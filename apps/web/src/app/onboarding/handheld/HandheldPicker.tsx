"use client";

/**
 * Handheld selection screen. A new player picks a premade skin from a carousel —
 * their working "Custom" handheld sits centred and large, flanked by the smaller
 * premades — then fine-tunes it through a single parameter switch: pick a part
 * (chassis, D-pad, buttons, phosphor, scanlines, marquee…) and a matching control
 * unfolds beneath. The live preview is rendered by the pure `renderHandheld`
 * model. Choosing saves the scheme + screen tuning to the profile (and
 * localStorage) and moves on to `?next` (their profile by default). Detailed
 * pixel edits happen in a pixel tool via the downloadable `.aseprite` template.
 */

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import {
  HANDHELD_PRESETS,
  HANDHELD_REGIONS,
  renderHandheld,
  compositeDoc,
  handheldPreset,
  parseAsepriteLayers,
  extractSchemeFromLayers,
  proPaletteHex,
  DEFAULT_HANDHELD_PRESET_ID,
  type HandheldScheme,
  type HandheldTemplate,
  type HandheldBackground,
} from "@cartbox/editor";

import { authHeaders } from "@/lib/supabase-browser";
import { isStaticExport } from "@/lib/staticSite";
import { CUSTOM_PRESET_ID, CUSTOM_ART_PRESET_ID, normalizeHandheld, type HandheldArt, type StoredHandheld } from "@/lib/handheld";
import { loadHandheldTemplate } from "@/lib/handheldTemplate";
import { saveHandheldDraft, loadHandheldDraft, clearHandheldDraft, type HandheldDraft } from "@/lib/handheldDraft";
import { assembleSheetCanvas } from "@/lib/handheldSheet";
import { ANIMATED_PRESETS, animatedPresetView, renderAnimatedArt } from "@/lib/handheldAnimated";
import { decodeBackgroundSource, readImageBackground, renderBackgroundArt } from "@/lib/handheldBackground";
import {
  loadConsoleSettings,
  saveConsoleSettings,
  OS_STYLES,
  OS_PHOSPHORS,
  type OsPhosphorId,
  type OsStyleId,
} from "@/app/console/consoleSettings";
import { handheldAssetUrl } from "@/lib/handheldAssets";
import { HandheldSkinEditor } from "./HandheldSkinEditor";
import { useChassisColor } from "./chassisColor";
import { TerminalPreview } from "./TerminalPreview";
import styles from "./handheld.module.css";

/** Where the anonymous/offline choice is remembered until an account exists. */
export const LOCAL_HANDHELD_KEY = "cartbox.handheld";

/**
 * The marquee each premade ships with. Loading a premade loads its marquee too
 * (the player can switch it afterwards via the Marquee parameter), so every
 * premade arrives with an arcade scene playing on its chassis. Ids reference
 * `ANIMATED_PRESETS`; premades outnumber the scenes, so a few scenes recur.
 */
const PREMADE_MARQUEE: Record<string, string> = {
  red: "anim-pac-man",
  orange: "anim-virtual-pet",
  yellow: "anim-xp-bar",
  green: "anim-space-invaders",
  blue: "anim-gamertag",
  indigo: "anim-asteroids",
  violet: "anim-bullet-hell",
  graphite: "anim-equalizer",
  white: "anim-gamertag",
};

/** The hex glow of each phosphor preset, mirroring the console.css tints — used
 * to seed the custom colour picker and its swatch so it opens on the live hue. */
const PHOSPHOR_HEX: Record<OsPhosphorId, string> = {
  green: "#6bffb0",
  amber: "#ffc65e",
  cyan: "#6bf0ff",
  red: "#ff6f6f",
};

/** How a customizable part is edited: a flat colour, the phosphor glow, the
 * scanline toggle, the marquee scene, the on-screen OS style, or the free-form
 * pixel-art tools. */
type ParamKind = "color" | "phosphor" | "scanlines" | "marquee" | "screen" | "draw";

interface ParamDef {
  readonly id: string;
  readonly label: string;
  readonly kind: ParamKind;
  /** For colour params, the scheme region it recolours. */
  readonly regionId?: keyof HandheldScheme;
}

/**
 * The parameter selector, in the order the ‹ › switch steps through it: the nine
 * recolour regions first (chassis → button letters), then the screen/marquee
 * controls, and finally the free-form drawing tools. Exactly one option shows at
 * a time, and its matching control unfolds beneath the selector.
 */
const CUSTOMIZE_PARAMS: readonly ParamDef[] = [
  ...HANDHELD_REGIONS.map((region) => ({
    id: region.id,
    label: region.label,
    kind: "color" as const,
    regionId: region.id as keyof HandheldScheme,
  })),
  { id: "screen", label: "Screen", kind: "screen" },
  { id: "phosphor", label: "Phosphor", kind: "phosphor" },
  { id: "scanlines", label: "Scanlines", kind: "scanlines" },
  { id: "marquee", label: "Marquee", kind: "marquee" },
  { id: "draw", label: "Draw your own", kind: "draw" },
];

/** Flatten a resumed draft into displayable art (a sprite sheet when animated). */
function draftToArt(draft: HandheldDraft): HandheldArt | null {
  const first = draft.frames[0];
  if (!first) return null;
  const canvas = assembleSheetCanvas(draft.frames.map(compositeDoc), first.width, first.height);
  const url = canvas.toDataURL("image/png");
  return draft.frames.length > 1
    ? { url, w: first.width, h: first.height, frames: draft.frames.length, durationMs: draft.frameMs }
    : { url, w: first.width, h: first.height };
}

/** The device screen rectangle (0..1 fractions) from the measured layout. */
type ScreenRect = { x: number; y: number; w: number; h: number };

/** One premade in the ring (an element of HANDHELD_PRESETS). */
type Premade = (typeof HANDHELD_PRESETS)[number];

/**
 * How far the tinted screen overlay grows past the measured screen window, in
 * CSS pixels per side. The chassis render leaves the screen as a transparent
 * hole; without a little bleed the backdrop shows through along its edges.
 */
const SCREEN_BLEED_PX = 5;

/** Absolute box for a screen overlay, bled out so no edge of the hole shows. */
function screenBoxStyle(rect: ScreenRect): CSSProperties {
  return {
    left: `calc(${rect.x * 100}% - ${SCREEN_BLEED_PX}px)`,
    top: `calc(${rect.y * 100}% - ${SCREEN_BLEED_PX}px)`,
    width: `calc(${rect.w * 100}% + ${SCREEN_BLEED_PX * 2}px)`,
    height: `calc(${rect.h * 100}% + ${SCREEN_BLEED_PX * 2}px)`,
  };
}

/**
 * Resize a canvas only when the size actually changes. Assigning `width`/`height`
 * clears the canvas even when the value is unchanged, which would blank a device
 * that is merely being repainted with new content.
 */
function resizeCanvas(canvas: HTMLCanvasElement, width: number, height: number): void {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

/**
 * Sprite sheets already decoded for a previous playback, keyed by their source
 * URL. Turning the carousel re-points every device at a different premade, so
 * without this each turn would decode the same sheets again — asynchronously,
 * leaving the canvases blank until they landed (the flicker while flipping).
 */
const decodedSheets = new Map<string, HTMLImageElement>();

/**
 * Resolve a sheet to a decoded image, calling back *synchronously* when it has
 * been decoded before so the caller can paint within the same frame. Returns a
 * cleanup that detaches a pending callback.
 */
function loadSheet(url: string, onReady: (image: HTMLImageElement) => void): () => void {
  let image = decodedSheets.get(url);
  if (!image) {
    image = new Image();
    image.src = url;
    decodedSheets.set(url, image);
  }
  const sheet = image;
  if (sheet.complete && sheet.naturalWidth > 0) {
    onReady(sheet);
    return () => {};
  }
  const handleLoad = () => onReady(sheet);
  sheet.addEventListener("load", handleLoad);
  return () => sheet.removeEventListener("load", handleLoad);
}

/**
 * Paint a `HandheldArt` onto a canvas: an animation (multi-frame sprite sheet)
 * plays back on an interval; a single-frame image draws once. Returns a cleanup
 * that stops the interval. Shared by the centred handheld and the flanks so both
 * animate their marquee identically.
 */
function playArt(canvas: HTMLCanvasElement, art: HandheldArt): () => void {
  const context = canvas.getContext("2d");
  if (!context) return () => {};
  let timer: number | undefined;

  const stopLoading = loadSheet(art.url, (image) => {
    // Multi-frame sheets are `art.w * frames` wide and are drawn one frame at a
    // time through a source rect; a single frame is just the whole image.
    const frames = art.frames && art.frames > 1 ? art.frames : 1;
    const width = frames > 1 ? art.w : image.naturalWidth;
    const height = frames > 1 ? art.h : image.naturalHeight;
    resizeCanvas(canvas, width, height);

    let index = 0;
    const paint = () => {
      context.clearRect(0, 0, width, height);
      context.drawImage(image, index * width, 0, width, height, 0, 0, width, height);
      index = (index + 1) % frames;
    };
    paint();
    if (frames > 1) timer = window.setInterval(paint, art.durationMs ?? 120);
  });

  return () => {
    stopLoading();
    if (timer !== undefined) window.clearInterval(timer);
  };
}

/**
 * Recoloured chassis pixels, keyed by premade id. A premade's colours are fixed,
 * so its full-resolution composite is computed once instead of on every carousel
 * turn (nine devices × a 867×1579 recolour per turn is what stalled the flip).
 */
const chassisCache = new Map<string, ImageData>();

/**
 * Draw the static recoloured chassis, reusing the cached composite when the
 * scheme is a premade's (`cacheKey`) and computing it fresh otherwise (the
 * centred handheld's scheme changes as the player tunes it).
 */
function paintChassis(
  canvas: HTMLCanvasElement,
  template: HandheldTemplate,
  scheme: HandheldScheme,
  cacheKey?: string,
): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  resizeCanvas(canvas, template.width, template.height);
  let pixels = cacheKey ? chassisCache.get(cacheKey) : undefined;
  if (!pixels) {
    pixels = context.createImageData(template.width, template.height);
    pixels.data.set(renderHandheld(template, scheme));
    if (cacheKey) chassisCache.set(cacheKey, pixels);
  }
  context.putImageData(pixels, 0, 0);
}

/** Whether two schemes assign the same colour to every region. */
function sameScheme(a: HandheldScheme, b: HandheldScheme): boolean {
  const keys = Object.keys(a) as (keyof HandheldScheme)[];
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * Rendered animated marquees for the premades, keyed by preset id. Premade
 * colours are fixed, so each is rendered once and reused across carousel turns
 * (rendering every frame of a scene per flank is expensive to repeat). The cache
 * is pre-warmed on load so flanks render their animation instantly instead of
 * computing it lazily as each one appears.
 */
const flankArtCache = new Map<string, HandheldArt>();
/** Presets whose art is mid-render, so a warm request is never duplicated. */
const flankArtPending = new Set<string>();
/** Notified whenever a preset's art lands in the cache, so mounted flanks swap. */
const flankArtListeners = new Set<() => void>();

function subscribeFlankArt(listener: () => void): () => void {
  flankArtListeners.add(listener);
  return () => {
    flankArtListeners.delete(listener);
  };
}

/**
 * Render one premade's animated marquee into the cache exactly once, off the
 * critical path. The work yields to the browser (idle callback) so warming the
 * whole ring never blocks the first paint or an interaction.
 */
function ensureFlankArt(template: HandheldTemplate, preset: Premade, marqueeId: string | null): void {
  if (!marqueeId || flankArtCache.has(preset.id) || flankArtPending.has(preset.id)) return;
  const view = animatedPresetView(marqueeId);
  if (!view) return;
  flankArtPending.add(preset.id);
  const run = () => {
    try {
      flankArtCache.set(preset.id, renderAnimatedArt(template, preset.scheme, view));
    } catch {
      /* Leave it uncached; the flank keeps showing its static chassis. */
    }
    flankArtPending.delete(preset.id);
    flankArtListeners.forEach((listener) => listener());
  };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: 800 });
  } else {
    window.setTimeout(run, 0);
  }
}

/**
 * A flanking premade: its chassis rendered live (so it always matches the
 * preset's scheme) with its marquee animating in the marquee panel, and a lit
 * screen tinted to the chassis colour so the screen never reads as a see-through
 * hole. Clicking it brings the premade to the centre.
 */
function PremadeFlank({
  template,
  preset,
  marqueeId,
  width,
  screenRect,
  onClick,
}: {
  template: HandheldTemplate;
  preset: Premade;
  marqueeId: string | null;
  width: number;
  screenRect: ScreenRect | null;
  onClick: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [art, setArt] = useState<HandheldArt | null>(() => flankArtCache.get(preset.id) ?? null);

  // Ensure this premade's marquee is queued for rendering, then adopt it from the
  // cache the moment it lands (whether this flank or the pre-warm rendered it).
  useEffect(() => {
    ensureFlankArt(template, preset, marqueeId);
    const sync = () => {
      const cached = marqueeId ? flankArtCache.get(preset.id) ?? null : null;
      setArt((current) => (current === cached ? current : cached));
    };
    sync();
    return subscribeFlankArt(sync);
  }, [template, preset, marqueeId]);

  // Draw the static recoloured chassis immediately so the device is never blank,
  // then play the animated marquee over it. Both paint synchronously once their
  // composite/sheet is cached, so a repaint never shows a blank frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    paintChassis(canvas, template, preset.scheme, preset.id);
    if (art) return playArt(canvas, art);
  }, [art, template, preset]);

  return (
    <div
      className={styles.flankWrap}
      style={{ width }}
      onClick={onClick}
      role="button"
      aria-label={`${preset.label} handheld`}
    >
      <canvas ref={canvasRef} className={styles.flankCanvas} />
      {screenRect && (
        <div
          className={styles.flankScreen}
          style={{ ...screenBoxStyle(screenRect), "--ui": preset.scheme.face } as CSSProperties}
        />
      )}
    </div>
  );
}

/**
 * A grid of fixed colour swatches (the 64-colour Pro palette) — the colour
 * picker for every recolourable part, replacing the OS gradient picker so a
 * choice is one tap on a consistent set of colours.
 */
function SwatchGrid({ value, onPick }: { value: string; onPick: (hex: string) => void }) {
  const palette = useMemo(() => proPaletteHex(), []);
  const current = value.toLowerCase();
  return (
    <div className={styles.swatchGrid} role="listbox" aria-label="Colour swatches">
      {palette.map((hex) => {
        const active = hex.toLowerCase() === current;
        return (
          <button
            key={hex}
            type="button"
            role="option"
            aria-selected={active}
            className={`${styles.swatchCell} ${active ? styles.swatchCellActive : ""}`}
            style={{ background: hex }}
            onClick={() => onPick(hex)}
            title={hex}
          />
        );
      })}
    </div>
  );
}

/** Index of a premade in the ring, or the default premade's slot when unknown. */
function presetIndex(id: string): number {
  const index = HANDHELD_PRESETS.findIndex((preset) => preset.id === id);
  if (index >= 0) return index;
  const fallback = HANDHELD_PRESETS.findIndex((preset) => preset.id === DEFAULT_HANDHELD_PRESET_ID);
  return fallback >= 0 ? fallback : 0;
}

export function HandheldPicker() {
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get("next") || "/profile/edit";

  const defaultPreset = handheldPreset(DEFAULT_HANDHELD_PRESET_ID);
  const [template, setTemplate] = useState<HandheldTemplate | null>(null);
  const [presetId, setPresetId] = useState<string>(defaultPreset.id);
  const [scheme, setScheme] = useState<HandheldScheme>(defaultPreset.scheme);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  // Free-form pixel art drawn in the editor; when set it supersedes the scheme.
  const [drawnArt, setDrawnArt] = useState<HandheldArt | null>(null);
  // The selected marquee animation (a preset id), independent of the chassis
  // colours. When set, the displayed/saved skin is rendered live from `scheme`,
  // so recolouring recolours the animation too. Seeded from the default premade
  // so a fresh player lands on that premade with its marquee playing.
  const [animationId, setAnimationId] = useState<string | null>(PREMADE_MARQUEE[defaultPreset.id] ?? null);
  const [animatedArt, setAnimatedArt] = useState<HandheldArt | null>(null);
  const [animatedError, setAnimatedError] = useState<string | null>(null);
  // A colour for the marquee scene chosen independently of the chassis. Null
  // means the scene follows the button accent (the default). Only applies while
  // a marquee is selected.
  const [marqueeColor, setMarqueeColor] = useState<string | null>(null);
  // An uploaded image shown through the chassis (`face`) region. Like an
  // animation it rides on the current chassis and re-renders when the scheme
  // changes, so recolouring the chrome keeps the background.
  const [background, setBackground] = useState<HandheldBackground | null>(null);
  const [backgroundArt, setBackgroundArt] = useState<HandheldArt | null>(null);
  // The persistable source image (a PNG data URL) behind `background`, saved so a
  // returning session or the live console can re-composite it after recolouring.
  const [backgroundSource, setBackgroundSource] = useState<HandheldArt | null>(null);
  // The editor's working draft (animation frames), kept so re-opening resumes
  // the same work instead of restarting from the scheme render. Dropped when the
  // design is changed another way (preset, recolour, upload).
  const [draft, setDraft] = useState<HandheldDraft | null>(null);
  const [editing, setEditing] = useState(false);
  // The on-screen OS skin (a separate axis from the device art) and its tuning.
  // Seeded from any stored console settings so returning players keep their pick.
  const [osStyle, setOsStyle] = useState<OsStyleId>("pipboy");
  const [osPhosphor, setOsPhosphor] = useState<OsPhosphorId>("green");
  // A free-form phosphor hue; when set it overrides the preset for extra variety.
  const [osPhosphorColor, setOsPhosphorColor] = useState<string | null>(null);
  const [osScanlines, setOsScanlines] = useState(true);
  // Which slot of the premade ring is centred, and which parameter the ‹ ›
  // selector is showing. Exactly one parameter is always selected (index into
  // CUSTOMIZE_PARAMS); its control unfolds beneath the selector.
  const [carouselIndex, setCarouselIndex] = useState<number>(() => presetIndex(defaultPreset.id));
  const [activeIndex, setActiveIndex] = useState<number>(0);
  // How many premades flank the centre on each side, and the centre device's
  // pixel width — both measured from the available space so the carousel fits as
  // many handhelds as the screen allows and steps each flank down in size.
  const [flanksPerSide, setFlanksPerSide] = useState<number>(0);
  const [centerWidth, setCenterWidth] = useState<number>(0);
  // The device screen rectangle (0..1 fractions) from the measured layout, used
  // to overlay the live interface preview inside the handheld's screen.
  const [screenRect, setScreenRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const carouselRef = useRef<HTMLElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const backgroundUploadRef = useRef<HTMLInputElement>(null);
  // Where a touch began, so the carousel can turn a horizontal swipe into a
  // premade change on mobile (where the flanks are hidden).
  const touchStartX = useRef<number | null>(null);

  // Bumped whenever a premade's marquee lands in the flank cache, so the centre
  // picks up a pre-warmed render as soon as it exists.
  const [flankArtVersion, setFlankArtVersion] = useState(0);
  useEffect(() => subscribeFlankArt(() => setFlankArtVersion((version) => version + 1)), []);

  // Turning the carousel lands on an untouched premade, whose marquee the flank
  // pre-warm has already rendered — reuse it rather than re-rendering it behind
  // the debounce below, which would leave the previous premade's marquee playing
  // on the centre for a beat after every flip.
  const premadeArt = useMemo(() => {
    // A chosen marquee colour is not baked into the flank cache (those follow the
    // button accent), so a custom colour must fall through to a live render.
    if (marqueeColor) return null;
    const preset = HANDHELD_PRESETS.find((candidate) => candidate.id === presetId);
    if (!preset || !animationId || PREMADE_MARQUEE[preset.id] !== animationId) return null;
    if (!sameScheme(preset.scheme, scheme)) return null;
    return flankArtCache.get(preset.id) ?? null;
    // `flankArtVersion` is the cache's change signal, not an unused dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetId, scheme, animationId, marqueeColor, flankArtVersion]);

  // What actually renders/saves, in priority order: a live animation, else an
  // uploaded chassis background, else hand-drawn art, else the static recoloured
  // skin (art === null).
  const activeArt = animationId ? premadeArt ?? animatedArt : background ? backgroundArt : drawnArt;

  // Publish the chassis colour so the backdrop can tint itself to it.
  const { setColor } = useChassisColor();
  useEffect(() => {
    setColor(scheme.face);
  }, [scheme.face, setColor]);

  // Stage caption: the chassis name, with the animation appended when set.
  const chassisLabel =
    background && !animationId
      ? "Custom background"
      : drawnArt && !animationId
        ? "Custom art"
        : presetId === CUSTOM_PRESET_ID || presetId === CUSTOM_ART_PRESET_ID
          ? "Custom"
          : handheldPreset(presetId).label;
  const animationLabel = animationId ? animatedPresetView(animationId)?.label : null;
  const stageLabel = animationLabel ? `${chassisLabel} · ${animationLabel}` : chassisLabel;

  // The premades flanking the centred handheld, shown at full opacity but
  // stepping down in size the further they sit from the centre. The step is
  // geometric (each flank is `ratio×` its inner neighbour); the ratio widens
  // toward 1 as more flanks fit, so a crowded carousel steps down more gently
  // than a sparse one (a lone flank lands at 75% — the sparse-case target).
  const presetCount = HANDHELD_PRESETS.length;
  const flankRatio = 1 - 0.25 / Math.max(flanksPerSide, 1);
  const flankScale = (step: number) => Math.pow(flankRatio, step);
  const flankAt = (offset: number) =>
    HANDHELD_PRESETS[((carouselIndex + offset) % presetCount + presetCount) % presetCount]!;
  // Outermost-first on the left (…‑2, ‑1) and inner-first on the right (1, 2…),
  // so the ring reads continuously left-to-right around the centre.
  const leftFlanks = Array.from({ length: flanksPerSide }, (_, i) => flanksPerSide - i);
  const rightFlanks = Array.from({ length: flanksPerSide }, (_, i) => i + 1);

  // Jump straight to a flanked premade when it is clicked (the arrows/swipe move
  // one at a time; clicking a distant flank brings it to the centre directly).
  const goToPreset = (index: number) => {
    setCarouselIndex(index);
    choosePreset(HANDHELD_PRESETS[index]!);
  };

  // Pre-warm every premade's animated marquee once the chrome is loaded, so a
  // flank (including ones revealed by turning the carousel) shows its animation
  // instantly from cache instead of rendering it on the fly.
  useEffect(() => {
    if (!template) return;
    for (const preset of HANDHELD_PRESETS) {
      ensureFlankArt(template, preset, PREMADE_MARQUEE[preset.id] ?? null);
    }
  }, [template]);

  // Measure the available width and the viewport height to decide how many
  // handhelds fit and how big the centre one should be. Re-runs on resize.
  useEffect(() => {
    const carousel = carouselRef.current;
    if (!carousel || !template) return;
    const aspect = template.width / template.height; // device width ÷ height
    const GAP = 10; // must match the carousel's flex gap
    const ARROW = 44;

    const measure = () => {
      const available = carousel.clientWidth;
      if (available <= 0) return;
      // Centre size: tall enough to stay under the fold (≤52vh), never wider than
      // the space allows on a narrow screen, and capped so it is not huge on a
      // big display.
      const byHeight = 0.52 * window.innerHeight * aspect;
      const byWidth = available * 0.9;
      const center = Math.max(150, Math.min(300, byHeight, byWidth));
      const usable = available - 2 * (ARROW + GAP); // reserve the ‹ › buttons

      // Take the most flanks (each side) whose stepped-down widths still fit.
      let fits = 0;
      for (let candidate = 5; candidate >= 1; candidate--) {
        const ratio = 1 - 0.25 / candidate;
        let flanksWidth = 0;
        for (let step = 1; step <= candidate; step++) flanksWidth += Math.pow(ratio, step);
        flanksWidth *= 2 * center; // both sides
        const gaps = 2 * candidate * GAP;
        if (center + flanksWidth + gaps <= usable) {
          fits = candidate;
          break;
        }
      }
      setCenterWidth(center);
      setFlanksPerSide(fits);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(carousel);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template]);

  // Load the shared chrome + region mask once, then restore any saved drawing so
  // a reload resumes it — both as the editable draft and in the live preview.
  useEffect(() => {
    let alive = true;
    loadHandheldTemplate()
      .then(async (loaded) => {
        if (!alive) return;
        setTemplate(loaded);
        const savedDraft = await loadHandheldDraft(loaded.width, loaded.height);
        if (!alive || !savedDraft) return;
        setDraft(savedDraft);
        const restoredArt = draftToArt(savedDraft);
        if (restoredArt) {
          setDrawnArt(restoredArt);
          setPresetId(CUSTOM_ART_PRESET_ID);
        }
      })
      .catch(() => alive && setError("Could not load the handheld artwork."));
    return () => {
      alive = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resume the player's current handheld when they come back to edit it: seed the
  // scheme, preset and any custom art from what the console is showing. Runs once
  // on mount; a saved editor draft (loaded above) still wins for the art, so an
  // in-progress drawing is not lost.
  useEffect(() => {
    const raw = window.localStorage.getItem(LOCAL_HANDHELD_KEY);
    if (!raw) return;
    try {
      const stored = normalizeHandheld(JSON.parse(raw));
      setScheme(stored.scheme);
      setPresetId(stored.presetId);
      setCarouselIndex(presetIndex(stored.presetId));
      // An animation re-renders live from the scheme, so restore the selection
      // rather than the baked sheet; otherwise restore any hand-drawn art. When
      // no animation was stored, clear the default marquee so a returning player
      // who turned it off keeps it off.
      if (stored.animation) {
        const view = ANIMATED_PRESETS.find((preset) => preset.game === stored.animation);
        setAnimationId(view ? view.id : null);
        if (view && stored.marqueeColor) setMarqueeColor(stored.marqueeColor);
      } else {
        setAnimationId(null);
        if (stored.background) {
          // Resume the chassis background: keep the source for saving and decode
          // it back to pixels so recolouring re-composites it live.
          setBackgroundSource(stored.background);
          void decodeBackgroundSource(stored.background)
            .then(setBackground)
            .catch(() => {
              /* Corrupt source; the recoloured skin still shows. */
            });
        } else if (stored.art) {
          setDrawnArt(stored.art);
        }
      }
    } catch {
      // Ignore a corrupt stored value; the defaults stand.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seed the OS-skin controls from stored console settings (normalized), so the
  // selector reflects the player's current choice rather than resetting it.
  useEffect(() => {
    const settings = loadConsoleSettings();
    setOsStyle(settings.osStyle);
    setOsPhosphor(settings.osPhosphor);
    setOsPhosphorColor(settings.osPhosphorColor);
    setOsScanlines(settings.osScanlines);
  }, []);

  // Load the measured device layout so the interface preview can sit in the
  // handheld's actual screen window. A failure just hides the overlay.
  useEffect(() => {
    let alive = true;
    fetch(handheldAssetUrl("/handheld/handheld-layout.json"))
      .then((response) => response.json() as Promise<{ screen: { x: number; y: number; w: number; h: number } }>)
      .then((layout) => alive && setScreenRect(layout.screen))
      .catch(() => {
        /* No overlay if the layout can't load; the device still renders. */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Render the uploaded chassis background live in the current chassis colours.
  // Debounced (like the animation) so dragging a colour slider coalesces into a
  // single composite. Clears when no background image is set.
  useEffect(() => {
    if (!template || !background) {
      setBackgroundArt(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      try {
        const rendered = renderBackgroundArt(template, scheme, background);
        if (!cancelled) setBackgroundArt(rendered);
      } catch {
        if (!cancelled) setError("Could not apply that background image.");
      }
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [template, scheme, background]);

  // Render the selected animation live in the current chassis colours. Debounced
  // so dragging a colour slider coalesces into one render (each frame is a full
  // template composite). Clears when no animation is selected.
  useEffect(() => {
    if (!template || !animationId) {
      setAnimatedArt(null);
      return;
    }
    // An untouched premade already has its marquee cached; `activeArt` prefers
    // that render, so there is nothing to compute.
    if (premadeArt) return;
    const view = animatedPresetView(animationId);
    if (!view) {
      setAnimatedArt(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      try {
        const rendered = renderAnimatedArt(template, scheme, view, marqueeColor);
        if (!cancelled) setAnimatedArt(rendered);
      } catch {
        if (!cancelled) setAnimatedError(`Could not render the ${view.label} animation.`);
      }
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [template, scheme, animationId, marqueeColor, premadeArt]);

  // Re-render the live preview. Custom pixel art or the selected marquee (when
  // present) wins over the region-recoloured scheme, so the preview always shows
  // what will be saved; the marquee animates via the shared `playArt` playback.
  // The static recoloured chassis is drawn first (unless a single-frame custom
  // drawing/background is active, which isn't scheme-derived) so the device is
  // never blank while an animation sheet decodes — its base colours match.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !template) return;

    const isAnimated = Boolean(activeArt?.frames && activeArt.frames > 1);
    if (!activeArt || isAnimated) {
      // Cache the composite under the premade's id whenever the scheme is still
      // that premade's, so flipping back and forth doesn't recompute it.
      const preset = HANDHELD_PRESETS.find((candidate) => candidate.id === presetId);
      const cacheKey = preset && sameScheme(preset.scheme, scheme) ? preset.id : undefined;
      paintChassis(canvas, template, scheme, cacheKey);
    }
    if (activeArt) return playArt(canvas, activeArt);
  }, [template, scheme, activeArt, presetId]);

  // Load a premade into the centred handheld: set its colours and its marquee,
  // and drop any hand-drawn art or uploaded background (a premade is a fresh
  // starting point). Recolouring afterwards forks it to "Custom" in place.
  const choosePreset = (preset: (typeof HANDHELD_PRESETS)[number]) => {
    setPresetId(preset.id);
    setScheme(preset.scheme);
    setDrawnArt(null);
    setDraft(null);
    clearHandheldDraft();
    setAnimatedError(null);
    setAnimationId(PREMADE_MARQUEE[preset.id] ?? null);
    setMarqueeColor(null); // a premade's marquee follows its own button accent
    clearBackground();
  };

  // Turn the carousel by one premade (arrows on desktop, swipe on mobile), which
  // loads that premade into the centre.
  const turnCarousel = (direction: 1 | -1) => {
    const nextIndex = (carouselIndex + direction + presetCount) % presetCount;
    setCarouselIndex(nextIndex);
    choosePreset(HANDHELD_PRESETS[nextIndex]!);
  };

  const onTouchStart = (event: React.TouchEvent) => {
    touchStartX.current = event.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (event: React.TouchEvent) => {
    const start = touchStartX.current;
    touchStartX.current = null;
    if (start === null) return;
    const delta = (event.changedTouches[0]?.clientX ?? start) - start;
    if (Math.abs(delta) < 40) return; // ignore taps and tiny drags
    turnCarousel(delta < 0 ? 1 : -1); // swipe left → next premade
  };

  const recolour = (regionId: keyof HandheldScheme, color: string) => {
    setScheme((current) => ({ ...current, [regionId]: color }));
    setPresetId(CUSTOM_PRESET_ID);
    setDrawnArt(null);
    setDraft(null);
    clearHandheldDraft();
  };

  // Pick (or clear) the marquee animation. It rides on the current chassis and
  // renders live from `scheme` via the effect above, so it works on ANY handheld
  // and recolours with the chassis. Null turns the animation off.
  const chooseAnimation = (id: string | null) => {
    setAnimatedError(null);
    setAnimationId(id);
    if (id) clearBackground(); // an animation and a chassis background are exclusive
    else setMarqueeColor(null); // turning the marquee off drops its colour override
  };

  const clearBackground = () => {
    setBackground(null);
    setBackgroundArt(null);
    setBackgroundSource(null);
  };

  // Upload an image to show through the chassis. It supersedes any hand-drawn
  // art or animation, and re-renders live when the chrome colours change.
  const uploadBackground = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);
    setUploadNote("Reading image…");
    try {
      const { pixels, source } = await readImageBackground(file);
      setBackground(pixels);
      setBackgroundSource(source);
      setAnimationId(null);
      setDrawnArt(null);
      setDraft(null);
      clearHandheldDraft();
      setPresetId(CUSTOM_ART_PRESET_ID);
      setUploadNote(`Applied ${file.name} as the chassis background.`);
    } catch (backgroundError) {
      setUploadNote(backgroundError instanceof Error ? backgroundError.message : "Could not read that image.");
    }
  };

  // Bring back edits made in Aseprite (or any pixel tool) on the downloaded
  // template: read each region's colour from the uploaded file and apply it.
  const importAseprite = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setUploadNote("Reading…");
    try {
      const layers = await parseAsepriteLayers(new Uint8Array(await file.arrayBuffer()));
      setScheme((current) => extractSchemeFromLayers(layers, current));
      setPresetId(CUSTOM_PRESET_ID);
      setDrawnArt(null);
      setDraft(null);
      clearHandheldDraft();
      clearBackground();
      setUploadNote(`Applied colours from ${file.name}.`);
    } catch (importError) {
      setUploadNote(importError instanceof Error ? importError.message : "Could not read that .aseprite file.");
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    // Persist the chassis (presetId + scheme), the active art (live animation or
    // hand-drawn), and the animation game id so re-opening resumes recolouring.
    const animationGame = animationId ? animatedPresetView(animationId)?.game : undefined;
    const handheld: StoredHandheld = {
      presetId,
      scheme,
      ...(activeArt ? { art: activeArt } : {}),
      // Persist the background source (not just the composite) so recolouring in
      // the live console re-composites it instead of dropping it.
      ...(background && backgroundSource && !animationId ? { background: backgroundSource } : {}),
      ...(animationGame ? { animation: animationGame } : {}),
      // A chosen marquee colour only travels with an actual marquee.
      ...(animationGame && marqueeColor ? { marqueeColor } : {}),
    };
    try {
      window.localStorage.setItem(LOCAL_HANDHELD_KEY, JSON.stringify(handheld));
      // Make the live console default to the handheld they just designed, and
      // carry over the OS-skin choices (terminal style + tuning) they set here.
      saveConsoleSettings({
        ...loadConsoleSettings(),
        theme: "handheld",
        osStyle,
        osPhosphor,
        osPhosphorColor,
        osScanlines,
      });
      if (!isStaticExport) {
        const response = await fetch("/api/console/me/handheld", {
          method: "PUT",
          headers: await authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ handheld }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? "Could not save your handheld.");
        }
      }
      // The static demo has no account pages (the profile step needs a server),
      // so boot straight into the console — the chosen skin is already in
      // localStorage, which is where the console reads it from.
      router.push(isStaticExport ? "/console" : next);
      router.refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save your handheld.");
      setSaving(false);
    }
  };

  const activeDef = CUSTOMIZE_PARAMS[activeIndex]!;
  const stepParam = (direction: 1 | -1) =>
    setActiveIndex((index) => (index + direction + CUSTOMIZE_PARAMS.length) % CUSTOMIZE_PARAMS.length);
  const phosphorValue = osPhosphorColor ?? PHOSPHOR_HEX[osPhosphor];

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <h1 className={styles.title}>Choose your handheld</h1>
        <p className={styles.subtitle}>
          Flip through the premades, then tune any part of your own. You can change it later.
        </p>
      </header>

      {/* --- Carousel: the working handheld centred, flanked by premades --- */}
      <section
        ref={carouselRef}
        className={styles.carousel}
        aria-label="Handheld carousel"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <button
          type="button"
          className={styles.carouselArrow}
          onClick={() => turnCarousel(-1)}
          aria-label="Previous premade"
        >
          ‹
        </button>

        {template &&
          leftFlanks.map((step) => {
            const index = ((carouselIndex - step) % presetCount + presetCount) % presetCount;
            const preset = flankAt(-step);
            return (
              <PremadeFlank
                // Keyed by premade, not by slot: turning the carousel shifts the
                // ring, so keying by slot would repaint every flank with a
                // different premade. Keyed this way the surviving flanks just
                // move, and only the one entering the ring paints.
                key={preset.id}
                template={template}
                preset={preset}
                marqueeId={PREMADE_MARQUEE[preset.id] ?? null}
                width={centerWidth * flankScale(step)}
                screenRect={screenRect}
                onClick={() => goToPreset(index)}
              />
            );
          })}

        <div className={styles.centerStage}>
          <div className={styles.stageDevice}>
            <canvas
              ref={canvasRef}
              className={styles.preview}
              style={{ width: centerWidth ? centerWidth : undefined }}
            />
            {/* The live interface preview sits in the handheld's actual screen
                window (positioned from the measured device layout). */}
            {screenRect && (
              <div
                className={styles.screenOverlay}
                style={screenBoxStyle(screenRect)}
              >
                <TerminalPreview
                  fill
                  style={osStyle}
                  phosphor={osPhosphor}
                  phosphorColor={osPhosphorColor}
                  scanlines={osScanlines}
                />
              </div>
            )}
          </div>
          <span className={styles.stageLabel}>{stageLabel}</span>
        </div>

        {template &&
          rightFlanks.map((step) => {
            const index = (carouselIndex + step) % presetCount;
            const preset = flankAt(step);
            return (
              <PremadeFlank
                key={preset.id}
                template={template}
                preset={preset}
                marqueeId={PREMADE_MARQUEE[preset.id] ?? null}
                width={centerWidth * flankScale(step)}
                screenRect={screenRect}
                onClick={() => goToPreset(index)}
              />
            );
          })}

        <button
          type="button"
          className={styles.carouselArrow}
          onClick={() => turnCarousel(1)}
          aria-label="Next premade"
        >
          ›
        </button>
      </section>
      {animatedError && <p className={styles.error}>{animatedError}</p>}

      {/* --- Customize: a single ‹ › selector, one unfolding control --- */}
      <section className={styles.customize} aria-label="Customize">
        <div className={styles.paramSelector} role="group" aria-label="Part to customize">
          <button
            type="button"
            className={styles.paramNav}
            onClick={() => stepParam(-1)}
            aria-label="Previous part"
          >
            ‹
          </button>
          <div className={styles.paramCurrent} aria-live="polite">
            {activeDef.kind === "color" && activeDef.regionId && (
              <span className={styles.paramDot} style={{ background: scheme[activeDef.regionId] }} aria-hidden />
            )}
            {activeDef.kind === "phosphor" && (
              <span className={styles.paramDot} style={{ background: phosphorValue }} aria-hidden />
            )}
            <span className={styles.paramCurrentLabel}>{activeDef.label}</span>
          </div>
          <button
            type="button"
            className={styles.paramNav}
            onClick={() => stepParam(1)}
            aria-label="Next part"
          >
            ›
          </button>
        </div>

        {/* The control for the currently selected part unfolds beneath the
            selector — only its parameters show, nothing else. */}
        <div className={styles.paramPanel}>
          {activeDef.kind === "color" && activeDef.regionId && (
            <div className={styles.controlColumn}>
              <div className={styles.colorMeta}>
                <span className={styles.colorName}>{activeDef.label}</span>
                <span className={styles.colorHex}>{scheme[activeDef.regionId]}</span>
              </div>
              <SwatchGrid
                value={scheme[activeDef.regionId]}
                onPick={(hex) => recolour(activeDef.regionId!, hex)}
              />
              {/* The chassis (face) is where an uploaded background image lives,
                  so its upload/remove controls sit with its colour. */}
              {activeDef.regionId === "face" && (
                <div className={styles.inlineButtons}>
                  <button
                    type="button"
                    className={styles.secondary}
                    onClick={() => backgroundUploadRef.current?.click()}
                  >
                    Upload chassis background
                  </button>
                  {background && (
                    <button type="button" className={styles.secondary} onClick={clearBackground}>
                      Remove background
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {activeDef.kind === "screen" && (
            <div className={styles.segRow} role="group" aria-label="Screen mode">
              {OS_STYLES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`${styles.seg} ${osStyle === option.id ? styles.segActive : ""}`}
                  onClick={() => setOsStyle(option.id)}
                  aria-pressed={osStyle === option.id}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}

          {activeDef.kind === "phosphor" && (
            <div className={styles.phosphorControl}>
              <div className={styles.segRow} role="group" aria-label="Phosphor preset">
                {OS_PHOSPHORS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`${styles.seg} ${osPhosphor === option.id && !osPhosphorColor ? styles.segActive : ""}`}
                    onClick={() => {
                      setOsPhosphor(option.id);
                      setOsPhosphorColor(null);
                    }}
                    aria-pressed={osPhosphor === option.id && !osPhosphorColor}
                  >
                    <span className={styles.paramDot} style={{ background: PHOSPHOR_HEX[option.id] }} aria-hidden />
                    {option.label}
                  </button>
                ))}
              </div>
              <div className={styles.controlColumn}>
                <div className={styles.colorMeta}>
                  <span className={styles.colorName}>Custom glow</span>
                  <span className={styles.colorHex}>{phosphorValue}</span>
                  {osPhosphorColor && (
                    <button type="button" className={styles.linkButton} onClick={() => setOsPhosphorColor(null)}>
                      Reset to preset
                    </button>
                  )}
                </div>
                <SwatchGrid value={phosphorValue} onPick={(hex) => setOsPhosphorColor(hex)} />
              </div>
              {osStyle !== "pipboy" && (
                <p className={styles.paramHint}>Phosphor applies to the Terminal screen — pick the Screen part and choose Pip-Boy Terminal.</p>
              )}
            </div>
          )}

          {activeDef.kind === "scanlines" && (
            <label className={styles.toggleControl}>
              <input type="checkbox" checked={osScanlines} onChange={(event) => setOsScanlines(event.target.checked)} />
              <span>Scanline overlay on the terminal screen</span>
            </label>
          )}

          {/* Marquee is previewed on the handhelds themselves (centre + flanks),
              so the control is just buttons that switch the centre's marquee. */}
          {activeDef.kind === "marquee" && (
            <div className={styles.marqueeControl}>
              <div className={styles.marqueeButtons} role="group" aria-label="Marquee">
                <button
                  type="button"
                  className={`${styles.seg} ${animationId === null ? styles.segActive : ""}`}
                  onClick={() => chooseAnimation(null)}
                  aria-pressed={animationId === null}
                >
                  None
                </button>
                {ANIMATED_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={`${styles.seg} ${animationId === preset.id ? styles.segActive : ""}`}
                    onClick={() => chooseAnimation(preset.id)}
                    aria-pressed={animationId === preset.id}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              {/* Colour the marquee content itself — independent of the chassis
                  buttons it otherwise follows. Only meaningful with a marquee on. */}
              {animationId && (
                <div className={styles.controlColumn}>
                  <div className={styles.colorMeta}>
                    <span className={styles.colorName}>Marquee colour</span>
                    <span className={styles.colorHex}>{marqueeColor ?? "Match buttons"}</span>
                    {marqueeColor && (
                      <button type="button" className={styles.linkButton} onClick={() => setMarqueeColor(null)}>
                        Match buttons
                      </button>
                    )}
                  </div>
                  <SwatchGrid value={marqueeColor ?? scheme.buttonColor} onPick={(hex) => setMarqueeColor(hex)} />
                </div>
              )}
            </div>
          )}

          {activeDef.kind === "draw" && (
            <div className={styles.drawControl}>
              <div className={styles.inlineButtons}>
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => setEditing(true)}
                  disabled={!template}
                >
                  Edit Handheld
                </button>
                <a className={styles.secondary} href={handheldAssetUrl("/handheld/template.aseprite")} download>
                  Download .aseprite template
                </a>
                <button type="button" className={styles.secondary} onClick={() => uploadRef.current?.click()}>
                  Upload edited .aseprite
                </button>
              </div>
              <p className={styles.paramHint}>
                Edit the handheld pixel-by-pixel here, or download the template, recolour it in Aseprite (or any
                pixel-art tool), and upload it back to apply your colours.
              </p>
            </div>
          )}
        </div>
      </section>

      <section className={styles.actions}>
        <button type="button" className={styles.primary} onClick={save} disabled={saving || !template}>
          {saving ? "Saving…" : "Use this handheld"}
        </button>
        <input ref={uploadRef} type="file" accept=".aseprite,.ase" onChange={importAseprite} hidden />
        <input ref={backgroundUploadRef} type="file" accept="image/*" onChange={uploadBackground} hidden />
        {uploadNote && <p className={styles.hint}>{uploadNote}</p>}
        {error && <p className={styles.error}>{error}</p>}
      </section>

      {editing && template && (
        <HandheldSkinEditor
          template={template}
          scheme={scheme}
          initialDraft={draft}
          onCancel={() => setEditing(false)}
          onApply={(drawn, workingDraft) => {
            setDrawnArt(drawn);
            setDraft(workingDraft); // resume from these frames next time
            void saveHandheldDraft(workingDraft); // survive a reload too
            setPresetId(CUSTOM_ART_PRESET_ID);
            setAnimationId(null); // a hand-drawn skin replaces the animation
            clearBackground(); // …and replaces any uploaded background
            setEditing(false);
          }}
        />
      )}
    </main>
  );
}
