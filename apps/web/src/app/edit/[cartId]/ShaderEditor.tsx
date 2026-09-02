"use client";

/**
 * FX tab: authors the cart's post-processing stack.
 *
 * The stack is judged against a picture, so which picture matters. The tab
 * composes one — a flat map screen, the 3D map orbited from outside, or the 3D
 * map from where a player stands (see {@link fxSources}) — and runs it through
 * the shared WebGL effect chain (@cartbox/player's PostFxPass, the exact
 * pipeline the runtime player uses), with a generic control panel driven by the
 * POST_FX_EFFECTS definitions.
 *
 * The 3D framings are the point of the source picker: a cart whose world is
 * voxels, hexels and sprite-skinned planes cannot have its bloom threshold or
 * fog density judged against flat tiles, because none of the geometry that
 * feeds those effects is in the flat picture at all.
 *
 * The settings are owned by the workbench: they persist with the cart on Save
 * and are applied live by the player on Run and on the public play page.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  loadMapVoxelSpace,
  walkAxes,
  type Rgb,
  type SpriteSheet,
  type TileMap,
} from "@cartbox/editor";
import {
  POST_FX_EFFECTS,
  PostFxPass,
  defaultPostFxSettings,
  paramKey,
  uniformsFromSettings,
  type PostFxEffectId,
  type PostFxSettings,
} from "@cartbox/player";

import { buildMapAtlas } from "@/lib/mapAtlas";
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
import {
  FX_SOURCES,
  ORBIT_CELL_MAX,
  ORBIT_CELL_MIN,
  ORBIT_RADIUS_MAX,
  ORBIT_RADIUS_MIN,
  clampOrbitCell,
  clampOrbitPitch,
  createFxFrameBuffers,
  orbitCameraOnContent,
  renderFxFrame,
  type FxFrameBuffers,
  type FxFrameRequest,
  type FxOrbitCamera,
  type FxSourceId,
} from "./fxSources";
import { clampToMap, walkCameraOnContent, type WalkCamera } from "./walkCamera";

/** Upscale factor from cart pixels to canvas pixels (240×136 → 960×544). */
const PREVIEW_SCALE = 4;

/** Radians of camera movement per pixel dragged, orbiting and looking. */
const ORBIT_SPEED = 0.009;
const LOOK_SPEED = 0.005;

/** Pitch stops just short of straight up and down so the walk view never inverts. */
const WALK_PITCH_LIMIT = Math.PI / 2 - 0.02;

/** Cells travelled per key press, and the multiplier while Shift is held. */
const TRAVEL_STEP = 1;
const TRAVEL_RUN = 4;

/** How far a press may move before it counts as a drag rather than a click. */
const DRAG_THRESHOLD = 3;

/** Fallback for a palette index the sheet does not hold. */
const WHITE: Rgb = [255, 255, 255];

interface ShaderEditorProps {
  sheet: SpriteSheet;
  map: TileMap;
  /**
   * The cart's serialized 3D map cells, so the preview can compose the world the
   * effects will actually run over. Null on a cart that has never built any.
   */
  columnPayload: string | null;
  /** The cart's FX stack, owned by the workbench so it persists on Save. */
  settings: PostFxSettings;
  onSettingsChange: (settings: PostFxSettings) => void;
  /**
   * Changes when the cart in engine memory is replaced — an undo, a redo, or a
   * bank switch. The preview re-reads the art rather than being remounted, so
   * the camera and source the creator chose survive an undo.
   */
  resyncKey: string;
}

export function ShaderEditor({ sheet, map, columnPayload, settings, onSettingsChange, resyncKey }: ShaderEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<PostFxPass | null>(null);
  const [source, setSource] = useState<FxSourceId>("screen");
  const [screen, setScreen] = useState({ column: 0, row: 0 });
  const [webglMissing, setWebglMissing] = useState(false);

  const screenColumns = Math.floor(map.width / map.screenWidth);
  const screenRows = Math.floor(map.height / map.screenHeight);
  const sourceWidth = map.screenWidth * sheet.tileSize;
  const sourceHeight = map.screenHeight * sheet.tileSize;

  // The map's cells, read once from what the Map tab saved. This view never
  // writes them, so it takes a plain copy rather than sharing the editor's live
  // space — switching tabs remounts the preview and re-reads.
  const space = useMemo(
    () => loadMapVoxelSpace(columnPayload, map.width, map.height),
    [columnPayload, map.width, map.height],
  );

  // The same atlas and palette the map's own 3D views sample, so the preview is
  // the picture those views show rather than an approximation of it. Material
  // channels are deliberately not passed: the software renderers behind both 3D
  // sources light by face normal and never read them, so building them would be
  // work whose result is discarded.
  // `sheet` is a stable view onto engine memory, so its identity does not
  // change when the cart underneath does; resyncKey is what says "re-read".
  const palette = useMemo(() => {
    const table = sheet.paletteRgb();
    return (index: number): Rgb => table[index] ?? WHITE;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, resyncKey]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const atlas = useMemo(() => buildMapAtlas(sheet), [sheet, resyncKey]);
  const view = useMemo(() => ({ space, atlas, palette }), [space, atlas, palette]);

  const [orbit, setOrbit] = useState<FxOrbitCamera>(() => orbitCameraOnContent(space, sourceWidth));
  const [walk, setWalk] = useState<WalkCamera>(() => walkCameraOnContent(space));

  const buffers = useMemo(() => createFxFrameBuffers(sourceWidth, sourceHeight), [sourceWidth, sourceHeight]);

  const request = useMemo<FxFrameRequest>(() => {
    if (source === "orbit") return { source: "orbit", view, camera: orbit };
    if (source === "walk") return { source: "walk", view, camera: walk };
    return { source: "screen", sheet, map, screen };
  }, [source, view, orbit, walk, sheet, map, screen]);

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

  // Composing the frame and running the shader chain over it are separate costs
  // with separate triggers: the frame changes when the camera does, the chain
  // re-runs on every slider tick. Remembering what is already in the buffer is
  // what keeps a drag on a slider from re-marching thirty thousand rays.
  const composedRef = useRef<{ request: FxFrameRequest; buffers: FxFrameBuffers } | null>(null);
  useEffect(() => {
    const composed = composedRef.current;
    if (!composed || composed.request !== request || composed.buffers !== buffers) {
      renderFxFrame(request, buffers);
      composedRef.current = { request, buffers };
    }
    rendererRef.current?.render(buffers.frame, buffers.width, buffers.height, uniformsFromSettings(settings));
  }, [request, buffers, settings, webglMissing]);

  const toggleEffect = (id: PostFxEffectId) => {
    onSettingsChange({ ...settings, enabled: { ...settings.enabled, [id]: !settings.enabled[id] } });
  };

  const setValue = (key: string, value: number) => {
    onSettingsChange({ ...settings, values: { ...settings.values, [key]: value } });
  };

  const setColor = (key: string, value: string) => {
    onSettingsChange({ ...settings, colors: { ...settings.colors, [key]: value } });
  };

  const enabledCount = POST_FX_EFFECTS.filter((effect) => settings.enabled[effect.id]).length;
  const spatial = source !== "screen";

  // --- Camera -----------------------------------------------------------------
  // Both 3D sources are driven the same way — drag to turn, keys to travel — so
  // the pointer handlers dispatch on the source rather than existing twice.

  const drag = useRef<{ lastX: number; lastY: number; panning: boolean } | null>(null);

  /** Walk the orbit focus across the map, in screen-relative directions. */
  const moveOrbitFocus = (right: number, forward: number, up = 0) => {
    setOrbit((current) => {
      const x = current.focus.x + Math.cos(current.yaw) * right - Math.sin(current.yaw) * forward;
      const z = current.focus.z + Math.sin(current.yaw) * right + Math.cos(current.yaw) * forward;
      return {
        ...current,
        focus: {
          x: Math.max(0, Math.min(space.width - 1, x)),
          y: Math.max(0, Math.min(space.maxHeight - 1, current.focus.y + up)),
          z: Math.max(0, Math.min(space.depth - 1, z)),
        },
      };
    });
  };

  /** Walk the viewer, in the directions the image says are forward and right. */
  const moveWalk = (right: number, forward: number, up: number) => {
    setWalk((current) => {
      const axes = walkAxes(current.yaw);
      return clampToMap(space, {
        ...current,
        x: current.x + axes.forward[0] * forward + axes.right[0] * right,
        y: current.y + up,
        z: current.z + axes.forward[1] * forward + axes.right[1] * right,
      });
    });
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!spatial) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    // The travel keys are bound to the canvas, so a press has to focus it or
    // WASD would go nowhere until the user found the canvas with Tab.
    event.currentTarget.focus();
    drag.current = { lastX: event.clientX, lastY: event.clientY, panning: event.shiftKey || event.button === 1 };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const state = drag.current;
    if (!state) return;
    const dx = event.clientX - state.lastX;
    const dy = event.clientY - state.lastY;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    state.lastX = event.clientX;
    state.lastY = event.clientY;

    if (source === "orbit") {
      if (state.panning) {
        // Drag the world under the cursor: the scene follows the pointer, so the
        // focus travels the other way. Vertical drags are divided by how steeply
        // the camera looks down, since a shallow pitch foreshortens the ground.
        const foreshorten = Math.max(0.25, Math.sin(orbit.pitch));
        moveOrbitFocus(-dx / orbit.cell, -dy / (orbit.cell * foreshorten));
      } else {
        setOrbit((current) => ({
          ...current,
          yaw: current.yaw - dx * ORBIT_SPEED,
          pitch: clampOrbitPitch(current.pitch + dy * ORBIT_SPEED),
        }));
      }
      return;
    }
    setWalk((current) => ({
      ...current,
      yaw: current.yaw - dx * LOOK_SPEED,
      pitch: Math.max(-WALK_PITCH_LIMIT, Math.min(WALK_PITCH_LIMIT, current.pitch - dy * LOOK_SPEED)),
    }));
  };

  const endDrag = () => {
    drag.current = null;
  };

  const onKeyDown =(event: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!spatial) return;
    const step = event.shiftKey ? TRAVEL_RUN : TRAVEL_STEP;
    const moves: Record<string, readonly [number, number, number]> = {
      w: [0, step, 0],
      arrowup: [0, step, 0],
      s: [0, -step, 0],
      arrowdown: [0, -step, 0],
      a: [-step, 0, 0],
      arrowleft: [-step, 0, 0],
      d: [step, 0, 0],
      arrowright: [step, 0, 0],
      e: [0, 0, step],
      pageup: [0, 0, step],
      q: [0, 0, -step],
      pagedown: [0, 0, -step],
    };
    const move = moves[event.key.toLowerCase()];
    if (!move) return;
    event.preventDefault();
    if (source === "orbit") moveOrbitFocus(move[0], move[1], move[2]);
    else moveWalk(move[0], move[1], move[2]);
  };

  // Wheel zoom without letting the page scroll under the cursor. React's onWheel
  // is passive and cannot preventDefault, so bind a native listener.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || source !== "orbit") return;
    const handler = (event: WheelEvent) => {
      event.preventDefault();
      setOrbit((current) => ({ ...current, cell: clampOrbitCell(current.cell - Math.sign(event.deltaY)) }));
    };
    canvas.addEventListener("wheel", handler, { passive: false });
    return () => canvas.removeEventListener("wheel", handler);
  }, [source]);

  // --- Panels -----------------------------------------------------------------

  const sourceOption = FX_SOURCES.find((option) => option.id === source) ?? FX_SOURCES[0]!;

  const effectList = POST_FX_EFFECTS.map((effect) => (
    <div key={effect.id} className={styles.fxEffect} data-enabled={settings.enabled[effect.id]}>
      <label className={styles.fxEffectHead}>
        <input
          type="checkbox"
          checked={settings.enabled[effect.id]}
          onChange={() => toggleEffect(effect.id)}
        />
        <span className={styles.fxEffectName}>{effect.label}</span>
        {(effect.colors ?? []).map((color) => {
          const key = paramKey(effect.id, color.id);
          return (
            <input
              key={color.id}
              type="color"
              value={settings.colors[key] ?? color.defaultValue}
              onChange={(event) => setColor(key, event.target.value)}
              aria-label={`${effect.label} ${color.label}`}
              title={color.label}
            />
          );
        })}
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
  ));

  // The FX tab used to be the one editor with no rail at all — a two-column
  // layout of its own while every sibling had three. Its controls are a `view`
  // (what is being previewed, and from where) and an `io` (Reset), so it now
  // wears the same skeleton as the rest. See workbenchLayout.
  const rail: RailSlots = {
    view: (
      <RailGroup label="Preview">
        <SegmentedControl
          options={FX_SOURCES.map((option) => ({ id: option.id, label: option.label, hint: option.hint }))}
          selected={source}
          onSelect={setSource}
          ariaLabel="What the effect stack is previewed over"
        />
        <RailHint>{sourceOption.hint}</RailHint>
        {source === "screen" && (
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
        )}
      </RailGroup>
    ),

    canvas: spatial && (
      <RailGroup label="Camera">
        {source === "orbit" && (
          <RangeControl
            label="Zoom"
            nested
            min={ORBIT_CELL_MIN}
            max={ORBIT_CELL_MAX}
            value={orbit.cell}
            onChange={(cell) => setOrbit((current) => ({ ...current, cell: clampOrbitCell(cell) }))}
            ariaLabel="Orbit zoom, in preview pixels per cell"
            display={`${orbit.cell}px`}
          />
        )}
        {source === "orbit" && (
          <RangeControl
            label="Range"
            nested
            min={ORBIT_RADIUS_MIN}
            max={ORBIT_RADIUS_MAX}
            value={orbit.radius}
            onChange={(radius) => setOrbit((current) => ({ ...current, radius }))}
            ariaLabel="How many cells around the focus are built"
            display={`${orbit.radius * 2 + 1} cells`}
          />
        )}
        <div className={styles.toolGroup}>
          <button
            type="button"
            className={styles.toolBtn}
            onClick={() =>
              source === "orbit"
                ? setOrbit(orbitCameraOnContent(space, sourceWidth))
                : setWalk(walkCameraOnContent(space))
            }
            title="Move the camera back to the middle of what you have built"
          >
            <span className={styles.toolGlyph} aria-hidden>
              ⌖
            </span>
            Frame the build
          </button>
        </div>
        <RailHint>
          {source === "orbit"
            ? "Drag to turn, shift-drag to pan, wheel to zoom. W A S D moves the focus, Q and E change its height."
            : "Drag to look. W A S D walks, Q and E change height. Hold Shift to move faster."}
        </RailHint>
      </RailGroup>
    ),

    io: (
      <RailGroup label="Stack">
        <div className={styles.toolGroup}>
          <button
            type="button"
            className={styles.toolBtn}
            onClick={() => onSettingsChange(defaultPostFxSettings())}
            title="Return every effect to its default"
          >
            <span className={styles.toolGlyph} aria-hidden>
              ↺
            </span>
            Reset stack
          </button>
        </div>
      </RailGroup>
    ),
  };

  const inspector: InspectorSlots = {
    extras: (
      <InspectorPanel title="Post-processing" meta={`${enabledCount} on`}>
        <div className={styles.fxEffectList}>{effectList}</div>
      </InspectorPanel>
    ),

    hint: (
      <InspectorHint>
        Saved with the cart on Save and applied when it runs (playtest and the play page). Fog here is the
        screen-space kind — the volumetric god rays live in the Assets tab&apos;s lit preview.
      </InspectorHint>
    ),
  };

  return (
    <div className={styles.body}>
      <WorkbenchRail slots={rail} />

      <section className={styles.stage}>
        <div className={styles.canvasPanel}>
          <canvas
            ref={canvasRef}
            className={styles.fxCanvas}
            data-interactive={spatial || undefined}
            tabIndex={spatial ? 0 : undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={onKeyDown}
            onContextMenu={(event) => spatial && event.preventDefault()}
            role={spatial ? "application" : "img"}
            aria-label={
              spatial
                ? `Post-processing preview of the 3D map, ${sourceOption.label.toLowerCase()} view. Drag to turn, W A S D to move.`
                : `Post-processing preview of map screen ${screen.column},${screen.row}`
            }
          />
        </div>
        {webglMissing && <div className={styles.fxNote}>WebGL is unavailable — the FX preview cannot render.</div>}
        {spatial && space.isEmpty && (
          <div className={styles.fxNote}>
            This cart has no 3D map yet — build cells in the Map tab and they will appear here.
          </div>
        )}
        <div className={styles.hud}>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>{spatial ? "Camera" : "Screen"}</span>
            <span className={`${styles.hudValue} data`}>
              {source === "orbit"
                ? `${Math.round(orbit.focus.x)},${Math.round(orbit.focus.y)},${Math.round(orbit.focus.z)}`
                : source === "walk"
                  ? `${walk.x.toFixed(1)},${walk.y.toFixed(1)},${walk.z.toFixed(1)}`
                  : `${screen.column},${screen.row}`}
            </span>
          </span>
          {spatial && (
            <span className={styles.hudItem}>
              <span className={styles.hudLabel}>Cells</span>
              <span className={`${styles.hudValue} data`}>{space.cellCount.toLocaleString()}</span>
            </span>
          )}
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>Source</span>
            <span className={`${styles.hudValue} data`}>
              {sourceWidth}×{sourceHeight}
            </span>
          </span>
        </div>
      </section>

      <WorkbenchInspector slots={inspector} />
    </div>
  );
}
