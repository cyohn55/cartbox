# WebQuake (vendored engine)

The `quake` catalog runtime plays id Software's Quake through **WebQuake**, a
pure-JavaScript WebGL reimplementation of the Quake engine. Unlike the ScummVM /
SuperTux / Doom runtimes there is no Emscripten build: WebQuake is JavaScript
source, so it is vendored here directly and copied into
`apps/web/public/quake/WebQuake/` by `scripts/fetch-quake.mjs`.

- **Upstream:** https://github.com/Triang3l/WebQuake
- **Pinned commit:** `917617ffdfe42fa9dca41bf1762f16a2e71f2d7b` (branch `master`)
- **License:** GPL-2.0 (see `GNU.md`). This vendored tree **is** the corresponding
  source required by the GPL; the pinned commit is the exact provenance.

## Contents

| Path | What it is |
|---|---|
| `WebQuake/*.js` | The engine (36 modules). Copied verbatim from upstream `Client/WebQuake/`. |
| `index.htm` | Upstream launcher page. Kept as the authoritative source of the WebGL shader blocks the engine reads from the DOM; `fetch-quake.mjs` transforms it into `cartbox-boot.html`. |
| `cartbox-bridge.js` | Cartbox-authored console bridge (not upstream): reports load/ready/error to the handheld host by `postMessage`, matching the ScummVM/SuperTux/DOS boot contract. |
| `GNU.md`, `README.md` | Upstream license and readme. |

## Refreshing

To move to a newer WebQuake commit: re-clone upstream, copy `Client/WebQuake/*.js`
and `Client/index.htm` over the files here, update the pinned commit above, and
re-run `node scripts/fetch-quake.mjs`. Diff `index.htm` first — if the shader
blocks changed, the boot-page transform still works (it only injects), but verify
the game still boots.

## Game data

The engine ships no game data. `fetch-quake.mjs` fetches id's freely
redistributable **Quake shareware** (episode 1) and extracts `id1/pak0.pak` from
it — see that script and the catalog row in `apps/web/src/lib/demoTitles.ts` for
the licensing basis. The shareware license text is written next to the data so it
"accompanies the Software at all times" as that license requires.
