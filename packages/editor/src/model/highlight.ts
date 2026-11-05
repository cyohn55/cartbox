/**
 * A small, language-aware tokenizer for the code editor. It is deliberately
 * pure and dependency-free: given source text and a language config, it returns
 * a flat list of tokens (with original whitespace preserved as `text`) that the
 * editor renders as coloured spans. The same function is unit-tested directly.
 *
 * It covers the constructs that carry most of the visual signal — comments,
 * strings, numbers, language keywords, and the TIC-80 API — and classifies
 * everything else as plain text. It is not a parser and does not validate code.
 */

export type TokenType = "keyword" | "api" | "string" | "comment" | "number" | "text";

export interface Token {
  type: TokenType;
  value: string;
}

export interface LanguageConfig {
  id: string;
  label: string;
  lineComment: string;
  blockComment?: [open: string, close: string];
  /** Lua-style long strings/comments delimited by [[ ]]. */
  longStrings?: boolean;
  keywords: string[];
}

/** TIC-80 callbacks and API functions, highlighted across every language. */
const TIC80_API = new Set([
  "TIC", "BOOT", "SCN", "BDR", "OVR", "MENU",
  "btn", "btnp", "key", "keyp", "mouse",
  "cls", "pix", "line", "rect", "rectb", "circ", "circb", "elli", "ellib",
  "tri", "trib", "ttri", "textri", "spr", "print", "font", "trace",
  "map", "mget", "mset", "peek", "peek1", "peek2", "peek4",
  "poke", "poke1", "poke2", "poke4", "memcpy", "memset", "pmem",
  "sfx", "music", "sync", "vbank", "fget", "fset",
  "clip", "exit", "reset", "time", "tstamp",
]);

const LUA: LanguageConfig = {
  id: "lua",
  label: "Lua",
  lineComment: "--",
  blockComment: ["--[[", "]]"],
  longStrings: true,
  keywords: [
    "and", "break", "do", "else", "elseif", "end", "false", "for", "function",
    "goto", "if", "in", "local", "nil", "not", "or", "repeat", "return", "then",
    "true", "until", "while",
  ],
};

const JS: LanguageConfig = {
  id: "js",
  label: "JavaScript",
  lineComment: "//",
  blockComment: ["/*", "*/"],
  keywords: [
    "break", "case", "catch", "const", "continue", "default", "delete", "do",
    "else", "export", "false", "for", "function", "if", "import", "in", "let",
    "new", "null", "of", "return", "switch", "this", "throw", "true", "try",
    "typeof", "var", "void", "while",
  ],
};

const PYTHON: LanguageConfig = {
  id: "python",
  label: "Python",
  lineComment: "#",
  keywords: [
    "and", "as", "break", "class", "continue", "def", "elif", "else", "except",
    "False", "for", "from", "global", "if", "import", "in", "is", "lambda",
    "None", "not", "or", "pass", "return", "True", "try", "while", "with",
  ],
};

export const LANGUAGES: LanguageConfig[] = [LUA, JS, PYTHON];

export function languageById(id: string): LanguageConfig {
  return LANGUAGES.find((language) => language.id === id) ?? LUA;
}

const isIdentStart = (char: string) => /[A-Za-z_]/.test(char);
const isIdentPart = (char: string) => /[A-Za-z0-9_]/.test(char);
const isDigit = (char: string) => char >= "0" && char <= "9";

export function tokenize(source: string, config: LanguageConfig): Token[] {
  const tokens: Token[] = [];
  const keywords = new Set(config.keywords);
  let text = "";
  let index = 0;

  const flushText = () => {
    if (text) {
      tokens.push({ type: "text", value: text });
      text = "";
    }
  };
  const emit = (type: TokenType, value: string) => {
    flushText();
    tokens.push({ type, value });
  };
  const readUntil = (start: number, terminator: string): number => {
    const found = source.indexOf(terminator, start);
    return found === -1 ? source.length : found + terminator.length;
  };

  while (index < source.length) {
    const rest = source.slice(index);
    const char = source[index]!;

    // Block comment (before line comment: "--[[" must beat "--").
    if (config.blockComment && rest.startsWith(config.blockComment[0])) {
      const end = readUntil(index + config.blockComment[0].length, config.blockComment[1]);
      emit("comment", source.slice(index, end));
      index = end;
      continue;
    }

    // Line comment.
    if (rest.startsWith(config.lineComment)) {
      const newline = source.indexOf("\n", index);
      const end = newline === -1 ? source.length : newline;
      emit("comment", source.slice(index, end));
      index = end;
      continue;
    }

    // Lua long string [[ ... ]].
    if (config.longStrings && rest.startsWith("[[")) {
      const end = readUntil(index + 2, "]]");
      emit("string", source.slice(index, end));
      index = end;
      continue;
    }

    // Quoted string with backslash escapes.
    if (char === '"' || char === "'") {
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== char) {
        cursor += source[cursor] === "\\" ? 2 : 1;
      }
      const end = Math.min(cursor + 1, source.length);
      emit("string", source.slice(index, end));
      index = end;
      continue;
    }

    // Number (decimal or hex).
    if (isDigit(char)) {
      let cursor = index;
      while (cursor < source.length && /[0-9a-fA-FxX.]/.test(source[cursor]!)) cursor += 1;
      emit("number", source.slice(index, cursor));
      index = cursor;
      continue;
    }

    // Identifier: keyword, API, or plain text.
    if (isIdentStart(char)) {
      let cursor = index;
      while (cursor < source.length && isIdentPart(source[cursor]!)) cursor += 1;
      const word = source.slice(index, cursor);
      if (keywords.has(word)) emit("keyword", word);
      else if (TIC80_API.has(word)) emit("api", word);
      else text += word;
      index = cursor;
      continue;
    }

    // Anything else (whitespace, punctuation) accumulates as plain text.
    text += char;
    index += 1;
  }

  flushText();
  return tokens;
}

// --- Incremental highlighting (AAA_PRODUCTION_ROADMAP.md K3) ------------------------------------

/**
 * What a line starts inside: nothing, or a block comment / long string still
 * open from an earlier line, with the text that closes it. Carried from line
 * to line, so one line is tokenised without the lines before it, and only the
 * lines an edit reaches are tokenised again.
 */
export type LineState = null | { readonly type: "comment" | "string"; readonly close: string };

export interface LineTokens {
  readonly tokens: readonly Token[];
  /** The state the next line starts in. */
  readonly end: LineState;
}

const sameState = (a: LineState, b: LineState) => a === b || (a !== null && b !== null && a.type === b.type && a.close === b.close);

/**
 * One line's tokens (without its newline), starting in `state`. Its tokens are
 * the same, character for character, as {@link tokenize}'s over the whole
 * document; a block comment or long string that spans lines is cut at each.
 */
export function tokenizeLine(line: string, state: LineState, config: LanguageConfig, keywords: ReadonlySet<string> = new Set(config.keywords)): LineTokens {
  const tokens: Token[] = [];
  let text = "";
  let index = 0;
  const flushText = () => {
    if (text) {
      tokens.push({ type: "text", value: text });
      text = "";
    }
  };
  const emit = (type: TokenType, value: string) => {
    flushText();
    if (value) tokens.push({ type, value });
  };
  /** Read a span that `close` ends; null when it runs past the line (it stays open). */
  const span = (type: "comment" | "string", from: number, start: number, close: string): LineState => {
    let found: number;
    if (close === '"' || close === "'") {
      // A quoted string carried over a line: its escapes still count.
      let cursor = start;
      while (cursor < line.length && line[cursor] !== close) cursor += line[cursor] === "\\" ? 2 : 1;
      found = cursor < line.length ? cursor : -1;
    } else found = line.indexOf(close, start);
    if (found === -1) {
      emit(type, line.slice(from));
      index = line.length;
      return { type, close };
    }
    emit(type, line.slice(from, found + close.length));
    index = found + close.length;
    return null;
  };

  if (state) {
    const open = span(state.type, 0, 0, state.close);
    if (open) return { tokens, end: open };
  }
  while (index < line.length) {
    const char = line[index]!;
    if (config.blockComment && line.startsWith(config.blockComment[0], index)) {
      const open = span("comment", index, index + config.blockComment[0].length, config.blockComment[1]);
      if (open) return { tokens, end: open };
      continue;
    }
    if (line.startsWith(config.lineComment, index)) {
      emit("comment", line.slice(index));
      return { tokens, end: null };
    }
    if (config.longStrings && line.startsWith("[[", index)) {
      const open = span("string", index, index + 2, "]]");
      if (open) return { tokens, end: open };
      continue;
    }
    if (char === '"' || char === "'") {
      // An unclosed quote runs on to the next one, over the newline, as the whole-document tokenizer's does: carried.
      let cursor = index + 1;
      while (cursor < line.length && line[cursor] !== char) cursor += line[cursor] === "\\" ? 2 : 1;
      if (cursor >= line.length) {
        emit("string", line.slice(index));
        return { tokens, end: { type: "string", close: char } };
      }
      emit("string", line.slice(index, cursor + 1));
      index = cursor + 1;
      continue;
    }
    if (isDigit(char)) {
      let cursor = index;
      while (cursor < line.length && /[0-9a-fA-FxX.]/.test(line[cursor]!)) cursor += 1;
      emit("number", line.slice(index, cursor));
      index = cursor;
      continue;
    }
    if (isIdentStart(char)) {
      let cursor = index;
      while (cursor < line.length && isIdentPart(line[cursor]!)) cursor += 1;
      const word = line.slice(index, cursor);
      if (keywords.has(word)) emit("keyword", word);
      else if (TIC80_API.has(word)) emit("api", word);
      else text += word;
      index = cursor;
      continue;
    }
    text += char;
    index += 1;
  }
  flushText();
  return { tokens, end: null };
}

/**
 * A document's tokens line by line, kept across edits: `update` re-tokenises
 * from the first line that changed and stops as soon as a line it reaches is
 * unchanged and starts in the state it started in before, so typing on one line
 * costs that line (and, opening or closing a block comment, the lines it
 * reaches), not the document.
 */
export class LineTokenCache {
  private lines: string[] = [];
  private states: LineState[] = [];
  private results: LineTokens[] = [];
  private readonly keywords: ReadonlySet<string>;
  /** Lines tokenised by the last update (for tests and the profiler). */
  lastWork = 0;

  constructor(private readonly config: LanguageConfig) {
    this.keywords = new Set(config.keywords);
  }

  /** The tokens of `source`, line by line. */
  update(source: string): readonly LineTokens[] {
    const next = source.split("\n");
    const old = this.lines;
    // The common prefix and suffix of unchanged lines.
    let head = 0;
    while (head < next.length && head < old.length && next[head] === old[head]) head += 1;
    let tail = 0;
    while (tail < next.length - head && tail < old.length - head && next[next.length - 1 - tail] === old[old.length - 1 - tail]) tail += 1;
    const states: LineState[] = this.states.slice(0, head);
    const results: LineTokens[] = this.results.slice(0, head);
    let work = 0;
    let state: LineState = head === 0 ? null : this.results[head - 1]!.end;
    for (let i = head; i < next.length; i += 1) {
      // Past the edit, an unchanged line starting in its old state has the rest of the old tokens after it.
      const oldIndex = i - next.length + old.length;
      if (i >= next.length - tail && oldIndex >= 0 && sameState(state, this.states[oldIndex] ?? null)) {
        for (let k = oldIndex; k < old.length; k += 1) {
          states.push(this.states[k]!);
          results.push(this.results[k]!);
        }
        break;
      }
      const result = tokenizeLine(next[i]!, state, this.config, this.keywords);
      states.push(state);
      results.push(result);
      state = result.end;
      work += 1;
    }
    this.lines = next;
    this.states = states;
    this.results = results;
    this.lastWork = work;
    return results;
  }
}
