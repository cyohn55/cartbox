# Doom (Freedoom) — `wasm-app` title

Doom running on the Cartbox Game ABI (see `games/README.md`). Tier A: both the
engine and the assets are freely redistributable, so the whole game ships with
the console and nothing is supplied by the player.

## Building

```
node scripts/fetch-freedoom.mjs      # once — downloads + verifies the IWAD
source ~/emsdk/emsdk_env.sh
node scripts/build-doom.mjs
```

Output lands in `apps/web/public/games/doom/` as `game.js`, `game.wasm` and
`game.data`. None of those, nor the fetched IWAD, are committed: they total
~55MB and are reproducible from the two commands above. **A deploy must run
both** — the static Pages build copies `public/`, it does not populate it.

## What is here

| Path | What it is |
|---|---|
| `cartbox_doom.c` | The entire port: a doomgeneric platform backend on one side, the seven ABI exports on the other |
| `vendor/` | doomgeneric, unmodified |
| `assets/` | Freedoom IWAD, fetched not committed |

The engine is vendored **verbatim** so it can be diffed against upstream. Every
adaptation lives in `cartbox_doom.c`, which is what makes it reviewable at all:
a port that edits 80 engine files cannot be told apart from a fork.

## Licensing

| Component | Licence | Source |
|---|---|---|
| doomgeneric / Doom engine | GPL-2.0 | https://github.com/ozkl/doomgeneric |
| Freedoom assets (`freedoom1.wad`) | BSD-3-Clause | https://freedoom.github.io |

Freedoom is what makes this Tier A rather than Tier B. Doom's *original* WADs
are commercial data even in shareware form; Freedoom is a clean-room asset set
under a BSD licence, so shipping it is redistribution the licence plainly
permits. Nothing from id's shareware release is used.

Two obligations follow and are not optional:

- **GPL-2 corresponding source.** The engine is distributed as compiled WASM, so
  the source it was built from must be offered to players. `vendor/` is that
  source, and it is why the tree is vendored rather than fetched at build time.
- **BSD attribution.** `scripts/fetch-freedoom.mjs` writes Freedoom's
  `COPYING.txt` alongside the IWAD; the licence text has to reach the player,
  which the title page is responsible for surfacing.

## Notes on the port

Three things in `cartbox_doom.c` are non-obvious and were each a real failure:

- **The framebuffer is BGRA, not RGBA.** doomgeneric calls its 32-bit mode
  "rgba8888" but packs `B | G<<8 | R<<16`, which lands in memory as B,G,R — and
  it never writes the alpha byte, leaving it zero. Copied straight out, the
  canvas is transparent and red/blue swapped.
- **The clock has to move during a tick.** `TryRunTics` spins waiting for a new
  tic, polling `I_GetTime` and calling `I_Sleep` between attempts, and it runs
  once *before* the first `cartbox_tick`. With a clock that only advances
  between ticks, that loop never exits — the port hung on boot until
  `DG_SleepMs` was made to advance the virtual clock instead of doing nothing.
- **Ticks are gated to 35Hz.** Doom is fixed-timestep and `TryRunTics` always
  runs at least one tic, so calling it once per host frame runs the game at the
  display's refresh rate — about 1.7x too fast at 60fps.

Audio is not wired up: the ABI has no audio channel, so the game is built
`-nosound`.

Controls: d-pad moves and turns, A fires, B opens doors, X runs, Y toggles the
automap, Start is Enter and Select is Escape (which opens Doom's menu).
