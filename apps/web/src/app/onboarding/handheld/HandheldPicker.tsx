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

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import {
  HANDHELD_PRESETS,
  HANDHELD_REGIONS,
  renderHandheld,
  compositeDoc,
  handheldPreset,
  parseAsepriteLayers,
  extractSchemeFromLayers,
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
import { assembleSheetCanvas, sliceSheet } from "@/lib/handheldSheet";
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
 * scanline toggle, or the marquee scene. */
type ParamKind = "color" | "phosphor" | "scanlines" | "marquee";

interface ParamDef {
  readonly id: string;
  readonly label: string;
  readonly kind: ParamKind;
  /** For colour params, the scheme region it recolours. */
  readonly regionId?: keyof HandheldScheme;
}

/**
 * The parameter switch, in the order the screen presents it: the nine recolour
 * regions first (chassis → button letters), then the three screen/marquee
 * controls. Selecting one unfolds its control beneath the switch.
 */
const CUSTOMIZE_PARAMS: readonly ParamDef[] = [
  ...HANDHELD_REGIONS.map((region) => ({
    id: region.id,
    label: region.label,
    kind: "color" as const,
    regionId: region.id as keyof HandheldScheme,
  })),
  { id: "phosphor", label: "Phosphor", kind: "phosphor" },
  { id: "scanlines", label: "Scanlines", kind: "scanlines" },
  { id: "marquee", label: "Marquee", kind: "marquee" },
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
  // Which slot of the premade ring is centred, and which parameter (if any) is
  // unfolded in the customize switch. `activeParam` null keeps every control
  // collapsed until the player chooses a part to change.
  const [carouselIndex, setCarouselIndex] = useState<number>(() => presetIndex(defaultPreset.id));
  const [activeParam, setActiveParam] = useState<string | null>(null);
  // The device screen rectangle (0..1 fractions) from the measured layout, used
  // to overlay the live interface preview inside the handheld's screen.
  const [screenRect, setScreenRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const backgroundUploadRef = useRef<HTMLInputElement>(null);
  // Where a touch began, so the carousel can turn a horizontal swipe into a
  // premade change on mobile (where the flanks are hidden).
  const touchStartX = useRef<number | null>(null);

  // What actually renders/saves, in priority order: a live animation, else an
  // uploaded chassis background, else hand-drawn art, else the static recoloured
  // skin (art === null).
  const activeArt = animationId ? animatedArt : background ? backgroundArt : drawnArt;

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

  // The premades flanking the centred handheld (one either side of the current
  // slot), shown smaller as a preview of what the arrows/swipe will load.
  const presetCount = HANDHELD_PRESETS.length;
  const leftPreset = HANDHELD_PRESETS[(carouselIndex - 1 + presetCount) % presetCount]!;
  const rightPreset = HANDHELD_PRESETS[(carouselIndex + 1) % presetCount]!;

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
    const view = animatedPresetView(animationId);
    if (!view) {
      setAnimatedArt(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      try {
        const rendered = renderAnimatedArt(template, scheme, view);
        if (!cancelled) setAnimatedArt(rendered);
      } catch {
        if (!cancelled) setAnimatedError(`Could not render the ${view.label} animation.`);
      }
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [template, scheme, animationId]);

  // Re-render the live preview. Custom pixel art (when present) wins over the
  // region-recoloured scheme, so the preview always shows what will be saved.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    if (activeArt) {
      const art = activeArt;
      const image = new Image();
      // Animated art is a horizontal sprite sheet: play it back in the preview so
      // the marquee looks alive; a single-frame image just draws once.
      if (art.frames && art.frames > 1) {
        let timer: number | undefined;
        image.onload = () => {
          canvas.width = art.w;
          canvas.height = art.h;
          const urls = sliceSheet(image, art.w, art.h, art.frames!);
          const frameImages = urls.map((url) => {
            const frame = new Image();
            frame.src = url;
            return frame;
          });
          let index = 0;
          const paint = () => {
            const frame = frameImages[index];
            if (frame) {
              context.clearRect(0, 0, canvas.width, canvas.height);
              context.drawImage(frame, 0, 0);
            }
            index = (index + 1) % frameImages.length;
          };
          paint();
          timer = window.setInterval(paint, art.durationMs ?? 120);
        };
        image.src = art.url;
        return () => {
          if (timer !== undefined) window.clearInterval(timer);
        };
      }
      image.onload = () => {
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0);
      };
      image.src = art.url;
      return;
    }

    if (!template) return;
    canvas.width = template.width;
    canvas.height = template.height;
    const rgba = renderHandheld(template, scheme);
    const image = context.createImageData(template.width, template.height);
    image.data.set(rgba);
    context.putImageData(image, 0, 0);
  }, [template, scheme, activeArt]);

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
    // An animation and a chassis background are mutually exclusive looks.
    if (id) clearBackground();
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

  const activeDef = CUSTOMIZE_PARAMS.find((param) => param.id === activeParam) ?? null;
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

        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className={`${styles.flank} ${styles.flankLeft}`}
          src={handheldAssetUrl(`/handheld/preview/${leftPreset.id}.png`)}
          alt={`${leftPreset.label} handheld`}
          onClick={() => turnCarousel(-1)}
          aria-hidden
        />

        <div className={styles.centerStage}>
          <div className={styles.stageDevice}>
            <canvas ref={canvasRef} className={styles.preview} />
            {/* The live interface preview sits in the handheld's actual screen
                window (positioned from the measured device layout). */}
            {screenRect && (
              <div
                className={styles.screenOverlay}
                style={{
                  left: `${screenRect.x * 100}%`,
                  top: `${screenRect.y * 100}%`,
                  width: `${screenRect.w * 100}%`,
                  height: `${screenRect.h * 100}%`,
                }}
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

        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className={`${styles.flank} ${styles.flankRight}`}
          src={handheldAssetUrl(`/handheld/preview/${rightPreset.id}.png`)}
          alt={`${rightPreset.label} handheld`}
          onClick={() => turnCarousel(1)}
          aria-hidden
        />

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

      {/* --- Customize: one parameter switch, one unfolding control --- */}
      <section className={styles.customize} aria-label="Customize">
        <div className={styles.screenModeRow} role="group" aria-label="Screen mode">
          <span className={styles.screenModeLabel}>Screen</span>
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

        <div className={styles.paramSwitch} role="tablist" aria-label="Part to customize">
          {CUSTOMIZE_PARAMS.map((param) => {
            const isActive = activeParam === param.id;
            return (
              <button
                key={param.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`${styles.paramChip} ${isActive ? styles.paramChipActive : ""}`}
                onClick={() => setActiveParam(isActive ? null : param.id)}
              >
                {param.kind === "color" && param.regionId && (
                  <span className={styles.paramDot} style={{ background: scheme[param.regionId] }} aria-hidden />
                )}
                {param.kind === "phosphor" && (
                  <span className={styles.paramDot} style={{ background: phosphorValue }} aria-hidden />
                )}
                {param.label}
              </button>
            );
          })}
        </div>

        {/* The control unfolds only once a part is picked; otherwise it stays
            collapsed with a hint, per the "collapsed unless changing" rule. */}
        <div className={styles.paramPanel}>
          {!activeDef && (
            <p className={styles.paramHint}>Pick a part above to change its colour or setting.</p>
          )}

          {activeDef?.kind === "color" && activeDef.regionId && (
            <div className={styles.colorControl}>
              <input
                type="color"
                className={styles.colorInputLarge}
                value={scheme[activeDef.regionId]}
                onChange={(event) => recolour(activeDef.regionId!, event.target.value)}
                aria-label={`${activeDef.label} colour`}
              />
              <div className={styles.colorMeta}>
                <span className={styles.colorName}>{activeDef.label}</span>
                <span className={styles.colorHex}>{scheme[activeDef.regionId]}</span>
              </div>
            </div>
          )}

          {activeDef?.kind === "phosphor" && (
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
              <div className={styles.colorControl}>
                <input
                  type="color"
                  className={styles.colorInputLarge}
                  value={phosphorValue}
                  onChange={(event) => setOsPhosphorColor(event.target.value)}
                  aria-label="Custom phosphor colour"
                />
                <div className={styles.colorMeta}>
                  <span className={styles.colorName}>Custom glow</span>
                  <span className={styles.colorHex}>{phosphorValue}</span>
                </div>
                {osPhosphorColor && (
                  <button type="button" className={styles.linkButton} onClick={() => setOsPhosphorColor(null)}>
                    Reset to preset
                  </button>
                )}
              </div>
              {osStyle !== "pipboy" && (
                <p className={styles.paramHint}>Phosphor applies to the Terminal screen — switch Screen to Terminal above.</p>
              )}
            </div>
          )}

          {activeDef?.kind === "scanlines" && (
            <label className={styles.toggleControl}>
              <input type="checkbox" checked={osScanlines} onChange={(event) => setOsScanlines(event.target.checked)} />
              <span>Scanline overlay on the terminal screen</span>
            </label>
          )}

          {activeDef?.kind === "marquee" && (
            <div className={styles.marqueeControl}>
              <div className={styles.presetGrid}>
                <button
                  type="button"
                  className={`${styles.presetCard} ${animationId === null ? styles.presetCardActive : ""}`}
                  onClick={() => chooseAnimation(null)}
                  aria-pressed={animationId === null}
                >
                  <span className={styles.noneThumb} aria-hidden>
                    —
                  </span>
                  <span className={styles.presetName}>None</span>
                </button>
                {ANIMATED_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={`${styles.presetCard} ${animationId === preset.id ? styles.presetCardActive : ""}`}
                    onClick={() => chooseAnimation(preset.id)}
                    aria-pressed={animationId === preset.id}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img className={styles.presetThumb} src={preset.previewUrl} alt={preset.label} />
                    <span className={styles.presetName}>{preset.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      <section className={styles.actions}>
        <button type="button" className={styles.primary} onClick={save} disabled={saving || !template}>
          {saving ? "Saving…" : "Use this handheld"}
        </button>
        <div className={styles.secondaryRow}>
          <button type="button" className={styles.secondary} onClick={() => setEditing(true)} disabled={!template}>
            Draw your own
          </button>
          <a className={styles.secondary} href={handheldAssetUrl("/handheld/template.aseprite")} download>
            Download .aseprite template
          </a>
          <button type="button" className={styles.secondary} onClick={() => uploadRef.current?.click()}>
            Upload edited .aseprite
          </button>
          <button type="button" className={styles.secondary} onClick={() => backgroundUploadRef.current?.click()}>
            Upload chassis background
          </button>
          {background && (
            <button type="button" className={styles.secondary} onClick={clearBackground}>
              Remove background
            </button>
          )}
        </div>
        <input ref={uploadRef} type="file" accept=".aseprite,.ase" onChange={importAseprite} hidden />
        <input ref={backgroundUploadRef} type="file" accept="image/*" onChange={uploadBackground} hidden />
        <p className={styles.hint}>
          Want to draw your own? Download the template, recolour it in Aseprite or any pixel-art tool, then upload it
          back here to apply your colours.
        </p>
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
