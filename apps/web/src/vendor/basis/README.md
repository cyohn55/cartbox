# Basis Universal transcoder

`basis_transcoder.cjs` (renamed from `.js`, so it loads as CommonJS in this
`"type": "module"` package) and `basis_transcoder.wasm` are the official WebAssembly
build of the [Basis Universal](https://github.com/BinomialLLC/basis_universal)
transcoder, taken unmodified from `three@0.186.1`
(`examples/jsm/libs/basis/`). Apache License 2.0.

Cartbox uses them to turn KTX2 (`KHR_texture_basisu`) textures into RGBA — see
`src/lib/ktx2Decoder.ts`. They are loaded only for scenes that keep KTX2
textures (see `ktx2Policy.ts`), so no other cart downloads them.

# Basis Universal encoder

`basis_encoder.mjs` and `basis_encoder.wasm` are the WebAssembly build of the
Basis Universal encoder (Apache License 2.0), taken from
`ktx2-encoder@0.6.0` (`dist/basis/`, MIT glue). The `.wasm` is unmodified.
The `.mjs` (renamed from `basis_encoder.js`) is patched so it never takes
Emscripten's Node.js paths: `ENVIRONMENT_IS_NODE` is `false`, and the
`import("module")`, `require("fs" | "path" | "url" | "crypto")` and
`new URL("basis_encoder.wasm", import.meta.url)` it would use there are
removed. The caller always passes `wasmBinary`, so it loads the same way in
the browser and in the tests, and bundlers see no Node built-ins.

Cartbox uses it to compress an imported model's PNG and JPEG maps to KTX2 —
see `src/lib/ktx2Encoder.ts` and `compressMeshTextures` in `ktx2Policy.ts`.
It is loaded only in the editor, and only when an import has maps to
compress (~3 MB); players never fetch it.
