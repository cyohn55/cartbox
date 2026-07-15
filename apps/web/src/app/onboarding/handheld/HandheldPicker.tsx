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
  handheldPreset,
  parseAsepriteLayers,
  extractSchemeFromLayers,
  DEFAULT_HANDHELD_PRESET_ID,
  type HandheldScheme,
  type HandheldTemplate,
} from "@cartbox/editor";

import { authHeaders } from "@/lib/supabase-browser";
import { isStaticExport } from "@/lib/staticSite";
import { CUSTOM_PRESET_ID, type StoredHandheld } from "@/lib/handheld";
import { loadHandheldTemplate } from "@/lib/handheldTemplate";
import { loadConsoleSettings, saveConsoleSettings } from "@/app/console/consoleSettings";
import { withBasePath } from "@/lib/staticSite";
import styles from "./handheld.module.css";

/** Where the anonymous/offline choice is remembered until an account exists. */
export const LOCAL_HANDHELD_KEY = "cartbox.handheld";

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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  // Load the shared chrome + region mask once.
  useEffect(() => {
    let alive = true;
    loadHandheldTemplate()
      .then((loaded) => alive && setTemplate(loaded))
      .catch(() => alive && setError("Could not load the handheld artwork."));
    return () => {
      alive = false;
    };
  }, []);

  // Re-render the live preview whenever the scheme (or template) changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !template) return;
    canvas.width = template.width;
    canvas.height = template.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    const rgba = renderHandheld(template, scheme);
    const image = context.createImageData(template.width, template.height);
    image.data.set(rgba);
    context.putImageData(image, 0, 0);
  }, [template, scheme]);

  const choosePreset = (preset: (typeof HANDHELD_PRESETS)[number]) => {
    setPresetId(preset.id);
    setScheme(preset.scheme);
  };

  const recolour = (regionId: string, color: string) => {
    setScheme((current) => ({ ...current, [regionId]: color }));
    setPresetId(CUSTOM_PRESET_ID);
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
      setUploadNote(`Applied colours from ${file.name}.`);
    } catch (importError) {
      setUploadNote(importError instanceof Error ? importError.message : "Could not read that .aseprite file.");
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const handheld: StoredHandheld = { presetId, scheme };
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
            {presetId === CUSTOM_PRESET_ID ? "Custom" : handheldPreset(presetId).label}
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
                  <img className={styles.presetThumb} src={withBasePath(`/handheld/preview/${preset.id}.png`)} alt={preset.label} />
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
              <a className={styles.secondary} href={withBasePath("/handheld/template.aseprite")} download>
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
    </main>
  );
}
