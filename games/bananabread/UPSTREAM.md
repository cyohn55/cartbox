# BananaBread (vendored Cube 2: Sauerbraten engine)

The `cube2` catalog runtime plays **Cube 2: Sauerbraten** through **BananaBread**,
Mozilla's Emscripten port of the Cube 2 engine to WebAssembly + WebGL. Like the
ScummVM / SuperTux / DOS / Quake runtimes it is a whole in-browser engine that
owns its canvas and loop; `scripts/fetch-cube2.mjs` copies it into
`apps/web/public/cube2/`.

- **Upstream:** https://github.com/kripken/BananaBread (branch `gh-pages`)
- **Pinned commit:** `2d72c7f11f7619e6be83833289122b83f21dc494`
- **License:** zlib (the Cube 2 engine and Sauerbraten game data are both freely
  redistributable — Tier A). This directory is the exact provenance.

## Why vendored (not fetched)

`gh-pages` is a rolling branch, not a tagged release, and the build artefacts
(`bb.wasm`, the `*.data` asset packages) are what actually run — there is no
practical "rebuild from source" step for the web target here. So the minimal
runnable set is vendored for reproducibility, exactly like the C-Dogs runtime.

## Contents

| Path | What it is |
|---|---|
| `cube2/bb.wasm`, `cube2/bb.js` | The compiled engine + its Emscripten glue. |
| `cube2/base.data`, `cube2/character.data`, `cube2/low.data` | Emscripten file packages: maps, textures, models, configs, player model. |
| `cube2/game/*.js`, `cube2/js/*.js` | Loader glue (`preload_*`, `setup_low`, `gl-matrix`, workers). `setup_low.js` defines the default bot match (`effic colos ; addbot`). |
| `cartbox-boot.html` | Cartbox-authored boot page (not upstream): mirrors bb.html's Module + wasm loader, fills the iframe, runs the handheld control binds, and reports lifecycle to the host. |
| `cartbox-bridge.js` | Cartbox console bridge (not upstream): postMessage lifecycle + error surfacing. |

## Controls (handheld)

Sauerbraten is mouse-look only — it has **no keyboard-turn bind** — so the player
turns by synthesizing mouse motion (see `apps/web/src/app/console/Cube2Player.tsx`
and `apps/web/src/lib/cube2Runtime.ts`). d-pad up/down = move, left/right = turn
(synthetic yaw), A = fire, B = jump, X = menu, Y = cycle weapon. The non-default
binds (`F attack`, `Q weapon`) are applied at load via `BananaBread.execute`.
