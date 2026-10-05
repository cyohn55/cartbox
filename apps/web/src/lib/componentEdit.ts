/**
 * Editing components in the Mesh tab (ENGINE_PARITY_ROADMAP.md EP14): the
 * cart's component scripts, and attaching them to objects with per-object
 * field values. Pure sidecar → sidecar steps; see components.ts in
 * @cartbox/editor for what a component is.
 */

import { MAX_COMPONENTS, compileScriptGraph, componentTemplate, componentValues, emptyScriptGraph, type AttachedComponent, type ComponentDef, type ComponentValue, type ScriptGraph } from "@cartbox/editor";

import { setMeshAttached, setMeshComponents, type MeshSidecar } from "./meshSidecar";

const NAME = /^[A-Za-z_]\w{0,31}$/;

/** A name not yet taken: `base`, else `base2`, `base3` … */
function freeName(taken: readonly ComponentDef[], base: string): string {
  const names = new Set(taken.map((d) => d.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n += 1) if (!names.has(`${base}${n}`)) return `${base}${n}`;
}

/** Add a component script (from the starter template); null when the cart has as many as it may. */
export function addComponent(sidecar: MeshSidecar, base = "Behaviour"): { sidecar: MeshSidecar; name: string } | null {
  const defs = sidecar.components ?? [];
  if (defs.length >= MAX_COMPONENTS) return null;
  const name = freeName(defs, NAME.test(base) ? base : "Behaviour");
  return { sidecar: setMeshComponents(sidecar, [...defs, { name, code: componentTemplate(name) }]), name };
}

/** Add a visual script (EP16): a component whose code is its graph compiled. */
export function addVisualScript(sidecar: MeshSidecar, base = "Script"): { sidecar: MeshSidecar; name: string } | null {
  const defs = sidecar.components ?? [];
  if (defs.length >= MAX_COMPONENTS) return null;
  const name = freeName(defs, base);
  const graph = emptyScriptGraph();
  return { sidecar: setMeshComponents(sidecar, [...defs, { name, code: compileScriptGraph(graph, name), graph }]), name };
}

/** Replace a visual script's graph (its code follows). */
export function setComponentGraph(sidecar: MeshSidecar, name: string, graph: ScriptGraph): MeshSidecar {
  return setMeshComponents(sidecar, (sidecar.components ?? []).map((d) => (d.name === name ? { name, code: compileScriptGraph(graph, name), graph } : d)));
}

/**
 * Change a script's code, or rename it — a rename follows it onto every object
 * (and prefab node) it's attached to. An invalid or taken name is refused (null).
 */
export function updateComponent(sidecar: MeshSidecar, name: string, patch: { name?: string; code?: string }): MeshSidecar | null {
  const defs = sidecar.components ?? [];
  const to = patch.name ?? name;
  if (!NAME.test(to) || (to !== name && defs.some((d) => d.name === to))) return null;
  const next = defs.map((d) => (d.name === name ? (d.graph ? { name: to, code: compileScriptGraph(d.graph, to), graph: d.graph } : { name: to, code: patch.code ?? d.code }) : d));
  if (to === name) return setMeshComponents(sidecar, next);
  const rename = <T extends { components?: readonly AttachedComponent[] }>(item: T): T =>
    item.components?.some((c) => c.name === name) ? { ...item, components: item.components.map((c) => (c.name === name ? { ...c, name: to } : c)) } : item;
  const renamed: MeshSidecar = {
    ...sidecar,
    meshes: sidecar.meshes.map(rename),
    ...(sidecar.prefabs ? { prefabs: sidecar.prefabs.map((p) => ({ ...p, nodes: p.nodes.map(rename) })) } : {}),
  };
  return setMeshComponents(renamed, next);
}

/** Delete a script; it comes off every object it was on. */
export function removeComponent(sidecar: MeshSidecar, name: string): MeshSidecar {
  return setMeshComponents(sidecar, (sidecar.components ?? []).filter((d) => d.name !== name));
}

/** The components on one object. */
export function attachedTo(sidecar: MeshSidecar, id: string): readonly AttachedComponent[] {
  return sidecar.meshes.find((m) => m.id === id)?.components ?? [];
}

/** Attach a script to an object (once; its fields start at the defaults). */
export function attachComponent(sidecar: MeshSidecar, id: string, name: string): MeshSidecar {
  const on = attachedTo(sidecar, id);
  if (on.some((c) => c.name === name)) return sidecar;
  return setMeshAttached(sidecar, id, [...on, { name, fields: {} }]);
}

/** Take a script off an object. */
export function detachComponent(sidecar: MeshSidecar, id: string, name: string): MeshSidecar {
  return setMeshAttached(sidecar, id, attachedTo(sidecar, id).filter((c) => c.name !== name));
}

/** Set one field of an object's component; setting it back to the default stops storing it. */
export function setComponentField(sidecar: MeshSidecar, id: string, name: string, field: string, value: ComponentValue): MeshSidecar {
  const def = (sidecar.components ?? []).find((d) => d.name === name);
  if (!def) return sidecar;
  const defaults = componentValues(def, null);
  return setMeshAttached(
    sidecar,
    id,
    attachedTo(sidecar, id).map((c) => {
      if (c.name !== name) return c;
      const { [field]: _drop, ...fields } = c.fields;
      void _drop;
      return { ...c, fields: value === defaults[field] ? fields : { ...fields, [field]: value } };
    }),
  );
}
