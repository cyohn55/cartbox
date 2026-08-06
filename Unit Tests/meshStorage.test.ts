/**
 * Unit tests for the mesh-sidecar offload logic (lib/meshStorage): the reference
 * encode/parse, the size threshold, and the inline/fallback behaviour of the
 * store + resolve paths. The real R2 round-trip (upload + fetch back) is covered
 * separately against local object storage; here the storage credentials are
 * absent, which is exactly the "no R2" path a dev box or unprovisioned deploy
 * hits — so these prove offload degrades to inline without ever throwing.
 */

import { describe, expect, it } from "vitest";

import {
  MESH_INLINE_LIMIT,
  buildMeshReference,
  parseMeshReference,
  shouldOffload,
  storeMeshSidecar,
  resolveMeshSidecar,
  deleteMeshObject,
  meshObjectKey,
} from "@/lib/meshStorage";

/** A minimal but structurally-real inline sidecar of a given byte size. */
function inlineSidecar(bytes: number): string {
  const filler = "a".repeat(Math.max(0, bytes - 40));
  return JSON.stringify({ version: 1, meshes: [{ id: "m", name: filler }] });
}

describe("mesh reference encode/parse", () => {
  it("round-trips an object key through a reference", () => {
    const ref = buildMeshReference("meshes/abc.json");
    expect(parseMeshReference(ref)).toBe("meshes/abc.json");
  });

  it("does not mistake a real inline sidecar for a reference", () => {
    expect(parseMeshReference(JSON.stringify({ version: 1, meshes: [] }))).toBeNull();
  });

  it("returns null for empty, non-JSON, or keyless payloads", () => {
    expect(parseMeshReference(null)).toBeNull();
    expect(parseMeshReference("")).toBeNull();
    expect(parseMeshReference("not json")).toBeNull();
    expect(parseMeshReference(JSON.stringify({ $meshRef: "" }))).toBeNull();
  });

  it("keys an offloaded object by cart id", () => {
    expect(meshObjectKey("cart-123")).toBe("meshes/cart-123.json");
  });
});

describe("offload threshold", () => {
  it("offloads only above the inline limit", () => {
    expect(shouldOffload(inlineSidecar(1024))).toBe(false);
    expect(shouldOffload("x".repeat(MESH_INLINE_LIMIT + 1))).toBe(true);
  });
});

describe("storeMeshSidecar without object storage (fallback)", () => {
  it("clears on an empty payload", async () => {
    expect(await storeMeshSidecar("cart-1", null)).toBeNull();
  });

  it("keeps a small sidecar inline unchanged", async () => {
    const small = inlineSidecar(2048);
    expect(await storeMeshSidecar("cart-1", small)).toBe(small);
  });

  it("falls back to inline for a large sidecar when R2 is unconfigured", async () => {
    // No R2_* env in the test environment, so a large sidecar can't offload and
    // must be stored inline rather than throwing — offload never blocks a save.
    const large = "x".repeat(MESH_INLINE_LIMIT + 1000);
    expect(await storeMeshSidecar("cart-1", large)).toBe(large);
  });
});

describe("resolveMeshSidecar", () => {
  it("passes an inline sidecar through unchanged", async () => {
    const inline = inlineSidecar(2048);
    expect(await resolveMeshSidecar(inline)).toBe(inline);
  });

  it("returns null for an empty stored value", async () => {
    expect(await resolveMeshSidecar(null)).toBeNull();
  });
});

describe("deleteMeshObject", () => {
  it("is a safe no-op when object storage is unconfigured", async () => {
    // No R2_* env in the test environment: cleanup must never throw (it can't
    // fail a Save), so this resolves without touching storage.
    await expect(deleteMeshObject("cart-1")).resolves.toBeUndefined();
  });
});
