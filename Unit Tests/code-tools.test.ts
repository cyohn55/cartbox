/**
 * Code-editor text-operation tests
 * (apps/web/src/app/edit/[cartId]/codeTools.ts).
 *
 * The code editor had no find, no replace, no auto-indent, and no way to reach
 * the line a runtime error blamed — the last of which is what closes the
 * edit → run → fix loop the whole editor exists to serve. Each of those is
 * string arithmetic with more edge cases than it looks, so it was written apart
 * from the textarea and is driven directly here.
 */

import { describe, expect, it } from "vitest";

import {
  errorLineFrom,
  findMatches,
  indentOf,
  lineRangeAt,
  newlineIndent,
  nextMatchIndex,
  offsetOfLine,
  reindentClosing,
  replaceAll,
  replaceMatch,
} from "@/app/edit/[cartId]/codeTools";

describe("findMatches", () => {
  it("finds every occurrence, in order", () => {
    const matches = findMatches("spr spr spr", "spr");
    expect(matches.map((match) => match.start)).toEqual([0, 4, 8]);
  });

  it("ignores case by default", () => {
    expect(findMatches("SPR spr", "spr")).toHaveLength(2);
  });

  it("respects case when asked", () => {
    expect(findMatches("SPR spr", "spr", { caseSensitive: true })).toHaveLength(1);
  });

  it("finds overlapping occurrences of a repeating needle", () => {
    expect(findMatches("aaa", "aa")).toHaveLength(2);
  });

  it("treats regex characters as literal text", () => {
    // A creator typing "(" wants a bracket, not a pattern error.
    expect(findMatches("f(x) g(y)", "(")).toHaveLength(2);
    expect(findMatches("a.b axb", ".")).toHaveLength(1);
  });

  it("matches whole words only when asked", () => {
    expect(findMatches("spr sprite", "spr", { wholeWord: true })).toHaveLength(1);
  });

  it("finds nothing for an empty query", () => {
    expect(findMatches("anything", "")).toEqual([]);
  });
});

describe("nextMatchIndex", () => {
  const matches = [
    { start: 2, end: 4 },
    { start: 10, end: 12 },
    { start: 20, end: 22 },
  ];

  it("finds the first match at or after the caret", () => {
    expect(nextMatchIndex(matches, 5)).toBe(1);
  });

  it("wraps to the top past the last match", () => {
    expect(nextMatchIndex(matches, 99)).toBe(0);
  });

  it("walks backwards, wrapping to the bottom", () => {
    expect(nextMatchIndex(matches, 11, true)).toBe(1);
    expect(nextMatchIndex(matches, 0, true)).toBe(2);
  });

  it("returns -1 when there is nothing to find", () => {
    expect(nextMatchIndex([], 0)).toBe(-1);
  });
});

describe("replacing", () => {
  it("replaces one match and reports where the caret lands", () => {
    const result = replaceMatch("a spr b", { start: 2, end: 5 }, "print");
    expect(result.text).toBe("a print b");
    expect(result.caret).toBe(7);
  });

  it("replaces every match in one pass", () => {
    const text = "x x x";
    expect(replaceAll(text, findMatches(text, "x"), "y")).toBe("y y y");
  });

  it("handles a replacement longer than what it replaces", () => {
    const text = "ab ab";
    expect(replaceAll(text, findMatches(text, "ab"), "abcd")).toBe("abcd abcd");
  });
});

describe("line addressing", () => {
  const text = "one\ntwo\nthree";

  it("finds the offset of a 1-based line", () => {
    expect(offsetOfLine(text, 1)).toBe(0);
    expect(offsetOfLine(text, 2)).toBe(4);
    expect(offsetOfLine(text, 3)).toBe(8);
  });

  it("clamps a line past the end to the end", () => {
    expect(offsetOfLine(text, 99)).toBe(text.length);
  });

  it("finds the range of the line containing an offset", () => {
    expect(lineRangeAt(text, 5)).toEqual({ start: 4, end: 7 });
  });

  it("runs the last line to the end of the text", () => {
    expect(lineRangeAt(text, 9)).toEqual({ start: 8, end: text.length });
  });
});

describe("auto-indent", () => {
  it("carries the current line's indent onto the next", () => {
    const text = "  local x = 1";
    expect(newlineIndent(text, text.length, "lua")).toBe("\n  ");
  });

  it("goes one level deeper after a line that opens a block", () => {
    const text = "if x then";
    expect(newlineIndent(text, text.length, "lua")).toBe("\n  ");
  });

  it("does not go deeper after a one-line block that already closed", () => {
    const text = "if x then y = 1 end";
    expect(newlineIndent(text, text.length, "lua")).toBe("\n");
  });

  it("uses the language's own indent unit", () => {
    const text = "def go():";
    expect(newlineIndent(text, text.length, "python")).toBe("\n    ");
  });

  it("opens a block on a trailing brace in JavaScript", () => {
    const text = "function go() {";
    expect(newlineIndent(text, text.length, "js")).toBe("\n  ");
  });

  it("reads the leading whitespace of a line", () => {
    expect(indentOf("    deep", 6)).toBe("    ");
    expect(indentOf("flush", 2)).toBe("");
  });
});

describe("re-indenting a closing line", () => {
  it("pulls an `end` back out one level", () => {
    const text = "if x then\n    end";
    const result = reindentClosing(text, text.length, "lua");
    expect(result?.text).toBe("if x then\n  end");
    expect(result?.shift).toBe(-2);
  });

  it("leaves a line that closes nothing alone", () => {
    expect(reindentClosing("  local x = 1", 8, "lua")).toBeNull();
  });

  it("leaves an already-flush closing line alone", () => {
    expect(reindentClosing("end", 3, "lua")).toBeNull();
  });

  it("dedents an `else`, which sits with its `if`", () => {
    const text = "if x then\n    else";
    expect(reindentClosing(text, text.length, "lua")?.text).toBe("if x then\n  else");
  });
});

describe("errorLineFrom", () => {
  it("reads the line out of a Lua runtime error", () => {
    expect(errorLineFrom("cart.lua:12: attempt to index a nil value")).toBe(12);
  });

  it("reads a message that spells the word out", () => {
    expect(errorLineFrom("SyntaxError at line 7")).toBe(7);
  });

  it("returns nothing when the message names no line", () => {
    expect(errorLineFrom("something went wrong")).toBeNull();
  });

  it("rejects line zero rather than jumping somewhere wrong", () => {
    expect(errorLineFrom("cart.lua:0: what")).toBeNull();
  });
});
