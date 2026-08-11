/**
 * Unit tests for the asset-library manifest contract (`parseLibraryManifest` and
 * `provenanceCredit`). The manifest is untrusted input served over HTTP, so the
 * suite guards two things: that a well-formed catalogue round-trips through JSON
 * with its fields intact and normalised, and that every way the input can be
 * malformed — a disallowed licence, a bad version, a duplicate id, a missing
 * field, a non-fetchable URL — is rejected with an error rather than trusted.
 *
 * Inputs are built by factories from explicit parameters and the assertions read
 * back those same parameters, so nothing is checked against a hand-copied
 * literal that could drift from what the code actually produced.
 */

import { describe, expect, it } from "vitest";

import {
  LIBRARY_MANIFEST_VERSION,
  LibraryManifestError,
  parseLibraryManifest,
  provenanceCredit,
  type LibraryAsset,
} from "@/lib/libraryManifest";

/** Build a valid raw provenance object, overridable field by field. */
function makeProvenance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "Kenney",
    author: "Kenney",
    license: "CC0-1.0",
    url: "https://kenney.nl/assets/barrel",
    ...overrides,
  };
}

/** Build a valid raw asset object, overridable field by field. */
function makeRawAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "kenney-barrel",
    name: "Barrel",
    kind: "mesh",
    category: "props",
    tags: ["barrel", "container"],
    thumbnailUrl: "/library/thumbs/kenney-barrel.png",
    payloadUrl: "https://cdn.example.com/library/kenney-barrel.glb",
    sizeBytes: 20_480,
    provenance: makeProvenance(),
    ...overrides,
  };
}

/** Build a valid raw manifest wrapping the given raw assets. */
function makeRawManifest(assets: unknown[]): Record<string, unknown> {
  return { version: LIBRARY_MANIFEST_VERSION, assets };
}

/** Route input through JSON as it would arrive from the network. */
function throughJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("parseLibraryManifest", () => {
  it("round-trips a well-formed manifest through JSON with fields intact", () => {
    const rawAsset = makeRawAsset();
    const manifest = parseLibraryManifest(throughJson(makeRawManifest([rawAsset])));

    expect(manifest.version).toBe(LIBRARY_MANIFEST_VERSION);
    expect(manifest.assets).toHaveLength(1);

    const asset = manifest.assets[0]!;
    expect(asset.id).toBe(rawAsset.id);
    expect(asset.name).toBe(rawAsset.name);
    expect(asset.kind).toBe(rawAsset.kind);
    expect(asset.category).toBe(rawAsset.category);
    expect(asset.payloadUrl).toBe(rawAsset.payloadUrl);
    expect(asset.thumbnailUrl).toBe(rawAsset.thumbnailUrl);
    expect(asset.sizeBytes).toBe(rawAsset.sizeBytes);
    expect(asset.provenance).toEqual(rawAsset.provenance);
  });

  it("lowercases and de-duplicates tags so search need not normalise", () => {
    const asset = parseLibraryManifest(
      makeRawManifest([makeRawAsset({ tags: ["Barrel", "BARREL", "Crate"] })]),
    ).assets[0]!;
    expect(asset.tags).toEqual(["barrel", "crate"]);
  });

  it("accepts both http(s) URLs and same-origin absolute paths for payloads", () => {
    const httpAsset = makeRawAsset({ id: "a", payloadUrl: "https://cdn/x.glb" });
    const pathAsset = makeRawAsset({ id: "b", payloadUrl: "/library/x.glb" });
    const manifest = parseLibraryManifest(makeRawManifest([httpAsset, pathAsset]));
    expect(manifest.assets.map((asset) => asset.payloadUrl)).toEqual([
      "https://cdn/x.glb",
      "/library/x.glb",
    ]);
  });

  it("rejects a licence outside the allowed public-domain set", () => {
    const raw = makeRawManifest([makeRawAsset({ provenance: makeProvenance({ license: "CC-BY-4.0" }) })]);
    expect(() => parseLibraryManifest(raw)).toThrow(LibraryManifestError);
    expect(() => parseLibraryManifest(raw)).toThrow(/license/i);
  });

  it("rejects an unsupported manifest version", () => {
    const raw = { version: LIBRARY_MANIFEST_VERSION + 1, assets: [] };
    expect(() => parseLibraryManifest(raw)).toThrow(/version/i);
  });

  it("rejects duplicate asset ids that would collide as R2 or React keys", () => {
    const raw = makeRawManifest([makeRawAsset({ id: "dup" }), makeRawAsset({ id: "dup" })]);
    expect(() => parseLibraryManifest(raw)).toThrow(/duplicate asset id/i);
  });

  it("rejects a non-fetchable payload URL (relative, not absolute or http)", () => {
    const raw = makeRawManifest([makeRawAsset({ payloadUrl: "barrel.glb" })]);
    expect(() => parseLibraryManifest(raw)).toThrow(/payloadUrl/);
  });

  it("rejects a negative payload size", () => {
    const raw = makeRawManifest([makeRawAsset({ sizeBytes: -1 })]);
    expect(() => parseLibraryManifest(raw)).toThrow(/sizeBytes/);
  });

  it.each(["id", "name", "category"])("rejects a missing required field: %s", (field) => {
    const raw = makeRawManifest([makeRawAsset({ [field]: "" })]);
    expect(() => parseLibraryManifest(raw)).toThrow(LibraryManifestError);
  });

  it("rejects an unknown asset kind", () => {
    const raw = makeRawManifest([makeRawAsset({ kind: "hologram" })]);
    expect(() => parseLibraryManifest(raw)).toThrow(/kind/);
  });

  it("rejects a non-object manifest", () => {
    expect(() => parseLibraryManifest(null)).toThrow(/manifest must be an object/);
    expect(() => parseLibraryManifest("[]")).toThrow(/manifest must be an object/);
  });
});

describe("provenanceCredit", () => {
  const asset = (overrides: Partial<LibraryAsset["provenance"]> & { name?: string }): LibraryAsset =>
    parseLibraryManifest(
      makeRawManifest([
        makeRawAsset({
          name: overrides.name ?? "Barrel",
          provenance: makeProvenance({ ...overrides, name: undefined }),
        }),
      ]),
    ).assets[0]!;

  it("collapses author and source when they are the same", () => {
    expect(provenanceCredit(asset({ author: "Kenney", source: "Kenney" }))).toBe(
      "Barrel by Kenney — CC0-1.0",
    );
  });

  it("shows author and source separately when they differ", () => {
    expect(provenanceCredit(asset({ author: "Jane Doe", source: "Poly Haven" }))).toBe(
      "Barrel by Jane Doe (Poly Haven) — CC0-1.0",
    );
  });
});
