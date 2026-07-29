-- Migrations 0013 + 0014 + 0015, combined for a one-off paste into the Supabase
-- dashboard SQL editor (Project > SQL Editor > New query > Run).
--
-- This is a convenience wrapper, not a new migration: it is the content of
-- 0013_title_runtimes.sql, 0014_title_launch_metadata.sql and
-- 0015_portrait_runtime.sql, made safe to run against a database that already
-- holds catalog rows. Re-running it is a no-op rather than an error, which
-- matters because the dashboard makes it easy to hit Run twice.
--
-- Order of business:
--   1. add the launch metadata columns
--   2. put the runtime whitelist in its final (0015) shape
--   3. add the shared-engine constraint WITHOUT rejecting legacy rows
--
-- Step 3 is the subtle one. A bundled DOS or ScummVM title with no launch_target
-- cannot boot, so the constraint is right — but a plain ADD CONSTRAINT would
-- refuse to install at all while such rows exist, taking the rest of the
-- migration down with it. Adding it NOT VALID enforces the rule on every future
-- insert and update while tolerating rows that predate it, then the script tries
-- to validate: seed the catalog (scripts/seed-titles.mjs fills every target) and
-- run this again, and the second pass validates cleanly.

begin;

-- --- 1. Launch metadata (0014) ---------------------------------------------

alter table titles
  add column if not exists launch_target text,
  add column if not exists width  integer not null default 320,
  add column if not exists height integer not null default 180;

comment on column titles.launch_target is
  'Game selector inside a shared engine bundle: "<zip>:<EXE>" for dos, the engine target id for scummvm.';

alter table titles drop constraint if exists titles_dimensions_positive;
alter table titles add constraint titles_dimensions_positive check (width > 0 and height > 0);

-- --- 2. Runtime whitelist (0013, superseded by 0015) ------------------------
-- 0015 restates the whole list and adds cartbox-portrait, so the final shape is
-- applied once rather than in two steps.

alter table titles drop constraint if exists titles_runtime_check;
alter table titles add constraint titles_runtime_check check (runtime in (
  'cartbox-classic',
  'cartbox-pro',
  'cartbox-portrait',
  'wasm-app',
  'scummvm',
  'supertux',
  'dos',
  'quake',
  'cube2',
  'libretro'
));

-- --- 3. Shared-engine launch target (0014) ----------------------------------

alter table titles drop constraint if exists titles_shared_engine_needs_target;
alter table titles add constraint titles_shared_engine_needs_target check (
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
    raise notice 'shared-engine constraint validated: every bundled DOS/ScummVM title names a target.';
  else
    raise notice 'shared-engine constraint left NOT VALID: % existing title(s) have no launch_target. It is already enforced for new and updated rows. Run scripts/seed-titles.mjs to fill them in, then run this script again to validate.', unbootable;
  end if;
end $$;

commit;

-- --- What the database looks like now ---------------------------------------

select
  (select count(*) from titles)                                       as titles_rows,
  (select count(*) from titles where published)                       as published_rows,
  (select count(*) from information_schema.columns
     where table_name = 'titles'
       and column_name in ('launch_target', 'width', 'height'))       as new_columns_present,
  (select convalidated from pg_constraint
     where conrelid = 'titles'::regclass
       and conname = 'titles_shared_engine_needs_target')             as target_rule_validated;
