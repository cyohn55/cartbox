/**
 * Code editor model tests. They drive the real tokenizer and CodeDocument (over
 * the real StubCartEngine) and assert on observable outputs: token
 * classification, the exact-reproduction invariant the highlight overlay relies
 * on, and cursor/line math. No hard-coded internal state.
 */

import { describe, expect, it } from "vitest";
import { CodeDocument, StubCartEngine, languageById, tokenize, type Token } from "@cartbox/editor";

const lua = languageById("lua");
const js = languageById("js");
const python = languageById("python");

function typesOf(tokens: Token[], value: string): string[] {
  return tokens.filter((token) => token.value === value).map((token) => token.type);
}

describe("tokenizer classification (Lua)", () => {
  const tokens = tokenize('function TIC() cls(1) print("hi") end -- note', lua);

  it("classifies language keywords", () => {
    expect(typesOf(tokens, "function")).toContain("keyword");
    expect(typesOf(tokens, "end")).toContain("keyword");
  });

  it("classifies the TIC-80 API", () => {
    expect(typesOf(tokens, "TIC")).toContain("api");
    expect(typesOf(tokens, "cls")).toContain("api");
    expect(typesOf(tokens, "print")).toContain("api");
  });

  it("classifies strings, numbers, and line comments", () => {
    expect(tokens.some((token) => token.type === "string" && token.value === '"hi"')).toBe(true);
    expect(tokens.some((token) => token.type === "number" && token.value === "1")).toBe(true);
    expect(tokens.some((token) => token.type === "comment" && token.value === "-- note")).toBe(true);
  });

  it("treats a Lua block comment as one comment token", () => {
    const blockTokens = tokenize("x --[[ hidden\nstill hidden ]] y", lua);
    expect(blockTokens.some((token) => token.type === "comment" && token.value.includes("still hidden"))).toBe(true);
  });
});

describe("tokenizer per-language comment syntax", () => {
  it("uses // and /* */ for JavaScript", () => {
    const tokens = tokenize("const a=1 // line\n/* block */", js);
    expect(typesOf(tokens, "const")).toContain("keyword");
    expect(tokens.some((token) => token.type === "comment" && token.value === "// line")).toBe(true);
    expect(tokens.some((token) => token.type === "comment" && token.value === "/* block */")).toBe(true);
  });

  it("uses # for Python", () => {
    const tokens = tokenize("def f(): # comment", python);
    expect(typesOf(tokens, "def")).toContain("keyword");
    expect(tokens.some((token) => token.type === "comment" && token.value === "# comment")).toBe(true);
  });
});

describe("tokenizer reproduces the source exactly", () => {
  // The highlight overlay sits behind the textarea; if the concatenated tokens
  // ever differ from the source, the caret drifts. This invariant guards that.
  const samples = [
    'function TIC()\n cls(1)\n print("hi") -- go\nend\n',
    "const x = 0xFF; // hex\n",
    "def run():\n    return 'ok' # done\n",
    "",
  ];

  it.each(samples)("round-trips sample %#", (source) => {
    const rebuilt = tokenize(source, lua)
      .map((token) => token.value)
      .join("");
    expect(rebuilt).toBe(source);
  });
});

describe("CodeDocument", () => {
  function newDoc(): CodeDocument {
    return new CodeDocument(new StubCartEngine());
  }

  it("round-trips text through the engine", () => {
    const doc = newDoc();
    doc.setText("x=1\ny=2");
    expect(doc.getText()).toBe("x=1\ny=2");
  });

  it("round-trips the language", () => {
    const doc = newDoc();
    doc.setLanguage("js");
    expect(doc.language).toBe("js");
  });

  it("counts lines, treating empty text as one line", () => {
    const doc = newDoc();
    doc.setText("a\nb\nc");
    expect(doc.lineCount()).toBe(3);
    doc.setText("");
    expect(doc.lineCount()).toBe(1);
  });

  it("resolves a character offset to a 1-based line and column", () => {
    const doc = newDoc();
    doc.setText("abc\ndef");
    expect(doc.positionAt(0)).toEqual({ line: 1, column: 1 });
    expect(doc.positionAt(4)).toEqual({ line: 2, column: 1 });
    expect(doc.positionAt(6)).toEqual({ line: 2, column: 3 });
  });
});
