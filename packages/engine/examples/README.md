# Engine verification kit

Durable harness for confirming the built WASM engine actually renders — no
temporary files, no external cartridge.

## Files
- **`sample-cart.mjs`** — builds a minimal Lua cartridge (concentric rings + a
  "CARTBOX" label) in memory. Also a CLI: `node sample-cart.mjs out.tic`.
- **`verify-engine.mjs`** — loads `../dist/tic80.js`, runs the sample cart for
  30 frames, and checks the framebuffer has real content (many palette colors,
  substantial coverage, fully opaque). Exits non-zero on failure.

## Run
```bash
# from the monorepo root (Working/tic80-console)
npm run engine:build:wasm     # once, to produce dist/tic80.js
npm run verify:engine         # -> "PASS — engine rendered real cartridge content."
```

Add `-- --ppm frame.ppm` to also dump the rendered frame as a viewable image:
```bash
npm run verify:engine -- --ppm frame.ppm
```

## What a pass proves
The engine instantiates, the `cbx_create/load/tick/screen_ptr` shim contract
works, a Lua cartridge executes its `TIC()` each frame, and the cropped 240×136
RGBA framebuffer is populated and opaque — i.e. the exact path the browser
player and the thumbnail render worker rely on.
