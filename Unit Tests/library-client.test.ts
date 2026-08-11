/**
 * Unit tests for the asset-library client's query-string builder
 * (`buildLibraryQueryString`). The load-bearing property is that what the client
 * encodes is exactly what the server decodes: building a string from a query and
 * parsing it back through `parseLibraryRequest` must reproduce that query. This
 * pins the two halves of the wire contract together so they cannot drift apart.
 */

import { describe, expect, it } from "vitest";

import { buildLibraryQueryString } from "@/lib/libraryClient";
import { DEFAULT_PAGE_SIZE, parseLibraryRequest } from "@/lib/libraryRoute";
import type { LibraryQuery } from "@/lib/librarySearch";

function parse(queryString: string) {
  return parseLibraryRequest(new URL(`https://x/api/library${queryString}`).searchParams);
}

describe("buildLibraryQueryString", () => {
  it("is empty for an empty query on the first page", () => {
    expect(buildLibraryQueryString()).toBe("");
  });

  it("omits the page parameter for page 0 but includes later pages", () => {
    expect(buildLibraryQueryString({}, 0)).toBe("");
    expect(buildLibraryQueryString({}, 2)).toBe("?page=2");
  });

  it("encodes text, repeated kinds, categories, and tags", () => {
    const queryString = buildLibraryQueryString({
      text: "old barrel",
      kinds: ["mesh", "sprite"],
      categories: ["props"],
      tags: ["wood"],
    });
    const params = new URL(`https://x${queryString}`).searchParams;
    expect(params.get("q")).toBe("old barrel");
    expect(params.getAll("kind")).toEqual(["mesh", "sprite"]);
    expect(params.getAll("category")).toEqual(["props"]);
    expect(params.getAll("tag")).toEqual(["wood"]);
  });

  it.each<LibraryQuery>([
    {},
    { text: "barrel" },
    { kinds: ["mesh"] },
    { kinds: ["mesh", "voxel"], categories: ["props"] },
    { text: "wood crate", kinds: ["mesh"], categories: ["props"], tags: ["wood", "container"] },
  ])("round-trips %o back through the server parser", (query) => {
    const parsed = parse(buildLibraryQueryString(query));
    expect(parsed.query).toEqual(query);
    expect(parsed.page).toBe(0);
    expect(parsed.pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it("carries an explicit page size", () => {
    expect(parse(buildLibraryQueryString({}, 0, 12)).pageSize).toBe(12);
  });
});
