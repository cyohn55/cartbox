-- Parallax-scene sidecar for carts.
--
-- A cart can declare a backdrop of depth layers (regions of its own sprite sheet)
-- plus an aerial-perspective atmosphere; the player composites them behind the
-- cart's interactive foreground at runtime (see @cartbox/player's
-- SceneBackdropSurface / parseScene). Like the rig, FX, material and voxel
-- sidecars it cannot live in the frozen .tic, so it rides alongside the cart row
-- as JSON: the editor saves it, and the play route hands it to the player's
-- `scene` mount option. Existing owner-write / public-read policies on carts
-- already cover the column.

alter table carts add column if not exists scene jsonb;
