"use client";

/**
 * Anim tab: authors the cart's animation timeline.
 *
 * An animation is sprite-frame clips (drawn as foreground placements) plus tracks
 * that drive scene-layer channels, post-FX values, and placement transforms. The
 * player plays it host-side off the frame clock (see @cartbox/player's
 * AnimatedForegroundSurface / evaluate). This tab lets the author declare clips,
 * place them, and add tracks — each a CONSTANT held value or a GENERATOR
 * (flicker/pulse/drift/sway) — and judges them against a live preview that runs
 * the real `evaluate` over this cart's scene backdrop and sprites.
 *
 * The spec is owned by the workbench: it persists with the cart on Save and is
 * applied by the player on Run and on the public play page. Every mutation goes
 * through the pure reducers in animAuthoring so this component holds no model
 * logic of its own.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SpriteSheet } from "@cartbox/editor";
import {
  evaluate,
  renderSceneBackdrop,
  resolveSceneLayers,
  type AnimSpec,
  type AnimTarget,
  type SceneSpec,
} from "@cartbox/player";

/** The resolved-layer shape, inferred (ParallaxLayer is not a top-level export). */
type ResolvedLayer = ReturnType<typeof resolveSceneLayers>[number] & {
  offsetX?: number;
  offsetY?: number;
  opacity?: number;
  emissive?: number;
};

import styles from "./editor.module.css";
import { RailGroup, RailHint, RangeControl, SegmentedControl } from "./railControls";
import { InspectorHint, InspectorPanel, WorkbenchInspector, WorkbenchRail, type InspectorSlots, type RailSlots } from "./workbenchPanels";
import { createEditorRegionSource } from "./sceneRegionSource";
import {
  DEFAULT_GENERATOR_PARAMS,
  LAYER_CHANNELS,
  PLACEMENT_CHANNELS,
  POSTFX_KEYS,
  describeTarget,
  withClipAdded,
  withClipFrameAdded,
  withClipFrameDuration,
  withClipFrameRemoved,
  withClipFrameSource,
  withClipRemoved,
  withClipUpdated,
  withPlacementAdded,
  withPlacementRemoved,
  withPlacementUpdated,
  withTrackAdded,
  withTrackConstant,
  withTrackGenerator,
  withTrackRemoved,
  withTrackTarget,
  type GeneratorKind,
  type GeneratorParams,
} from "./animAuthoring";

interface AnimEditorProps {
  sheet: SpriteSheet;
  width: number;
  height: number;
  /** The cart's backdrop, so the preview shows the animation over the real scene. */
  scene: SceneSpec | null;
  anim: AnimSpec | null;
  onAnimChange: (anim: AnimSpec | null) => void;
  /** Bumps when the cart's art changes, so the preview re-reads the sprites. */
  revision: number;
}

type Selection = { kind: "clip" | "placement" | "track"; index: number } | null;

const GENERATORS: readonly GeneratorKind[] = ["flicker", "pulse", "drift", "sway"];

/** A labelled native select for the small pick-one controls the tab needs. */
function SelectRow<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className={styles.rangeRow}>
      <label className={styles.groupLabel}>{label}</label>
      <select
        value={String(value)}
        onChange={(event) => {
          const raw = event.target.value;
          const match = options.find((option) => String(option.value) === raw);
          if (match) onChange(match.value);
        }}
        aria-label={label}
      >
        {options.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function AnimEditor({ sheet, width, height, scene, anim, onAnimChange, revision }: AnimEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selection, setSelection] = useState<Selection>(null);
  // Generator params are transient UI state (not part of the spec): the author
  // tunes them then applies a generator, which bakes keyframes into the track.
  const [generatorParams, setGeneratorParams] = useState<GeneratorParams>(DEFAULT_GENERATOR_PARAMS);

  const clips = anim?.clips ?? [];
  const placements = anim?.placements ?? [];
  const tracks = anim?.tracks ?? [];
  const clipNames = clips.map((clip) => clip.name);

  // Reading the sheet is cheap but not free; rebuild the source only when the
  // cart's art changes (revision) so the preview reflects edits in other tabs.
  const source = useMemo(() => createEditorRegionSource(sheet), [sheet, revision]);
  const sceneLayers = useMemo(() => (scene ? resolveSceneLayers(scene, source) : []), [scene, source]);

  // Live preview: run the real `evaluate` each frame and composite the animated
  // scene backdrop + foreground placements exactly as the player would.
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    canvas.width = width;
    canvas.height = height;

    const out = new Uint8ClampedArray(width * height * 4);
    let frame = 0;
    let raf = 0;
    const draw = () => {
      const state = anim ? evaluate(anim, frame) : { layers: {}, postfx: {}, placements: [] };

      if (scene && sceneLayers.length > 0) {
        const layers = sceneLayers.map((layer, index) => applyLayerOverride(layer, state.layers[index]));
        renderSceneBackdrop(out, width, height, layers, scene, frame);
      } else {
        fillDark(out); // no backdrop: a neutral field so placements read
      }
      for (const placement of state.placements) drawPlacement(out, width, height, source, placement);

      context.putImageData(new ImageData(out, width, height), 0, 0);
      frame += 1;
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [anim, scene, sceneLayers, source, width, height]);

  const addTrack = (target: AnimTarget) => {
    const next = withTrackAdded(anim, target);
    onAnimChange(next);
    setSelection({ kind: "track", index: next.tracks.length - 1 });
  };

  const rail: RailSlots = {
    layer: (
      <>
        <RailGroup label="Clips">
          <div className={styles.toolGroup}>
            {clips.map((clip, index) => (
              <ListButton
                key={index}
                active={selection?.kind === "clip" && selection.index === index}
                glyph="🎞"
                label={`${clip.name} · ${clip.frames.length}f`}
                onClick={() => setSelection({ kind: "clip", index })}
              />
            ))}
            <AddButton
              label="Add clip"
              onClick={() => {
                const next = withClipAdded(anim);
                onAnimChange(next);
                setSelection({ kind: "clip", index: next.clips.length - 1 });
              }}
            />
          </div>
        </RailGroup>

        <RailGroup label="Placements">
          <div className={styles.toolGroup}>
            {placements.map((placement, index) => (
              <ListButton
                key={index}
                active={selection?.kind === "placement" && selection.index === index}
                glyph="✦"
                label={`${placement.clip} @ ${placement.x},${placement.y}`}
                onClick={() => setSelection({ kind: "placement", index })}
              />
            ))}
            <AddButton
              label="Add placement"
              disabled={clipNames.length === 0}
              title={clipNames.length === 0 ? "Add a clip first" : "Place a clip in the frame"}
              onClick={() => {
                const next = withPlacementAdded(anim, clipNames[0]!, Math.round(width / 2), Math.round(height / 2));
                onAnimChange(next);
                setSelection({ kind: "placement", index: next.placements.length - 1 });
              }}
            />
          </div>
        </RailGroup>

        <RailGroup label="Tracks">
          <div className={styles.toolGroup}>
            {tracks.map((track, index) => (
              <ListButton
                key={index}
                active={selection?.kind === "track" && selection.index === index}
                glyph="〜"
                label={describeTarget(track.target)}
                onClick={() => setSelection({ kind: "track", index })}
              />
            ))}
            <AddButton label="Layer track" disabled={!scene} title={scene ? "Drive a scene layer" : "Add a backdrop in the Scene tab first"}
              onClick={() => addTrack({ kind: "sceneLayer", index: 0, channel: "emissive" })} />
            <AddButton label="FX track" onClick={() => addTrack({ kind: "postfx", key: POSTFX_KEYS[0]! })} />
            <AddButton label="Placement track" disabled={placements.length === 0} title={placements.length ? "Drive a placement" : "Add a placement first"}
              onClick={() => addTrack({ kind: "placement", index: 0, channel: "y" })} />
          </div>
          <RailHint>Tracks hold a constant value or run a generator — flicker a neon layer, drift fog, breathe bloom, bob a flame.</RailHint>
        </RailGroup>
      </>
    ),
    toolOptions: renderSelectedEditor(),
    io: anim ? (
      <RailGroup label="Animation">
        <button type="button" className={styles.toolBtn} onClick={() => { onAnimChange(null); setSelection(null); }} title="Remove the whole animation">
          <span className={styles.toolGlyph} aria-hidden>🗑</span>
          Clear animation
        </button>
      </RailGroup>
    ) : undefined,
  };

  const inspector: InspectorSlots = {
    extras: renderInspectorExtras(),
    hint: (
      <InspectorHint>
        Clips and placements read this cart&apos;s own sprites — paint the art in the Assets tab, then point a clip&apos;s
        frames at it here. The preview runs the real playback; Run and the play page play the same animation.
      </InspectorHint>
    ),
  };

  return (
    <div className={styles.body}>
      <WorkbenchRail slots={rail} />
      <section className={styles.stage}>
        <div className={styles.canvasPanel}>
          <canvas ref={canvasRef} className={styles.fxCanvas} style={{ imageRendering: "pixelated" }} role="img" aria-label="Animation preview" />
        </div>
        <div className={styles.hud}>
          <HudItem label="Clips" value={clips.length} />
          <HudItem label="Placements" value={placements.length} />
          <HudItem label="Tracks" value={tracks.length} />
        </div>
      </section>
      <WorkbenchInspector slots={inspector} />
    </div>
  );

  /** The rail editor for the current selection (clip frames / placement / track). */
  function renderSelectedEditor(): ReactNode {
    if (!anim || !selection) return undefined;

    if (selection.kind === "clip") {
      const clip = clips[selection.index];
      if (!clip) return undefined;
      return (
        <RailGroup label={`Clip · ${clip.name}`}>
          <div className={styles.rangeRow}>
            <label className={styles.groupLabel}>Name</label>
            <input type="text" value={clip.name} aria-label="Clip name"
              onChange={(event) => onAnimChange(withClipUpdated(anim, selection.index, { name: event.target.value }))} />
          </div>
          <SegmentedControl label="Loop" options={[{ id: "loop", label: "Loop" }, { id: "pingpong", label: "Ping" }, { id: "once", label: "Once" }]}
            selected={clip.mode} onSelect={(mode) => onAnimChange(withClipUpdated(anim, selection.index, { mode }))} />
          {clip.frames.map((region, frameIndex) => (
            <div key={frameIndex} className={styles.toolGroup} style={{ marginTop: 6 }}>
              <span className={styles.groupLabel}>Frame {frameIndex + 1}</span>
              <SegmentedControl label="Page" options={[{ id: 0 as const, label: "Front" }, { id: 1 as const, label: "Back" }]}
                selected={region.page} onSelect={(page) => onAnimChange(withClipFrameSource(anim, selection.index, frameIndex, { page }))} />
              <RangeControl label="Tile" min={0} max={255} value={region.tile}
                onChange={(tile) => onAnimChange(withClipFrameSource(anim, selection.index, frameIndex, { tile }))} ariaLabel="Frame first tile" />
              <RangeControl nested min={1} max={32} value={region.tilesW} display={`${region.tilesW} w`}
                onChange={(tilesW) => onAnimChange(withClipFrameSource(anim, selection.index, frameIndex, { tilesW }))} ariaLabel="Frame width in tiles" />
              <RangeControl nested min={1} max={32} value={region.tilesH} display={`${region.tilesH} h`}
                onChange={(tilesH) => onAnimChange(withClipFrameSource(anim, selection.index, frameIndex, { tilesH }))} ariaLabel="Frame height in tiles" />
              <RangeControl nested label="Hold" min={1} max={120} value={clip.durations[frameIndex] ?? 1} display={`${clip.durations[frameIndex] ?? 1}t`}
                onChange={(ticks) => onAnimChange(withClipFrameDuration(anim, selection.index, frameIndex, ticks))} ariaLabel="Frame hold ticks" />
              {clip.frames.length > 1 && (
                <button type="button" className={styles.toolBtn} onClick={() => onAnimChange(withClipFrameRemoved(anim, selection.index, frameIndex))}>
                  Remove frame {frameIndex + 1}
                </button>
              )}
            </div>
          ))}
          <AddButton label="Add frame" onClick={() => onAnimChange(withClipFrameAdded(anim, selection.index))} />
          <RemoveButton label="Delete clip" onClick={() => { onAnimChange(withClipRemoved(anim, selection.index)); setSelection(null); }} />
        </RailGroup>
      );
    }

    if (selection.kind === "placement") {
      const placement = placements[selection.index];
      if (!placement) return undefined;
      return (
        <RailGroup label={`Placement ${selection.index + 1}`}>
          <SelectRow label="Clip" value={placement.clip} options={clipNames.map((name) => ({ value: name, label: name }))}
            onChange={(clip) => onAnimChange(withPlacementUpdated(anim, selection.index, { clip }))} />
          <RangeControl label="X" min={0} max={width} value={placement.x} display={`${placement.x}px`}
            onChange={(x) => onAnimChange(withPlacementUpdated(anim, selection.index, { x }))} ariaLabel="Placement X" />
          <RangeControl label="Y" min={0} max={height} value={placement.y} display={`${placement.y}px`}
            onChange={(y) => onAnimChange(withPlacementUpdated(anim, selection.index, { y }))} ariaLabel="Placement Y" />
          <RangeControl label="Scale" min={25} max={600} value={Math.round(placement.scale * 100)} display={`${placement.scale.toFixed(2)}×`}
            onChange={(percent) => onAnimChange(withPlacementUpdated(anim, selection.index, { scale: percent / 100 }))} ariaLabel="Placement scale" />
          <RangeControl label="Opacity" min={0} max={100} value={Math.round(placement.opacity * 100)} display={`${Math.round(placement.opacity * 100)}%`}
            onChange={(percent) => onAnimChange(withPlacementUpdated(anim, selection.index, { opacity: percent / 100 }))} ariaLabel="Placement opacity" />
          <RemoveButton label="Delete placement" onClick={() => { onAnimChange(withPlacementRemoved(anim, selection.index)); setSelection(null); }} />
        </RailGroup>
      );
    }

    // track
    const track = tracks[selection.index];
    if (!track) return undefined;
    const target = track.target;
    return (
      <RailGroup label="Track">
        <SelectRow label="Target" value={target.kind}
          options={[{ value: "sceneLayer" as const, label: "Scene layer" }, { value: "postfx" as const, label: "Post-FX" }, { value: "placement" as const, label: "Placement" }]}
          onChange={(kind) => onAnimChange(withTrackTarget(anim, selection.index, defaultTargetFor(kind)))} />
        {target.kind === "sceneLayer" && (
          <>
            <RangeControl label="Layer" min={1} max={(scene?.layers.length ?? 1)} value={target.index + 1} display={`#${target.index + 1}`}
              onChange={(n) => onAnimChange(withTrackTarget(anim, selection.index, { ...target, index: n - 1 }))} ariaLabel="Scene layer number" />
            <SelectRow label="Channel" value={target.channel} options={LAYER_CHANNELS.map((c) => ({ value: c, label: c }))}
              onChange={(channel) => onAnimChange(withTrackTarget(anim, selection.index, { ...target, channel }))} />
          </>
        )}
        {target.kind === "postfx" && (
          <SelectRow label="FX value" value={target.key} options={POSTFX_KEYS.map((k) => ({ value: k, label: k }))}
            onChange={(key) => onAnimChange(withTrackTarget(anim, selection.index, { kind: "postfx", key }))} />
        )}
        {target.kind === "placement" && (
          <>
            <RangeControl label="Placement" min={1} max={Math.max(1, placements.length)} value={target.index + 1} display={`#${target.index + 1}`}
              onChange={(n) => onAnimChange(withTrackTarget(anim, selection.index, { ...target, index: n - 1 }))} ariaLabel="Placement number" />
            <SelectRow label="Channel" value={target.channel} options={PLACEMENT_CHANNELS.map((c) => ({ value: c, label: c }))}
              onChange={(channel) => onAnimChange(withTrackTarget(anim, selection.index, { ...target, channel }))} />
          </>
        )}
        <RemoveButton label="Delete track" onClick={() => { onAnimChange(withTrackRemoved(anim, selection.index)); setSelection(null); }} />
      </RailGroup>
    );
  }

  /** The inspector panel: a track's constant value + generator; nothing otherwise. */
  function renderInspectorExtras(): ReactNode {
    if (!anim || selection?.kind !== "track") return undefined;
    const track = tracks[selection.index];
    if (!track) return undefined;
    const isGenerated = track.keys.length > 1 || track.mode !== "hold";
    return (
      <InspectorPanel title="Motion">
        <RangeControl label="Constant value" min={-200} max={400} value={Math.round((track.keys[0]?.value ?? 0) * 100)} display={`${(track.keys[0]?.value ?? 0).toFixed(2)}`}
          onChange={(v) => onAnimChange(withTrackConstant(anim, selection.index, v / 100))} ariaLabel="Track constant value" />
        <span className={styles.groupLabel} style={{ marginTop: 8 }}>Generator</span>
        <div className={styles.segmented} role="group" aria-label="Track generator">
          {GENERATORS.map((kind) => (
            <button key={kind} type="button" className={styles.segment}
              onClick={() => onAnimChange(withTrackGenerator(anim, selection.index, kind, generatorParams))}>
              {kind}
            </button>
          ))}
        </div>
        <GeneratorParamControls params={generatorParams} onChange={setGeneratorParams} />
        <RailHint>{isGenerated ? "This track is animated by a generator. Adjust params then re-apply." : "This track holds a constant. Pick a generator to animate it."}</RailHint>
      </InspectorPanel>
    );
  }

  function defaultTargetFor(kind: AnimTarget["kind"]): AnimTarget {
    if (kind === "sceneLayer") return { kind, index: 0, channel: "emissive" };
    if (kind === "placement") return { kind, index: 0, channel: "y" };
    return { kind: "postfx", key: POSTFX_KEYS[0]! };
  }
}

function GeneratorParamControls({ params, onChange }: { params: GeneratorParams; onChange: (params: GeneratorParams) => void }) {
  const set = (patch: Partial<GeneratorParams>) => onChange({ ...params, ...patch });
  return (
    <>
      <RangeControl nested label="Period" min={2} max={600} value={params.period} display={`${params.period}t`} onChange={(period) => set({ period })} ariaLabel="Generator period" />
      <RangeControl nested label="Min" min={-200} max={400} value={Math.round(params.min * 100)} display={params.min.toFixed(2)} onChange={(v) => set({ min: v / 100 })} ariaLabel="Generator min" />
      <RangeControl nested label="Max" min={-200} max={400} value={Math.round(params.max * 100)} display={params.max.toFixed(2)} onChange={(v) => set({ max: v / 100 })} ariaLabel="Generator max" />
      <RangeControl nested label="Distance" min={-400} max={400} value={params.distance} display={`${params.distance}px`} onChange={(distance) => set({ distance })} ariaLabel="Generator drift distance" />
      <RangeControl nested label="Amplitude" min={0} max={200} value={params.amplitude} display={`${params.amplitude}px`} onChange={(amplitude) => set({ amplitude })} ariaLabel="Generator sway amplitude" />
    </>
  );
}

// ---- small presentational helpers --------------------------------------------

function ListButton({ active, glyph, label, onClick }: { active: boolean; glyph: string; label: string; onClick: () => void }) {
  return (
    <button type="button" className={`${styles.toolBtn} ${active ? styles.toolBtnActive : ""}`} onClick={onClick} aria-pressed={active}>
      <span className={styles.toolGlyph} aria-hidden>{glyph}</span>
      {label}
    </button>
  );
}
function AddButton({ label, onClick, disabled, title }: { label: string; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button type="button" className={styles.toolBtn} onClick={onClick} disabled={disabled} title={title}>
      <span className={styles.toolGlyph} aria-hidden>＋</span>
      {label}
    </button>
  );
}
function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className={styles.toolBtn} onClick={onClick} style={{ marginTop: 8 }}>
      <span className={styles.toolGlyph} aria-hidden>✕</span>
      {label}
    </button>
  );
}
function HudItem({ label, value }: { label: string; value: number }) {
  return (
    <span className={styles.hudItem}>
      <span className={styles.hudLabel}>{label}</span>
      <span className={`${styles.hudValue} data`}>{value}</span>
    </span>
  );
}

// ---- preview compositing ------------------------------------------------------

/** A structural view of the fields the preview overrides on a resolved layer. */


/** Apply one frame's scene-layer override to a resolved layer (mirrors the runtime). */
function applyLayerOverride(layer: ResolvedLayer, override: Partial<Record<string, number>> | undefined): ResolvedLayer {
  if (!override) return layer;
  return {
    ...layer,
    offsetX: (layer.offsetX ?? 0) + (override.offsetX ?? 0),
    offsetY: (layer.offsetY ?? 0) + (override.offsetY ?? 0),
    opacity: override.opacity ?? layer.opacity,
    emissive: override.emissive ?? layer.emissive,
  };
}

function fillDark(out: Uint8ClampedArray): void {
  for (let i = 0; i < out.length; i += 4) {
    out[i] = 14; out[i + 1] = 16; out[i + 2] = 28; out[i + 3] = 255;
  }
}

/** Nearest-neighbour, straight-alpha composite of one resolved placement (mirrors AnimatedForegroundSurface). */
function drawPlacement(
  out: Uint8ClampedArray,
  width: number,
  height: number,
  source: ReturnType<typeof createEditorRegionSource>,
  placement: { region: { page: 0 | 1; tile: number; tilesW: number; tilesH: number }; x: number; y: number; opacity: number; scale: number },
): void {
  const opacity = Math.max(0, Math.min(1, placement.opacity));
  if (opacity <= 0) return;
  const scale = placement.scale > 0 ? placement.scale : 1;
  const image = source.readRegion(placement.region.page, placement.region.tile, placement.region.tilesW, placement.region.tilesH);
  const destW = Math.max(1, Math.round(image.width * scale));
  const destH = Math.max(1, Math.round(image.height * scale));
  const ox = Math.round(placement.x);
  const oy = Math.round(placement.y);
  for (let dy = 0; dy < destH; dy += 1) {
    const y = oy + dy;
    if (y < 0 || y >= height) continue;
    const sy = Math.min(image.height - 1, Math.floor(dy / scale));
    for (let dx = 0; dx < destW; dx += 1) {
      const x = ox + dx;
      if (x < 0 || x >= width) continue;
      const sx = Math.min(image.width - 1, Math.floor(dx / scale));
      const si = (sy * image.width + sx) * 4;
      const alpha = ((image.pixels[si + 3] ?? 0) / 255) * opacity;
      if (alpha <= 0) continue;
      const di = (y * width + x) * 4;
      out[di] = lerp(out[di]!, image.pixels[si] ?? 0, alpha);
      out[di + 1] = lerp(out[di + 1]!, image.pixels[si + 1] ?? 0, alpha);
      out[di + 2] = lerp(out[di + 2]!, image.pixels[si + 2] ?? 0, alpha);
      out[di + 3] = 255;
    }
  }
}
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
