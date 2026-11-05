/**
 * Behaviour trees and a blackboard (AAA_PRODUCTION_ROADMAP.md K4): an agent's
 * decisions as a tree of composites, decorators and leaves, authored in the
 * editor, stored in the mesh sidecar, and run by the cart per agent.
 *
 * The runtime is Lua the player puts ahead of the cart's code (like
 * components'): `cartbox.bt.new(tree, agent)` makes an instance with its own
 * blackboard, and `cartbox.bt.tick(instance, dt)` runs one step and answers
 * "success", "failure" or "running". It uses no clock and no randomness of its
 * own (time is the `dt` the cart passes), so a tree decides the same on every
 * machine and in every replay.
 *
 * - Composites: `sequence` (each child in turn, until one fails; it keeps its
 *   place while a child runs), `selector` (each in turn, until one doesn't
 *   fail; reactive: it tries them in priority order every tick, so a higher
 *   branch whose condition comes true takes over, resetting the one that was
 *   running), `parallel` (all each tick; succeeds once `need` have).
 * - Decorators (one child): `inverter`, `succeeder`, `repeat` (`count` times,
 *   0 forever), `cooldown` (fails for `seconds` after its child finishes).
 * - Leaves: `wait` (`seconds`), `condition` (a blackboard key against a value),
 *   `set` (a key to a value), `action` (a function the cart registers with
 *   `cartbox.bt.action(name, fn)`, called with the agent, the blackboard, the
 *   node and dt, returning a status).
 *
 * The debugger view: `cartbox.bt.watch(instance)` traces the running node's path
 * to the editor's console each time it changes; `cartbox.bt.running(instance)`
 * returns it.
 */

export type BtNodeType = "sequence" | "selector" | "parallel" | "inverter" | "succeeder" | "repeat" | "cooldown" | "wait" | "condition" | "set" | "action";
export type BtCompare = "==" | "~=" | "<" | "<=" | ">" | ">=" | "truthy" | "falsy";
export type BtValue = number | string | boolean;

export interface BtNode {
  /** Unique in its tree (the debugger names nodes by it). */
  readonly id: string;
  readonly type: BtNodeType;
  /** A label for the editor and the debugger. */
  readonly label?: string;
  readonly children?: readonly BtNode[];
  /** condition / set: the blackboard key. */
  readonly key?: string;
  readonly op?: BtCompare;
  readonly value?: BtValue;
  /** wait / cooldown. */
  readonly seconds?: number;
  /** repeat: times (0 = forever). */
  readonly count?: number;
  /** parallel: children that must succeed (default all). */
  readonly need?: number;
  /** action: the registered function's name. */
  readonly action?: string;
}

export interface BehaviourTree {
  readonly name: string;
  readonly root: BtNode;
}

export const BT_NODE_TYPES: readonly BtNodeType[] = ["sequence", "selector", "parallel", "inverter", "succeeder", "repeat", "cooldown", "wait", "condition", "set", "action"];
export const BT_COMPARES: readonly BtCompare[] = ["==", "~=", "<", "<=", ">", ">=", "truthy", "falsy"];
const COMPOSITES = new Set<BtNodeType>(["sequence", "selector", "parallel"]);
const DECORATORS = new Set<BtNodeType>(["inverter", "succeeder", "repeat", "cooldown"]);
export const MAX_BT_NODES = 512;
export const MAX_BEHAVIOUR_TREES = 64;

/** Whether a node type takes children (composites any, decorators one). */
export function btChildren(type: BtNodeType): "many" | "one" | "none" {
  return COMPOSITES.has(type) ? "many" : DECORATORS.has(type) ? "one" : "none";
}

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined);

/** Read stored trees defensively: unknown types, repeated ids and oversized trees are dropped. */
export function readBehaviourTrees(raw: unknown): BehaviourTree[] {
  if (!Array.isArray(raw)) return [];
  const out: BehaviourTree[] = [];
  const names = new Set<string>();
  for (const t of raw.slice(0, MAX_BEHAVIOUR_TREES)) {
    const r = t as { name?: unknown; root?: unknown };
    if (typeof r?.name !== "string" || !NAME.test(r.name) || names.has(r.name)) continue;
    const ids = new Set<string>();
    let count = 0;
    const node = (value: unknown): BtNode | null => {
      const n = value as Record<string, unknown>;
      if (!n || typeof n !== "object" || !BT_NODE_TYPES.includes(n.type as BtNodeType)) return null;
      if (typeof n.id !== "string" || !n.id || n.id.length > 64 || ids.has(n.id) || ++count > MAX_BT_NODES) return null;
      ids.add(n.id);
      const type = n.type as BtNodeType;
      const kids = btChildren(type);
      const children = kids === "none" || !Array.isArray(n.children) ? [] : (n.children.slice(0, kids === "one" ? 1 : 64).map(node).filter((c): c is BtNode => c !== null));
      const value_ = typeof n.value === "number" && Number.isFinite(n.value) ? n.value : typeof n.value === "string" ? n.value.slice(0, 128) : typeof n.value === "boolean" ? n.value : undefined;
      return {
        id: n.id,
        type,
        ...(typeof n.label === "string" && n.label ? { label: n.label.slice(0, 64) } : {}),
        ...(kids !== "none" ? { children } : {}),
        ...((type === "condition" || type === "set") && typeof n.key === "string" && n.key ? { key: n.key.slice(0, 64) } : {}),
        ...(type === "condition" && BT_COMPARES.includes(n.op as BtCompare) ? { op: n.op as BtCompare } : {}),
        ...((type === "condition" || type === "set") && value_ !== undefined ? { value: value_ } : {}),
        ...((type === "wait" || type === "cooldown") && num(n.seconds, 0, 3600) !== undefined ? { seconds: num(n.seconds, 0, 3600)! } : {}),
        ...(type === "repeat" && num(n.count, 0, 1e6) !== undefined ? { count: Math.round(num(n.count, 0, 1e6)!) } : {}),
        ...(type === "parallel" && num(n.need, 1, 64) !== undefined ? { need: Math.round(num(n.need, 1, 64)!) } : {}),
        ...(type === "action" && typeof n.action === "string" && n.action ? { action: n.action.slice(0, 64) } : {}),
      };
    };
    const root = node(r.root);
    if (!root) continue;
    names.add(r.name);
    out.push({ name: r.name, root });
  }
  return out;
}

const luaString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
const luaValue = (v: BtValue | undefined) => (v === undefined ? "nil" : typeof v === "string" ? luaString(v) : String(v));

function nodeLua(n: BtNode): string {
  const fields = [`id=${luaString(n.id)}`, `t=${luaString(n.type)}`, `label=${luaString(n.label ?? n.action ?? n.id)}`];
  if (n.children) fields.push(`c={${n.children.map(nodeLua).join(",")}}`);
  if (n.key !== undefined) fields.push(`key=${luaString(n.key)}`);
  if (n.op !== undefined) fields.push(`op=${luaString(n.op)}`);
  if (n.value !== undefined) fields.push(`v=${luaValue(n.value)}`);
  if (n.seconds !== undefined) fields.push(`s=${n.seconds}`);
  if (n.count !== undefined) fields.push(`n=${n.count}`);
  if (n.need !== undefined) fields.push(`need=${n.need}`);
  if (n.action !== undefined) fields.push(`a=${luaString(n.action)}`);
  return `{${fields.join(",")}}`;
}

/** The runtime and the trees, as Lua to put ahead of the cart's code; empty without trees. */
export function behaviourTreesLua(trees: readonly BehaviourTree[]): string {
  if (trees.length === 0) return "";
  return `cartbox = cartbox or {}
cartbox.bt = {}
do
local TREES = {${trees.map((t) => `[${luaString(t.name)}]=${nodeLua(t.root)}`).join(",\n")}}
local actions = {}
function cartbox.bt.action(name, fn) actions[name] = fn end
function cartbox.bt.trees() local out = {} for name in pairs(TREES) do out[#out + 1] = name end table.sort(out) return out end
function cartbox.bt.new(name, agent, blackboard)
  local tree = TREES[name]
  if tree == nil then error("no behaviour tree named " .. tostring(name), 2) end
  return { name = name, tree = tree, agent = agent, bb = blackboard or {}, mem = {}, time = 0, path = nil, watching = false, shown = nil }
end
local function compare(op, a, b)
  if op == "truthy" then return a ~= nil and a ~= false end
  if op == "falsy" then return a == nil or a == false end
  if op == "==" then return a == b end
  if op == "~=" then return a ~= b end
  if type(a) ~= "number" or type(b) ~= "number" then return false end
  if op == "<" then return a < b elseif op == "<=" then return a <= b elseif op == ">" then return a > b else return a >= b end
end
local run
local function reset(inst, n)
  inst.mem[n.id] = nil
  if n.c then for _, c in ipairs(n.c) do reset(inst, c) end end
end
run = function(inst, n, dt)
  local m = inst.mem[n.id]
  if m == nil then m = {} inst.mem[n.id] = m end
  local t = n.t
  if t == "sequence" then
    local i = m.i or 1
    while i <= #n.c do
      local s = run(inst, n.c[i], dt)
      if s == "running" then m.i = i return "running" end
      if s == "failure" then m.i = nil return s end
      i = i + 1
    end
    m.i = nil
    return "success"
  elseif t == "selector" then
    -- Reactive: the children are tried in priority order every tick, and a
    -- branch that takes over from a lower one that was running resets it.
    for i, c in ipairs(n.c) do
      local s = run(inst, c, dt)
      if s ~= "failure" then
        if m.i and m.i ~= i then reset(inst, n.c[m.i]) end
        if s == "running" then m.i = i else m.i = nil end
        return s
      end
    end
    if m.i then reset(inst, n.c[m.i]) end
    m.i = nil
    return "failure"
  elseif t == "parallel" then
    local ok, bad = 0, 0
    for _, c in ipairs(n.c) do
      local s = run(inst, c, dt)
      if s == "success" then ok = ok + 1 elseif s == "failure" then bad = bad + 1 end
    end
    local need = n.need or #n.c
    if ok >= need then for _, c in ipairs(n.c) do reset(inst, c) end return "success" end
    if bad > #n.c - need then for _, c in ipairs(n.c) do reset(inst, c) end return "failure" end
    return "running"
  elseif t == "inverter" or t == "succeeder" then
    local c = n.c[1]
    if c == nil then return "failure" end
    local s = run(inst, c, dt)
    if s == "running" then return s end
    if t == "succeeder" then return "success" end
    if s == "success" then return "failure" else return "success" end
  elseif t == "repeat" then
    local c = n.c[1]
    if c == nil then return "failure" end
    local s = run(inst, c, dt)
    if s == "running" then return s end
    m.k = (m.k or 0) + 1
    reset(inst, c)
    if (n.n or 0) > 0 and m.k >= n.n then m.k = nil return "success" end
    return "running"
  elseif t == "cooldown" then
    if m.ready and inst.time < m.ready then return "failure" end
    local c = n.c[1]
    if c == nil then return "failure" end
    local s = run(inst, c, dt)
    if s ~= "running" then m.ready = inst.time + (n.s or 0) end
    return s
  elseif t == "wait" then
    m.left = (m.left or (n.s or 0)) - dt
    if m.left <= 1e-9 then m.left = nil return "success" end
    inst.path = inst.path or n
    return "running"
  elseif t == "condition" then
    if compare(n.op or "truthy", inst.bb[n.key or ""], n.v) then return "success" else return "failure" end
  elseif t == "set" then
    inst.bb[n.key or ""] = n.v
    return "success"
  elseif t == "action" then
    local fn = actions[n.a or ""]
    if fn == nil then return "failure" end
    local s = fn(inst.agent, inst.bb, n, dt) or "success"
    if s == true then s = "success" elseif s == false then s = "failure" end
    if s == "running" then inst.path = inst.path or n end
    return s
  end
  return "failure"
end
-- The running node's path, root to leaf, by label.
local function pathOf(inst, n, target, out)
  out[#out + 1] = n.label
  if n == target then return true end
  if n.c then for _, c in ipairs(n.c) do if pathOf(inst, c, target, out) then return true end end end
  out[#out] = nil
  return false
end
function cartbox.bt.running(inst)
  if inst.path == nil then return nil end
  local out = {}
  pathOf(inst, inst.tree, inst.path, out)
  return table.concat(out, " > "), inst.path.id
end
function cartbox.bt.watch(inst, on) inst.watching = on ~= false end
function cartbox.bt.tick(inst, dt)
  dt = dt or (1 / 60)
  inst.time = inst.time + dt
  inst.path = nil
  local s = run(inst, inst.tree, dt)
  inst.status = s
  if inst.watching then
    local shown = cartbox.bt.running(inst) or s
    if shown ~= inst.shown then inst.shown = shown trace("bt " .. inst.name .. ": " .. shown) end
  end
  return s
end
end`;
}

/** A new node of `type` with an id not yet in `tree` (the editor's add). */
export function newBtNode(type: BtNodeType, taken: ReadonlySet<string>): BtNode {
  let k = 1;
  while (taken.has(`${type}${k}`)) k += 1;
  const id = `${type}${k}`;
  const kids = btChildren(type);
  return {
    id,
    type,
    ...(kids !== "none" ? { children: [] } : {}),
    ...(type === "wait" || type === "cooldown" ? { seconds: 1 } : {}),
    ...(type === "condition" ? { key: "target", op: "truthy" as const } : {}),
    ...(type === "set" ? { key: "state", value: "idle" } : {}),
    ...(type === "action" ? { action: "act" } : {}),
  };
}

/** Every id in a tree. */
export function btIds(root: BtNode): Set<string> {
  const out = new Set<string>();
  const walk = (n: BtNode) => {
    out.add(n.id);
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

/** A tree with node `id` replaced by `next` (null removes it; the root can't be removed). */
export function replaceBtNode(root: BtNode, id: string, next: BtNode | null): BtNode {
  if (root.id === id) return next ?? root;
  if (!root.children) return root;
  const children = root.children.flatMap((c) => (c.id === id ? (next ? [next] : []) : [replaceBtNode(c, id, next)]));
  return { ...root, children };
}
