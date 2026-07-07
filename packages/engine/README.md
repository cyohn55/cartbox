# packages/engine — TIC-80 fork + build

TIC-80 (MIT) is vendored here as a **git submodule** at `./tic80`. We treat the VM as compatibility-frozen and
build two artifacts from it: a **native** binary (basis for the desktop editor) and a **WASM** module (basis for
the web player).

## Setup
```bash
git submodule add https://github.com/nesbox/TIC-80 packages/engine/tic80
git submodule update --init --recursive
```

## Build scripts
- `scripts/build-native.sh` → native `tic80` (CMake; see TIC-80's build docs for platform deps).
- `scripts/build-wasm.sh` → Emscripten build emitting `dist/tic80.wasm` + `dist/tic80.js` consumed by `@cartbox/player`.

## Upstream hygiene
- Keep local changes minimal and in patches/overlays, not by rewriting `tic80/`. Rebase on upstream tags.
- Push generally-useful fixes **upstream** to TIC-80 — good citizenship and less fork drift.

## License obligations (MIT)
- Retain `tic80/LICENSE` and copyright headers.
- Surface attribution in the desktop app's About screen and the web footer.
- Record any bundled third-party assets/fonts and their licenses in `../../NOTICE`.
