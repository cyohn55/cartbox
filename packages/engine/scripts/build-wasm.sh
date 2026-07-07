#!/usr/bin/env bash
#
# Builds the TIC-80 core to WASM and links the cbx shim, emitting an ES module
# (dist/tic80.js + dist/tic80.wasm) that @cartbox/player loads via `engineUrl`.
#
# Prerequisites:
#   - Emscripten SDK on PATH (emcc, emcmake)   https://emscripten.org
#   - TIC-80 vendored as a submodule at packages/engine/tic80
#
# Usage:  npm run engine:build:wasm   (from repo root)

set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIC80_DIR="${ENGINE_DIR}/tic80"
BUILD_DIR="${ENGINE_DIR}/build-wasm"
DIST_DIR="${ENGINE_DIR}/dist"

# --- Preconditions -----------------------------------------------------------
if ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc not found. Install and activate the Emscripten SDK first." >&2
  exit 1
fi
if [ ! -f "${TIC80_DIR}/include/tic80.h" ]; then
  echo "error: TIC-80 submodule missing at ${TIC80_DIR}." >&2
  echo "       git submodule add https://github.com/nesbox/TIC-80 packages/engine/tic80" >&2
  exit 1
fi

mkdir -p "${DIST_DIR}"

# --- 1. Build the TIC-80 core as a static library -----------------------------
# Frontends (SDL/Sokol) and demo carts are disabled — we only need the headless
# core. Enable just the script runtimes you want to support; more languages mean
# a larger .wasm. Lua + JS cover the large majority of cartridges.
emcmake cmake -S "${TIC80_DIR}" -B "${BUILD_DIR}" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DBUILD_SDL=OFF \
  -DBUILD_EDITORS=OFF \
  -DBUILD_TOOLS=OFF \
  -DBUILD_PLAYER=OFF \
  -DBUILD_PRO=OFF \
  -DBUILD_WITH_LUA=ON \
  -DBUILD_WITH_JS=ON \
  -DBUILD_WITH_MOON=OFF \
  -DBUILD_WITH_FENNEL=OFF \
  -DBUILD_WITH_SCHEME=OFF \
  -DBUILD_WITH_WREN=OFF \
  -DBUILD_WITH_SQUIRREL=OFF \
  -DBUILD_WITH_WASM=OFF \
  -DBUILD_WITH_PYTHON=OFF \
  -DBUILD_WITH_RUBY=OFF \
  -DBUILD_WITH_JANET=OFF \
  -DBUILD_WITH_YUE=OFF

cmake --build "${BUILD_DIR}" --target tic80core -j"$(nproc 2>/dev/null || echo 4)"

if [ -z "$(find "${BUILD_DIR}" -name 'libtic80core.a' | head -1)" ]; then
  echo "error: libtic80core.a not found under ${BUILD_DIR}." >&2
  echo "       Check the target name against the vendored TIC-80's CMakeLists." >&2
  exit 1
fi

# --- 2. Compile + link the shim into an ES module -----------------------------
# tic80core depends on several vendored static libs (png, blipbuf, zlib, lua,
# quickjs, ...). wasm-ld resolves archives order-independently, so we link every
# .a produced by the build alongside the shim.
mapfile -t ARCHIVES < <(find "${BUILD_DIR}" -name '*.a' | sort -u)

EXPORTED_FUNCTIONS='_malloc,_free,_cbx_create,_cbx_load,_cbx_tick,_cbx_screen_ptr,_cbx_samples_ptr,_cbx_samples_count,_cbx_mailbox_ptr,_cbx_mailbox_words,_cbx_delete,_cbx_cart_create,_cbx_cart_delete,_cbx_cart_bytesize,_cbx_cart_load,_cbx_cart_save,_cbx_cart_tiles_ptr,_cbx_cart_sprites_ptr,_cbx_cart_map_ptr,_cbx_cart_palette_ptr,_cbx_cart_code_ptr,_cbx_cart_code_capacity,_cbx_cart_get_lang,_cbx_cart_set_lang,_cbx_cart_banks,_cbx_cart_sfx_ptr,_cbx_cart_sfx_stride,_cbx_cart_waveforms_ptr,_cbx_cart_waveform_stride,_cbx_cart_sfx_loop_start,_cbx_cart_sfx_set_loop_start,_cbx_cart_sfx_loop_size,_cbx_cart_sfx_set_loop_size,_cbx_cart_music_patterns_ptr,_cbx_cart_music_pattern_stride,_cbx_cart_music_tracks_ptr,_cbx_cart_music_track_stride,_cbx_cart_music_pattern_id,_cbx_cart_music_set_pattern_id'

emcc -O3 \
  "${ENGINE_DIR}/shim.c" \
  "${ARCHIVES[@]}" \
  -I "${TIC80_DIR}/include" \
  -I "${TIC80_DIR}/src" \
  -o "${DIST_DIR}/tic80.js" \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_FUNCTIONS="${EXPORTED_FUNCTIONS}" \
  -sEXPORTED_RUNTIME_METHODS='HEAPU8,HEAP16,HEAP32' \
  -sEXPORT_NAME=Tic80Engine

echo "Built ${DIST_DIR}/tic80.js (+ tic80.wasm)."
echo "Serve dist/ and pass its tic80.js URL to the player as engineUrl."
