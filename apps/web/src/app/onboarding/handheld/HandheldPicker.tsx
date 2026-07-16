"use client";

/**
 * Handheld selection screen. A new player picks a premade skin or recolours each
 * region live, previewed on a canvas rendered by the pure `renderHandheld`
 * model. Choosing saves the scheme to the profile (and localStorage) and moves
 * on to `?next` (their profile by default). Detailed pixel edits happen in a
 * pixel tool via the downloadable `.aseprite` template.
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
import { TerminalPreview } from "./TerminalPreview";
import styles from "./handheld.module.css";

/** Where the anonymous/offline choice is remembered until an account exists. */
export const LOCAL_HANDHELD_KEY = "cartbox.handheld";

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
  // so recolouring recolours the animation too.
  const [animationId, setAnimationId] = useState<string | null>(null);
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
  const [osScanlines, setOsScanlines] = useState(true);
  // The device screen rectangle (0..1 fractions) from the measured layout, used
  // to overlay the live interface preview inside the handheld's screen.
  const [screenRect, setScreenRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const backgroundUploadRef = useRef<HTMLInputElement>(null);

  // What actually renders/saves, in priority order: a live animation, else an
  // uploaded chassis background, else hand-drawn art, else the static recoloured
  // skin (art === null).
  const activeArt = animationId ? animatedArt : background ? backgroundArt : drawnArt;

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
      // An animation re-renders live from the scheme, so restore the selection
      // rather than the baked sheet; otherwise restore any hand-drawn art.
      if (stored.animation) {
        const view = ANIMATED_PRESETS.find((preset) => preset.game === stored.animation);
        if (view) setAnimationId(view.id);
      } else if (stored.background) {
        // Resume the chassis background: keep the source for saving and decode it
        // back to pixels so recolouring re-composites it live.
        setBackgroundSource(stored.background);
        void decodeBackgroundSource(stored.background)
          .then(setBackground)
          .catch(() => {
            /* Corrupt source; the recoloured skin still shows. */
          });
      } else if (stored.art) {
        setDrawnArt(stored.art);
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

  // Choosing a premade or recolouring a region sets the chassis colours and
  // drops any hand-drawn art, but KEEPS the selected animation so it re-renders
  // in the new colours (that is the whole point of decoupling the two).
  const choosePreset = (preset: (typeof HANDHELD_PRESETS)[number]) => {
    setPresetId(preset.id);
    setScheme(preset.scheme);
    setDrawnArt(null);
    setDraft(null);
    clearHandheldDraft();
  };

  const recolour = (regionId: string, color: string) => {
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

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <h1 className={styles.title}>Choose your handheld</h1>
        <p className={styles.subtitle}>Pick a premade look or recolour your own. You can change it later.</p>
      </header>

      <div className={styles.layout}>
        <section className={styles.stage} aria-label="Handheld preview">
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
                <TerminalPreview fill style={osStyle} phosphor={osPhosphor} scanlines={osScanlines} />
              </div>
            )}
          </div>
          <span className={styles.stageLabel}>{stageLabel}</span>
        </section>

        <div className={styles.controls}>
          <section className={styles.section}>
            <div className={styles.sectionHead}>Premade</div>
            <div className={styles.presetGrid}>
              {HANDHELD_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`${styles.presetCard} ${presetId === preset.id ? styles.presetCardActive : ""}`}
                  onClick={() => choosePreset(preset)}
                  aria-pressed={presetId === preset.id}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className={styles.presetThumb} src={handheldAssetUrl(`/handheld/preview/${preset.id}.png`)} alt={preset.label} />
                  <span className={styles.presetName}>{preset.label}</span>
                </button>
              ))}
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHead}>Marquee animation</div>
            <p className={styles.hint}>
              Play an arcade scene on the chassis — it renders in your handheld&apos;s colours and rides on whichever
              chassis you pick above.
            </p>
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
            {animatedError && <p className={styles.error}>{animatedError}</p>}
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHead}>Recolour</div>
            {HANDHELD_REGIONS.map((region) => (
              <div key={region.id} className={styles.swatchRow}>
                <span className={styles.swatchLabel}>{region.label}</span>
                <span className={styles.swatchControl}>
                  <span className={styles.swatchHex}>{scheme[region.id]}</span>
                  <input
                    type="color"
                    className={styles.colorInput}
                    value={scheme[region.id]}
                    onChange={(event) => recolour(region.id, event.target.value)}
                    aria-label={`${region.label} colour`}
                  />
                </span>
              </div>
            ))}
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHead}>Console interface</div>
            <p className={styles.hint}>Previewed live inside the handheld screen above.</p>
            <div className={styles.uiRow}>
              <div className={styles.uiControls}>
                <div className={styles.segRow} role="group" aria-label="Interface style">
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
                <p className={styles.uiBlurb}>
                  {OS_STYLES.find((option) => option.id === osStyle)?.blurb}
                </p>

                {osStyle === "pipboy" && (
                  <>
                    <div className={styles.tuneRow}>
                      <span className={styles.tuneLabel}>Phosphor</span>
                      <div className={styles.segRow} role="group" aria-label="Phosphor colour">
                        {OS_PHOSPHORS.map((option) => (
                          <button
                            key={option.id}
                            type="button"
                            className={`${styles.seg} ${osPhosphor === option.id ? styles.segActive : ""}`}
                            onClick={() => setOsPhosphor(option.id)}
                            aria-pressed={osPhosphor === option.id}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <label className={styles.tuneRow}>
                      <span className={styles.tuneLabel}>Scanlines</span>
                      <input
                        type="checkbox"
                        checked={osScanlines}
                        onChange={(event) => setOsScanlines(event.target.checked)}
                      />
                    </label>
                  </>
                )}
              </div>
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
            <input
              ref={uploadRef}
              type="file"
              accept=".aseprite,.ase"
              onChange={importAseprite}
              hidden
            />
            <input
              ref={backgroundUploadRef}
              type="file"
              accept="image/*"
              onChange={uploadBackground}
              hidden
            />
            <p className={styles.hint}>
              Want to draw your own? Download the template, recolour it in Aseprite or any pixel-art tool, then upload
              it back here to apply your colours.
            </p>
            {uploadNote && <p className={styles.hint}>{uploadNote}</p>}
            {error && <p className={styles.error}>{error}</p>}
          </section>
        </div>
      </div>

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
