/**
 * FBX import (AAA_FIDELITY_ROADMAP.md F9d): the format most DCC tools and
 * asset stores still ship meshes in, read here directly (binary 7.x and ASCII)
 * rather than through a WebAssembly converter, so it imports like OBJ and glTF.
 *
 * What it reads: every `Geometry` of type Mesh — its control points, its
 * polygons (`PolygonVertexIndex`, each polygon's last index stored as
 * −index − 1, fan-triangulated), its normals and first UV set (by polygon
 * vertex or by control point, direct or through an index), and its material
 * per polygon — placed by the `Model` it is connected to (its local
 * translation, rotation in XYZ order, and scale, up its parent chain), and the
 * `Material`s' diffuse colours. Each (geometry, material) pair becomes a
 * primitive. FBX is centimetres by default; the file's `UnitScaleFactor` takes
 * it to metres. Skinning and animation are left to the glTF path.
 *
 * Binary arrays may be zlib-compressed, so parsing is async (the platform's
 * DecompressionStream).
 */

import type { MeshAsset, MeshMaterial, MeshPrimitive } from "./MeshAsset";

/** One node of the FBX tree: its name, its properties, and its children. */
export interface FbxNode {
  readonly name: string;
  readonly props: readonly FbxValue[];
  readonly children: readonly FbxNode[];
}
export type FbxValue = number | bigint | string | boolean | Uint8Array | ArrayLike<number>;

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const BINARY_MAGIC = "Kaydara FBX Binary  \0";

/** Whether bytes are a binary FBX. */
export function isBinaryFbx(bytes: Uint8Array): boolean {
  if (bytes.length < 27) return false;
  for (let i = 0; i < BINARY_MAGIC.length; i += 1) if (bytes[i] !== BINARY_MAGIC.charCodeAt(i)) return false;
  return true;
}

/** Parse a binary FBX into its tree. */
export async function parseFbxBinary(bytes: Uint8Array): Promise<FbxNode[]> {
  if (!isBinaryFbx(bytes)) throw new Error("Not a binary FBX file.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(23, true);
  const wide = version >= 7500;
  let pos = 27;
  const readNode = async (): Promise<FbxNode | null> => {
    const end = wide ? Number(view.getBigUint64(pos, true)) : view.getUint32(pos, true);
    const count = wide ? Number(view.getBigUint64(pos + 8, true)) : view.getUint32(pos + 4, true);
    const nameLen = bytes[pos + (wide ? 24 : 12)]!;
    pos += (wide ? 25 : 13);
    if (end === 0) return null;
    const name = new TextDecoder().decode(bytes.subarray(pos, pos + nameLen));
    pos += nameLen;
    const props: FbxValue[] = [];
    for (let i = 0; i < count; i += 1) {
      const type = String.fromCharCode(bytes[pos]!);
      pos += 1;
      switch (type) {
        case "Y": props.push(view.getInt16(pos, true)); pos += 2; break;
        case "C": props.push(bytes[pos] !== 0); pos += 1; break;
        case "I": props.push(view.getInt32(pos, true)); pos += 4; break;
        case "F": props.push(view.getFloat32(pos, true)); pos += 4; break;
        case "D": props.push(view.getFloat64(pos, true)); pos += 8; break;
        case "L": props.push(view.getBigInt64(pos, true)); pos += 8; break;
        case "S":
        case "R": {
          const len = view.getUint32(pos, true);
          pos += 4;
          const raw = bytes.subarray(pos, pos + len);
          props.push(type === "S" ? new TextDecoder().decode(raw) : raw.slice());
          pos += len;
          break;
        }
        case "f": case "d": case "l": case "i": case "b": {
          const length = view.getUint32(pos, true);
          const encoding = view.getUint32(pos + 4, true);
          const compressed = view.getUint32(pos + 8, true);
          pos += 12;
          let data = bytes.subarray(pos, pos + compressed);
          pos += compressed;
          if (encoding === 1) data = await inflate(data);
          const size = type === "d" || type === "l" ? 8 : type === "b" ? 1 : 4;
          const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
          const out = new Float64Array(length);
          for (let k = 0; k < length; k += 1) {
            const at = k * size;
            out[k] = type === "f" ? dv.getFloat32(at, true) : type === "d" ? dv.getFloat64(at, true) : type === "i" ? dv.getInt32(at, true) : type === "l" ? Number(dv.getBigInt64(at, true)) : dv.getUint8(at);
          }
          props.push(out);
          break;
        }
        default:
          throw new Error(`FBX property type "${type}" isn't known.`);
      }
    }
    const children: FbxNode[] = [];
    while (pos < end) {
      const child = await readNode();
      if (!child) break;
      children.push(child);
    }
    pos = end;
    return { name, props, children };
  };
  const nodes: FbxNode[] = [];
  while (pos < bytes.length - 13) {
    const node = await readNode();
    if (!node) break;
    nodes.push(node);
  }
  return nodes;
}

/** Parse an ASCII FBX into its tree. */
export function parseFbxAscii(text: string): FbxNode[] {
  let pos = 0;
  const n = text.length;
  const skip = () => {
    for (;;) {
      while (pos < n && /\s/.test(text[pos]!)) pos += 1;
      if (text[pos] === ";") {
        while (pos < n && text[pos] !== "\n") pos += 1;
        continue;
      }
      return;
    }
  };
  const value = (): FbxValue | null => {
    skip();
    const c = text[pos];
    if (c === '"') {
      const end = text.indexOf('"', pos + 1);
      const s = text.slice(pos + 1, end);
      pos = end + 1;
      return s;
    }
    if (c === "*") {
      // An array: *count { a: 1,2,3 }
      pos += 1;
      while (pos < n && /[0-9]/.test(text[pos]!)) pos += 1;
      skip();
      pos += 1; // {
      skip();
      const colon = text.indexOf(":", pos);
      const close = text.indexOf("}", pos);
      const body = text.slice(colon + 1, close);
      pos = close + 1;
      return Float64Array.from(body.split(",").map((s) => s.trim()).filter((s) => s.length > 0).map(Number));
    }
    const m = /^[-+0-9.eE]+|^[A-Za-z_][A-Za-z0-9_|]*/.exec(text.slice(pos, pos + 64));
    if (!m) return null;
    pos += m[0].length;
    const num = Number(m[0]);
    return Number.isNaN(num) ? m[0] : num;
  };
  const nodes = (): FbxNode[] => {
    const out: FbxNode[] = [];
    for (;;) {
      skip();
      if (pos >= n || text[pos] === "}") return out;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(text.slice(pos, pos + 128));
      if (!m) {
        pos += 1;
        continue;
      }
      pos += m[0].length;
      const props: FbxValue[] = [];
      let children: FbxNode[] = [];
      for (;;) {
        skip();
        if (text[pos] === "{") {
          pos += 1;
          children = nodes();
          pos += 1; // }
          break;
        }
        if (text[pos] === "\n" || pos >= n || /^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(text.slice(pos, pos + 64)) || text[pos] === "}") break;
        const v = value();
        if (v === null) break;
        props.push(v);
        skip();
        if (text[pos] === ",") pos += 1;
        else if (text[pos] !== "{") break;
      }
      out.push({ name: m[1]!, props, children });
    }
  };
  return nodes();
}

const child = (node: FbxNode, name: string) => node.children.find((c) => c.name === name) ?? null;
const array = (node: FbxNode | null): ArrayLike<number> => {
  const p = node?.props[0];
  return p && typeof p === "object" && !(p instanceof Uint8Array) ? (p as ArrayLike<number>) : [];
};
const id = (v: FbxValue | undefined): string => String(typeof v === "bigint" ? v : v ?? "");

/** A Model's or Material's Properties70 value by name. */
function property(node: FbxNode, name: string): FbxValue[] | null {
  const props = child(node, "Properties70") ?? child(node, "Properties60");
  for (const p of props?.children ?? []) if (p.props[0] === name) return p.props.slice(4) as FbxValue[];
  return null;
}

type M4 = number[];
const multiply = (a: M4, b: M4): M4 => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) for (let k = 0; k < 4; k += 1) o[c * 4 + r] += a[k * 4 + r]! * b[c * 4 + k]!;
  return o;
};
function localMatrix(model: FbxNode): M4 {
  const t = (property(model, "Lcl Translation") ?? [0, 0, 0]).map(Number);
  const r = (property(model, "Lcl Rotation") ?? [0, 0, 0]).map((v) => (Number(v) * Math.PI) / 180);
  const s = (property(model, "Lcl Scaling") ?? [1, 1, 1]).map(Number);
  const rx: M4 = [1, 0, 0, 0, 0, Math.cos(r[0]!), Math.sin(r[0]!), 0, 0, -Math.sin(r[0]!), Math.cos(r[0]!), 0, 0, 0, 0, 1];
  const ry: M4 = [Math.cos(r[1]!), 0, -Math.sin(r[1]!), 0, 0, 1, 0, 0, Math.sin(r[1]!), 0, Math.cos(r[1]!), 0, 0, 0, 0, 1];
  const rz: M4 = [Math.cos(r[2]!), Math.sin(r[2]!), 0, 0, -Math.sin(r[2]!), Math.cos(r[2]!), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const sm: M4 = [s[0]!, 0, 0, 0, 0, s[1]!, 0, 0, 0, 0, s[2]!, 0, 0, 0, 0, 1];
  const tm: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0]!, t[1]!, t[2]!, 1];
  // FBX's default XYZ order applies X first: R = Rz·Ry·Rx.
  return multiply(tm, multiply(multiply(rz, multiply(ry, rx)), sm));
}

/** A layer element's value for polygon-vertex `pv` at control point `cp` (by mapping and reference). */
function layerValue(layer: FbxNode | null, valuesName: string, indexName: string, width: number, pv: number, cp: number, polygon: number): number[] | null {
  if (!layer) return null;
  const mapping = String(child(layer, "MappingInformationType")?.props[0] ?? "ByPolygonVertex");
  const reference = String(child(layer, "ReferenceInformationType")?.props[0] ?? "Direct");
  const values = array(child(layer, valuesName));
  const indices = array(child(layer, indexName));
  let k = mapping === "ByPolygonVertex" ? pv : mapping === "ByVertice" || mapping === "ByVertex" ? cp : mapping === "ByPolygon" ? polygon : mapping === "AllSame" ? 0 : pv;
  if (reference === "IndexToDirect" || reference === "Index") k = indices[k] ?? 0;
  if ((k + 1) * width > values.length) return null;
  return Array.from({ length: width }, (_, c) => values[k * width + c]!);
}

/** Turn an FBX tree into a mesh (see the module comment). */
export function fbxToMesh(nodes: readonly FbxNode[], name = "fbx"): MeshAsset {
  const objects = nodes.find((n) => n.name === "Objects");
  if (!objects) throw new Error("FBX without objects.");
  const connections = nodes.find((n) => n.name === "Connections")?.children ?? [];
  const settings = nodes.find((n) => n.name === "GlobalSettings");
  const unit = settings ? Number(property(settings, "UnitScaleFactor")?.[0] ?? 1) : 1;
  const scale = (Number.isFinite(unit) && unit > 0 ? unit : 1) / 100;
  const byId = new Map(objects.children.map((o) => [id(o.props[0]), o]));
  // Child → parent object links (object-object connections).
  const parentOf = new Map<string, string[]>();
  for (const c of connections) {
    if (c.props[0] !== "OO") continue;
    const from = id(c.props[1]), to = id(c.props[2]);
    if (!parentOf.has(from)) parentOf.set(from, []);
    parentOf.get(from)!.push(to);
  }
  const worldOf = (modelId: string, depth = 0): M4 => {
    const model = byId.get(modelId);
    if (!model || model.name !== "Model" || depth > 32) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const up = (parentOf.get(modelId) ?? []).find((p) => byId.get(p)?.name === "Model");
    return up ? multiply(worldOf(up, depth + 1), localMatrix(model)) : localMatrix(model);
  };
  const materialsOf = (modelId: string) => [...connections].filter((c) => c.props[0] === "OO" && id(c.props[2]) === modelId && byId.get(id(c.props[1]))?.name === "Material").map((c) => byId.get(id(c.props[1]))!);
  const primitives: MeshPrimitive[] = [];
  for (const geometry of objects.children) {
    if (geometry.name !== "Geometry" || String(geometry.props[2] ?? "Mesh") !== "Mesh") continue;
    const gid = id(geometry.props[0]);
    const modelId = (parentOf.get(gid) ?? []).find((p) => byId.get(p)?.name === "Model") ?? "";
    const world = worldOf(modelId);
    const mats = materialsOf(modelId);
    const points = array(child(geometry, "Vertices"));
    const polys = array(child(geometry, "PolygonVertexIndex"));
    const normalLayer = child(geometry, "LayerElementNormal");
    const uvLayer = child(geometry, "LayerElementUV");
    const materialLayer = child(geometry, "LayerElementMaterial");
    const matIndices = array(child(materialLayer ?? { name: "", props: [], children: [] }, "Materials"));
    const matMapping = String(child(materialLayer ?? { name: "", props: [], children: [] }, "MappingInformationType")?.props[0] ?? "AllSame");
    // One builder a material.
    const builders = new Map<number, { positions: number[]; normals: number[]; uvs: number[]; indices: number[] }>();
    let polygon = 0;
    let start = 0;
    const normalMatrix = world;
    for (let i = 0; i < polys.length; i += 1) {
      const raw = polys[i]!;
      if (raw >= 0) continue;
      // Polygon from start to i (inclusive; the last stored as −index − 1).
      const corners: number[] = [];
      for (let k = start; k <= i; k += 1) corners.push(k);
      const mi = matMapping === "ByPolygon" ? (matIndices[polygon] ?? 0) : (matIndices[0] ?? 0);
      let b = builders.get(mi);
      if (!b) builders.set(mi, (b = { positions: [], normals: [], uvs: [], indices: [] }));
      const base = b.positions.length / 3;
      for (const pv of corners) {
        const v = polys[pv]!;
        const cp = v < 0 ? -v - 1 : v;
        const x = points[cp * 3]!, y = points[cp * 3 + 1]!, z = points[cp * 3 + 2]!;
        b.positions.push((world[0]! * x + world[4]! * y + world[8]! * z + world[12]!) * scale, (world[1]! * x + world[5]! * y + world[9]! * z + world[13]!) * scale, (world[2]! * x + world[6]! * y + world[10]! * z + world[14]!) * scale);
        const nv = layerValue(normalLayer, "Normals", "NormalsIndex", 3, pv, cp, polygon) ?? [0, 1, 0];
        const nx = normalMatrix[0]! * nv[0]! + normalMatrix[4]! * nv[1]! + normalMatrix[8]! * nv[2]!;
        const ny = normalMatrix[1]! * nv[0]! + normalMatrix[5]! * nv[1]! + normalMatrix[9]! * nv[2]!;
        const nz = normalMatrix[2]! * nv[0]! + normalMatrix[6]! * nv[1]! + normalMatrix[10]! * nv[2]!;
        const l = Math.hypot(nx, ny, nz) || 1;
        b.normals.push(nx / l, ny / l, nz / l);
        const uv = layerValue(uvLayer, "UV", "UVIndex", 2, pv, cp, polygon) ?? [0, 0];
        b.uvs.push(uv[0]!, uv[1]!);
      }
      for (let k = 1; k + 1 < corners.length; k += 1) b.indices.push(base, base + k, base + k + 1);
      polygon += 1;
      start = i + 1;
    }
    for (const [mi, b] of builders) {
      const m = mats[mi] ?? null;
      const diffuse = m ? (property(m, "DiffuseColor") ?? property(m, "Diffuse")) : null;
      const colour = diffuse ? diffuse.slice(0, 3).map(Number) : [0.8, 0.8, 0.8];
      const material: MeshMaterial = { name: m ? String(m.props[1] ?? "material").split("\u0000")[0]!.replace(/^Material::/, "") : "default", baseColorFactor: [colour[0]!, colour[1]!, colour[2]!, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.8 };
      primitives.push({ positions: Float32Array.from(b.positions), normals: Float32Array.from(b.normals), uvs: uvLayer ? Float32Array.from(b.uvs) : null, indices: Uint32Array.from(b.indices), material } as unknown as MeshPrimitive);
    }
  }
  if (primitives.length === 0) throw new Error("FBX has no meshes.");
  return { name, primitives } as MeshAsset;
}

/** Import an FBX file (binary or ASCII) as a mesh. */
export async function parseFbx(bytes: Uint8Array, name = "fbx"): Promise<MeshAsset> {
  const nodes = isBinaryFbx(bytes) ? await parseFbxBinary(bytes) : parseFbxAscii(new TextDecoder().decode(bytes));
  return fbxToMesh(nodes, name);
}
