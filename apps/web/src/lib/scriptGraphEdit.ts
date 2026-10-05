/**
 * Editing a visual script (ENGINE_PARITY_ROADMAP.md EP16): pure graph → graph
 * steps for the script graph editor, and where each node's pins sit on the
 * canvas. See scriptGraph.ts in @cartbox/editor for the graph itself.
 */

import { SCRIPT_NODES, pinsConnect, type PinDef, type ScriptGraph, type ScriptNode, type ScriptNodeKind, type ScriptValue, type ScriptVariable } from "@cartbox/editor";

export const SCRIPT_NODE_WIDTH = 200;
export const SCRIPT_NODE_HEADER = 26;
export const SCRIPT_PARAM_ROW = 26;
export const SCRIPT_ROW = 24;

const defOf = (kind: ScriptNodeKind) => SCRIPT_NODES[kind] as { inputs: readonly PinDef[]; outputs: readonly PinDef[]; param?: { label: string; value: string } };

/** Height of a node on the canvas. */
export function scriptNodeHeight(node: Pick<ScriptNode, "kind">): number {
  const def = defOf(node.kind);
  return SCRIPT_NODE_HEADER + (def.param ? SCRIPT_PARAM_ROW : 0) + Math.max(def.inputs.length, def.outputs.length) * SCRIPT_ROW + 6;
}

/** Where a pin sits: inputs on the left edge, outputs on the right. */
export function scriptPinAt(node: ScriptNode, side: "in" | "out", pin: string): { x: number; y: number } {
  const def = defOf(node.kind);
  const list = side === "in" ? def.inputs : def.outputs;
  const i = Math.max(0, list.findIndex((p) => p.name === pin));
  return { x: node.x + (side === "in" ? 0 : SCRIPT_NODE_WIDTH), y: node.y + SCRIPT_NODE_HEADER + (def.param ? SCRIPT_PARAM_ROW : 0) + i * SCRIPT_ROW + SCRIPT_ROW / 2 };
}

/** A spot near `at` clear of the other nodes. */
export function freeScriptSpot(graph: ScriptGraph, at: { x: number; y: number }, kind: ScriptNodeKind): { x: number; y: number } {
  const h = scriptNodeHeight({ kind });
  const x = at.x;
  let y = at.y;
  for (let tries = 0; tries < 40; tries += 1) {
    const hit = graph.nodes.some((n) => x < n.x + SCRIPT_NODE_WIDTH + 20 && x + SCRIPT_NODE_WIDTH + 20 > n.x && y < n.y + scriptNodeHeight(n) + 20 && y + h + 20 > n.y);
    if (!hit) break;
    y += 40;
  }
  return { x: Math.round(x), y: Math.round(y) };
}

function nextId(graph: ScriptGraph): string {
  let n = graph.nodes.length + 1;
  const ids = new Set(graph.nodes.map((x) => x.id));
  while (ids.has(`n${n}`)) n += 1;
  return `n${n}`;
}

export function addScriptNode(graph: ScriptGraph, kind: ScriptNodeKind, at: { x: number; y: number }): { graph: ScriptGraph; id: string } {
  const id = nextId(graph);
  const def = defOf(kind);
  const node: ScriptNode = { id, kind, x: at.x, y: at.y, ...(def.param ? { param: def.param.value } : {}) };
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, id };
}

export function moveScriptNode(graph: ScriptGraph, id: string, x: number, y: number): ScriptGraph {
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === id ? { ...n, x: Math.round(x), y: Math.round(y) } : n)) };
}

export function removeScriptNode(graph: ScriptGraph, id: string): ScriptGraph {
  return { ...graph, nodes: graph.nodes.filter((n) => n.id !== id), wires: graph.wires.filter((w) => w.from !== id && w.to !== id) };
}

/**
 * Wire an output pin to an input pin, when their kinds connect. An exec output
 * leads to one place and a data input takes one value, so a wire there
 * replaces the old one. Null when the pins don't connect.
 */
export function connectScriptPins(graph: ScriptGraph, from: string, fromPin: string, to: string, toPin: string): ScriptGraph | null {
  const a = graph.nodes.find((n) => n.id === from);
  const b = graph.nodes.find((n) => n.id === to);
  if (!a || !b || a === b) return null;
  const out = defOf(a.kind).outputs.find((p) => p.name === fromPin);
  const input = defOf(b.kind).inputs.find((p) => p.name === toPin);
  if (!out || !input || !pinsConnect(out.type, input.type)) return null;
  const wires = graph.wires.filter((w) => (out.type === "exec" ? !(w.from === from && w.fromPin === fromPin) : !(w.to === to && w.toPin === toPin)));
  return { ...graph, wires: [...wires, { from, fromPin, to, toPin }] };
}

/** Take the wires off an input pin. */
export function disconnectScriptInput(graph: ScriptGraph, to: string, toPin: string): ScriptGraph {
  return { ...graph, wires: graph.wires.filter((w) => !(w.to === to && w.toPin === toPin)) };
}

export function setScriptParam(graph: ScriptGraph, id: string, param: string): ScriptGraph {
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === id ? { ...n, param } : n)) };
}

/** Set the value an unwired input uses. */
export function setScriptValue(graph: ScriptGraph, id: string, pin: string, value: ScriptValue): ScriptGraph {
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === id ? { ...n, values: { ...n.values, [pin]: value } } : n)) };
}

const VAR_NAME = /^[A-Za-z_]\w{0,31}$/;

/** Add a variable (a free name like `value`, `value2` …). */
export function addScriptVariable(graph: ScriptGraph, type: ScriptVariable["type"] = "number"): ScriptGraph {
  const names = new Set(graph.variables.map((v) => v.name));
  let name = "value";
  for (let n = 2; names.has(name); n += 1) name = `value${n}`;
  return { ...graph, variables: [...graph.variables, { name, type, value: type === "number" ? 0 : type === "bool" ? false : "" }] };
}

/**
 * Change a variable; a rename follows it onto the nodes that get or set it.
 * Null when the name is invalid or taken.
 */
export function updateScriptVariable(graph: ScriptGraph, name: string, patch: Partial<ScriptVariable>): ScriptGraph | null {
  const to = patch.name ?? name;
  if (!VAR_NAME.test(to) || to === "obj" || to === "origin" || (to !== name && graph.variables.some((v) => v.name === to))) return null;
  const variables = graph.variables.map((v) => {
    if (v.name !== name) return v;
    const type = patch.type ?? v.type;
    const value = patch.value ?? (type !== v.type ? (type === "number" ? 0 : type === "bool" ? false : "") : v.value);
    return { name: to, type, value };
  });
  const nodes = to === name ? graph.nodes : graph.nodes.map((n) => ((n.kind === "getVar" || n.kind === "setVar") && n.param === name ? { ...n, param: to } : n));
  return { ...graph, variables, nodes };
}

export function removeScriptVariable(graph: ScriptGraph, name: string): ScriptGraph {
  return { ...graph, variables: graph.variables.filter((v) => v.name !== name) };
}
