/**
 * Visual scripting (ENGINE_PARITY_ROADMAP.md EP16): gameplay logic as a node
 * graph, in the spirit of Unreal's Blueprints, that compiles to Lua.
 *
 * A graph is a component (see components.ts): its compiled Lua is the
 * component's script, so it attaches to objects in the inspector, its
 * variables are the component's fields, and it runs where components run.
 *
 * - **Events** start a chain of actions: when the object starts, every tick,
 *   when an input action is pressed, every few seconds, on a collision or a
 *   trigger.
 * - **Execution wires** (from a node's "then" to the next node's "in") order
 *   the actions; **flow** nodes branch, sequence and loop.
 * - **Data wires** feed values into an action's inputs from value nodes
 *   (constants, variables, the object, time, maths, comparisons) — pure, so
 *   they compile to expressions. An unwired input uses the value typed on it.
 *
 * Pure and DOM-free: the node set, defensive reading, and the compiler.
 */

export type PinType = "exec" | "number" | "bool" | "text" | "object" | "any";
export type ScriptValue = number | boolean | string;

export interface PinDef {
  readonly name: string;
  readonly type: PinType;
  /** What an unwired data input uses. */
  readonly value?: ScriptValue;
}

export type ScriptCategory = "event" | "flow" | "action" | "value" | "maths";

export interface ScriptNodeDef {
  readonly label: string;
  readonly category: ScriptCategory;
  readonly inputs: readonly PinDef[];
  readonly outputs: readonly PinDef[];
  /** A name the node is set to (an input action, a sound, a variable, a cart function …). */
  readonly param?: { readonly label: string; readonly value: string };
  readonly doc: string;
}

const exec = (name = "in"): PinDef => ({ name, type: "exec" });
const then = (name = "then"): PinDef => ({ name, type: "exec" });
const num = (name: string, value = 0): PinDef => ({ name, type: "number", value });
const bool = (name: string, value = false): PinDef => ({ name, type: "bool", value });
const text = (name: string, value = ""): PinDef => ({ name, type: "text", value });
const obj = (name: string): PinDef => ({ name, type: "object" });
const any = (name: string): PinDef => ({ name, type: "any", value: 0 });
const binary = (label: string, doc: string): ScriptNodeDef => ({ label, category: "maths", inputs: [num("a"), num("b")], outputs: [num("out")], doc });
const compare = (label: string, doc: string): ScriptNodeDef => ({ label, category: "maths", inputs: [any("a"), any("b")], outputs: [bool("out")], doc });

/** The node set. */
export const SCRIPT_NODES = {
  // Events
  onStart: { label: "On start", category: "event", inputs: [], outputs: [then()], doc: "When the object starts (and again when a spawned copy comes back)." },
  onTick: { label: "Every tick", category: "event", inputs: [], outputs: [then(), num("dt")], doc: "Every tick, before the cart's own code; dt is the tick's length in seconds." },
  onAction: { label: "On action", category: "event", inputs: [], outputs: [then()], param: { label: "Action", value: "fire" }, doc: "When an input action (the Input tab) is pressed." },
  onTimer: { label: "Every … seconds", category: "event", inputs: [], outputs: [then()], param: { label: "Seconds", value: "1" }, doc: "Every so many seconds." },
  onCollision: { label: "On collision", category: "event", inputs: [], outputs: [then(), obj("other"), bool("started")], doc: "When the object touches (or stops touching) another." },
  onTrigger: { label: "On trigger", category: "event", inputs: [], outputs: [then(), obj("other"), bool("entered")], doc: "When the object enters or leaves a trigger zone (or something enters or leaves it)." },
  // Flow
  branch: { label: "Branch", category: "flow", inputs: [exec(), bool("condition", true)], outputs: [then("true"), then("false")], doc: "Go one way when the condition holds, the other when it doesn't." },
  sequence: { label: "Sequence", category: "flow", inputs: [exec()], outputs: [then("first"), then("second"), then("third")], doc: "Run three chains, one after another." },
  loop: { label: "Loop", category: "flow", inputs: [exec(), num("from", 1), num("to", 3)], outputs: [then("body"), num("index"), then("done")], doc: "Run the body once per number from … to …, then carry on." },
  // Actions
  setVar: { label: "Set variable", category: "action", inputs: [exec(), any("value")], outputs: [then()], param: { label: "Variable", value: "count" }, doc: "Store a value in one of the graph's variables (its fields in the inspector)." },
  place: { label: "Place object", category: "action", inputs: [exec(), obj("object"), num("x"), num("y"), num("z"), num("yaw"), num("scale", 1)], outputs: [then()], doc: "Put an object somewhere (world space; yaw in radians; scale 0 hides it)." },
  spawn: { label: "Spawn prefab", category: "action", inputs: [exec(), num("x"), num("y"), num("z"), num("yaw")], outputs: [then(), obj("copy")], param: { label: "Prefab", value: "" }, doc: "Bring a copy of a prefab into the world there." },
  despawn: { label: "Despawn", category: "action", inputs: [exec(), obj("object")], outputs: [then()], doc: "Put a spawned copy back in reserve." },
  sound: { label: "Play sound", category: "action", inputs: [exec(), num("x"), num("y"), num("z"), bool("at a place")], outputs: [then()], param: { label: "Sound", value: "" }, doc: "Play one of the scene's sounds, at a place or everywhere." },
  uiSet: { label: "Set UI value", category: "action", inputs: [exec(), any("value")], outputs: [then()], param: { label: "Binding", value: "score" }, doc: "Set a UI binding ({key} in text, a bar's fill …)." },
  uiShow: { label: "Show UI", category: "action", inputs: [exec(), bool("shown", true)], outputs: [then()], param: { label: "Document", value: "hud" }, doc: "Put a UI document up (or take it down)." },
  score: { label: "Post score", category: "action", inputs: [exec(), num("score")], outputs: [then()], doc: "Post a score to the cart's leaderboard." },
  print: { label: "Print", category: "action", inputs: [exec(), any("message")], outputs: [then()], doc: "Write to the playtest's console." },
  call: { label: "Call cart function", category: "action", inputs: [exec(), any("argument")], outputs: [then(), any("result")], param: { label: "Function", value: "" }, doc: "Call a global function in the cart's own code with one argument." },
  // Values
  number: { label: "Number", category: "value", inputs: [num("value")], outputs: [num("out")], doc: "A number." },
  text: { label: "Text", category: "value", inputs: [text("value")], outputs: [text("out")], doc: "Some text." },
  bool: { label: "True / false", category: "value", inputs: [bool("value", true)], outputs: [bool("out")], doc: "True or false." },
  getVar: { label: "Get variable", category: "value", inputs: [], outputs: [any("value")], param: { label: "Variable", value: "count" }, doc: "One of the graph's variables." },
  self: { label: "This object", category: "value", inputs: [], outputs: [obj("object"), num("x"), num("y"), num("z")], doc: "The object the graph is on, and where the scene placed it." },
  find: { label: "Find object", category: "value", inputs: [], outputs: [obj("object")], param: { label: "Name", value: "" }, doc: "A scene object by name." },
  time: { label: "Time", category: "value", inputs: [], outputs: [num("seconds")], doc: "Seconds since the cart started." },
  random: { label: "Random", category: "value", inputs: [num("min"), num("max", 1)], outputs: [num("out")], doc: "A random number between min and max." },
  actionHeld: { label: "Action held", category: "value", inputs: [], outputs: [bool("held")], param: { label: "Action", value: "fire" }, doc: "Whether an input action is held." },
  callValue: { label: "Ask cart function", category: "value", inputs: [any("argument")], outputs: [any("result")], param: { label: "Function", value: "" }, doc: "What a global function in the cart's code returns for one argument." },
  // Maths and logic
  add: binary("Add", "a + b"),
  subtract: binary("Subtract", "a − b"),
  multiply: binary("Multiply", "a × b"),
  divide: binary("Divide", "a ÷ b (0 when b is 0)"),
  min: binary("Min", "The smaller of a and b."),
  max: binary("Max", "The larger of a and b."),
  sin: { label: "Sin", category: "maths", inputs: [num("x")], outputs: [num("out")], doc: "sin(x), x in radians." },
  cos: { label: "Cos", category: "maths", inputs: [num("x")], outputs: [num("out")], doc: "cos(x), x in radians." },
  abs: { label: "Abs", category: "maths", inputs: [num("x")], outputs: [num("out")], doc: "|x|" },
  floor: { label: "Floor", category: "maths", inputs: [num("x")], outputs: [num("out")], doc: "x rounded down." },
  less: compare("Less than", "a < b"),
  greater: compare("Greater than", "a > b"),
  equal: compare("Equal", "a = b"),
  and: { label: "And", category: "maths", inputs: [bool("a"), bool("b")], outputs: [bool("out")], doc: "Both." },
  or: { label: "Or", category: "maths", inputs: [bool("a"), bool("b")], outputs: [bool("out")], doc: "Either." },
  not: { label: "Not", category: "maths", inputs: [bool("a")], outputs: [bool("out")], doc: "The opposite." },
  join: { label: "Join text", category: "maths", inputs: [any("a"), any("b")], outputs: [text("out")], doc: "a followed by b, as text." },
} as const satisfies Record<string, ScriptNodeDef>;

export type ScriptNodeKind = keyof typeof SCRIPT_NODES;

export interface ScriptNode {
  readonly id: string;
  readonly kind: ScriptNodeKind;
  readonly x: number;
  readonly y: number;
  /** The node's name setting (see {@link ScriptNodeDef.param}). */
  readonly param?: string;
  /** Values typed on unwired data inputs, by pin name. */
  readonly values?: Readonly<Record<string, ScriptValue>>;
}

/** A wire from one node's output pin to another's input pin. */
export interface ScriptWire {
  readonly from: string;
  readonly fromPin: string;
  readonly to: string;
  readonly toPin: string;
}

export interface ScriptVariable {
  readonly name: string;
  readonly type: "number" | "bool" | "text" | "object";
  readonly value: ScriptValue;
}

export interface ScriptGraph {
  readonly nodes: readonly ScriptNode[];
  readonly wires: readonly ScriptWire[];
  /** The graph's variables: the component's fields, edited per object in the inspector. */
  readonly variables: readonly ScriptVariable[];
}

export const MAX_SCRIPT_NODES = 200;
const NAME = /^[A-Za-z_]\w{0,31}$/;
const ID = /^[\w-]{1,40}$/;

const isKind = (k: unknown): k is ScriptNodeKind => typeof k === "string" && Object.prototype.hasOwnProperty.call(SCRIPT_NODES, k);
const pinOf = (kind: ScriptNodeKind, side: "inputs" | "outputs", name: string): PinDef | undefined =>
  (SCRIPT_NODES[kind][side] as readonly PinDef[]).find((p) => p.name === name);
const isValue = (v: unknown): v is ScriptValue => (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean" || (typeof v === "string" && v.length <= 200);

/** Whether a wire may run from an output pin to an input pin: exec to exec, or a data value to an input that takes it. */
export function pinsConnect(out: PinType, input: PinType): boolean {
  if (out === "exec" || input === "exec") return out === input;
  return out === input || out === "any" || input === "any" || (input === "text" && out === "number");
}

/** Read a stored graph defensively: known nodes, wires between real pins of the right kinds (one per data input), valid variables. */
export function parseScriptGraph(value: unknown): ScriptGraph | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { nodes?: unknown; wires?: unknown; variables?: unknown };
  if (!Array.isArray(raw.nodes)) return null;
  const nodes: ScriptNode[] = [];
  const ids = new Set<string>();
  for (const r of raw.nodes as unknown[]) {
    const n = r as { id?: unknown; kind?: unknown; x?: unknown; y?: unknown; param?: unknown; values?: unknown } | null;
    if (!n || typeof n.id !== "string" || !ID.test(n.id) || ids.has(n.id) || !isKind(n.kind)) continue;
    if (nodes.length >= MAX_SCRIPT_NODES) break;
    ids.add(n.id);
    const values: Record<string, ScriptValue> = {};
    if (n.values && typeof n.values === "object") {
      for (const [k, v] of Object.entries(n.values as Record<string, unknown>)) if (pinOf(n.kind, "inputs", k) && isValue(v)) values[k] = v;
    }
    nodes.push({
      id: n.id,
      kind: n.kind,
      x: typeof n.x === "number" && Number.isFinite(n.x) ? n.x : 0,
      y: typeof n.y === "number" && Number.isFinite(n.y) ? n.y : 0,
      ...(typeof n.param === "string" && "param" in SCRIPT_NODES[n.kind] ? { param: n.param.slice(0, 64) } : {}),
      ...(Object.keys(values).length > 0 ? { values } : {}),
    });
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const wires: ScriptWire[] = [];
  const taken = new Set<string>();
  for (const r of Array.isArray(raw.wires) ? (raw.wires as unknown[]) : []) {
    const w = r as Partial<ScriptWire> | null;
    if (!w || typeof w.from !== "string" || typeof w.to !== "string" || typeof w.fromPin !== "string" || typeof w.toPin !== "string") continue;
    const a = byId.get(w.from);
    const b = byId.get(w.to);
    if (!a || !b || a === b) continue;
    const out = pinOf(a.kind, "outputs", w.fromPin);
    const input = pinOf(b.kind, "inputs", w.toPin);
    if (!out || !input || !pinsConnect(out.type, input.type)) continue;
    // An exec output leads to one place; a data input takes one value.
    const key = out.type === "exec" ? `o:${w.from}:${w.fromPin}` : `i:${w.to}:${w.toPin}`;
    if (taken.has(key)) continue;
    taken.add(key);
    wires.push({ from: w.from, fromPin: w.fromPin, to: w.to, toPin: w.toPin });
  }
  const variables: ScriptVariable[] = [];
  const names = new Set<string>(["obj", "origin"]);
  for (const r of Array.isArray(raw.variables) ? (raw.variables as unknown[]) : []) {
    const v = r as Partial<ScriptVariable> | null;
    if (!v || typeof v.name !== "string" || !NAME.test(v.name) || names.has(v.name) || !["number", "bool", "text", "object"].includes(v.type as string)) continue;
    names.add(v.name);
    const type = v.type as ScriptVariable["type"];
    const fallback: ScriptValue = type === "number" ? 0 : type === "bool" ? false : "";
    const ok = type === "number" ? typeof v.value === "number" && Number.isFinite(v.value) : type === "bool" ? typeof v.value === "boolean" : typeof v.value === "string";
    variables.push({ name: v.name, type, value: ok ? (v.value as ScriptValue) : fallback });
  }
  return { nodes, wires, variables };
}

const luaString = (s: string) => JSON.stringify(s);
const luaLiteral = (v: ScriptValue): string => (typeof v === "string" ? luaString(v) : typeof v === "boolean" ? String(v) : Number.isFinite(v) ? String(v) : "0");
const luaName = (s: string) => (NAME.test(s) ? s : "_");

/** Variables as the component's `-- @field` lines. */
function fieldLines(graph: ScriptGraph): string[] {
  return graph.variables.map((v) => `-- @field ${v.name} ${v.type}${v.type === "object" ? "" : ` ${v.type === "text" ? String(v.value).replace(/\n/g, " ") : String(v.value)}`}`);
}

/**
 * Compile a graph to its component's Lua: one callback per kind of event
 * (start, update, collision, trigger; action and timer events run from
 * update), each running its chains in the order the events sit on the canvas
 * (top to bottom).
 */
export function compileScriptGraph(graph: ScriptGraph, name = "Graph"): string {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const into = new Map(graph.wires.map((w) => [`${w.to}:${w.toPin}`, w]));
  const execOut = new Map(graph.wires.filter((w) => pinOf(byId.get(w.from)!.kind, "outputs", w.fromPin)?.type === "exec").map((w) => [`${w.from}:${w.fromPin}`, w]));
  const varNames = new Set(graph.variables.map((v) => v.name));
  /** Locals an event or loop provides: its output pins, by `node:pin`. */
  const locals = new Map<string, string>();

  const expr = (nodeId: string, pin: string, depth = 0): string => {
    const wire = into.get(`${nodeId}:${pin}`);
    const node = byId.get(nodeId)!;
    if (!wire) {
      const def = pinOf(node.kind, "inputs", pin);
      const v = node.values?.[pin] ?? def?.value;
      if (def?.type === "object") return "self.obj";
      return v === undefined ? "nil" : luaLiteral(v);
    }
    return value(wire.from, wire.fromPin, depth + 1);
  };
  const value = (nodeId: string, pin: string, depth: number): string => {
    if (depth > 64) return "nil";
    const local = locals.get(`${nodeId}:${pin}`);
    if (local) return local;
    const n = byId.get(nodeId)!;
    const e = (p: string) => expr(nodeId, p, depth);
    const param = n.param ?? (("param" in SCRIPT_NODES[n.kind] ? (SCRIPT_NODES[n.kind] as ScriptNodeDef).param!.value : "") as string);
    switch (n.kind) {
      case "number":
      case "text":
      case "bool":
        return e("value");
      case "getVar":
        return varNames.has(param) ? `self.${luaName(param)}` : "nil";
      case "self":
        return pin === "object" ? "self.obj" : `self.origin.${pin}`;
      case "find":
        return `cartbox.find(${luaString(param)})`;
      case "time":
        return "(time() / 1000)";
      case "random":
        return `(${e("min")} + math.random() * (${e("max")} - ${e("min")}))`;
      case "actionHeld":
        return `cartbox.action(${luaString(param)})`;
      case "callValue":
        return NAME.test(param) ? `(${param} and ${param}(${e("argument")}))` : "nil";
      case "add":
        return `(${e("a")} + ${e("b")})`;
      case "subtract":
        return `(${e("a")} - ${e("b")})`;
      case "multiply":
        return `(${e("a")} * ${e("b")})`;
      case "divide":
        return `_div(${e("a")}, ${e("b")})`;
      case "min":
        return `math.min(${e("a")}, ${e("b")})`;
      case "max":
        return `math.max(${e("a")}, ${e("b")})`;
      case "sin":
        return `math.sin(${e("x")})`;
      case "cos":
        return `math.cos(${e("x")})`;
      case "abs":
        return `math.abs(${e("x")})`;
      case "floor":
        return `math.floor(${e("x")})`;
      case "less":
        return `(${e("a")} < ${e("b")})`;
      case "greater":
        return `(${e("a")} > ${e("b")})`;
      case "equal":
        return `(${e("a")} == ${e("b")})`;
      case "and":
        return `(${e("a")} and ${e("b")})`;
      case "or":
        return `(${e("a")} or ${e("b")})`;
      case "not":
        return `(not ${e("a")})`;
      case "join":
        return `(tostring(${e("a")}) .. tostring(${e("b")}))`;
      default:
        // An action's data output (a spawned copy, a call's result) is the local it set.
        return "nil";
    }
  };

  const visited = new Set<string>();
  const chain = (fromId: string, pin: string, indent: string, out: string[]): void => {
    const wire = execOut.get(`${fromId}:${pin}`);
    if (wire) statement(wire.to, indent, out);
  };
  const statement = (nodeId: string, indent: string, out: string[]): void => {
    // A node reached twice in one chain would loop forever when compiled: stop there.
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const n = byId.get(nodeId)!;
    const e = (p: string) => expr(nodeId, p);
    const param = n.param ?? (("param" in SCRIPT_NODES[n.kind] ? (SCRIPT_NODES[n.kind] as ScriptNodeDef).param!.value : "") as string);
    const next = () => chain(nodeId, "then", indent, out);
    switch (n.kind) {
      case "branch": {
        out.push(`${indent}if ${e("condition")} then`);
        chain(nodeId, "true", `${indent}  `, out);
        const alt: string[] = [];
        chain(nodeId, "false", `${indent}  `, alt);
        if (alt.length > 0) out.push(`${indent}else`, ...alt);
        out.push(`${indent}end`);
        break;
      }
      case "sequence":
        for (const p of ["first", "second", "third"]) chain(nodeId, p, indent, out);
        break;
      case "loop": {
        const i = `i_${luaName(n.id.replace(/-/g, "_"))}`;
        locals.set(`${nodeId}:index`, i);
        out.push(`${indent}for ${i} = ${e("from")}, ${e("to")} do`);
        chain(nodeId, "body", `${indent}  `, out);
        out.push(`${indent}end`);
        chain(nodeId, "done", indent, out);
        break;
      }
      case "setVar":
        if (varNames.has(param)) out.push(`${indent}self.${luaName(param)} = ${e("value")}`);
        next();
        break;
      case "place":
        out.push(`${indent}cartbox.place(${e("object")}, ${e("x")}, ${e("y")}, ${e("z")}, ${e("yaw")}, 0, 0, ${e("scale")})`);
        next();
        break;
      case "spawn": {
        const copy = `copy_${luaName(n.id.replace(/-/g, "_"))}`;
        locals.set(`${nodeId}:copy`, copy);
        out.push(`${indent}local ${copy} = cartbox.spawn(${luaString(param)}, ${e("x")}, ${e("y")}, ${e("z")}, ${e("yaw")})`);
        next();
        break;
      }
      case "despawn":
        out.push(`${indent}cartbox.despawn(${e("object")})`);
        next();
        break;
      case "sound":
        out.push(`${indent}if ${e("at a place")} then cartbox.sound(${luaString(param)}, ${e("x")}, ${e("y")}, ${e("z")}) else cartbox.sound(${luaString(param)}) end`);
        next();
        break;
      case "uiSet":
        out.push(`${indent}cartbox.ui.set(${luaString(param)}, ${e("value")})`);
        next();
        break;
      case "uiShow":
        out.push(`${indent}if ${e("shown")} then cartbox.ui.show(${luaString(param)}) else cartbox.ui.hide(${luaString(param)}) end`);
        next();
        break;
      case "score":
        out.push(`${indent}cartbox.score(${e("score")})`);
        next();
        break;
      case "print":
        out.push(`${indent}trace(tostring(${e("message")}))`);
        next();
        break;
      case "call": {
        const result = `r_${luaName(n.id.replace(/-/g, "_"))}`;
        locals.set(`${nodeId}:result`, result);
        out.push(NAME.test(param) ? `${indent}local ${result} = ${param} and ${param}(${e("argument")})` : `${indent}local ${result} = nil`);
        next();
        break;
      }
      default:
        // A value or event node can't be run: the chain ends.
        break;
    }
  };

  const events = graph.nodes.filter((n) => SCRIPT_NODES[n.kind].category === "event").sort((a, b) => a.y - b.y || a.x - b.x);
  const body = (event: ScriptNode, indent: string): string[] => {
    const out: string[] = [];
    visited.clear();
    chain(event.id, "then", indent, out);
    return out;
  };
  const lines: string[] = [`-- ${name}: a visual script (edit it as a graph).`, ...fieldLines(graph), "local function _div(a, b) if b == 0 then return 0 end return a / b end"];

  const of = (kind: ScriptNodeKind) => events.filter((n) => n.kind === kind);
  const starts = of("onStart");
  const timers = of("onTimer");
  if (starts.length > 0 || timers.length > 0) {
    lines.push("function start(self)");
    timers.forEach((t) => lines.push(`  self._t_${luaName(t.id.replace(/-/g, "_"))} = 0`));
    for (const ev of starts) lines.push(...body(ev, "  "));
    lines.push("end");
  }
  const ticks = of("onTick");
  const actions = of("onAction");
  if (ticks.length > 0 || actions.length > 0 || timers.length > 0) {
    lines.push("function update(self, dt)");
    for (const ev of ticks) {
      locals.set(`${ev.id}:dt`, "dt");
      lines.push(...body(ev, "  "));
    }
    for (const ev of actions) {
      lines.push(`  if cartbox.actionp(${luaString(ev.param ?? "fire")}) then`, ...body(ev, "    "), "  end");
    }
    for (const ev of timers) {
      const t = `self._t_${luaName(ev.id.replace(/-/g, "_"))}`;
      const every = Math.max(1 / 60, Number(ev.param ?? "1") || 1);
      lines.push(`  ${t} = (${t} or 0) + dt`, `  if ${t} >= ${every} then`, `    ${t} = ${t} - ${every}`, ...body(ev, "    "), "  end");
    }
    lines.push("end");
  }
  for (const [kind, fn, second] of [["onCollision", "collision", "started"], ["onTrigger", "trigger", "entered"]] as const) {
    const list = of(kind);
    if (list.length === 0) continue;
    lines.push(`function ${fn}(self, other, ${second})`);
    for (const ev of list) {
      locals.set(`${ev.id}:other`, "other");
      locals.set(`${ev.id}:${second}`, second);
      lines.push(...body(ev, "  "));
    }
    lines.push("end");
  }
  return `${lines.join("\n")}\n`;
}

/** A new graph's starting point: an "Every tick" event with nothing after it yet. */
export function emptyScriptGraph(): ScriptGraph {
  return { nodes: [{ id: "n1", kind: "onStart", x: 20, y: 20 }, { id: "n2", kind: "onTick", x: 20, y: 140 }], wires: [], variables: [] };
}
