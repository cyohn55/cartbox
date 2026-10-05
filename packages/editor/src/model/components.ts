/**
 * Components (ENGINE_PARITY_ROADMAP.md EP14): reusable Lua behaviours
 * attached to scene objects in the inspector, the way Unity's components work.
 *
 * A component is a named Lua script that defines any of five callbacks —
 *
 *   function start(self)                       once, on its first tick
 *   function update(self, dt)                  every tick (dt in seconds), before the cart's TIC
 *   function late(self, dt)                    every tick, after the cart's TIC (so a pose it
 *                                              sets survives the cart's cartbox.clearposes)
 *   function collision(self, other, started)   it touched (or stopped touching) another object
 *   function trigger(self, other, entered)     it entered (or left) a trigger zone, or something
 *                                              entered (or left) it, when it is one
 *
 * — and declares the fields the inspector edits with lines like
 * `-- @field speed number 2.5`, `-- @field label text Door`, `-- @field armed
 * bool true` or `-- @field target object`. Attached to an object, each copy
 * gets its own `self`: its fields (the object's values, else the defaults),
 * `self.obj` (the object, for cartbox.* calls), `self.origin` ({x, y, z},
 * where the scene placed it — cartbox.place moves it) and anything the script
 * keeps there. Each script runs in its own environment, so its functions and
 * top-level variables don't collide with the cart's or another component's.
 *
 * Pure and DOM-free: this parses scripts and attachments; the player wraps
 * them into the cart's Lua (componentsSdk.ts).
 */

import { compileScriptGraph, parseScriptGraph, type ScriptGraph } from "./scriptGraph";

export type ComponentFieldType = "number" | "bool" | "text" | "object";
export type ComponentValue = number | boolean | string;

export interface ComponentField {
  readonly name: string;
  readonly type: ComponentFieldType;
  readonly default: ComponentValue;
}

/**
 * A component script: its name and its Lua. Its fields come from its `@field`
 * lines. A visual script (EP16) also carries its graph, and its code is always
 * the graph compiled.
 */
export interface ComponentDef {
  readonly name: string;
  readonly code: string;
  readonly graph?: ScriptGraph;
}

/** A component on an object: which script, and the field values set for this object. */
export interface AttachedComponent {
  readonly name: string;
  readonly fields: Readonly<Record<string, ComponentValue>>;
}

export const MAX_COMPONENTS = 64;
export const MAX_COMPONENT_CODE = 16000;
export const COMPONENT_CALLBACKS = ["start", "update", "late", "collision", "trigger"] as const;

const NAME = /^[A-Za-z_]\w{0,31}$/;

function parseDefault(type: ComponentFieldType, raw: string | undefined): ComponentValue {
  const text = (raw ?? "").trim();
  switch (type) {
    case "number":
      return Number.isFinite(Number(text)) && text !== "" ? Number(text) : 0;
    case "bool":
      return text === "true";
    case "text":
    case "object":
      return text;
  }
}

/** A script's declared fields, from its `-- @field name type [default]` lines (first declaration of a name wins). */
export function componentFields(code: string): ComponentField[] {
  const out: ComponentField[] = [];
  const seen = new Set<string>();
  for (const line of code.split("\n")) {
    const m = /^\s*--\s*@field\s+([A-Za-z_]\w*)\s+(number|bool|text|object)\b(.*)$/.exec(line);
    if (!m || seen.has(m[1]!) || m[1] === "obj" || m[1] === "origin") continue;
    seen.add(m[1]!);
    out.push({ name: m[1]!, type: m[2] as ComponentFieldType, default: parseDefault(m[2] as ComponentFieldType, m[3]) });
  }
  return out;
}

/** Which callbacks a script defines (by its `function name(` lines). */
export function componentCallbacks(code: string): (typeof COMPONENT_CALLBACKS)[number][] {
  return COMPONENT_CALLBACKS.filter((cb) => new RegExp(`^\\s*function\\s+${cb}\\s*\\(`, "m").test(code));
}

/** An attached component's values for every declared field: what the object sets, else the default (wrong types fall back). */
export function componentValues(def: ComponentDef, attached: AttachedComponent | null): Record<string, ComponentValue> {
  const out: Record<string, ComponentValue> = {};
  for (const f of componentFields(def.code)) {
    const v = attached?.fields[f.name];
    const ok = f.type === "number" ? typeof v === "number" && Number.isFinite(v) : f.type === "bool" ? typeof v === "boolean" : typeof v === "string";
    out[f.name] = ok ? v! : f.default;
  }
  return out;
}

/** Read stored component scripts defensively (names unique and Lua-safe, code capped). */
export function parseComponentDefs(value: unknown): ComponentDef[] {
  if (!Array.isArray(value)) return [];
  const out: ComponentDef[] = [];
  const names = new Set<string>();
  for (const raw of value) {
    const r = raw as { name?: unknown; code?: unknown; graph?: unknown } | null;
    if (!r || typeof r.name !== "string" || !NAME.test(r.name) || names.has(r.name)) continue;
    const graph = r.graph !== undefined ? parseScriptGraph(r.graph) : null;
    if (!graph && typeof r.code !== "string") continue;
    if (out.length >= MAX_COMPONENTS) break;
    names.add(r.name);
    // A graph's code is recompiled, never trusted as stored: the two can't drift apart.
    out.push(graph ? { name: r.name, code: compileScriptGraph(graph, r.name), graph } : { name: r.name, code: (r.code as string).slice(0, MAX_COMPONENT_CODE) });
  }
  return out;
}

/** Read an object's attached components defensively (only known scripts, each once, values of plain types). */
export function parseAttached(value: unknown, known?: ReadonlySet<string>): AttachedComponent[] {
  if (!Array.isArray(value)) return [];
  const out: AttachedComponent[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const r = raw as { name?: unknown; fields?: unknown } | null;
    if (!r || typeof r.name !== "string" || !NAME.test(r.name) || seen.has(r.name) || (known && !known.has(r.name))) continue;
    seen.add(r.name);
    const fields: Record<string, ComponentValue> = {};
    if (r.fields && typeof r.fields === "object") {
      for (const [k, v] of Object.entries(r.fields as Record<string, unknown>)) {
        if (!NAME.test(k)) continue;
        if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean" || (typeof v === "string" && v.length <= 200)) fields[k] = v;
      }
    }
    out.push({ name: r.name, fields });
  }
  return out;
}

/** A new component's starter script. */
export function componentTemplate(name: string): string {
  return `-- ${name}: attach it to objects in the inspector.
-- @field speed number 1

function start(self)
  -- once, on its first tick. self.obj is the object.
end

function update(self, dt)
  -- every tick, before the cart's TIC; dt is in seconds.
end

function late(self, dt)
  -- every tick, after the cart's TIC (pose objects here: cartbox.meshpose).
end

function collision(self, other, started)
  -- it touched (started) or stopped touching another object.
end

function trigger(self, other, entered)
  -- it entered or left a trigger zone (or something entered or left it).
end
`;
}
