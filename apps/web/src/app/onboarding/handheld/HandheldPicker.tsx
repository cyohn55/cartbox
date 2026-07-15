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
  type PaintDoc,
} from "@cartbox/editor";

import { authHeaders } from "@/lib/supabase-browser";
import { isStaticExport } from "@/lib/staticSite";
import { CUSTOM_PRESET_ID, CUSTOM_ART_PRESET_ID, type HandheldArt, type StoredHandheld } from "@/lib/handheld";
import { loadHandheldTemplate } from "@/lib/handheldTemplate";
import { saveHandheldDraft, loadHandheldDraft, clearHandheldDraft } from "@/lib/handheldDraft";
import { loadConsoleSettings, saveConsoleSettings } from "@/app/console/consoleSettings";
import { handheldAssetUrl } from "@/lib/handheldAssets";
import { HandheldSkinEditor } from "./HandheldSkinEditor";
import styles from "./handheld.module.css";

/** Where the anonymous/offline choice is remembered until an account exists. */
export const LOCAL_HANDHELD_KEY = "cartbox.handheld";

/** Flatten a paint document to a PNG data URL for the preview (browser only). */
function docToDataUrl(doc: PaintDoc): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = doc.width;
  canvas.height = doc.height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const image = context.createImageData(doc.width, doc.height);
  image.data.set(compositeDoc(doc));
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
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
  // The editor's working document, kept so re-opening resumes the same layers
  // instead of restarting from the scheme render. Dropped when the design is
  // changed another way (preset, recolour, upload).
  const [draft, setDraft] = useState<PaintDoc | null>(null);
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
        const url = docToDataUrl(savedDraft);
        if (url) {
          setArt({ url, w: savedDraft.width, h: savedDraft.height });
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
    clearHandheldDraft();
  };

  const recolour = (regionId: string, color: string) => {
    setScheme((current) => ({ ...current, [regionId]: color }));
    setPresetId(CUSTOM_PRESET_ID);
    setArt(null);
    setDraft(null);
    clearHandheldDraft();
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
            {art
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
          initialDoc={draft}
          onCancel={() => setEditing(false)}
          onApply={(drawn, workingDoc) => {
            setArt(drawn);
            setDraft(workingDoc); // resume from these layers next time
            void saveHandheldDraft(workingDoc); // survive a reload too
            setPresetId(CUSTOM_ART_PRESET_ID);
            setEditing(false);
          }}
        />
      )}
    </main>
  );
}
