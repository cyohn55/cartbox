-- Admit the PS1 core to the `titles.runtime` whitelist.
--
-- The PS1 core is built and served (packages/engine/scripts/build-ps1-wasm.sh,
-- apps/web/public/engine/ps1/), so 'ps1' joined SELECTABLE_MODEL_IDS and
-- 'cartbox-ps1' joined RUNTIME_IDS in apps/web/src/lib/titleRuntime.ts.
--
-- As 0013/0015/0016 each established the hard way: a catalog row naming a
-- runtime missing from this constraint is rejected outright on a server build,
-- so the title can never be listed in Browse. The failure is silent — the insert
-- fails, not the page — which is why "Unit Tests/catalog-titles.test.ts" reads
-- this file and asserts it matches RUNTIME_IDS exactly.
--
-- The constraint is restated whole rather than amended, matching 0016, so the
-- current whitelist is readable in one place instead of assembled from a chain
-- of diffs.

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
