# The Elder Scrolls: Arena (DOS)

`arena.zip` is the DOS game, vendored for the `dos` runtime (see
`scripts/fetch-dosbox.mjs`, which copies it to `apps/web/public/dosbox/arena.zip`).

## Licensing

Bethesda Softworks released The Elder Scrolls: Arena as **freeware** (the full
game, version 1.06) to mark the series' 10th anniversary. It is freely
redistributable, which is what lets the whole game ship with the console.

## Provenance — how `arena.zip` is produced

Bethesda distributes the free release as a RAR self-extracting installer
(`Arena106.exe`), not a ready-to-run archive, so — unlike the other DOS titles,
which are fetched from a stable URL and digest-pinned in `fetch-dosbox.mjs` — the
game is vendored here after a one-time extraction:

1. Download Bethesda's free release (the `Arena106Setup.zip` on the Internet
   Archive `ElderScrollsArena` item), which contains `Arena106.exe`.
2. `Arena106.exe` is a RAR SFX; extract it with `unrar` (its compression method
   is not handled by the free `7z`/`unar` RAR support). This yields an `ARENA/`
   directory of ~156 files.
3. Zip the **contents** of `ARENA/` at the archive root (so the files land in
   `C:\`, next to `ARENA.BAT`): `cd ARENA && zip -r ../arena.zip .`

It is vendored rather than extracted at build time so the build needs no
(nonfree) `unrar` dependency; the digest in `fetch-dosbox.mjs` pins this exact
zip.

## Launch

`ARENA.BAT` runs `A.EXE` with the Sound Blaster arguments the game needs
(`-sa:220 -si:7 -sd:1 ...`); running `A.EXE` bare renders a black screen. The
title's `dosTarget` is therefore `arena:ARENA.BAT`. Arena has full keyboard
controls (arrows move/turn), so it plays on the handheld's d-pad.
