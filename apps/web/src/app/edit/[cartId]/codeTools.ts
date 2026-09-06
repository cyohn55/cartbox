/**
 * Text operations for the code editor, kept pure and away from the textarea.
 *
 * Find and replace, auto-indent and error-line parsing are all small pieces of
 * string arithmetic with an unusual number of edge cases — an empty needle, a
 * regex-special character in it, a `case` that dedents, an error message from a
 * language that numbers its lines differently. Testing them through a rendered
 * textarea would be slow and would prove very little, so they live here.
 */

/** One match of the find query. */
export interface Match {
  readonly start: number;
  readonly end: number;
}

export interface FindOptions {
  readonly caseSensitive?: boolean;
  /** Match only whole words. */
  readonly wholeWord?: boolean;
}

/**
 * Every occurrence of `query` in `text`, in order.
 *
 * Plain string search rather than a regex from user input: a creator typing
 * `(` into a find box wants to find a bracket, not to be told their pattern is
 * malformed.
 */
export function findMatches(text: string, query: string, options: FindOptions = {}): Match[] {
  if (query.length === 0) return [];
  const haystack = options.caseSensitive ? text : text.toLowerCase();
  const needle = options.caseSensitive ? query : query.toLowerCase();
  const matches: Match[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    const end = at + needle.length;
    if (!options.wholeWord || isWholeWord(text, at, end)) matches.push({ start: at, end });
    // Advance by one, not by the needle's length, so overlapping matches of a
    // repeating needle ("aa" in "aaa") are all found.
    from = at + 1;
  }
  return matches;
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

function isWholeWord(text: string, start: number, end: number): boolean {
  return !isWordChar(text[start - 1]) && !isWordChar(text[end]);
}

/** The index of the first match at or after `from`, wrapping around. */
export function nextMatchIndex(matches: readonly Match[], from: number, backwards = false): number {
  if (matches.length === 0) return -1;
  if (backwards) {
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      if ((matches[index]?.start ?? 0) < from) return index;
    }
    return matches.length - 1;
  }
  for (let index = 0; index < matches.length; index += 1) {
    if ((matches[index]?.start ?? 0) >= from) return index;
  }
  return 0;
}

/** Replace one match, returning the new text and where the caret should land. */
export function replaceMatch(
  text: string,
  match: Match,
  replacement: string,
): { text: string; caret: number } {
  return {
    text: text.slice(0, match.start) + replacement + text.slice(match.end),
    caret: match.start + replacement.length,
  };
}

/** Replace every match in one pass, right to left so earlier offsets hold. */
export function replaceAll(text: string, matches: readonly Match[], replacement: string): string {
  let output = text;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index]!;
    output = output.slice(0, match.start) + replacement + output.slice(match.end);
  }
  return output;
}

/** Character offset of the start of a 1-based line, clamped into the text. */
export function offsetOfLine(text: string, line: number): number {
  if (line <= 1) return 0;
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const at = text.indexOf("\n", offset);
    if (at === -1) return text.length;
    offset = at + 1;
  }
  return offset;
}

/** The whole 1-based line containing `offset`, as [start, end). */
export function lineRangeAt(text: string, offset: number): { start: number; end: number } {
  const start = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const newline = text.indexOf("\n", offset);
  return { start, end: newline === -1 ? text.length : newline };
}

/** How each language opens and closes a block, for auto-indent. */
export interface IndentRules {
  /** Lines matching this are followed by a deeper one. */
  readonly opens: RegExp;
  /** Lines matching this sit one level shallower than the line before. */
  readonly closes: RegExp;
  readonly unit: string;
}

const INDENT_RULES: Record<string, IndentRules> = {
  lua: {
    opens: /(^|\s)(function|if|for|while|repeat|do|else|elseif)\b(?!.*\bend\b)|[{([]\s*$/,
    closes: /^\s*(end|else|elseif|until|[)\]}])/,
    unit: "  ",
  },
  js: {
    opens: /[{([]\s*$|(^|\s)(else|do|try)\s*$/,
    closes: /^\s*[)\]}]|^\s*(else|catch|finally)\b/,
    unit: "  ",
  },
  python: {
    opens: /:\s*$/,
    closes: /^\s*(else|elif|except|finally)\b/,
    unit: "    ",
  },
};

export function indentRules(language: string): IndentRules {
  return INDENT_RULES[language] ?? INDENT_RULES.lua!;
}

/** The leading whitespace of the line containing `offset`. */
export function indentOf(text: string, offset: number): string {
  const { start, end } = lineRangeAt(text, offset);
  const line = text.slice(start, end);
  return line.slice(0, line.length - line.trimStart().length);
}

/**
 * What pressing Enter should insert: a newline plus the current line's indent,
 * one level deeper when the line opened a block.
 *
 * Returns the text to insert rather than mutating anything, so the caller keeps
 * control of the caret — which a textarea makes fiddly enough on its own.
 */
export function newlineIndent(text: string, offset: number, language: string): string {
  const rules = indentRules(language);
  const { start, end } = lineRangeAt(text, offset);
  const line = text.slice(start, Math.min(end, offset));
  const indent = indentOf(text, offset);
  return rules.opens.test(line) ? `\n${indent}${rules.unit}` : `\n${indent}`;
}

/**
 * Re-indent a line the creator has just closed, so typing `end` snaps it back
 * out one level. Returns the new text and how far the caret moved, or null when
 * nothing should change.
 */
export function reindentClosing(
  text: string,
  offset: number,
  language: string,
): { text: string; shift: number } | null {
  const rules = indentRules(language);
  const { start, end } = lineRangeAt(text, offset);
  const line = text.slice(start, end);
  if (!rules.closes.test(line)) return null;

  const indent = line.slice(0, line.length - line.trimStart().length);
  if (indent.length < rules.unit.length) return null;
  const dedented = indent.slice(rules.unit.length);
  return {
    text: text.slice(0, start) + dedented + line.trimStart() + text.slice(end),
    shift: -rules.unit.length,
  };
}

/**
 * Pull a line number out of a runtime error message.
 *
 * The Lua core reports errors as `cart.lua:12: attempt to index a nil value`,
 * and other cores use their own shapes; matching the first `:<digits>:` covers
 * every form the player has produced, and a message with no line number simply
 * yields null rather than a wrong jump.
 */
export function errorLineFrom(message: string): number | null {
  const match = /:(\d+):/.exec(message) ?? /\bline\s+(\d+)/i.exec(message);
  if (!match) return null;
  const line = Number(match[1]);
  return Number.isInteger(line) && line > 0 ? line : null;
}
