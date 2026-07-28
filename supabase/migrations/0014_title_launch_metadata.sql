-- Launch metadata for catalog titles.
--
-- The shared-engine runtimes (DOS via DOSBox, ScummVM) host many games out of
-- one bundle directory, so `bundle_key` alone does not identify a game: DOSBox
-- needs "<zip>:<EXE>" and ScummVM needs its engine target id. The static demo
-- build carries these on each entry (dosTarget / scummvmTarget in
-- apps/web/src/lib/demoTitles.ts), but the table had nowhere to put them — so a
-- server-build catalog row for any DOS or ScummVM title would list in Browse and
-- then fail to boot, having no target to launch.
--
-- Native resolution moves here for the same reason. The API was returning a
-- fixed 320x180 for every title, which is wrong for the DOS titles (320x200) and
-- for anything portrait; the player letterboxes against these numbers.

alter table titles
  -- Launch target within a shared engine bundle. NULL for titles whose bundle is
  -- the game (a Cartbox Game ABI module, SuperTux, Quake, Cube 2).
  add column if not exists launch_target text,
  add column if not exists width  integer not null default 320,
  add column if not exists height integer not null default 180;

alter table titles
  add constraint titles_dimensions_positive check (width > 0 and height > 0);

-- A shared-engine runtime without a launch target is a title that cannot boot.
-- Catching it here keeps the failure at insert time rather than in the player.
alter table titles
  add constraint titles_shared_engine_needs_target check (
    runtime not in ('dos', 'scummvm')
    or asset_source <> 'bundled'
    or launch_target is not null
  );

comment on column titles.launch_target is
  'Game selector inside a shared engine bundle: "<zip>:<EXE>" for dos, the engine target id for scummvm.';
