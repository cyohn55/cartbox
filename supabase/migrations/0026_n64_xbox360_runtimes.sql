-- Admit the N64 and Xbox 360 cores to the `titles.runtime` whitelist.
--
-- Both cores are built and served (packages/engine/scripts/build-n64-wasm.sh,
-- build-xbox360-wasm.sh; apps/web/public/engine/{n64,xbox360}/), so 'n64' and
-- 'xbox360' joined SELECTABLE_MODEL_IDS and 'cartbox-n64' / 'cartbox-xbox360'
-- joined RUNTIME_IDS in apps/web/src/lib/titleRuntime.ts.
--
-- As 0013/0015/0016/0025 each established the hard way: a catalog row naming a
-- runtime missing from this constraint is rejected outright on a server build,
-- silently — the title just never appears in Browse. "Unit Tests/
-- catalog-titles.test.ts" reads this file and asserts it matches RUNTIME_IDS
-- exactly, so the next runtime cannot drift.
--
-- The constraint is restated whole rather than amended, matching 0016/0025, so
-- the current whitelist is readable in one place.

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
