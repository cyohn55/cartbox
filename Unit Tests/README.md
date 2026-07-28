# Unit Tests

Everything that tests this repo lives here. Two runners share the folder, split
by extension rather than by subject:

- **`*.test.ts` — vitest.** `npx vitest run` from the repo root. `vitest.config.ts`
  collects `Unit Tests/**/*.test.ts` and aliases `@cartbox/player`,
  `@cartbox/editor` and the web app's `@/…` to source, so tests import the same
  specifiers the app does and need no build step.
- **`*.test.mjs` — node's own runner**, from before the vitest suite existed:
  `node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/<file>"`.
  Each file's header repeats its own command. `registerTsHooks.mjs`,
  `tsResolveHooks.mjs`, `lightingResolveHooks.mjs` and `registerLightingHooks.mjs`
  are those hooks, not tests. Vitest does not collect these.

The `.ts` suite used to sit two levels above the repository, outside it, which
meant none of it was version-controlled — a clone got the code and no tests for
it. It moved in on 2026-07-28; relative imports lost the `../Working/tic80-console/`
prefix they carried to reach back down.

## Four tests reach outside the repository

`gotta-catch-em-all`, `gotta-catch-pro`, `neon-city-cart` and `lightingCore` assert
against sibling cart projects in `Working/`, which are not part of this repo, so
they resolve through `../../`. On a clean clone the first two **skip** with a
warning (they already guard on the artefact existing); `neon-city-cart` imports its
build harness statically and will fail to collect; `lightingCore` is `.mjs` and is
not collected by vitest at all. Either vendor those carts here or guard the
imports before treating a clean-clone run as green.
