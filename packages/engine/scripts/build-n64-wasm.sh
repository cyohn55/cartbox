#!/usr/bin/env bash
# Build the Cartbox N64 core: a 320x240, 8bpp, 8-channel build of the same
# TIC-80-derived engine the Classic and Pro cores use.
#
# This is deliberately the Pro script with a different fixed spec. A new era
# model should be a set of numbers plus a renderer that honours its RenderCaps,
# not a new engine — the 3D itself comes from the player's mesh and world
# overlay surfaces, which composite textured triangles over whatever frame the
# core produces. See ERA_MODELS.md.
#
# What the core supplies: the 2D framebuffer (HUD, UI, backdrops), the Lua/JS
# VM, sound, and the cartridge memory map. What it does not supply: geometry.
# That lives in the cart's asset manifest.
#
# Display 320x240 (4:3, the era's NTSC frame). FULLWIDTH_BITS=9 => a 512-wide
# overscan buffer, the smallest power of two that contains 320 with margin.
#
# Prerequisites: Emscripten SDK on PATH (emcc, emcmake); TIC-80 submodule present.
#
# Use Emscripten 3.1.x (the repo pins 3.1.64), NOT 4.x/6.x. The newer toolchain's
# MODULARIZE+EXPORT_ES6 output — a bare `async function` factory plus an
# `import("node:module")` scheme import — fails to load on older WebKit (iPad
# Safari) with a bare "Type error". The shipped classic/pro/portrait cores are
# all 3.1.x; a N64 core must match so it loads everywhere they do.
set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIC80_DIR="${ENGINE_DIR}/tic80"
BUILD_DIR="${ENGINE_DIR}/build-wasm-n64"
DIST_DIR="${ENGINE_DIR}/dist/n64"

# --- PS1 fixed spec ----------------------------------------------------------
# Memory map sized from the same rules the Pro spec documents, at this
# resolution. At 8bpp: screen 320*240 = 75KB (VRAM 128KB with headroom for the
# palette and the rest of the vram struct); map 320*240 = 75KB; RAM =
# vram + tiles/sprites (2x16KB) + map + rest, rounded up to 384KB.
N64_WIDTH=320
N64_HEIGHT=240
N64_FULLWIDTH_BITS=9
N64_PALETTE_BPP=8
N64_SOUND_CHANNELS=8
N64_VRAM_SIZE=$((128 * 1024))    # 131072
N64_RAM_SIZE=$((384 * 1024))     # 393216
N64_MAP_MAX_SIZE=$((128 * 1024)) # sanity bound above the ~75KB n64 map

N64_DEFINES="-DTIC80_WIDTH=${N64_WIDTH} -DTIC80_HEIGHT=${N64_HEIGHT}"
N64_DEFINES+=" -DTIC80_FULLWIDTH_BITS=${N64_FULLWIDTH_BITS}"
N64_DEFINES+=" -DTIC_PALETTE_BPP=${N64_PALETTE_BPP}"
N64_DEFINES+=" -DTIC_SOUND_CHANNELS=${N64_SOUND_CHANNELS}"
N64_DEFINES+=" -DTIC_VRAM_SIZE=${N64_VRAM_SIZE} -DTIC_RAM_SIZE=${N64_RAM_SIZE}"
N64_DEFINES+=" -DTIC_MAP_MAX_SIZE=${N64_MAP_MAX_SIZE}"

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

# --- 1. Build the TIC-80 core as a static library (n64 config) ---------------
# The n64 -D defines reach every core translation unit via CMAKE_C_FLAGS so the
# memory-map structs are laid out at the pro sizes.
emcmake cmake -S "${TIC80_DIR}" -B "${BUILD_DIR}" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DCMAKE_C_FLAGS="${N64_DEFINES}" \
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

# --- 2. Compile + link the shim into an ES module (n64 config) ---------------
# Same shim.c as classic; it reads dimensions from the (now n64) macros. The n64
# -D defines must be repeated here so the shim's own use of TIC80_WIDTH/HEIGHT etc.
# matches the core it links against.
#
# STACK_SIZE is raised from Emscripten's 64KB default: the core's per-frame draw
# buffers scale with resolution (e.g. draw.c's s16 Left/Right[TIC80_HEIGHT] and
# draw_dep.c's s32 ULeft/VLeft[TIC80_HEIGHT]) and, on top of the scripting VM's
# own C stack, exceeded 64KB at 640x360 — which silently corrupted memory and trapped
# mid-tick until the stack was enlarged.
mapfile -t ARCHIVES < <(find "${BUILD_DIR}" -name '*.a' | sort -u)

EXPORTED_FUNCTIONS='_malloc,_free,_cbx_create,_cbx_load,_cbx_tick,_cbx_screen_ptr,_cbx_samples_ptr,_cbx_samples_count,_cbx_mailbox_ptr,_cbx_mailbox_words,_cbx_material_ptr,_cbx_emissive_ptr,_cbx_set_material_capture,_cbx_delete,_cbx_cart_create,_cbx_cart_delete,_cbx_cart_bytesize,_cbx_cart_load,_cbx_cart_save,_cbx_cart_tiles_ptr,_cbx_cart_sprites_ptr,_cbx_cart_map_ptr,_cbx_cart_palette_ptr,_cbx_cart_code_ptr,_cbx_cart_code_capacity,_cbx_cart_get_lang,_cbx_cart_set_lang,_cbx_cart_banks,_cbx_cart_sfx_ptr,_cbx_cart_sfx_stride,_cbx_cart_waveforms_ptr,_cbx_cart_waveform_stride,_cbx_cart_sfx_loop_start,_cbx_cart_sfx_set_loop_start,_cbx_cart_sfx_loop_size,_cbx_cart_sfx_set_loop_size,_cbx_cart_music_patterns_ptr,_cbx_cart_music_pattern_stride,_cbx_cart_music_tracks_ptr,_cbx_cart_music_track_stride,_cbx_cart_music_pattern_id,_cbx_cart_music_set_pattern_id,_cbx_last_error,_cbx_error_seq'

emcc -O3 \
  ${N64_DEFINES} \
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
  -sEXPORT_NAME=N64Engine

echo "Built ${DIST_DIR}/engine.js (+ engine.wasm) — n64 core, ${N64_WIDTH}x${N64_HEIGHT}."
