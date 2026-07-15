"use client";

/**
 * Full-screen pixel editor for the handheld skin — the in-app "draw your own"
 * experience (like Aseprite) that goes beyond region recolouring. It seeds a
 * layered RGBA document from the current skin render, hands the painting surface
 * to SkinPaintCanvas, and wraps it with a toolbar (tools, brush size, colour +
 * recents, undo/redo, zoom) and a layers panel. On "Done" it flattens the
 * document to a PNG, uploads it to object storage (falling back to an inline
 * data URL for guests/static), and reports the resulting art to the caller.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import {
  addLayer,
  removeLayer,
  reorderLayer,
  setActiveLayer,
  setLayerProps,
  cloneDoc,
  compositeDoc,
  docFromRgba,
  docFromLayers,
  renderHandheld,
  parseAsepriteLayers,
  blitRect,
  encodeAsepriteRgba,
  HANDHELD_REGIONS,
  MAX_PAINT_LAYERS,
  type PaintDoc,
  type HandheldRegionId,
  type HandheldScheme,
  type HandheldTemplate,
} from "@cartbox/editor";

import { authHeaders } from "@/lib/supabase-browser";
import { isStaticExport } from "@/lib/staticSite";
import type { HandheldArt } from "@/lib/handheld";

import { SkinPaintCanvas, type SkinTool, type StrokeSnapshot } from "./SkinPaintCanvas";
import { SkinPalette } from "./SkinPalette";
import styles from "./skinEditor.module.css";

/** Undo/redo entry: a rectangular pixel edit, or a whole-document structural change. */
type HistoryEntry =
  | { kind: "pixels"; snapshot: StrokeSnapshot }
  | { kind: "doc"; before: PaintDoc; after: PaintDoc };

/** Cap on undo depth — enough to feel unlimited without unbounded memory. */
const MAX_HISTORY = 24;

interface ToolButton {
  id: SkinTool;
  label: string;
  glyph: string;
}

const TOOLBAR: ToolButton[] = [
  { id: "pencil", label: "Pencil", glyph: "✎" },
  { id: "eraser", label: "Eraser", glyph: "⌫" },
  { id: "fill", label: "Fill", glyph: "▦" },
  { id: "line", label: "Line", glyph: "╱" },
  { id: "rect", label: "Rectangle", glyph: "▭" },
  { id: "ellipse", label: "Ellipse", glyph: "◯" },
  { id: "eyedropper", label: "Eyedropper", glyph: "⦿" },
  { id: "pan", label: "Pan", glyph: "✋" },
];

const WEIGHTED: ReadonlySet<SkinTool> = new Set<SkinTool>(["pencil", "eraser", "line", "rect", "ellipse"]);

interface HandheldSkinEditorProps {
  template: HandheldTemplate;
  /** The scheme the drawing starts from (rendered as the base bitmap). */
  scheme: HandheldScheme;
  /**
   * A working document to resume from — the layers left off in a previous visit
   * to the editor this session. When absent, the drawing starts from the scheme
   * render. Cloned on seed so the caller's copy is never mutated.
   */
  initialDoc?: PaintDoc | null;
  onCancel: () => void;
  /** Report the flattened art plus the working document to resume from next time. */
  onApply: (art: HandheldArt, doc: PaintDoc) => void;
}

export function HandheldSkinEditor({ template, scheme, initialDoc, onCancel, onApply }: HandheldSkinEditorProps) {
  const [doc, setDoc] = useState<PaintDoc>(() =>
    initialDoc ? cloneDoc(initialDoc) : docFromRgba(renderHandheld(template, scheme), template.width, template.height, "Skin"),
  );
  const [tool, setTool] = useState<SkinTool>("pencil");
  const [color, setColor] = useState<string>("#ffffff");
  const [recentColors, setRecentColors] = useState<string[]>([]);
  const [weight, setWeight] = useState(1);
  const [tolerance, setTolerance] = useState(0);
  const [mirrorX, setMirrorX] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  // "all" paints anywhere; a region id confines edits to that part of the body.
  const [clipRegion, setClipRegion] = useState<HandheldRegionId | "all">("all");
  const [structureVersion, setStructureVersion] = useState(0);
  const [repaintVersion, setRepaintVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const importInputRef = useRef<HTMLInputElement>(null);
  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  const [historyTick, setHistoryTick] = useState(0); // re-render undo/redo buttons

  const pushHistory = useCallback((entry: HistoryEntry) => {
    undoStack.current.push(entry);
    if (undoStack.current.length > MAX_HISTORY) undoStack.current.shift();
    redoStack.current = [];
    setHistoryTick((tick) => tick + 1);
  }, []);

  // A completed brush/shape/fill stroke: record it for undo.
  const handleStroke = useCallback((snapshot: StrokeSnapshot) => pushHistory({ kind: "pixels", snapshot }), [pushHistory]);

  /** Track a colour in the recents strip (most-recent first, unique, capped). */
  const rememberColor = useCallback((hex: string) => {
    setRecentColors((current) => [hex, ...current.filter((entry) => entry !== hex)].slice(0, 12));
  }, []);

  const pickColor = useCallback((hex: string) => {
    setColor(hex);
    rememberColor(hex);
  }, [rememberColor]);

  /** Apply a structural change and record the before/after for undo. */
  const structuralEdit = useCallback((make: (doc: PaintDoc) => PaintDoc) => {
    setDoc((current) => {
      const next = make(current);
      if (next === current) return current;
      pushHistory({ kind: "doc", before: cloneDoc(current), after: cloneDoc(next) });
      setStructureVersion((version) => version + 1);
      return next;
    });
  }, [pushHistory]);

  /** Cheap structural change (visibility/opacity/active/rename): no undo entry. */
  const liveEdit = useCallback((make: (doc: PaintDoc) => PaintDoc) => {
    setDoc((current) => {
      const next = make(current);
      if (next !== current) setStructureVersion((version) => version + 1);
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    const entry = undoStack.current.pop();
    if (!entry) return;
    redoStack.current.push(entry);
    if (entry.kind === "pixels") {
      setDoc((current) => {
        const layer = current.layers.find((candidate) => candidate.id === entry.snapshot.layerId);
        if (layer) blitRect(layer, current.width, entry.snapshot.rect, entry.snapshot.before);
        return current;
      });
      setRepaintVersion((version) => version + 1);
    } else {
      setDoc(cloneDoc(entry.before));
      setStructureVersion((version) => version + 1);
    }
    setHistoryTick((tick) => tick + 1);
  }, []);

  const redo = useCallback(() => {
    const entry = redoStack.current.pop();
    if (!entry) return;
    undoStack.current.push(entry);
    if (entry.kind === "pixels") {
      setDoc((current) => {
        const layer = current.layers.find((candidate) => candidate.id === entry.snapshot.layerId);
        if (layer) blitRect(layer, current.width, entry.snapshot.rect, entry.snapshot.after);
        return current;
      });
      setRepaintVersion((version) => version + 1);
    } else {
      setDoc(cloneDoc(entry.after));
      setStructureVersion((version) => version + 1);
    }
    setHistoryTick((tick) => tick + 1);
  }, []);

  // Keyboard: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl+Y redo.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  /** Flatten the document to a PNG (blob for upload, data URL as fallback). */
  const flattenToPng = async (): Promise<{ blob: Blob | null; dataUrl: string }> => {
    const rgba = compositeDoc(doc);
    const canvas = document.createElement("canvas");
    canvas.width = doc.width;
    canvas.height = doc.height;
    const context = canvas.getContext("2d");
    if (!context) return { blob: null, dataUrl: "" };
    const image = context.createImageData(doc.width, doc.height);
    image.data.set(rgba);
    context.putImageData(image, 0, 0);
    const dataUrl = canvas.toDataURL("image/png");
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return { blob, dataUrl };
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const { blob, dataUrl } = await flattenToPng();
      let art: HandheldArt = { url: dataUrl, w: doc.width, h: doc.height };
      // Upload to object storage when a backend + auth are available; on any
      // failure keep the inline data URL so the drawing is never lost.
      if (!isStaticExport && blob) {
        try {
          const response = await fetch("/api/console/me/handheld/art", {
            method: "POST",
            headers: await authHeaders({ "Content-Type": "image/png" }),
            body: blob,
          });
          if (response.ok) {
            const body = (await response.json()) as { url: string; w: number; h: number };
            art = { url: body.url, w: body.w, h: body.h };
          }
        } catch {
          // Fall back to the data URL already in `art`.
        }
      }
      onApply(art, doc);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save your artwork.");
      setSaving(false);
    }
  };

  /** Load a .aseprite's image layers as the current document (dims must match). */
  const importAseprite = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);
    try {
      const parsed = await parseAsepriteLayers(new Uint8Array(await file.arrayBuffer()));
      if (parsed.width !== doc.width || parsed.height !== doc.height) {
        setError(`That file is ${parsed.width}×${parsed.height}; this handheld is ${doc.width}×${doc.height}.`);
        return;
      }
      const imageLayers = parsed.layers.filter((layer) => layer.type === 0 && layer.pixels);
      if (imageLayers.length === 0) {
        setError("No image layers found in that file.");
        return;
      }
      const next = docFromLayers(
        imageLayers.map((layer) => ({ name: layer.name, visible: layer.visible, opacity: layer.opacity / 255, pixels: layer.pixels! })),
        doc.width,
        doc.height,
      );
      pushHistory({ kind: "doc", before: cloneDoc(doc), after: cloneDoc(next) });
      setDoc(next);
      setStructureVersion((version) => version + 1);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Could not read that .aseprite file.");
    }
  };

  /** Download the layered drawing as an RGBA .aseprite for external editing. */
  const exportAseprite = async () => {
    setError(null);
    try {
      const layers = doc.layers.map((layer) => ({
        name: layer.name,
        visible: layer.visible,
        opacity: Math.round(layer.opacity * 255),
        pixels: layer.pixels,
      }));
      const bytes = await encodeAsepriteRgba(layers, doc.width, doc.height);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "handheld.aseprite";
      link.click();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Could not export the .aseprite file.");
    }
  };

  // An offscreen of the original chrome, drawn once, for the onion-skin overlay.
  const guideCanvas = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = template.width;
    canvas.height = template.height;
    const context = canvas.getContext("2d");
    if (context) {
      const image = context.createImageData(template.width, template.height);
      image.data.set(template.base);
      context.putImageData(image, 0, 0);
    }
    return canvas;
  }, [template]);

  // Confine painting to one region by testing the template's per-pixel region
  // map; region ids in the map are 1-based in HANDHELD_REGIONS order.
  const clip = useMemo(() => {
    if (clipRegion === "all") return null;
    const regionValue = HANDHELD_REGIONS.findIndex((region) => region.id === clipRegion) + 1;
    if (regionValue <= 0) return null;
    const { regionMask, width } = template;
    return (x: number, y: number) => regionMask[y * width + x] === regionValue;
  }, [clipRegion, template]);

  const layersTopFirst = [...doc.layers].reverse(); // panel shows top layer first

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Handheld artwork editor">
      <div className={styles.editor}>
        <header className={styles.topbar}>
          <span className={styles.title}>Draw your handheld</span>
          <div className={styles.topActions}>
            <button type="button" className={styles.ghost} onClick={undo} disabled={undoStack.current.length === 0} data-history={historyTick}>
              ↶ Undo
            </button>
            <button type="button" className={styles.ghost} onClick={redo} disabled={redoStack.current.length === 0}>
              ↷ Redo
            </button>
            <button type="button" className={styles.ghost} onClick={() => importInputRef.current?.click()} disabled={saving} title="Load a .aseprite file's layers">
              Import
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept=".aseprite,.ase"
              onChange={importAseprite}
              hidden
            />
            <button type="button" className={styles.ghost} onClick={exportAseprite} disabled={saving} title="Download as an .aseprite file">
              Export
            </button>
            <button type="button" className={styles.ghost} onClick={onCancel} disabled={saving}>
              Cancel
            </button>
            <button type="button" className={styles.primary} onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Done"}
            </button>
          </div>
        </header>

        <div className={styles.body}>
          <aside className={styles.tools} aria-label="Tools">
            <div className={styles.toolGrid}>
              {TOOLBAR.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`${styles.tool} ${tool === entry.id ? styles.toolActive : ""}`}
                  onClick={() => setTool(entry.id)}
                  aria-pressed={tool === entry.id}
                  title={entry.label}
                >
                  <span aria-hidden>{entry.glyph}</span>
                </button>
              ))}
            </div>

            <label className={styles.field}>
              <span>Colour</span>
              <input type="color" value={color} onChange={(event) => pickColor(event.target.value)} aria-label="Paint colour" />
            </label>

            <SkinPalette scheme={scheme} activeColor={color} onPick={pickColor} />

            {recentColors.length > 0 && (
              <div className={styles.recents} aria-label="Recent colours">
                {recentColors.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    className={styles.swatch}
                    style={{ background: hex }}
                    onClick={() => setColor(hex)}
                    aria-label={`Use ${hex}`}
                  />
                ))}
              </div>
            )}

            {WEIGHTED.has(tool) && (
              <label className={styles.field}>
                <span>Brush {weight}px</span>
                <input type="range" min={1} max={16} value={weight} onChange={(event) => setWeight(Number(event.target.value))} />
              </label>
            )}

            {tool === "fill" && (
              <label className={styles.field}>
                <span>Tolerance {Math.round(tolerance * 100)}%</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(tolerance * 100)}
                  onChange={(event) => setTolerance(Number(event.target.value) / 100)}
                />
              </label>
            )}

            <button
              type="button"
              className={`${styles.toggle} ${mirrorX ? styles.toggleOn : ""}`}
              onClick={() => setMirrorX((on) => !on)}
              aria-pressed={mirrorX}
              title="Mirror edits across the vertical centre line"
            >
              <span aria-hidden>⇋</span> Symmetry
            </button>

            <button
              type="button"
              className={`${styles.toggle} ${showGuide ? styles.toggleOn : ""}`}
              onClick={() => setShowGuide((on) => !on)}
              aria-pressed={showGuide}
              title="Show a faint overlay of the original handheld for alignment"
            >
              <span aria-hidden>◫</span> Guide
            </button>

            <label className={styles.field}>
              <span>Paint region</span>
              <select
                className={styles.select}
                value={clipRegion}
                onChange={(event) => setClipRegion(event.target.value as HandheldRegionId | "all")}
              >
                <option value="all">Whole handheld</option>
                {HANDHELD_REGIONS.map((region) => (
                  <option key={region.id} value={region.id}>
                    {region.label}
                  </option>
                ))}
              </select>
            </label>
          </aside>

          <SkinPaintCanvas
            doc={doc}
            tool={tool}
            color={color}
            weight={weight}
            tolerance={tolerance}
            mirrorX={mirrorX}
            clip={clip}
            guide={showGuide ? guideCanvas : null}
            repaintVersion={repaintVersion}
            structureVersion={structureVersion}
            onStroke={handleStroke}
            onPickColor={pickColor}
          />

          <aside className={styles.layers} aria-label="Layers">
            <div className={styles.layersHead}>
              <span>Layers</span>
              <button
                type="button"
                className={styles.ghost}
                onClick={() => structuralEdit((current) => addLayer(current))}
                disabled={doc.layers.length >= MAX_PAINT_LAYERS}
                title="Add layer"
              >
                ＋
              </button>
            </div>
            <ul className={styles.layerList}>
              {layersTopFirst.map((layer) => {
                const index = doc.layers.indexOf(layer);
                return (
                  <li
                    key={layer.id}
                    className={`${styles.layerRow} ${layer.id === doc.activeId ? styles.layerActive : ""}`}
                  >
                    <button
                      type="button"
                      className={styles.eye}
                      onClick={() => liveEdit((current) => setLayerProps(current, layer.id, { visible: !layer.visible }))}
                      aria-label={layer.visible ? "Hide layer" : "Show layer"}
                      aria-pressed={layer.visible}
                    >
                      {layer.visible ? "👁" : "—"}
                    </button>
                    <button type="button" className={styles.layerName} onClick={() => liveEdit((current) => setActiveLayer(current, layer.id))}>
                      {layer.name}
                    </button>
                    <div className={styles.layerCtl}>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={Math.round(layer.opacity * 100)}
                        onChange={(event) => liveEdit((current) => setLayerProps(current, layer.id, { opacity: Number(event.target.value) / 100 }))}
                        aria-label={`${layer.name} opacity`}
                        title="Opacity"
                      />
                      <button
                        type="button"
                        className={styles.mini}
                        onClick={() => structuralEdit((current) => reorderLayer(current, layer.id, index + 1))}
                        disabled={index === doc.layers.length - 1}
                        aria-label="Move layer up"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className={styles.mini}
                        onClick={() => structuralEdit((current) => reorderLayer(current, layer.id, index - 1))}
                        disabled={index === 0}
                        aria-label="Move layer down"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className={styles.mini}
                        onClick={() => structuralEdit((current) => removeLayer(current, layer.id))}
                        disabled={doc.layers.length <= 1}
                        aria-label="Delete layer"
                      >
                        🗑
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </aside>
        </div>

        {error && <p className={styles.error}>{error}</p>}
      </div>
    </div>
  );
}
