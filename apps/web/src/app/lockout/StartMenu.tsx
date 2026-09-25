"use client";

/**
 * The Start menu: opened by a controller's Start, the touch pad's Start button,
 * or Enter / P. Controls (aim inversion, look sensitivity, the touch pad),
 * button mapping for a controller and the keyboard, audio and display, plus
 * resume / leave. Every setting applies at once and is kept in this browser.
 * Fully usable with a controller: D-pad or stick to move, left/right to adjust,
 * A to choose, B or Start to close.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ConsoleButton, DEFAULT_CONTROL_SETTINGS, PAD_BUTTONS, standardizePad, type ControlTarget, type PadButton } from "@cartbox/player";

import {
  DEFAULT_GAME_SETTINGS,
  PAD_PRESETS,
  keyLabel,
  keysFor,
  rebindKey,
  type GameAction,
  type GameSettings,
} from "@/lib/gameSettings";

type Tab = "controls" | "buttons" | "audio" | "display";

export interface StartMenuProps {
  settings: GameSettings;
  onChange: (settings: GameSettings) => void;
  actions: readonly GameAction[];
  /** In an online room (the game keeps running while the menu is open). */
  online: boolean;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onClose: () => void;
  /** Leave the online room / matchmaking (shown when online). */
  onLeave: () => void;
  /** Back to the page's lobby. */
  onQuit: () => void;
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
  const rootRef = useRef<HTMLDivElement>(null);
  const controls = settings.controls;
  const setControls = (patch: Partial<typeof controls>) => onChange({ ...settings, controls: { ...controls, ...patch } });

  useGamepadNavigation(rootRef, props.onClose, listening === null);

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
      if ((event.code === "Escape" || event.code === "KeyP") && listening === null) props.onClose();
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
          {(["controls", "buttons", "audio", "display"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              data-menu-tab
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              style={{ ...styles.tab, ...(tab === t ? styles.tabOn : {}) }}
            >
              {t === "controls" ? "Controls" : t === "buttons" ? "Button mapping" : t === "audio" ? "Audio" : "Display"}
            </button>
          ))}
        </div>

        <div style={styles.body}>
          {tab === "controls" && (
            <>
              <Row label="Invert aim (look up/down)">
                <Toggle on={controls.invertY} onChange={(invertY) => setControls({ invertY })} />
              </Row>
              <Row label={`Look sensitivity  ×${controls.lookSensitivity.toFixed(2)}`}>
                <Slider min={0.25} max={3} step={0.05} value={controls.lookSensitivity} onChange={(lookSensitivity) => setControls({ lookSensitivity })} />
              </Row>
              <Row label={`Touch controls size  ${Math.round(controls.touchScale * 100)}%`}>
                <Slider min={0.7} max={1.4} step={0.05} value={controls.touchScale} onChange={(touchScale) => setControls({ touchScale })} />
              </Row>
              <Row label={`Touch controls opacity  ${Math.round(controls.touchOpacity * 100)}%`}>
                <Slider min={0.2} max={1} step={0.05} value={controls.touchOpacity} onChange={(touchOpacity) => setControls({ touchOpacity })} />
              </Row>
              <Row label="">
                <button type="button" className="cbx-btn" onClick={() => onChange({ ...settings, controls: DEFAULT_CONTROL_SETTINGS })}>
                  Reset controls to defaults
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
            </>
          )}

          {tab === "audio" && (
            <>
              <Row label={`Volume  ${Math.round(settings.volume * 100)}%`}>
                <Slider min={0} max={1} step={0.05} value={settings.volume} onChange={(volume) => onChange({ ...settings, volume })} />
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
              <Row label="Show frame rate">
                <Toggle on={settings.showFps} onChange={(showFps) => onChange({ ...settings, showFps })} />
              </Row>
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

function Slider({ min, max, step, value, onChange }: { min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <input
      type="range"
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
