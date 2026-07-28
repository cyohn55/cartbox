/**
 * Unit tests for the TIC-80 archive catalog parser — the pure translation of
 * tic80.com's Lua-table directory listing into typed arcade entries, plus the
 * binary/cover URL builders the Browse tab plays from.
 *
 * Run with:
 *   npx vitest run
 */

import { describe, expect, it } from "vitest";

import {
  parseTicDir,
  ticArcadeCartUrl,
  ticArcadeCoverUrl,
} from "../apps/web/src/lib/ticArcade";

/** Verbatim shape of the live /api?fn=dir&path=play/games response. */
const SAMPLE_LISTING = `folders =
{
\t{ name = "New" },
\t{ name = "Recent" },

}

files =
{
\t{ name = "8 Bit Panda.tic", hash = "b88b74e7a6f923251de764d89d6f3507", id = 188, filename = "8_bit_panda.tic"},
\t{ name = "Mario Bros?.tic", hash = "51ebbe2af13164b2d47f2a2fe0a5a937", id = 223, filename = "mario_bros.tic"},
\t{ name = "FPS80.tic", hash = "13dacc4d8b359a393f9e87bc9b514f42", id = 237, filename = "fps80.tic"},

}
`;

describe("parseTicDir", () => {
  it("parses every file row into a typed entry", () => {
    const entries = parseTicDir(SAMPLE_LISTING);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      id: 188,
      title: "8 Bit Panda",
      hash: "b88b74e7a6f923251de764d89d6f3507",
      filename: "8_bit_panda.tic",
    });
  });

  it("keeps punctuation in titles and strips only the .tic suffix", () => {
    const entries = parseTicDir(SAMPLE_LISTING);
    expect(entries[1]!.title).toBe("Mario Bros?");
  });

  it("ignores folder rows (no hash/id/filename)", () => {
    const entries = parseTicDir(SAMPLE_LISTING);
    expect(entries.every((entry) => entry.hash.length === 32)).toBe(true);
  });

  it("skips malformed rows instead of throwing on external input", () => {
    const mangled = `files = { { name = "Broken.tic", hash = "not-hex!", id = x, filename = }, ${SAMPLE_LISTING} }`;
    const entries = parseTicDir(mangled);
    expect(entries).toHaveLength(3);
  });

  it("returns an empty list for empty or unrelated text", () => {
    expect(parseTicDir("")).toEqual([]);
    expect(parseTicDir("<p>404. Not Found!</p>")).toEqual([]);
  });
});

describe("arcade URLs", () => {
  const entry = {
    id: 188,
    title: "8 Bit Panda",
    hash: "b88b74e7a6f923251de764d89d6f3507",
    filename: "8_bit_panda.tic",
  };

  it("addresses the cart binary by hash and filename", () => {
    expect(ticArcadeCartUrl(entry)).toBe(
      "https://tic80.com/cart/b88b74e7a6f923251de764d89d6f3507/8_bit_panda.tic",
    );
  });

  it("addresses the cover art beside the binary", () => {
    expect(ticArcadeCoverUrl(entry)).toBe(
      "https://tic80.com/cart/b88b74e7a6f923251de764d89d6f3507/cover.gif",
    );
  });

  it("honors a mirror base URL", () => {
    expect(ticArcadeCartUrl(entry, "https://mirror.example")).toContain("https://mirror.example/cart/");
  });
});
