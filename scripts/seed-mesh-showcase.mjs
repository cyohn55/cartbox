// Seeds the MESH SHOWCASE cart — a live demo of the 3D mesh runtime (see
// [[mesh-asset-3d-feature]]). Three voxel-derived meshes (a spinning cube, a
// bobbing sphere, a rotating + pulsing pyramid) are placed as a mesh sidecar and
// driven every frame by the cart's own Lua via cartbox.meshcam (orbit camera) and
// cartbox.meshpose (per-instance transforms). The meshes are built here from
// voxel grids through the same voxelGridToMeshAsset the editor's "To mesh" button
// uses, so the whole pipeline — voxels → greedy mesh → sidecar → runtime
// rasteriser → cart-driven animation — is exercised end to end.
//
// Run against a stack's app env (build + seed in one step; imports editor TS via
// the transform loader):
//   node --env-file=apps/web/.env.local \
//        --experimental-transform-types --import "./Unit Tests/registerLightingHooks.mjs" \
//        scripts/seed-mesh-showcase.mjs
// Swap .env.local for .env.production.local to seed prod.

import { createClient } from "@supabase/supabase-js";
import { putCartObject } from "./lib/seedStorage.mjs";

const load = (rel) => import(new URL(rel, import.meta.url).href);
const { VoxelGrid } = await load("../packages/editor/src/model/VoxelGrid.ts");
const { voxelGridToMeshAsset } = await load("../packages/editor/src/model/voxelToMesh.ts");
const { serializeMeshAsset, meshTriangleCount } = await load("../packages/editor/src/model/MeshAsset.ts");
const { buildLuaCart } = await load("../packages/engine/examples/sample-cart.mjs");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

const CART_ID = "00000000-0000-4000-8000-000000000040";

// --- The three shapes, built as voxel grids ------------------------------------

/** A solid cube of one colour. */
function cubeGrid(n, rgb) {
  const grid = new VoxelGrid(n, n, n);
  for (let x = 0; x < n; x += 1) for (let y = 0; y < n; y += 1) for (let z = 0; z < n; z += 1) grid.set(x, y, z, ...rgb);
  return grid;
}

/** A voxel sphere: cells within `radius` of the grid centre. */
function sphereGrid(n, rgb) {
  const grid = new VoxelGrid(n, n, n);
  const c = (n - 1) / 2;
  const r = n / 2;
  for (let x = 0; x < n; x += 1)
    for (let y = 0; y < n; y += 1)
      for (let z = 0; z < n; z += 1)
        if (Math.hypot(x - c, y - c, z - c) <= r) grid.set(x, y, z, ...rgb);
  return grid;
}

/** A stepped pyramid: each layer up is a smaller centred square. */
function pyramidGrid(n, rgb) {
  const grid = new VoxelGrid(n, n, n);
  for (let y = 0; y < n; y += 1) {
    const size = n - y;
    const start = Math.floor((n - size) / 2);
    for (let x = start; x < start + size; x += 1) for (let z = start; z < start + size; z += 1) grid.set(x, y, z, ...rgb);
  }
  return grid;
}

/** Build a sidecar entry from a grid: greedy-meshed, serialized, with a transform. */
function meshEntry(id, name, grid, position) {
  const asset = voxelGridToMeshAsset(grid, { name });
  return {
    entry: {
      id,
      name,
      mesh: serializeMeshAsset(asset),
      transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    tris: meshTriangleCount(asset),
  };
}

const cube = meshEntry("cube", "Cube", cubeGrid(3, [220, 70, 70]), [-5, 0, 0]);
const sphere = meshEntry("sphere", "Sphere", sphereGrid(5, [80, 200, 110]), [0, 0, 0]);
const pyramid = meshEntry("pyramid", "Pyramid", pyramidGrid(5, [90, 130, 235]), [5, 0, 0]);

const MESH_SIDECAR = JSON.stringify({
  version: 1,
  meshes: [cube.entry, sphere.entry, pyramid.entry],
});

// --- The cart: drive the camera + each instance every frame --------------------

const CART_SOURCE = `-- MESH SHOWCASE — the 3D mesh runtime, driven from Lua.
function TIC()
 cls(0)
 local t=time()/1000
 -- Orbit the whole scene slowly; distance 0 auto-fits the three shapes.
 cartbox.meshcam(t*0.35, 0.5, 0)
 -- Animate each placed mesh on top of its authored position.
 cartbox.clearposes()
 cartbox.meshpose(0, 0, 0, 0, t*1.6, 0, 0)                         -- cube: spin
 cartbox.meshpose(1, 0, math.sin(t*2.0)*1.6, 0, 0, 0, 0)          -- sphere: bob
 cartbox.meshpose(2, 0, 0, 0, 0, t*1.3, 0, 1+math.sin(t*3.0)*0.25) -- pyramid: turn + pulse
 print("3D MESH SHOWCASE",64,6,12)
 print("meshcam + meshpose",66,124,14)
end`;

// --- Seed ----------------------------------------------------------------------

// Cart binaries belong in Supabase Storage (publicly served); strip any R2 vars
// so putCartObject never routes the .tic to the object store. The mesh sidecar is
// small and rides inline in the carts.mesh column.
for (const name of ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[name];

const supabase = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

async function main() {
  const { data: profile, error: profileError } = await supabase.from("profiles").select("id").eq("handle", "demo").single();
  if (profileError || !profile) {
    throw new Error(`no demo profile to own the cart: ${profileError?.message ?? "not found"}. Run scripts/seed.mjs first.`);
  }

  // Raw cart bytes — the player injects the cartbox SDK at load, so meshcam/meshpose
  // resolve at runtime without baking the SDK into the stored cartridge.
  const bytes = buildLuaCart(CART_SOURCE);
  const storedKey = await putCartObject(`carts/${CART_ID}.tic`, bytes);

  const { error } = await supabase.from("carts").upsert({
    id: CART_ID,
    owner_id: profile.id,
    title: "3D Mesh Showcase",
    slug: "mesh-showcase",
    description:
      "A live demo of Cartbox's 3D mesh runtime: three voxel-built meshes — a spinning cube, " +
      "a bobbing sphere, and a turning, pulsing pyramid — rasterised over the cart frame and " +
      "driven entirely from the cart's own Lua via cartbox.meshcam (an orbit camera) and " +
      "cartbox.meshpose (per-instance transforms). Import or voxel-derive a mesh, place it, and " +
      "animate it — no engine code required.",
    tags: ["3d", "mesh", "demo", "tech"],
    console_model: "classic",
    price_cents: 0,
    r2_key: storedKey,
    mesh: MESH_SIDECAR,
    published: true,
  });
  if (error) throw new Error(`seeding carts failed: ${error.message}`);

  const totalTris = cube.tris + sphere.tris + pyramid.tris;
  console.log(
    `Seeded 3D MESH SHOWCASE — cube ${cube.tris} + sphere ${sphere.tris} + pyramid ${pyramid.tris} = ${totalTris} tris, ` +
      `sidecar ${(MESH_SIDECAR.length / 1024).toFixed(1)} KB, .tic ${bytes.byteLength} bytes. Play at /play/${CART_ID}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
