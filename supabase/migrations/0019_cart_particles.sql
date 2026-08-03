-- Particle/weather sidecar for carts (cinematic gap #6).
--
-- A cart can declare a weather system — rain, snow, drifting embers, or rolling
-- fog — which the player composites over each frame host-side off a stateless
-- field (see @cartbox/player's ParticleOverlaySurface / parseParticles; no cart
-- code involved). Like the scene, anim, rig, FX, material and voxel sidecars it
-- cannot live in the frozen .tic, so it rides alongside the cart row as JSON: the
-- editor saves it, and the play route hands it to the player's `particles` mount
-- option. Existing owner-write / public-read policies on carts already cover the
-- column.

alter table carts add column if not exists particles jsonb;
