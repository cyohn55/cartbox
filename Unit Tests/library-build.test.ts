/**
 * Unit tests for the ingestion pipeline's pure core (`assembleManifest` and its
 * URL helpers). These guard that a source descriptor becomes the right catalogue
 * entry: payloads and thumbnails resolve under the given base (a same-origin path
 * locally, an origin-qualified URL for R2), each medium routes to its own
 * directory, and a malformed source fails the build rather than shipping.
 *
 * Sources are built from an explicit factory; the assembled manifest is the real
 * validated output, so a URL regression or a broken descriptor is caught here.
 */

import { describe, expect, it } from "vitest";

import { LibraryManifestError } from "@/lib/libraryManifest";
import {
  assembleManifest,
  normalizeBaseUrl,
  payloadDirForKind,
  payloadUrlFor,
  thumbnailUrlFor,
  type LibrarySource,
} from "@/lib/libraryBuild";

function source(overrides: Partial<LibrarySource> = {}): LibrarySource {
  return {
    id: "kenney-barrel",
    name: "Wooden Barrel",
    kind: "mesh",
    category: "props",
    tags: ["barrel"],
    payloadFile: "kenney-barrel.glb",
    thumbnailFile: "kenney-barrel.png",
    sizeBytes: 2224,
    provenance: { source: "Kenney", author: "Kenney", license: "CC0-1.0", url: "https://kenney.nl" },
    ...overrides,
  };
}

describe("payloadDirForKind", () => {
  it("routes each medium to its own directory", () => {
    expect(payloadDirForKind("mesh")).toBe("meshes");
    expect(payloadDirForKind("voxel")).toBe("voxels");
    expect(payloadDirForKind("sprite")).toBe("sprites");
    expect(payloadDirForKind("tile")).toBe("sprites");
  });
});

describe("normalizeBaseUrl", () => {
  it("strips trailing slashes so joins never double up", () => {
    expect(normalizeBaseUrl("")).toBe("");
    expect(normalizeBaseUrl("https://cdn.example.com/")).toBe("https://cdn.example.com");
    expect(normalizeBaseUrl("https://cdn.example.com///")).toBe("https://cdn.example.com");
  });
});

describe("URL helpers", () => {
  it("build same-origin paths for an empty base (local mode)", () => {
    const barrel = source();
    expect(payloadUrlFor("", barrel)).toBe("/library/meshes/kenney-barrel.glb");
    expect(thumbnailUrlFor("", barrel)).toBe("/library/thumbs/kenney-barrel.png");
  });

  it("qualify with the origin for an R2 base", () => {
    const tile = source({ id: "grass", kind: "tile", payloadFile: "grass.png", thumbnailFile: "grass.png" });
    expect(payloadUrlFor("https://cdn.example.com/", tile)).toBe(
      "https://cdn.example.com/library/sprites/grass.png",
    );
  });
});

describe("assembleManifest", () => {
  it("assembles a validated manifest with resolved URLs", () => {
    const manifest = assembleManifest(
      [source(), source({ id: "voxel-pyramid", kind: "voxel", payloadFile: "pyr.vox", thumbnailFile: "pyr.png" })],
      "",
    );
    expect(manifest.version).toBe(1);
    expect(manifest.assets.map((asset) => asset.id)).toEqual(["kenney-barrel", "voxel-pyramid"]);
    expect(manifest.assets[1]!.payloadUrl).toBe("/library/voxels/pyr.vox");
  });

  it("fails the build when a source is malformed", () => {
    // A non-CC0 licence must never reach a shipped manifest.
    expect(() =>
      assembleManifest([source({ provenance: { ...source().provenance, license: "CC-BY-4.0" as never } })], ""),
    ).toThrow(LibraryManifestError);
  });

  it("fails the build on a duplicate id", () => {
    expect(() => assembleManifest([source(), source()], "")).toThrow(/duplicate/i);
  });
});
