# MikkTSpace

`mikktspace.wasm` is the WebAssembly build of [MikkTSpace](http://www.mikktspace.com/)
vertex tangent generation, taken unmodified from `mikktspace@1.1.1`
(`dist/module/mikktspace_module_bg.wasm`, by Don McCurdy, MIT; see `LICENSE`).
It is built from the Rust port of Morten S. Mikkelsen's reference
implementation (zlib licence). The wasm-bindgen glue is not vendored: its two
imports and five exports are wired up by `src/lib/mikktspace.ts`, so it loads
the same way in the browser and in the tests.

Cartbox uses it to give an imported, normal-mapped model the tangents its
normal maps were baked against when the file carries none (AAA_FIDELITY_ROADMAP.md
F1c). It is loaded only in the editor, and only for such an import (~42 KB);
players never fetch it.
