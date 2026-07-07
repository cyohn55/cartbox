-- Post-processing FX sidecar for carts.
--
-- The FX stack (fog, bloom, CRT, …) is authored in the editor's FX tab and
-- applied by the player at runtime. Like the rig, it cannot live in the frozen
-- .tic, so it rides alongside the cart row as JSON: the editor saves it, and
-- the play/playtest routes hand it to @cartbox/player's PostFxSurface.
-- Existing owner-write / public-read policies on carts already cover it.

alter table carts add column if not exists fx jsonb;
