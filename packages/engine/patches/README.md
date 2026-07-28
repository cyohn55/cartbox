# Engine overlays (patches to the vendored TIC-80)

The vendored TIC-80 lives at `../tic80` and is **gitignored**, so local edits to
its source are captured here as patches (see `../README.md` "Upstream hygiene").
The shipped runtime is the built `../dist` artifacts; these patches let anyone
reproduce them from a fresh submodule checkout.

## cartbox-material-gbuffer.patch

Adds the Cartbox **material G-buffer** to the core so the web player can relight
carts with authored per-pixel material (normal / height / specular / roughness /
emissive). Touches `src/core/draw.c` (blit + textured-triangle capture, cls-driven
matte reset) and `src/core/core.c` (tracks the tile bank resident in RAM so
capture is skipped for foreign-bank syncs). Pairs with `../shim.c`
(`cbx_material_ptr` / `cbx_emissive_ptr` / `cbx_set_material_capture`).

## cartbox-model-specs.patch

Makes the **fixed spec overridable at build time** so one source tree can compile
every console model. Guards the display constants in `include/tic80.h`, the
memory-map and palette/sound constants in `src/tic.h`, and widens what those
sizes ripple into (`src/core/sound.c`, `src/tilesheet.c`, `src/tools.{c,h}` — the
music-track pattern packing needs u64 at 8 channels). Every change is
`#ifndef`-guarded, so a build with no `-D` compiles to the exact upstream values
and the classic core stays byte-for-byte stock.

`TIC80_FULLHEIGHT` is guarded here too, which is what makes a **portrait** model
possible at all: upstream derives the overscan buffer's height from its width at
16:9, so a 360-wide screen would get a 288-line buffer and render nothing below
that line — not a build error, just a frame that stops two-thirds of the way
down.

Apply both after fetching the submodule, then rebuild:

```bash
git -C packages/engine/tic80 apply packages/engine/patches/cartbox-model-specs.patch
git -C packages/engine/tic80 apply packages/engine/patches/cartbox-material-gbuffer.patch
npm run engine:build:wasm        # classic  -> dist/tic80.{js,wasm}
npm run engine:build:pro         # pro      -> dist/pro/engine.{js,wasm}
npm run engine:build:portrait    # portrait -> dist/portrait/engine.{js,wasm}
```
