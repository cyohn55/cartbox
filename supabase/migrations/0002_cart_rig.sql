-- Character-rig sidecar for carts.
--
-- The rig is editor-only metadata: multi-plane sprite layering that drives the
-- parallax preview by binding sprite blocks to depths. It cannot live in the
-- frozen .tic, and the published cart runtime does not use it, so it rides
-- alongside the cart row as JSON. Owner-authored; read back only by the editor.
-- Existing owner-write / public-read policies on carts already cover it.

alter table carts add column if not exists rig jsonb;
