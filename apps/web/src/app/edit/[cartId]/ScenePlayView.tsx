"use client";

/**
 * Play in the editor (ENGINE_PARITY_ROADMAP.md EP5): the cart runs inside the
 * Mesh tab's view while the hierarchy and inspector stay usable beside it.
 *
 * - Pause, resume and step a frame.
 * - Eject: look at the running game through a free camera (the scene view's
 *   orbit / pan / dolly / right-drag-and-WASD fly), and return to the game's.
 * - Edits made while it plays — placements, meshes and materials, lighting —
 *   are pushed into the running scene at once (`updateMeshScene`); a change to
 *   the scene's structure (objects added or removed) shows on the next run.
 *
 * Stopping is the Mesh tab's business: it reverts what was edited during play
 * unless the creator chose to keep it.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { mount, parseMeshScene, type AnimSpec, type CollisionField, type FlagsField, type MeshScene, type ModelId, type ParticleSpec, type PlayerHandle, type PostFxSettings, type SceneSpec, type WorldScene } from "@cartbox/player";
import type { InputAction, UiDocument } from "@cartbox/editor";
import { browserStorage, readLocalSave, writeLocalSave } from "@/lib/saveData";

import { loadKtx2Decoder } from "@/lib/ktx2Decoder";
import { encodeMeshSidecar, type MeshSidecar } from "@/lib/meshSidecar";
import { rapierPhysics } from "@/lib/physicsRapier";
import { editorOrbit } from "@/lib/playCamera";
import { VIEWPORT_FOV, cameraLookingAt, dolly, fly, look, orbit, pan, unitsPerPixel, type ViewportCamera } from "@/lib/viewportCamera";
import styles from "./editor.module.css";

/** Everything a playtest needs besides the mesh scene, as the workbench builds it for its Run overlay. */
export interface PlaytestConfig {
  readonly bytes: Uint8Array;
  readonly engineUrl: string;
  readonly modelId: ModelId;
  readonly postFx?: PostFxSettings;
  readonly scene?: SceneSpec;
  readonly anim?: AnimSpec;
  readonly particles?: ParticleSpec;
  readonly collision?: CollisionField;
  readonly flags?: FlagsField;
  readonly world?: WorldScene;
  /** The 3D scene as the run starts. */
  readonly mesh: MeshScene | null;
  /** The cart's UI documents (EP13). */
  readonly ui?: readonly UiDocument[];
  readonly actions?: readonly InputAction[];
  /** Where the playtest keeps the cart's save data (EP15b) in this browser; absent = saves off. */
  readonly saveKey?: string;
}

const ORBIT_SPEED = 0.008;
const LOOK_SPEED = 0.005;

export function ScenePlayView({
  config,
  sidecar,
  keep,
  onKeepChange,
  onStop,
}: {
  config: PlaytestConfig;
  /** The scene as edited now: pushed into the running game whenever it changes. */
  sidecar: MeshSidecar;
  keep: boolean;
  onKeepChange: (keep: boolean) => void;
  onStop: () => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<PlayerHandle | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(true);
  const [ejected, setEjected] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const center = config.mesh?.bounds.center ?? [0, 0, 0];
  const radius = config.mesh?.bounds.radius ?? 5;
  const camera = useRef<ViewportCamera>(cameraLookingAt(center, 0.6, 0.45, radius / Math.sin(VIEWPORT_FOV / 2) + radius));

  // Mount once per run; edits reach it through updateMeshScene, not a remount.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const url = URL.createObjectURL(new Blob([config.bytes.buffer as ArrayBuffer], { type: "application/octet-stream" }));
    const handle = mount(stage, {
      cartUrl: url,
      engineUrl: config.engineUrl,
      modelId: config.modelId,
      autostart: true,
      record: false,
      controls: "auto",
      scale: "fit",
      lighting: { autoDetect: true },
      postFx: config.postFx,
      scene: config.scene,
      anim: config.anim,
      particles: config.particles,
      collision: config.collision,
      flags: config.flags,
      mesh: config.mesh ?? undefined,
      ...(config.ui && config.ui.length > 0 ? { ui: config.ui } : {}),
      ...(config.actions && config.actions.length > 0 ? { actions: config.actions } : {}),
      ...(config.saveKey
        ? {
            saveData: readLocalSave(browserStorage(), config.saveKey)?.data ?? null,
            onSave: (data: string | null) => writeLocalSave(browserStorage(), config.saveKey!, data, new Date().toISOString()),
          }
        : {}),
      physics: rapierPhysics(),
      ktx2: loadKtx2Decoder,
      world: config.world,
      onReady: () => setStatus("ready"),
      onError: (e) => {
        setStatus("error");
        setError(e.message);
      },
    });
    handleRef.current = handle;
    return () => {
      handle.destroy();
      handleRef.current = null;
      URL.revokeObjectURL(url);
    };
  }, [config]);

  // Push edits into the running scene (a short pause first, so a drag sends a few, not hundreds).
  const firstSidecar = useRef(sidecar);
  useEffect(() => {
    if (sidecar === firstSidecar.current) return;
    const timer = setTimeout(() => {
      const scene = parseMeshScene(encodeMeshSidecar(sidecar));
      const handle = handleRef.current;
      if (!scene || !handle) return;
      void handle.updateMeshScene(scene).then((applied) => setNotice(applied ? null : "Objects were added or removed: that shows when you play again."));
    }, 120);
    return () => clearTimeout(timer);
  }, [sidecar]);

  const send = useCallback(() => {
    handleRef.current?.setEditorCamera(editorOrbit(camera.current, center));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center[0], center[1], center[2]]);
  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
    if (ejected) send();
    else handle.setEditorCamera(null);
  }, [ejected, send]);

  const togglePause = () => {
    const handle = handleRef.current;
    if (!handle) return;
    if (handle.running) handle.pause();
    else handle.resume();
    setRunning(handle.running);
  };

  // --- The ejected camera's controls (over the running game) -------------------
  const drag = useRef<{ kind: "orbit" | "pan" | "look"; x: number; y: number } | null>(null);
  const keys = useRef(new Set<string>());
  useEffect(() => {
    if (!ejected) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const k = keys.current;
      if (drag.current?.kind !== "look" || k.size === 0) return;
      const speed = Math.max(0.5, radius) * (k.has("shift") ? 3 : 1) * dt;
      const forward = (k.has("w") ? 1 : 0) - (k.has("s") ? 1 : 0);
      const right = (k.has("d") ? 1 : 0) - (k.has("a") ? 1 : 0);
      const up = (k.has("e") ? 1 : 0) - (k.has("q") ? 1 : 0);
      if (forward || right || up) {
        camera.current = fly(camera.current, { forward: forward * speed, right: right * speed, up: up * speed });
        send();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ejected, radius, send]);

  return (
    <section className={styles.mapStage} style={{ flex: "1 1 auto" }} aria-label="Playing in the editor">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "center" }}>
        <button type="button" className={styles.toolBtn} onClick={onStop} title="Stop and go back to editing">
          ■ Stop
        </button>
        <button type="button" className={styles.toolBtn} onClick={togglePause} disabled={status !== "ready"}>
          {running ? "❚❚ Pause" : "▶ Resume"}
        </button>
        <button type="button" className={styles.toolBtn} onClick={() => handleRef.current?.stepFrame()} disabled={status !== "ready" || running} title="Run one frame (while paused)">
          Step
        </button>
        <button type="button" className={styles.toolBtn} aria-pressed={ejected} onClick={() => setEjected((v) => !v)} disabled={status !== "ready" || !config.mesh} title="Look around with a free camera while the game plays">
          {ejected ? "↩ Back to the game's camera" : "⤢ Eject"}
        </button>
        <label style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12 }} title="Keep what you change while playing when you stop (otherwise it's undone)">
          <input type="checkbox" checked={keep} onChange={(e) => onKeepChange(e.target.checked)} />
          Keep changes
        </label>
        <span style={{ fontSize: 12, opacity: 0.7 }}>{status === "loading" ? "starting…" : status === "error" ? "error" : running ? "playing" : "paused"}</span>
      </div>
      {notice && <div style={{ fontSize: 12, color: "#ffd84a", textAlign: "center" }}>{notice}</div>}
      {error && <div style={{ fontSize: 12, color: "#ff7a7a", textAlign: "center" }}>{error}</div>}
      <div style={{ position: "relative", flex: "1 1 auto", minHeight: 420, borderRadius: 8, overflow: "hidden", background: "#000", outline: "2px solid rgba(90, 255, 122, 0.45)" }}>
        <div ref={stageRef} style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }} />
        {ejected && (
          <div
            role="img"
            aria-label="Free camera over the running game — drag to orbit, middle- or Shift-drag to pan, right-drag with WASD to fly, wheel to dolly"
            tabIndex={0}
            style={{ position: "absolute", inset: 0, cursor: "grab", touchAction: "none", outline: "none" }}
            onContextMenu={(e) => e.preventDefault()}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              e.currentTarget.focus();
              drag.current = { kind: e.button === 2 ? "look" : e.button === 1 || e.shiftKey ? "pan" : "orbit", x: e.clientX, y: e.clientY };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              const dx = e.clientX - d.x;
              const dy = e.clientY - d.y;
              d.x = e.clientX;
              d.y = e.clientY;
              const cam = camera.current;
              if (d.kind === "orbit") camera.current = orbit(cam, -dx * ORBIT_SPEED, dy * ORBIT_SPEED);
              else if (d.kind === "look") camera.current = look(cam, -dx * LOOK_SPEED, dy * LOOK_SPEED);
              else {
                const k = unitsPerPixel(cam, cam.distance, e.currentTarget.getBoundingClientRect().height);
                camera.current = pan(cam, -dx * k, dy * k);
              }
              send();
            }}
            onPointerUp={() => {
              drag.current = null;
              keys.current.clear();
            }}
            onWheel={(e) => {
              camera.current = dolly(camera.current, e.deltaY < 0 ? 0.88 : 1 / 0.88);
              send();
            }}
            onKeyDown={(e) => {
              const key = e.key.toLowerCase();
              if (["w", "a", "s", "d", "q", "e", "shift"].includes(key)) {
                keys.current.add(key);
                e.preventDefault();
              }
            }}
            onKeyUp={(e) => keys.current.delete(e.key.toLowerCase())}
          />
        )}
      </div>
    </section>
  );
}
