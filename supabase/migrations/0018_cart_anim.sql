-- Animation-timeline sidecar for carts (cinematic gap #1).
--
-- A cart can declare ambient motion — sprite-frame clips as foreground placements
-- plus keyframed tracks driving scene-layer channels, post-FX values, and
-- placement transforms — which the player plays back host-side off the frame clock
-- (see @cartbox/player's AnimatedForegroundSurface / parseAnim; no cart code
-- involved). Like the scene, rig, FX, material and voxel sidecars it cannot live in
-- the frozen .tic, so it rides alongside the cart row as JSON: the editor saves it,
-- and the play route hands it to the player's `anim` mount option. Existing
-- owner-write / public-read policies on carts already cover the column.

alter table carts add column if not exists anim jsonb;
