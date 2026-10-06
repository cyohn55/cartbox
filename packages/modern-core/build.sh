#!/usr/bin/env bash
# Builds the dedicated Modern core (ENGINE_PARITY_ROADMAP.md EP20b) to
# dist/modern-core.{js,wasm}: Lua 5.4 (vendor/lua) plus src/core.c and src/tic.c, with
# src/host.js as the direct API's imports. Needs Emscripten (emcc) on PATH;
# CI builds it with the same version (.github/workflows/build-modern-core.yml).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
LUA_SOURCES=$(ls vendor/lua/*.c)
emcc -O2 -flto \
  -Ivendor/lua \
  -DLUA_COMPAT_5_3 \
  src/core.c src/tic.c $LUA_SOURCES \
  --js-library src/host.js \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=ModernCore \
  -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 \
  -sFILESYSTEM=0 \
  -sEXPORTED_FUNCTIONS=_cbx_core_init,_cbx_core_cart,_cbx_core_load,_cbx_core_tick,_cbx_core_framebuffer,_cbx_core_ram,_cbx_core_samples,_cbx_core_sample_count,_cbx_core_returns,_cbx_core_error,_cbx_core_memory,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF64,UTF8ToString \
  -o dist/modern-core.js
ls -l dist
