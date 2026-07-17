"use client";

/**
 * The backdrop prop manager: edit the onboarding scene's 3D objects directly.
 * Every change is saved to a local working copy that overrides the published set
 * on this browser, so the onboarding backdrop previews your edits live. To make
 * them global (Global-by-deploy), download props.json and commit it to
 * public/backdrop/props.json.
 *
 * Pixel-editing a prop hands it to the real sprite editor (via a pending edit),
 * where you draw with the full tools and "Publish as backdrop prop" back into
 * this set. Here you arrange placement, size, depth, and bob/spin motion, and
 * add/duplicate/delete props.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  DEFAULT_BACKDROP_PROP_SET,
  type BackdropPropSet,
  type MotionPatch,
  type StoredBackdropProp,
} from "@/lib/backdropProps";
import {
  clearWorkingSet,
  exportPropSet,
  importPropSetJson,
  loadPublishedSet,
  loadWorkingSet,
  saveWorkingSet,
  savePendingPropEdit,
} from "@/lib/backdropPropsStore";
import { PropPreview } from "./PropPreview";
import styles from "./backdrop.module.css";

/** A unique id for a newly added prop. */
function newId(): string {
  const uuid = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}`;
  return `prop-${uuid}`;
}

export function BackdropManager() {
  const router = useRouter();
  const [set, setSet] = useState<BackdropPropSet>(DEFAULT_BACKDROP_PROP_SET);
  const [loaded, setLoaded] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Load the working copy if one exists, otherwise the published global set.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const working = loadWorkingSet();
      const initial = working ?? (await loadPublishedSet());
      if (!cancelled) {
        setSet(initial);
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Apply a new set and persist it as the working copy. */
  const commit = (next: BackdropPropSet) => {
    setSet(next);
    saveWorkingSet(next);
  };

  const updateProp = (id: string, patch: Partial<StoredBackdropProp>) => {
    commit({ ...set, props: set.props.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  };

  const updateMotion = (id: string, patch: MotionPatch) => {
    commit({
      ...set,
      props: set.props.map((p) => (p.id === id ? { ...p, motion: { ...p.motion, ...patch } } : p)),
    });
  };

  const deleteProp = (id: string) => {
    commit({ ...set, props: set.props.filter((p) => p.id !== id) });
  };

  const duplicateProp = (prop: StoredBackdropProp) => {
    const copy: StoredBackdropProp = {
      ...prop,
      id: newId(),
      name: `${prop.name} copy`,
      fx: Math.min(1, prop.fx + 0.04),
      fy: Math.min(1, prop.fy + 0.04),
    };
    commit({ ...set, props: [...set.props, copy] });
  };

  const editPixels = (prop: StoredBackdropProp) => {
    if (!prop.art) return; // voxel props have no pixels to edit (button is hidden for them)
    savePendingPropEdit({
      targetId: prop.id,
      name: prop.name,
      width: prop.art.width,
      height: prop.art.height,
      albedo: prop.art.albedo,
    });
    router.push("/edit/new");
  };

  const downloadJson = () => {
    const blob = new Blob([exportPropSet(set)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "props.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const uploadJson = async (file: File) => {
    const parsed = importPropSetJson(await file.text());
    if (parsed) commit(parsed);
    else window.alert("That file is not a valid backdrop prop set.");
  };

  const revertToPublished = async () => {
    clearWorkingSet();
    setSet(await loadPublishedSet());
  };

  const resetToDefaults = () => commit(DEFAULT_BACKDROP_PROP_SET);

  const addProp = () => {
    if (set.props.length > 0) duplicateProp(set.props[0]!);
  };

  if (!loaded) {
    return (
      <main className={styles.page}>
        <p className={styles.subtitle}>Loading backdrop props…</p>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <h1 className={styles.title}>Backdrop props</h1>
        <p className={styles.subtitle}>
          Edit the 3D objects on the onboarding backdrop. Changes save to this browser and preview live on the
          &ldquo;Choose your handheld&rdquo; screen.
        </p>
      </header>

      <div className={styles.note}>
        To publish globally so every visitor sees them, <strong>Download props.json</strong> and commit it to{" "}
        <code>apps/web/public/backdrop/props.json</code>, then deploy. <strong>Revert to published</strong> drops your
        local edits. Use <strong>Edit pixels</strong> on a prop to redraw it in the full sprite editor.
      </div>

      <div className={styles.toolbar}>
        <button type="button" className={styles.btn} onClick={addProp}>
          + Add prop
        </button>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={downloadJson}>
          Download props.json
        </button>
        <button type="button" className={styles.btn} onClick={() => fileInput.current?.click()}>
          Upload props.json
        </button>
        <button type="button" className={styles.btn} onClick={() => void revertToPublished()}>
          Revert to published
        </button>
        <button type="button" className={styles.btn} onClick={resetToDefaults}>
          Reset to defaults
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void uploadJson(file);
            event.target.value = "";
          }}
        />
      </div>

      <div className={styles.grid}>
        {set.props.map((prop) => (
          <div key={prop.id} className={styles.card}>
            <div className={styles.previewWrap}>
              <PropPreview prop={prop} />
            </div>
            <input
              className={styles.nameInput}
              value={prop.name}
              onChange={(event) => updateProp(prop.id, { name: event.target.value })}
              aria-label="Prop name"
            />

            <Slider label="X" min={0} max={1} step={0.01} value={prop.fx} format={(v) => v.toFixed(2)}
              onChange={(v) => updateProp(prop.id, { fx: v })} />
            <Slider label="Y" min={0} max={1} step={0.01} value={prop.fy} format={(v) => v.toFixed(2)}
              onChange={(v) => updateProp(prop.id, { fy: v })} />
            <Slider label="Size" min={1} max={6} step={1} value={prop.cell} format={(v) => String(v)}
              onChange={(v) => updateProp(prop.id, { cell: v })} />
            {/* Depth only extrudes 2D sprite props; a voxel model already has 3D shape. */}
            {!prop.voxel && (
              <Slider label="Depth" min={1} max={16} step={1} value={prop.depth} format={(v) => String(v)}
                onChange={(v) => updateProp(prop.id, { depth: v })} />
            )}
            <Slider label="Bob height" min={0} max={12} step={0.5} value={prop.motion.bobAmplitude} format={(v) => v.toFixed(1)}
              onChange={(v) => updateMotion(prop.id, { bobAmplitude: v })} />
            <Slider label="Bob speed" min={1} max={10} step={0.5} value={prop.motion.bobPeriod} format={(v) => `${v.toFixed(1)}s`}
              onChange={(v) => updateMotion(prop.id, { bobPeriod: v })} />
            <Slider label="Spin every" min={3} max={40} step={1} value={prop.motion.spinCycle} format={(v) => `${v}s`}
              onChange={(v) => updateMotion(prop.id, { spinCycle: v, spinDuration: Math.min(prop.motion.spinDuration, v) })} />
            <Slider label="Spin time" min={1} max={8} step={0.5} value={prop.motion.spinDuration} format={(v) => `${v.toFixed(1)}s`}
              onChange={(v) => updateMotion(prop.id, { spinDuration: Math.min(v, prop.motion.spinCycle) })} />

            <div className={styles.cardActions}>
              {/* Pixel editing is for 2D sprite props; voxel props are sculpted in the editor's Voxel tab. */}
              {!prop.voxel && (
                <button type="button" className={styles.btn} onClick={() => editPixels(prop)}>
                  Edit pixels
                </button>
              )}
              <button type="button" className={styles.btn} onClick={() => duplicateProp(prop)}>
                Duplicate
              </button>
              <button type="button" className={`${styles.btn} ${styles.danger}`} onClick={() => deleteProp(prop.id)}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

interface SliderProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}

function Slider({ label, min, max, step, value, format, onChange }: SliderProps) {
  return (
    <label className={styles.control}>
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={label}
      />
      <span className={styles.controlValue}>{format(value)}</span>
    </label>
  );
}
