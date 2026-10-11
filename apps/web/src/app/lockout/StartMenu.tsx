"use client";

/**
 * The Start menu: opened by a controller's Start, the touch pad's Start button,
 * or Enter / P. Controls (look sensitivity per axis, inversion, the response
 * curve, each stick's dead zones, the stick layout and the triggers' pull, with
 * a live picture of the controller), the touch pad, button mapping for a
 * controller and the keyboard, the game's input actions
 * (EP15: rebind each one's key and controller button), audio and display, plus
 * resume / leave. Every setting applies at once and is kept in this browser.
 * Fully usable with a controller: D-pad or stick to move, left/right to adjust,
 * A to choose, B or Start to close.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  AIM_ASSISTS,
  ConsoleButton,
  DEFAULT_CONTROL_SETTINGS,
  DEFAULT_MOUSE_LOOK,
  DEFAULT_STICK_DEAD_ZONES,
  DEFAULT_TRIGGER_THRESHOLD,
  PAD_BUTTONS,
  GYRO_AIMS,
  RESPONSE_CURVES,
  STICK_LAYOUTS,
  askMotionPermission,
  standardizePad,
  type AimAssist,
  type ControlSettings,
  type ControlTarget,
  type GyroAim,
  type LookProfile,
  type PadButton,
  type ResponseCurve,
  type StickDeadZones,
  type StickLayout,
} from "@cartbox/player";
import { COLOR_FILTERS, COLOR_FILTER_LABELS, TEXT_SCALES, actionLabel, languageName, reboundActions, type ActionPadButton, type ColorFilter, type InputAction } from "@cartbox/editor";
import type { PlayerPrefs } from "@/lib/accessibilityPrefs";

import {
  DEFAULT_GAME_SETTINGS,
  PAD_PRESETS,
  keyLabel,
  keysFor,
  rebindKey,
  type GameAction,
  type GameSettings,
} from "@/lib/gameSettings";
import { StickPreview } from "./StickPreview";

type Tab = "controls" | "touch" | "mouse" | "buttons" | "audio" | "display";
const TABS: readonly Tab[] = ["controls", "touch", "mouse", "buttons", "audio", "display"];
const TAB_LABELS: Record<Tab, string> = { controls: "Controls", touch: "Touch", mouse: "Mouse", buttons: "Button mapping", audio: "Audio", display: "Display" };
const DEFAULT_TOUCH_LOOK: LookProfile = { sensitivity: 1, sensitivityY: 1, curve: "standard" };

const CURVE_LABELS: Record<ResponseCurve, string> = {
  standard: "Standard — as the stick leans",
  dynamic: "Dynamic — fine near the centre, quick mid-way",
  precision: "Precision — slower near the centre",
  responsive: "Responsive — quicker off the centre",
};

const AIM_ASSIST_LABELS: Record<AimAssist, string> = {
  off: "Off",
  standard: "Standard",
  strong: "Strong — nudges harder, slows turning across a target",
};

const LAYOUT_LABELS: Record<StickLayout, string> = {
  default: "Default — left moves, right looks",
  southpaw: "Southpaw — right moves, left looks",
  legacy: "Legacy — left moves and turns, right strafes and looks up/down",
  legacySouthpaw: "Legacy southpaw — legacy, sticks swapped",
};

/** The settings the Controls tab owns (its reset puts back only these). */
const STICK_SETTING_KEYS = [
  "invertY",
  "invertX",
  "lookSensitivity",
  "lookSensitivityY",
  "lookCurve",
  "leftStick",
  "rightStick",
  "stickLayout",
  "zoomSensitivity",
  "lookAcceleration",
  "aimAssist",
  "vibration",
  "vibrationStrength",
  "leftTrigger",
  "rightTrigger",
] as const satisfies readonly (keyof ControlSettings)[];

const pct = (v: number) => `${Math.round(v * 100)}%`;

export interface StartMenuProps {
  settings: GameSettings;
  onChange: (settings: GameSettings) => void;
  actions: readonly GameAction[];
  /** The game's input actions (EP15), which the player can rebind here. */
  inputActions?: readonly InputAction[];
  /** In an online room (the game keeps running while the menu is open). */
  online: boolean;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onClose: () => void;
  /** Leave the online room / matchmaking (shown when online). */
  onLeave: () => void;
  /** Back to the page's lobby. */
  onQuit: () => void;
  /** The preset "auto" picked on this device, when a game is running. */
  quality?: string;
  /** The player's accessibility and language settings (EP19b), shared by every game. */
  prefs?: PlayerPrefs;
  onPrefsChange?: (prefs: PlayerPrefs) => void;
  /** The game's languages. */
  languages?: readonly string[];
  /**
   * The game reads its look gain (cartbox.lookgain, C2): sensitivity turns it
   * faster than full lean, and zoom sensitivity and look acceleration apply.
   */
  lookGain?: boolean;
}

const PAD_LABELS: Record<PadButton, string> = {
  A: "A", B: "B", X: "X", Y: "Y", LB: "LB", RB: "RB", LT: "LT (trigger)", RT: "RT (trigger)",
  Back: "Back", Start: "Start", LS: "Left stick click", RS: "Right stick click",
  Up: "D-pad up", Down: "D-pad down", Left: "D-pad left", Right: "D-pad right", Guide: "Xbox (guide) button",
};

export function StartMenu(props: StartMenuProps) {
  const { settings, onChange, actions } = props;
  const [tab, setTab] = useState<Tab>("controls");
  const [listening, setListening] = useState<ConsoleButton | null>(null);
  const [listeningAction, setListeningAction] = useState<string | null>(null);
  const [gyroDenied, setGyroDenied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const controls = settings.controls;
  const setControls = (patch: Partial<typeof controls>) => onChange({ ...settings, controls: { ...controls, ...patch } });

  useGamepadNavigation(rootRef, props.onClose, listening === null && listeningAction === null);
  const rebinds = controls.actionBindings ?? {};
  const rebind = (name: string, patch: { keys?: readonly string[]; pad?: readonly ActionPadButton[] }) =>
    setControls({ actionBindings: { ...rebinds, [name]: { ...rebinds[name], ...patch } } });
  const current = reboundActions(props.inputActions ?? [], rebinds);

  // Rebinding an action's key: the next key pressed becomes its key (Escape cancels).
  useEffect(() => {
    if (listeningAction === null) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.code !== "Escape") rebind(listeningAction, { keys: [event.code] });
      setListeningAction(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // Focus the first control so a controller or keyboard can drive the menu at once.
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>("[data-menu-tab][aria-selected='true']")?.focus();
  }, []);

  // Keyboard rebinding: the next key pressed becomes the action's key (Escape cancels).
  useEffect(() => {
    if (listening === null) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.code !== "Escape") setControls({ keyBindings: rebindKey(controls.keyBindings, event.code, listening) });
      setListening(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // Escape or P closes the menu (when not rebinding).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.code === "Escape" || event.code === "KeyP") && listening === null && listeningAction === null) props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const targetLabel = (target: ControlTarget) =>
    target === null ? "Nothing" : target === "start" ? "Start menu" : actions.find((a) => a.button === target)?.label ?? ConsoleButton[target];

  return (
    <div role="dialog" aria-modal="true" aria-label="Start menu" style={styles.backdrop}>
      <div ref={rootRef} style={styles.panel}>
        <div style={styles.header}>
          <strong style={{ fontSize: 20, letterSpacing: 2 }}>PAUSED</strong>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>
            {props.online ? "Online — the match keeps going while this is open" : "The game is paused"}
          </span>
        </div>

        <div role="tablist" style={styles.tabs}>
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              data-menu-tab
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              style={{ ...styles.tab, ...(tab === t ? styles.tabOn : {}) }}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>

        <div style={styles.body}>
          {tab === "controls" && (
            <>
              <h3 style={styles.h3}>Look (controller)</h3>
              <Row label={`Horizontal sensitivity  ×${controls.lookSensitivity.toFixed(2)}`}>
                <Slider label="Horizontal sensitivity" min={0.25} max={3} step={0.05} value={controls.lookSensitivity} onChange={(lookSensitivity) => setControls({ lookSensitivity })} />
              </Row>
              <Row label={`Vertical sensitivity  ×${(controls.lookSensitivityY ?? controls.lookSensitivity).toFixed(2)}`}>
                <Slider
                  label="Vertical sensitivity"
                  min={0.25}
                  max={3}
                  step={0.05}
                  value={controls.lookSensitivityY ?? controls.lookSensitivity}
                  onChange={(lookSensitivityY) => setControls({ lookSensitivityY })}
                />
              </Row>
              <Row label={`Zoom sensitivity  ×${(controls.zoomSensitivity ?? 1).toFixed(2)}`}>
                <Slider
                  label="Zoom sensitivity"
                  min={0.25}
                  max={2}
                  step={0.05}
                  value={controls.zoomSensitivity ?? 1}
                  onChange={(zoomSensitivity) => setControls({ zoomSensitivity })}
                />
              </Row>
              <Row label={`Look acceleration  ${Math.round((controls.lookAcceleration ?? 0) * 10)}`}>
                <Slider
                  label="Look acceleration"
                  min={0}
                  max={1}
                  step={0.1}
                  value={controls.lookAcceleration ?? 0}
                  onChange={(lookAcceleration) => setControls({ lookAcceleration })}
                />
              </Row>
              <Row label="Response curve">
                <select
                  aria-label="Response curve"
                  style={styles.select}
                  value={controls.lookCurve ?? "standard"}
                  onChange={(event) => setControls({ lookCurve: event.target.value as ResponseCurve })}
                >
                  {RESPONSE_CURVES.map((c) => (
                    <option key={c} value={c}>
                      {CURVE_LABELS[c]}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Aim assist">
                <select
                  aria-label="Aim assist"
                  style={styles.select}
                  value={controls.aimAssist ?? "standard"}
                  onChange={(event) => setControls({ aimAssist: event.target.value as AimAssist })}
                >
                  {AIM_ASSISTS.map((a) => (
                    <option key={a} value={a}>
                      {AIM_ASSIST_LABELS[a]}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Invert look up/down">
                <Toggle on={controls.invertY} onChange={(invertY) => setControls({ invertY })} />
              </Row>
              <Row label="Invert look left/right">
                <Toggle on={controls.invertX ?? false} onChange={(invertX) => setControls({ invertX })} />
              </Row>
              <p style={styles.note}>
                {props.lookGain
                  ? "Sensitivity sets how fast you turn and look, past the game's usual top speed. Zoom sensitivity applies while zoomed. Look acceleration speeds turning up when the stick is held at full lean (0 is off)."
                  : "Sensitivity above ×1 reaches the game's top turn speed with less lean. This game doesn't read zoom sensitivity or look acceleration."}{" "}
                Touch and the mouse have their own sensitivity and curve (their tabs); inversion, zoom sensitivity and aim assist are shared.
              </p>

              <h3 style={styles.h3}>Controller sticks</h3>
              <Row label="Stick layout">
                <select
                  aria-label="Stick layout"
                  style={styles.select}
                  value={controls.stickLayout ?? "default"}
                  onChange={(event) => setControls({ stickLayout: event.target.value as StickLayout })}
                >
                  {STICK_LAYOUTS.map((l) => (
                    <option key={l} value={l}>
                      {LAYOUT_LABELS[l]}
                    </option>
                  ))}
                </select>
              </Row>
              <StickPreview settings={controls} lookGain={props.lookGain} />
              {(["leftStick", "rightStick"] as const).map((which) => {
                const zones = controls[which] ?? DEFAULT_STICK_DEAD_ZONES;
                const name = which === "leftStick" ? "Left stick" : "Right stick";
                // Full lean always lies past the dead zone, as the saved settings require.
                const set = (patch: Partial<StickDeadZones>) => {
                  const next = { ...zones, ...patch };
                  setControls({ [which]: { ...next, maxInput: Math.max(next.maxInput, Math.min(1, next.radial + 0.1)) } });
                };
                return (
                  <div key={which}>
                    <Row label={`${name} dead zone  ${pct(zones.radial)}`}>
                      <Slider label={`${name} dead zone`} min={0} max={0.5} step={0.01} value={zones.radial} onChange={(radial) => set({ radial })} />
                    </Row>
                    <Row label={`${name} axial dead zone  ${pct(zones.axial)}`}>
                      <Slider label={`${name} axial dead zone`} min={0} max={0.5} step={0.01} value={zones.axial} onChange={(axial) => set({ axial })} />
                    </Row>
                    <Row label={`${name} max input  ${pct(zones.maxInput)}`}>
                      <Slider label={`${name} max input`} min={0.5} max={1} step={0.01} value={zones.maxInput} onChange={(maxInput) => set({ maxInput })} />
                    </Row>
                  </div>
                );
              })}
              <p style={styles.note}>
                Dead zone: how far a stick must lean before it counts (raise it if a stick drifts). Axial dead zone: each direction on its own, so a
                push straight ahead stays straight. Max input: how far out reads as full lean (lower it if a stick never quite reaches its edge).
              </p>

              <h3 style={styles.h3}>Triggers</h3>
              <Row label={`LT presses at  ${pct(controls.leftTrigger ?? DEFAULT_TRIGGER_THRESHOLD)}`}>
                <Slider
                  label="LT presses at"
                  min={0.05}
                  max={0.95}
                  step={0.05}
                  value={controls.leftTrigger ?? DEFAULT_TRIGGER_THRESHOLD}
                  onChange={(leftTrigger) => setControls({ leftTrigger })}
                />
              </Row>
              <Row label={`RT presses at  ${pct(controls.rightTrigger ?? DEFAULT_TRIGGER_THRESHOLD)}`}>
                <Slider
                  label="RT presses at"
                  min={0.05}
                  max={0.95}
                  step={0.05}
                  value={controls.rightTrigger ?? DEFAULT_TRIGGER_THRESHOLD}
                  onChange={(rightTrigger) => setControls({ rightTrigger })}
                />
              </Row>
              <p style={styles.note}>A lower pull fires sooner (a hair trigger).</p>

              <h3 style={styles.h3}>Vibration</h3>
              <Row label="Vibration">
                <Toggle on={controls.vibration ?? true} onChange={(vibration) => setControls({ vibration })} />
              </Row>
              <Row label={`Vibration strength  ${pct(controls.vibrationStrength ?? 1)}`}>
                <Slider
                  label="Vibration strength"
                  min={0.1}
                  max={1}
                  step={0.1}
                  value={controls.vibrationStrength ?? 1}
                  onChange={(vibrationStrength) => setControls({ vibrationStrength })}
                />
              </Row>
              <p style={styles.note}>On a controller the browser can rumble. A phone buzzes for the strong ones (a hit, a melee).</p>

              <Row label="">
                <button
                  type="button"
                  className="cbx-btn"
                  onClick={() => setControls(Object.fromEntries(STICK_SETTING_KEYS.map((k) => [k, DEFAULT_CONTROL_SETTINGS[k]])) as Partial<ControlSettings>)}
                >
                  Reset look, sticks &amp; triggers
                </button>
              </Row>
            </>
          )}

          {tab === "touch" && (
            <>
              <h3 style={styles.h3}>Look (touch)</h3>
              <Row label="Look with">
                <select
                  aria-label="Touch look"
                  style={styles.select}
                  value={controls.touchLookMode ?? "stick"}
                  onChange={(event) => setControls({ touchLookMode: event.target.value === "drag" ? "drag" : "stick" })}
                >
                  <option value="stick">The right stick</option>
                  <option value="drag">A drag anywhere on the right of the screen</option>
                </select>
              </Row>
              <LookProfileRows
                device="Touch"
                profile={controls.touchLook ?? DEFAULT_TOUCH_LOOK}
                onChange={(touchLook) => setControls({ touchLook })}
              />
              <h3 style={styles.h3}>Gyro aim</h3>
              <Row label="Turn the device to aim">
                <select
                  aria-label="Gyro aim"
                  style={styles.select}
                  value={controls.gyroAim ?? "off"}
                  onChange={(event) => {
                    const gyroAim = event.target.value as GyroAim;
                    setControls({ gyroAim });
                    // iOS sends motion only once the page asks, from a tap like this one.
                    if (gyroAim !== "off") void askMotionPermission().then((ok) => !ok && setGyroDenied(true));
                  }}
                >
                  {GYRO_AIMS.map((g) => (
                    <option key={g} value={g}>
                      {g === "off" ? "Off" : g === "always" ? "Always" : "Only while zoomed"}
                    </option>
                  ))}
                </select>
              </Row>
              {gyroDenied && <p style={styles.note}>This browser didn&apos;t allow motion, so gyro aim can&apos;t read the device turning.</p>}
              <LookProfileRows
                device="Gyro"
                profile={controls.gyroLook ?? DEFAULT_TOUCH_LOOK}
                onChange={(gyroLook) => setControls({ gyroLook })}
              />
              <p style={styles.note}>On a phone or tablet: turn it left or right to turn, tilt it to aim up or down, with the sticks as well.</p>

              <h3 style={styles.h3}>On-screen pad</h3>
              <Row label="Floating move stick">
                <Toggle on={controls.floatingStick ?? false} onChange={(floatingStick) => setControls({ floatingStick })} />
              </Row>
              <p style={styles.note}>The move stick comes to wherever your thumb lands on the left of the screen.</p>
              <Row label={`Touch controls size  ${pct(controls.touchScale)}`}>
                <Slider label="Touch controls size" min={0.7} max={1.4} step={0.05} value={controls.touchScale} onChange={(touchScale) => setControls({ touchScale })} />
              </Row>
              <Row label={`Touch controls opacity  ${pct(controls.touchOpacity)}`}>
                <Slider label="Touch controls opacity" min={0.2} max={1} step={0.05} value={controls.touchOpacity} onChange={(touchOpacity) => setControls({ touchOpacity })} />
              </Row>
              <Row label="">
                <button
                  type="button"
                  className="cbx-btn"
                  onClick={() =>
                    setControls({
                      touchScale: DEFAULT_CONTROL_SETTINGS.touchScale,
                      touchOpacity: DEFAULT_CONTROL_SETTINGS.touchOpacity,
                      touchLook: DEFAULT_TOUCH_LOOK,
                      touchLookMode: "stick",
                      floatingStick: false,
                      gyroAim: "off",
                      gyroLook: DEFAULT_TOUCH_LOOK,
                    })
                  }
                >
                  Reset touch controls
                </button>
              </Row>
            </>
          )}

          {tab === "mouse" && (
            <>
              <Row label="Mouse look">
                <Toggle on={controls.mouseCapture ?? false} onChange={(mouseCapture) => setControls({ mouseCapture })} />
              </Row>
              <p style={styles.note}>
                Click the game to capture the mouse: it turns and aims, left click fires and right click zooms (both rebindable under Button
                mapping). Esc lets it go.
              </p>
              <LookProfileRows device="Mouse" profile={controls.mouseLook ?? DEFAULT_MOUSE_LOOK} onChange={(mouseLook) => setControls({ mouseLook })} />
              <p style={styles.note}>Responsive suits a mouse: the view turns in step with it.</p>
              <Row label="">
                <button type="button" className="cbx-btn" onClick={() => setControls({ mouseCapture: false, mouseLook: DEFAULT_MOUSE_LOOK })}>
                  Reset mouse
                </button>
              </Row>
            </>
          )}

          {tab === "buttons" && (
            <>
              <h3 style={styles.h3}>Controller (Xbox 360 / Xbox)</h3>
              <Row label="Layout">
                <select
                  aria-label="Controller layout"
                  style={styles.select}
                  value={PAD_PRESETS.findIndex((p) => JSON.stringify(p.bindings) === JSON.stringify(controls.padBindings))}
                  onChange={(event) => {
                    const preset = PAD_PRESETS[Number(event.target.value)];
                    if (preset) setControls({ padBindings: preset.bindings });
                  }}
                >
                  <option value={-1} disabled>
                    Custom
                  </option>
                  {PAD_PRESETS.map((p, i) => (
                    <option key={p.name} value={i}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Row>
              {PAD_BUTTONS.map((name) => (
                <Row key={name} label={PAD_LABELS[name]}>
                  <select
                    aria-label={`${PAD_LABELS[name]} does`}
                    style={styles.select}
                    value={String(controls.padBindings[name])}
                    onChange={(event) => {
                      const v = event.target.value;
                      const target: ControlTarget = v === "null" ? null : v === "start" ? "start" : (Number(v) as ConsoleButton);
                      setControls({ padBindings: { ...controls.padBindings, [name]: target } });
                    }}
                  >
                    {actions.map((a) => (
                      <option key={a.button} value={String(a.button)}>
                        {a.label}
                      </option>
                    ))}
                    <option value="start">Start menu</option>
                    <option value="null">Nothing</option>
                  </select>
                </Row>
              ))}
              <p style={styles.note}>Left stick moves, right stick aims. Currently: {targetLabel(controls.padBindings.RT)} on RT.</p>

              <h3 style={styles.h3}>Keyboard</h3>
              {actions.map((a) => (
                <Row key={a.button} label={a.label}>
                  <span style={{ fontFamily: "var(--font-data)", minWidth: 60 }}>{keysFor(controls.keyBindings, a.button).join(" / ") || "—"}</span>
                  <button type="button" className="cbx-btn" onClick={() => setListening(a.button)}>
                    {listening === a.button ? "Press a key… (Esc cancels)" : "Change"}
                  </button>
                </Row>
              ))}
              <p style={styles.note}>
                Start menu: {["Enter", "KeyP"].map(keyLabel).join(" or ")}.
              </p>
              <Row label="">
                <button
                  type="button"
                  className="cbx-btn"
                  onClick={() => setControls({ padBindings: DEFAULT_CONTROL_SETTINGS.padBindings, keyBindings: DEFAULT_CONTROL_SETTINGS.keyBindings })}
                >
                  Reset controller buttons &amp; keys
                </button>
              </Row>

              {current.length > 0 && (
                <>
                  <h3 style={styles.h3}>Actions</h3>
                  {current.map((a) => (
                    <Row key={a.name} label={a.name[0]!.toUpperCase() + a.name.slice(1)}>
                      <span style={{ fontFamily: "var(--font-data)", minWidth: 60 }}>{actionLabel({ ...a, buttons: [] }, "keyboard") || "—"}</span>
                      <button type="button" className="cbx-btn" onClick={() => setListeningAction(a.name)}>
                        {listeningAction === a.name ? "Press a key… (Esc cancels)" : "Change key"}
                      </button>
                      <select
                        aria-label={`${a.name}: hold or toggle`}
                        style={styles.select}
                        value={controls.actionToggles?.includes(a.name) ? "toggle" : "hold"}
                        onChange={(event) => {
                          const others = (controls.actionToggles ?? []).filter((n) => n !== a.name);
                          setControls({ actionToggles: event.target.value === "toggle" ? [...others, a.name] : others });
                        }}
                      >
                        <option value="hold">Hold</option>
                        <option value="toggle">Toggle</option>
                      </select>
                      <select
                        aria-label={`${a.name} on the controller`}
                        style={styles.select}
                        value={a.pad[0] ?? ""}
                        onChange={(event) => rebind(a.name, { pad: event.target.value ? [event.target.value as ActionPadButton] : [] })}
                      >
                        <option value="">No controller button</option>
                        {PAD_BUTTONS.map((b) => (
                          <option key={b} value={b}>
                            {PAD_LABELS[b]}
                          </option>
                        ))}
                      </select>
                    </Row>
                  ))}
                  <p style={styles.note}>
                    A key or controller button given to an action is that action&apos;s alone. Each action also keeps its button above. Toggle: a press
                    turns the action on and the next turns it off (zoom, for one).
                  </p>
                  <Row label="">
                    <button type="button" className="cbx-btn" onClick={() => setControls({ actionBindings: {}, actionToggles: [] })}>
                      Reset actions
                    </button>
                  </Row>
                </>
              )}
            </>
          )}

          {tab === "audio" && (
            <>
              <Row label={`Volume  ${Math.round(settings.volume * 100)}%`}>
                <Slider label="Volume" min={0} max={1} step={0.05} value={settings.volume} onChange={(volume) => onChange({ ...settings, volume })} />
              </Row>
              <Row label="Mute">
                <Toggle on={settings.muted} onChange={(muted) => onChange({ ...settings, muted })} />
              </Row>
            </>
          )}

          {tab === "display" && (
            <>
              <Row label="Full screen">
                <Toggle on={props.isFullscreen} onChange={() => props.onToggleFullscreen()} />
              </Row>
              <Row label="Start games in full screen">
                <Toggle on={settings.fullscreen} onChange={(fullscreen) => onChange({ ...settings, fullscreen })} />
              </Row>
              <Row label="Graphics quality">
                <select
                  aria-label="Graphics quality"
                  value={settings.quality}
                  onChange={(e) => onChange({ ...settings, quality: e.target.value as typeof settings.quality })}
                  style={{ font: "inherit", padding: "6px 10px", borderRadius: "var(--radius-sm)" }}
                >
                  <option value="auto">Auto{props.quality ? ` (${props.quality})` : ""}</option>
                  <option value="low">Low — no shadows, lighter effects</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </Row>
              <Row label="Show frame rate">
                <Toggle on={settings.showFps} onChange={(showFps) => onChange({ ...settings, showFps })} />
              </Row>
              {props.prefs && props.onPrefsChange && (
                <>
                  <h3 style={styles.h3}>Accessibility</h3>
                  <Row label="Colour filter">
                    <select
                      aria-label="Colour filter"
                      value={props.prefs.colorFilter}
                      onChange={(e) => props.onPrefsChange!({ ...props.prefs!, colorFilter: e.target.value as ColorFilter })}
                      style={{ font: "inherit", padding: "6px 10px", borderRadius: "var(--radius-sm)" }}
                    >
                      {COLOR_FILTERS.map((f) => (
                        <option key={f} value={f}>
                          {COLOR_FILTER_LABELS[f]}
                        </option>
                      ))}
                    </select>
                  </Row>
                  <Row label="Text size">
                    <select
                      aria-label="Text size"
                      value={props.prefs.textScale}
                      onChange={(e) => props.onPrefsChange!({ ...props.prefs!, textScale: Number(e.target.value) })}
                      style={{ font: "inherit", padding: "6px 10px", borderRadius: "var(--radius-sm)" }}
                    >
                      {TEXT_SCALES.map((t) => (
                        <option key={t} value={t}>
                          {t === 1 ? "Normal" : `×${t}`}
                        </option>
                      ))}
                    </select>
                  </Row>
                  {props.languages && props.languages.length > 1 && (
                    <Row label="Language">
                      <select
                        aria-label="Language"
                        value={props.prefs.language ?? ""}
                        onChange={(e) => props.onPrefsChange!({ ...props.prefs!, language: e.target.value || null })}
                        style={{ font: "inherit", padding: "6px 10px", borderRadius: "var(--radius-sm)" }}
                      >
                        <option value="">Browser&apos;s</option>
                        {props.languages.map((l) => (
                          <option key={l} value={l}>
                            {languageName(l)}
                          </option>
                        ))}
                      </select>
                    </Row>
                  )}
                </>
              )}
              <Row label="">
                <button type="button" className="cbx-btn" onClick={() => onChange({ ...DEFAULT_GAME_SETTINGS, controls })}>
                  Reset audio &amp; display
                </button>
              </Row>
            </>
          )}
        </div>

        <div style={styles.footer}>
          <button type="button" className="cbx-btn cbx-btn-accent" onClick={props.onClose}>
            Resume
          </button>
          {props.online && (
            <button type="button" className="cbx-btn" onClick={props.onLeave}>
              Leave match
            </button>
          )}
          <button type="button" className="cbx-btn" onClick={props.onQuit} style={{ marginLeft: "auto" }}>
            Quit to lobby
          </button>
        </div>
      </div>
    </div>
  );
}

/** One device's look sensitivity (both axes) and response curve (C4). */
function LookProfileRows({ device, profile, onChange }: { device: string; profile: LookProfile; onChange: (profile: LookProfile) => void }) {
  return (
    <>
      <Row label={`${device} horizontal sensitivity  ×${profile.sensitivity.toFixed(2)}`}>
        <Slider label={`${device} horizontal sensitivity`} min={0.25} max={3} step={0.05} value={profile.sensitivity} onChange={(sensitivity) => onChange({ ...profile, sensitivity })} />
      </Row>
      <Row label={`${device} vertical sensitivity  ×${profile.sensitivityY.toFixed(2)}`}>
        <Slider label={`${device} vertical sensitivity`} min={0.25} max={3} step={0.05} value={profile.sensitivityY} onChange={(sensitivityY) => onChange({ ...profile, sensitivityY })} />
      </Row>
      <Row label={`${device} response curve`}>
        <select
          aria-label={`${device} response curve`}
          style={styles.select}
          value={profile.curve}
          onChange={(event) => onChange({ ...profile, curve: event.target.value as ResponseCurve })}
        >
          {RESPONSE_CURVES.map((c) => (
            <option key={c} value={c}>
              {CURVE_LABELS[c]}
            </option>
          ))}
        </select>
      </Row>
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={styles.row}>
      <span style={{ flex: "1 1 200px" }}>{label}</span>
      <span style={{ display: "flex", gap: 8, alignItems: "center", flex: "0 1 auto" }}>{children}</span>
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" className="cbx-btn" aria-pressed={on} onClick={() => onChange(!on)} style={{ minWidth: 64, ...(on ? { background: "var(--accent)", color: "var(--accent-ink)" } : {}) }}>
      {on ? "On" : "Off"}
    </button>
  );
}

function Slider({ label, min, max, step, value, onChange }: { label?: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <input
      type="range"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      style={{ width: "min(260px, 50vw)", accentColor: "var(--accent)" }}
    />
  );
}

/**
 * Drive the menu with a controller: up/down move focus, left/right adjust a
 * slider or picker, A presses, B or Start closes. Edges only, with the buttons
 * already held when the menu opened ignored (the Start that opened it).
 */
function useGamepadNavigation(rootRef: React.RefObject<HTMLDivElement | null>, onClose: () => void, active: boolean) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    let prev: boolean[] | null = null;
    let repeatAt = 0;
    const focusables = () =>
      Array.from(rootRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), select, input") ?? []);
    const move = (delta: number) => {
      const list = focusables();
      if (list.length === 0) return;
      const at = list.indexOf(document.activeElement as HTMLElement);
      const next = list[(at + delta + list.length) % list.length]!;
      next.focus();
      next.scrollIntoView({ block: "nearest" });
    };
    const adjust = (delta: number) => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement && el.type === "range") {
        const step = Number(el.step) || 1;
        const value = Math.max(Number(el.min), Math.min(Number(el.max), Number(el.value) + delta * step));
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(el, String(value));
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (el instanceof HTMLSelectElement) {
        const options = Array.from(el.options);
        let i = el.selectedIndex;
        do i = (i + delta + options.length) % options.length;
        while (options[i]?.disabled && i !== el.selectedIndex);
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
        setter?.call(el, options[i]!.value);
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (el instanceof HTMLElement && el.getAttribute("role") === "tab") {
        move(delta);
        (document.activeElement as HTMLElement | null)?.click();
      }
    };
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      const raw = Array.from(navigator.getGamepads?.() ?? []).find((p) => p && p.connected);
      if (!raw) return;
      const pad = standardizePad(raw);
      const b = (i: number) => Boolean(pad.buttons[i]?.pressed);
      const ly = pad.axes[1] ?? 0;
      const lx = pad.axes[0] ?? 0;
      const state = [b(0), b(1), b(9) || b(8) || b(16), b(12) || ly < -0.6, b(13) || ly > 0.6, b(14) || lx < -0.6, b(15) || lx > 0.6];
      if (!prev) {
        prev = state; // ignore whatever was held when the menu opened
        return;
      }
      const pressed = (i: number) => state[i] && !prev![i];
      const held = (i: number) => state[i] && now >= repeatAt;
      if (pressed(0)) (document.activeElement as HTMLElement | null)?.click();
      if (pressed(1) || pressed(2)) closeRef.current();
      for (const [i, act] of [
        [3, () => move(-1)],
        [4, () => move(1)],
        [5, () => adjust(-1)],
        [6, () => adjust(1)],
      ] as const) {
        if (pressed(i)) {
          act();
          repeatAt = now + 350;
        } else if (held(i)) {
          act();
          repeatAt = now + 90;
        }
      }
      prev = state;
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [rootRef, active]);
}

const styles: Record<string, CSSProperties> = {
  backdrop: {
    position: "absolute",
    inset: 0,
    zIndex: 20,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(6,8,14,0.72)",
    padding: 16,
  },
  panel: {
    width: "min(760px, 100%)",
    maxHeight: "100%",
    display: "flex",
    flexDirection: "column",
    background: "var(--surface-raised)",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-lg)",
    boxShadow: "var(--shadow)",
    color: "var(--text)",
    overflow: "hidden",
  },
  header: { display: "flex", flexWrap: "wrap", gap: 12, alignItems: "baseline", padding: "14px 18px 6px" },
  tabs: { display: "flex", flexWrap: "wrap", gap: 6, padding: "6px 18px", borderBottom: "1px solid var(--border)" },
  tab: { background: "transparent", border: "1px solid transparent", color: "var(--muted)", padding: "8px 12px", borderRadius: "var(--radius-sm)", font: "inherit", cursor: "pointer" },
  tabOn: { color: "var(--text)", borderColor: "var(--border-strong)", background: "var(--well)" },
  body: { overflowY: "auto", padding: "10px 18px", display: "grid", gap: 4 },
  row: { display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)" },
  h3: { margin: "10px 0 2px", fontSize: 14, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1 },
  select: { font: "inherit", padding: "6px 8px", background: "var(--well)", color: "var(--text)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-sm)", maxWidth: "min(340px, 60vw)" },
  note: { margin: "6px 0", color: "var(--faint)", fontSize: 13 },
  footer: { display: "flex", flexWrap: "wrap", gap: 10, padding: "12px 18px", borderTop: "1px solid var(--border)" },
};
