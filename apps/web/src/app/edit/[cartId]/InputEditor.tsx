"use client";

/**
 * The Input tab (ENGINE_PARITY_ROADMAP.md EP15): the cart's input actions —
 * "jump", "fire", "reload" — each bound to keyboard keys, controller buttons
 * and console buttons, which the cart reads with cartbox.action(name). A test
 * strip lights each action as you press its bindings, so a binding can be
 * tried here. Players can rebind actions on top (see ControlSettings).
 */

import { useEffect, useRef, useState } from "react";

import {
  ACTION_CONSOLE_BUTTONS,
  ACTION_PAD_BUTTONS,
  MAX_ACTIONS,
  MAX_ACTION_BINDINGS,
  actionMask,
  keyLabel,
  newInputAction,
  type ActionPadButton,
  type InputAction,
} from "@cartbox/editor";

import { setMeshActions, type MeshSidecar } from "@/lib/meshSidecar";
import { RailGroup, RailHint } from "./railControls";

const NAME = /^[A-Za-z_]\w{0,23}$/;
const chip = { display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 6px", borderRadius: 4, background: "rgba(255,255,255,0.08)", fontSize: 12 } as const;
const cell = { padding: "6px 8px", verticalAlign: "top", borderTop: "1px solid rgba(255,255,255,0.06)" } as const;

/** Which actions are held now, from this page's keys and the first controller (for the test strip). */
function useHeldActions(actions: readonly InputAction[], paused: boolean): number {
  const [mask, setMask] = useState(0);
  const keys = useRef(new Set<string>());
  useEffect(() => {
    if (paused) return;
    const down = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") keys.current.add(e.code);
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.code);
    const blur = () => keys.current.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    let frame = 0;
    const poll = () => {
      const pad = navigator.getGamepads?.().find((p) => p && p.connected) ?? null;
      const pressed = new Set<string>();
      pad?.buttons.forEach((b, i) => {
        if ((b.pressed || b.value > 0.5) && ACTION_PAD_BUTTONS[i]) pressed.add(ACTION_PAD_BUTTONS[i]!);
      });
      setMask(actionMask(actions, { keys: keys.current, pad: pressed, buttons: 0 }));
      frame = requestAnimationFrame(poll);
    };
    frame = requestAnimationFrame(poll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [actions, paused]);
  return mask;
}

export function InputEditor({ sidecar, onSidecarChange }: { sidecar: MeshSidecar; onSidecarChange: (next: MeshSidecar) => void }) {
  const actions = sidecar.actions ?? [];
  const [listening, setListening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const held = useHeldActions(actions, listening !== null);
  const save = (next: readonly InputAction[]) => onSidecarChange(setMeshActions(sidecar, next));
  const patch = (name: string, change: Partial<InputAction>) => save(actions.map((a) => (a.name === name ? { ...a, ...change } : a)));

  // Capture the next key for an action (Escape cancels). The binding is added
  // through the latest render's actions, kept in a ref.
  const bindKey = useRef<(name: string, code: string) => void>(() => {});
  useEffect(() => {
    bindKey.current = (name, code) => {
      const a = actions.find((x) => x.name === name);
      if (a && !a.keys.includes(code)) patch(name, { keys: [...a.keys, code].slice(-MAX_ACTION_BINDINGS) });
    };
  });
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setListening(null);
      if (e.code !== "Escape") bindKey.current(listening, e.code);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [listening]);

  const rename = (from: string, to: string) => {
    if (to === from) return true;
    if (!NAME.test(to) || actions.some((a) => a.name === to)) {
      setError("A name is letters, digits and _ (not starting with a digit), and not one already used.");
      return false;
    }
    setError(null);
    patch(from, { name: to });
    return true;
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 14, maxWidth: 1100 }}>
      <RailGroup label="Input actions">
        <RailHint>
          Name what the player does — jump, fire, reload — and bind it per device. The cart reads cartbox.action(name) (held), cartbox.actionp (pressed this
          tick) and cartbox.actionr (released); cartbox.actionlabel(name) gives its keys for an on-screen prompt. Console buttons also cover the on-screen
          pad. Players can rebind actions from the Start menu.
        </RailHint>
        {actions.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
            <thead>
              <tr style={{ textAlign: "left", fontSize: 12, opacity: 0.7 }}>
                <th style={cell}>Action</th>
                <th style={cell}>Keyboard</th>
                <th style={cell}>Controller</th>
                <th style={cell}>Console buttons</th>
                <th style={cell} />
              </tr>
            </thead>
            <tbody>
              {actions.map((a, i) => {
                const on = (held & (1 << i)) !== 0;
                return (
                  <tr key={a.name}>
                    <td style={cell}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span
                          aria-label={on ? `${a.name} held` : `${a.name} not held`}
                          title="Lights while held (try it)"
                          style={{ width: 10, height: 10, borderRadius: 5, background: on ? "#5cd0ff" : "rgba(255,255,255,0.15)", flex: "none" }}
                        />
                        <input
                          aria-label="Action name"
                          defaultValue={a.name}
                          style={{ width: 120 }}
                          onBlur={(e) => {
                            if (!rename(a.name, e.target.value.trim())) e.target.value = a.name;
                          }}
                        />
                      </div>
                    </td>
                    <td style={cell}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {a.keys.map((k) => (
                          <span key={k} style={chip}>
                            {keyLabel(k)}
                            <button type="button" aria-label={`Unbind ${keyLabel(k)}`} style={{ background: "none", border: 0, color: "inherit", cursor: "pointer", padding: 0 }} onClick={() => patch(a.name, { keys: a.keys.filter((x) => x !== k) })}>
                              ✕
                            </button>
                          </span>
                        ))}
                        {a.keys.length < MAX_ACTION_BINDINGS && (
                          <button type="button" className="cbx-btn" onClick={() => setListening(a.name)} aria-pressed={listening === a.name}>
                            {listening === a.name ? "Press a key…" : "+ Key"}
                          </button>
                        )}
                      </div>
                    </td>
                    <td style={cell}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {a.pad.map((b) => (
                          <span key={b} style={chip}>
                            {b}
                            <button type="button" aria-label={`Unbind ${b}`} style={{ background: "none", border: 0, color: "inherit", cursor: "pointer", padding: 0 }} onClick={() => patch(a.name, { pad: a.pad.filter((x) => x !== b) })}>
                              ✕
                            </button>
                          </span>
                        ))}
                        {a.pad.length < MAX_ACTION_BINDINGS && (
                          <select aria-label={`Add a controller button to ${a.name}`} value="" onChange={(e) => e.target.value && patch(a.name, { pad: [...a.pad, e.target.value as ActionPadButton] })}>
                            <option value="">+ Button</option>
                            {ACTION_PAD_BUTTONS.filter((b) => !a.pad.includes(b)).map((b) => (
                              <option key={b} value={b}>
                                {b}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    </td>
                    <td style={cell}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {ACTION_CONSOLE_BUTTONS.map((name, b) => (
                          <label key={name} style={{ fontSize: 12, display: "inline-flex", gap: 3, alignItems: "center" }}>
                            <input
                              type="checkbox"
                              checked={a.buttons.includes(b)}
                              onChange={(e) => patch(a.name, { buttons: e.target.checked ? [...a.buttons, b].slice(-MAX_ACTION_BINDINGS) : a.buttons.filter((x) => x !== b) })}
                            />
                            {name.toUpperCase()}
                          </label>
                        ))}
                      </div>
                    </td>
                    <td style={cell}>
                      <button type="button" className="cbx-btn" aria-label={`Delete ${a.name}`} onClick={() => save(actions.filter((x) => x.name !== a.name))}>
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button
            type="button"
            className="cbx-btn"
            disabled={actions.length >= MAX_ACTIONS}
            onClick={() => {
              setError(null);
              save([...actions, newInputAction(actions)]);
            }}
          >
            + New action
          </button>
        </div>
        {actions.length >= MAX_ACTIONS && <RailHint>A cart holds up to {MAX_ACTIONS} actions.</RailHint>}
        {error && <RailHint>{error}</RailHint>}
      </RailGroup>
    </div>
  );
}
