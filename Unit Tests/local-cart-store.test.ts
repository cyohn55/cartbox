/**
 * Browser-local draft tests (apps/web/src/lib/localCartStore.ts).
 *
 * This store is where the editor's worst bug lived. On the static demo build —
 * the public site, and how most people ever try the editor — Save wrote a draft
 * that had no field for the mesh sidecar and none for the world sidecar. A
 * creator could import a mesh or build an HD-2D world, press Save, be told
 * "Saved ✓", and find the work gone on reload.
 *
 * The first test here is that regression, stated directly. The rest cover the
 * migration from the old per-payload shape, so a cart mid-edit when this
 * shipped opens with its work rather than blank.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** A minimal localStorage, since these tests run outside a browser. */
class MemoryStorage {
  private readonly entries = new Map<string, string>();
  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
  clear(): void {
    this.entries.clear();
  }
  get size(): number {
    return this.entries.size;
  }
}

const storage = new MemoryStorage();
vi.stubGlobal("window", { localStorage: storage });
vi.stubGlobal("btoa", (raw: string) => Buffer.from(raw, "binary").toString("base64"));
vi.stubGlobal("atob", (raw: string) => Buffer.from(raw, "base64").toString("binary"));

const { clearCartDraft, draftBytes, loadCartDraft, saveCartDraft } = await import("@/lib/localCartStore");
const { emptySidecars } = await import("@/lib/sidecars");
const { encodeMeshSidecar, emptyMeshSidecar, addMesh } = await import("@/lib/meshSidecar");

const CART_ID = "cart-under-test";
const BYTES = new Uint8Array([1, 2, 3, 4, 250]);
const META = { title: "Cave Diver", description: "Go down.", tags: ["platformer"] };

/** A real mesh sidecar payload, built by the encoder the editor uses. */
function meshPayload(): string | null {
  const asset = {
    name: "Slab",
    primitives: [
      {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: null,
        uvs: null,
        indices: new Uint32Array([0, 1, 2]),
        material: { name: "flat", baseColorFactor: [1, 1, 1, 1], baseColorImage: null },
      },
    ],
  };
  return encodeMeshSidecar(addMesh(emptyMeshSidecar(), asset as never, "Slab").sidecar);
}

beforeEach(() => {
  storage.clear();
});

describe("the browser-local cart draft", () => {
  it("keeps mesh and world work across a save and reload", () => {
    // The regression: both were dropped on the floor by the demo build's Save.
    const mesh = meshPayload();
    expect(mesh).not.toBeNull();

    const saved = saveCartDraft(CART_ID, {
      model: "classic",
      bytes: BYTES,
      sidecars: { ...emptySidecars(), mesh },
      meta: META,
    });
    expect(saved).toBe(true);

    const draft = loadCartDraft(CART_ID);
    expect(draft?.sidecars.mesh).toBe(mesh);
  });

  it("keeps the marketplace details, which were also discarded", () => {
    saveCartDraft(CART_ID, { model: "classic", bytes: BYTES, sidecars: emptySidecars(), meta: META });
    const draft = loadCartDraft(CART_ID);
    expect(draft?.meta).toEqual(META);
  });

  it("round-trips the cartridge bytes exactly", () => {
    saveCartDraft(CART_ID, { model: "pro", bytes: BYTES, sidecars: emptySidecars(), meta: META });
    const draft = loadCartDraft(CART_ID);
    expect(draft).not.toBeNull();
    expect([...draftBytes(draft!)]).toEqual([...BYTES]);
    expect(draft!.model).toBe("pro");
  });

  it("marks an automatic write as unsaved, so recovery can be offered", () => {
    saveCartDraft(CART_ID, {
      model: "classic",
      bytes: BYTES,
      sidecars: emptySidecars(),
      meta: META,
      saved: false,
    });
    expect(loadCartDraft(CART_ID)?.saved).toBe(false);
  });

  it("marks a creator's own Save as saved", () => {
    saveCartDraft(CART_ID, { model: "classic", bytes: BYTES, sidecars: emptySidecars(), meta: META, saved: true });
    expect(loadCartDraft(CART_ID)?.saved).toBe(true);
  });

  it("reads a draft written in the old per-payload shape", () => {
    // A cart mid-edit when the bundle shipped must still open with its work.
    const collision = { version: 1, width: 2, height: 2, bits: "AA==" };
    storage.setItem(
      `cartbox.demo.cart.${CART_ID}`,
      JSON.stringify({
        model: "classic",
        bytesBase64: Buffer.from(BYTES).toString("base64"),
        collisionJson: JSON.stringify(collision),
        savedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const draft = loadCartDraft(CART_ID);
    expect(draft?.sidecars.collision).toEqual(collision);
  });

  it("returns nothing for a cart with no draft", () => {
    expect(loadCartDraft("never-saved")).toBeNull();
  });

  it("returns nothing for a corrupt draft rather than throwing", () => {
    storage.setItem(`cartbox.demo.cart.${CART_ID}`, "{not json");
    expect(loadCartDraft(CART_ID)).toBeNull();
  });

  it("clears a draft", () => {
    saveCartDraft(CART_ID, { model: "classic", bytes: BYTES, sidecars: emptySidecars(), meta: META });
    clearCartDraft(CART_ID);
    expect(loadCartDraft(CART_ID)).toBeNull();
  });
});
