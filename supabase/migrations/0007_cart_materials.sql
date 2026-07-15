-- Material-swatches sidecar for carts.
--
-- The swatch bindings are editor-only authoring metadata: which normal/height/
-- specular/roughness/emissive a palette colour stamps when painted with the
-- "Material" brush. The painted channel pixels live in the frozen .tic banks;
-- only the per-colour brush bindings ride alongside the cart row as JSON, like
-- the rig and FX sidecars. Owner-authored; read back only by the editor.
-- Existing owner-write / public-read policies on carts already cover it.

alter table carts add column if not exists materials jsonb;
