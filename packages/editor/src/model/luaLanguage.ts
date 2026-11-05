/**
 * A language service for cart Lua (AAA_PRODUCTION_ROADMAP.md K2): completion,
 * diagnostics and go to definition, across K1's modules.
 *
 * It works from tokens, not a full parse: Lua's structure that matters here is
 * visible in them. A `local` or a parameter declares a name; a name assigned at
 * a statement's start, or named by `function`, is a global the cart defines; a
 * name otherwise used and declared nowhere, and not a Lua or TIC-80 built-in,
 * is undefined (a typo, usually). `local m = require("x")` binds `m` to module
 * `x`, whose `function M.f` and `M.f =` are its members. Scopes are not
 * tracked: a local declared anywhere in a file counts throughout it, which
 * errs toward silence, the right side for a warning.
 *
 * Pure: the code tab hands it the code and the SDK reference's entries.
 */

import { splitLuaModules } from "./luaModules";
import { languageById, tokenizeLine, type LineState } from "./highlight";

/** One SDK call as the reference lists it (`cartbox.motor(obj, speed, force)`). */
export interface LuaSdkEntry {
  readonly name: string;
  readonly signature: string;
  readonly doc?: string;
}

export interface LuaDiagnostic {
  /** 1-based, in the whole code. */
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly severity: "warning" | "error";
}

export interface LuaCompletion {
  readonly label: string;
  readonly kind: "sdk" | "local" | "global" | "module" | "member" | "keyword" | "builtin";
  readonly detail?: string;
}

/** A word token with its place (1-based line, 0-based column, offset in the code). */
interface Word {
  readonly value: string;
  readonly line: number;
  readonly column: number;
  readonly offset: number;
  /** The character before it (skipping spaces), and after it. */
  readonly before: string;
  readonly after: string;
  /** The word before it, if only spaces separate them. */
  readonly prev: string;
}

const LUA = languageById("lua");
const KEYWORDS = new Set(LUA.keywords);
/** Lua's standard globals and TIC-80's API: never undefined. */
const BUILTINS = new Set([
  "_G", "_VERSION", "assert", "collectgarbage", "error", "getmetatable", "ipairs", "load", "next", "pairs", "pcall", "print", "rawequal", "rawget", "rawlen", "rawset", "require", "select", "setmetatable", "tonumber", "tostring", "type", "xpcall", "unpack",
  "math", "string", "table", "utf8", "coroutine", "os", "debug", "bit32",
  "TIC", "BOOT", "SCN", "BDR", "OVR", "MENU", "btn", "btnp", "key", "keyp", "mouse", "cls", "pix", "line", "rect", "rectb", "circ", "circb", "elli", "ellib", "tri", "trib", "ttri", "textri", "spr", "font", "trace", "map", "mget", "mset", "peek", "peek1", "peek2", "peek4", "poke", "poke1", "poke2", "poke4", "memcpy", "memset", "pmem", "sfx", "music", "sync", "vbank", "fget", "fset", "clip", "exit", "reset", "time", "tstamp",
  "cartbox", "self", "arg",
]);

/** Every word of the code outside comments and strings, with its context. */
function words(code: string): Word[] {
  const out: Word[] = [];
  let state: LineState = null;
  let offset = 0;
  code.split("\n").forEach((text, i) => {
    const { tokens, end } = tokenizeLine(text, state, LUA);
    state = end;
    // Blank out comments and strings, keeping columns, so the scan below sees only code.
    let masked = "";
    for (const t of tokens) masked += t.type === "comment" || t.type === "string" ? " ".repeat(t.value.length) : t.value;
    const re = /[A-Za-z_][A-Za-z0-9_]*/g;
    for (let m = re.exec(masked); m; m = re.exec(masked)) {
      const col = m.index;
      const left = masked.slice(0, col).trimEnd();
      const right = masked.slice(col + m[0].length).trimStart();
      const prevMatch = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(left);
      out.push({
        value: m[0],
        line: i + 1,
        column: col,
        offset: offset + col,
        before: left.slice(-1),
        after: right.slice(0, 1),
        prev: prevMatch ? prevMatch[1]! : "",
      });
    }
    offset += text.length + 1;
  });
  return out;
}

/** What the code declares and binds: locals, globals, modules required, and each module's members. */
interface Index {
  readonly locals: Map<string, number>;
  readonly globals: Map<string, number>;
  /** Local name → the module it was bound to by require. */
  readonly required: Map<string, string>;
  /** Module → member → the line it's defined on. */
  readonly members: Map<string, Map<string, number>>;
  /** Module → the line of its `--#module` marker. */
  readonly modules: Map<string, number>;
}

function index(code: string, all: readonly Word[]): Index {
  const locals = new Map<string, number>();
  const globals = new Map<string, number>();
  const required = new Map<string, string>();
  const members = new Map<string, Map<string, number>>();
  const modules = new Map<string, number>();
  const split = splitLuaModules(code);
  for (const m of split.modules) modules.set(m.name, m.line);
  // The module (and its table's local name) each line belongs to: `local M = {}` … `return M`.
  const moduleOfLine = (line: number) => {
    let found: string | null = null;
    for (const m of split.modules) if (line > m.line && line <= m.line + m.source.split("\n").length) found = m.name;
    return found;
  };
  const lines = code.split("\n");
  // require bindings, from the raw lines (the module name is a string).
  for (const text of lines) {
    const r = /^\s*(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*require\s*\(?\s*["']([^"']+)["']/.exec(text);
    if (r) required.set(r[1]!, r[2]!);
  }
  // Each module's returned table name, for its members.
  const tableOf = new Map<string, string>();
  for (const m of split.modules) {
    const ret = /^\s*return\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/m.exec(m.source);
    if (ret) tableOf.set(m.name, ret[1]!);
  }
  for (let k = 0; k < all.length; k += 1) {
    const w = all[k]!;
    const next = all[k + 1];
    if (w.prev === "local" && w.value !== "function") {
      if (!locals.has(w.value)) locals.set(w.value, w.line);
      // `local a, b, c`: the names after commas on the same line.
      for (let j = k + 1; j < all.length && all[j]!.line === w.line && all[j - 1]!.after === ","; j += 1) if (!locals.has(all[j]!.value)) locals.set(all[j]!.value, w.line);
    }
    // (`function(` is an anonymous function: it names nothing.)
    if (w.value === "function" && w.after !== "(" && next && next.line === w.line) {
      // `local function f`, `function f`, `function M.f`, `function M:f`.
      if (w.prev === "local") {
        if (!locals.has(next.value)) locals.set(next.value, next.line);
      } else if (next.after === "." || next.after === ":") {
        const member = all[k + 2];
        const mod = moduleOfLine(w.line);
        if (member && mod && tableOf.get(mod) === next.value) {
          if (!members.has(mod)) members.set(mod, new Map());
          members.get(mod)!.set(member.value, member.line);
        }
      } else if (next.after === "(" && !globals.has(next.value)) globals.set(next.value, next.line);
    }
    // Parameters: the names between `function name(` and `)`, and after `for`.
    if (w.prev === "for" || (all[k - 1]?.value === "for" && w.before === ",")) if (!locals.has(w.value)) locals.set(w.value, w.line);
  }
  // Parameters, from the raw lines.
  lines.forEach((text, i) => {
    for (const m of text.matchAll(/\bfunction\b[^(]*\(([^)]*)\)/g)) for (const p of m[1]!.split(",")) {
      const name = p.trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !locals.has(name)) locals.set(name, i + 1);
    }
    for (const m of text.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s+(?:in|=)/g)) for (const p of m[1]!.split(",")) if (!locals.has(p.trim())) locals.set(p.trim(), i + 1);
  });
  // Globals assigned at a statement's start (`name = …`, not `name == …`) and members by assignment (`M.f = …`).
  lines.forEach((text, i) => {
    const masked = text.replace(/--.*$/, "");
    const g = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/.exec(masked);
    if (g && !globals.has(g[1]!) && !KEYWORDS.has(g[1]!)) globals.set(g[1]!, i + 1);
    const mm = /^\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/.exec(masked);
    const mod = mm ? moduleOfLine(i + 1) : null;
    if (mm && mod && tableOf.get(mod) === mm[1]) {
      if (!members.has(mod)) members.set(mod, new Map());
      if (!members.get(mod)!.has(mm[2]!)) members.get(mod)!.set(mm[2]!, i + 1);
    }
  });
  return { locals, globals, required, members, modules };
}

/** The most parameters an SDK signature takes, or null for any number (`...`). */
function arity(signature: string): number | null {
  const m = /\(([^)]*)\)/.exec(signature);
  if (!m) return null;
  if (m[1]!.includes("...")) return null;
  const params = m[1]!.split(",").map((p) => p.trim()).filter(Boolean);
  return params.length;
}

/** Arguments in a call starting just after its `(` at `offset`: top-level commas, or null when it isn't closed on screen. */
function countArgs(code: string, offset: number): number | null {
  let depth = 0;
  let args = 0;
  let any = false;
  let quote: string | null = null;
  for (let i = offset; i < code.length && i < offset + 2000; i += 1) {
    const c = code[i]!;
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      any = true;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") {
      if (depth === 0) return any ? args + 1 : 0;
      depth -= 1;
    } else if (c === "," && depth === 0) args += 1;
    else if (!/\s/.test(c)) any = true;
  }
  return null;
}

/**
 * Problems in the code: K1's module problems, undefined globals (warnings),
 * SDK calls given more arguments than they take, and `require` of a module the
 * cart doesn't hold (errors).
 */
export function luaDiagnostics(code: string, sdk: readonly LuaSdkEntry[] = []): LuaDiagnostic[] {
  const out: LuaDiagnostic[] = [];
  for (const p of splitLuaModules(code).problems) out.push({ line: p.line, column: 0, message: p.message, severity: "error" });
  const all = words(code);
  const idx = index(code, all);
  const sdkArity = new Map(sdk.map((e) => [e.name, arity(e.signature)]));
  const lines = code.split("\n");
  lines.forEach((text, i) => {
    for (const m of text.replace(/--.*$/, "").matchAll(/\brequire\s*\(?\s*["']([^"']+)["']/g)) {
      if (!idx.modules.has(m[1]!)) out.push({ line: i + 1, column: m.index ?? 0, message: `module '${m[1]}' isn't in this cart`, severity: "error" });
    }
  });
  const reported = new Set<string>();
  for (const w of all) {
    if (KEYWORDS.has(w.value)) continue;
    // A member (`a.b`, `a:b`), a table key (`{ b = 1 }`, `b = 1` inside a constructor is rare enough), or a goto label.
    if (w.before === "." || w.before === ":") continue;
    if (w.after === "=" && w.before === "{") continue;
    if (w.before === "," && w.after === "=") continue;
    // An SDK call's arity.
    if (w.value === "cartbox" && w.after === ".") {
      const member = all.find((x) => x.offset > w.offset && x.line === w.line);
      if (member && member.after === "(") {
        const max = sdkArity.get(`cartbox.${member.value}`);
        const open = code.indexOf("(", member.offset);
        const given = open >= 0 ? countArgs(code, open + 1) : null;
        if (max !== undefined && max !== null && given !== null && given > max) {
          out.push({ line: member.line, column: member.column, message: `cartbox.${member.value} takes at most ${max} argument${max === 1 ? "" : "s"}; this call gives ${given}`, severity: "warning" });
        }
      }
      continue;
    }
    if (BUILTINS.has(w.value) || idx.locals.has(w.value) || idx.globals.has(w.value)) continue;
    // A field of a table constructor across lines: `name = value,` at a line's start inside `{`… is a global assignment to the tokens; treat `name =` as defining.
    if (w.after === "=" && code[w.offset + w.value.length] !== "=") continue;
    const key = `${w.value}@${w.line}`;
    if (reported.has(key)) continue;
    reported.add(key);
    out.push({ line: w.line, column: w.column, message: `'${w.value}' isn't defined anywhere in the cart (a typo?)`, severity: "warning" });
  }
  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** The completions at `offset`: after `cartbox.`, the SDK; after a required module's name and a dot, its members; else names in scope. */
export function luaCompletions(code: string, offset: number, sdk: readonly LuaSdkEntry[] = []): { from: number; items: LuaCompletion[] } {
  const before = code.slice(0, offset);
  const word = /([A-Za-z_][A-Za-z0-9_]*)?$/.exec(before)![1] ?? "";
  const from = offset - word.length;
  const prefix = word.toLowerCase();
  const owner = /([A-Za-z_][A-Za-z0-9_]*)[.:]$/.exec(before.slice(0, from));
  const all = words(code);
  const idx = index(code, all);
  const match = (label: string) => label.toLowerCase().startsWith(prefix);
  let items: LuaCompletion[] = [];
  if (owner && owner[1] === "cartbox") {
    items = sdk.filter((e) => e.name.startsWith("cartbox.")).map((e) => ({ label: e.name.slice(8), kind: "sdk" as const, detail: e.signature }));
  } else if (owner && idx.required.has(owner[1]!)) {
    const mod = idx.required.get(owner[1]!)!;
    items = [...(idx.members.get(mod) ?? new Map<string, number>()).keys()].map((label) => ({ label, kind: "member" as const, detail: `${mod}.${label}` }));
  } else if (owner) {
    items = []; // A table the service doesn't know the members of.
  } else {
    const seen = new Set<string>();
    const add = (label: string, kind: LuaCompletion["kind"], detail?: string) => {
      if (seen.has(label)) return;
      seen.add(label);
      items.push({ label, kind, ...(detail ? { detail } : {}) });
    };
    for (const name of idx.locals.keys()) add(name, idx.required.has(name) ? "module" : "local", idx.required.has(name) ? `require("${idx.required.get(name)}")` : undefined);
    for (const name of idx.globals.keys()) add(name, "global");
    add("cartbox", "builtin");
    for (const name of BUILTINS) add(name, "builtin");
    for (const name of KEYWORDS) add(name, "keyword");
  }
  return { from, items: items.filter((i) => match(i.label)).sort((a, b) => a.label.localeCompare(b.label)) };
}

/**
 * Where the name at `offset` is defined, as a line of the whole code (1-based):
 * a module member through its `require`d name, a module by its name in a
 * `require`, a local or a global; null when it's a built-in or unknown.
 */
export function luaDefinition(code: string, offset: number): number | null {
  const all = words(code);
  const idx = index(code, all);
  const at = all.find((w) => offset >= w.offset && offset <= w.offset + w.value.length);
  if (!at) {
    // A module's name inside require("…").
    const line = code.slice(0, offset).split("\n").length;
    const text = code.split("\n")[line - 1] ?? "";
    const r = /require\s*\(?\s*["']([^"']+)["']/.exec(text);
    return r && idx.modules.has(r[1]!) ? idx.modules.get(r[1]!)! : null;
  }
  if (at.before === "." || at.before === ":") {
    const owner = [...all].reverse().find((w) => w.offset < at.offset && w.line === at.line);
    const mod = owner ? idx.required.get(owner.value) : undefined;
    return mod ? (idx.members.get(mod)?.get(at.value) ?? null) : null;
  }
  if (idx.required.has(at.value)) return idx.modules.get(idx.required.get(at.value)!) ?? idx.locals.get(at.value) ?? null;
  return idx.locals.get(at.value) ?? idx.globals.get(at.value) ?? null;
}
