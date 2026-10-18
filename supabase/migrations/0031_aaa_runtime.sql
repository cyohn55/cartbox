-- Admit the AAA tier to the `titles.runtime` whitelist.
--
-- The AAA tier (AAA_FIDELITY_ROADMAP.md) is Modern's PBR path presented from
-- the GPU, WebGPU-only by design. It joined SELECTABLE_MODEL_IDS as 'aaa' and
-- 'cartbox-aaa' joined RUNTIME_IDS in apps/web/src/lib/titleRuntime.ts.
--
-- As 0013/0015/0016/0025/0026/0027 each established: a catalog row naming a
-- runtime missing from this constraint is rejected on a server build, silently.
-- "Unit Tests/catalog-titles.test.ts" reads this file and asserts it matches
-- RUNTIME_IDS exactly. The constraint is restated whole, so the current
-- whitelist is readable in one place, and the migration is safe to re-run.

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
