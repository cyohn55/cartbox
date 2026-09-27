/**
 * Breakpoint hooks for the playtest's Lua debugger (ENGINE_ROADMAP.md, Phase 5).
 *
 * Lua can't pause from a debug hook (a `debug.sethook` function can't yield),
 * so the debugger runs `TIC` in a coroutine and the cart's code calls a hook at
 * the start of each statement line: `__bp(12) x = x + 1`. The hook yields when
 * line 12 has a breakpoint (or a step lands there), which hands control back to
 * the host with the frame half-run. Hooks go on the same line, so every line
 * number stays the cart's own.
 *
 * Where a statement starts is decided from tokens, conservatively: a line gets
 * a hook only when its first token starts a statement, it sits directly in a
 * block (not inside brackets or a loop header), and the line before ends in a
 * way that can end a statement. A line it can't be sure of gets no hook — a
 * breakpoint there moves to the next line that has one. Code it can't tokenize
 * is left alone. Pure.
 */

type TokenType = "name" | "keyword" | "number" | "string" | "symbol";

interface Token {
  readonly type: TokenType;
  readonly value: string;
  readonly line: number;
  readonly start: number;
}

const KEYWORDS = new Set([
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if", "in",
  "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while",
]);

const SYMBOLS = ["...", "..", "::", "==", "~=", "<=", ">=", "//", "<<", ">>"];

/** Split Lua source into tokens (comments and whitespace dropped); null when it can't. */
export function tokenizeLua(code: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  const n = code.length;
  /** Length of the `[==[` opener at `at` (its level + 2), or 0. */
  const longOpen = (at: number): number => {
    if (code[at] !== "[") return 0;
    let j = at + 1;
    while (code[j] === "=") j += 1;
    return code[j] === "[" ? j - at + 1 : 0;
  };
  /** Skip a long bracket body opened with `level` '=' signs; false when unterminated. */
  const skipLong = (level: number): boolean => {
    const close = `]${"=".repeat(level)}]`;
    const end = code.indexOf(close, i);
    if (end < 0) return false;
    for (let k = i; k < end; k += 1) if (code.charCodeAt(k) === 10) line += 1;
    i = end + close.length;
    return true;
  };
  while (i < n) {
    const c = code[i]!;
    if (c === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") {
      i += 1;
      continue;
    }
    const start = i;
    const startLine = line;
    if (c === "-" && code[i + 1] === "-") {
      i += 2;
      const open = longOpen(i);
      if (open > 0) {
        i += open;
        if (!skipLong(open - 2)) return null;
      } else {
        while (i < n && code[i] !== "\n") i += 1;
      }
      continue;
    }
    const open = longOpen(i);
    if (open > 0) {
      i += open;
      if (!skipLong(open - 2)) return null;
      out.push({ type: "string", value: code.slice(start, i), line: startLine, start });
      continue;
    }
    if (c === '"' || c === "'") {
      i += 1;
      while (i < n && code[i] !== c) {
        if (code[i] === "\\") {
          i += 1;
          if (code[i] === "\n") line += 1;
          else if (code[i] === "z") {
            // \z skips the whitespace (newlines included) that follows
            i += 1;
            while (i < n && /\s/.test(code[i]!)) {
              if (code[i] === "\n") line += 1;
              i += 1;
            }
            continue;
          }
        } else if (code[i] === "\n") return null; // unfinished string
        i += 1;
      }
      if (i >= n) return null;
      i += 1;
      out.push({ type: "string", value: code.slice(start, i), line: startLine, start });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(code[i + 1] ?? ""))) {
      if (c === "0" && (code[i + 1] === "x" || code[i + 1] === "X")) {
        i += 2;
        while (i < n && /[0-9a-fA-F.pP]/.test(code[i]!)) {
          if ((code[i] === "p" || code[i] === "P") && (code[i + 1] === "+" || code[i + 1] === "-")) i += 1;
          i += 1;
        }
      } else {
        while (i < n && /[0-9.eE]/.test(code[i]!)) {
          if ((code[i] === "e" || code[i] === "E") && (code[i + 1] === "+" || code[i + 1] === "-")) i += 1;
          i += 1;
        }
      }
      out.push({ type: "number", value: code.slice(start, i), line: startLine, start });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      while (i < n && /[A-Za-z0-9_]/.test(code[i]!)) i += 1;
      const value = code.slice(start, i);
      out.push({ type: KEYWORDS.has(value) ? "keyword" : "name", value, line: startLine, start });
      continue;
    }
    const symbol = SYMBOLS.find((s) => code.startsWith(s, i)) ?? c;
    if (!/[+\-*/%^#&~|<>=(){}[\];:,.]/.test(symbol[0]!)) return null; // not Lua
    i += symbol.length;
    out.push({ type: "symbol", value: symbol, line: startLine, start });
  }
  return out;
}

/** Keywords a statement can start with. */
const STATEMENT_KEYWORDS = new Set(["local", "if", "for", "while", "repeat", "do", "return", "break", "goto", "function"]);
/** Tokens a statement can end with (so what follows starts a new one). */
const ENDS_STATEMENT = new Set(["end", "then", "do", "else", "repeat", "break", ")", "]", "}", ";", "true", "false", "nil", "..."]);

type Context = "root" | "block" | "function" | "head" | "bracket";

/** The hook call the instrumented code makes. */
export const BREAK_HOOK = "__bp";

/**
 * The cart's code with a breakpoint hook at the start of each statement line,
 * and the lines that got one (ascending). Unchanged, with no lines, when the
 * code can't be tokenized or its blocks don't balance.
 */
export function instrumentLua(code: string): { code: string; lines: number[] } {
  const tokens = tokenizeLua(code);
  if (!tokens) return { code, lines: [] };
  const stack: Context[] = ["root"];
  const inserts: { at: number; line: number }[] = [];
  let prev: Token | null = null;
  for (const token of tokens) {
    const top = stack[stack.length - 1]!;
    const firstOnLine = !prev || prev.line !== token.line;
    if (firstOnLine && (top === "root" || top === "block" || top === "function")) {
      const starts = token.type === "name" || (token.type === "keyword" && STATEMENT_KEYWORDS.has(token.value)) || token.value === "::";
      const after = !prev || prev.type === "name" || prev.type === "number" || prev.type === "string" || ENDS_STATEMENT.has(prev.value);
      if (starts && after) inserts.push({ at: token.start, line: token.line });
    }
    const v = token.value;
    if (token.type === "symbol") {
      if (v === "(" || v === "[" || v === "{") stack.push("bracket");
      else if (v === ")" || v === "]" || v === "}") {
        if (stack.pop() !== "bracket") return { code, lines: [] };
      }
    } else if (token.type === "keyword") {
      if (v === "function") stack.push("function");
      else if (v === "if" || v === "repeat") stack.push("block");
      else if (v === "while" || v === "for") stack.push("head");
      else if (v === "do") {
        if (top === "head") stack[stack.length - 1] = "block";
        else stack.push("block");
      } else if (v === "end" || v === "until") {
        const popped = stack.pop();
        if (popped !== "block" && popped !== "function") return { code, lines: [] };
      }
    }
    prev = token;
  }
  if (stack.length !== 1) return { code, lines: [] };
  let out = "";
  let cursor = 0;
  for (const insert of inserts) {
    out += code.slice(cursor, insert.at) + `${BREAK_HOOK}(${insert.line}) `;
    cursor = insert.at;
  }
  out += code.slice(cursor);
  return { code: out, lines: inserts.map((i) => i.line) };
}

/** The line a breakpoint on `line` actually stops at: it, or the next line with a hook (null past the last). */
export function breakableLine(line: number, lines: readonly number[]): number | null {
  for (const l of lines) if (l >= line) return l;
  return null;
}

/**
 * The lines to stop at for a list of breakpoints: each on the first line at or
 * after it that has a hook (a breakpoint on a blank line, a comment or an `end`
 * stops at the next statement); ones past the last hook are dropped. Sorted.
 */
export function effectiveBreakpoints(list: readonly number[], lines: readonly number[]): number[] {
  const out = new Set<number>();
  for (const line of list) {
    const at = breakableLine(line, lines);
    if (at !== null) out.add(at);
  }
  return [...out].sort((a, b) => a - b);
}
