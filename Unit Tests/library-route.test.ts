/**
 * Unit tests for the asset-library HTTP seam (`parseLibraryRequest`,
 * `buildLibraryResponse`). These guard the two behaviours the route depends on:
 * request parameters map onto a query leniently (unknown mediums dropped, page
 * size clamped, absent values defaulted) so a hand-edited URL never 400s, and the
 * response reports categories from the *whole* catalogue so filter chips do not
 * vanish as results narrow.
 *
 * The manifest under test is produced by the real `parseLibraryManifest`, and
 * `URLSearchParams` is fed exactly what a browser would send.
 */

import { describe, expect, it } from "vitest";

import { parseLibraryManifest, LIBRARY_MANIFEST_VERSION } from "@/lib/libraryManifest";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildLibraryResponse,
  parseLibraryRequest,
} from "@/lib/libraryRoute";

function manifest() {
  const specs = [
    { id: "barrel", name: "Barrel", kind: "mesh", category: "props", tags: ["wood"] },
    { id: "crate", name: "Crate", kind: "mesh", category: "props", tags: ["wood"] },
    { id: "hero", name: "Hero", kind: "sprite", category: "characters", tags: ["player"] },
    { id: "grass", name: "Grass", kind: "tile", category: "tilesets", tags: ["nature"] },
  ];
  return parseLibraryManifest({
    version: LIBRARY_MANIFEST_VERSION,
    assets: specs.map((spec) => ({
      ...spec,
      thumbnailUrl: `/library/thumbs/${spec.id}.png`,
      payloadUrl: `/library/${spec.id}`,
      sizeBytes: 1024,
      provenance: { source: "Kenney", author: "Kenney", license: "CC0-1.0", url: "https://kenney.nl" },
    })),
  });
}

function params(search: string): URLSearchParams {
  return new URL(`https://x/api/library${search}`).searchParams;
}

describe("parseLibraryRequest", () => {
  it("reads text, repeated kinds, categories, and tags", () => {
    const request = parseLibraryRequest(params("?q=barrel&kind=mesh&kind=sprite&category=props&tag=wood"));
    expect(request.query).toEqual({
      text: "barrel",
      kinds: ["mesh", "sprite"],
      categories: ["props"],
      tags: ["wood"],
    });
  });

  it("drops unknown mediums rather than erroring", () => {
    expect(parseLibraryRequest(params("?kind=mesh&kind=hologram")).query.kinds).toEqual(["mesh"]);
  });

  it("omits empty query fields so an empty search means 'everything'", () => {
    expect(parseLibraryRequest(params("")).query).toEqual({});
    expect(parseLibraryRequest(params("?q=%20%20")).query).toEqual({});
  });

  it("defaults and clamps the page size", () => {
    expect(parseLibraryRequest(params("")).pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(parseLibraryRequest(params("?pageSize=9999")).pageSize).toBe(MAX_PAGE_SIZE);
    expect(parseLibraryRequest(params("?pageSize=0")).pageSize).toBe(1);
    expect(parseLibraryRequest(params("?pageSize=notanumber")).pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it("defaults the page to the first and floors negatives", () => {
    expect(parseLibraryRequest(params("")).page).toBe(0);
    expect(parseLibraryRequest(params("?page=-3")).page).toBe(0);
  });
});

describe("buildLibraryResponse", () => {
  const catalogue = manifest();

  it("returns the filtered, paged slice with totals", () => {
    const response = buildLibraryResponse(
      catalogue,
      parseLibraryRequest(params("?kind=mesh&pageSize=1&page=1")),
    );
    expect(response.items.map((item) => item.id)).toEqual(["crate"]);
    expect(response.totalItems).toBe(2);
    expect(response.pageCount).toBe(2);
    expect(response.page).toBe(1);
  });

  it("scopes category chips to the requested medium (no empty categories)", () => {
    // The mesh browser must not offer 'characters' or 'tilesets' — those media
    // have no meshes, so selecting them would strand the user on an empty grid.
    const response = buildLibraryResponse(catalogue, parseLibraryRequest(params("?kind=mesh")));
    expect(response.items.every((item) => item.category === "props")).toBe(true);
    expect(response.categories).toEqual(["props"]);
  });

  it("lists every category when no medium filter is set", () => {
    const response = buildLibraryResponse(catalogue, parseLibraryRequest(params("")));
    expect(response.categories).toEqual(["props", "characters", "tilesets"]);
  });

  it("keeps the medium's category chips stable when a category is selected", () => {
    // Picking 'props' within the mesh browser must not collapse the chip list to
    // just 'props' — the other in-medium categories stay reachable.
    const response = buildLibraryResponse(
      catalogue,
      parseLibraryRequest(params("?kind=mesh&kind=sprite&category=props")),
    );
    expect(response.categories).toEqual(["props", "characters"]);
  });

  it("returns the full catalogue for an empty request", () => {
    const response = buildLibraryResponse(catalogue, parseLibraryRequest(params("")));
    expect(response.totalItems).toBe(4);
    expect(response.items).toHaveLength(4);
  });
});
