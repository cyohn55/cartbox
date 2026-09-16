-- Migration 0026 (N64 + Xbox 360 runtimes), for a one-off paste into the
-- Supabase dashboard SQL editor (Project > SQL Editor > New query > Run).
--
-- Convenience wrapper, not a new migration: it is the content of
-- 0026_n64_xbox360_runtimes.sql, already safe to re-run (the constraint is
-- dropped if present, then restated). Touches no data — it only widens what
-- titles.runtime accepts.
--
-- Until this runs, N64 and Xbox 360 cartridges author and play normally; only
-- publishing one to the catalog fails, and silently — the same trap that hid
-- SuperTux, Quake and Cube 2 from Browse before 0013/0015/0016.

alter table titles drop constraint if exists titles_runtime_check;

alter table titles add constraint titles_runtime_check check (runtime in (
  'cartbox-classic',
  'cartbox-pro',
  'cartbox-portrait',
  'cartbox-ps1',
  'cartbox-n64',
  'cartbox-xbox360',
  'wasm-app',
  'scummvm',
  'supertux',
  'dos',
  'quake',
  'cube2',
  'opentyrian',
  'openttd',
  'cavestory',
  'libretro'
));

-- Verification (read-only, safe to re-run). Expect one row listing both
-- 'cartbox-n64' and 'cartbox-xbox360'.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conname = 'titles_runtime_check';
