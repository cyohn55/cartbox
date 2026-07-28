-- Admit the portrait Cartbox core to the `titles.runtime` whitelist.
--
-- The 360x640 portrait model runs on its own core binary, so it gets its own
-- runtime id ('cartbox-portrait') rather than sharing Pro's. 0013 restated this
-- constraint and "Unit Tests/catalog-titles.test.ts" asserts it matches
-- RUNTIME_IDS, so adding the runtime in TypeScript requires this migration in
-- the same change — which is the drift guard working as intended.

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
