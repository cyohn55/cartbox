"use client";

/**
 * Playtest overlay: runs the current cart live using @cartbox/player. The editor
 * hands us the serialised .tic bytes; we wrap them in a blob: URL (the player
 * fetches cartUrl, and fetch supports blob:) so the exact in-memory cartridge
 * runs with no round-trip through storage. Stop tears the player down and
 * returns to editing.
 */

import { useEffect, useRef, useState } from "react";
import { mount, type AnimSpec, type CollisionField, type FlagsField, type MeshScene, type ParticleSpec, type PlayerHandle, type PostFxSettings, type SceneSpec, type WorldScene } from "@cartbox/player";

import styles from "./editor.module.css";

interface RunOverlayProps {
  bytes: Uint8Array;
  engineUrl: string;
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
  onClose: () => void;
}

export function RunOverlay({ bytes, engineUrl, cartName, postFx, scene, anim, particles, collision, flags, mesh, world, onClose }: RunOverlayProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<PlayerHandle | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [running, setRunning] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fps, setFps] = useState<number | null>(null);
  // Frames the cart has presented since the last FPS sample. A ref, not state, so
  // the 60Hz onFrame handler never triggers a React render — the interval below
  // reads and resets it once a second.
  const frameCountRef = useRef(0);

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

    // saveTic() returns an exact-length buffer, so its ArrayBuffer is the cart
    // bytes verbatim. The cast sidesteps the DOM lib's SharedArrayBuffer union.
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const handle = mount(stage, {
      cartUrl: url,
      engineUrl,
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
      // Playtest the cart's imported 3D meshes, rasterised over each frame.
      mesh,
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
    });
    handleRef.current = handle;

    return () => {
      handle.destroy();
      URL.revokeObjectURL(url);
    };
  }, [bytes, engineUrl, postFx, scene, anim, particles, collision, flags, mesh, world]);

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
            <button type="button" className="cbx-btn" onClick={togglePlayback} disabled={status !== "ready"}>
              {running ? "Pause" : "Resume"}
            </button>
            <button type="button" className="cbx-btn cbx-btn-accent" onClick={onClose}>
              Stop
            </button>
          </div>
        </div>

        <div ref={stageRef} className={styles.runStage} />

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

        <p className={styles.runHint}>
          <span className="data">← ↑ ↓ →</span> move · <span className="data">Z</span> /{" "}
          <span className="data">X</span> action · <span className="data">Esc</span> to stop
        </p>
      </div>
    </div>
  );
}
