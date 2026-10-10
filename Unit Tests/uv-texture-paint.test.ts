/**
 * UVs and texture painting (LOCKOUT_MULTIPLAYER_ROADMAP.md L17): unwrapping
 * a mesh into charts at one texel density, UV islands picked and edited,
 * a brush painting through the UVs into a material's base colour,
 * roughness/metal, emissive and team-colour mask maps, the mask applied to a
 * tinted copy, an image uploaded into any material slot, and material sets
 * made and edited. On Lockout's Spartan: its armour unwrapped and repainted
 * as a new armour set, which comes back unchanged from a GLB (L14) and is
 * what the bots wear.
 */

import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  MATERIAL_IMAGE_SLOTS,
  addMaterialSet,
  applyMeshVariant,
  blankLayer,
  deserializeMeshAsset,
  encodeGlb,
  encodePaintImage,
  layerValue,
  lockoutMeshSidecar,
  materialFor,
  meshBounds,
  meshClosure,
  orbitView,
  packIslands,
  parseGlb,
  patchMaterial,
  pickIsland,
  pickMeshPoint,
  projectPoint,
  removeMaterialSet,
  renameMaterialSet,
  renderMesh,
  resetSetMaterial,
  serializeMeshAsset,
  setHasMaterial,
  setMaterialImage,
  surfaceUv,
  texelOf,
  paintTexels,
  tintMaskTexture,
  transformIsland,
  unwrapPrimitive,
  uvIslands,
  type EncodedImage,
  type MeshAsset,
  type MeshPrimitive,
  type PaintImage,
} from "@cartbox/editor";
import { TINT_PALETTE, parseMeshScene } from "@cartbox/player";

import { tintMesh } from "../packages/player/src/mesh/MeshOverlaySurface";
import { decodeMeshSidecar, encodeMeshSidecar, setMeshVariant, type MeshSidecar } from "../apps/web/src/lib/meshSidecar";
import { replaceModel } from "../apps/web/src/lib/meshReplace";

/** Decode an 8-bit RGBA PNG (any row filter) with Node's zlib. */
function decodePng(png: Uint8Array): { width: number; height: number; data: Uint8Array } {
  const b = Buffer.from(png);
  let o = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o);
    const type = b.toString("ascii", o + 4, o + 8);
    const d = b.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      width = d.readUInt32BE(0);
      height = d.readUInt32BE(4);
    }
    if (type === "IDAT") idat.push(d);
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const f = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= 4 ? out[y * stride + x - 4]! : 0;
      const up = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4]! : 0;
      let v = raw[y * (stride + 1) + 1 + x]!;
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { width, height, data: out };
}

const base: MeshSidecar = decodeMeshSidecar(lockoutMeshSidecar());
const soldier: MeshAsset = deserializeMeshAsset(base.meshes.find((m) => m.id === "bot-1")!.mesh);
const part = (mesh: MeshAsset, name: string) => mesh.primitives.findIndex((p) => p.material.name === name);
const armor = part(soldier, "armor");

/** The soldier with some parts unwrapped. */
function unwrapped(names: string[]): MeshAsset {
  return { ...soldier, primitives: soldier.primitives.map((p) => (names.includes(p.material.name) ? unwrapPrimitive(p) : p)) };
}

const corner = (p: MeshPrimitive, t: number, c: number) => p.indices[t * 3 + c]!;
const pos = (p: MeshPrimitive, v: number) => [p.positions[v * 3]!, p.positions[v * 3 + 1]!, p.positions[v * 3 + 2]!];
const uvOf = (p: MeshPrimitive, v: number): [number, number] => [p.uvs![v * 2]!, p.uvs![v * 2 + 1]!];

/** Texel centres of an n × n grid covered by more than one triangle (none, for UVs that don't overlap). */
function overlaps(p: MeshPrimitive, n = 256): number {
  const hits = new Uint8Array(n * n);
  let doubled = 0;
  for (let t = 0; t < p.indices.length / 3; t += 1) {
    const [a, b, c] = [0, 1, 2].map((k) => uvOf(p, corner(p, t, k))) as [[number, number], [number, number], [number, number]];
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(d) < 1e-14) continue;
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]) * n)), x1 = Math.min(n - 1, Math.ceil(Math.max(a[0], b[0], c[0]) * n));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]) * n)), y1 = Math.min(n - 1, Math.ceil(Math.max(a[1], b[1], c[1]) * n));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const u = (x + 0.5) / n, v = (y + 0.5) / n;
        const l1 = ((b[1] - c[1]) * (u - c[0]) + (c[0] - b[0]) * (v - c[1])) / d;
        const l2 = ((c[1] - a[1]) * (u - c[0]) + (a[0] - c[0]) * (v - c[1])) / d;
        if (l1 <= 1e-9 || l2 <= 1e-9 || 1 - l1 - l2 <= 1e-9) continue;
        if (hits[y * n + x]) doubled += 1;
        hits[y * n + x] = 1;
      }
    }
  }
  return doubled;
}

describe("unwrapping", () => {
  it("lays the Spartan's armour flat: in the square, one texel density, never mirrored or overlapping, the mesh as it was", () => {
    const p = soldier.primitives[armor]!;
    expect(p.uvs).toBeNull();
    const q = unwrapPrimitive(p);
    expect(q.uvs!.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(q.indices.length).toBe(p.indices.length);
    // Every corner where it was, on the joints it was.
    for (let t = 0; t < p.indices.length / 3; t += 1) {
      for (let c = 0; c < 3; c += 1) {
        expect(pos(q, corner(q, t, c))).toEqual(pos(p, corner(p, t, c)));
        expect(Array.from(q.weights!.subarray(corner(q, t, c) * 4, corner(q, t, c) * 4 + 4))).toEqual(Array.from(p.weights!.subarray(corner(p, t, c) * 4, corner(p, t, c) * 4 + 4)));
      }
    }
    expect(meshClosure(q).closed).toBe(true);
    // One density: UV area over surface area is the same for every triangle; and each winds the right way in UV.
    const ratios: number[] = [];
    for (let t = 0; t < q.indices.length / 3; t += 1) {
      const [a, b, c] = [0, 1, 2].map((k) => pos(q, corner(q, t, k)));
      const e1 = b!.map((v, k) => v - a![k]!), e2 = c!.map((v, k) => v - a![k]!);
      const area = Math.hypot(e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!) / 2;
      if (area < 1e-6) continue;
      const [ua, ub, uc] = [0, 1, 2].map((k) => uvOf(q, corner(q, t, k)));
      const uvArea = ((ub![0] - ua![0]) * (uc![1] - ua![1]) - (ub![1] - ua![1]) * (uc![0] - ua![0])) / 2;
      expect(uvArea).toBeGreaterThan(0);
      // Projected area over true area is the cosine to the chart's axis: at least 1/√3, at most 1.
      ratios.push(uvArea / area);
    }
    const top = Math.max(...ratios);
    expect(Math.min(...ratios) / top).toBeGreaterThan(1 / Math.sqrt(3) - 1e-6);
    expect(overlaps(q)).toBe(0);
  });
});

describe("UV islands", () => {
  const q = unwrapPrimitive(soldier.primitives[armor]!);
  const islands = uvIslands(q);

  it("are the charts, each picked by a point inside it", () => {
    expect(islands.length).toBeGreaterThan(20);
    expect(islands.reduce((n, i) => n + i.triangles.length, 0)).toBe(q.indices.length / 3);
    for (const [k, island] of islands.entries()) {
      const t = island.triangles[0]!;
      const [a, b, c] = [0, 1, 2].map((i) => uvOf(q, corner(q, t, i)));
      expect(pickIsland(q, islands, [(a![0] + b![0] + c![0]) / 3, (a![1] + b![1] + c![1]) / 3])).toBe(k);
    }
    expect(pickIsland(q, islands, [2, 2])).toBe(-1);
  });

  it("move, turn and scale one at a time, leaving the rest where they were; and re-pack without overlapping", () => {
    const [first] = islands;
    const moved = transformIsland(q, first!, { kind: "move", offset: [0.01, -0.02] });
    const inIsland = new Set(first!.triangles);
    for (let t = 0; t < q.indices.length / 3; t += 1) {
      for (let c = 0; c < 3; c += 1) {
        const was = uvOf(q, corner(q, t, c)), now = uvOf(moved, corner(moved, t, c));
        if (inIsland.has(t)) {
          expect(now[0]).toBeCloseTo(was[0] + 0.01, 6);
          expect(now[1]).toBeCloseTo(was[1] - 0.02, 6);
        } else expect(now).toEqual(was);
      }
    }
    const turned = transformIsland(transformIsland(q, first!, { kind: "rotate", angle: Math.PI / 2 }), first!, { kind: "rotate", angle: -Math.PI / 2 });
    for (let t = 0; t < q.indices.length / 3; t += 1) for (let c = 0; c < 3; c += 1) uvOf(turned, corner(turned, t, c)).forEach((v, k) => expect(v).toBeCloseTo(uvOf(q, corner(q, t, c))[k]!, 5));
    const bigger = transformIsland(q, first!, { kind: "scale", factor: 3 });
    const repacked = packIslands(bigger);
    expect(repacked.uvs!.every((v) => v >= -1e-6 && v <= 1 + 1e-6)).toBe(true);
    expect(overlaps(repacked)).toBe(0);
    expect(uvIslands(repacked)).toHaveLength(islands.length);
  });
});

describe("painting", () => {
  const mesh = unwrapped(["armor"]);
  const camera = { yaw: 0, pitch: 0.1 };
  // The middle of the chest plate's front, as the preview sees it.
  const plate = projectPoint(orbitView(meshBounds(mesh)!, camera).viewProj, [0, 1.33, 0.2])!;
  const ndc: [number, number] = [plate[0], plate[1]];

  it("writes the texels under the brush through the UVs, and the preview shows the paint there", () => {
    const hit = pickMeshPoint(mesh, camera, ndc[0], ndc[1])!;
    expect(hit.primitive).toBe(armor);
    const p = mesh.primitives[armor]!;
    const uv = surfaceUv(p, hit.triangle, hit.barycentric)!;
    const { image, patch } = blankLayer(p.material, "baseColor", 128);
    expect(patch).toEqual({}); // tintable: a white map under the team colour
    expect(Array.from(image.data.subarray(0, 4))).toEqual([255, 255, 255, 255]);
    const touched = paintTexels(image, "baseColor", uv, [1, 0, 0], { radius: 3, opacity: 1, hardness: 1 })!;
    const [x, y] = texelOf(image, uv);
    expect(layerValue(image, "baseColor", x, y)).toEqual([1, 0, 0]);
    expect(x).toBeGreaterThanOrEqual(touched.x0);
    expect(x).toBeLessThanOrEqual(touched.x1);
    let red = 0;
    for (let ty = 0; ty < 128; ty += 1) {
      for (let tx = 0; tx < 128; tx += 1) {
        const isRed = image.data[(ty * 128 + tx) * 4 + 1] === 0;
        if (isRed) red += 1;
        if (Math.hypot(tx - x, ty - y) > 4.5) expect(isRed).toBe(false);
      }
    }
    expect(red).toBeGreaterThan(20);
    expect(red).toBeLessThan(40);
    // The preview samples the map through the same UVs: red at the painted point, not beside it.
    const size = 96;
    const render = (texture: PaintImage | null) => {
      const out = new Uint8ClampedArray(size * size * 4);
      renderMesh(mesh, { camera, size, out, depth: new Float32Array(size * size), textures: mesh.primitives.map((_, i) => (i === armor ? texture : null)) });
      const px = Math.floor(((ndc[0] + 1) / 2) * size), py = Math.floor(((1 - ndc[1]) / 2) * size);
      return Array.from(out.subarray((py * size + px) * 4, (py * size + px) * 4 + 3));
    };
    const [r, g] = render(image);
    expect(r).toBeGreaterThan(2 * Math.max(1, g!));
    const [r0, g0] = render(blankLayer(p.material, "baseColor", 128).image);
    expect(r0! / Math.max(1, g0!)).toBeLessThan(1.5);
  });

  it("paints each layer into its own channels: roughness green, metal blue, emissive RGB, the team mask grey", () => {
    const p = mesh.primitives[armor]!;
    const uv: [number, number] = [0.5, 0.5];
    const mr = blankLayer(p.material, "roughness", 32);
    expect(mr.patch).toEqual({ metallicFactor: 1, roughnessFactor: 1 });
    const [x, y] = texelOf(mr.image, uv);
    const before = Array.from(mr.image.data.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4));
    expect(before).toEqual([255, Math.round(0.4 * 255), Math.round(0.45 * 255), 255]);
    paintTexels(mr.image, "roughness", uv, [0.9], { radius: 2, opacity: 1, hardness: 1 });
    expect(layerValue(mr.image, "roughness", x, y)[0]).toBeCloseTo(0.9, 2);
    expect(layerValue(mr.image, "metal", x, y)[0]).toBeCloseTo(0.45, 2);
    paintTexels(mr.image, "metal", uv, [0.1], { radius: 2, opacity: 1, hardness: 1 });
    expect(layerValue(mr.image, "metal", x, y)[0]).toBeCloseTo(0.1, 2);
    expect(layerValue(mr.image, "roughness", x, y)[0]).toBeCloseTo(0.9, 2);
    // Emissive: the visor's faint gold glow carried into the map.
    const visor = soldier.primitives[part(soldier, "visor")]!.material;
    const glow = blankLayer(visor, "emissive", 16);
    expect(glow.patch).toEqual({ emissiveFactor: [1, 1, 1] });
    expect(layerValue(glow.image, "emissive", 0, 0)).toEqual([0.3, 0.18, 0.04].map((v) => Math.round(v * 255) / 255));
    paintTexels(glow.image, "emissive", uv, [0, 0.8, 1], { radius: 2, opacity: 0.5, hardness: 1 });
    const [ex, ey] = texelOf(glow.image, uv);
    // Half way from (77, 46, 10) to (0, 204, 255).
    expect(layerValue(glow.image, "emissive", ex, ey).map((v) => Math.round(v * 255))).toEqual([39, 125, 133]);
    // The mask starts as the part's tint mix (the trim takes a fifth), and is grey.
    const trim = soldier.primitives[part(soldier, "armor-trim")]!.material;
    const mask = blankLayer(trim, "teamMask", 16);
    expect(mask.patch).toEqual({ tintable: true, tintMix: undefined });
    expect(layerValue(mask.image, "teamMask", 3, 3)).toEqual([51, 51, 51].map((v) => v / 255));
    paintTexels(mask.image, "teamMask", uv, [1], { radius: 2, opacity: 1, hardness: 1 });
    expect(layerValue(mask.image, "teamMask", ex, ey)).toEqual([1, 1, 1]);
    // A part that isn't tinted keeps its colour in the map, and its factor goes white.
    const suit = soldier.primitives[part(soldier, "undersuit")]!.material;
    const own = blankLayer(suit, "baseColor", 8);
    expect(own.patch).toEqual({ baseColorFactor: [1, 1, 1, 1] });
    expect(Array.from(own.image.data.subarray(0, 3))).toEqual([0.13, 0.14, 0.16].map((v) => Math.round(v * 255)));
    // Saved as a PNG, read back texel for texel.
    expect(Array.from(decodePng(encodePaintImage(mr.image).bytes).data)).toEqual(Array.from(mr.image.data));
  });

  it("puts the team colour where the mask is painted, and the part's own colour elsewhere", () => {
    const mask: PaintImage = { width: 2, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]) };
    const flat = tintMaskTexture(null, mask, [0.5, 0.5, 0.5], [1, 0, 0]);
    expect(Array.from(flat.data)).toEqual([255, 0, 0, 255, 128, 128, 128, 255]);
    const albedo: PaintImage = { width: 2, height: 1, data: new Uint8ClampedArray([200, 200, 200, 255, 100, 100, 100, 128]) };
    expect(Array.from(tintMaskTexture(albedo, mask, [0.5, 0.5, 0.5], [1, 0, 0], 0.5).data)).toEqual([150, 50, 50, 255, 50, 50, 50, 128]);
    // In the player: a masked part draws white-factored (its colour is in the masked map); the rest tint as before.
    const tinted = tintMesh(soldier, 2, undefined, new Set([armor]));
    expect(tinted.primitives[armor]!.material.baseColorFactor).toEqual([1, 1, 1, 1]);
    const trim = part(soldier, "armor-trim");
    expect(tinted.primitives[trim]!.material.baseColorFactor).toEqual(tintMesh(soldier, 2).primitives[trim]!.material.baseColorFactor);
    expect(TINT_PALETTE[2]).toBeDefined();
  });
});

describe("material slots and sets", () => {
  const png: EncodedImage = encodePaintImage({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(200) });

  it("takes an uploaded image into any slot, of a part's own material or a set's", () => {
    for (const { slot } of MATERIAL_IMAGE_SLOTS) {
      const own = setMaterialImage(soldier, armor, slot, png);
      expect(materialFor(own, armor)![slot]).toBe(png);
      const back = deserializeMeshAsset(serializeMeshAsset(own));
      expect(Array.from((materialFor(back, armor)![slot] as EncodedImage).bytes), slot).toEqual(Array.from(png.bytes));
      // Into a set: the part's own material is left alone.
      const inSet = setMaterialImage(soldier, armor, slot, png, "Veteran");
      expect(materialFor(inSet, armor, "Veteran")![slot]).toBe(png);
      expect(materialFor(inSet, armor)).toBe(soldier.primitives[armor]!.material);
    }
    const cleared = setMaterialImage(setMaterialImage(soldier, armor, "emissiveImage", png), armor, "emissiveImage", null);
    expect(materialFor(cleared, armor)!.emissiveImage).toBeNull();
  });

  it("makes, edits, renames and removes material sets", () => {
    const made = addMaterialSet(soldier, "Desert");
    expect(made.name).toBe("Desert");
    expect(made.mesh.variants!.map((v) => v.name)).toEqual(["Veteran", "Recon", "Desert"]);
    // A new set wears every part's own until edited; an edit starts from a copy of the part's own.
    expect(materialFor(made.mesh, armor, "Desert")).toBe(soldier.primitives[armor]!.material);
    const edited = patchMaterial(made.mesh, armor, { baseColorFactor: [0.76, 0.6, 0.42, 1] }, "Desert");
    expect(setHasMaterial(edited, "Desert", armor)).toBe(true);
    expect(materialFor(edited, armor, "Desert")).toMatchObject({ ...soldier.primitives[armor]!.material, baseColorFactor: [0.76, 0.6, 0.42, 1] });
    expect(materialFor(edited, armor)!.baseColorFactor).toEqual(soldier.primitives[armor]!.material.baseColorFactor);
    expect(setHasMaterial(resetSetMaterial(edited, "Desert", armor), "Desert", armor)).toBe(false);
    // A copy of another set, a clashing name numbered, a rename, a removal.
    const copy = addMaterialSet(edited, "Desert", "Veteran");
    expect(copy.name).toBe("Desert 2");
    expect(copy.mesh.variants![3]!.materials).toEqual(soldier.variants![0]!.materials);
    const renamed = renameMaterialSet(copy.mesh, "Desert 2", "Dune");
    expect(renamed.name).toBe("Dune");
    expect(removeMaterialSet(renamed.mesh, "Dune").variants!.map((v) => v.name)).toEqual(["Veteran", "Recon", "Desert"]);
    expect(removeMaterialSet(removeMaterialSet(soldier, "Veteran"), "Recon").variants).toBeUndefined();
  });
});

describe("Lockout: a Spartan's armour repainted as a new armour set", () => {
  /** The soldier unwrapped and given a "Desert" set: tan plates with a team-colour stripe over the helmet, worn edges, a glowing visor seam. */
  function desert(): MeshAsset {
    let mesh = unwrapped(["armor", "armor-trim", "visor"]);
    mesh = addMaterialSet(mesh, "Desert").mesh;
    const paint = (prim: number, layer: "baseColor" | "roughness" | "metal" | "emissive" | "teamMask", value: number[], where: (p: number[]) => boolean, size = 128) => {
      const p = mesh.primitives[prim]!;
      const material = materialFor(mesh, prim, "Desert")!;
      const { image, patch } = blankLayer(material, layer, size);
      // Dab at every corner the test picks out, through its UVs.
      for (let v = 0; v < p.positions.length / 3; v += 1) if (where(pos(p, v))) paintTexels(image, layer, uvOf(p, v), value, { radius: 4, opacity: 1, hardness: 0.6 });
      const slot = layer === "baseColor" ? "baseColorImage" : layer === "emissive" ? "emissiveImage" : layer === "teamMask" ? "tintMaskImage" : "metallicRoughnessImage";
      mesh = patchMaterial(mesh, prim, { ...patch, [slot]: encodePaintImage(image) }, "Desert");
    };
    const a = part(mesh, "armor"), visor = part(mesh, "visor");
    paint(a, "baseColor", [0.76, 0.6, 0.42], () => true);
    paint(a, "teamMask", [1], (p) => p[1]! > 1.6 && Math.abs(p[0]!) < 0.04);
    paint(a, "roughness", [0.85], (p) => p[1]! < 1);
    paint(visor, "emissive", [1, 0.5, 0.1], (p) => p[1]! < 1.66);
    return mesh;
  }

  it("is painted where it was meant to be, through the UVs", () => {
    const mesh = desert();
    const a = part(mesh, "armor");
    const m = materialFor(mesh, a, "Desert")!;
    const mask = decodePng(m.tintMaskImage!.bytes);
    const p = mesh.primitives[a]!;
    // The helmet's centre line takes the full team colour; a shoulder only the part's own (the tint mix it had, 1).
    let stripe = 0, shoulder = 0;
    for (let v = 0; v < p.positions.length / 3; v += 1) {
      const [x, y] = texelOf(mask, uvOf(p, v));
      const value = mask.data[(y * mask.width + x) * 4]!;
      const at = pos(p, v);
      if (at[1]! > 1.6 && Math.abs(at[0]!) < 0.04) {
        expect(value).toBe(255);
        stripe += 1;
      }
      if (Math.abs(at[0]!) > 0.3 && at[1]! > 1.4) shoulder += 1;
    }
    expect(stripe).toBeGreaterThan(4);
    expect(shoulder).toBeGreaterThan(4);
    expect(m.tintable).toBe(true);
    expect(materialFor(mesh, a)!.tintMaskImage).toBeUndefined(); // the plates' own material is untouched
  });

  it("round-trips through GLB export: the set's maps, factors and the UVs come back the same", () => {
    const mesh = desert();
    const back = parseGlb(encodeGlb(mesh));
    expect(back.variants!.map((v) => v.name)).toEqual(["Veteran", "Recon", "Desert"]);
    for (const name of ["armor", "visor"]) {
      const i = part(mesh, name);
      const was = materialFor(mesh, i, "Desert")!, now = materialFor(back, i, "Desert")!;
      for (const slot of ["baseColorImage", "metallicRoughnessImage", "emissiveImage", "tintMaskImage"] as const) {
        expect(Boolean(now[slot]), `${name} ${slot}`).toBe(Boolean(was[slot]));
        if (was[slot]) expect(Array.from(now[slot]!.bytes), `${name} ${slot}`).toEqual(Array.from(was[slot]!.bytes));
      }
      expect(now.baseColorFactor).toEqual(was.baseColorFactor);
      expect(now.metallicFactor).toBe(was.metallicFactor);
      expect(now.roughnessFactor).toBe(was.roughnessFactor);
      expect(now.emissiveFactor).toEqual(was.emissiveFactor);
      expect(Array.from(back.primitives[i]!.uvs!)).toEqual(Array.from(mesh.primitives[i]!.uvs!));
    }
    // The other sets as they were.
    expect(materialFor(back, part(back, "armor"), "Veteran")!.name).toBe(materialFor(soldier, armor, "Veteran")!.name);
    // Saved in the cart, likewise.
    const saved = deserializeMeshAsset(serializeMeshAsset(mesh));
    expect(Array.from(materialFor(saved, armor, "Desert")!.tintMaskImage!.bytes)).toEqual(Array.from(materialFor(mesh, armor, "Desert")!.tintMaskImage!.bytes));
  });

  it("is what a bot wears in the cart", () => {
    const mesh = desert();
    const { sidecar } = replaceModel(base, "bot-1", mesh);
    const wearing = setMeshVariant(sidecar, "bot-1", "Desert");
    const scene = parseMeshScene(encodeMeshSidecar(wearing))!;
    const object = wearing.meshes.findIndex((m) => m.id === "bot-1");
    const worn = scene.instances[object]!.mesh;
    const painted = applyMeshVariant(mesh, "Desert").primitives[armor]!.material.baseColorImage!;
    expect(Array.from(worn.primitives[armor]!.material.baseColorImage!.bytes)).toEqual(Array.from(painted.bytes));
  });
});
