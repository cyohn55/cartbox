-- Migration 0031 (the AAA runtime), for a one-off paste into the Supabase
-- dashboard SQL editor (Project > SQL Editor > New query > Run).
--
-- The content of 0031_aaa_runtime.sql, safe to re-run: the constraint is
-- dropped if present and restated whole.

alter table titles drop constraint if exists titles_runtime_check;

alter table titles add constraint titles_runtime_check check (runtime in (
  'cartbox-classic',
  'cartbox-pro',
  'cartbox-portrait',
  'cartbox-ps1',
  'cartbox-n64',
  'cartbox-xbox360',
  'cartbox-modern',
  'cartbox-aaa',
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
