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

Apply after fetching the submodule, then rebuild:

```bash
git -C packages/engine/tic80 apply packages/engine/patches/cartbox-material-gbuffer.patch
npm run engine:build:wasm      # classic core -> dist/tic80.{js,wasm}
bash packages/engine/scripts/build-pro-wasm.sh   # pro core -> dist/pro/engine.{js,wasm}
```
