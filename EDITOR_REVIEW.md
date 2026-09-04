# Editor review — findings and proposed upgrades

Scope: the Cartbox creation editor — `apps/web/src/app/edit/[cartId]/` (79 files,
~20.7k lines of TS/TSX plus a 2.4k-line CSS module), the models it is built on in
`packages/editor/src/` (~19.4k lines), and the save path in
`apps/web/src/app/api/carts/[cartId]/`.

Reviewed at `75439ca`.

**Status: implemented.** All eight defects are fixed and twelve of the fourteen
upgrades have shipped; see §5 for what was deliberately left and why. The
document is kept as the record of what was found and what was done about it.

---

## 1. The honest summary

This is a genuinely ambitious editor — eleven tabs covering pixels, voxels,
tilemaps, HD-2D worlds, imported meshes, parallax scenes, sprite animation,
weather, post-FX, SFX and a music tracker, all backed by one live TIC-80
cartridge in WASM memory. The core architecture is right: every tab is a *view*
onto one cart (`SpriteSheet`, `TileMap`, `CodeDocument`, `SoundBank`,
`MusicTracker` over a shared `CartEngine`), so edits carry across tabs and
serialise back to a real `.tic`. The `observeEngine` + coalesced-snapshot undo
model is a clean answer to "one timeline over many tools". The code is unusually
well-commented, and the comments explain *why*, not *what*.

The problems are not architectural taste — they are **the seams**. The cart has
grown eleven sidecar payloads bolted on beside the `.tic`, and each one had to be
threaded through roughly twenty places by hand. Two of them (`mesh`, `world`)
did not get threaded through all twenty, and creators lose that work silently.
That is the shape of every high-severity finding below.

Underneath that, the two things a creator does most — **hear a sound** and
**not lose their work** — are the two things the editor cannot currently do.

---

## 2. Defects

Ordered by what it costs a creator when it bites.

### D1 — Mesh and World work is silently destroyed by Save in the static demo

`StaticCartEditor.tsx:118-119` hardcodes `initialMesh={null}` and
`initialWorld={null}`, and `EditorWorkbench.tsx:448` omits `mesh`/`world` from
the `saveCartDraft` payload. `StoredCartDraft` (`lib/localCartStore.ts:13-37`)
has no field for either.

So on the public demo build — the live GitHub Pages site, which is how most
people will ever try this editor — a creator can import a mesh or build an HD-2D
world, press **Save**, get **"Saved ✓"**, and have that work gone on reload.
Description and tags (`initialDescription=""`, `initialTags={[]}`,
`StaticCartEditor.tsx:125-126`) are lost the same way.

Silent, confirmed-looking data loss is the worst failure an editor has.

### D2 — "Saved ✓" is sticky and lies

`saveState` (`EditorWorkbench.tsx:384`) is set to `"saved"` on a successful
write and is never reset by a subsequent edit. Make a change after saving and
the button still reads "Saved ✓". There is no dirty flag anywhere in the app —
`grep -r "beforeunload\|isDirty\|unsaved" apps/web/src` returns nothing — so
closing the tab with unsaved work produces no warning either.

### D3 — Save failures are mute

`persist()` (`EditorWorkbench.tsx:440-515`) collapses every failure into
`saveState = "error"`, rendered as a button labelled "Retry save". A signed-out
creator gets a 401 from every endpoint and is told only to retry — forever. The
response bodies already carry good messages ("Sign in to save this cartridge.");
none of them reach the UI.

### D4 — A save is twelve non-atomic writes

`persist()` fires one `PUT` for the `.tic` and then eleven parallel sidecar
`PUT`s. Each sidecar route re-authenticates, re-reads the cart row, and issues
its own `UPDATE`. If three succeed and one 500s, the creator sees "Retry save"
over a cart that is now half-new and half-old on the server, with no way to tell
which half. There is also no optimistic-concurrency check anywhere: two tabs open
on one cart is last-write-wins, silently.

### D5 — Mesh and World are outside undo

`EditorWorkbench.tsx:364,371` keeps `mesh` and `world` in plain `useState`,
outside the history timeline. Deleting a mesh or flattening a chunk of world
terrain is unrecoverable — and `Ctrl+Z` right after appears to do nothing, or
worse, undoes an unrelated sprite edit instead. The comment is honest about the
choice; the UI gives the creator no signal that undo stops at the tab boundary.

### D6 — The WASM cartridge leaks on every editor mount

The boot effect (`EditorWorkbench.tsx:145-190`) disposes the engine only on the
race path (`loaded.dispose()` at :173, when `active` is already false). On a
normal unmount — navigating editor → home → editor — the engine that was set into
state is never disposed, so `_cbx_cart_create()`'s `tic_cartridge` (roughly 1 MB:
8 banks of tiles/sprites/map/sfx/music plus the 512 KB code buffer) is orphaned
in the WASM heap. The module itself is cached per URL (`wasmModule.ts:53`), and
WASM heaps never shrink, so this accumulates for the whole browser session.

### D7 — Dead "coming soon" branch

`LIVE_TABS` (`EditorWorkbench.tsx:70`) enumerates exactly the same eleven tabs as
`TABS` (:68), so `disabled={!live}` and the `"${tab} editor — coming soon"`
tooltip at :605/:607 (and its More-menu twin at :642) can never fire. Two constants that must be kept in sync
where one would do.

### D8 — The "More" menu is positioned once

`moreMenuPos` is captured from `getBoundingClientRect()` when the menu opens
(`EditorWorkbench.tsx:412-420`) and rendered `position: fixed`. Scrolling the tab
strip or the window leaves the menu stranded away from its button. It also has no
Escape handler and no outside-click dismissal beyond the button's `onBlur`.

---

## 3. Upgrades

### Tier 1 — Trust: never lose work (do this first)

**U1. One sidecar bundle, one endpoint, one write.**
The eleven sidecars are the source of D1, D4 and most of the editor's
maintenance cost. Today adding one requires edits in ~20 places: `CartTarget`
plus both `resolveCart` returns and the JSX in `page.tsx`; the props interface,
destructure and hand-off in `EditorWorkbench`; `WorkbenchBody`'s params;
`UseEditorHistoryArgs`, `CartSnapshot`, `snapshotsEqual`, `capture`, `apply`,
the refs block, a `useCallback` setter and the `EditorHistory` interface *and*
return object in `useEditorHistory`; the fetch list and the `ok` conjunction in
`persist`; `StoredCartDraft` and both its codecs; `ResolvedCart` and both
branches in `StaticCartEditor`; `RunOverlay`'s props and `mount` options; and a
new API route. `mesh` and `world` are what a 20-step manual checklist looks like
when someone gets to step 14.

Replace it with a registry:

```ts
// One entry per sidecar. Everything else derives from this table.
export const SIDECARS = {
  fx:        { parse: parsePostFxSettings, column: "fx",        inHistory: true },
  rig:       { parse: parseRig,            column: "rig",       inHistory: true },
  mesh:      { parse: parseMeshSidecar,    column: "mesh",      inHistory: true },
  world:     { parse: parseWorldScene,     column: "world",     inHistory: true },
  // …
} as const;
export type Sidecars = { [K in keyof typeof SIDECARS]: Parsed<K> | null };
```

Then: `page.tsx` selects the columns from the table; the workbench threads one
`sidecars` object; `useEditorHistory` snapshots `Sidecars` wholesale;
`localCartStore` serialises the same object; and `persist` sends one
`PUT /api/carts/:id` carrying bytes + sidecars, written in a single row
`UPDATE`. That collapses ~832 lines of near-identical route boilerplate across
twelve files into roughly 120, makes a save atomic (fixing D4), and makes D1
structurally impossible rather than fixed-once.

**U2. Dirty tracking, autosave, and an unload guard.**
The history hook already knows the last-committed snapshot; compare it to the
last *saved* snapshot to get a real `isDirty`. Then:
- `saveState` returns to `"Save"` on the first edit after a save (fixes D2);
- a debounced autosave (~10 s idle, or on tab switch / before Run) writes the
  draft — to `localStorage` in the demo build, to the API when signed in;
- `beforeunload` warns while dirty;
- a *local* draft is written on every history commit regardless of sign-in, so a
  crashed tab or an expired session is recoverable.

**U3. Real save errors.** Surface the first failing response's message in a
toast, and name what failed. Detect 401 specifically and offer sign-in inline
rather than discarding the work.

**U4. Dispose the engine on unmount** (fixes D6) — track the loaded engine in a
ref and dispose it in the effect's cleanup, not only on the race path.

### Tier 2 — The two missing tools

**U5. Audio preview in the SFX and Music editors.** This is the largest
functional gap in the editor. `SfxEditor` (149 lines) and `MusicEditor` (295
lines) contain no `AudioContext`, no playback, no preview of any kind — a
creator authors a volume envelope and a waveform *blind*, and can only hear the
result by pressing Run and triggering the sound in-game. Every fantasy-console
editor this competes with plays the sound on selection.

The engine can already synthesise: the player mounts the WASM core with audio.
Two routes, cheapest first:
1. **Web Audio preview** — render the sample's envelope × waveform to an
   `AudioBuffer` in JS and play it on click. Fully offline, no engine round-trip,
   works in the stub mode too, and is enough for "does this laser sound right".
2. **Engine-backed preview** — hold a hidden runtime instance and call `sfx()` /
   `music()` on it. Exact fidelity, more plumbing.

Ship (1); it is a few hundred lines and it unblocks the whole sound half of the
editor. Add a spacebar play/stop and auto-play-on-select.

**U6. Finish the SFX model.** `SFX_CHANNEL` (`SoundBank.ts:19`) already names
all four channels — `wave`, `volume`, `chord`, `pitch` — but `SoundBank` exposes
setters for volume and a *global* waveform only (`setWaveAll`), and `SfxEditor`
edits nothing else. Missing: per-tick wave, arpeggio, pitch envelopes, sample
speed, octave, and stereo. `MusicTracker` likewise has no tempo, speed, or
rows-per-track. Carts authored here therefore cannot express sounds a plain
TIC-80 cart can, which matters for a marketplace whose pitch is
TIC-80-compatibility.

### Tier 3 — Creator velocity

**U7. Keyboard shortcuts.** The editor binds exactly two:
`Ctrl+Z` / `Ctrl+Shift+Z` (`EditorWorkbench.tsx:424-438`). Nothing else — not
even `Ctrl+S`. For a tool people sit in for hours, add:
- `Ctrl+S` save, `Ctrl+Enter` / `Ctrl+R` run, `Esc` stop;
- single-key tool switching (`B` pencil, `E` eraser, `G` fill, `L` line, `U`
  rect, `O` ellipse, `W` wand) — the `ToolCapabilities` table is already the
  right place to hang a `key` field;
- `[` / `]` brush size, `1`–`9` palette index, `Alt`-drag eyedropper;
- `Ctrl+1..9` tab switching;
- a `?` overlay listing them, since none of this is discoverable otherwise.

**U8. Pixel-editor essentials.** `PixelCanvas` has a magic wand whose selection
masks other tools (good), but no marquee select, no move-selection, no
copy/paste, no flip/rotate/shift, no eyedropper tool, no zoom or pan (the canvas
is pinned to `TARGET_CANVAS_PX = 360`, so a 32×32 block draws at ~11 px cells and
cannot be enlarged), and no onion-skin or symmetry. Marquee + move + copy/paste +
flip/rotate is the smallest set that makes the tool feel finished; zoom/pan is
the highest-value single addition.

**U9. Code editor.** `CodeEditor` is a textarea over a highlight layer — a sound
choice, and the tokenizer is clean. What it lacks: find/replace, auto-indent and
bracket/`end` closing, jump-to-line, code folding, and — most valuable —
**clicking a runtime error to land on its line**. `RunOverlay` already receives
`onRuntimeError` with a message (`RunOverlay.tsx:114`); parsing the line number
out of it and linking it back to the Code tab closes the edit→run→fix loop.

Note the perf ceiling too: every keystroke re-tokenises the whole document and
re-renders one `<span>` per token. Fine at a few hundred lines, not at a few
thousand. Either memoise per-line or move to CodeMirror 6 — but only if
find/replace and folding are wanted anyway; the current approach is otherwise
worth keeping for its zero dependencies.

**Correction, from implementing it:** memoising per line is wrong as stated.
Lua's `--[[ … ]]` block comments and long strings span lines, so a line
tokenised in isolation colours the inside of a block comment as code. Doing it
properly means teaching `tokenize` to carry a line-start state — a change to the
module every tab's colouring depends on, worth making only once a cart's source
is big enough for the cost to be felt. Whole-document tokenising was kept.

**U10. Stop remounting tabs on undo.** Every tab is keyed on `revision`
(`key={`code:${revision}`}` etc.), so each undo tears down and rebuilds the
active editor, discarding tool selection, scroll position, camera, and canvas
selection. The keys are a blunt instrument for "re-read the cart". Give the
views a `useSyncExternalStore`-style subscription to the engine revision instead,
and the tab re-renders without losing the creator's place. The same applies to
bank switching (`key={`${bank}:${revision}`}`).

### Tier 4 — Performance and structure

**U11. Bound the history cost.** Each commit calls `saveTic()` on the whole
cartridge and `snapshotsEqual` byte-compares it against the previous snapshot;
`HISTORY_LIMIT = 60` full carts are retained. A well-used 8-bank cart serialises
to several hundred KB, so the timeline can hold tens of MB, and each 400 ms
coalescing window costs a full serialise + full compare. Cheap fixes, in order:
hash the bytes (FNV/xxhash) for the equality check instead of comparing them;
store deltas against the previous snapshot; or drop the limit and scale it by
observed cart size. Worth measuring before rewriting — this may be entirely fine
in practice, but nothing currently measures it.

**U12. Split the giants.** `VoxelEditor.tsx` is 1,849 lines, `MapEditor.tsx`
1,104, `SpriteEditor.tsx` 1,003, `EditorWorkbench.tsx` 892, and
`editor.module.css` is 2,383 lines shared by every tab. The shared CSS module in
particular means no tab's styles can be changed with confidence. The extraction
seams are already visible — `workbenchPanels.tsx`, `railControls.tsx` and
`toolCapabilities.ts` are exactly the right idea and just haven't been pushed far
enough.

**U13. Responsive coverage.** One `@media (max-width: 900px)` block
(`editor.module.css:1737`) carries the entire phone layout, and
`scripts/verify-editor-mobile.mjs` checks only the sprite tab. The 3D tabs
(Voxel, Mesh, World, Map-3D) have no phone story at all. Either verify them or
tell the creator on a phone that those tabs need a bigger screen — silently
shipping an unusable tab is worse than either.

**U14. Menu polish** — fix D8 by re-measuring on scroll/resize (or switching to
the CSS anchor-positioning / popover API), and add Escape-to-close.

---

## 4. Order of work (as done)

1. **D1 + U1** (sidecar registry) — kills a data-loss bug and the class it came
   from, and shrinks the save path by ~700 lines.
2. **U2 + U3 + D2** (dirty state, autosave, real errors) — the rest of "don't
   lose my work".
3. **U5** (audio preview) — the biggest single jump in what the editor can do.
4. **U7** (shortcuts) — cheapest large win in daily feel.
5. **U4, D7, D8** — small, contained.
6. **U8 / U9 / U6** — depth in each tool, in whichever order matches what
   creators are actually asking for.
7. **U10 / U11 / U12 / U13** — structural, best done once the above have settled
   the shape.

Items 1–4 are the ones I would not ship the editor publicly without.

---

## 5. What shipped, and what did not

Everything in §2 and §3 is implemented except **U12** and part of **U6**, both
recorded below with the reason rather than quietly dropped.

### Not done: U12, splitting the giant files

`VoxelEditor.tsx` (1,849 lines), `MapEditor.tsx` (1,104), `SpriteEditor.tsx`
(1,003) and the 2,383-line shared CSS module are still that size. Splitting them
is a large mechanical refactor with no behavioural payoff and a real regression
risk in files with no component-level test coverage, and it would have tripled
the size of a diff that already changes how every cart is saved. It is the right
next piece of work, and it is easier now: the workbench shed its save path
(`persistCart.ts`), its shortcut handling (`shortcuts.ts`) and its sidecar
plumbing (`lib/sidecars.ts`) along the way, and the pixel editor shed its
selection geometry (`pixelSelection.ts`).

### Partly done: U6, the SFX model

Per-tick **wave**, **arpeggio** and **pitch** are editable — the three channels
`SFX_CHANNEL` had always named and nothing could write. The sample's `speed`,
`octave` and `reverse` fields are still unreachable: they sit past the packed
`data[]` region the WASM shim exposes, so reaching them needs a new `cbx_*`
accessor in `shim.c` and an engine rebuild, which is engine work rather than
editor work. `MusicTracker`'s tempo and speed are unreachable for the same
reason.

### Worth knowing about the audio preview

`renderSfx` is the editor's own synthesis of the envelopes a creator has drawn,
not the core's mixer. It reproduces per-tick volume, waveform, arpeggio and fine
pitch over the cart's real 4-bit wavetables at the console's tick rate; it does
not reproduce channel mixing or the envelope loop hardware. That is the right
trade for "does this laser sound right", and the editor says so where a creator
can see it.

### Corrections found by reviewing the implementation

Two claims in §3 did not survive contact, and one behaviour was nearly lost:

- **U9's per-line tokenisation** is unsound; see the correction inline above.
- **The audio preview must render at the output device's sample rate**, not at
  a fixed 44.1 kHz. Rendering at 44.1 and playing through a 48 kHz device
  detunes every preview by about a semitone and a half, which for a sound
  editor is worse than no preview at all.
- **`collision` and `flags` carried missing-column tolerance** in their own
  routes, which the first cut of the registry dropped by marking only `mesh`
  and `world` optional. On a deploy running ahead of its migration that would
  have failed a creator's whole save instead of one layer. All four are marked
  optional now, and a test pins the set.

### Verification

`tsc --noEmit` clean, `next build` succeeds (28 routes), and the suite went from
1,651 to 1,794 passing tests — 143 new ones covering the sidecar registry and
its route handler, the draft store (including the mesh/world regression stated
directly), snapshot hashing and equality, the SFX synthesiser and the four
envelope channels, the selection and clipboard geometry, the code-editor text
operations, and the shortcut matcher. One pre-existing failure remains in
`neon-city-cart.test.ts`, which imports a build script that is not in this
repository; it is unrelated to the editor and was failing before this work.

`scripts/verify-editor-mobile.mjs` now walks every tab rather than the sprite
tab alone, asserts that the two tabs with no phone layout say so instead of
rendering an unusable viewport, and checks the top bar at desktop widths.

### Looking at it in a browser

The static export was built and driven with a real Chromium, which found five
layout defects no unit test could have — three of them mine:

- **Every tab showed a "forbidden" cursor.** `.tab { cursor: not-allowed }`
  existed to serve the disabled "coming soon" state; removing that state (D7)
  left the rule behind, so all five primary tabs looked unclickable.
- **The tab strip was squeezed to nothing.** It needs 407px and was getting
  287px at 1500px wide, 110px at 1280, and **zero at 1100** — an editor with no
  reachable tab navigation at all. The bar already overflowed by 80px before
  this branch; the `?` button added 28px more and tipped it over. The strip now
  takes its own row below ~1650px, the width at which it stops fitting.
- **The header row was a fixed 52px track**, so the wrapped strip rendered 28px
  *below* the bar, on top of the tab content.
- **The unsaved-work dot never rendered.** `.cbx-btn` is a global class, and a
  bare `.cbx-btn` selector inside a `.module.css` is hashed — it matched
  nothing. It needed `:global(...)`.
- **"Save •" wrapped onto two lines**, making the whole bar taller. The dot is
  drawn by CSS now, so no label can wrap.

Each is pinned by a check in `verify-editor-mobile.mjs` at 1920, 1500 and
1100px. The script needs a running server and a browser, so it does not run in
CI as things stand.
