-- HD-2D world sidecar for carts.
--
-- The World tab authors a height-mapped 3D tile world plus the billboard slots
-- its 2D character sprites occupy. Like the voxel, scene, anim, particle and mesh
-- sidecars it rides alongside the cart row rather than in the .tic banks. The
-- payload is the editor's world model (a small JSON object: grid dimensions,
-- per-cell height + tile sprite, billboard slots, default camera), stored as text
-- so the editor round-trips it as an opaque string. Owner-authored; existing
-- owner-write / public-read policies on carts already cover the column.

alter table carts add column if not exists world text;
