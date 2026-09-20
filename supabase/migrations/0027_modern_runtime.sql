-- Admit the Modern (AAA) tier to the `titles.runtime` whitelist.
--
-- The Modern tier is the top of the console family — an uncapped, PBR/WebGPU
-- path for photoreal-leaning web games, alongside (never replacing) the fantasy
-- tiers. See AAA_TIER_ROADMAP.md. It joined SELECTABLE_MODEL_IDS as 'modern'
-- and 'cartbox-modern' joined RUNTIME_IDS in apps/web/src/lib/titleRuntime.ts.
--
-- As 0013/0015/0016/0025/0026 each established: a catalog row naming a runtime
-- missing from this constraint is rejected on a server build, silently — the
-- title just never appears in Browse. "Unit Tests/catalog-titles.test.ts" reads
-- this file and asserts it matches RUNTIME_IDS exactly, so the next runtime
-- cannot drift. The constraint is restated whole (matching 0016/0025/0026) so
-- the current whitelist is readable in one place.

alter table titles drop constraint if exists titles_runtime_check;

alter table titles add constraint titles_runtime_check check (runtime in (
  'cartbox-classic',
  'cartbox-pro',
  'cartbox-portrait',
  'cartbox-ps1',
  'cartbox-n64',
  'cartbox-xbox360',
  'cartbox-modern',
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
