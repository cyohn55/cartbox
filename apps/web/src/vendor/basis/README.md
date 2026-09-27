# Basis Universal transcoder

`basis_transcoder.cjs` (renamed from `.js`, so it loads as CommonJS in this
`"type": "module"` package) and `basis_transcoder.wasm` are the official WebAssembly
build of the [Basis Universal](https://github.com/BinomialLLC/basis_universal)
transcoder, taken unmodified from `three@0.186.1`
(`examples/jsm/libs/basis/`). Apache License 2.0.

Cartbox uses them to turn KTX2 (`KHR_texture_basisu`) textures into RGBA — see
`src/lib/ktx2Decoder.ts`. They are loaded only for scenes that keep KTX2
textures (see `ktx2Policy.ts`), so no other cart downloads them.
