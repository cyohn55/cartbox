/**
 * Formats on import (AAA_FIDELITY_ROADMAP.md F9d): OpenEXR and float KTX2
 * environments (to Radiance, so the sky takes them as it takes `.hdr`), IES
 * light profiles (and the AAA renderer shading by them on a real device), FBX
 * (binary and ASCII), USDA and USDZ, and the platform texture plan.
 */

import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  IES_HORIZONTAL_SAMPLES,
  IES_VERTICAL_SAMPLES,
  composeModelMatrix,
  decodeExr,
  decodeKtx2Hdr,
  defaultSceneLighting,
  encodeRadianceHdr,
  iesProfile,
  parseFbx,
  parseIes,
  parseSceneLighting,
  parseUsd,
  projectionMatrix,
  readIesProfile,
  sampleIes,
  viewMatrix,
  type MeshAsset,
  type MeshSceneInstance,
  type SceneLight,
} from "@cartbox/editor";
import { WebgpuSceneRenderer, packLights } from "@cartbox/player";

import { decodeRadianceHdr } from "../packages/editor/src/render/skyLayers";
import { downscaleTexture, importTexturePlan } from "../apps/web/src/lib/ktx2Policy";

/** A little-endian byte writer. */
class Bytes {
  readonly out: number[] = [];
  u8(...v: number[]) { this.out.push(...v.map((x) => x & 0xff)); return this; }
  u16(v: number) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return this.u8(...b); }
  i32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); return this.u8(...b); }
  u32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return this.u8(...b); }
  u64(v: number | bigint) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return this.u8(...b); }
  i64(v: bigint) { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, v, true); return this.u8(...b); }
  f32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return this.u8(...b); }
  f64(v: number) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); return this.u8(...b); }
  str(s: string) { return this.u8(...new TextEncoder().encode(s)); }
  cstr(s: string) { return this.str(s).u8(0); }
  bytes(b: ArrayLike<number>) { return this.u8(...Array.from(b)); }
  get length() { return this.out.length; }
  done() { return Uint8Array.from(this.out); }
}

/** Float → IEEE half, for values a half holds exactly. */
function toHalf(v: number): number {
  if (v === 0) return 0;
  const e = Math.floor(Math.log2(v));
  return ((e + 15) << 10) | Math.round((v / 2 ** e - 1) * 1024);
}

/** A scanline OpenEXR of RGB `pixel(x, y)`: float channels uncompressed, or half channels ZIP-compressed. */
function buildExr(width: number, height: number, pixel: (x: number, y: number) => [number, number, number], zip: boolean): Uint8Array {
  const type = zip ? 1 : 2;
  const head = new Bytes().u32(20000630).u32(2);
  const chlist = new Bytes();
  for (const c of ["B", "G", "R"]) chlist.cstr(c).i32(type).u8(0, 0, 0, 0).i32(1).i32(1);
  chlist.u8(0);
  head.cstr("channels").cstr("chlist").u32(chlist.length).bytes(chlist.out);
  head.cstr("compression").cstr("compression").u32(1).u8(zip ? 3 : 0);
  head.cstr("dataWindow").cstr("box2i").u32(16).i32(0).i32(0).i32(width - 1).i32(height - 1);
  head.cstr("displayWindow").cstr("box2i").u32(16).i32(0).i32(0).i32(width - 1).i32(height - 1);
  head.cstr("lineOrder").cstr("lineOrder").u32(1).u8(0);
  head.u8(0);
  const per = zip ? 16 : 1;
  const blocks: Uint8Array[] = [];
  for (let y0 = 0; y0 < height; y0 += per) {
    const raw = new Bytes();
    for (let y = y0; y < Math.min(height, y0 + per); y += 1) {
      for (const c of [2, 1, 0]) for (let x = 0; x < width; x += 1) {
        const v = pixel(x, y)[c]!;
        if (zip) raw.u16(toHalf(v));
        else raw.f32(v);
      }
    }
    let data = raw.done();
    if (zip) {
      // Split even and odd bytes, then the byte predictor, then zlib.
      const split = new Uint8Array(data.length);
      const half = Math.ceil(data.length / 2);
      for (let i = 0; i < data.length; i += 1) split[i % 2 === 0 ? i >> 1 : half + (i >> 1)] = data[i]!;
      const predicted = Uint8Array.from(split, (b, i) => (i === 0 ? b : (b - split[i - 1]! + 128 + 256) & 0xff));
      data = new Uint8Array(deflateSync(predicted));
    }
    blocks.push(new Bytes().i32(y0).u32(data.length).bytes(data).done());
  }
  const table = new Bytes();
  let at = head.length + blocks.length * 8;
  for (const b of blocks) { table.u64(at); at += b.length; }
  const out = new Bytes().bytes(head.out).bytes(table.out);
  for (const b of blocks) out.bytes(b);
  return out.done();
}

/** An uncompressed KTX2 of `format` holding `level` bytes, `width × height`. */
function buildKtx2(format: number, width: number, height: number, level: Uint8Array): Uint8Array {
  const b = new Bytes().u8(0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a);
  b.u32(format).u32(1).u32(width).u32(height).u32(0).u32(0).u32(1).u32(1).u32(0);
  while (b.length < 80) b.u8(0);
  b.u64(104).u64(level.length).u64(level.length);
  return b.bytes(level).done();
}

describe("OpenEXR, KTX2 HDR and Radiance", () => {
  const pixel = (x: number, y: number): [number, number, number] => [0.25 * (x + 1), 1.5 + y, 12 / (x + y + 1)];

  it("decodes an uncompressed float EXR, channels found by name", async () => {
    const image = await decodeExr(buildExr(3, 2, pixel, false));
    expect([image.width, image.height]).toEqual([3, 2]);
    for (let y = 0; y < 2; y += 1) for (let x = 0; x < 3; x += 1) {
      const want = pixel(x, y);
      for (let c = 0; c < 3; c += 1) expect(image.data[(y * 3 + x) * 3 + c]).toBeCloseTo(want[c]!, 5);
    }
  });

  it("decodes a ZIP EXR of half channels across 16-line blocks", async () => {
    const exact = (x: number, y: number): [number, number, number] => [0.25 * (x + 1), 1.5 + y, 2 ** (x % 4)];
    const image = await decodeExr(buildExr(5, 20, exact, true));
    expect([image.width, image.height]).toEqual([5, 20]);
    for (const [x, y] of [[0, 0], [4, 7], [2, 15], [3, 16], [4, 19]] as const) expect(Array.from(image.data.subarray((y * 5 + x) * 3, (y * 5 + x) * 3 + 3))).toEqual(exact(x, y));
  });

  it("refuses what it doesn't read with the reason", async () => {
    const piz = buildExr(2, 2, pixel, false);
    const text = new TextDecoder("latin1").decode(piz);
    const at = text.indexOf("compression\0compression\0") + "compression\0compression\0".length + 4;
    piz[at] = 4;
    await expect(decodeExr(piz)).rejects.toThrow(/PIZ/);
    await expect(decodeExr(new Uint8Array(16))).rejects.toThrow(/OpenEXR/);
  });

  it("decodes float KTX2: RGBA32F and the shared-exponent format", () => {
    const rgba = new Bytes();
    for (const v of [0.5, 2, 8, 1, 3, 0, 0.125, 1]) rgba.f32(v);
    const a = decodeKtx2Hdr(buildKtx2(109, 2, 1, rgba.done()));
    expect(Array.from(a.data)).toEqual([0.5, 2, 8, 3, 0, 0.125]);
    // E5B9G9R9: 1.0 is a mantissa of 256 at exponent 16.
    const e5 = new Bytes().u32((256 | (128 << 9) | (64 << 18) | (16 << 27)) >>> 0).done();
    expect(Array.from(decodeKtx2Hdr(buildKtx2(123, 1, 1, e5)).data)).toEqual([1, 0.5, 0.25]);
    expect(() => decodeKtx2Hdr(buildKtx2(37, 1, 1, new Uint8Array(4)))).toThrow(/float format/);
  });

  it("writes Radiance the sky's own reader takes back within RGBE's precision", () => {
    const data = Float32Array.from([0.5, 1, 2, 10, 0, 0.01, 0, 0, 0, 1000, 900, 800]);
    const back = decodeRadianceHdr(encodeRadianceHdr({ width: 2, height: 2, data }))!;
    expect([back.width, back.height]).toEqual([2, 2]);
    for (let p = 0; p < 4; p += 1) {
      const top = Math.max(data[p * 3]!, data[p * 3 + 1]!, data[p * 3 + 2]!);
      for (let c = 0; c < 3; c += 1) expect(Math.abs(back.data[p * 3 + c]! - data[p * 3 + c]!)).toBeLessThanOrEqual(top / 128 + 1e-9);
    }
  });
});

const DOWNLIGHT = `IESNA:LM-63-2002
[TEST] lab 42
[LUMINAIRE] Recessed downlight
[MORE] a comment
TILT=NONE
1 1000 2 5 1 1 2 0.1 0.1 0
1 1 12
0 30 60 90 180
0
1000 800 100 0 0
`;

describe("IES profiles", () => {
  it("parses LM-63's header, angles and candela, and resamples about the axis", () => {
    const parsed = parseIes(DOWNLIGHT);
    expect(parsed.vertical).toEqual([0, 30, 60, 90, 180]);
    expect(parsed.horizontal).toEqual([0]);
    expect(parsed.multiplier).toBe(2);
    const profile = iesProfile(DOWNLIGHT);
    expect(profile.label).toBe("lab 42");
    expect(profile.peakCandela).toBe(2000);
    expect(profile.samples.length).toBe(IES_VERTICAL_SAMPLES * IES_HORIZONTAL_SAMPLES);
    expect(sampleIes(profile, 0, 0)).toBeCloseTo(1, 6);
    expect(sampleIes(profile, Math.PI / 12, 1)).toBeCloseTo(0.9, 4);
    expect(sampleIes(profile, Math.PI / 2, 2)).toBeCloseTo(0, 2);
    // One horizontal angle: the same all the way round.
    for (const h of [0.3, 2, 4, 6]) expect(sampleIes(profile, 0.4, h)).toBeCloseTo(sampleIes(profile, 0.4, 0), 6);
  });

  it("unfolds a quadrant-symmetric file onto the full circle", () => {
    const quadrant = `IESNA:LM-63-1995\nTILT=NONE\n1 -1 1 2 3 1 2 0 0 0\n1 1 10\n0 90\n0 45 90\n100 100\n50 50\n0 0\n`;
    const profile = iesProfile(quadrant);
    const v = Math.PI / 4;
    expect(sampleIes(profile, v, 0)).toBeCloseTo(1, 5);
    expect(sampleIes(profile, v, Math.PI / 4)).toBeCloseTo(0.5, 5);
    expect(sampleIes(profile, v, (3 * Math.PI) / 4)).toBeCloseTo(0.5, 5);
    expect(sampleIes(profile, v, Math.PI)).toBeCloseTo(1, 5);
    expect(sampleIes(profile, v, (3 * Math.PI) / 2)).toBeCloseTo(0, 5);
  });

  it("refuses what isn't a profile, and keeps one on a light through a save", () => {
    expect(() => parseIes("hello")).toThrow();
    expect(() => parseIes("IESNA:LM-63-2002\nTILT=NONE\n1 1000 1")).toThrow(/early/);
    const profile = iesProfile(DOWNLIGHT);
    expect(readIesProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
    expect(readIesProfile({ samples: [1, 2] })).toBeNull();
    const spot: SceneLight = { kind: "spot", position: [0, 3, 0], direction: [0, -1, 0], color: [1, 1, 1], intensity: 4, range: 10, innerAngle: 0.3, outerAngle: 0.6, ies: profile };
    const back = parseSceneLighting(JSON.parse(JSON.stringify({ ...defaultSceneLighting(), lights: [spot] })))!;
    expect(back.lights[0]!.ies).toEqual(profile);
  });

  it("packs a profile's slot and axis, and −1 without one", () => {
    const profile = iesProfile(DOWNLIGHT);
    const lights: SceneLight[] = [
      { kind: "point", position: [0, 2, 0], direction: [0, -2, 0], color: [1, 1, 1], intensity: 1, range: 5, ies: profile },
      { kind: "point", position: [1, 2, 0], color: [1, 1, 1], intensity: 1, range: 5 },
    ];
    const packed = packLights(lights, true, (l) => (l.ies ? 3 : -1));
    expect(packed[19]).toBe(3);
    expect(Array.from(packed.subarray(12, 15))).toEqual([0, -1, 0]);
    expect(packed[20 + 19]).toBe(-1);
    expect(Array.from(packed.subarray(32, 35))).toEqual([0, 0, 0]);
  });
});

const FBX_ASCII = `; FBX 7.4.0 project file
FBXHeaderExtension:  {
	FBXVersion: 7400
}
GlobalSettings:  {
	Properties70:  {
		P: "UnitScaleFactor", "double", "Number", "",100
	}
}
Objects:  {
	Geometry: 1000, "Geometry::Quad", "Mesh" {
		Vertices: *12 {
			a: 0,0,0,1,0,0,1,1,0,0,1,0
		}
		PolygonVertexIndex: *4 {
			a: 0,1,2,-4
		}
		LayerElementNormal: 0 {
			MappingInformationType: "ByVertice"
			ReferenceInformationType: "Direct"
			Normals: *12 {
				a: 0,0,1,0,0,1,0,0,1,0,0,1
			}
		}
		LayerElementUV: 0 {
			MappingInformationType: "ByPolygonVertex"
			ReferenceInformationType: "IndexToDirect"
			UV: *8 {
				a: 0,0,1,0,1,1,0,1
			}
			UVIndex: *4 {
				a: 0,1,2,3
			}
		}
	}
	Model: 2000, "Model::Quad", "Mesh" {
		Properties70:  {
			P: "Lcl Translation", "Lcl Translation", "", "A",0,0,5
			P: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,90
		}
	}
	Material: 3000, "Material::Red", "" {
		Properties70:  {
			P: "DiffuseColor", "Color", "", "A",1,0,0
		}
	}
}
Connections:  {
	C: "OO",1000,2000
	C: "OO",2000,0
	C: "OO",3000,2000
}
`;

type Prop = number | bigint | string | Float64Array | Int32Array;
interface Node { name: string; props: Prop[]; children: Node[] }
const node = (name: string, props: Prop[], children: Node[] = []): Node => ({ name, props, children });

/** A binary FBX 7400 of `nodes`: doubles as D, ids as L, strings as S, Float64Arrays as zlib'd d, Int32Arrays as plain i. */
function buildFbxBinary(nodes: Node[]): Uint8Array {
  const out = new Bytes().str("Kaydara FBX Binary  \0").u8(0x1a, 0).u32(7400);
  const write = (n: Node) => {
    const props = new Bytes();
    for (const p of n.props) {
      if (typeof p === "bigint") props.str("L").i64(p);
      else if (typeof p === "number") props.str("D").f64(p);
      else if (typeof p === "string") props.str("S").u32(new TextEncoder().encode(p).length).str(p);
      else if (p instanceof Float64Array) {
        const raw = new Uint8Array(p.buffer);
        const z = deflateSync(raw);
        props.str("d").u32(p.length).u32(1).u32(z.length).bytes(z);
      } else props.str("i").u32(p.length).u32(0).u32(p.length * 4).bytes(new Uint8Array(p.buffer));
    }
    const start = out.length;
    out.u32(0).u32(n.props.length).u32(props.length).u8(n.name.length).str(n.name).bytes(props.out);
    for (const c of n.children) write(c);
    if (n.children.length > 0) for (let i = 0; i < 13; i += 1) out.u8(0);
    const end = out.length;
    out.out.splice(start, 4, end & 0xff, (end >> 8) & 0xff, (end >> 16) & 0xff, (end >>> 24) & 0xff);
  };
  for (const n of nodes) write(n);
  for (let i = 0; i < 13; i += 1) out.u8(0);
  return out.done();
}

const P = (...v: Prop[]) => node("P", v);
const FBX_TREE: Node[] = [
  node("GlobalSettings", [], [node("Properties70", [], [P("UnitScaleFactor", "double", "Number", "", 100)])]),
  node("Objects", [], [
    node("Geometry", [1000n, "Quad\u0000\u0001Geometry", "Mesh"], [
      node("Vertices", [Float64Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0])]),
      node("PolygonVertexIndex", [Int32Array.from([0, 1, 2, -4])]),
      node("LayerElementNormal", [0], [node("MappingInformationType", ["ByVertice"]), node("ReferenceInformationType", ["Direct"]), node("Normals", [Float64Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])])]),
      node("LayerElementUV", [0], [node("MappingInformationType", ["ByPolygonVertex"]), node("ReferenceInformationType", ["IndexToDirect"]), node("UV", [Float64Array.from([0, 0, 1, 0, 1, 1, 0, 1])]), node("UVIndex", [Int32Array.from([0, 1, 2, 3])])]),
    ]),
    node("Model", [2000n, "Quad\u0000\u0001Model", "Mesh"], [node("Properties70", [], [P("Lcl Translation", "Lcl Translation", "", "A", 0, 0, 5), P("Lcl Rotation", "Lcl Rotation", "", "A", 0, 0, 90)])]),
    node("Material", [3000n, "Red\u0000\u0001Material", ""], [node("Properties70", [], [P("DiffuseColor", "Color", "", "A", 1, 0, 0)])]),
  ]),
  node("Connections", [], [node("C", ["OO", 1000n, 2000n]), node("C", ["OO", 2000n, 0n]), node("C", ["OO", 3000n, 2000n])]),
];

function expectQuad(mesh: MeshAsset) {
  expect(mesh.primitives.length).toBe(1);
  const p = mesh.primitives[0]!;
  expect(Array.from(p.indices)).toEqual([0, 1, 2, 0, 2, 3]);
  // Turned 90° about Z, then 5 up Z: (1, 0, 0) lands at (0, 1, 5).
  const at = (i: number) => Array.from(p.positions.subarray(i * 3, i * 3 + 3)).map((v) => Math.round(v * 1e5) / 1e5 + 0);
  expect(at(0)).toEqual([0, 0, 5]);
  expect(at(1)).toEqual([0, 1, 5]);
  expect(at(2)).toEqual([-1, 1, 5]);
  expect(Array.from(p.normals!.subarray(0, 3)).map((v) => Math.round(v * 1e5) / 1e5 + 0)).toEqual([0, 0, 1]);
  expect(Array.from(p.uvs!)).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
  expect(p.material.name).toBe("Red");
  expect(p.material.baseColorFactor).toEqual([1, 0, 0, 1]);
}

describe("FBX", () => {
  it("imports an ASCII FBX: geometry placed by its model, its UVs and its material", async () => {
    expectQuad(await parseFbx(new TextEncoder().encode(FBX_ASCII), "quad"));
  });

  it("imports the same scene as binary FBX, with zlib-compressed arrays", async () => {
    expectQuad(await parseFbx(buildFbxBinary(FBX_TREE), "quad"));
  });

  it("refuses a file without meshes", async () => {
    await expect(parseFbx(new TextEncoder().encode("Objects:  {\n}\n"))).rejects.toThrow(/no meshes/);
  });
});

const USDA = `#usda 1.0
(
    defaultPrim = "Root"
    metersPerUnit = 0.01
    upAxis = "Z"
)

def Xform "Root" (
    kind = "component"
)
{
    double3 xformOp:translate = (0, 0, 100)
    uniform token[] xformOpOrder = ["xformOp:translate"]

    def Mesh "Quad"
    {
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
        point3f[] points = [(0, 0, 0), (100, 0, 0), (100, 100, 0), (0, 100, 0)]
        normal3f[] normals = [(0, 0, 1), (0, 0, 1), (0, 0, 1), (0, 0, 1)] (
            interpolation = "faceVarying"
        )
        texCoord2f[] primvars:st = [(0, 0), (1, 0), (1, 1), (0, 1)] (
            interpolation = "faceVarying"
        )
        color3f[] primvars:displayColor = [(0, 1, 0)]
    }
}
`;

/** A stored (uncompressed) zip of `files`, as USDZ is. */
function storedZip(files: [string, Uint8Array][]): Uint8Array {
  const b = new Bytes();
  for (const [name, data] of files) {
    const n = new TextEncoder().encode(name);
    b.u32(0x04034b50).u16(20).u16(0).u16(0).u16(0).u16(0).u32(0).u32(data.length).u32(data.length).u16(n.length).u16(0).bytes(n).bytes(data);
  }
  return b.done();
}

function expectUsdQuad(mesh: MeshAsset) {
  const p = mesh.primitives[0]!;
  expect(Array.from(p.indices)).toEqual([0, 1, 2, 0, 2, 3]);
  // Centimetres, Z up, raised a metre: (100, 100, 0) lands at (1, 1, −1) in metres, Y up.
  const at = (i: number) => Array.from(p.positions.subarray(i * 3, i * 3 + 3)).map((v) => Math.round(v * 1e5) / 1e5 + 0);
  expect(at(0)).toEqual([0, 1, 0]);
  expect(at(2)).toEqual([1, 1, -1]);
  expect(Array.from(p.normals!.subarray(0, 3)).map((v) => Math.round(v * 1e5) / 1e5 + 0)).toEqual([0, 1, 0]);
  expect(Array.from(p.uvs!)).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
  expect(p.material.baseColorFactor).toEqual([0, 1, 0, 1]);
}

describe("USD", () => {
  it("imports a USDA stage: units, up axis, transforms, normals, UVs and display colour", () => {
    expectUsdQuad(parseUsd(new TextEncoder().encode(USDA)));
  });

  it("imports a USDZ package's layer, and refuses the binary crate with a way out", () => {
    const usdz = storedZip([["quad.usda", new TextEncoder().encode(USDA)], ["tex.png", new Uint8Array([1, 2, 3])]]);
    expectUsdQuad(parseUsd(usdz));
    expect(() => parseUsd(new TextEncoder().encode("PXR-USDC\0\0\0\0"))).toThrow(/USDA/);
    expect(() => parseUsd(new TextEncoder().encode("#usda 1.0\n"))).toThrow(/no meshes/);
  });
});

describe("textures by platform", () => {
  it("plans UASTC on desktop, ETC1S colour on mobile, and each platform's largest edge", () => {
    expect(importTexturePlan("desktop", "color", 2048, 2048)).toEqual({ codec: "uastc", maxEdge: 8192 });
    expect(importTexturePlan("mobile", "color", 4096, 4096)).toEqual({ codec: "etc1s", maxEdge: 2048 });
    expect(importTexturePlan("mobile", "normal", 1024, 1024).codec).toBe("uastc");
    // Past Basis's texel limit even at 8K, it stays as it is.
    expect(importTexturePlan("desktop", "color", 8192, 8192).codec).toBe("keep");
  });

  it("halves a texture by box filter until it fits", () => {
    const data = new Uint8ClampedArray(8 * 4 * 4);
    for (let i = 0; i < 32; i += 1) data.set([i % 2 ? 200 : 100, 0, 0, 255], i * 4);
    const small = downscaleTexture({ width: 8, height: 4, data }, 2);
    expect([small.width, small.height]).toEqual([2, 1]);
    expect(Array.from(small.data.subarray(0, 4))).toEqual([150, 0, 0, 255]);
  });
});

async function realDevice(): Promise<any | null> {
  try {
    const module = (await import(/* @vite-ignore */ "@kmamal/gpu")) as any;
    const instance = (module.default ?? module).create([]);
    const adapter = await instance.requestAdapter();
    return adapter ? await adapter.requestDevice() : null;
  } catch {
    return null;
  }
}
const device = await realDevice();

async function settled<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 400 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    device.tick?.();
  }
  return promise;
}

function half(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (m / 1024);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + m / 1024);
}

describe.skipIf(!device)("an IES light on a real device", { timeout: 60_000 }, () => {
  const W = 48;
  const H = 48;
  const QUAD = {
    name: "q",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.8 },
      },
    ],
  } as unknown as MeshAsset;

  /** The linear red at pixels (x, y) of a quad lit by `light`. */
  async function render(light: SceneLight, pixels: [number, number][]): Promise<number[]> {
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr: true }))!;
    const instances: MeshSceneInstance[] = [{ mesh: QUAD, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [2, 2, 1]) }];
    device.pushErrorScope("validation");
    const texture = renderer.renderToTexture!(instances, {
      width: W,
      height: H,
      view: viewMatrix([0, 0, 3], [0, 0, 0]),
      projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50),
      ambient: 0,
      lightDirection: [0, 0, -1],
      environment: null,
      lights: [light],
    } as any);
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const bytesPerRow = Math.ceil((W * 8) / 256) * 256;
    const buffer = device.createBuffer({ size: bytesPerRow * H, usage: 0x01 | 0x08 });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: H }, { width: W, height: H });
    device.queue.submit([encoder.finish()]);
    await settled(buffer.mapAsync(0x01));
    const halves = new Uint16Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    buffer.destroy();
    renderer.dispose();
    return pixels.map(([x, y]) => half(halves[(y * bytesPerRow) / 2 + x * 4]!));
  }

  it("throws a downlight's pool: full under it, dark past its cut-off", async () => {
    // Full to 20° off the axis, nothing past 35°.
    const narrow = iesProfile(`IESNA:LM-63-2002\nTILT=NONE\n1 1000 1 5 1 1 2 0 0 0\n1 1 10\n0 20 35 90 180\n0\n1000 1000 0 0 0\n`);
    const plain: SceneLight = { kind: "point", position: [0, 0, 1], direction: [0, 0, -1], color: [1, 1, 1], intensity: 3, range: 10 };
    // The centre (about 2° off the axis), and a pixel about 56° off it.
    const pixels: [number, number][] = [[W >> 1, H >> 1], [44, H >> 1]];
    const [centre, edge] = await render(plain, pixels);
    const [centreIes, edgeIes] = await render({ ...plain, ies: narrow }, pixels);
    expect(edge).toBeGreaterThan(0.01);
    expect(Math.abs(centreIes! - centre!) / centre!).toBeLessThan(0.02);
    expect(edgeIes).toBeLessThan(edge! * 0.02);
  });
});
