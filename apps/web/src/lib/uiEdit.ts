/**
 * Editing UI documents (ENGINE_PARITY_ROADMAP.md EP13): the document list on
 * the sidecar, and a document's widget tree — find, change, add (at the top
 * or inside a widget), remove, and reorder. Pure: the UI tab and the tests
 * share it. See ui.ts in @cartbox/editor.
 */

import { newUiWidget, type UiDocument, type UiKind, type UiWidget } from "@cartbox/editor";

import { setMeshUi, type MeshSidecar } from "./meshSidecar";

export function uiDocuments(sidecar: MeshSidecar): readonly UiDocument[] {
  return sidecar.ui ?? [];
}

/** Add an empty document (a unique name from `base`). */
export function addUiDocument(sidecar: MeshSidecar, base = "screen"): { sidecar: MeshSidecar; name: string } {
  const taken = new Set(uiDocuments(sidecar).map((d) => d.name));
  let name = base;
  for (let k = 2; taken.has(name); k += 1) name = `${base}${k}`;
  return { sidecar: setMeshUi(sidecar, [...uiDocuments(sidecar), { name, widgets: [] }]), name };
}

/** Store an edited document in place of the one with `name` (a rename takes `doc.name`). */
export function replaceUiDocument(sidecar: MeshSidecar, name: string, doc: UiDocument): MeshSidecar {
  return setMeshUi(sidecar, uiDocuments(sidecar).map((d) => (d.name === name ? doc : d)));
}

export function removeUiDocument(sidecar: MeshSidecar, name: string): MeshSidecar {
  return setMeshUi(sidecar, uiDocuments(sidecar).filter((d) => d.name !== name));
}

/** Every widget of a document, depth-first, with how deep it sits. */
export function flattenWidgets(widgets: readonly UiWidget[], depth = 0): { widget: UiWidget; depth: number }[] {
  return widgets.flatMap((w) => [{ widget: w, depth }, ...flattenWidgets(w.children ?? [], depth + 1)]);
}

export function findWidget(doc: UiDocument, id: string): UiWidget | null {
  return flattenWidgets(doc.widgets).find((f) => f.widget.id === id)?.widget ?? null;
}

/** A tree with one widget changed (by id). */
function mapWidgets(widgets: readonly UiWidget[], id: string, change: (w: UiWidget) => UiWidget | null): UiWidget[] {
  const out: UiWidget[] = [];
  for (const w of widgets) {
    if (w.id === id) {
      const next = change(w);
      if (next) out.push(next);
      continue;
    }
    out.push(w.children?.length ? { ...w, children: mapWidgets(w.children, id, change) } : w);
  }
  return out;
}

/** Change a widget's fields (an `undefined` in the patch removes that field). */
export function updateWidget(doc: UiDocument, id: string, patch: Partial<UiWidget>): UiDocument {
  return {
    ...doc,
    widgets: mapWidgets(doc.widgets, id, (w) => {
      const next = { ...w, ...patch } as Record<string, unknown>;
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
      return next as unknown as UiWidget;
    }),
  };
}

export function removeWidget(doc: UiDocument, id: string): UiDocument {
  return { ...doc, widgets: mapWidgets(doc.widgets, id, () => null) };
}

/** A widget id not yet used in the document: `kind1`, `kind2`… */
export function freeWidgetId(doc: UiDocument, kind: string): string {
  const taken = new Set(flattenWidgets(doc.widgets).map((f) => f.widget.id));
  for (let k = 1; ; k += 1) if (!taken.has(`${kind}${k}`)) return `${kind}${k}`;
}

/** Add a widget of `kind` at the top level, or inside the widget `parent`. Returns the new id. */
export function addWidget(doc: UiDocument, kind: UiKind, parent: string | null = null): { doc: UiDocument; id: string } {
  const id = freeWidgetId(doc, kind);
  const widget = newUiWidget(kind, id);
  if (!parent || !findWidget(doc, parent)) return { doc: { ...doc, widgets: [...doc.widgets, widget] }, id };
  return { doc: { ...doc, widgets: mapWidgets(doc.widgets, parent, (w) => ({ ...w, children: [...(w.children ?? []), widget] })) }, id };
}

/** Move a widget one place earlier (−1, drawn sooner: under) or later (+1, over) among its siblings. */
export function reorderWidget(doc: UiDocument, id: string, step: -1 | 1): UiDocument {
  const move = (list: readonly UiWidget[]): UiWidget[] => {
    const i = list.findIndex((w) => w.id === id);
    if (i >= 0) {
      const j = i + step;
      if (j < 0 || j >= list.length) return [...list];
      const out = [...list];
      [out[i], out[j]] = [out[j]!, out[i]!];
      return out;
    }
    return list.map((w) => (w.children?.length ? { ...w, children: move(w.children) } : w));
  };
  return { ...doc, widgets: move(doc.widgets) };
}
