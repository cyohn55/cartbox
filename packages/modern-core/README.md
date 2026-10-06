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
  string, math and utf8 only), a 2D layer (a 32-bit framebuffer drawn with
  `cls`, `pix`, `rect`, `rectb`, `line`, `circ`, `circb`, `tri` in palette
  colours; `print` hands its text to the host), input (`btn`, `btnp`), a tick
  clock (`time`) and the bridge (`_cbx_cmd`, `_cbx_query`).
- `src/host.js` holds the imports the bridge calls.
- `src/index.ts` wraps it for JavaScript: `createModernCore(factory, options)`.
- `vendor/lua` is Lua 5.4.7 (MIT, see its LICENSE).
- `dist/` is the build, committed like the TIC-80 cores. Run `npm run build`
  with Emscripten 3.1.64 on PATH. The build is reproducible, and CI checks the
  committed one matches (`.github/workflows/build-modern-core.yml`).
