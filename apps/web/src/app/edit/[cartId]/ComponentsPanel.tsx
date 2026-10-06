"use client";

/**
 * Components in the Mesh tab (ENGINE_PARITY_ROADMAP.md EP14): the cart's
 * component scripts (scene-wide, written here), and on the selected object the
 * ones attached to it with its field values — the way an inspector lists a
 * Unity object's components. See components.ts in @cartbox/editor.
 */

import { useState } from "react";

import { componentCallbacks, componentFields, componentValues, type ComponentField, type ComponentValue } from "@cartbox/editor";

import { addComponent, addVisualScript, attachComponent, attachedTo, detachComponent, removeComponent, setComponentField, setComponentGraph, updateComponent } from "@/lib/componentEdit";
import { ScriptGraphEditor } from "./ScriptGraphEditor";
import { type MeshSidecar, type MeshSidecarEntry } from "@/lib/meshSidecar";
import { RailGroup, RailHint } from "./railControls";

const box = { border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: 6 } as const;
const row = { fontSize: 12, display: "flex", gap: 6, alignItems: "center" } as const;

/** The scene's component scripts: add, rename, write, delete. */
export function ComponentScriptsPanel({ sidecar, onChange }: { sidecar: MeshSidecar; onChange: (next: MeshSidecar) => void }) {
  const defs = sidecar.components ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editingDef = defs.find((d) => d.name === editing && d.graph);
  const uses = (name: string) => sidecar.meshes.filter((m) => m.components?.some((c) => c.name === name)).length;

  return (
    <RailGroup label="Components" collapsible defaultOpen={defs.length > 0}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {defs.map((def) => (
          <div key={def.name} style={box}>
            <button type="button" className="cbx-btn" style={{ width: "100%", textAlign: "left" }} onClick={() => setOpen(open === def.name ? null : def.name)} aria-expanded={open === def.name}>
              {def.name}
              <span style={{ opacity: 0.55, fontSize: 11 }}>
                {" "}
                · {def.graph ? "visual script" : componentCallbacks(def.code).join(", ") || "no callbacks"} · on {uses(def.name)}
              </span>
            </button>
            {open === def.name && (
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                <input
                  aria-label="Component name"
                  defaultValue={def.name}
                  onBlur={(event) => {
                    const to = event.target.value.trim();
                    if (to === def.name) return;
                    const next = updateComponent(sidecar, def.name, { name: to });
                    setError(next ? null : "A name is letters, digits and _ (not starting with a digit), and not one already used.");
                    if (next) {
                      onChange(next);
                      setOpen(to);
                    } else event.target.value = def.name;
                  }}
                />
                {def.graph && (
                  <button type="button" className="cbx-btn" onClick={() => setEditing(def.name)}>
                    Edit graph
                  </button>
                )}
                <textarea
                  aria-label={`${def.name} script`}
                  readOnly={Boolean(def.graph)}
                  key={def.graph ? def.code : def.name}
                  defaultValue={def.code}
                  spellCheck={false}
                  rows={14}
                  style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, resize: "vertical", tabSize: 2 }}
                  onKeyDown={(event) => {
                    if (event.key !== "Tab") return;
                    event.preventDefault();
                    const t = event.currentTarget;
                    t.setRangeText("  ", t.selectionStart, t.selectionEnd, "end");
                  }}
                  onBlur={(event) => !def.graph && event.target.value !== def.code && onChange(updateComponent(sidecar, def.name, { code: event.target.value }) ?? sidecar)}
                />
                <RailHint>
                  Fields: {componentFields(def.code).map((f) => `${f.name} (${f.type})`).join(", ") || "none — declare one with “-- @field speed number 2”"}.
                </RailHint>
                <button type="button" className="cbx-btn" onClick={() => onChange(removeComponent(sidecar, def.name))}>
                  Delete {def.name}
                </button>
              </div>
            )}
          </div>
        ))}
        <button
          type="button"
          className="cbx-btn"
          onClick={() => {
            const made = addComponent(sidecar);
            if (!made) return setError("A cart holds up to 64 components.");
            setError(null);
            onChange(made.sidecar);
            setOpen(made.name);
          }}
        >
          + New component
        </button>
        <button
          type="button"
          className="cbx-btn"
          onClick={() => {
            const made = addVisualScript(sidecar);
            if (!made) return setError("A cart holds up to 64 components.");
            setError(null);
            onChange(made.sidecar);
            setOpen(made.name);
            setEditing(made.name);
          }}
        >
          + New visual script
        </button>
        {editingDef?.graph && (
          <ScriptGraphEditor name={editingDef.name} graph={editingDef.graph} onChange={(graph) => onChange(setComponentGraph(sidecar, editingDef.name, graph))} onClose={() => setEditing(null)} />
        )}
        {error && <RailHint>{error}</RailHint>}
        <RailHint>
          A component is a Lua behaviour — start(self), update(self, dt), collision(self, other, started), trigger(self, other, entered) — attached to objects
          in the inspector. self.obj is the object; cartbox.component(obj, name) reads another&apos;s.
        </RailHint>
      </div>
    </RailGroup>
  );
}

function FieldInput({ field, value, objects, onChange }: { field: ComponentField; value: ComponentValue; objects: readonly string[]; onChange: (value: ComponentValue) => void }) {
  const label = `${field.name}`;
  switch (field.type) {
    case "bool":
      return (
        <label style={row}>
          <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
          {label}
        </label>
      );
    case "number":
      return (
        <label style={row}>
          <span style={{ minWidth: 70 }}>{label}</span>
          <input
            type="number"
            aria-label={label}
            defaultValue={String(value)}
            key={String(value)}
            step="any"
            style={{ flex: 1, minWidth: 0 }}
            onBlur={(event) => Number.isFinite(Number(event.target.value)) && event.target.value !== "" && onChange(Number(event.target.value))}
          />
        </label>
      );
    case "object":
      return (
        <label style={row}>
          <span style={{ minWidth: 70 }}>{label}</span>
          <select aria-label={label} value={String(value)} onChange={(event) => onChange(event.target.value)} style={{ flex: 1, minWidth: 0 }}>
            <option value="">(none)</option>
            {[...new Set(String(value) ? [...objects, String(value)] : objects)].map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      );
    case "text":
      return (
        <label style={row}>
          <span style={{ minWidth: 70 }}>{label}</span>
          <input aria-label={label} defaultValue={String(value)} key={String(value)} maxLength={200} style={{ flex: 1, minWidth: 0 }} onBlur={(event) => onChange(event.target.value)} />
        </label>
      );
  }
}

/** The selected object's components: attach one, set its fields, take it off. */
export function ComponentsInspector({ sidecar, entry, onChange }: { sidecar: MeshSidecar; entry: MeshSidecarEntry; onChange: (next: MeshSidecar) => void }) {
  const defs = sidecar.components ?? [];
  const on = attachedTo(sidecar, entry.id);
  const free = defs.filter((d) => !on.some((c) => c.name === d.name));
  const objects = [...new Set(sidecar.meshes.filter((m) => m.id !== entry.id).map((m) => m.name))];
  if (defs.length === 0 && on.length === 0) return null;

  return (
    <RailGroup label="Components" collapsible defaultOpen={on.length > 0}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {on.map((attached) => {
          const def = defs.find((d) => d.name === attached.name);
          if (!def) return null;
          const values = componentValues(def, attached);
          return (
            <div key={attached.name} style={box}>
              <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                <strong style={{ flex: 1, fontSize: 12 }}>{attached.name}</strong>
                <button type="button" className="cbx-btn" aria-label={`Remove ${attached.name}`} title="Remove from this object" onClick={() => onChange(detachComponent(sidecar, entry.id, attached.name))}>
                  ✕
                </button>
              </div>
              {componentFields(def.code).map((field) => (
                <FieldInput key={field.name} field={field} value={values[field.name]!} objects={objects} onChange={(value) => onChange(setComponentField(sidecar, entry.id, attached.name, field.name, value))} />
              ))}
            </div>
          );
        })}
        {free.length > 0 && (
          <select aria-label="Add component" value="" onChange={(event) => event.target.value && onChange(attachComponent(sidecar, entry.id, event.target.value))}>
            <option value="">+ Add component…</option>
            {free.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
        )}
      </div>
    </RailGroup>
  );
}
