# Command & Conquer: Tiberian Dawn (DOS)

`cnc.zip` is the playable DOS game, vendored for the `dos` runtime (see
`scripts/fetch-dosbox.mjs`, which copies it to `apps/web/public/dosbox/cnc.zip`).

## Licensing

Electronic Arts released the original Command & Conquer (Tiberian Dawn) as
**freeware** for the series' 12th anniversary, and later open-sourced the engine.
The game is freely redistributable, which is what lets it ship with the console.

## Provenance — how `cnc.zip` is produced

EA's clean release is a ~490 MB CD-ROM ISO (most of which is full-motion video),
so the playable game is assembled once from it and vendored, the same way Arena
is (there is no ready-to-run download to fetch and digest-pin):

1. Download the freeware DOS v1.22 GDI disc ISO (Internet Archive item
   `cnc-dos-eng-v-1.22`).
2. Extract the game files (7z reads ISO9660), **excluding `MOVIES.MIX`** (the
   425 MB of FMV). The game runs without the movies.
3. The runnable binary is `GAME.NEW` (the CD ships it under that name; the tiny
   `C&C.COM` loader decompresses it to `GAME.DAT` and runs it under DOS/4GW).
   Keep `GAME.NEW` un-renamed — `C&C.COM` does the rename itself.
4. Put the core game data (`CONQUER.MIX`, the theater MIX files, `GENERAL.MIX`,
   `SOUNDS.MIX`, `SPEECH.MIX`, `LOCAL.MIX`, `TRANSIT.MIX`, `AUD.MIX`) plus the
   loader, `HMIDET.386`/`HMIDRV.386`, and a `CONQUER.INI` (no-sound config, from
   the demo) at the archive root — the game reads its data from C:.
   `SCORES.MIX` (39 MB of music) is omitted for size, so there is no in-game
   music.
5. The game refuses to run without a Command & Conquer CD in a CD-ROM drive.
   The check is by **volume label**, not contents, so build a tiny ISO
   (`genisoimage -iso-level 1 -V GDI`) holding just `TEMPERAT.MIX`, name it
   `CNC.ISO`, and add it to the archive root. The boot page mounts it as a
   CD-ROM (`imgmount d CNC.ISO -t iso`) — see the third field of the dosTarget.

## Launch

`dosTarget` is `cnc:C&C.COM:CNC.ISO` — the third field is the CD image the DOS
boot page mounts before running `C&C.COM`. C&C is mouse-driven, so it is played
by tapping the screen (the handheld forwards taps as clicks); the d-pad scrolls
the battlefield.
