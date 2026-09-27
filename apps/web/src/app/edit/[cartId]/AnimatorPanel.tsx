"use client";

/**
 * The Mesh tab's state machine editor for a skinned object (ENGINE_ROADMAP.md,
 * Phase 3): parameters the cart sets, states that play a clip or blend clips by
 * a parameter, transitions between them, and named clip events. Stored on the
 * object's sidecar entry as `animator` (see animatorSpec.ts); the cart drives it
 * with cartbox.set / trigger and reads it with cartbox.state / events.
 */

import { useEffect, useState } from "react";

import {
  ANIMATOR_LIMITS,
  DEFAULT_ANIMATOR_FADE,
  defaultAnimator,
  type AnimatorCondition,
  type AnimatorOp,
  type AnimatorParam,
  type AnimatorParamKind,
  type AnimatorSpec,
  type AnimatorState,
  type AnimatorTransition,
  type MeshAsset,
} from "@cartbox/editor";

import { setMeshAnimator, type MeshSidecar, type MeshSidecarEntry } from "@/lib/meshSidecar";
import styles from "./editor.module.css";
import { RailGroup, RailHint } from "./railControls";

const input: React.CSSProperties = { width: "100%", minWidth: 0, padding: "3px 5px", borderRadius: 6, fontSize: 12 };
const row: React.CSSProperties = { display: "flex", gap: 4, alignItems: "center" };
const card: React.CSSProperties = { display: "grid", gap: 4, padding: 6, borderRadius: 8, border: "1px solid rgba(255,255,255,0.12)" };
const sub: React.CSSProperties = { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, opacity: 0.7, marginTop: 8 };

const OPS_BY_KIND: Record<AnimatorParamKind, readonly AnimatorOp[]> = {
  number: [">", "<", ">=", "<=", "==", "!="],
  bool: ["true", "false"],
  trigger: ["set"],
};

function Remove({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className={styles.toolBtn} aria-label={label} onClick={onClick} style={{ padding: "2px 6px", flex: "none" }}>
      ×
    </button>
  );
}

function Add({ children, onClick, disabled }: { children: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className={styles.toolBtn} onClick={onClick} disabled={disabled} style={{ fontSize: 12 }}>
      + {children}
    </button>
  );
}

/**
 * A name field that commits on blur or Enter, and only a non-empty name no
 * sibling already has (a clash mid-typing would otherwise drop the other one).
 */
function NameInput({ label, value, taken, onCommit }: { label: string; value: string; taken: readonly string[]; onCommit: (name: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.trim();
    if (next && next !== value && next !== "*" && !taken.includes(next)) onCommit(next);
    else setDraft(value);
  };
  return (
    <input
      aria-label={label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
      style={input}
    />
  );
}

/** A name not yet in `taken`: `base`, `base 2`, `base 3`… */
function fresh(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
}

export function AnimatorPanel({
  sidecar,
  entry,
  mesh,
  onChange,
}: {
  sidecar: MeshSidecar;
  entry: MeshSidecarEntry;
  mesh: MeshAsset;
  onChange: (next: MeshSidecar) => void;
}) {
  const spec = entry.animator ?? null;
  const clipNames = (mesh.clips ?? []).map((c) => c.name);
  const save = (next: AnimatorSpec | null) => onChange(setMeshAnimator(sidecar, entry.id, next));
  const name = JSON.stringify(entry.name);

  if (!spec) {
    return (
      <RailGroup label="State machine" advanced>
        <button type="button" className={styles.toolBtn} onClick={() => save(defaultAnimator(clipNames))}>
          Add a state machine
        </button>
        <RailHint>
          States (idle, walk, run…) the object moves between when the cart changes a parameter — e.g. cartbox.set({name}, &quot;speed&quot;, 3). Without one it loops its first clip.
        </RailHint>
      </RailGroup>
    );
  }

  const set = (patch: Partial<AnimatorSpec>) => save({ ...spec, ...patch });
  const setParam = (i: number, p: AnimatorParam) => set({ params: spec.params.map((q, k) => (k === i ? p : q)) });
  const setState = (i: number, s: AnimatorState) => set({ states: spec.states.map((q, k) => (k === i ? s : q)) });
  const setTransition = (i: number, t: AnimatorTransition) => set({ transitions: spec.transitions.map((q, k) => (k === i ? t : q)) });
  const numberParams = spec.params.filter((p) => p.kind === "number");
  const clipOptions = (
    <>
      {clipNames.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </>
  );

  // Renaming a parameter or state carries the new name into everything that refers to it.
  const renameParam = (i: number, to: string) => {
    const from = spec.params[i]!.name;
    save({
      ...spec,
      params: spec.params.map((p, k) => (k === i ? { ...p, name: to } : p)),
      states: spec.states.map((s) => (s.blend?.param === from ? { ...s, blend: { ...s.blend, param: to } } : s)),
      transitions: spec.transitions.map((t) => ({ ...t, when: t.when.map((c) => (c.param === from ? { ...c, param: to } : c)) })),
    });
  };
  const renameState = (i: number, to: string) => {
    const from = spec.states[i]!.name;
    save({
      ...spec,
      states: spec.states.map((s, k) => (k === i ? { ...s, name: to } : s)),
      transitions: spec.transitions.map((t) => ({ ...t, from: t.from === from ? to : t.from, to: t.to === from ? to : t.to })),
    });
  };

  return (
    <RailGroup label="State machine">
      <div style={sub}>Parameters</div>
      {spec.params.map((p, i) => (
        <div key={i} style={row}>
          <NameInput label="Parameter name" value={p.name} taken={spec.params.filter((_, k) => k !== i).map((q) => q.name)} onCommit={(n) => renameParam(i, n)} />
          <select
            aria-label="Parameter kind"
            value={p.kind}
            onChange={(e) => setParam(i, { ...p, kind: e.target.value as AnimatorParamKind, initial: 0 })}
            style={{ ...input, width: 78, flex: "none" }}
          >
            <option value="number">number</option>
            <option value="bool">bool</option>
            <option value="trigger">trigger</option>
          </select>
          <Remove label={`Remove parameter ${p.name}`} onClick={() => set({ params: spec.params.filter((_, k) => k !== i) })} />
        </div>
      ))}
      <Add
        disabled={spec.params.length >= ANIMATOR_LIMITS.params}
        onClick={() => set({ params: [...spec.params, { name: fresh("speed", spec.params.map((p) => p.name)), kind: "number", initial: 0 }] })}
      >
        Parameter
      </Add>

      <div style={sub}>States (the first is where it starts)</div>
      {spec.states.map((s, i) => (
        <div key={i} style={card}>
          <div style={row}>
            <NameInput label="State name" value={s.name} taken={spec.states.filter((_, k) => k !== i).map((q) => q.name)} onCommit={(n) => renameState(i, n)} />
            {spec.states.length > 1 && (
              <Remove
                label={`Remove state ${s.name}`}
                onClick={() =>
                  save({
                    ...spec,
                    states: spec.states.filter((_, k) => k !== i),
                    transitions: spec.transitions.filter((t) => t.from !== s.name && t.to !== s.name),
                  })
                }
              />
            )}
          </div>
          <select
            aria-label="State clip"
            value={s.blend ? "__blend" : (s.clip ?? "")}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__blend") {
                const param = numberParams[0]?.name;
                if (!param) return;
                const { blend: _drop, ...rest } = s;
                setState(i, { ...rest, blend: { param, points: clipNames.slice(0, 2).map((clip, k) => ({ clip, at: k })) } });
              } else {
                const { blend: _drop, ...rest } = s;
                setState(i, { ...rest, clip: v || null });
              }
            }}
            style={input}
          >
            <option value="">Rest pose</option>
            {clipOptions}
            <option value="__blend" disabled={numberParams.length === 0}>
              Blend by a number parameter…
            </option>
          </select>
          {s.blend && (
            <div style={{ display: "grid", gap: 4 }}>
              <div style={row}>
                <span style={{ fontSize: 12, flex: "none" }}>by</span>
                <select
                  aria-label="Blend parameter"
                  value={s.blend.param}
                  onChange={(e) => setState(i, { ...s, blend: { ...s.blend!, param: e.target.value } })}
                  style={input}
                >
                  {numberParams.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              {s.blend.points.map((pt, k) => (
                <div key={k} style={row}>
                  <select
                    aria-label="Blend clip"
                    value={pt.clip}
                    onChange={(e) => setState(i, { ...s, blend: { ...s.blend!, points: s.blend!.points.map((q, j) => (j === k ? { ...q, clip: e.target.value } : q)) } })}
                    style={input}
                  >
                    {clipOptions}
                  </select>
                  <span style={{ fontSize: 12, flex: "none" }}>at</span>
                  <input
                    type="number"
                    step={0.1}
                    aria-label="Blend point"
                    value={pt.at}
                    onChange={(e) => setState(i, { ...s, blend: { ...s.blend!, points: s.blend!.points.map((q, j) => (j === k ? { ...q, at: Number(e.target.value) } : q)) } })}
                    style={{ ...input, width: 56, flex: "none" }}
                  />
                  {s.blend!.points.length > 1 && (
                    <Remove label="Remove blend point" onClick={() => setState(i, { ...s, blend: { ...s.blend!, points: s.blend!.points.filter((_, j) => j !== k) } })} />
                  )}
                </div>
              ))}
              <Add
                disabled={s.blend.points.length >= ANIMATOR_LIMITS.blendPoints || clipNames.length === 0}
                onClick={() => {
                  const last = s.blend!.points[s.blend!.points.length - 1];
                  setState(i, { ...s, blend: { ...s.blend!, points: [...s.blend!.points, { clip: clipNames[0]!, at: (last?.at ?? 0) + 1 }] } });
                }}
              >
                Blend point
              </Add>
            </div>
          )}
          <div style={row}>
            <label style={{ ...row, fontSize: 12 }}>
              <input type="checkbox" aria-label="Loop" checked={s.loop} onChange={(e) => setState(i, { ...s, loop: e.target.checked })} />
              loop
            </label>
            <span style={{ fontSize: 12, marginLeft: "auto" }}>speed</span>
            <input
              type="number"
              step={0.1}
              aria-label="State speed"
              value={s.speed}
              onChange={(e) => setState(i, { ...s, speed: Number(e.target.value) })}
              style={{ ...input, width: 56 }}
            />
          </div>
        </div>
      ))}
      <Add
        disabled={spec.states.length >= ANIMATOR_LIMITS.states}
        onClick={() => set({ states: [...spec.states, { name: fresh(clipNames[0] ?? "state", spec.states.map((s) => s.name)), clip: clipNames[0] ?? null, speed: 1, loop: true }] })}
      >
        State
      </Add>

      <div style={sub}>Transitions</div>
      {spec.transitions.map((t, i) => (
        <div key={i} style={card}>
          <div style={row}>
            <select aria-label="Transition from" value={t.from} onChange={(e) => setTransition(i, { ...t, from: e.target.value })} style={input}>
              <option value="*">any state</option>
              {spec.states.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
            <span style={{ flex: "none" }}>→</span>
            <select aria-label="Transition to" value={t.to} onChange={(e) => setTransition(i, { ...t, to: e.target.value })} style={input}>
              {spec.states.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
            <Remove label="Remove transition" onClick={() => set({ transitions: spec.transitions.filter((_, k) => k !== i) })} />
          </div>
          {t.when.map((c, k) => {
            const p = spec.params.find((q) => q.name === c.param);
            const ops = p ? OPS_BY_KIND[p.kind] : [];
            const setCond = (next: AnimatorCondition) => setTransition(i, { ...t, when: t.when.map((q, j) => (j === k ? next : q)) });
            return (
              <div key={k} style={row}>
                <span style={{ fontSize: 12, flex: "none" }}>{k === 0 ? "when" : "and"}</span>
                <select
                  aria-label="Condition parameter"
                  value={c.param}
                  onChange={(e) => {
                    const q = spec.params.find((x) => x.name === e.target.value)!;
                    setCond({ param: q.name, op: OPS_BY_KIND[q.kind][0]!, value: 0 });
                  }}
                  style={{ ...input, minWidth: 72 }}
                >
                  {spec.params.map((q) => (
                    <option key={q.name} value={q.name}>
                      {q.name}
                    </option>
                  ))}
                </select>
                {ops.length > 1 && (
                  <select aria-label="Condition test" value={c.op} onChange={(e) => setCond({ ...c, op: e.target.value as AnimatorOp })} style={{ ...input, width: 58, flex: "none" }}>
                    {ops.map((op) => (
                      <option key={op} value={op}>
                        {op === "true" ? "is on" : op === "false" ? "is off" : op}
                      </option>
                    ))}
                  </select>
                )}
                {p?.kind === "number" && (
                  <input
                    type="number"
                    step={0.1}
                    aria-label="Condition value"
                    value={c.value}
                    onChange={(e) => setCond({ ...c, value: Number(e.target.value) })}
                    style={{ ...input, width: 52, flex: "none" }}
                  />
                )}
                {p?.kind === "trigger" && <span style={{ fontSize: 12 }}>fires</span>}
                <Remove label="Remove condition" onClick={() => setTransition(i, { ...t, when: t.when.filter((_, j) => j !== k) })} />
              </div>
            );
          })}
          {spec.params.length > 0 && t.when.length < ANIMATOR_LIMITS.conditions && (
            <Add
              onClick={() => {
                const q = spec.params[0]!;
                setTransition(i, { ...t, when: [...t.when, { param: q.name, op: OPS_BY_KIND[q.kind][0]!, value: 0 }] });
              }}
            >
              Condition
            </Add>
          )}
          <div style={row}>
            <span style={{ fontSize: 12 }}>fade s</span>
            <input
              type="number"
              step={0.05}
              min={0}
              aria-label="Transition fade"
              value={t.fade}
              onChange={(e) => setTransition(i, { ...t, fade: Number(e.target.value) })}
              style={{ ...input, width: 52 }}
            />
            <span style={{ fontSize: 12, marginLeft: "auto" }}>after</span>
            <input
              type="number"
              step={0.1}
              min={0}
              aria-label="Transition exit time"
              placeholder="any"
              title="How far through the clip (1 = once through) before this transition may fire; empty = any time"
              value={t.exitTime ?? ""}
              onChange={(e) => {
                const { exitTime: _drop, ...rest } = t;
                setTransition(i, e.target.value === "" ? rest : { ...rest, exitTime: Number(e.target.value) });
              }}
              style={{ ...input, width: 64 }}
            />
          </div>
        </div>
      ))}
      <Add
        disabled={spec.transitions.length >= ANIMATOR_LIMITS.transitions || spec.states.length < 1}
        onClick={() =>
          set({ transitions: [...spec.transitions, { from: spec.states[0]!.name, to: spec.states[1]?.name ?? spec.states[0]!.name, when: [], fade: DEFAULT_ANIMATOR_FADE }] })
        }
      >
        Transition
      </Add>

      <div style={sub}>Clip events</div>
      {spec.events.map((ev, i) => (
        <div key={i} style={row}>
          <select
            aria-label="Event clip"
            value={ev.clip}
            onChange={(e) => set({ events: spec.events.map((q, k) => (k === i ? { ...q, clip: e.target.value } : q)) })}
            style={input}
          >
            {clipOptions}
          </select>
          <input
            type="number"
            step={0.05}
            min={0}
            aria-label="Event time"
            value={ev.time}
            onChange={(e) => set({ events: spec.events.map((q, k) => (k === i ? { ...q, time: Number(e.target.value) } : q)) })}
            style={{ ...input, width: 52, flex: "none" }}
          />
          <NameInput label="Event name" value={ev.name} taken={[]} onCommit={(n) => set({ events: spec.events.map((q, k) => (k === i ? { ...q, name: n } : q)) })} />
          <Remove label={`Remove event ${ev.name}`} onClick={() => set({ events: spec.events.filter((_, k) => k !== i) })} />
        </div>
      ))}
      <Add
        disabled={spec.events.length >= ANIMATOR_LIMITS.events || clipNames.length === 0}
        onClick={() => set({ events: [...spec.events, { clip: clipNames[0]!, time: 0, name: fresh("step", spec.events.map((e) => e.name)) }] })}
      >
        Event
      </Add>

      <button type="button" className={styles.toolBtn} style={{ marginTop: 10 }} onClick={() => save(null)}>
        Remove state machine
      </button>
      <RailHint>
        {`In code: cartbox.set(${name}, "${spec.params[0]?.name ?? "speed"}", value), cartbox.trigger(…) for triggers, cartbox.state(${name}) for the state, cartbox.events(${name}) for events that just fired. "After" is how far through the clip (1 = once through) before a transition may fire.`}
      </RailHint>
    </RailGroup>
  );
}
