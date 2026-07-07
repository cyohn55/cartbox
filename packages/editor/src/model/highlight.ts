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
