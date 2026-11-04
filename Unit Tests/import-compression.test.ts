/**
 * GPU texture formats on import (AAA_PRODUCTION_ROADMAP.md D3): a CC0
 * library's material goes through the same KTX2 compression a model file
 * does when it's imported, not only when the cart is saved.
 */
import { describe, expect, it } from "vitest";
import { encodeRgbaPng, type DecodedTexture, type MeshMaterial } from "@cartbox/editor";
import { compressMaterialTextures } from "@/lib/ktx2Policy";

const png = (v: number) => encodeRgbaPng(Uint8Array.from({ length: 64 * 64 * 4 }, (_, i) => (i * v) % 251), 64, 64);
const texture = (): DecodedTexture => ({ width: 64, height: 64, data: new Uint8Array(64 * 64 * 4) }) as DecodedTexture;

describe("a library material's maps on import (D3)", () => {
  it("become KTX2 by the import's rule, each image once, the rest of the material kept", async () => {
    const shared = { mime: "image/png", bytes: png(7) };
    const material = {
      name: "rock_wall",
      baseColorFactor: [1, 1, 1, 1],
      baseColorImage: { mime: "image/png", bytes: png(3) },
      normalImage: { mime: "image/png", bytes: png(5) },
      metallicRoughnessImage: shared,
      occlusionImage: shared,
      roughnessFactor: 0.7,
    } as unknown as MeshMaterial;
    const kinds: string[] = [];
    let loads = 0;
    const out = await compressMaterialTextures(material, {
      sceneHasKtx2: true,
      decode: async () => texture(),
      encoder: async () => {
        loads += 1;
        return (_t, kind) => {
          kinds.push(kind);
          return Uint8Array.from([0xab, 0x4b, 0x54, 0x58, 1, 2, 3]);
        };
      },
    });
    expect(out.outcome).toBe("compressed");
    expect(loads).toBe(1);
    expect(kinds.sort()).toEqual(["color", "data", "normal"]); // the shared map encoded once
    expect(out.material.baseColorImage!.mime).toBe("image/ktx2");
    expect(out.material.normalImage!.mime).toBe("image/ktx2");
    expect(out.material.metallicRoughnessImage).toBe(out.material.occlusionImage); // still one image
    expect([out.material.name, out.material.roughnessFactor]).toEqual(["rock_wall", 0.7]);
  });

  it("keeps a map that won't decode, and doesn't load the encoder for a material without PNG or JPEG maps", async () => {
    const material = { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: { mime: "image/png", bytes: png(3) } } as unknown as MeshMaterial;
    const kept = await compressMaterialTextures(material, { sceneHasKtx2: true, decode: async () => null, encoder: async () => () => new Uint8Array(4) });
    expect(kept.outcome).toBe("none");
    expect(kept.material.baseColorImage!.mime).toBe("image/png");
    let loads = 0;
    const plain = await compressMaterialTextures({ name: "p", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } as MeshMaterial, {
      sceneHasKtx2: false,
      decode: async () => null,
      encoder: async () => ((loads += 1), () => null),
    });
    expect(plain.outcome).toBe("none");
    expect(loads).toBe(0);
  });
});
