/**
 * Parametric shapes (EDITOR_PRO_ROADMAP.md P5), Blueprint-lite: a scene object
 * can be a generator and its parameters — an arch's span and height, a
 * flight's steps — rather than fixed triangles, and changing a parameter
 * builds it again. Each shape is a closed solid (built from CSG brushes, see
 * csg.ts), so shapes can be cut and joined in turn, and collide as solids.
 *
 * The stone and Forerunner kit is a set of these with materials from the
 * texture generators (P1c), projected triplanar so a piece of any size keeps
 * the same texel density.
 *
 * Pure and DOM-free.
 */

import { boxSolid, csg, cylinderSolid, solidFromFaces, wedgeSolid } from "./csg";
import { withGeneratedMaps, type MeshAsset, type MeshMaterial } from "./MeshAsset";

export type ParametricKind = "slab" | "stairs" | "ramp" | "arch" | "pillar" | "wall";

export interface ParametricParam {
  readonly key: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
}

/** A scene object's shape: which generator, and its parameters. */
export interface ParametricShape {
  readonly kind: ParametricKind;
  readonly params: Readonly<Record<string, number>>;
}

const translate = (x: number, y: number, z: number): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
/** Turn a solid standing on Y to lie along Z (a quarter turn about X), and move it. */
const alongZ = (x: number, y: number, z: number): number[] => [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, x, y, z, 1];

const p = (key: string, label: string, min: number, max: number, step: number, value: number): ParametricParam => ({ key, label, min, max, step, value });

/** Each generator: its label, its parameters (with their defaults), and how it builds. Every shape sits on y = 0, centred on x and z. */
export const PARAMETRIC_SHAPES: Readonly<Record<ParametricKind, { readonly label: string; readonly params: readonly ParametricParam[]; readonly build: (v: Readonly<Record<string, number>>, material: MeshMaterial) => MeshAsset }>> = {
  slab: {
    label: "Slab",
    params: [p("width", "Width", 0.1, 50, 0.1, 4), p("height", "Height", 0.05, 20, 0.05, 0.4), p("depth", "Depth", 0.1, 50, 0.1, 4)],
    build: (v, m) => move(boxSolid([v.width!, v.height!, v.depth!], m), 0, v.height! / 2, 0),
  },
  stairs: {
    label: "Stairs",
    params: [p("width", "Width", 0.5, 20, 0.1, 2), p("height", "Rise", 0.2, 20, 0.05, 1.8), p("depth", "Run", 0.3, 40, 0.1, 3), p("steps", "Steps", 1, 32, 1, 9)],
    build: (v, m) => {
      const steps = Math.max(1, Math.round(v.steps!));
      const w = v.width! / 2, tread = v.depth! / steps, riser = v.height! / steps;
      const z0 = -v.depth! / 2, z1 = v.depth! / 2;
      type F = { points: [number, number, number][]; out: [number, number, number] };
      // The flight climbs toward +Z: its faces, each facing out.
      const faces: F[] = [
        { points: [[-w, 0, z0], [w, 0, z0], [w, 0, z1], [-w, 0, z1]], out: [0, -1, 0] },
        { points: [[-w, 0, z1], [w, 0, z1], [w, v.height!, z1], [-w, v.height!, z1]], out: [0, 0, 1] },
      ];
      for (let k = 0; k < steps; k += 1) {
        const za = z0 + tread * k, zb = za + tread, y0 = riser * k, y1 = riser * (k + 1);
        faces.push({ points: [[-w, y0, za], [w, y0, za], [w, y1, za], [-w, y1, za]], out: [0, 0, -1] }); // the riser
        faces.push({ points: [[-w, y1, za], [w, y1, za], [w, y1, zb], [-w, y1, zb]], out: [0, 1, 0] }); // the tread
        for (const x of [-w, w]) faces.push({ points: [[x, 0, za], [x, 0, zb], [x, y1, zb], [x, y1, za]], out: [Math.sign(x), 0, 0] }); // a column of each side
      }
      return { ...solidFromFaces("stairs", m, faces), name: "stairs" };
    },
  },
  ramp: {
    label: "Ramp",
    params: [p("width", "Width", 0.5, 30, 0.1, 3), p("height", "Rise", 0.1, 20, 0.05, 1.5), p("depth", "Length", 0.5, 60, 0.1, 6)],
    build: (v, m) => {
      // A wedge rises toward −X; turned so the ramp climbs toward +Z.
      const w = wedgeSolid([v.depth!, v.height!, v.width!], m);
      return { ...transformMesh(w, [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, v.height! / 2, 0, 1]), name: "ramp" };
    },
  },
  arch: {
    label: "Arch",
    params: [p("span", "Span", 0.5, 30, 0.1, 3), p("height", "Height", 1, 30, 0.1, 4.5), p("thickness", "Piers", 0.2, 10, 0.1, 0.8), p("depth", "Depth", 0.2, 20, 0.1, 1.2), p("sides", "Smoothness", 6, 48, 2, 24)],
    build: (v, m) => {
      // The crown over the opening is at least 30 cm, and the jambs at least 30 cm tall.
      const crown = Math.max(0.3, Math.min(0.6, v.height! * 0.15));
      const span = v.span!, height = Math.max(v.height!, span / 2 + crown + 0.3), depth = v.depth!;
      const outer = boxSolid([span + 2 * v.thickness!, height, depth], m);
      // The opening: straight jambs up to the springing line, then a round head.
      const spring = height - span / 2 - crown;
      const jambs = boxSolid([span, spring + 0.02, depth + 0.4], m);
      const head = cylinderSolid([span, depth + 0.4, span], Math.round(v.sides!), m);
      let solid = csg(outer, jambs, "subtract", { bModel: translate(0, -height / 2 + spring / 2 - 0.01, 0) });
      solid = csg(solid, head, "subtract", { bModel: alongZ(0, -height / 2 + spring, 0) });
      return { ...move(solid, 0, height / 2, 0), name: "arch" };
    },
  },
  pillar: {
    label: "Pillar",
    params: [p("radius", "Radius", 0.1, 5, 0.05, 0.4), p("height", "Height", 0.5, 30, 0.1, 4), p("sides", "Sides", 4, 32, 1, 12), p("plinth", "Base and capital", 0, 2, 0.05, 0.25)],
    build: (v, m) => {
      const r = v.radius!, h = v.height!, t = Math.min(v.plinth!, h / 3);
      const shaft = cylinderSolid([r * 2, t > 0 ? h - t : h, r * 2], Math.round(v.sides!), m);
      if (!(t > 0)) return { ...move(shaft, 0, h / 2, 0), name: "pillar" };
      // Base and capital first (apart, so they join trivially), then the shaft through both, its ends inside them.
      const block = r * 2 + t * 1.5;
      const ends = csg(move(boxSolid([block, t, block], m), 0, t / 2, 0), boxSolid([block, t, block], m), "union", { bModel: translate(0, h - t / 2, 0) });
      const solid = csg(ends, shaft, "union", { bModel: translate(0, h / 2, 0) });
      return { ...solid, name: "pillar" };
    },
  },
  wall: {
    label: "Wall",
    params: [
      p("width", "Width", 0.5, 60, 0.1, 6),
      p("height", "Height", 0.5, 30, 0.1, 3.4),
      p("thickness", "Thickness", 0.05, 5, 0.05, 0.4),
      p("door", "Doorway width", 0, 20, 0.1, 1.6),
      p("doorHeight", "Doorway height", 0.5, 20, 0.1, 2.4),
      p("window", "Window width", 0, 20, 0.1, 0),
    ],
    build: (v, m) => {
      const w = v.width!, h = v.height!, t = v.thickness!;
      let solid = move(boxSolid([w, h, t], m), 0, h / 2, 0);
      const door = Math.min(v.door!, w - 0.2);
      if (door > 0.05) {
        const dh = Math.min(v.doorHeight!, h - 0.1);
        solid = csg(solid, boxSolid([door, dh + 0.02, t + 0.4], m), "subtract", { bModel: translate(0, dh / 2 - 0.01, 0) });
      }
      const window = Math.min(v.window!, (w - door) / 2 - 0.4);
      if (window > 0.05) {
        const x = door > 0.05 ? (door / 2 + (w / 2 - door / 2) / 2) : 0;
        const wh = Math.min(window, h * 0.35);
        solid = csg(solid, boxSolid([window, wh, t + 0.4], m), "subtract", { bModel: translate(x, h * 0.62, 0) });
      }
      return { ...solid, name: "wall" };
    },
  },
};

export const PARAMETRIC_KINDS = Object.keys(PARAMETRIC_SHAPES) as ParametricKind[];

/** Read a stored shape defensively: a known kind, each parameter its default when missing, clamped to its range. */
export function readParametric(value: unknown): ParametricShape | null {
  const r = value as { kind?: unknown; params?: unknown } | null;
  if (!r || typeof r !== "object" || typeof r.kind !== "string" || !(r.kind in PARAMETRIC_SHAPES)) return null;
  const kind = r.kind as ParametricKind;
  const raw = (r.params && typeof r.params === "object" ? r.params : {}) as Record<string, unknown>;
  const params: Record<string, number> = {};
  for (const q of PARAMETRIC_SHAPES[kind].params) {
    const v = raw[q.key];
    params[q.key] = typeof v === "number" && Number.isFinite(v) ? Math.max(q.min, Math.min(q.max, v)) : q.value;
  }
  return { kind, params };
}

/** A shape with every parameter at its default. */
export function defaultParametric(kind: ParametricKind): ParametricShape {
  return { kind, params: Object.fromEntries(PARAMETRIC_SHAPES[kind].params.map((q) => [q.key, q.value])) };
}

const PLAIN: MeshMaterial = { name: "shape", baseColorFactor: [0.66, 0.66, 0.68, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.85 };

/** Build a shape (its parameters read defensively), in `material` (a plain grey by default). */
export function buildParametric(spec: ParametricShape, material: MeshMaterial = PLAIN): MeshAsset {
  const read = readParametric(spec) ?? defaultParametric("slab");
  return PARAMETRIC_SHAPES[read.kind].build(read.params, material);
}

/**
 * Build a shape again after its parameters change, keeping the materials the
 * creator gave its parts (the first part's material carries over to every
 * part of the new build when the count changed).
 */
export function rebuildParametric(spec: ParametricShape, previous: MeshAsset | null): MeshAsset {
  const material = previous?.primitives[0]?.material;
  const built = buildParametric(spec, material);
  if (!previous || previous.primitives.length !== built.primitives.length) return built;
  return { ...built, primitives: built.primitives.map((prim, k) => ({ ...prim, material: previous.primitives[k]!.material })) };
}

// --- The stone and Forerunner kit --------------------------------------------------------

export type KitStyle = "stone" | "forerunner";

/** A kit style's material: a texture generator (P1c), projected triplanar every `repeat` metres. */
export function kitMaterial(style: KitStyle): MeshMaterial {
  return withGeneratedMaps(
    style === "stone"
      ? { name: "kit-stone", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 1, roughnessFactor: 1, generator: { kind: "stone", seed: 3, scale: 1, tint: [0.92, 0.88, 0.82], size: 256 }, triplanar: 2.5, macro: { scale: 6, strength: 0.15 } }
      : { name: "kit-forerunner", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 1, roughnessFactor: 1, generator: { kind: "forerunner", seed: 5, scale: 1, tint: [0.88, 0.9, 0.95], size: 256 }, triplanar: 3, clearcoat: 0.3 },
  );
}

/** One kit piece: a named shape in a style. */
export interface KitPiece {
  readonly id: string;
  readonly label: string;
  readonly style: KitStyle;
  readonly shape: ParametricShape;
}

const piece = (id: string, label: string, style: KitStyle, kind: ParametricKind, params: Record<string, number> = {}): KitPiece => ({ id, label, style, shape: { kind, params: { ...defaultParametric(kind).params, ...params } } });

/** The kit: stone for the canyon's bases, bridges and steps; Forerunner for its tech pieces. */
export const KIT_PIECES: readonly KitPiece[] = [
  piece("stone-slab", "Stone slab", "stone", "slab", { width: 4, height: 0.4, depth: 4 }),
  piece("stone-block", "Stone block", "stone", "slab", { width: 2, height: 1, depth: 1 }),
  piece("stone-wall", "Stone wall with doorway", "stone", "wall"),
  piece("stone-arch", "Stone arch", "stone", "arch"),
  piece("stone-bridge", "Stone bridge arch", "stone", "arch", { span: 6, height: 4, thickness: 1.2, depth: 3 }),
  piece("stone-stairs", "Stone stairs", "stone", "stairs"),
  piece("stone-ramp", "Stone ramp", "stone", "ramp"),
  piece("stone-column", "Stone column", "stone", "pillar", { radius: 0.45, sides: 10, plinth: 0.3 }),
  piece("fore-panel", "Forerunner panel", "forerunner", "slab", { width: 4, height: 3, depth: 0.3 }),
  piece("fore-trim", "Forerunner trim", "forerunner", "slab", { width: 4, height: 0.25, depth: 0.5 }),
  piece("fore-pillar", "Forerunner pillar", "forerunner", "pillar", { radius: 0.35, sides: 6, plinth: 0.2 }),
  piece("fore-gate", "Forerunner gateway", "forerunner", "wall", { width: 6, height: 4, thickness: 0.6, door: 2.4, doorHeight: 3 }),
];

/** Build a kit piece in its style. */
export function buildKitPiece(kit: KitPiece): MeshAsset {
  return { ...buildParametric(kit.shape, kitMaterial(kit.style)), name: kit.label };
}

// --- Helpers -----------------------------------------------------------------------------

function move(mesh: MeshAsset, x: number, y: number, z: number): MeshAsset {
  return transformMesh(mesh, translate(x, y, z));
}

/** A mesh with a rigid transform (rotation and translation; normals turned by the rotation) applied. */
function transformMesh(mesh: MeshAsset, m: readonly number[]): MeshAsset {
  return {
    ...mesh,
    primitives: mesh.primitives.map((prim) => {
      const positions = new Float32Array(prim.positions.length);
      const normals = prim.normals ? new Float32Array(prim.normals.length) : null;
      for (let i = 0; i < prim.positions.length; i += 3) {
        const x = prim.positions[i]!, y = prim.positions[i + 1]!, z = prim.positions[i + 2]!;
        positions[i] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
        positions[i + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
        positions[i + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
        if (normals && prim.normals) {
          const nx = prim.normals[i]!, ny = prim.normals[i + 1]!, nz = prim.normals[i + 2]!;
          normals[i] = m[0]! * nx + m[4]! * ny + m[8]! * nz;
          normals[i + 1] = m[1]! * nx + m[5]! * ny + m[9]! * nz;
          normals[i + 2] = m[2]! * nx + m[6]! * ny + m[10]! * nz;
        }
      }
      return { ...prim, positions, normals };
    }),
  };
}
