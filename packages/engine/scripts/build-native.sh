#!/usr/bin/env bash
#
# Builds the native TIC-80 binary — the basis for the desktop editor wrapped by
# apps/desktop (Tauri). This is a thin convenience wrapper around TIC-80's own
# CMake build; see TIC-80's BUILD.md for platform-specific dependencies.
#
# Usage:  npm run engine:build:native   (from repo root)

set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIC80_DIR="${ENGINE_DIR}/tic80"
BUILD_DIR="${ENGINE_DIR}/build-native"

if ! command -v cmake >/dev/null 2>&1; then
  echo "error: cmake not found." >&2
  exit 1
fi
if [ ! -f "${TIC80_DIR}/CMakeLists.txt" ]; then
  echo "error: TIC-80 submodule missing at ${TIC80_DIR}." >&2
  echo "       git submodule add https://github.com/nesbox/TIC-80 packages/engine/tic80" >&2
  exit 1
fi

# TIC-80's build expects its own submodules (vendored libs) to be present.
git -C "${TIC80_DIR}" submodule update --init --recursive

cmake -S "${TIC80_DIR}" -B "${BUILD_DIR}" -DCMAKE_BUILD_TYPE=Release
cmake --build "${BUILD_DIR}" -j"$(nproc 2>/dev/null || echo 4)"

echo "Native build complete under ${BUILD_DIR}."
