#!/usr/bin/env bash
#
# Builds the "portrait" core: the pro core's spec turned on its side, 360x640.
#
# Why this is cheap: 360*640 is exactly 640*360, so the portrait model has the
# same pixel count, the same framebuffer size, and the same memory map as pro.
# Only the two dimensions and the overscan buffer differ, so this reuses the pro
# VRAM/RAM/map sizes verbatim rather than re-deriving them.
#
# Two things do not simply transpose:
#
#  * TIC80_FULLWIDTH_BITS picks a power-of-two overscan *width*. Pro uses 10
#    (1024, framing 640). Portrait is 360 wide, so 9 (512) frames it with an even
#    76px margin; 10 would waste 3x the buffer.
#  * TIC80_FULLHEIGHT is derived upstream as FULLWIDTH*9/16 — a landscape
#    assumption that gives 288 lines here, less than half the 640 the screen
#    needs. tic80.h now #ifndef-guards it (Cartbox fork) so this build states it
#    directly: 704, framing 640 with an even 32px margin.
#
# Prerequisites: Emscripten SDK on PATH (emcc, emcmake); TIC-80 source present.
# Usage:  npm run engine:build:portrait   (from repo root)

set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIC80_DIR="${ENGINE_DIR}/tic80"
BUILD_DIR="${ENGINE_DIR}/build-wasm-portrait"
DIST_DIR="${ENGINE_DIR}/dist/portrait"

# --- Portrait fixed spec -----------------------------------------------------
PORTRAIT_WIDTH=360
PORTRAIT_HEIGHT=640
PORTRAIT_FULLWIDTH_BITS=9   # 512 wide, 76px side margins around 360
PORTRAIT_FULLHEIGHT=704     # 704 tall, 32px top/bottom margins around 640
PORTRAIT_PALETTE_BPP=8
PORTRAIT_SOUND_CHANNELS=8
# Identical to pro: the screen is the same 230,400 bytes at 8bpp (225KB), so the
# same VRAM/RAM/map bounds hold with the same headroom.
PORTRAIT_VRAM_SIZE=$((256 * 1024))
PORTRAIT_RAM_SIZE=$((768 * 1024))
PORTRAIT_MAP_MAX_SIZE=$((256 * 1024))

PORTRAIT_DEFINES="-DTIC80_WIDTH=${PORTRAIT_WIDTH} -DTIC80_HEIGHT=${PORTRAIT_HEIGHT}"
PORTRAIT_DEFINES+=" -DTIC80_FULLWIDTH_BITS=${PORTRAIT_FULLWIDTH_BITS}"
PORTRAIT_DEFINES+=" -DTIC80_FULLHEIGHT=${PORTRAIT_FULLHEIGHT}"
PORTRAIT_DEFINES+=" -DTIC_PALETTE_BPP=${PORTRAIT_PALETTE_BPP}"
PORTRAIT_DEFINES+=" -DTIC_SOUND_CHANNELS=${PORTRAIT_SOUND_CHANNELS}"
PORTRAIT_DEFINES+=" -DTIC_VRAM_SIZE=${PORTRAIT_VRAM_SIZE} -DTIC_RAM_SIZE=${PORTRAIT_RAM_SIZE}"
PORTRAIT_DEFINES+=" -DTIC_MAP_MAX_SIZE=${PORTRAIT_MAP_MAX_SIZE}"

# --- Preconditions -----------------------------------------------------------
if ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc not found. Install and activate the Emscripten SDK first." >&2
  exit 1
fi
if [ ! -f "${TIC80_DIR}/include/tic80.h" ]; then
  echo "error: TIC-80 source missing at ${TIC80_DIR}." >&2
  exit 1
fi
if ! grep -q "ifndef TIC80_FULLHEIGHT" "${TIC80_DIR}/include/tic80.h"; then
  echo "error: tic80.h does not guard TIC80_FULLHEIGHT — apply the Cartbox patch first" >&2
  echo "       (packages/engine/patches/); without it this build silently gets a" >&2
  echo "       288-line overscan buffer for a 640-line screen." >&2
  exit 1
fi

mkdir -p "${DIST_DIR}"

# --- 1. Build the TIC-80 core as a static library (portrait config) ----------
emcmake cmake -S "${TIC80_DIR}" -B "${BUILD_DIR}" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DCMAKE_C_FLAGS="${PORTRAIT_DEFINES}" \
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
  exit 1
fi

# --- 2. Compile + link the shim into an ES module (portrait config) ----------
# STACK_SIZE is raised for the same reason as pro: draw.c's per-scanline buffers
# are sized by TIC80_HEIGHT, and portrait's 640 lines make them larger than pro's
# 360 — so if anything this build needs the headroom more.
mapfile -t ARCHIVES < <(find "${BUILD_DIR}" -name '*.a' | sort -u)

EXPORTED_FUNCTIONS='_malloc,_free,_cbx_create,_cbx_load,_cbx_tick,_cbx_screen_ptr,_cbx_samples_ptr,_cbx_samples_count,_cbx_mailbox_ptr,_cbx_mailbox_words,_cbx_material_ptr,_cbx_emissive_ptr,_cbx_set_material_capture,_cbx_delete,_cbx_cart_create,_cbx_cart_delete,_cbx_cart_bytesize,_cbx_cart_load,_cbx_cart_save,_cbx_cart_tiles_ptr,_cbx_cart_sprites_ptr,_cbx_cart_map_ptr,_cbx_cart_palette_ptr,_cbx_cart_code_ptr,_cbx_cart_code_capacity,_cbx_cart_get_lang,_cbx_cart_set_lang,_cbx_cart_banks,_cbx_cart_sfx_ptr,_cbx_cart_sfx_stride,_cbx_cart_waveforms_ptr,_cbx_cart_waveform_stride,_cbx_cart_sfx_loop_start,_cbx_cart_sfx_set_loop_start,_cbx_cart_sfx_loop_size,_cbx_cart_sfx_set_loop_size,_cbx_cart_music_patterns_ptr,_cbx_cart_music_pattern_stride,_cbx_cart_music_tracks_ptr,_cbx_cart_music_track_stride,_cbx_cart_music_pattern_id,_cbx_cart_music_set_pattern_id,_cbx_last_error,_cbx_error_seq'

emcc -O3 \
  ${PORTRAIT_DEFINES} \
  "${ENGINE_DIR}/shim.c" \
  "${ARCHIVES[@]}" \
  -I "${TIC80_DIR}/include" \
  -I "${TIC80_DIR}/src" \
  -o "${DIST_DIR}/engine.js" \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 \
  -sSTACK_SIZE=4194304 \
  -sEXPORTED_FUNCTIONS="${EXPORTED_FUNCTIONS}" \
  -sEXPORTED_RUNTIME_METHODS='HEAPU8,HEAP16,HEAP32' \
  -sEXPORT_NAME=PortraitEngine

echo "Built ${DIST_DIR}/engine.js (+ engine.wasm) — portrait core, ${PORTRAIT_WIDTH}x${PORTRAIT_HEIGHT}."
