/**
 * Blockout mesh editing (HALO_INFINITE_STYLE_ROADMAP.md I14): faces found as
 * planar regions, and extrude, inset and bevel on them, keeping the mesh
 * closed and consistently wound, flat-shaded, and textured at its own density.
 */

import { describe, expect, it } from "vitest";
import { editFace, editMeshFace, faceAt, faceBoundary, primitiveFaces, type MeshAsset, type MeshPrimitive } from "@cartbox/editor";

/** A 2 × 2 × 2 cube centred on the origin, its faces' corners split (as a modelling tool exports it), with UVs at one unit a metre. */
function cube(): MeshPrimitive {
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  const faces: [number[], number[], number[]][] = [
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [n, u, v] of faces) {
    const base = positions.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      positions.push(n[0]! + u[0]! * su! + v[0]! * sv!, n[1]! + u[1]! * su! + v[1]! * sv!, n[2]! + u[2]! * su! + v[2]! * sv!);
      normals.push(...n);
      uvs.push((su! + 1) / 2 * 2, (sv! + 1) / 2 * 2);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
    material: { name: "block", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, lightmapImage: { mime: "image/png", bytes: new Uint8Array(4) } },
  };
}

const at = (p: MeshPrimitive, i: number) => [p.positions[i * 3]!, p.positions[i * 3 + 1]!, p.positions[i * 3 + 2]!];
const key = (v: number[]) => v.map((x) => Math.round(x * 1e4)).join(",");

/** Closed and consistently wound: every directed edge (by position) is matched by its reverse exactly once. */
function watertight(p: MeshPrimitive): boolean {
  const edges = new Map<string, number>();
  for (let t = 0; t < p.indices.length; t += 3) {
    for (let e = 0; e < 3; e += 1) {
      const a = key(at(p, p.indices[t + e]!)), b = key(at(p, p.indices[t + ((e + 1) % 3)]!));
      edges.set(`${a}>${b}`, (edges.get(`${a}>${b}`) ?? 0) + 1);
    }
  }
  for (const [edge, n] of edges) {
    const [a, b] = edge.split(">");
    if (n !== 1 || edges.get(`${b}>${a}`) !== 1) return false;
  }
  return true;
}

/** Enclosed volume (divergence theorem), positive for outward winding. */
function volume(p: MeshPrimitive): number {
  let v = 0;
  for (let t = 0; t < p.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => at(p, p.indices[t + k]!)) as [number[], number[], number[]];
    v += (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) / 6;
  }
  return v;
}

const maxY = (p: MeshPrimitive) => Math.max(...Array.from({ length: p.positions.length / 3 }, (_, i) => p.positions[i * 3 + 1]!));
const top = (p: MeshPrimitive) => faceAt(p, 0);

describe("faces", () => {
  it("are the planar, edge-connected regions a modelling tool would show", () => {
    const box = cube();
    expect(primitiveFaces(box)).toHaveLength(6);
    const face = top(box);
    expect(face.triangles).toEqual([0, 1]);
    face.normal.forEach((v, k) => expect(v).toBeCloseTo([0, 1, 0][k]!, 9));
    expect(face.area).toBeCloseTo(4, 6);
    face.centroid.forEach((v, k) => expect(v).toBeCloseTo([0, 1, 0][k]!, 6));
    // Its boundary: one loop of four corners, counter-clockwise seen from above.
    const [loop] = faceBoundary(box, face.triangles);
    expect(loop).toHaveLength(4);
    let area = 0;
    loop!.forEach((p, i) => {
      const q = loop![(i + 1) % loop!.length]!;
      area += p[2] * q[0] - p[0] * q[2];
    });
    expect(area / 2).toBeCloseTo(4, 6);
  });
});

describe("editing a face", () => {
  it("extrudes it along its normal, walls and all, still closed", () => {
    const box = cube();
    const out = editFace(box, top(box).triangles, { kind: "extrude", distance: 1 });
    expect(maxY(out)).toBeCloseTo(2, 6);
    expect(out.indices.length / 3).toBe(12 + 8);
    expect(watertight(out)).toBe(true);
    expect(volume(out)).toBeCloseTo(12, 5);
    // And cuts a recess the other way.
    const dent = editFace(box, top(box).triangles, { kind: "extrude", distance: -0.5 });
    expect(watertight(dent)).toBe(true);
    expect(volume(dent)).toBeCloseTo(6, 5);
  });

  it("insets it within its plane, leaving a ring around a smaller face", () => {
    const box = cube();
    const out = editFace(box, top(box).triangles, { kind: "inset", amount: 0.25 });
    expect(maxY(out)).toBeCloseTo(1, 6);
    expect(out.indices.length / 3).toBe(12 + 8);
    expect(watertight(out)).toBe(true);
    expect(volume(out)).toBeCloseTo(8, 5);
    // The inner face is its own face, 1.5 across, ready to extrude; the ring is four faces round it, all facing up.
    expect(faceAt(out, 0).area).toBeCloseTo(2.25, 5);
    expect(primitiveFaces(out)).toHaveLength(6 + 4);
    const ring = faceAt(out, out.indices.length / 3 - 1);
    expect(ring.triangles).toHaveLength(2);
    expect(ring.normal[1]).toBeCloseTo(1, 6);
    // Inset, then extrude the inner face: a raised boss on the block.
    const boss = editFace(out, faceAt(out, 0).triangles, { kind: "extrude", distance: 0.5 });
    expect(watertight(boss)).toBe(true);
    expect(volume(boss)).toBeCloseTo(8 + 2.25 * 0.5, 5);
  });

  it("bevels it: a sloped chamfer up to a raised face, or a sunken channel", () => {
    const box = cube();
    const raised = editFace(box, top(box).triangles, { kind: "bevel", width: 0.25, depth: 0.25 });
    expect(maxY(raised)).toBeCloseTo(1.25, 6);
    expect(watertight(raised)).toBe(true);
    // The cube plus a frustum from 2 × 2 up to 1.5 × 1.5 over a quarter.
    expect(volume(raised)).toBeCloseTo(8 + (0.25 / 3) * (4 + 2.25 + 3), 5);
    // The chamfer's faces slope outward and up.
    const ring = primitiveFaces(raised).filter((f) => f.normal[1] > 0.1 && f.normal[1] < 0.99);
    expect(ring).toHaveLength(4);
    for (const f of ring) expect(f.normal[1]).toBeCloseTo(Math.SQRT1_2, 5);
    const channel = editFace(box, top(box).triangles, { kind: "bevel", width: 0.5, depth: -0.2 });
    expect(watertight(channel)).toBe(true);
    expect(volume(channel)).toBeLessThan(8);
  });

  it("keeps untouched triangles' normals, flat-shades what it makes, maps walls at the face's density, and drops the light map", () => {
    const box = cube();
    const out = editFace(box, top(box).triangles, { kind: "extrude", distance: 1 });
    expect(out.normals).not.toBeNull();
    expect(out.material.lightmapImage).toBeUndefined();
    // Every corner's normal is one of the six axes (the cube's own, and the walls').
    for (let i = 0; i < out.positions.length / 3; i += 1) {
      const n = [out.normals![i * 3]!, out.normals![i * 3 + 1]!, out.normals![i * 3 + 2]!];
      expect(n.map(Math.abs).sort()).toEqual([0, 0, 1]);
    }
    // A wall one unit tall spans one unit of texture, as the face does.
    let span = 0;
    for (let i = 0; i < out.positions.length / 3; i += 1) if (out.positions[i * 3 + 1]! > 1.5) span = Math.max(span, out.uvs![i * 2 + 1]!);
    expect(span).toBeCloseTo(2, 5); // y = 2 at one UV unit a metre
  });

  it("carries a skinned face's weights to what it grows (L15), and edits one face of one primitive of a mesh", () => {
    const box = cube();
    // Every vertex wholly on joint 2: the inset ring and inner face ride it too.
    const joints = new Uint16Array(96).map((_, k) => (k % 4 === 0 ? 2 : 0));
    const weights = new Float32Array(96).map((_, k) => (k % 4 === 0 ? 1 : 0));
    const skinned = editFace({ ...box, joints, weights }, [0, 1], { kind: "inset", amount: 0.1 });
    expect(watertight(skinned)).toBe(true);
    expect(skinned.joints!.length).toBe((skinned.positions.length / 3) * 4);
    for (let v = 0; v < skinned.positions.length / 3; v += 1) {
      expect(skinned.joints![v * 4]).toBe(2);
      expect(skinned.weights![v * 4]).toBe(1);
    }
    const mesh: MeshAsset = { name: "blocks", primitives: [box, cube()] };
    const out = editMeshFace(mesh, 1, 0, { kind: "extrude", distance: 2 });
    expect(out.primitives[0]).toBe(box);
    expect(maxY(out.primitives[1]!)).toBeCloseTo(3, 6);
    expect(editMeshFace(mesh, 5, 0, { kind: "extrude", distance: 1 })).toBe(mesh);
  });
});

describe("picking a face in the Mesh tab's preview", () => {
  it("finds the triangle under a point of the image, nearest the camera, matching what renderMesh draws", async () => {
    const { pickMeshTriangle, renderMesh } = await import("@cartbox/editor");
    const mesh: MeshAsset = { name: "block", primitives: [cube()] };
    const camera = { yaw: 0.6, pitch: 0.5 };
    // Looking down at the block from above and in front: the image's centre shows the cube; the very corner, nothing.
    const size = 64;
    const out = new Uint8ClampedArray(size * size * 4);
    renderMesh(mesh, { size, out, depth: new Float32Array(size * size), camera });
    for (const [px, py] of [[32, 32], [32, 12], [20, 44], [2, 2]] as const) {
      const ndc = [((px + 0.5) / size) * 2 - 1, 1 - ((py + 0.5) / size) * 2] as const;
      const hit = pickMeshTriangle(mesh, camera, ndc[0], ndc[1]);
      const drawn = out[(py * size + px) * 4 + 3]! > 0;
      expect(hit !== null, `${px},${py}`).toBe(drawn);
    }
    // From straight above, the centre is the top face.
    const above = pickMeshTriangle(mesh, { yaw: 0, pitch: 1.5 }, 0, 0)!;
    expect(faceAt(mesh.primitives[0]!, above.triangle).normal[1]).toBeCloseTo(1, 6);
    // From the front (+Z), the front face.
    const front = pickMeshTriangle(mesh, { yaw: 0, pitch: 0 }, 0.05, 0.05)!;
    expect(faceAt(mesh.primitives[0]!, front.triangle).normal[2]).toBeCloseTo(1, 6);
  });
});

describe("an edit in the editor", () => {
  it("replaces the entry's mesh and remakes its LODs, leaving other copies of the old model as they were", async () => {
    const { addMesh, emptyMeshSidecar, readMeshEntry } = await import("@/lib/meshSidecar");
    const { generateEntryLods, withEditedGeometry } = await import("@/lib/meshLods");
    // A heavy block: the cube with a 40 × 40 grid on top, enough triangles to want LODs.
    const grid: MeshPrimitive = (() => {
      const n = 40, positions: number[] = [], indices: number[] = [];
      for (let z = 0; z <= n; z += 1) for (let x = 0; x <= n; x += 1) positions.push(-1 + (2 * x) / n, 1 + 0.02 * Math.sin(x * 1.3) * Math.cos(z * 0.7), -1 + (2 * z) / n);
      for (let z = 0; z < n; z += 1) for (let x = 0; x < n; x += 1) {
        const a = z * (n + 1) + x;
        indices.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
      }
      return { positions: Float32Array.from(positions), normals: null, uvs: null, indices: Uint32Array.from(indices), material: cube().material };
    })();
    const heavy: MeshAsset = { name: "heavy", primitives: [cube(), grid] };
    const first = addMesh(emptyMeshSidecar(), heavy, "a");
    const id = first.id;
    const copy = addMesh(first.sidecar, heavy, "b");
    const sidecar = generateEntryLods(copy.sidecar, id).sidecar;
    const before = sidecar.meshes.find((m) => m.id === copy.id)!.lods;
    expect(before).toBeDefined();
    const edited = editMeshFace(heavy, 0, 0, { kind: "extrude", distance: 1 });
    const next = withEditedGeometry(sidecar, id, edited);
    const entry = next.meshes.find((m) => m.id === id)!;
    expect(maxY(readMeshEntry(entry).primitives[0]!)).toBeCloseTo(2, 5);
    expect(entry.lods).toBeDefined();
    expect(entry.lods).not.toEqual(before);
    expect(next.meshes.find((m) => m.id === copy.id)!.lods).toEqual(before);
  });
});
