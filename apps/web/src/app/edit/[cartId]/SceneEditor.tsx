"use client";

/**
 * Scene tab: authors the cart's parallax-scene backdrop.
 *
 * A scene is a stack of depth layers, each pointing at a region of the cart's
 * own sprite sheet, composited with aerial-perspective atmosphere behind the
 * cart's live foreground (see @cartbox/player's SceneBackdropSurface). This tab
 * lets the author declare those layers — their art region, depth, parallax and
 * placement — plus the scene-wide atmosphere, camera scroll and chroma-key, and
 * judges them against a live preview that runs the exact resolve→compose path the
 * runtime uses, reading the editor's current sprites.
 *
 * The spec is owned by the workbench: it persists with the cart on Save and is
 * applied by the player on Run and on the public play page. Every mutation goes
 * through the pure reducers in sceneAuthoring so this component holds no model
 * logic of its own.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { SpriteSheet } from "@cartbox/editor";
import { renderSceneBackdrop, resolveSceneLayers, type SceneSpec } from "@cartbox/player";

import styles from "./editor.module.css";
import { RailGroup, RailHint, RangeControl, SegmentedControl } from "./railControls";
import {
  InspectorHint,
  InspectorPanel,
  WorkbenchInspector,
  WorkbenchRail,
  type InspectorSlots,
  type RailSlots,
} from "./workbenchPanels";
import { createEditorRegionSource } from "./sceneRegionSource";
import {
  MAX_SCENE_LAYERS,
  withAtmosphere,
  withCamera,
  withKeyColor,
  withLayerAdded,
  withLayerMoved,
  withLayerRemoved,
  withLayerSource,
  withLayerUpdated,
} from "./sceneAuthoring";

/** Auto-scroll range offered in the UI, in cart pixels per frame. */
const SCROLL_LIMIT = 4;

/** Named air looks: each sets density, desaturation and lift together. */
const ATMOSPHERE_PRESET_VALUES = {
  clear: { density: 0.1, desaturate: 0.1, lift: 0.05 },
  hazy: { density: 0.35, desaturate: 0.35, lift: 0.2 },
  foggy: { density: 0.7, desaturate: 0.6, lift: 0.45 },
} as const;

type AtmospherePresetId = keyof typeof ATMOSPHERE_PRESET_VALUES;

const ATMOSPHERE_PRESETS: readonly { id: AtmospherePresetId; label: string }[] = [
  { id: "clear", label: "Clear" },
  { id: "hazy", label: "Hazy" },
  { id: "foggy", label: "Foggy" },
];

/** The preset the current atmosphere matches exactly, or null when hand-tuned. */
function activeAtmospherePreset(atmosphere: {
  density: number;
  desaturate: number;
  lift: number;
}): AtmospherePresetId | null {
  for (const id of Object.keys(ATMOSPHERE_PRESET_VALUES) as AtmospherePresetId[]) {
    const preset = ATMOSPHERE_PRESET_VALUES[id];
    if (
      Math.abs(atmosphere.density - preset.density) < 0.005 &&
      Math.abs(atmosphere.desaturate - preset.desaturate) < 0.005 &&
      Math.abs(atmosphere.lift - preset.lift) < 0.005
    ) {
      return id;
    }
  }
  return null;
}

interface SceneEditorProps {
  sheet: SpriteSheet;
  /** The cart's screen size, so the preview matches the runtime backdrop. */
  width: number;
  height: number;
  scene: SceneSpec | null;
  onSceneChange: (scene: SceneSpec | null) => void;
  /** Bumps when the cart's art changes, so the preview re-reads the sprites. */
  revision: number;
}

/** An 0..255 RGB triplet as a "#rrggbb" string for a colour input. */
function toHex([r, g, b]: readonly number[]): string {
  const channel = (value: number) => Math.round(value).toString(16).padStart(2, "0");
  return `#${channel(r ?? 0)}${channel(g ?? 0)}${channel(b ?? 0)}`;
}

/** Parse a "#rrggbb" colour input value back to an 0..255 RGB triplet. */
function fromHex(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16) || 0,
    parseInt(hex.slice(3, 5), 16) || 0,
    parseInt(hex.slice(5, 7), 16) || 0,
  ];
}

export function SceneEditor({ sheet, width, height, scene, onSceneChange, revision }: SceneEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selected, setSelected] = useState(0);

  // Keep the selected layer valid as layers are added and removed.
  const layerCount = scene?.layers.length ?? 0;
  const activeIndex = layerCount === 0 ? -1 : Math.min(selected, layerCount - 1);
  const activeLayer = activeIndex >= 0 ? scene!.layers[activeIndex]! : null;

  // Re-reading the sheet is cheap but not free; rebuild the source only when the
  // cart's art changes (revision) so it reflects sprite edits made in other tabs.
  const source = useMemo(() => createEditorRegionSource(sheet), [sheet, revision]);
  const layers = useMemo(() => (scene ? resolveSceneLayers(scene, source) : []), [scene, source]);

  // The live preview: run the real backdrop renderer each frame so auto-scroll
  // and atmosphere read exactly as they will at runtime.
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    canvas.width = width;
    canvas.height = height;

    if (!scene || layers.length === 0) {
      context.clearRect(0, 0, width, height);
      return;
    }

    const out = new Uint8ClampedArray(width * height * 4);
    let frame = 0;
    let raf = 0;
    const draw = () => {
      renderSceneBackdrop(out, width, height, layers, scene, frame);
      context.putImageData(new ImageData(out, width, height), 0, 0);
      frame += 1;
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [scene, layers, width, height]);

  const pageOptions = [
    { id: 0 as const, label: "Front" },
    { id: 1 as const, label: "Back" },
  ];
  const wrapOptions = [
    { id: "wrap" as const, label: "Wrap" },
    { id: "clamp" as const, label: "Clamp" },
  ];
  const parallaxOptions = [
    { id: "auto" as const, label: "Auto" },
    { id: "custom" as const, label: "Custom" },
  ];

  const rail: RailSlots = {
    layer: (
      <RailGroup label="Layers">
        <div className={styles.toolGroup}>
          {(scene?.layers ?? []).map((layer, index) => (
            <button
              key={index}
              type="button"
              className={`${styles.toolBtn} ${index === activeIndex ? styles.toolBtnActive : ""}`}
              onClick={() => setSelected(index)}
              aria-pressed={index === activeIndex}
            >
              <span className={styles.toolGlyph} aria-hidden>
                {index === 0 ? "▲" : index === layerCount - 1 ? "▽" : "◆"}
              </span>
              Layer {index + 1} · {Math.round(layer.depth * 100)}%
            </button>
          ))}
          <button
            type="button"
            className={styles.toolBtn}
            onClick={() => {
              const next = withLayerAdded(scene);
              onSceneChange(next);
              setSelected(next.layers.length - 1);
            }}
            disabled={layerCount >= MAX_SCENE_LAYERS}
            title={layerCount >= MAX_SCENE_LAYERS ? `A scene holds at most ${MAX_SCENE_LAYERS} layers` : "Add a backdrop layer"}
          >
            <span className={styles.toolGlyph} aria-hidden>
              ＋
            </span>
            Add layer
          </button>
        </div>
        <RailHint>
          Layers paint far to near. Nearer layers (lower depth) scroll faster and stay crisp; farther ones
          desaturate and haze toward the fog colour.
        </RailHint>
      </RailGroup>
    ),
    toolOptions: activeLayer ? (
      <RailGroup label={`Layer ${activeIndex + 1}`}>
        <SegmentedControl
          label="Sprite page"
          options={pageOptions}
          selected={activeLayer.source.page}
          onSelect={(page) => onSceneChange(withLayerSource(scene!, activeIndex, { page }))}
        />
        <RangeControl
          label="First tile"
          min={0}
          max={255}
          value={activeLayer.source.tile}
          onChange={(tile) => onSceneChange(withLayerSource(scene!, activeIndex, { tile }))}
          ariaLabel="Layer region first tile"
        />
        <RangeControl
          label="Region size"
          nested
          min={1}
          max={32}
          value={activeLayer.source.tilesW}
          onChange={(tilesW) => onSceneChange(withLayerSource(scene!, activeIndex, { tilesW }))}
          ariaLabel="Layer region width in tiles"
          display={`${activeLayer.source.tilesW} w`}
        />
        <RangeControl
          nested
          min={1}
          max={32}
          value={activeLayer.source.tilesH}
          onChange={(tilesH) => onSceneChange(withLayerSource(scene!, activeIndex, { tilesH }))}
          ariaLabel="Layer region height in tiles"
          display={`${activeLayer.source.tilesH} h`}
        />
        <RangeControl
          label="Depth"
          min={0}
          max={100}
          value={Math.round(activeLayer.depth * 100)}
          onChange={(percent) => onSceneChange(withLayerUpdated(scene!, activeIndex, { depth: percent / 100 }))}
          ariaLabel="Layer depth"
          display={`${Math.round(activeLayer.depth * 100)}%`}
        />
        <RangeControl
          label="Vertical offset"
          min={-height}
          max={height}
          value={activeLayer.offsetY ?? 0}
          onChange={(offsetY) => onSceneChange(withLayerUpdated(scene!, activeIndex, { offsetY }))}
          ariaLabel="Layer vertical offset in pixels"
          display={`${activeLayer.offsetY ?? 0}px`}
        />
        <SegmentedControl
          label="Horizontal"
          options={wrapOptions}
          selected={activeLayer.wrapX === false ? "clamp" : "wrap"}
          onSelect={(mode) => onSceneChange(withLayerUpdated(scene!, activeIndex, { wrapX: mode === "wrap" }))}
        />
        <SegmentedControl
          label="Parallax"
          options={parallaxOptions}
          selected={activeLayer.parallax === undefined ? "auto" : "custom"}
          onSelect={(mode) =>
            onSceneChange(
              withLayerUpdated(scene!, activeIndex, {
                parallax: mode === "auto" ? undefined : (activeLayer.parallax ?? 1 - activeLayer.depth),
              }),
            )
          }
        />
        {activeLayer.parallax !== undefined && (
          <RangeControl
            nested
            label="Factor"
            min={0}
            max={400}
            value={Math.round(activeLayer.parallax * 100)}
            onChange={(percent) => onSceneChange(withLayerUpdated(scene!, activeIndex, { parallax: percent / 100 }))}
            ariaLabel="Layer parallax factor"
            display={`${activeLayer.parallax.toFixed(2)}×`}
          />
        )}
        <div className={styles.segmented} role="group" aria-label="Reorder or remove layer" style={{ marginTop: 8 }}>
          <button
            type="button"
            className={styles.segment}
            onClick={() => onSceneChange(withLayerMoved(scene!, activeIndex, -1))}
            disabled={activeIndex <= 0}
            aria-label="Move layer nearer"
            title="Move nearer (paints later)"
          >
            ↑
          </button>
          <button
            type="button"
            className={styles.segment}
            onClick={() => onSceneChange(withLayerMoved(scene!, activeIndex, 1))}
            disabled={activeIndex >= layerCount - 1}
            aria-label="Move layer farther"
            title="Move farther (paints earlier)"
          >
            ↓
          </button>
          <button
            type="button"
            className={styles.segment}
            onClick={() => {
              onSceneChange(withLayerRemoved(scene!, activeIndex));
              setSelected((current) => Math.max(0, current - 1));
            }}
            aria-label="Remove layer"
            title="Remove this layer"
          >
            ✕
          </button>
        </div>
      </RailGroup>
    ) : undefined,
    canvas: scene ? (
      <>
        <RailGroup label="Camera">
          <RangeControl
            label="Auto-scroll X"
            nested
            min={-SCROLL_LIMIT * 100}
            max={SCROLL_LIMIT * 100}
            value={Math.round((scene.camera.autoScrollX ?? 0) * 100)}
            onChange={(value) => onSceneChange(withCamera(scene, { autoScrollX: value / 100 }))}
            ariaLabel="Backdrop auto-scroll X speed"
            display={`${(scene.camera.autoScrollX ?? 0).toFixed(2)}`}
          />
          <RangeControl
            nested
            label="Auto-scroll Y"
            min={-SCROLL_LIMIT * 100}
            max={SCROLL_LIMIT * 100}
            value={Math.round((scene.camera.autoScrollY ?? 0) * 100)}
            onChange={(value) => onSceneChange(withCamera(scene, { autoScrollY: value / 100 }))}
            ariaLabel="Backdrop auto-scroll Y speed"
            display={`${(scene.camera.autoScrollY ?? 0).toFixed(2)}`}
          />
        </RailGroup>
        <RangeControl
          label="Key colour"
          min={0}
          max={sheet.paletteSize - 1}
          value={scene.keyColor}
          onChange={(keyColor) => onSceneChange(withKeyColor(scene, keyColor))}
          ariaLabel="Chroma-key palette index"
          display={`#${scene.keyColor}`}
        />
      </>
    ) : undefined,
    io: scene ? (
      <RailGroup label="Backdrop">
        <button type="button" className={styles.toolBtn} onClick={() => onSceneChange(null)} title="Remove the whole backdrop">
          <span className={styles.toolGlyph} aria-hidden>
            🗑
          </span>
          Clear backdrop
        </button>
      </RailGroup>
    ) : undefined,
  };

  const inspector: InspectorSlots = {
    extras: scene ? (
      <InspectorPanel title="Atmosphere">
        <div className={styles.rangeRow}>
          <label htmlFor="scene-fog" className={styles.groupLabel}>
            Fog colour
          </label>
          <input
            id="scene-fog"
            type="color"
            value={toHex(scene.atmosphere.fog)}
            onChange={(event) => onSceneChange(withAtmosphere(scene, { fog: fromHex(event.target.value) }))}
            aria-label="Atmosphere fog colour"
          />
        </div>

        {/* Most authors want a look, not three numbers: the presets set density,
            desaturation and lift together, and the exact sliders fold away below
            for the author who wants to dial them in. */}
        <SegmentedControl
          label="Depth of air"
          options={ATMOSPHERE_PRESETS}
          selected={activeAtmospherePreset(scene.atmosphere)}
          onSelect={(id) => onSceneChange(withAtmosphere(scene, ATMOSPHERE_PRESET_VALUES[id]))}
        />
        <RailGroup label="Fine tune" advanced>
          <RangeControl
            label="Density"
            nested
            min={0}
            max={100}
            value={Math.round(scene.atmosphere.density * 100)}
            onChange={(percent) => onSceneChange(withAtmosphere(scene, { density: percent / 100 }))}
            ariaLabel="Atmosphere density"
            display={`${Math.round(scene.atmosphere.density * 100)}%`}
          />
          <RangeControl
            label="Desaturation"
            nested
            min={0}
            max={100}
            value={Math.round(scene.atmosphere.desaturate * 100)}
            onChange={(percent) => onSceneChange(withAtmosphere(scene, { desaturate: percent / 100 }))}
            ariaLabel="Atmosphere desaturation with distance"
            display={`${Math.round(scene.atmosphere.desaturate * 100)}%`}
          />
          <RangeControl
            label="Contrast lift"
            nested
            min={0}
            max={100}
            value={Math.round(scene.atmosphere.lift * 100)}
            onChange={(percent) => onSceneChange(withAtmosphere(scene, { lift: percent / 100 }))}
            ariaLabel="Atmosphere contrast lift toward fog"
            display={`${Math.round(scene.atmosphere.lift * 100)}%`}
          />
        </RailGroup>
      </InspectorPanel>
    ) : undefined,
    hint: (
      <InspectorHint>
        The backdrop is composited behind the cart&apos;s frame at runtime: every pixel the cart draws in the key
        colour shows the scene through it. Layers read from this cart&apos;s own sprite pages, so paint the backdrop
        art in the Assets tab and point layers at it here.
      </InspectorHint>
    ),
  };

  return (
    <div className={styles.body}>
      <WorkbenchRail slots={rail} />

      <section className={styles.stage}>
        <div className={styles.canvasPanel}>
          {scene ? (
            <canvas
              ref={canvasRef}
              className={styles.fxCanvas}
              style={{ imageRendering: "pixelated" }}
              role="img"
              aria-label="Parallax backdrop preview"
            />
          ) : (
            <div className={styles.fxNote}>
              No backdrop yet. Add a layer from the rail, then point it at a region of this cart&apos;s sprites.
            </div>
          )}
        </div>
        {scene && (
          <div className={styles.hud}>
            <span className={styles.hudItem}>
              <span className={styles.hudLabel}>Layers</span>
              <span className={`${styles.hudValue} data`}>{layerCount}</span>
            </span>
            <span className={styles.hudItem}>
              <span className={styles.hudLabel}>Size</span>
              <span className={`${styles.hudValue} data`}>
                {width}×{height}
              </span>
            </span>
          </div>
        )}
      </section>

      <WorkbenchInspector slots={inspector} />
    </div>
  );
}
