"use client";

/**
 * FX tab: authors the cart's post-processing stack. Composes one screen of the
 * map from the sprite sheet (the same 30×17-tile screens the map editor marks
 * with guides) and runs it through the shared WebGL effect chain
 * (@cartbox/player's PostFxPass — the exact pipeline the runtime player uses),
 * with a generic control panel driven by the POST_FX_EFFECTS definitions.
 *
 * The settings are owned by the workbench: they persist with the cart on Save
 * and are applied live by the player on Run and on the public play page.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { SpriteSheet, TileMap } from "@cartbox/editor";
import {
  POST_FX_EFFECTS,
  PostFxPass,
  defaultPostFxSettings,
  paramKey,
  uniformsFromSettings,
  type PostFxEffectId,
  type PostFxSettings,
} from "@cartbox/player";

import styles from "./editor.module.css";

/** Upscale factor from cart pixels to canvas pixels (240×136 → 960×544). */
const PREVIEW_SCALE = 4;

interface ShaderEditorProps {
  sheet: SpriteSheet;
  map: TileMap;
  /** The cart's FX stack, owned by the workbench so it persists on Save. */
  settings: PostFxSettings;
  onSettingsChange: (settings: PostFxSettings) => void;
}

/** Rasterise one map screen (screenWidth×screenHeight tiles) to RGBA bytes. */
function composeScreen(sheet: SpriteSheet, map: TileMap, screenColumn: number, screenRow: number): Uint8ClampedArray {
  const edge = sheet.tileSize;
  const width = map.screenWidth * edge;
  const out = new Uint8ClampedArray(width * map.screenHeight * edge * 4);
  for (let cellY = 0; cellY < map.screenHeight; cellY += 1) {
    for (let cellX = 0; cellX < map.screenWidth; cellX += 1) {
      const tile = map.getCell(screenColumn * map.screenWidth + cellX, screenRow * map.screenHeight + cellY);
      const rgba = sheet.renderTileRgba(0, tile);
      for (let y = 0; y < edge; y += 1) {
        const sourceRow = y * edge * 4;
        const targetRow = ((cellY * edge + y) * width + cellX * edge) * 4;
        out.set(rgba.subarray(sourceRow, sourceRow + edge * 4), targetRow);
      }
    }
  }
  return out;
}

export function ShaderEditor({ sheet, map, settings, onSettingsChange }: ShaderEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<PostFxPass | null>(null);
  const [screen, setScreen] = useState({ column: 0, row: 0 });
  const [webglMissing, setWebglMissing] = useState(false);

  const screenColumns = Math.floor(map.width / map.screenWidth);
  const screenRows = Math.floor(map.height / map.screenHeight);
  const sourceWidth = map.screenWidth * sheet.tileSize;
  const sourceHeight = map.screenHeight * sheet.tileSize;

  const source = useMemo(
    () => composeScreen(sheet, map, screen.column, screen.row),
    [sheet, map, screen],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = sourceWidth * PREVIEW_SCALE;
    canvas.height = sourceHeight * PREVIEW_SCALE;
    const renderer = PostFxPass.create(canvas);
    rendererRef.current = renderer;
    setWebglMissing(!renderer);
    return () => {
      renderer?.dispose();
      rendererRef.current = null;
    };
  }, [sourceWidth, sourceHeight]);

  useEffect(() => {
    rendererRef.current?.render(source, sourceWidth, sourceHeight, uniformsFromSettings(settings));
  }, [source, sourceWidth, sourceHeight, settings, webglMissing]);

  const toggleEffect = (id: PostFxEffectId) => {
    onSettingsChange({ ...settings, enabled: { ...settings.enabled, [id]: !settings.enabled[id] } });
  };

  const setValue = (key: string, value: number) => {
    onSettingsChange({ ...settings, values: { ...settings.values, [key]: value } });
  };

  return (
    <div className={styles.fxBody}>
      <section className={styles.stage}>
        <div className={styles.canvasPanel}>
          <canvas
            ref={canvasRef}
            className={styles.fxCanvas}
            role="img"
            aria-label={`Post-processing preview of map screen ${screen.column},${screen.row}`}
          />
        </div>
        {webglMissing && <div className={styles.fxNote}>WebGL is unavailable — the FX preview cannot render.</div>}
        <div className={styles.hud}>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>Screen</span>
            <select
              className={styles.fxSelect}
              value={`${screen.column},${screen.row}`}
              onChange={(event) => {
                const [column = 0, row = 0] = event.target.value.split(",").map(Number);
                setScreen({ column, row });
              }}
              aria-label="Map screen to preview"
            >
              {Array.from({ length: screenRows }, (_unused, row) =>
                Array.from({ length: screenColumns }, (_unused2, column) => (
                  <option key={`${column},${row}`} value={`${column},${row}`}>
                    {column},{row}
                  </option>
                )),
              )}
            </select>
          </span>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>Source</span>
            <span className={`${styles.hudValue} data`}>
              {sourceWidth}×{sourceHeight}
            </span>
          </span>
        </div>
        <div className={styles.fxNote}>
          Saved with the cart on Save and applied when it runs (playtest and the play page). Fog here is the
          screen-space kind — the volumetric god rays live in the Sprites tab&apos;s lit preview.
        </div>
      </section>

      <aside className={styles.fxPanel}>
        <div className={styles.panelHead}>
          <span className={styles.panelTitle}>Post-processing</span>
          <button type="button" className="cbx-btn" onClick={() => onSettingsChange(defaultPostFxSettings())}>
            Reset
          </button>
        </div>
        {POST_FX_EFFECTS.map((effect) => (
          <div key={effect.id} className={styles.fxEffect} data-enabled={settings.enabled[effect.id]}>
            <label className={styles.fxEffectHead}>
              <input
                type="checkbox"
                checked={settings.enabled[effect.id]}
                onChange={() => toggleEffect(effect.id)}
              />
              <span className={styles.fxEffectName}>{effect.label}</span>
              {effect.hasColor && (
                <input
                  type="color"
                  value={settings.fogColor}
                  onChange={(event) => onSettingsChange({ ...settings, fogColor: event.target.value })}
                  aria-label={`${effect.label} colour`}
                  title={`${effect.label} colour`}
                />
              )}
            </label>
            <div className={styles.fxEffectDescription}>{effect.description}</div>
            {settings.enabled[effect.id] &&
              effect.params.map((param) => {
                const key = paramKey(effect.id, param.id);
                return (
                  <label key={param.id} className={styles.fxParam}>
                    <span className={styles.fxParamLabel}>{param.label}</span>
                    <input
                      type="range"
                      min={param.min}
                      max={param.max}
                      step={param.step}
                      value={settings.values[key] ?? param.defaultValue}
                      onChange={(event) => setValue(key, Number(event.target.value))}
                      aria-label={`${effect.label} ${param.label}`}
                    />
                    <span className={`${styles.fxParamValue} data`}>
                      {(settings.values[key] ?? param.defaultValue).toFixed(param.step >= 1 ? 0 : 2)}
                    </span>
                  </label>
                );
              })}
          </div>
        ))}
      </aside>
    </div>
  );
}
