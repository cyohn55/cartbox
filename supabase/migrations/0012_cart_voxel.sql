-- Voxel-sculpt sidecar for carts.
--
-- The Voxel tab authors a 3D sculpt that has nowhere to live in the .tic banks,
-- so — like the rig, FX and material sidecars — it rides alongside the cart row.
-- The payload is the editor's own serialized voxel grid, optionally wrapped with
-- the sprite materials that skin it (see lib/voxelSidecar.ts). It is stored as
-- text rather than jsonb: the editor round-trips it as an opaque string, and text
-- hands back exactly the bytes that were saved. Owner-authored; existing
-- owner-write / public-read policies on carts already cover it.

alter table carts add column if not exists voxel text;
