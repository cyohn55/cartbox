-- Handheld console skin chosen during onboarding.
--
-- Stored as { presetId, scheme } where scheme is the seven region hex colours
-- (see apps/web/src/lib/... and packages/editor/src/model/handheldSkin.ts). The
-- appearance is derived at render time from the shared base + region mask + these
-- colours, so only the colours (not an image) live here. Normalized server-side
-- on write so a malformed skin can never persist. Mirrors voxel_avatar.
alter table profiles
  add column if not exists handheld jsonb;
