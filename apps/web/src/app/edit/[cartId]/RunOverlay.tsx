"use client";

/**
 * Playtest overlay: runs the current cart live using @cartbox/player. The editor
 * hands us the serialised .tic bytes; we wrap them in a blob: URL (the player
 * fetches cartUrl, and fetch supports blob:) so the exact in-memory cartridge
 * runs with no round-trip through storage. Stop tears the player down and
 * returns to editing.
 */

import { useEffect, useRef, useState } from "react";
import { mount, type InspectedObject, type AnimSpec, type CollisionField, type FlagsField, type MeshScene, type ModelId, type ParticleSpec, type PlayerHandle, type PostFxSettings, type SceneSpec, type WorldScene } from "@cartbox/player";

import styles from "./editor.module.css";
import { errorLineFrom } from "./codeTools";
import { rapierPhysics } from "@/lib/physicsRapier";

interface RunOverlayProps {
  bytes: Uint8Array;
  engineUrl: string;
  /**
   * The cart's console model.
   *
   * Not optional, and not derivable from `engineUrl`. The player reads its
   * frame geometry, palette size and render caps from the model, and defaults
   * to Classic when given none — so omitting this loaded the right *core* and
   * then read its output at 240x136 with Classic's caps. A Pro, Portrait or PS1
   * cart playtested that way is garbled: the frame is sampled at the wrong
   * stride, and the era caps that make a model look like itself never apply.
   */
  modelId: ModelId;
  cartName: string;
  /** The cart's post-processing stack, applied live during the playtest. */
  postFx?: PostFxSettings;
  /** The cart's parallax-scene backdrop, composited live during the playtest. */
  scene?: SceneSpec;
  /** The cart's animation timeline, played live during the playtest. */
  anim?: AnimSpec;
  /** The cart's weather system, composited live during the playtest. */
  particles?: ParticleSpec;
  /** The cart's collision layer, exposed to its Lua via cartbox.solid during the playtest. */
  collision?: CollisionField;
  /** The cart's tile-flags layer, exposed to its Lua via cartbox.flag during the playtest. */
  flags?: FlagsField;
  /** The cart's 3D mesh scene, rasterised over each frame during the playtest. */
  mesh?: MeshScene;
  /** The cart's HD-2D world (3D terrain + 2D character billboards), during the playtest. */
  world?: WorldScene;
  /**
   * Open the Code tab on a line. A runtime error names one, and the shortest
   * path from "it crashed" to "here is why" is a click — previously the message
   * was shown and the creator had to find the line themselves.
   */
  onGoToLine?: (line: number) => void;
  onClose: () => void;
}

export function RunOverlay({ bytes, engineUrl, modelId, cartName, postFx, scene, anim, particles, collision, flags, mesh, world, onGoToLine, onClose }: RunOverlayProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<PlayerHandle | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [running, setRunning] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // The most recent Lua runtime error the cart raised. Unlike errorMessage (a
  // fatal load failure) the cart keeps running, so this is a dismissible report.
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [fps, setFps] = useState<number | null>(null);
  // The line the error blames, when it names one. Parsed rather than shown raw
  // so the "go to line" button only appears where it can actually go somewhere.
  const errorLine = runtimeError === null ? null : errorLineFrom(runtimeError);
  // Frames the cart has presented since the last FPS sample. A ref, not state, so
  // the 60Hz onFrame handler never triggers a React render — the interval below
  // reads and resets it once a second.
  const frameCountRef = useRef(0);
  // Live inspection: the scene objects as they are this moment, refreshed a few
  // times a second while the panel is open.
  const [inspecting, setInspecting] = useState(false);
  const [objects, setObjects] = useState<InspectedObject[]>([]);
  const [filter, setFilter] = useState("");

  // The sidecars the player is actually applying this playtest, so a creator can
  // confirm at a glance what is (and isn't) in effect.
  const activeLayers = [
    postFx ? "FX" : null,
    scene ? "Scene" : null,
    anim ? "Anim" : null,
    particles ? "Weather" : null,
    collision ? "Collision" : null,
    flags ? "Flags" : null,
    mesh ? "Mesh" : null,
    world ? "World" : null,
  ].filter((name): name is string => name !== null);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    // A fresh run clears any error from the previous cart bytes.
    setRuntimeError(null);

    // saveTic() returns an exact-length buffer, so its ArrayBuffer is the cart
    // bytes verbatim. The cast sidesteps the DOM lib's SharedArrayBuffer union.
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const handle = mount(stage, {
      cartUrl: url,
      engineUrl,
      // Playtest at the cart's own geometry and caps, not Classic's.
      modelId,
      autostart: true,
      record: false,
      controls: "auto",
      scale: "fit",
      // Let creators playtest lit carts: autoDetect only lights carts that call
      // cartbox.light(), so unlit carts preview unchanged.
      lighting: { autoDetect: true },
      // Playtest with the cart's authored FX stack, exactly as players see it.
      postFx,
      // Playtest with the cart's parallax backdrop behind its live frame.
      scene,
      anim,
      particles,
      // Playtest with the cart's collision + flags layers available to its own Lua.
      collision,
      flags,
      // Playtest the cart's imported 3D meshes, rasterised over each frame, with
      // their physics bodies simulated (Rapier loads only when there are bodies).
      mesh,
      physics: rapierPhysics(),
      // Playtest the cart's HD-2D world: 3D terrain with the cart's 2D character
      // sprites standing in it as depth-composited billboards.
      world,
      onReady: () => setStatus("ready"),
      // Surface the real load-error message instead of a generic failure line.
      // (A runtime Lua error renders on the cart's own screen — the core does not
      // report it to the host.)
      onError: (error) => {
        setStatus("error");
        setErrorMessage(error.message);
      },
      onFrame: () => {
        frameCountRef.current += 1;
      },
      // A Lua runtime error mid-frame: the cart keeps running, so show it as a
      // dismissible banner rather than tearing the playtest down.
      onRuntimeError: (message) => setRuntimeError(message),
    });
    handleRef.current = handle;

    return () => {
      handle.destroy();
      URL.revokeObjectURL(url);
    };
  }, [bytes, engineUrl, modelId, postFx, scene, anim, particles, collision, flags, mesh, world]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Sample the cart's true frame rate once a second from the onFrame tally.
  useEffect(() => {
    const timer = window.setInterval(() => {
      setFps(frameCountRef.current);
      frameCountRef.current = 0;
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!inspecting) return;
    const read = () => setObjects(handleRef.current?.inspect() ?? []);
    read();
    const timer = window.setInterval(read, 250);
    return () => window.clearInterval(timer);
  }, [inspecting]);

  const togglePlayback = () => {
    const handle = handleRef.current;
    if (!handle) return;
    if (handle.running) {
      handle.pause();
      setRunning(false);
    } else {
      handle.resume();
      setRunning(true);
    }
  };

  return (
    <div className={styles.runOverlay} role="dialog" aria-modal="true" aria-label={`Playtest ${cartName}`}>
      <div className={styles.runCard}>
        <div className={styles.runBar}>
          <span className={styles.runDot} aria-hidden />
          <span className={styles.runTitle}>Playtest · {cartName}</span>
          <div className={styles.runBarActions}>
            {mesh && (
              <button type="button" className="cbx-btn" aria-pressed={inspecting} onClick={() => setInspecting((v) => !v)} disabled={status !== "ready"}>
                {inspecting ? "Hide objects" : "Objects"}
              </button>
            )}
            <button type="button" className="cbx-btn" onClick={togglePlayback} disabled={status !== "ready"}>
              {running ? "Pause" : "Resume"}
            </button>
            <button type="button" className="cbx-btn cbx-btn-accent" onClick={onClose}>
              Stop
            </button>
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "stretch", minHeight: 0 }}>
          <div ref={stageRef} className={styles.runStage} style={{ flex: 1, minWidth: 0 }} />
          {inspecting && <ObjectsPanel objects={objects} filter={filter} onFilter={setFilter} />}
        </div>

        <div className={styles.runDebug}>
          <span className={styles.runDebugItem}>
            <span className={styles.runDebugLabel}>Status</span>
            <span className={`${styles.runDebugValue} data`}>
              {status === "loading" ? "building…" : status === "error" ? "error" : running ? "running" : "paused"}
            </span>
          </span>
          <span className={styles.runDebugItem}>
            <span className={styles.runDebugLabel}>FPS</span>
            <span className={`${styles.runDebugValue} data`}>{status === "ready" && fps !== null ? fps : "—"}</span>
          </span>
          <span className={styles.runDebugItem}>
            <span className={styles.runDebugLabel}>Layers</span>
            <span className={styles.runDebugValue}>
              {activeLayers.length > 0 ? activeLayers.join(" · ") : "none"}
            </span>
          </span>
        </div>

        {status === "error" && (
          <p className={styles.runError}>
            {errorMessage
              ? `Failed to load: ${errorMessage}`
              : "This cartridge failed to run. A code error shows on the cart screen above."}
          </p>
        )}

        {runtimeError && status !== "error" && (
          <p className={styles.runError} role="alert">
            Lua error: {runtimeError}{" "}
            {errorLine !== null && onGoToLine && (
              <button
                type="button"
                className={styles.rendererToggle}
                onClick={() => onGoToLine(errorLine)}
                style={{ marginLeft: 8 }}
              >
                Go to line {errorLine}
              </button>
            )}
            <button
              type="button"
              className={styles.rendererToggle}
              onClick={() => setRuntimeError(null)}
              style={{ marginLeft: 8 }}
            >
              Dismiss
            </button>
          </p>
        )}

        <p className={styles.runHint}>
          <span className="data">← ↑ ↓ →</span> move · <span className="data">Z</span> /{" "}
          <span className="data">X</span> action · <span className="data">Esc</span> to stop · on a touchscreen, the
          left stick moves (A/B/X/Y = Z/X/A/S; a right stick appears for carts that read cartbox.stick)
        </p>
      </div>
    </div>
  );
}

const fmt = (v: number) => (Math.abs(v) < 0.005 ? "0" : v.toFixed(2));

/**
 * Live inspection: every scene object's position and state while the cart runs
 * (refreshed ~4×/s). Pause to read values at a moment.
 */
function ObjectsPanel({ objects, filter, onFilter }: { objects: InspectedObject[]; filter: string; onFilter: (value: string) => void }) {
  const needle = filter.trim().toLowerCase();
  const shown = objects.filter(
    (o) => !needle || o.name.toLowerCase().includes(needle) || o.tags.some((t) => t.toLowerCase().includes(needle)),
  );
  return (
    <aside aria-label="Live objects" style={{ width: 300, maxHeight: 460, overflowY: "auto", fontSize: 12, display: "grid", gap: 6, alignContent: "start" }}>
      <input
        aria-label="Filter objects"
        placeholder="Filter by name or tag"
        value={filter}
        onChange={(event) => onFilter(event.target.value)}
        style={{ padding: "4px 6px", borderRadius: 6 }}
      />
      {shown.map((o) => (
        <div key={o.index} data-object={o.name} style={{ padding: "4px 6px", borderRadius: 6, background: "rgba(255,255,255,0.04)", opacity: o.visible ? 1 : 0.55 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
            <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.name}</strong>
            <span className="data" style={{ opacity: 0.7 }}>
              #{o.index}
            </span>
          </div>
          <div className="data">
            {fmt(o.position[0])}, {fmt(o.position[1])}, {fmt(o.position[2])}
          </div>
          <div style={{ opacity: 0.75 }}>
            {[
              o.prefab ? (o.prefab.spawned ? `spawned ${o.prefab.name}` : `${o.prefab.name} reserve`) : null,
              o.visible ? null : "hidden",
              o.body
                ? `${o.body.kind}${o.body.active ? "" : " (off)"} · v ${fmt(o.body.velocity[0])}, ${fmt(o.body.velocity[1])}, ${fmt(o.body.velocity[2])}${o.body.kind === "character" ? (o.body.grounded ? " · grounded" : " · airborne") : ""}`
                : null,
              o.animation ? (o.animation.clip ? `▶ ${o.animation.clip} ${fmt(o.animation.time)}s` : "rest pose") : null,
              o.tags.length > 0 ? o.tags.map((t) => `#${t}`).join(" ") : null,
              Object.keys(o.props).length > 0
                ? Object.entries(o.props)
                    .map(([k, v]) => `${k}=${String(v)}`)
                    .join(" ")
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
      ))}
      {shown.length === 0 && <span style={{ opacity: 0.7 }}>No objects match.</span>}
    </aside>
  );
}
