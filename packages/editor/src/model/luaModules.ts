/**
 * Lua modules (AAA_PRODUCTION_ROADMAP.md K1): a cart's script as several
 * files, loaded by `require` from the cart, never from a file system.
 *
 * The files live in the cart's one code text, so the .tic format, the code
 * banks, saving and the replay contract are all unchanged. A module is a
 * section between two comment lines:
 *
 * ```lua
 * --#module enemies
 * local M = {}
 * function M.spawn(x, y) ... end
 * return M
 * --#end
 * ```
 *
 * Everything outside a section is the main file. Before the cart runs, the
 * player lifts each section into a prelude that registers it as a function and
 * defines `require` (each module runs once, on its first `require`, and gets
 * its own locals), then blanks the section's lines in place, so the main
 * file's line numbers, which errors and breakpoints use, don't move.
 *
 * Pure: the editor uses the same functions to show and edit one file at a time.
 */

/** A module's name: Lua identifiers joined by dots, like `ai.patrol`. */
export const LUA_MODULE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
/** The most modules a cart holds. */
export const MAX_LUA_MODULES = 64;
/** The main file's name in the editor's file list. */
export const MAIN_FILE = "main";

const START = /^--#module[ \t]+(\S+)[ \t]*\r?$/;
const END = /^--#end[ \t]*\r?$/;

export interface LuaModule {
  readonly name: string;
  /** Its source: the lines between its markers. */
  readonly source: string;
  /** The line (1-based, in the whole code) of its `--#module` marker. */
  readonly line: number;
}

export interface LuaModuleSplit {
  /** The main file: the code with every module's lines (markers included) blanked. */
  readonly main: string;
  readonly modules: readonly LuaModule[];
  /** Problems found (an unclosed section, a repeated or invalid name), each with its line. */
  readonly problems: readonly { readonly line: number; readonly message: string }[];
}

/** Split code into its main file and its modules (see the module comment). */
export function splitLuaModules(code: string): LuaModuleSplit {
  const lines = code.split("\n");
  const modules: LuaModule[] = [];
  const problems: { line: number; message: string }[] = [];
  const main: string[] = [];
  let open: { name: string; line: number; body: string[] } | null = null;
  const seen = new Set<string>();
  lines.forEach((text, i) => {
    const line = i + 1;
    const start = START.exec(text);
    if (start) {
      if (open) problems.push({ line, message: `module ${open.name} (line ${open.line}) isn't closed with --#end before the next one` });
      const name = start[1]!;
      if (!LUA_MODULE_NAME.test(name)) problems.push({ line, message: `"${name}" isn't a module name (letters, digits, _ and dots)` });
      else if (seen.has(name)) problems.push({ line, message: `module ${name} is defined twice` });
      seen.add(name);
      if (open && LUA_MODULE_NAME.test(open.name)) modules.push({ name: open.name, source: open.body.join("\n"), line: open.line });
      open = { name, line, body: [] };
      main.push("");
      return;
    }
    if (open && END.test(text)) {
      if (LUA_MODULE_NAME.test(open.name) && modules.length < MAX_LUA_MODULES && !modules.some((m) => m.name === open!.name)) modules.push({ name: open.name, source: open.body.join("\n"), line: open.line });
      open = null;
      main.push("");
      return;
    }
    if (open) {
      open.body.push(text);
      main.push("");
    } else main.push(text);
  });
  if (open) {
    const o = open as { name: string; line: number; body: string[] };
    problems.push({ line: o.line, message: `module ${o.name} isn't closed with --#end` });
    if (LUA_MODULE_NAME.test(o.name) && !modules.some((m) => m.name === o.name)) modules.push({ name: o.name, source: o.body.join("\n"), line: o.line });
  }
  return { main: main.join("\n"), modules, problems };
}

/**
 * The prelude that registers `modules` and defines `require` (on both cores:
 * plain Lua, no `load`, no file system). A `require` of a module the cart
 * doesn't hold is an error naming it; a module that requires itself while
 * loading gets `true`, as Lua's own `require` gives a cycle.
 */
export function luaModulesPrelude(modules: readonly LuaModule[]): string {
  const out = ["__cbx_modules = {}"];
  for (const m of modules) out.push(`__cbx_modules[${JSON.stringify(m.name)}] = function(...)`, m.source, "end");
  out.push(
    "do",
    "  local loaded = {}",
    "  function require(name)",
    "    local value = loaded[name]",
    "    if value ~= nil then return value end",
    "    local body = __cbx_modules[name]",
    "    if body == nil then error(\"module '\" .. tostring(name) .. \"' isn't in this cart\", 2) end",
    "    loaded[name] = true",
    "    value = body(name)",
    "    if value == nil then value = true end",
    "    loaded[name] = value",
    "    return value",
    "  end",
    "end",
  );
  return out.join("\n");
}

/**
 * What the player runs for a cart's code: `null` when it has no modules (the
 * code runs as written), else the main file (module lines blanked) and the
 * prelude to prepend.
 */
export function bundleLuaModules(code: string): { main: string; prelude: string } | null {
  if (!code.includes("--#module")) return null;
  const split = splitLuaModules(code);
  if (split.modules.length === 0) return null;
  return { main: split.main, prelude: luaModulesPrelude(split.modules) };
}

// --- One file at a time (the editor) ---------------------------------------------------------

/** The files in the code: the main file first, then each module in order. */
export function luaFiles(code: string): string[] {
  return [MAIN_FILE, ...splitLuaModules(code).modules.map((m) => m.name)];
}

/** The lines (0-based, end exclusive) a module's body takes, between its markers, or null. */
function moduleRange(lines: readonly string[], name: string): { start: number; end: number } | null {
  for (let i = 0; i < lines.length; i += 1) {
    const m = START.exec(lines[i]!);
    if (!m || m[1] !== name) continue;
    let end = i + 1;
    while (end < lines.length && !END.test(lines[end]!) && !START.test(lines[end]!)) end += 1;
    return { start: i + 1, end };
  }
  return null;
}

/** One file's text: a module's source, or the main file's (the code outside every module). */
export function readLuaFile(code: string, name: string): string {
  if (name === MAIN_FILE) return mainOnly(code);
  const lines = code.split("\n");
  const range = moduleRange(lines, name);
  return range ? lines.slice(range.start, range.end).join("\n") : "";
}

/** The main file without the blank lines its modules leave (what the editor shows as "main"). */
function mainOnly(code: string): string {
  const lines = code.split("\n");
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (START.test(line)) inside = true;
    else if (inside && END.test(line)) inside = false;
    else if (!inside) out.push(line);
  }
  return out.join("\n");
}

/** The code with one file's text replaced (the main file keeps the modules where they were, at its end if it moved). */
export function writeLuaFile(code: string, name: string, text: string): string {
  const lines = code.split("\n");
  if (name !== MAIN_FILE) {
    const range = moduleRange(lines, name);
    if (!range) return code;
    return [...lines.slice(0, range.start), ...text.split("\n"), ...lines.slice(range.end)].join("\n");
  }
  // The modules' sections, kept whole, after the new main text.
  const sections: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (START.test(line)) inside = true;
    if (inside) sections.push(line);
    if (inside && END.test(line)) inside = false;
  }
  return sections.length > 0 ? `${text}\n${sections.join("\n")}` : text;
}

/** The code with a new, empty module `name` at its end; unchanged when the name is taken, invalid, or one too many. */
export function addLuaModule(code: string, name: string): string {
  if (!LUA_MODULE_NAME.test(name) || name === MAIN_FILE) return code;
  const split = splitLuaModules(code);
  if (split.modules.some((m) => m.name === name) || split.modules.length >= MAX_LUA_MODULES) return code;
  const body = `local M = {}\n\nreturn M`;
  return `${code.endsWith("\n") || code === "" ? code : `${code}\n`}--#module ${name}\n${body}\n--#end`;
}

/** The code without module `name` (its section, markers and all). */
export function removeLuaModule(code: string, name: string): string {
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const m = START.exec(lines[i]!);
    if (!m || m[1] !== name) continue;
    let end = i + 1;
    while (end < lines.length && !END.test(lines[end]!) && !START.test(lines[end]!)) end += 1;
    if (end < lines.length && END.test(lines[end]!)) end += 1;
    return [...lines.slice(0, i), ...lines.slice(end)].join("\n");
  }
  return code;
}
