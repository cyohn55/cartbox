# Cartbox Game ABI (`wasm-app` runtime)

The contract a ported game implements to run on the console. Anything that can be compiled
with Emscripten — an open-source game, a source port, a decompilation-free reimplementation —
becomes a catalog title by exporting these seven functions.

Deliberately narrow: the host owns the canvas, the clock, input polling, and save storage.
The game owns a framebuffer and its own state. Nothing in the ABI concerns networking or the
filesystem, so a ported game cannot reach past the browser sandbox even accidentally.

## Exports

| Symbol | Signature | Purpose |
|---|---|---|
| `cartbox_init` | `(int width, int height) -> uint8_t*` | Allocate state; return a pointer to a `width * height * 4` RGBA framebuffer the host reads each frame. |
| `cartbox_set_input` | `(uint32_t buttons) -> void` | Current button bitmask (see `gameInput.ts`). Called once per frame before `cartbox_tick`. |
| `cartbox_tick` | `(float deltaSeconds) -> void` | Advance one frame and repaint the framebuffer. |
| `cartbox_score` | `() -> int` | Current score, or 0 for games without one. Surfaced to leaderboards. |
| `cartbox_save_size` | `() -> int` | Bytes needed for a save, or 0 if the game has no save state. |
| `cartbox_save` | `(uint8_t* out) -> int` | Serialise into `out`; return bytes written. |
| `cartbox_load` | `(const uint8_t* data, int size) -> int` | Restore; return non-zero on success. Must reject a save it does not recognise. |

## Rules

- **The framebuffer pointer must stay valid** for the module's lifetime. The host caches it
  after `cartbox_init` and reads it directly, so a game that reallocates must copy into the
  original buffer instead.
- **`cartbox_load` must validate.** Saves persist across game updates, so a version tag is the
  game's responsibility. Returning zero makes the host discard the save rather than boot a
  corrupt state.
- **`cartbox_tick` must not block.** It runs on the main thread inside a rAF loop.

## Building

```
source ~/emsdk/emsdk_env.sh
node scripts/build-game.mjs reference
```

Output lands in `apps/web/public/games/<name>/` as `game.js` + `game.wasm`.

## Porting a real game

A game with its own main loop (most of them) needs a shim translating its loop into
`cartbox_tick`, plus a blit from its renderer into the ABI framebuffer. Games using SDL2 can
keep SDL — Emscripten ports it — and the shim only bridges the loop and the frame handoff.
Asset data is mounted by the host before `cartbox_init` (see `gameAssets.ts`), so the game
reads its own files at their usual paths.
