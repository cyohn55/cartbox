/**
 * FBX skinning, animation and textures (AAA_PRODUCTION_ROADMAP.md D1): a
 * binary FBX 7400 built here, a strip of two quads skinned to a root and a tip
 * bone, an animation stack turning the tip 90° about Z over a second, an
 * embedded base-colour PNG and a normal map named by a path, supplied by file.
 * The skin is checked by skinning the strip with the engine's own functions.
 */
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { FBX_TICKS_PER_SECOND, encodeRgbaPng, fbxReferencedFiles, parseFbx, parseFbxBinary, restPose, sampleClip, skinMatrices, skinVertices, type MeshAsset } from "@cartbox/editor";

type Prop = number | bigint | string | Float64Array | Int32Array | BigInt64Array | Uint8Array;
interface Node { name: string; props: Prop[]; children: Node[] }
const node = (name: string, props: Prop[], children: Node[] = []): Node => ({ name, props, children });
const P = (...v: Prop[]) => node("P", v);

/** A binary FBX 7400: numbers as D, ids as L, strings as S, raw bytes as R, Float64Array d (zlib), Int32Array i, BigInt64Array l. */
function buildFbx(nodes: Node[]): Uint8Array {
  const out: number[] = [];
  const u8 = (...b: number[]) => out.push(...b);
  const u32 = (v: number) => u8(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const str = (s: string) => u8(...new TextEncoder().encode(s));
  const bytes = (b: Uint8Array) => u8(...b);
  str("Kaydara FBX Binary  \0");
  u8(0x1a, 0);
  u32(7400);
  const prop = (p: Prop): number[] => {
    const saved = out.length;
    if (typeof p === "bigint") {
      str("L");
      const b = new Uint8Array(8);
      new DataView(b.buffer).setBigInt64(0, p, true);
      bytes(b);
    } else if (typeof p === "number") {
      str("D");
      const b = new Uint8Array(8);
      new DataView(b.buffer).setFloat64(0, p, true);
      bytes(b);
    } else if (typeof p === "string") {
      str("S");
      u32(new TextEncoder().encode(p).length);
      str(p);
    } else if (p instanceof Uint8Array) {
      str("R");
      u32(p.length);
      bytes(p);
    } else if (p instanceof Float64Array) {
      const z = deflateSync(new Uint8Array(p.buffer));
      str("d");
      u32(p.length);
      u32(1);
      u32(z.length);
      bytes(z);
    } else if (p instanceof BigInt64Array) {
      str("l");
      u32(p.length);
      u32(0);
      u32(p.length * 8);
      bytes(new Uint8Array(p.buffer));
    } else {
      str("i");
      u32(p.length);
      u32(0);
      u32(p.length * 4);
      bytes(new Uint8Array(p.buffer));
    }
    return out.splice(saved);
  };
  const write = (n: Node) => {
    const props = n.props.flatMap(prop);
    const start = out.length;
    u32(0);
    u32(n.props.length);
    u32(props.length);
    u8(n.name.length);
    str(n.name);
    u8(...props);
    for (const c of n.children) write(c);
    if (n.children.length > 0) for (let i = 0; i < 13; i += 1) u8(0);
    const end = out.length;
    out.splice(start, 4, end & 0xff, (end >>> 8) & 0xff, (end >>> 16) & 0xff, (end >>> 24) & 0xff);
  };
  for (const n of nodes) write(n);
  for (let i = 0; i < 13; i += 1) u8(0);
  return Uint8Array.from(out);
}

const RED = encodeRgbaPng(Uint8Array.from([255, 0, 0, 255]), 1, 1);
const NORMAL = encodeRgbaPng(Uint8Array.from([128, 128, 255, 255]), 1, 1);
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translate = (x: number, y: number, z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

/** The strip, its bones, skin, animation and material; `unit` is the file's UnitScaleFactor (100 = metres). */
function strip(unit = 100, u = 1): Node[] {
  const lcl = (t: number[]) => node("Properties70", [], [P("Lcl Translation", "Lcl Translation", "", "A", ...t)]);
  return [
    node("GlobalSettings", [], [node("Properties70", [], [P("UnitScaleFactor", "double", "Number", "", unit)])]),
    node("Objects", [], [
      node("Geometry", [1000n, "Strip\u0000\u0001Geometry", "Mesh"], [
        node("Vertices", [Float64Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 2, 0, 0, 2, 0].map((v) => v * u))]),
        node("PolygonVertexIndex", [Int32Array.from([0, 1, 2, -4, 3, 2, 4, -6])]),
      ]),
      node("Model", [2000n, "Strip\u0000\u0001Model", "Mesh"], []),
      node("Model", [10n, "Root\u0000\u0001Model", "LimbNode"], [lcl([0, 0, 0])]),
      node("Model", [11n, "Tip\u0000\u0001Model", "LimbNode"], [lcl([0, u, 0])]),
      node("Deformer", [20n, "Skin\u0000\u0001Deformer", "Skin"], []),
      node("Deformer", [21n, "R\u0000\u0001SubDeformer", "Cluster"], [
        node("Indexes", [Int32Array.from([0, 1, 2, 3])]),
        node("Weights", [Float64Array.from([1, 1, 0.5, 0.5])]),
        node("TransformLink", [Float64Array.from(identity)]),
      ]),
      node("Deformer", [22n, "T\u0000\u0001SubDeformer", "Cluster"], [
        node("Indexes", [Int32Array.from([2, 3, 4, 5])]),
        node("Weights", [Float64Array.from([0.5, 0.5, 1, 1])]),
        node("TransformLink", [Float64Array.from(translate(0, u, 0))]),
      ]),
      node("AnimationStack", [30n, "Take 001\u0000\u0001AnimStack", ""], []),
      node("AnimationLayer", [31n, "Base\u0000\u0001AnimLayer", ""], []),
      node("AnimationCurveNode", [32n, "R\u0000\u0001AnimCurveNode", ""], [node("Properties70", [], [P("d|X", "Number", "", "A", 0), P("d|Y", "Number", "", "A", 0), P("d|Z", "Number", "", "A", 0)])]),
      node("AnimationCurve", [33n, "\u0000\u0001AnimCurve", ""], [node("KeyTime", [BigInt64Array.from([0n, BigInt(FBX_TICKS_PER_SECOND)])]), node("KeyValueFloat", [Float64Array.from([0, 90])])]),
      node("Material", [40n, "Painted\u0000\u0001Material", ""], [node("Properties70", [], [P("DiffuseColor", "Color", "", "A", 0.2, 0.2, 0.2)])]),
      node("Texture", [41n, "Albedo\u0000\u0001Texture", ""], [node("RelativeFilename", ["albedo.png"])]),
      node("Video", [42n, "Albedo\u0000\u0001Video", "Clip"], [node("Content", [RED])]),
      node("Texture", [43n, "Normal\u0000\u0001Texture", ""], [node("RelativeFilename", ["C:\\art\\normal.png"])]),
    ]),
    node("Connections", [], [
      node("C", ["OO", 1000n, 2000n]),
      node("C", ["OO", 2000n, 0n]),
      node("C", ["OO", 10n, 0n]),
      node("C", ["OO", 11n, 10n]),
      node("C", ["OO", 20n, 1000n]),
      node("C", ["OO", 21n, 20n]),
      node("C", ["OO", 22n, 20n]),
      node("C", ["OO", 10n, 21n]),
      node("C", ["OO", 11n, 22n]),
      node("C", ["OO", 31n, 30n]),
      node("C", ["OO", 32n, 31n]),
      node("C", ["OP", 32n, 11n, "Lcl Rotation"]),
      node("C", ["OP", 33n, 32n, "d|Z"]),
      node("C", ["OO", 40n, 2000n]),
      node("C", ["OP", 41n, 40n, "DiffuseColor"]),
      node("C", ["OO", 42n, 41n]),
      node("C", ["OP", 43n, 40n, "NormalMap"]),
    ]),
  ];
}

/** The strip's vertices skinned at a pose (none: the rest pose), rounded. */
function skinned(mesh: MeshAsset, time: number | null): number[][] {
  const p = mesh.primitives[0]!;
  const pose = time === null ? restPose(mesh.skin!) : sampleClip(mesh.skin!, mesh.clips![0]!, time, false);
  const out = new Float32Array(p.positions.length);
  skinVertices(p.joints!, p.weights!, skinMatrices(mesh.skin!, pose), p.positions, null, out, null);
  return Array.from({ length: out.length / 3 }, (_, i) => [0, 1, 2].map((k) => Math.round(out[i * 3 + k]! * 1000) / 1000 + 0));
}
const bind = (mesh: MeshAsset) => Array.from({ length: mesh.primitives[0]!.positions.length / 3 }, (_, i) => [0, 1, 2].map((k) => Math.round(mesh.primitives[0]!.positions[i * 3 + k]! * 1000) / 1000 + 0));

describe("FBX skin, animation and textures (D1)", () => {
  it("reads the bones as joints, parents first, with each vertex's weights", async () => {
    const mesh = await parseFbx(buildFbx(strip()), "strip", { files: new Map([["normal.png", NORMAL]]) });
    expect(mesh.skin!.joints.map((j) => [j.name, j.parent])).toEqual([["Root", -1], ["Tip", 0]]);
    expect(mesh.skin!.joints[1]!.translation).toEqual([0, 1, 0]);
    const p = mesh.primitives[0]!;
    // Polygon vertices follow the corners: quad 1 is cps 0,1,2,3; quad 2 is 3,2,4,5.
    const at = (v: number) => ({ joints: Array.from(p.joints!.subarray(v * 4, v * 4 + 2)), weights: Array.from(p.weights!.subarray(v * 4, v * 4 + 2)) });
    expect(at(0)).toEqual({ joints: [0, 0], weights: [1, 0] });
    expect(at(2).weights).toEqual([0.5, 0.5]);
    expect(at(6)).toEqual({ joints: [1, 0], weights: [1, 0] });
  });

  it("skins to the bind shape at rest, and bends the tip by the clip", async () => {
    const mesh = await parseFbx(buildFbx(strip()), "strip");
    expect(skinned(mesh, null)).toEqual(bind(mesh));
    expect(mesh.clips!.map((c) => [c.name, c.duration])).toEqual([["Take 001", 1]]);
    const end = skinned(mesh, 1);
    // cp 4 (1, 2, 0) is all tip: 1 to the right of it, turned 90° about Z → (-1, 2, 0).
    expect(end[6]).toEqual([-1, 2, 0]);
    // cp 2 (1, 1, 0) is half each: (1, 1, 0) and (0, 2, 0) → (0.5, 1.5, 0).
    expect(end[2]).toEqual([0.5, 1.5, 0]);
    // The root's own vertices don't move.
    expect(end[0]).toEqual([0, 0, 0]);
    expect(skinned(mesh, 0)).toEqual(bind(mesh));
  });

  it("keeps the skin consistent in centimetres", async () => {
    const mesh = await parseFbx(buildFbx(strip(1, 100)), "strip");
    expect(bind(mesh)[6]).toEqual([1, 2, 0]); // 100 cm a unit: metres
    expect(skinned(mesh, null)).toEqual(bind(mesh));
    expect(skinned(mesh, 1)[6]).toEqual([-1, 2, 0]);
  });

  it("takes an embedded base-colour image and a named normal map supplied by file", async () => {
    const nodes = await parseFbxBinary(buildFbx(strip()));
    expect(fbxReferencedFiles(nodes)).toEqual(["normal.png"]);
    const mesh = await parseFbx(buildFbx(strip()), "strip", { files: new Map([["normal.png", NORMAL]]) });
    const m = mesh.primitives[0]!.material;
    expect(m.baseColorImage?.mime).toBe("image/png");
    expect(Array.from(m.baseColorImage!.bytes)).toEqual(Array.from(RED));
    expect(m.baseColorFactor).toEqual([1, 1, 1, 1]); // the texture carries the colour
    expect(Array.from(m.normalImage!.bytes)).toEqual(Array.from(NORMAL));
    // Without the file, the normal map is left out and the rest still imports.
    const without = await parseFbx(buildFbx(strip()), "strip");
    expect(without.primitives[0]!.material.normalImage).toBeUndefined();
    expect(without.primitives[0]!.material.baseColorImage?.mime).toBe("image/png");
  });
});
