-- Admit the newest engine runtimes to the `titles.runtime` whitelist.
--
-- Three more runtimes shipped after 0015: OpenTyrian (Tyrian 2000, an emscripten
-- SDL2 build), OpenTTD (emscripten SDL2, driven by an emulated cursor) and Cave
-- Story (NXEngine, a GPL clean-room reimplementation). Each is registered in
-- apps/web/src/lib/titleRuntime.ts, and — as 0013/0015 established — a catalog row
-- for a runtime missing from this constraint is silently rejected on a server
-- build, so it could never be listed in Browse. This restates the whole constraint
-- at the current RUNTIME_IDS. "Unit Tests/catalog-titles.test.ts" now reads this
-- migration and asserts it matches RUNTIME_IDS, so the next runtime cannot drift.
--
-- (The Griffon Legend needs no change here: it runs on the existing 'scummvm'
-- runtime, only its ScummVM engine build gained the griffon engine.)

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
  'opentyrian',
  'openttd',
  'cavestory',
  'libretro'
));
