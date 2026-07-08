-- Voxel avatar for the handheld console's profile tab.
--
-- Separate from avatar_json (the legacy 2D Mii-style spec used on public web
-- profiles): the console renders a voxel character built in its own creator.
-- Stored as the part/palette spec (see apps/web/src/lib/voxelAvatar.ts), and
-- normalized server-side on write so malformed specs can never persist.

alter table profiles
  add column if not exists voxel_avatar jsonb;
