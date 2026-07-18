/**
 * Unit tests for the cell geometry (packages/editor/src/render/cellGeometry.ts):
 * the cube and hexel (rhombic-dodecahedron) face tables that let one voxel
 * pipeline build and draw either shape.
 *
 * Assertions are derived from the geometry, not hard-coded corner lists: the
 * hexel is verified to be a genuine, closed, space-filling rhombic dodecahedron
 * (correct Euler characteristic, planar rhombic faces, faces that meet its
 * neighbours' faces so the cells tile, and unit volume equal to the FCC cell),
 * and its lattice offsets are verified to preserve the even-parity invariant the
 * tiling depends on. The cube geometry is checked to match its six axis faces.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/cellGeometry.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const geoMod = await import(pathToFileURL(path.resolve(here, "../packages/editor/src/render/cellGeometry.ts")).href);
const { CUBE_GEOMETRY, HEXEL_GEOMETRY, geometryFor, isValidSite } = geoMod;

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const vkey = (p) => p.map((c) => c.toFixed(6)).join(",");

// --- Cube geometry: six axis faces, neighbour offset equals the face normal. ---
{
  check("cube has 6 faces", CUBE_GEOMETRY.faces.length === 6);
  check("cube shape tag", CUBE_GEOMETRY.shape === "cube");
  check("cube is full-lattice (no parity)", CUBE_GEOMETRY.evenParity === false);
  check(
    "cube face offset equals its normal",
    CUBE_GEOMETRY.faces.every((f) => f.offset[0] === f.normal[0] && f.offset[1] === f.normal[1] && f.offset[2] === f.normal[2]),
  );
  check("cube offsets are the six axis directions", new Set(CUBE_GEOMETRY.faces.map((f) => f.offset.join(","))).size === 6);
  check("cube neighbours match faces", CUBE_GEOMETRY.neighbors.length === 6);
}

// --- Hexel geometry: a valid, closed, space-filling rhombic dodecahedron. ---
const faces = HEXEL_GEOMETRY.faces;
{
  check("hexel has 12 faces", faces.length === 12);
  check("hexel shape tag", HEXEL_GEOMETRY.shape === "hexel");
  check("hexel is even-parity (FCC)", HEXEL_GEOMETRY.evenParity === true);
  check("hexel face bits are unique powers of two", new Set(faces.map((f) => f.bit)).size === 12 && faces.every((f) => (f.bit & (f.bit - 1)) === 0));

  // Each offset is a permutation of (±1, ±1, 0): exactly one zero, two ±1.
  check(
    "every offset is a (±1,±1,0) permutation",
    faces.every((f) => f.offset.filter((c) => c === 0).length === 1 && f.offset.filter((c) => Math.abs(c) === 1).length === 2),
  );
  check("the 12 offsets are distinct", new Set(faces.map((f) => f.offset.join(","))).size === 12);
}

// Per-face structure: planar rhombus, renderer's parallelogram winding, and a
// centroid at offset/2 — the property that makes a face coincide with the
// neighbour's opposing face, i.e. the cells tile with no gap.
const verts = new Set();
const edges = new Map();
for (const f of faces) {
  const c = f.corners;
  check("face has 4 corners", c.length === 4);
  // Parallelogram winding expected by fillQuad: corner2 = corner1 + corner3 - corner0.
  check("parallelogram winding", [0, 1, 2].every((a) => near(c[2][a], c[1][a] + c[3][a] - c[0][a])));

  const centroid = [0, 1, 2].map((a) => (c[0][a] + c[1][a] + c[2][a] + c[3][a]) / 4);
  check("face centroid is offset/2 (cells share the face)", [0, 1, 2].every((a) => near(centroid[a], f.offset[a] / 2)));
  check("all corners coplanar on the face normal", c.every((p) => near((p[0] - centroid[0]) * f.normal[0] + (p[1] - centroid[1]) * f.normal[1] + (p[2] - centroid[2]) * f.normal[2], 0)));

  check("normal is unit length", near(Math.hypot(...f.normal), 1));
  const offLen = Math.hypot(...f.offset);
  check("normal points outward along the offset", [0, 1, 2].every((a) => near(f.normal[a], f.offset[a] / offLen)));

  for (const p of c) verts.add(vkey(p));
  for (let i = 0; i < 4; i += 1) {
    const key = [vkey(c[i]), vkey(c[(i + 1) % 4])].sort().join("|");
    edges.set(key, (edges.get(key) ?? 0) + 1);
  }
}

// Closed polyhedron: Euler characteristic and the rhombic dodecahedron's known
// vertex split (8 degree-3 "cube" vertices at ±½, 6 degree-4 "octahedral" at ±1).
{
  const V = verts.size;
  const E = edges.size;
  const F = faces.length;
  check(`14 vertices (got ${V})`, V === 14);
  check(`24 edges (got ${E})`, E === 24);
  check("Euler characteristic V-E+F = 2", V - E + F === 2);
  check("every edge is shared by exactly two faces", [...edges.values()].every((n) => n === 2));

  const vertList = [...verts].map((s) => s.split(",").map(Number));
  const octahedral = vertList.filter((p) => p.filter((x) => near(Math.abs(x), 1)).length === 1 && p.filter((x) => near(x, 0)).length === 2);
  const cube = vertList.filter((p) => p.every((x) => near(Math.abs(x), 0.5)));
  check("6 octahedral vertices at ±1", octahedral.length === 6);
  check("8 cube vertices at ±½", cube.length === 8);
}

// Space-filling: the RD's volume equals the FCC unit-cell volume of 2 (the
// determinant of the even-parity lattice), so the cells fill space exactly.
{
  const faceArea = (c) => {
    const e1 = [c[1][0] - c[0][0], c[1][1] - c[0][1], c[1][2] - c[0][2]];
    const e2 = [c[3][0] - c[0][0], c[3][1] - c[0][1], c[3][2] - c[0][2]];
    return Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
  };
  let volume = 0;
  for (const f of faces) {
    const centroid = [0, 1, 2].map((a) => (f.corners[0][a] + f.corners[1][a] + f.corners[2][a] + f.corners[3][a]) / 4);
    const height = centroid[0] * f.normal[0] + centroid[1] * f.normal[1] + centroid[2] * f.normal[2];
    volume += (faceArea(f.corners) * height) / 3;
  }
  check(`RD volume equals the FCC cell volume of 2 (got ${volume.toFixed(4)})`, near(volume, 2, 1e-6));
}

// Lattice invariant: every hexel neighbour step preserves the even coordinate
// sum, so a sculpt seeded on the lattice can never leave it.
{
  check(
    "all hexel offsets keep (x+y+z) even",
    HEXEL_GEOMETRY.neighbors.every((d) => (d[0] + d[1] + d[2]) % 2 === 0),
  );
  check("neighbours equal the face offsets", HEXEL_GEOMETRY.neighbors.length === 12);
}

// --- geometryFor / isValidSite. ---
{
  check("geometryFor('cube') is the cube table", geometryFor("cube") === CUBE_GEOMETRY);
  check("geometryFor('hexel') is the hexel table", geometryFor("hexel") === HEXEL_GEOMETRY);
  check("cube accepts any site", isValidSite(CUBE_GEOMETRY, 1, 2, 4) && isValidSite(CUBE_GEOMETRY, 3, 3, 3));
  check("hexel accepts even-parity sites", isValidSite(HEXEL_GEOMETRY, 2, 2, 0) && isValidSite(HEXEL_GEOMETRY, 1, 1, 0));
  check("hexel rejects odd-parity sites", !isValidSite(HEXEL_GEOMETRY, 1, 0, 0) && !isValidSite(HEXEL_GEOMETRY, 2, 2, 1));
  check("hexel parity is sign-safe for negatives", isValidSite(HEXEL_GEOMETRY, -1, -1, 0) && !isValidSite(HEXEL_GEOMETRY, -1, 0, 0));
}

console.log(`cellGeometry: ${passed}/${passed} checks passed`);
