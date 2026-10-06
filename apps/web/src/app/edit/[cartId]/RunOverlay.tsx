"use client";

/**
 * Playtest overlay: runs the current cart live using @cartbox/player. The editor
 * hands us the serialised .tic bytes; we wrap them in a blob: URL (the player
 * fetches cartUrl, and fetch supports blob:) so the exact in-memory cartridge
 * runs with no round-trip through storage. Stop tears the player down and
 * returns to editing.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { frameDurationMs, getModel, mount, readCartCode, type DebugStep, type InspectedObject, type PauseInfo, type ProfileSnapshot, type AnimSpec, type CollisionField, type FlagsField, type MeshScene, type ModelId, type ParticleSpec, type PlayerHandle, type PostFxSettings, type QualityChoice, type SceneSpec, type WorldScene } from "@cartbox/player";
import { COLOR_FILTERS, COLOR_FILTER_LABELS, languageName, type ColorFilter, type InputAction, type StringTable, type UiDocument } from "@cartbox/editor";
import { preferredLanguages, readPlayerPrefs } from "@/lib/accessibilityPrefs";
import { browserStorage, readLocalSave, writeLocalSave } from "@/lib/saveData";

import styles from "./editor.module.css";
import { errorLineFrom } from "./codeTools";
import { appendConsole, traceColor, type ConsoleEntry } from "./consoleLog";
import { ProfilerPanel } from "./ProfilerPanel";
import { DebuggerPanel } from "./DebuggerPanel";
import { toggleBreakpoint } from "./debuggerView";
import { loadKtx2Decoder } from "@/lib/ktx2Decoder";
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
  /** The cart's UI documents (EP13), driven by its Lua through cartbox.ui. */
  ui?: readonly UiDocument[];
  /** The cart's input actions (EP15), read by its Lua through cartbox.action. */
  actions?: readonly InputAction[];
  /** Where the playtest keeps the cart's save data (EP15b) in this browser, apart from players' saves; absent = saves off. */
  saveKey?: string;
  /** The cart's string table (EP19b): the playtest can run in each of its languages. */
  strings?: StringTable | null;
  /** The cart's HD-2D world (3D terrain + 2D character billboards), during the playtest. */
  world?: WorldScene;
  /**
   * Open the Code tab on a line. A runtime error names one, and the shortest
   * path from "it crashed" to "here is why" is a click — previously the message
   * was shown and the creator had to find the line themselves.
   */
  onGoToLine?: (line: number) => void;
  /** The debugger's breakpoints (cart lines) and watch expressions, owned by the editor. */
  breakpoints?: readonly number[];
  onBreakpointsChange?: (lines: number[]) => void;
  watches?: readonly string[];
  onWatchesChange?: (watches: string[]) => void;
  onClose: () => void;
}

const NO_LINES: readonly number[] = [];
const NO_WATCHES: readonly string[] = [];

export function RunOverlay({
  bytes,
  engineUrl,
  modelId,
  cartName,
  postFx,
  scene,
  anim,
  particles,
  collision,
  flags,
  mesh,
  ui,
  actions,
  saveKey,
  strings,
  world,
  onGoToLine,
  breakpoints = NO_LINES,
  onBreakpointsChange,
  watches = NO_WATCHES,
  onWatchesChange,
  onClose,
}: RunOverlayProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<PlayerHandle | null>(null);
  const [quality, setQuality] = useState<QualityChoice>("auto");
  // Localisation and accessibility (EP19b): the playtest's language (switching restarts it) and a colour preview.
  const [language, setLanguage] = useState<string | null>(null);
  const [colorPreview, setColorPreview] = useState<{ filter: ColorFilter; kind: "correct" | "simulate" }>({ filter: "none", kind: "simulate" });
  const colorPreviewRef = useRef(colorPreview);
  colorPreviewRef.current = colorPreview;
  // Read at mount so a remount (the cart's data changed) keeps the chosen preset.
  const qualityRef = useRef<QualityChoice>("auto");
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
  // The profiler: on while its panel is open (it costs a few clock reads per frame).
  const [profiling, setProfiling] = useState(false);
  const profilingRef = useRef(false);
  const [profile, setProfile] = useState<ProfileSnapshot | null>(null);
  // The debugger: on from the start when there are breakpoints (it costs a
  // call per statement, so otherwise it's switched on by hand, which restarts).
  const [debugOn, setDebugOn] = useState(() => breakpoints.length > 0);
  // Save data (EP15b): whether the playtest holds a save, and a bump to restart without it.
  const [hasSave, setHasSave] = useState(() => (saveKey ? readLocalSave(browserStorage(), saveKey) !== null : false));
  const [restarts, setRestarts] = useState(0);
  const [pause, setPause] = useState<PauseInfo | null>(null);
  const breakpointsRef = useRef(breakpoints);
  breakpointsRef.current = breakpoints;
  const watchesRef = useRef(watches);
  watchesRef.current = watches;
  const code = useMemo(() => readCartCode(bytes) ?? "", [bytes]);
  // Speed (1 is normal), read at mount like the quality preset.
  const [speed, setSpeed] = useState(1);
  const speedRef = useRef(1);
  const [frame, setFrame] = useState(0);
  // The console: traces and errors land in a ref at frame rate and are shown a
  // few times a second, so a cart tracing every frame doesn't render React at 60Hz.
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [log, setLog] = useState<ConsoleEntry[]>([]);
  const logRef = useRef<ConsoleEntry[]>([]);
  const logDirtyRef = useRef(false);

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
    logRef.current = [];
    setLog([]);
    const record = (kind: ConsoleEntry["kind"], text: string, frame: number, color?: number) => {
      logRef.current = appendConsole(logRef.current, kind, text, frame, color);
      logDirtyRef.current = true;
    };

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
      ...(ui && ui.length > 0 ? { ui } : {}),
      ...(actions && actions.length > 0 ? { actions } : {}),
      strings: strings ?? null,
      languages: language ? [language] : preferredLanguages(readPlayerPrefs(browserStorage())),
      accessibility: readPlayerPrefs(browserStorage()),
      ...(saveKey
        ? {
            saveData: readLocalSave(browserStorage(), saveKey)?.data ?? null,
            onSave: (data: string | null) => {
              writeLocalSave(browserStorage(), saveKey, data, new Date().toISOString());
              setHasSave(data !== null);
            },
          }
        : {}),
      physics: rapierPhysics(),
      // KTX2 textures: the transcoder is fetched only if the scene has one.
      ktx2: loadKtx2Decoder,
      // Playtest the cart's HD-2D world: 3D terrain with the cart's 2D character
      // sprites standing in it as depth-composited billboards.
      world,
      quality: qualityRef.current,
      onReady: () => {
        setStatus("ready");
        const preview = colorPreviewRef.current;
        if (preview.filter !== "none") handleRef.current?.setColorFilter(preview.filter, preview.kind);
      },
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
      onRuntimeError: (message) => {
        setRuntimeError(message);
        record("error", message, handleRef.current?.frame() ?? 0);
      },
      // The console: the cart's trace() output.
      onTrace: (text, color, at) => record("trace", text, at, color),
      debug: debugOn
        ? {
            breakpoints: breakpointsRef.current,
            watches: watchesRef.current,
            onPause: (p) => {
              setPause(p);
              if (p) setRunning(false);
            },
          }
        : undefined,
    });
    handleRef.current = handle;
    handle.setTimeScale(speedRef.current);
    handle.setProfiling(profilingRef.current);

    return () => {
      handle.destroy();
      URL.revokeObjectURL(url);
    };
  }, [bytes, engineUrl, modelId, postFx, scene, anim, particles, collision, flags, mesh, ui, actions, saveKey, strings, language, restarts, world, debugOn]);

  // Breakpoints and watches edited during the run reach the player at once.
  useEffect(() => {
    handleRef.current?.setBreakpoints(breakpoints);
  }, [breakpoints]);
  useEffect(() => {
    handleRef.current?.setWatches(watches);
  }, [watches]);

  /** Carry on from a breakpoint. */
  const debugStep = (step: DebugStep) => {
    const handle = handleRef.current;
    if (!handle?.debugPaused()) return;
    handle.debugContinue(step);
    setRunning(true);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      // Debugger keys, as in most IDEs: F8 continue, F10 over, F11 into, Shift+F11 out.
      const steps: Record<string, DebugStep> = { F8: "continue", F10: "over", F11: event.shiftKey ? "out" : "into" };
      const step = steps[event.key];
      if (step && handleRef.current?.debugPaused()) {
        event.preventDefault();
        handleRef.current.debugContinue(step);
        setRunning(true);
      }
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

  // Show new console lines and the frame counter a few times a second.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (logDirtyRef.current) {
        logDirtyRef.current = false;
        setLog(logRef.current);
      }
      setFrame(handleRef.current?.frame() ?? 0);
    }, 200);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    profilingRef.current = profiling;
    handleRef.current?.setProfiling(profiling);
    if (!profiling) {
      setProfile(null);
      return;
    }
    const read = () => setProfile(handleRef.current?.profile() ?? null);
    const timer = window.setInterval(read, 500);
    return () => window.clearInterval(timer);
  }, [profiling]);

  /** While paused: run one frame and show what it did. */
  const stepFrame = () => {
    const handle = handleRef.current;
    if (!handle || handle.running) return;
    handle.stepFrame();
    setFrame(handle.frame());
    if (logDirtyRef.current) {
      logDirtyRef.current = false;
      setLog(logRef.current);
    }
  };

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
              <select
                aria-label="Graphics quality"
                title="Graphics quality — try Low to see the cart as a weak phone would"
                value={quality}
                disabled={status !== "ready"}
                onChange={(e) => {
                  const next = e.target.value as QualityChoice;
                  setQuality(next);
                  qualityRef.current = next;
                  handleRef.current?.setQuality(next);
                }}
                style={{ font: "inherit", padding: "4px 8px", borderRadius: 6 }}
              >
                <option value="auto">Quality: auto{status === "ready" && handleRef.current ? ` (${handleRef.current.quality()})` : ""}</option>
                <option value="low">Quality: low</option>
                <option value="medium">Quality: medium</option>
                <option value="high">Quality: high</option>
              </select>
            )}
            {mesh && (
              <button type="button" className="cbx-btn" aria-pressed={inspecting} onClick={() => setInspecting((v) => !v)} disabled={status !== "ready"}>
                {inspecting ? "Hide objects" : "Objects"}
              </button>
            )}
            {strings && strings.languages.length > 1 && (
              <select
                aria-label="Language"
                title="Play in another of the cart's languages (restarts the playtest)"
                value={language ?? ""}
                onChange={(e) => setLanguage(e.target.value || null)}
                style={{ font: "inherit", padding: "4px 8px", borderRadius: 6 }}
              >
                <option value="">Language: player&apos;s</option>
                {strings.languages.map((l) => (
                  <option key={l} value={l}>
                    {languageName(l)} ({l})
                  </option>
                ))}
              </select>
            )}
            <select
              aria-label="Colour preview"
              title="See the cart as a colour-blind player does, or with a player's correction filter"
              value={`${colorPreview.kind}:${colorPreview.filter}`}
              disabled={status !== "ready"}
              onChange={(e) => {
                const [kind, filter] = e.target.value.split(":") as ["correct" | "simulate", ColorFilter];
                setColorPreview({ filter, kind });
                handleRef.current?.setColorFilter(filter, kind);
              }}
              style={{ font: "inherit", padding: "4px 8px", borderRadius: 6 }}
            >
              <option value="simulate:none">Colours: normal</option>
              {COLOR_FILTERS.filter((f) => f !== "none" && f !== "high-contrast").map((f) => (
                <option key={`s${f}`} value={`simulate:${f}`}>
                  As seen with {f}
                </option>
              ))}
              {COLOR_FILTERS.filter((f) => f !== "none").map((f) => (
                <option key={`c${f}`} value={`correct:${f}`}>
                  Player filter: {COLOR_FILTER_LABELS[f]}
                </option>
              ))}
            </select>
            <select
              aria-label="Speed"
              title="Game speed — slow it down to watch a bug happen (sound is muted away from 1×)"
              value={speed}
              disabled={status !== "ready"}
              onChange={(e) => {
                const next = Number(e.target.value);
                setSpeed(next);
                speedRef.current = next;
                handleRef.current?.setTimeScale(next);
              }}
              style={{ font: "inherit", padding: "4px 8px", borderRadius: 6 }}
            >
              <option value={0.25}>0.25×</option>
              <option value={0.5}>0.5×</option>
              <option value={1}>1×</option>
              <option value={2}>2×</option>
            </select>
            <button type="button" className="cbx-btn" onClick={togglePlayback} disabled={status !== "ready" || pause !== null}>
              {running ? "Pause" : "Resume"}
            </button>
            <button type="button" className="cbx-btn" onClick={stepFrame} disabled={status !== "ready" || running || pause !== null} title="Run one frame (while paused)">
              Step
            </button>
            <button
              type="button"
              className="cbx-btn"
              aria-pressed={debugOn}
              onClick={() => {
                setPause(null);
                setRunning(true);
                setDebugOn((v) => !v);
              }}
              title={debugOn ? "Turn the Lua debugger off (restarts the cart)" : "Turn the Lua debugger on: breakpoints, stepping, variables (restarts the cart)"}
            >
              Debugger
            </button>
            <button type="button" className="cbx-btn" aria-pressed={profiling} onClick={() => setProfiling((v) => !v)} disabled={status !== "ready"}>
              Profiler
            </button>
            {saveKey && (
              <button
                type="button"
                className="cbx-btn"
                disabled={!hasSave}
                title="Forget what the cart saved with cartbox.save, and restart it"
                onClick={() => {
                  writeLocalSave(browserStorage(), saveKey, null, new Date().toISOString());
                  setHasSave(false);
                  setRestarts((n) => n + 1);
                }}
              >
                Clear save
              </button>
            )}
            <button type="button" className="cbx-btn" aria-pressed={consoleOpen} onClick={() => setConsoleOpen((v) => !v)}>
              Console{log.length > 0 ? ` · ${log.length}` : ""}
            </button>
            <button type="button" className="cbx-btn cbx-btn-accent" onClick={onClose}>
              Stop
            </button>
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "stretch", minHeight: 0 }}>
          <div ref={stageRef} className={styles.runStage} style={{ flex: 1, minWidth: 0 }} />
          {inspecting && <ObjectsPanel objects={objects} filter={filter} onFilter={setFilter} />}
          {profiling && <ProfilerPanel profile={profile} budgetMs={frameDurationMs(getModel(modelId))} />}
          {debugOn && (
            <DebuggerPanel
              pause={pause}
              code={code}
              breakpoints={breakpoints}
              onToggleBreakpoint={(line) => onBreakpointsChange?.(toggleBreakpoint(breakpoints, line))}
              watches={watches}
              onWatchesChange={(next) => onWatchesChange?.(next)}
              onStep={debugStep}
            />
          )}
        </div>

        <div className={styles.runDebug}>
          <span className={styles.runDebugItem}>
            <span className={styles.runDebugLabel}>Status</span>
            <span className={`${styles.runDebugValue} data`}>
              {status === "loading" ? "building…" : status === "error" ? "error" : pause ? `stopped at line ${pause.line}` : running ? "running" : "paused"}
            </span>
          </span>
          <span className={styles.runDebugItem}>
            <span className={styles.runDebugLabel}>Frame</span>
            <span className={`${styles.runDebugValue} data`}>{status === "ready" ? frame : "—"}</span>
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

        {consoleOpen && (
          <ConsolePanel
            log={log}
            onGoToLine={onGoToLine}
            onClear={() => {
              logRef.current = [];
              setLog([]);
            }}
          />
        )}

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

/**
 * The console: what the cart traced and the errors it raised, each tagged with
 * its frame; an error's line and the lines of its call stack open the code.
 */
function ConsolePanel({ log, onGoToLine, onClear }: { log: ConsoleEntry[]; onGoToLine?: (line: number) => void; onClear: () => void }) {
  const listRef = useRef<HTMLDivElement>(null);
  // Follow new lines, unless the creator has scrolled up to read.
  useEffect(() => {
    const list = listRef.current;
    if (list && list.scrollHeight - list.scrollTop - list.clientHeight < 40) list.scrollTop = list.scrollHeight;
  }, [log]);
  const lineLink = (line: number, label: string) =>
    onGoToLine ? (
      <button type="button" className={styles.rendererToggle} onClick={() => onGoToLine(line)} style={{ padding: "0 4px" }}>
        {label}
      </button>
    ) : (
      <span>{label}</span>
    );
  return (
    <section aria-label="Console" style={{ border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface)", fontSize: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 8px", borderBottom: "1px solid var(--border)" }}>
        <strong>Console</strong>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ opacity: 0.7 }}>trace(&quot;…&quot;) prints here</span>
          <button type="button" className={styles.rendererToggle} onClick={onClear} disabled={log.length === 0}>
            Clear
          </button>
        </span>
      </div>
      <div ref={listRef} role="log" className="data" style={{ maxHeight: 150, overflowY: "auto", padding: "4px 8px", display: "grid", gap: 2 }}>
        {log.length === 0 && <span style={{ opacity: 0.6 }}>Nothing yet.</span>}
        {log.map((entry) => (
          <div key={entry.id} data-kind={entry.kind} style={{ display: "flex", gap: 8, alignItems: "baseline", color: entry.kind === "error" ? "#ff8a8a" : traceColor(entry.color) }}>
            <span style={{ opacity: 0.5, minWidth: 48, textAlign: "right" }}>{entry.frame}</span>
            <span style={{ flex: 1, minWidth: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {entry.kind === "error" ? entry.text.split("\n", 1)[0] : entry.text}
              {entry.kind === "error" && entry.line !== null && <> {lineLink(entry.line, `line ${entry.line}`)}</>}
              {entry.stack.length > 1 && (
                <span style={{ opacity: 0.8 }}>
                  {" "}
                  ← {entry.stack.slice(1).map((f, i) => (
                    <span key={i}>
                      {i > 0 && " ← "}
                      {f.name} {lineLink(f.line, String(f.line))}
                    </span>
                  ))}
                </span>
              )}
            </span>
            {entry.count > 1 && <span style={{ opacity: 0.7 }}>×{entry.count}</span>}
          </div>
        ))}
      </div>
    </section>
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
