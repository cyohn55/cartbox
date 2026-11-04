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

import type { EncodedImage, MeshAsset, MeshMaterial, MeshPrimitive } from "./MeshAsset";
import type { AnimationClip, ClipChannel, MeshSkin, SkinJoint } from "./skeleton";

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
type Q = [number, number, number, number];
const quatMul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
/** FBX's default XYZ Euler order applies X first: R = Rz·Ry·Rx, so q = qz·qy·qx. */
function eulerQuat(deg: readonly number[]): Q {
  const h = (i: number) => ((Number(deg[i] ?? 0) * Math.PI) / 180) / 2;
  const qx: Q = [Math.sin(h(0)), 0, 0, Math.cos(h(0))];
  const qy: Q = [0, Math.sin(h(1)), 0, Math.cos(h(1))];
  const qz: Q = [0, 0, Math.sin(h(2)), Math.cos(h(2))];
  return quatMul(qz, quatMul(qy, qx));
}
const trsMatrix = (t: readonly number[], q: Q, s: readonly number[]): M4 => {
  const [x, y, z, w] = q;
  const r = [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)];
  return [r[0]! * s[0]!, r[1]! * s[0]!, r[2]! * s[0]!, 0, r[3]! * s[1]!, r[4]! * s[1]!, r[5]! * s[1]!, 0, r[6]! * s[2]!, r[7]! * s[2]!, r[8]! * s[2]!, 0, t[0]!, t[1]!, t[2]!, 1];
};
/** A Model's local transform as translation, rotation (its PreRotation, then Lcl Rotation) and scale. */
function localTRS(model: FbxNode, at: { t?: readonly number[]; r?: readonly number[]; s?: readonly number[] } = {}): { t: number[]; q: Q; s: number[] } {
  const t = (at.t ?? property(model, "Lcl Translation") ?? [0, 0, 0]).map(Number);
  const r = (at.r ?? property(model, "Lcl Rotation") ?? [0, 0, 0]).map(Number);
  const pre = (property(model, "PreRotation") ?? [0, 0, 0]).map(Number);
  const s = (at.s ?? property(model, "Lcl Scaling") ?? [1, 1, 1]).map(Number);
  return { t, q: quatMul(eulerQuat(pre), eulerQuat(r)), s };
}
function localMatrix(model: FbxNode): M4 {
  const { t, q, s } = localTRS(model);
  return trsMatrix(t, q, s);
}
function invert(m: M4): M4 {
  const inv = new Array(16).fill(0);
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  const d = det === 0 ? 0 : 1 / det;
  inv[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d; inv[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  inv[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d; inv[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  inv[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d; inv[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  inv[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d; inv[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  inv[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d; inv[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  inv[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d; inv[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  inv[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d; inv[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  inv[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d; inv[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return inv;
}

/** FBX time: ticks a second. */
export const FBX_TICKS_PER_SECOND = 46186158000;

/** An image's MIME type from its first bytes (PNG, JPEG, KTX2, WebP), or null. */
function imageMime(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0xab && bytes[1] === 0x4b && bytes[2] === 0x54 && bytes[3] === 0x58) return "image/ktx2";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return null;
}

/** A file name without its folders (FBX stores the author's absolute paths). */
const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

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

/** Options for an import: image files the FBX names but doesn't embed, by file name. */
export interface FbxImportOptions {
  readonly files?: ReadonlyMap<string, Uint8Array>;
}

/** What's connected where: object-object links (child → parents) and object-property links. */
function links(nodes: readonly FbxNode[]) {
  const connections = nodes.find((n) => n.name === "Connections")?.children ?? [];
  const parentOf = new Map<string, string[]>();
  const childrenOf = new Map<string, string[]>();
  const props: { from: string; to: string; prop: string }[] = [];
  for (const c of connections) {
    const from = id(c.props[1]);
    const to = id(c.props[2]);
    if (c.props[0] === "OO") {
      if (!parentOf.has(from)) parentOf.set(from, []);
      parentOf.get(from)!.push(to);
      if (!childrenOf.has(to)) childrenOf.set(to, []);
      childrenOf.get(to)!.push(from);
    } else if (c.props[0] === "OP") props.push({ from, to, prop: String(c.props[3] ?? "") });
  }
  return { connections, parentOf, childrenOf, props };
}

/** The image files an FBX's textures name without embedding them (their file names), for a caller to supply. */
export function fbxReferencedFiles(nodes: readonly FbxNode[]): string[] {
  const objects = nodes.find((n) => n.name === "Objects");
  if (!objects) return [];
  const { childrenOf } = links(nodes);
  const byId = new Map(objects.children.map((o) => [id(o.props[0]), o]));
  const out = new Set<string>();
  for (const tex of objects.children) {
    if (tex.name !== "Texture") continue;
    const video = (childrenOf.get(id(tex.props[0])) ?? []).map((v) => byId.get(v)).find((v) => v?.name === "Video");
    const content = video ? child(video, "Content")?.props[0] : undefined;
    if ((content instanceof Uint8Array && content.length > 0) || (typeof content === "string" && content.length > 0)) continue;
    const file = String(child(tex, "RelativeFilename")?.props[0] ?? child(tex, "FileName")?.props[0] ?? "");
    if (file) out.add(baseName(file));
  }
  return [...out];
}

function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/=]/g, "");
  const bin = typeof atob === "function" ? atob(clean) : Buffer.from(clean, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Linear interpolation of a curve's keys at `t` (held at the ends). */
function sampleCurve(times: ArrayLike<number>, values: ArrayLike<number>, t: number): number {
  const n = Math.min(times.length, values.length);
  if (n === 0) return 0;
  if (t <= times[0]!) return values[0]!;
  if (t >= times[n - 1]!) return values[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid;
  }
  const f = (t - times[lo]!) / (times[hi]! - times[lo]! || 1);
  return values[lo]! + (values[hi]! - values[lo]!) * f;
}

/**
 * Turn an FBX tree into a mesh (see the module comment): its geometry, and
 * (AAA_PRODUCTION_ROADMAP.md D1) its skin, its animation stacks as clips and
 * its materials' textures.
 *
 * - **Skin.** Each mesh's Skin deformer and its Clusters: the bones they name
 *   (and the LimbNodes between them) become joints, parents first, each at its
 *   rest transform (PreRotation honoured); a root's `base` holds the unit
 *   scale and the nodes above it. Each cluster's TransformLink gives its
 *   joint's inverse bind; each vertex keeps its four strongest weights.
 * - **Animation.** Each AnimationStack is a clip: a bone's Lcl Translation,
 *   Rotation and Scaling curve nodes, sampled at the union of their keys (FBX
 *   time in ticks, from the stack's first key), Euler angles turned to
 *   quaternions kept on one hemisphere.
 * - **Textures.** A material's DiffuseColor, NormalMap and EmissiveColor
 *   textures, embedded (a Video's Content) or among `options.files` by name;
 *   a textured base colour takes a white factor.
 */
export function fbxToMesh(nodes: readonly FbxNode[], name = "fbx", options: FbxImportOptions = {}): MeshAsset {
  const objects = nodes.find((n) => n.name === "Objects");
  if (!objects) throw new Error("FBX without objects.");
  const { parentOf, childrenOf, props: opLinks } = links(nodes);
  const settings = nodes.find((n) => n.name === "GlobalSettings");
  const unit = settings ? Number(property(settings, "UnitScaleFactor")?.[0] ?? 1) : 1;
  const scale = (Number.isFinite(unit) && unit > 0 ? unit : 1) / 100;
  const S: M4 = [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, 1];
  const byId = new Map(objects.children.map((o) => [id(o.props[0]), o]));
  const isModel = (oid: string | undefined) => oid !== undefined && byId.get(oid)?.name === "Model";
  const modelParent = (oid: string) => (parentOf.get(oid) ?? []).find((p) => isModel(p));
  const worldOf = (modelId: string, depth = 0): M4 => {
    const model = byId.get(modelId);
    if (!model || model.name !== "Model" || depth > 64) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const up = modelParent(modelId);
    return up ? multiply(worldOf(up, depth + 1), localMatrix(model)) : localMatrix(model);
  };
  const kids = (oid: string, kind: string, sub?: string) =>
    (childrenOf.get(oid) ?? []).filter((c) => byId.get(c)?.name === kind && (sub === undefined || String(byId.get(c)!.props[2] ?? "") === sub));
  const materialsOf = (modelId: string) => kids(modelId, "Material").map((m) => byId.get(m)!);

  // --- Skin: clusters per geometry, and the joints they name -------------------------------
  interface Cluster { readonly bone: string; readonly indices: ArrayLike<number>; readonly weights: ArrayLike<number>; readonly link: M4 | null }
  const clustersOf = new Map<string, Cluster[]>();
  for (const geometry of objects.children) {
    if (geometry.name !== "Geometry") continue;
    const gid = id(geometry.props[0]);
    const clusters: Cluster[] = [];
    for (const skin of kids(gid, "Deformer", "Skin")) {
      for (const cid of kids(skin, "Deformer", "Cluster")) {
        const cluster = byId.get(cid)!;
        const bone = (childrenOf.get(cid) ?? []).find((b) => isModel(b));
        if (!bone) continue;
        const link = array(child(cluster, "TransformLink"));
        clusters.push({ bone, indices: array(child(cluster, "Indexes")), weights: array(child(cluster, "Weights")), link: link.length === 16 ? Array.from(link) : null });
      }
    }
    if (clusters.length > 0) clustersOf.set(gid, clusters);
  }
  const linkOf = new Map<string, M4>();
  const bones = new Set<string>();
  for (const clusters of clustersOf.values()) for (const c of clusters) {
    bones.add(c.bone);
    if (c.link) linkOf.set(c.bone, c.link);
  }
  // The LimbNodes between named bones complete the hierarchy.
  for (const bone of [...bones]) {
    for (let up = modelParent(bone), guard = 0; up && guard < 64; up = modelParent(up), guard += 1) {
      if (String(byId.get(up)!.props[2] ?? "") === "LimbNode") bones.add(up);
    }
  }
  const depthOf = (oid: string) => {
    let d = 0;
    for (let up = modelParent(oid); up && d < 64; up = modelParent(up)) d += 1;
    return d;
  };
  const jointIds = [...bones].sort((a, b) => depthOf(a) - depthOf(b));
  const jointIndex = new Map(jointIds.map((j, i) => [j, i]));
  let skin: MeshSkin | null = null;
  if (jointIds.length > 0) {
    const inverseBind = new Float32Array(jointIds.length * 16);
    const joints: SkinJoint[] = jointIds.map((jid, i) => {
      const model = byId.get(jid)!;
      let parentModel = modelParent(jid);
      while (parentModel && !jointIndex.has(parentModel) && !isModel(parentModel)) parentModel = modelParent(parentModel);
      const parent = parentModel !== undefined && jointIndex.has(parentModel) ? jointIndex.get(parentModel)! : -1;
      const { t, q, s: sc } = localTRS(model);
      const bind = multiply(S, linkOf.get(jid) ?? worldOf(jid));
      inverseBind.set(invert(bind), i * 16);
      const base = parent < 0 ? multiply(S, parentModel ? worldOf(parentModel) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) : null;
      return {
        name: String(model.props[1] ?? `joint${i}`).split("\u0000")[0]!.replace(/^Model::/, ""),
        parent,
        translation: [t[0]!, t[1]!, t[2]!],
        rotation: q,
        scale: [sc[0]!, sc[1]!, sc[2]!],
        ...(base ? { base } : {}),
      } as SkinJoint;
    });
    skin = { joints, inverseBind };
  }

  // --- Animation stacks as clips -------------------------------------------------------------
  const clips: AnimationClip[] = [];
  if (skin) {
    for (const stack of objects.children) {
      if (stack.name !== "AnimationStack") continue;
      const sid = id(stack.props[0]);
      // Per joint, its T/R/S curve nodes: the node, and its X/Y/Z curves.
      const tracks = new Map<string, Map<string, { node: FbxNode; axes: (FbxNode | null)[] }>>();
      for (const layer of kids(sid, "AnimationLayer")) {
        for (const nid of kids(layer, "AnimationCurveNode")) {
          const target = opLinks.find((l) => l.from === nid && jointIndex.has(l.to));
          if (!target || !/^Lcl (Translation|Rotation|Scaling)$/.test(target.prop)) continue;
          const axes = ["d|X", "d|Y", "d|Z"].map((axis) => {
            const curve = opLinks.find((l) => l.to === nid && l.prop === axis);
            return curve ? (byId.get(curve.from) ?? null) : null;
          });
          if (!tracks.has(target.to)) tracks.set(target.to, new Map());
          tracks.get(target.to)!.set(target.prop, { node: byId.get(nid)!, axes });
        }
      }
      if (tracks.size === 0) continue;
      const seconds = (curve: FbxNode | null) => Array.from(array(child(curve ?? { name: "", props: [], children: [] }, "KeyTime")), (k) => k / FBX_TICKS_PER_SECOND);
      let first = Infinity;
      let last = -Infinity;
      for (const byProp of tracks.values()) for (const tr of byProp.values()) for (const c of tr.axes) for (const k of seconds(c)) {
        first = Math.min(first, k);
        last = Math.max(last, k);
      }
      if (!Number.isFinite(first)) continue;
      const channels: ClipChannel[] = [];
      for (const [jid, byProp] of tracks) {
        const joint = jointIndex.get(jid)!;
        const model = byId.get(jid)!;
        const keyTimes = [...new Set([...byProp.values()].flatMap((tr) => tr.axes.flatMap(seconds)))].sort((a, b) => a - b);
        const valueAt = (prop: string, t: number, rest: readonly number[]): number[] => {
          const tr = byProp.get(prop);
          return [0, 1, 2].map((a) => {
            const curve = tr?.axes[a] ?? null;
            if (!curve) return Number(property(tr?.node ?? model, ["d|X", "d|Y", "d|Z"][a]!)?.[0] ?? rest[a] ?? 0);
            return sampleCurve(seconds(curve), array(child(curve, "KeyValueFloat")), t);
          });
        };
        const rest = localTRS(model);
        const restEuler = (property(model, "Lcl Rotation") ?? [0, 0, 0]).map(Number);
        const times = Float32Array.from(keyTimes, (k) => k - first);
        if (byProp.has("Lcl Translation")) {
          channels.push({ joint, path: "translation", interpolation: "linear", times, values: Float32Array.from(keyTimes.flatMap((k) => valueAt("Lcl Translation", k, rest.t))) });
        }
        if (byProp.has("Lcl Rotation")) {
          const values: number[] = [];
          let prev: Q | null = null;
          for (const k of keyTimes) {
            let q = localTRS(model, { r: valueAt("Lcl Rotation", k, restEuler) }).q;
            if (prev && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
            values.push(...q);
            prev = q;
          }
          channels.push({ joint, path: "rotation", interpolation: "linear", times, values: Float32Array.from(values) });
        }
        if (byProp.has("Lcl Scaling")) {
          channels.push({ joint, path: "scale", interpolation: "linear", times, values: Float32Array.from(keyTimes.flatMap((k) => valueAt("Lcl Scaling", k, rest.s))) });
        }
      }
      const clipName = String(stack.props[1] ?? "clip").split("\u0000")[0]!.replace(/^AnimStack::/, "") || `clip${clips.length}`;
      clips.push({ name: clipName, duration: Math.max(0, last - first), channels });
    }
  }

  // --- Textures -------------------------------------------------------------------------------
  const imageCache = new Map<string, EncodedImage | null>();
  const textureOf = (materialId: string, props: readonly string[]): EncodedImage | null => {
    const tid = opLinks.find((l) => l.to === materialId && props.includes(l.prop) && byId.get(l.from)?.name === "Texture")?.from;
    if (!tid) return null;
    if (imageCache.has(tid)) return imageCache.get(tid)!;
    const tex = byId.get(tid)!;
    const video = (childrenOf.get(tid) ?? []).map((v) => byId.get(v)).find((v) => v?.name === "Video") ?? null;
    const content = video ? child(video, "Content")?.props[0] : undefined;
    let bytes: Uint8Array | null = content instanceof Uint8Array && content.length > 0 ? content : typeof content === "string" && content.length > 0 ? decodeBase64(content) : null;
    if (!bytes) {
      const file = String(child(tex, "RelativeFilename")?.props[0] ?? child(tex, "FileName")?.props[0] ?? (video ? (child(video, "RelativeFilename")?.props[0] ?? "") : ""));
      bytes = file ? (options.files?.get(baseName(file)) ?? null) : null;
    }
    const mime = bytes ? imageMime(bytes) : null;
    const image = bytes && mime ? ({ mime, bytes } as EncodedImage) : null;
    imageCache.set(tid, image);
    return image;
  };

  const primitives: MeshPrimitive[] = [];
  for (const geometry of objects.children) {
    if (geometry.name !== "Geometry" || String(geometry.props[2] ?? "Mesh") !== "Mesh") continue;
    const gid = id(geometry.props[0]);
    const modelId = (parentOf.get(gid) ?? []).find((p) => isModel(p)) ?? "";
    const world = worldOf(modelId);
    const mats = materialsOf(modelId);
    const points = array(child(geometry, "Vertices"));
    const polys = array(child(geometry, "PolygonVertexIndex"));
    const normalLayer = child(geometry, "LayerElementNormal");
    const uvLayer = child(geometry, "LayerElementUV");
    const materialLayer = child(geometry, "LayerElementMaterial");
    const matIndices = array(child(materialLayer ?? { name: "", props: [], children: [] }, "Materials"));
    const matMapping = String(child(materialLayer ?? { name: "", props: [], children: [] }, "MappingInformationType")?.props[0] ?? "AllSame");
    // Each control point's four strongest (joint, weight), normalised.
    const clusters = clustersOf.get(gid) ?? null;
    let influence: Map<number, [number, number][]> | null = null;
    if (clusters && skin) {
      influence = new Map();
      for (const c of clusters) {
        const j = jointIndex.get(c.bone)!;
        for (let k = 0; k < c.indices.length; k += 1) {
          const cp = c.indices[k]!;
          const w = c.weights[k] ?? 0;
          if (!(w > 0)) continue;
          if (!influence.has(cp)) influence.set(cp, []);
          influence.get(cp)!.push([j, w]);
        }
      }
      for (const [cp, list] of influence) {
        list.sort((a, b) => b[1] - a[1]);
        const top = list.slice(0, 4);
        const total = top.reduce((sum, [, w]) => sum + w, 0) || 1;
        influence.set(cp, top.map(([j, w]) => [j, w / total]));
      }
    }
    // One builder a material.
    const builders = new Map<number, { positions: number[]; normals: number[]; uvs: number[]; indices: number[]; joints: number[]; weights: number[] }>();
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
      if (!b) builders.set(mi, (b = { positions: [], normals: [], uvs: [], indices: [], joints: [], weights: [] }));
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
        if (influence) {
          const list = influence.get(cp) ?? [];
          for (let k = 0; k < 4; k += 1) {
            b.joints.push(list[k]?.[0] ?? 0);
            b.weights.push(list[k]?.[1] ?? 0);
          }
        }
      }
      for (let k = 1; k + 1 < corners.length; k += 1) b.indices.push(base, base + k, base + k + 1);
      polygon += 1;
      start = i + 1;
    }
    for (const [mi, b] of builders) {
      const m = mats[mi] ?? null;
      const mid = m ? id(m.props[0]) : "";
      const diffuse = m ? (property(m, "DiffuseColor") ?? property(m, "Diffuse")) : null;
      const colourImage = m ? textureOf(mid, ["DiffuseColor", "Diffuse", "Maya|baseColor", "base_color"]) : null;
      const normalImage = m ? textureOf(mid, ["NormalMap", "Maya|normalCamera"]) : null;
      const emissiveImage = m ? textureOf(mid, ["EmissiveColor", "Emissive"]) : null;
      const colour = colourImage ? [1, 1, 1] : diffuse ? diffuse.slice(0, 3).map(Number) : [0.8, 0.8, 0.8];
      const material: MeshMaterial = {
        name: m ? String(m.props[1] ?? "material").split("\u0000")[0]!.replace(/^Material::/, "") : "default",
        baseColorFactor: [colour[0]!, colour[1]!, colour[2]!, 1],
        baseColorImage: colourImage,
        metallicFactor: 0,
        roughnessFactor: 0.8,
        ...(normalImage ? { normalImage } : {}),
        ...(emissiveImage ? { emissiveImage, emissiveFactor: [1, 1, 1] } : {}),
      } as MeshMaterial;
      primitives.push({
        positions: Float32Array.from(b.positions),
        normals: Float32Array.from(b.normals),
        uvs: uvLayer ? Float32Array.from(b.uvs) : null,
        indices: Uint32Array.from(b.indices),
        material,
        ...(influence ? { joints: Uint16Array.from(b.joints), weights: Float32Array.from(b.weights) } : {}),
      } as unknown as MeshPrimitive);
    }
  }
  if (primitives.length === 0) throw new Error("FBX has no meshes.");
  return { name, primitives, ...(skin ? { skin } : {}), ...(clips.length > 0 ? { clips } : {}) } as MeshAsset;
}

/** Import an FBX file (binary or ASCII) as a mesh, with its skin, clips and textures (D1). */
export async function parseFbx(bytes: Uint8Array, name = "fbx", options: FbxImportOptions = {}): Promise<MeshAsset> {
  const nodes = isBinaryFbx(bytes) ? await parseFbxBinary(bytes) : parseFbxAscii(new TextDecoder().decode(bytes));
  return fbxToMesh(nodes, name, options);
}
