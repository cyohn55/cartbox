# packages/engine — TIC-80 fork + build

TIC-80 (MIT) is vendored here at `./tic80` — fetched by `npm run engine:prepare`, gitignored, and patched in
place (see `patches/`). We treat the VM as compatibility-frozen and build from it: a **native** binary (basis for
the desktop editor), and one **WASM** core per console model (Classic, Pro, Portrait, PS1), each selected by
build-time `-D` defines rather than by a source fork.

## Setup

```bash
npm run engine:prepare
```

Clones TIC-80 at the pinned commit the patches were authored against and applies
both overlays. Idempotent, so it is safe to run before every build.

> **Note.** The line above used to read `git submodule add ... && git submodule
> update --init`. That never worked: this repository has no `.gitmodules` and
> `tic80/` is gitignored, so `update --init` silently did nothing and the build
> then failed its "TIC-80 submodule missing" precondition — a failure that reads
> like a missing toolchain rather than a missing checkout. A plain pinned clone
> is also the more honest tool here, because the patches carry `index` lines
> naming the blobs they expect and only apply at that one commit.

## Build scripts
- `scripts/build-native.sh` → native `tic80` (CMake; see TIC-80's build docs for platform deps).
- `scripts/build-wasm.sh` → Emscripten build emitting `dist/tic80.wasm` + `dist/tic80.js` consumed by `@cartbox/player`.
- `scripts/build-{pro,portrait,ps1}-wasm.sh` → the same core at another model's fixed spec, into `dist/<model>/`.

`.github/workflows/build-engine-cores.yml` runs the prepare + build chain on any change to `shim.c`, the patches
or the build scripts, so the recipe cannot rot unnoticed while the committed binaries keep working.

## Upstream hygiene
- Keep local changes minimal and in patches/overlays, not by rewriting `tic80/`. Rebase on upstream tags.
- Push generally-useful fixes **upstream** to TIC-80 — good citizenship and less fork drift.

## License obligations (MIT)
- Retain `tic80/LICENSE` and copyright headers.
- Surface attribution in the desktop app's About screen and the web footer.
- Record any bundled third-party assets/fonts and their licenses in `../../NOTICE`.
