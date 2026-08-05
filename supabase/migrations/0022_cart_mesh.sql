-- Triangle-mesh sidecar for carts (true-mesh 3D asset support, Phase 1).
--
-- The Mesh tab imports real polygon meshes (OBJ / glTF-GLB) that the editor
-- previews and the runtime rasterises — geometry the .tic banks cannot hold, so
-- like the voxel, scene, anim and particle sidecars it rides alongside the cart
-- row. The payload is the editor's own mesh sidecar (named mesh assets with a
-- transform each; see lib/meshSidecar.ts), stored as text rather than jsonb: the
-- editor round-trips it as an opaque string and text hands back exactly the bytes
-- that were saved. Owner-authored; existing owner-write / public-read policies on
-- carts already cover the column.

alter table carts add column if not exists mesh text;
