#!/usr/bin/env bash
#
# Builds the "pro" core: the same TIC-80 core + cbx shim as build-wasm.sh, but
# compiled with the pro console model's larger fixed spec injected via -D. The
# base constants are #ifndef-guarded in tic80.h / tic.h (Cartbox fork), so the
# classic build (build-wasm.sh, no -D) is byte-for-byte upstream while this build
# selects the pro dimensions. Output: dist/pro/engine.js + engine.wasm, loaded by
# @cartbox/player via the pro model's engineUrl (/engine/pro/engine.js).
#
# MILESTONE 1: resolution 640x360.  MILESTONE 2 (current): 8bpp / 256-color
# framebuffer (TIC_PALETTE_BPP=8) — one byte per pixel, a natural extension of the
# core's existing 1/2/4bpp machinery (6bpp is not byte-aligned and would need a new
# pixel-addressing model, so 8bpp was chosen; the model's 64-color spec is the
# editor-enforced authoring limit). Sound channels (8) remain milestone 3. NB: 8bpp
# sprites/tiles (spr/map) are a follow-up — see build note below.
# MILESTONE 3: 8 sound channels (TIC_SOUND_CHANNELS=8) — channel arrays and the
# mixer size from the constant; the music-track pattern packing is widened to u64
# in tools.c (8 channels x 6 bits = 48 bits overflow the upstream u32).
#
# Prerequisites: Emscripten SDK on PATH (emcc, emcmake); TIC-80 submodule present.
# Usage:  npm run engine:build:pro   (from repo root)

set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIC80_DIR="${ENGINE_DIR}/tic80"
BUILD_DIR="${ENGINE_DIR}/build-wasm-pro"
DIST_DIR="${ENGINE_DIR}/dist/pro"

# --- Pro fixed spec (milestone 1) --------------------------------------------
# Display 640x360 (16:9). FULLWIDTH_BITS=10 => 1024x576 overscan buffer, large
# enough to letterbox the 640x360 visible region (margins 192 / 108).
PRO_WIDTH=640
PRO_HEIGHT=360
PRO_FULLWIDTH_BITS=10
PRO_PALETTE_BPP=8
PRO_SOUND_CHANNELS=8
# Memory map, sized generously above the computed struct layout so the
# sizeof(tic_vram)==TIC_VRAM_SIZE / sizeof(tic_ram)==TIC_RAM_SIZE asserts hold
# (the union's data[SIZE] member dominates). At 8bpp: screen 640*360=225KB (VRAM
# 256KB); RAM = vram(256KB)+tiles/sprites(2x16KB)+map(225KB)+rest (~560KB struct
# => 768KB with headroom).
PRO_VRAM_SIZE=$((256 * 1024))   # 262144
PRO_RAM_SIZE=$((768 * 1024))    # 786432
PRO_MAP_MAX_SIZE=$((256 * 1024)) # sanity bound above the ~225KB pro map

PRO_DEFINES="-DTIC80_WIDTH=${PRO_WIDTH} -DTIC80_HEIGHT=${PRO_HEIGHT}"
PRO_DEFINES+=" -DTIC80_FULLWIDTH_BITS=${PRO_FULLWIDTH_BITS}"
PRO_DEFINES+=" -DTIC_PALETTE_BPP=${PRO_PALETTE_BPP}"
PRO_DEFINES+=" -DTIC_SOUND_CHANNELS=${PRO_SOUND_CHANNELS}"
PRO_DEFINES+=" -DTIC_VRAM_SIZE=${PRO_VRAM_SIZE} -DTIC_RAM_SIZE=${PRO_RAM_SIZE}"
PRO_DEFINES+=" -DTIC_MAP_MAX_SIZE=${PRO_MAP_MAX_SIZE}"

# --- Preconditions -----------------------------------------------------------
if ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc not found. Install and activate the Emscripten SDK first." >&2
  exit 1
fi
if [ ! -f "${TIC80_DIR}/include/tic80.h" ]; then
  echo "error: TIC-80 submodule missing at ${TIC80_DIR}." >&2
  exit 1
fi

mkdir -p "${DIST_DIR}"

# --- 1. Build the TIC-80 core as a static library (pro config) ---------------
# The pro -D defines reach every core translation unit via CMAKE_C_FLAGS so the
# memory-map structs are laid out at the pro sizes.
emcmake cmake -S "${TIC80_DIR}" -B "${BUILD_DIR}" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DCMAKE_C_FLAGS="${PRO_DEFINES}" \
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

# --- 2. Compile + link the shim into an ES module (pro config) ---------------
# Same shim.c as classic; it reads dimensions from the (now pro) macros. The pro
# -D defines must be repeated here so the shim's own use of TIC80_WIDTH/HEIGHT etc.
# matches the core it links against.
#
# STACK_SIZE is raised from Emscripten's 64KB default: the core's per-frame draw
# buffers scale with resolution (e.g. draw.c's s16 Left/Right[TIC80_HEIGHT] and
# draw_dep.c's s32 ULeft/VLeft[TIC80_HEIGHT]) and, on top of the scripting VM's
# own C stack, exceed 64KB at 640x360 — which silently corrupted memory and trapped
# mid-tick until the stack was enlarged.
mapfile -t ARCHIVES < <(find "${BUILD_DIR}" -name '*.a' | sort -u)

EXPORTED_FUNCTIONS='_malloc,_free,_cbx_create,_cbx_load,_cbx_tick,_cbx_screen_ptr,_cbx_samples_ptr,_cbx_samples_count,_cbx_mailbox_ptr,_cbx_mailbox_words,_cbx_material_ptr,_cbx_emissive_ptr,_cbx_set_material_capture,_cbx_delete,_cbx_cart_create,_cbx_cart_delete,_cbx_cart_bytesize,_cbx_cart_load,_cbx_cart_save,_cbx_cart_tiles_ptr,_cbx_cart_sprites_ptr,_cbx_cart_map_ptr,_cbx_cart_palette_ptr,_cbx_cart_code_ptr,_cbx_cart_code_capacity,_cbx_cart_get_lang,_cbx_cart_set_lang,_cbx_cart_banks,_cbx_cart_sfx_ptr,_cbx_cart_sfx_stride,_cbx_cart_waveforms_ptr,_cbx_cart_waveform_stride,_cbx_cart_sfx_loop_start,_cbx_cart_sfx_set_loop_start,_cbx_cart_sfx_loop_size,_cbx_cart_sfx_set_loop_size,_cbx_cart_music_patterns_ptr,_cbx_cart_music_pattern_stride,_cbx_cart_music_tracks_ptr,_cbx_cart_music_track_stride,_cbx_cart_music_pattern_id,_cbx_cart_music_set_pattern_id'

emcc -O3 \
  ${PRO_DEFINES} \
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
  -sEXPORT_NAME=ProEngine

echo "Built ${DIST_DIR}/engine.js (+ engine.wasm) — pro core, ${PRO_WIDTH}x${PRO_HEIGHT}."
