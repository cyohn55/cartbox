-- Bring the `titles.runtime` whitelist back in line with the runtimes the app
-- actually implements.
--
-- 0011 fixed the check constraint at the six runtimes that existed then. Three
-- more shipped since — SuperTux (SDL3), Quake (WebQuake) and Cube 2 (BananaBread)
-- — each registered in apps/web/src/lib/titleRuntime.ts but never added here. The
-- effect was silent and total: a catalog row for any of those three is rejected
-- by the constraint, so the three newest runtimes could not be listed in Browse
-- at all on a server build, no matter what the seed did.
--
-- "Unit Tests/catalog-titles.test.ts" now parses this constraint and asserts it
-- matches RUNTIME_IDS, so the next runtime cannot drift in the same way.

alter table titles drop constraint if exists titles_runtime_check;

alter table titles add constraint titles_runtime_check check (runtime in (
  'cartbox-classic',
  'cartbox-pro',
  'wasm-app',
  'scummvm',
  'supertux',
  'dos',
  'quake',
  'cube2',
  'libretro'
));
