# C-Dogs — `dos` runtime launch title

C-Dogs is the launch title for the console's **DOS runtime**: the original 1997
MS-DOS game running unmodified inside DOSBox, compiled to WebAssembly by the
[js-dos](https://js-dos.com) project (6.22). It is the DOS counterpart to the
Doom / ScummVM / SuperTux runtimes — the engine owns its own canvas and loop and
runs in a same-origin iframe.

## What's here

| Path | What it is | Provenance |
|---|---|---|
| `c-dogs.zip` | The full DOS game (CDOGS.EXE, graphics, sounds, campaigns), distributed **unmodified** | [DOS Games Archive](https://www.dosgamesarchive.com/download/c-dogs/) |
| `cdogssrc.zip` | The game's C source code | same |
| `SOUND.CFG` | Sound Blaster 16 config (overlay, see below) | generated with the game's DSETUP32 |
| `OPTIONS.CNF` | Player 1 controls bound to WASD + Space + Enter (overlay) | authored, see below |
| `vendor/js-dos/` | DOSBox built to WebAssembly (`js-dos.js`, `wdosbox.js`, `wdosbox.wasm.js`) | js-dos 6.22 (`js-dos.com/6.22/current`) |

`scripts/fetch-dosbox.mjs` copies the engine and game into
`apps/web/public/dosbox/` (renaming `c-dogs.zip` → `cdogs.zip`) at build time,
verifying each against a pinned SHA-256, and emits `cdogs.files.json` (a
path → base64 map of the overlay files below). The boot page extracts the game
zip, writes the overlay files into `C:` via `fs.createFile`, then launches
`CDOGS.EXE`. The assembled `public/dosbox/` is gitignored and regenerated; only
`cartbox-boot.html` is committed there.

## Overlay files (why the game boots clean and controllable)

C-Dogs may only be redistributed **unmodified**, so two files it needs are shipped
*alongside* the archive rather than inside it, and written into `C:` at launch:

- **`SOUND.CFG`** — without it C-Dogs fails sound initialisation (its DSMI system
  needs a card config). Generated once by driving the game's own `DSETUP32.EXE`
  to select the Sound Blaster 16 that DOSBox emulates (I/O 220, IRQ 7, DMA 5).
- **`OPTIONS.CNF`** — binds Player 1 to **W A S D + Space + Enter**. C-Dogs reads
  raw scancodes through a custom INT9 handler that mishandles the extended
  (`0xE0`-prefixed) codes of the arrow keys, so its arrow-key defaults arrive
  scrambled through DOSBox; the non-extended WASD/Space/Enter keys are delivered
  cleanly. `keys[]` order is `[Left, Right, Up, Down, Button1, Button2]` =
  `[A=30, D=32, W=17, S=31, Space=57, Enter=28]` (set-1 scancodes). This must
  stay in sync with the console→DOS key map in `apps/web/src/lib/dosRuntime.ts`.

## Licensing — why this is a Tier A title

C-Dogs is redistributable in full — engine **and** assets — which is what makes
it Tier A (free code + free assets), not a bring-your-own-data title:

- **Game code:** GPL-2 (with parts BSD-2). Ronny Wester released the C-Dogs
  source in 2002. `cdogssrc.zip` is the corresponding source, carried here to
  satisfy the GPL's source-offer obligation for the DOS binary we redistribute.
- **Game assets:** CC-BY. Ronny Wester released the C-Dogs data under Creative
  Commons Attribution in 2016 (see the
  [cdogs-sdl README](https://github.com/cxong/cdogs-sdl/blob/master/README.md):
  "the original C-Dogs data is also under CC-BY").
- **Original 1997 grant:** the game's own `README.TXT` already permitted free
  redistribution provided "all files must be distributed unmodified" and there is
  "no charge" — which is exactly how `c-dogs.zip` is shipped here: intact.
- **DOSBox / js-dos:** GPL-2, freely redistributable.

The title's `license` field is recorded as `gpl-2.0` — the stricter of the code
and asset licenses governs the work as a whole, the same rule the Doom title
follows for GPL engine + BSD assets.
