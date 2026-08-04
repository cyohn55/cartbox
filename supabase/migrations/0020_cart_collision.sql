-- Per-cell collision sidecar for carts.
--
-- The Map tab lets an author mark which map cells are solid (walls, ground); that
-- layer is one boolean per cell, packed, stored on the cart row as JSON (see
-- @cartbox/editor's CollisionMap). Like the rig, FX, material, voxel and scene
-- sidecars it cannot live in the frozen .tic, so it rides alongside the cart row:
-- the editor saves it, and a cart's own logic can read it. Existing owner-write /
-- public-read policies on carts already cover the column.

alter table carts add column if not exists collision jsonb;
