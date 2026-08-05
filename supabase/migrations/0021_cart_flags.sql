-- Per-cell tile-flags sidecar for carts.
--
-- The Map tab lets an author tag map cells with up to eight gameplay flags
-- (hazard, ladder, one-way platform, water, trigger zones, …) — one byte per
-- cell, stored on the cart row as JSON (see @cartbox/editor's TileFlags). Like
-- the collision sidecar it is gameplay data the cart reads (via cartbox.flag), so
-- it rides alongside the cart row rather than in the frozen .tic. Existing
-- owner-write / public-read policies on carts already cover the column.

alter table carts add column if not exists flags jsonb;
