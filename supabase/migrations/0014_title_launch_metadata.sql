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
--
-- NOT VALID, deliberately: a database that already holds bundled DOS/ScummVM
-- rows has exactly the rows this rule forbids, and a plain ADD CONSTRAINT would
-- refuse to install at all rather than install and flag them — failing the
-- migration on the databases that need it most. NOT VALID enforces the rule on
-- every future insert and update while tolerating what predates it; the block
-- below promotes it to fully validated as soon as nothing violates it, so a
-- fresh database ends up with an ordinary validated constraint and a populated
-- one self-heals after scripts/seed-titles.mjs fills the targets in.
alter table titles
  add constraint titles_shared_engine_needs_target check (
    runtime not in ('dos', 'scummvm')
    or asset_source <> 'bundled'
    or launch_target is not null
  ) not valid;

do $$
declare
  unbootable integer;
begin
  select count(*) into unbootable
  from titles
  where runtime in ('dos', 'scummvm')
    and asset_source = 'bundled'
    and launch_target is null;

  if unbootable = 0 then
    alter table titles validate constraint titles_shared_engine_needs_target;
  else
    raise notice
      'titles_shared_engine_needs_target left NOT VALID: % existing title(s) name no game to launch. Enforced for new and updated rows; seed the catalog and re-run to validate.',
      unbootable;
  end if;
end $$;

comment on column titles.launch_target is
  'Game selector inside a shared engine bundle: "<zip>:<EXE>" for dos, the engine target id for scummvm.';
