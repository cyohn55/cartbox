-- Migration 0025 (PS1 runtime), for a one-off paste into the Supabase dashboard
-- SQL editor (Project > SQL Editor > New query > Run).
--
-- This is a convenience wrapper, not a new migration: it is the content of
-- 0025_ps1_runtime.sql, and it is already safe to re-run — the constraint is
-- dropped if present and then restated, so hitting Run twice is a no-op rather
-- than an error.
--
-- Nothing here touches data. It widens what `titles.runtime` will accept; no
-- existing row changes and no existing value stops being valid.
--
-- Why it matters: 'cartbox-ps1' is now a runtime the app can dispatch to, and a
-- catalog row naming a runtime this constraint does not list is rejected
-- outright on insert. The failure is silent from the outside — the title simply
-- never appears in Browse — which is how the same omission hid SuperTux, Quake
-- and Cube 2 once before (see 0013/0015/0016).
--
-- Until this runs, PS1 cartridges still author and play fine. Only publishing
-- one to the catalog would fail.

alter table titles drop constraint if exists titles_runtime_check;

alter table titles add constraint titles_runtime_check check (runtime in (
  'cartbox-classic',
  'cartbox-pro',
  'cartbox-portrait',
  'cartbox-ps1',
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

-- ---------------------------------------------------------------------------
-- Verification (read-only, safe to re-run on its own).
-- Expect one row, whose definition lists 'cartbox-ps1'.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'titles'::regclass
  and conname = 'titles_runtime_check';
