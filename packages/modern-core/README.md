# @cartbox/modern-core

The dedicated Modern core (ENGINE_PARITY_ROADMAP.md, EP20b): a Lua 5.4 VM with
a **direct scripting API**, compiled to WebAssembly.

The other tiers run carts in a TIC-80–derived core, which reaches the 3D engine
through a command channel in RAM that the host reads after each tick. Here a
cart's calls into the engine *are* calls: `cartbox.command(op, ...)` and
`cartbox.query(op, ...)` cross into the host the moment the cart makes them, so
nothing is capped and a query answers in the same call. The op numbers are the
runtime protocol's, so the same host code (`RuntimeChannel.applyCommands`)
serves both cores.

- `src/core.c` is the core: the Lua VM, sandboxed (base, coroutine, table,
  string, math and utf8 only), the bridge (`_cbx_cmd` and `_cbx_query`), and
  the frame in the HD core's order (input and sound, `BOOT` once, `TIC`,
  `OVR`, then the frame with `SCN`/`BDR`, then its sound). `math.random` is Lua
  5.3's on the C library's generator, as the HD core's, so a seed rolls the
  same numbers on both.
- `src/tic.c` is TIC-80 as a cart sees it, ported from TIC-80 (MIT, see
  `src/TIC80-LICENSE`) at the HD core's spec (8 bits a pixel, 8 sound
  channels):
  - its RAM in the HD core's layout (`peek`/`poke` in 1, 2, 4 and 8 bits,
    `pmem`, `memcpy`, `memset`), so the Lua SDK written for those cores runs
    unchanged;
  - the cartridge's banks (palette, tiles, sprites, map, flags, sfx,
    waveforms, music, screen) and `sync`;
  - the whole 2D API: `cls`, `pix`, `line`, `rect(b)`, `circ(b)`, `elli(b)`,
    `tri(b)`, `ttri` (with depth), `textri`, `paint`, `clip`, `spr`, `map`
    (with remap), `mget`/`mset`, `fget`/`fset`, `print` and `font` in TIC-80's
    fonts (`src/font.h`), the palette mapping, vbanks and screen offsets;
  - input (`btn`, `btnp` with repeat, `key`, `keyp`, `mouse`), `time` (the HD
    core's virtual clock), `reset`, `trace`;
  - sound: TIC-80's sfx and music state machine, register for register. The
    registers are turned into samples by a small mixer of our own (TIC-80's
    is blip_buf, LGPL), so the notes, timing and volumes are TIC-80's and the
    samples differ only by a little filtering.
  The algorithms are TIC-80's, step for step, and a test runs carts on both
  cores and requires the same frame, pixel for pixel, and the same RAM, byte
  for byte, every tick (`Unit Tests/modern-core-parity.test.ts`, Lockout
  included).
- `src/host.js` holds the imports the bridge calls.
- `src/index.ts` wraps it for JavaScript: `createModernCore(factory, options)`,
  or `wrapModernCore(module, options)` for an instantiated module. The player
  presents it as a console (`packages/player/src/directConsole.ts`) for
  Modern-tier scenes that choose it.
- `vendor/lua` is Lua 5.4.7 (MIT, see its LICENSE).
- `dist/` is the build, committed like the TIC-80 cores. Run `npm run build`
  with Emscripten 3.1.64 on PATH. The build is reproducible, and CI checks the
  committed one matches (`.github/workflows/build-modern-core.yml`).
