/**
 * USD and USDZ import (AAA_FIDELITY_ROADMAP.md F9d): Pixar's scene format,
 * the interchange of film pipelines and of Apple's AR Quick Look.
 *
 * What it reads: USDA (the text form), and USDZ packages holding a `.usda`
 * layer (a USDZ is an uncompressed zip; its first USD layer is the stage).
 * Every `def Mesh` prim gives a primitive: its `points`, its polygons
 * (`faceVertexCounts` and `faceVertexIndices`, fan-triangulated), its
 * `normals` and `primvars:st` texture coordinates (per vertex or per face
 * vertex, through `primvars:st:indices` when indexed), and its `displayColor`
 * as the base colour, placed by the `xformOp:translate`, `xformOp:scale` and
 * `xformOp:rotateXYZ` of it and the Xforms it sits in. The stage's
 * `metersPerUnit` and `upAxis = "Z"` are honoured (Y up, in metres, here).
 *
 * The binary crate form (`.usdc`), which most USDZ files from Apple's tools
 * hold, is refused with a message to export USDA; its reader is a project of
 * its own.
 */

import type { MeshAsset, MeshMaterial, MeshPrimitive } from "./MeshAsset";

/** The files in a zip with stored (uncompressed) entries, as USDZ requires. */
export function readStoredZip(bytes: Uint8Array): { name: string; data: Uint8Array }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: { name: string; data: Uint8Array }[] = [];
  let pos = 0;
  while (pos + 30 <= bytes.length && view.getUint32(pos, true) === 0x04034b50) {
    const method = view.getUint16(pos + 8, true);
    const size = view.getUint32(pos + 18, true);
    const nameLength = view.getUint16(pos + 26, true);
    const extraLength = view.getUint16(pos + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(pos + 30, pos + 30 + nameLength));
    const start = pos + 30 + nameLength + extraLength;
    if (method !== 0) throw new Error(`USDZ entry ${name} is compressed; a USDZ's entries must be stored.`);
    out.push({ name, data: bytes.subarray(start, start + size) });
    pos = start + size;
  }
  return out;
}

interface Prim {
  readonly type: string;
  readonly name: string;
  readonly attrs: Map<string, string>;
  readonly children: Prim[];
}

/** Parse USDA's prims (type, name, attributes as raw text, children); the stage's metadata as a root prim. */
export function parseUsda(text: string): Prim {
  if (!text.startsWith("#usda")) throw new Error("Not a USDA layer.");
  const root: Prim = { type: "Stage", name: "", attrs: new Map(), children: [] };
  // The stage metadata in the opening ( … ).
  const meta = /^#usda[^\n]*\n\s*\(([\s\S]*?)\n\)/.exec(text);
  if (meta) {
    for (const m of meta[1]!.matchAll(/(\w+)\s*=\s*("[^"]*"|[^\n]+)/g)) root.attrs.set(m[1]!, m[2]!.trim());
  }
  let pos = meta ? meta.index + meta[0].length : text.indexOf("\n");
  const stack: Prim[] = [root];
  const n = text.length;
  while (pos < n) {
    const def = /^\s*def\s+(\w+)?\s*"([^"]+)"/.exec(text.slice(pos, pos + 200));
    if (def) {
      const prim: Prim = { type: def[1] ?? "", name: def[2]!, attrs: new Map(), children: [] };
      stack[stack.length - 1]!.children.push(prim);
      pos += def[0].length;
      // Skip its metadata ( … ), then enter its body.
      const brace = text.indexOf("{", pos);
      if (brace < 0) break;
      pos = brace + 1;
      stack.push(prim);
      continue;
    }
    const c = text[pos]!;
    if (c === "}") {
      stack.pop();
      pos += 1;
      continue;
    }
    // An attribute: a type, a name, = a value (up to the line's end, or a bracketed list over several).
    const attr = /^\s*(?:uniform\s+|custom\s+)*([\w:[\]]+)\s+([\w:.]+)\s*=\s*/.exec(text.slice(pos, pos + 300));
    if (attr && stack.length > 1) {
      pos += attr[0].length;
      let value: string;
      if (text[pos] === "[" || text[pos] === "(") {
        const open = text[pos]!;
        const close = open === "[" ? "]" : ")";
        let depth = 0;
        const from = pos;
        for (; pos < n; pos += 1) {
          if (text[pos] === open) depth += 1;
          else if (text[pos] === close && (depth -= 1) === 0) break;
        }
        value = text.slice(from, pos + 1);
        pos += 1;
      } else {
        const eol = text.indexOf("\n", pos);
        value = text.slice(pos, eol < 0 ? n : eol).trim();
        pos = eol < 0 ? n : eol;
      }
      stack[stack.length - 1]!.attrs.set(attr[2]!, value);
      // Skip the attribute's own metadata ( interpolation = "faceVarying" ) — kept beside it.
      const metaAfter = /^\s*\(([^)]*)\)/.exec(text.slice(pos, pos + 400));
      if (metaAfter) {
        stack[stack.length - 1]!.attrs.set(`${attr[2]!}#meta`, metaAfter[1]!);
        pos += metaAfter[0].length;
      }
      continue;
    }
    pos = text.indexOf("\n", pos);
    if (pos < 0) break;
    pos += 1;
  }
  return root;
}

const numbers = (s: string | undefined): number[] => (s ? (s.match(/-?[0-9.]+(?:e-?[0-9]+)?/gi) ?? []).map(Number) : []);

type M4 = number[];
const multiply = (a: M4, b: M4): M4 => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) for (let k = 0; k < 4; k += 1) o[c * 4 + r] += a[k * 4 + r]! * b[c * 4 + k]!;
  return o;
};
const IDENTITY: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function primMatrix(prim: Prim): M4 {
  const t = numbers(prim.attrs.get("xformOp:translate"));
  const s = numbers(prim.attrs.get("xformOp:scale"));
  const r = numbers(prim.attrs.get("xformOp:rotateXYZ")).map((d) => (d * Math.PI) / 180);
  let m = IDENTITY;
  if (t.length === 3) m = multiply(m, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0]!, t[1]!, t[2]!, 1]);
  if (r.length === 3) {
    const rx: M4 = [1, 0, 0, 0, 0, Math.cos(r[0]!), Math.sin(r[0]!), 0, 0, -Math.sin(r[0]!), Math.cos(r[0]!), 0, 0, 0, 0, 1];
    const ry: M4 = [Math.cos(r[1]!), 0, -Math.sin(r[1]!), 0, 0, 1, 0, 0, Math.sin(r[1]!), 0, Math.cos(r[1]!), 0, 0, 0, 0, 1];
    const rz: M4 = [Math.cos(r[2]!), Math.sin(r[2]!), 0, 0, -Math.sin(r[2]!), Math.cos(r[2]!), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    m = multiply(m, multiply(rz, multiply(ry, rx)));
  }
  if (s.length === 3) m = multiply(m, [s[0]!, 0, 0, 0, 0, s[1]!, 0, 0, 0, 0, s[2]!, 0, 0, 0, 0, 1]);
  return m;
}

/** A stage's meshes (see the module comment). */
export function usdaToMesh(stage: Prim, name = "usd"): MeshAsset {
  const metersPerUnit = numbers(stage.attrs.get("metersPerUnit"))[0] ?? 0.01;
  const zUp = (stage.attrs.get("upAxis") ?? "").includes("Z");
  // Z up to Y up: (x, y, z) → (x, z, −y).
  let root: M4 = [metersPerUnit, 0, 0, 0, 0, metersPerUnit, 0, 0, 0, 0, metersPerUnit, 0, 0, 0, 0, 1];
  if (zUp) root = multiply(root, [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
  const primitives: MeshPrimitive[] = [];
  const visit = (prim: Prim, parent: M4) => {
    const world = multiply(parent, primMatrix(prim));
    if (prim.type === "Mesh") {
      const points = numbers(prim.attrs.get("points"));
      const counts = numbers(prim.attrs.get("faceVertexCounts"));
      const indices = numbers(prim.attrs.get("faceVertexIndices"));
      const normals = numbers(prim.attrs.get("normals"));
      const normalsFaceVarying = (prim.attrs.get("normals#meta") ?? "").includes("faceVarying") || normals.length === indices.length * 3;
      const st = numbers(prim.attrs.get("primvars:st"));
      const stIndices = numbers(prim.attrs.get("primvars:st:indices"));
      const stFaceVarying = (prim.attrs.get("primvars:st#meta") ?? "").includes("faceVarying") || (stIndices.length === 0 && st.length === indices.length * 2) || stIndices.length === indices.length;
      const colour = numbers(prim.attrs.get("primvars:displayColor"));
      const positions: number[] = [], nrm: number[] = [], uvs: number[] = [], tris: number[] = [];
      let at = 0;
      for (const count of counts) {
        const base = positions.length / 3;
        for (let k = 0; k < count; k += 1) {
          const fv = at + k;
          const v = indices[fv]!;
          const x = points[v * 3]!, y = points[v * 3 + 1]!, z = points[v * 3 + 2]!;
          positions.push(world[0]! * x + world[4]! * y + world[8]! * z + world[12]!, world[1]! * x + world[5]! * y + world[9]! * z + world[13]!, world[2]! * x + world[6]! * y + world[10]! * z + world[14]!);
          if (normals.length > 0) {
            const ni = normalsFaceVarying ? fv : v;
            const a = normals[ni * 3]!, b = normals[ni * 3 + 1]!, c = normals[ni * 3 + 2]!;
            const nx = world[0]! * a + world[4]! * b + world[8]! * c;
            const ny = world[1]! * a + world[5]! * b + world[9]! * c;
            const nz = world[2]! * a + world[6]! * b + world[10]! * c;
            const l = Math.hypot(nx, ny, nz) || 1;
            nrm.push(nx / l, ny / l, nz / l);
          }
          if (st.length > 0) {
            const si = stIndices.length > 0 ? stIndices[stFaceVarying ? fv : v]! : stFaceVarying ? fv : v;
            uvs.push(st[si * 2] ?? 0, st[si * 2 + 1] ?? 0);
          }
        }
        // USD is right-handed with counter-clockwise front faces, as here.
        for (let k = 1; k + 1 < count; k += 1) tris.push(base, base + k, base + k + 1);
        at += count;
      }
      if (tris.length > 0) {
        const material: MeshMaterial = { name: prim.name, baseColorFactor: colour.length >= 3 ? [colour[0]!, colour[1]!, colour[2]!, 1] : [0.8, 0.8, 0.8, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.8 };
        primitives.push({ positions: Float32Array.from(positions), normals: nrm.length > 0 ? Float32Array.from(nrm) : null, uvs: uvs.length > 0 ? Float32Array.from(uvs) : null, indices: Uint32Array.from(tris), material } as unknown as MeshPrimitive);
      }
    }
    for (const c of prim.children) visit(c, world);
  };
  for (const c of stage.children) visit(c, root);
  if (primitives.length === 0) throw new Error("USD stage has no meshes.");
  return { name, primitives } as MeshAsset;
}

/** Import a USDA layer or a USDZ package as a mesh. */
export function parseUsd(bytes: Uint8Array, name = "usd"): MeshAsset {
  const head = new TextDecoder().decode(bytes.subarray(0, 8));
  if (head.startsWith("PXR-USDC")) throw new Error("This is a binary USD (USDC) layer: export it as USDA (text) to import it.");
  if (head.startsWith("#usda")) return usdaToMesh(parseUsda(new TextDecoder().decode(bytes)), name);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const files = readStoredZip(bytes);
    const layer = files.find((f) => /\.usda$/i.test(f.name)) ?? files.find((f) => /\.usd[c]?$/i.test(f.name));
    if (!layer) throw new Error("USDZ holds no USD layer.");
    return parseUsd(layer.data, name);
  }
  throw new Error("Not a USD file.");
}
