/**
 * Unit tests for the asset-library query logic (`searchLibrary`, `categoriesOf`,
 * `paginate`). These guard the browsing contract a creator relies on: text terms
 * combine with AND across every searchable field, medium/category chips widen
 * their own axis while narrowing overall, tag requirements are conjunctive, and
 * paging stays in range as filters shrink the result set.
 *
 * The catalogue under test is built from a parameter table via the real
 * `parseLibraryManifest`, so every asset is exactly what production would parse
 * and the assertions compare against ids derived from that same table.
 */

import { describe, expect, it } from "vitest";

import {
  parseLibraryManifest,
  LIBRARY_MANIFEST_VERSION,
  type LibraryAsset,
  type LibraryAssetKind,
} from "@/lib/libraryManifest";
import { categoriesOf, paginate, searchLibrary } from "@/lib/librarySearch";

interface AssetSpec {
  id: string;
  name: string;
  kind: LibraryAssetKind;
  category: string;
  tags: string[];
  author?: string;
  source?: string;
}

/** Build a parsed catalogue from a compact spec table (actual parsed assets). */
function catalogue(specs: AssetSpec[]): LibraryAsset[] {
  const assets = specs.map((spec) => ({
    id: spec.id,
    name: spec.name,
    kind: spec.kind,
    category: spec.category,
    tags: spec.tags,
    thumbnailUrl: `/library/thumbs/${spec.id}.png`,
    payloadUrl: `/library/${spec.id}`,
    sizeBytes: 1024,
    provenance: {
      source: spec.source ?? "Kenney",
      author: spec.author ?? spec.source ?? "Kenney",
      license: "CC0-1.0",
      url: `https://example.com/${spec.id}`,
    },
  }));
  return parseLibraryManifest({ version: LIBRARY_MANIFEST_VERSION, assets }).assets as LibraryAsset[];
}

const SPECS: AssetSpec[] = [
  { id: "barrel", name: "Wooden Barrel", kind: "mesh", category: "props", tags: ["wood", "container"] },
  { id: "crate", name: "Crate", kind: "mesh", category: "props", tags: ["wood", "container"] },
  { id: "hero", name: "Hero Knight", kind: "sprite", category: "characters", tags: ["player", "medieval"], author: "Jane" },
  { id: "grass", name: "Grass Tile", kind: "tile", category: "tilesets", tags: ["nature", "green"] },
  { id: "rock", name: "Rock Chunk", kind: "voxel", category: "props", tags: ["nature", "stone"] },
];

function ids(assets: readonly LibraryAsset[]): string[] {
  return assets.map((asset) => asset.id);
}

describe("searchLibrary", () => {
  const assets = catalogue(SPECS);

  it("returns the whole catalogue in curation order for an empty query", () => {
    expect(ids(searchLibrary(assets))).toEqual(SPECS.map((spec) => spec.id));
  });

  it("matches free text across name, and is case-insensitive", () => {
    expect(ids(searchLibrary(assets, { text: "barrel" }))).toEqual(["barrel"]);
    expect(ids(searchLibrary(assets, { text: "KNIGHT" }))).toEqual(["hero"]);
  });

  it("matches free text against tags, author, and category too", () => {
    expect(ids(searchLibrary(assets, { text: "container" })).sort()).toEqual(["barrel", "crate"]);
    expect(ids(searchLibrary(assets, { text: "jane" }))).toEqual(["hero"]);
    expect(ids(searchLibrary(assets, { text: "tilesets" }))).toEqual(["grass"]);
  });

  it("requires every text term to appear (terms combine with AND)", () => {
    expect(ids(searchLibrary(assets, { text: "wood container" })).sort()).toEqual(["barrel", "crate"]);
    expect(ids(searchLibrary(assets, { text: "wood nature" }))).toEqual([]);
  });

  it("filters by medium, ORing within kinds", () => {
    expect(ids(searchLibrary(assets, { kinds: ["sprite", "tile"] })).sort()).toEqual(["grass", "hero"]);
  });

  it("filters by category case-insensitively", () => {
    expect(ids(searchLibrary(assets, { categories: ["PROPS"] })).sort()).toEqual(["barrel", "crate", "rock"]);
  });

  it("requires all listed tags (tags combine with AND)", () => {
    expect(ids(searchLibrary(assets, { tags: ["wood", "container"] })).sort()).toEqual(["barrel", "crate"]);
    expect(ids(searchLibrary(assets, { tags: ["wood", "stone"] }))).toEqual([]);
  });

  it("combines axes with AND (kind ∧ category ∧ text)", () => {
    const result = searchLibrary(assets, { kinds: ["mesh"], categories: ["props"], text: "crate" });
    expect(ids(result)).toEqual(["crate"]);
  });

  it("does not mutate its input", () => {
    const before = ids(assets);
    searchLibrary(assets, { text: "barrel", kinds: ["mesh"] });
    expect(ids(assets)).toEqual(before);
  });
});

describe("categoriesOf", () => {
  it("lists distinct categories in first-seen order", () => {
    expect(categoriesOf(catalogue(SPECS))).toEqual(["props", "characters", "tilesets"]);
  });
});

describe("paginate", () => {
  const assets = catalogue(SPECS); // 5 assets

  it("returns the requested slice and total context", () => {
    const page = paginate(assets, 0, 2);
    expect(ids(page.items)).toEqual(["barrel", "crate"]);
    expect(page.page).toBe(0);
    expect(page.pageCount).toBe(3);
    expect(page.totalItems).toBe(5);
  });

  it("returns a partial final page", () => {
    expect(ids(paginate(assets, 2, 2).items)).toEqual(["rock"]);
  });

  it("clamps an out-of-range page into the valid last page", () => {
    const page = paginate(assets, 99, 2);
    expect(page.page).toBe(2);
    expect(ids(page.items)).toEqual(["rock"]);
  });

  it("reports a single empty page for an empty result set", () => {
    const page = paginate([], 0, 10);
    expect(page.items).toEqual([]);
    expect(page.pageCount).toBe(1);
    expect(page.totalItems).toBe(0);
  });

  it("rejects a non-positive page size", () => {
    expect(() => paginate(assets, 0, 0)).toThrow(RangeError);
  });
});
