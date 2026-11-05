/**
 * Incremental highlighting (AAA_PRODUCTION_ROADMAP.md K3): a tokenizer that
 * carries a line-start state, so block comments and long strings colour right
 * while an edit re-tokenises only the lines it reaches. Checked against the
 * whole-document tokenizer, character by character.
 */
import { describe, expect, it } from "vitest";
import { LineTokenCache, languageById, tokenize, type LineTokens, type Token } from "@cartbox/editor";

const LUA = languageById("lua");
const JS = languageById("js");

/** Each character's token type, from a flat token list. */
const perChar = (tokens: readonly Token[]) => tokens.flatMap((t) => Array.from(t.value, () => t.type));
/** The same from line tokens, a newline (plain text) between lines. */
const perCharLines = (lines: readonly LineTokens[]) => lines.flatMap((l, i) => [...perChar(l.tokens), ...(i < lines.length - 1 ? ["text" as const] : [])]);
/** The whole-document tokenizer's types, with each newline counted as text (as a line break is drawn). */
const reference = (source: string, config = LUA) => {
  const types = perChar(tokenize(source, config));
  return Array.from(source, (c, i) => (c === "\n" ? "text" : types[i]!));
};

const SAMPLE = `-- script: lua
local s = "a \\"quoted\\" string" .. 'single'
--[[ a block comment
  that spans
  three lines ]] x = 1
local long = [[ a long
string ]] .. 0x1F
function TIC()
  cls(0) print("hi", 2, 3) -- trailing
end`;

describe("the line tokenizer (K3)", () => {
  it("colours every character as the whole-document tokenizer does", () => {
    const lines = new LineTokenCache(LUA).update(SAMPLE);
    expect(perCharLines(lines)).toEqual(reference(SAMPLE));
    expect(lines[2]!.end).toEqual({ type: "comment", close: "]]" });
    expect(lines[4]!.end).toBeNull();
  });

  it("agrees on random Lua and on a C-style language", () => {
    const pieces = ["local", " x", " = ", "1", "\n", "--[[", "]]", "[[", '"', "'", "\\", "--", " end", "print", "(", ")", "0x2a", "\n", "\n"];
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let trial = 0; trial < 300; trial += 1) {
      const source = Array.from({ length: 40 }, () => pieces[Math.floor(rand() * pieces.length)]).join("");
      expect(perCharLines(new LineTokenCache(LUA).update(source))).toEqual(reference(source));
    }
    const js = "const a = 1; /* block\n comment */ let s = \"x\";\n// line\nfunction f() { return 2 }";
    expect(perCharLines(new LineTokenCache(JS).update(js))).toEqual(reference(js, JS));
  });
});

describe("the line cache (K3)", () => {
  const big = Array.from({ length: 2000 }, (_, i) => `local v${i} = ${i} -- line ${i}`).join("\n");

  it("re-tokenises only the line typed on", () => {
    const cache = new LineTokenCache(LUA);
    cache.update(big);
    expect(cache.lastWork).toBe(2000);
    const edited = big.replace("local v1000 = 1000", "local v1000 = 1000 + 1");
    const lines = cache.update(edited);
    expect(cache.lastWork).toBe(1);
    expect(perCharLines(lines)).toEqual(reference(edited));
  });

  it("follows a block comment opened and closed by an edit to the lines it reaches, and no further", () => {
    const cache = new LineTokenCache(LUA);
    const src = big.split("\n");
    cache.update(big);
    src[100] = "--[[ opened";
    const opened = src.join("\n");
    let lines = cache.update(opened);
    expect(cache.lastWork).toBe(1900); // everything after it is comment now
    expect(perCharLines(lines)).toEqual(reference(opened));
    // Typing inside the comment leaves every later line as it was: one line's work.
    src[500] = "still commented";
    lines = cache.update(src.join("\n"));
    expect(cache.lastWork).toBe(1);
    // Opening and closing it in one edit (a pasted block) costs the lines between, then the cache takes over.
    const fresh = new LineTokenCache(LUA);
    fresh.update(big);
    const block = big.split("\n");
    block[100] = "--[[ opened";
    block[110] = "]] closed";
    lines = fresh.update(block.join("\n"));
    expect(fresh.lastWork).toBe(11);
    expect(perCharLines(lines)).toEqual(reference(block.join("\n")));
  });

  it("handles lines added and removed", () => {
    const cache = new LineTokenCache(LUA);
    cache.update(SAMPLE);
    const added = SAMPLE.replace("function TIC()", "x = [[\nmore\n]]\nfunction TIC()");
    expect(perCharLines(cache.update(added))).toEqual(reference(added));
    const removed = added.split("\n").filter((_, i) => i !== 3).join("\n");
    expect(perCharLines(cache.update(removed))).toEqual(reference(removed));
  });
});
