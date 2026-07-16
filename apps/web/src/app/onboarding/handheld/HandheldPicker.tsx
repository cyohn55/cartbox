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
} from "@cartbox/editor";

import { authHeaders } from "@/lib/supabase-browser";
import { isStaticExport } from "@/lib/staticSite";
import { CUSTOM_PRESET_ID, CUSTOM_ART_PRESET_ID, type HandheldArt, type StoredHandheld } from "@/lib/handheld";
import { loadHandheldTemplate } from "@/lib/handheldTemplate";
import { saveHandheldDraft, loadHandheldDraft, clearHandheldDraft, type HandheldDraft } from "@/lib/handheldDraft";
import { assembleSheetCanvas, sliceSheet } from "@/lib/handheldSheet";
import { ANIMATED_PRESETS, loadAnimatedArt, type AnimatedPresetView } from "@/lib/handheldAnimated";
import { loadConsoleSettings, saveConsoleSettings } from "@/app/console/consoleSettings";
import { handheldAssetUrl } from "@/lib/handheldAssets";
import { HandheldSkinEditor } from "./HandheldSkinEditor";
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
  const [art, setArt] = useState<HandheldArt | null>(null);
  // Which animated premade is selected, for the card highlight + stage label
  // (the saved skin records it as custom art, so this is UI state only).
  const [animatedId, setAnimatedId] = useState<string | null>(null);
  const [animatedError, setAnimatedError] = useState<string | null>(null);
  // The editor's working draft (animation frames), kept so re-opening resumes
  // the same work instead of restarting from the scheme render. Dropped when the
  // design is changed another way (preset, recolour, upload).
  const [draft, setDraft] = useState<HandheldDraft | null>(null);
  const [editing, setEditing] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

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
          setArt(restoredArt);
          setPresetId(CUSTOM_ART_PRESET_ID);
        }
      })
      .catch(() => alive && setError("Could not load the handheld artwork."));
    return () => {
      alive = false;
    };
  }, []);

  // Re-render the live preview. Custom pixel art (when present) wins over the
  // region-recoloured scheme, so the preview always shows what will be saved.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    if (art) {
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
  }, [template, scheme, art]);

  // Choosing a premade or recolouring a region drops any custom art — the two
  // ways of designing the handheld are mutually exclusive.
  const choosePreset = (preset: (typeof HANDHELD_PRESETS)[number]) => {
    setPresetId(preset.id);
    setScheme(preset.scheme);
    setArt(null);
    setDraft(null);
    setAnimatedId(null);
    clearHandheldDraft();
  };

  const recolour = (regionId: string, color: string) => {
    setScheme((current) => ({ ...current, [regionId]: color }));
    setPresetId(CUSTOM_PRESET_ID);
    setArt(null);
    setDraft(null);
    setAnimatedId(null);
    clearHandheldDraft();
  };

  // Choosing an animated premade loads its baked sprite sheet as playable art.
  // It is stored as custom art (a sheet the console animates), so `animatedId`
  // is kept only for the card highlight and stage label in this screen.
  const chooseAnimated = async (preset: AnimatedPresetView) => {
    setAnimatedError(null);
    try {
      const loaded = await loadAnimatedArt(preset);
      setArt(loaded);
      setPresetId(CUSTOM_ART_PRESET_ID);
      setAnimatedId(preset.id);
      setDraft(null);
      clearHandheldDraft();
    } catch {
      setAnimatedError(`Could not load the ${preset.label} animation.`);
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
      setArt(null);
      setDraft(null);
      setAnimatedId(null);
      clearHandheldDraft();
      setUploadNote(`Applied colours from ${file.name}.`);
    } catch (importError) {
      setUploadNote(importError instanceof Error ? importError.message : "Could not read that .aseprite file.");
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const handheld: StoredHandheld = art ? { presetId, scheme, art } : { presetId, scheme };
    try {
      window.localStorage.setItem(LOCAL_HANDHELD_KEY, JSON.stringify(handheld));
      // Make the live console default to the handheld they just designed.
      saveConsoleSettings({ ...loadConsoleSettings(), theme: "handheld" });
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
      router.push(next);
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
          <canvas ref={canvasRef} className={styles.preview} />
          <span className={styles.stageLabel}>
            {animatedId
              ? ANIMATED_PRESETS.find((preset) => preset.id === animatedId)?.label ?? "Animated"
              : art
                ? "Custom art"
                : presetId === CUSTOM_PRESET_ID
                  ? "Custom"
                  : handheldPreset(presetId).label}
          </span>
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
            <div className={styles.sectionHead}>Animated</div>
            <div className={styles.presetGrid}>
              {ANIMATED_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`${styles.presetCard} ${animatedId === preset.id ? styles.presetCardActive : ""}`}
                  onClick={() => chooseAnimated(preset)}
                  aria-pressed={animatedId === preset.id}
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
            </div>
            <input
              ref={uploadRef}
              type="file"
              accept=".aseprite,.ase"
              onChange={importAseprite}
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
            setArt(drawn);
            setDraft(workingDraft); // resume from these frames next time
            void saveHandheldDraft(workingDraft); // survive a reload too
            setPresetId(CUSTOM_ART_PRESET_ID);
            setAnimatedId(null);
            setEditing(false);
          }}
        />
      )}
    </main>
  );
}
