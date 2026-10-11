# Tablet editor roadmap

The editor should work as well on an iPad with fingers and an Apple Pencil as
it does with a mouse and keyboard, so an artist can model, rig and paint
Lockout's Spartans on a tablet. Each item ships as its own PR with tests.

## Where the editor stands

**Most surfaces use pointer events** (`onPointerDown`/`Move`/`Up` with pointer
capture), so a single finger or a Pencil already reaches them as a "mouse".
What a tablet can't do:

- **Orbit while modelling:** in the Mesh tab's Model mode a left drag boxes
  a selection and only the right button orbits.
- **Zoom anywhere:** zoom is the mouse wheel. There is no pinch.
- **Use a second finger:** it lands as another pointer and restarts or
  corrupts the drag.
- **Hold a key:** add, subtract and loop selection are Shift, Ctrl and Alt
  clicks, and some menus are right-clicks.
- **Press:** nothing reads the Pencil's pressure or tilt. The texture and
  weight brushes paint at one strength.
- **Hit a small target:** picking radii and buttons are sized for a mouse,
  and nothing is styled for coarse pointers.
- **Rest a palm on the screen:** a palm while drawing with the Pencil reads as
  input.

The modelling keys (1/2/3, G/R/S, A, Escape, Delete) and undo already have
on-screen buttons.

## Conventions

These follow the iPad 3D and painting apps (Nomad Sculpt, Shapr3D,
Procreate), so they feel familiar.

- **The Pencil is the tool:** select, box-select, drag a gizmo, paint, pose.
  Its **pressure** scales a brush's strength and size, and **hovering** (a
  Pencil that hovers) shows the brush where it would land.
- **Fingers:**
  - **One finger** draws or selects until a Pencil is first used. After that
    it navigates (orbit in 3D, pan in 2D) and never draws, which is palm
    rejection. A tap still picks.
  - A **Fingers** toggle on the touch bar forces either way.
- **Two fingers:** drag orbits (pans in 2D views), pinch zooms.
- **Taps:** two-finger tap undoes, three-finger tap redoes.
- **Long press:** whatever right-click or Alt-click does there.
- **Touch bar:** shown once touch or a Pencil is used.
  - **Add**, **Remove** and **Loop** toggles stand in for Shift, Ctrl and Alt.
  - Undo, redo and the Fingers toggle sit beside them.

**Pencil Pro.** Squeeze and barrel roll are not available to web pages. Safari
does not deliver them to websites. Pressure, tilt and hover are, and the
editor uses them. If a future Safari reports barrel roll as the pointer's
`twist`, the brush can turn with it.

## Items

- [x] **T1. A tablet input layer, and the Mesh tab on a tablet.**
  - **Input layer** (`apps/web/src/lib/tabletInput.ts`, pure and tested):
    - **Samples:** pointer kind, pressure, tilt, twist, hover.
    - **Picking:** how far a pick reaches per kind (mouse, Pencil, finger).
    - **Gestures:** a recogniser that turns raw pointers into tool strokes,
      orbit/pan, pinch zoom, undo/redo taps and long presses. It does palm
      rejection, holds back a finger until it is clearly drawing, and cancels
      a stroke a second finger turns into a gesture.
  - **Touch bar:** with the modifier toggles.
  - **Mesh tab:**
    - **Navigation:** Pencil or finger tools in every Edit mode, finger orbit
      and pinch zoom.
    - **Picking:** picks reach further for a finger.
    - **Long press:** loop-selects.
    - **Brushes:** pressure scales the weight and texture brushes.
    - **Pencil hover:** shows the brush.

  *Tests:* the recogniser, driven with recorded pointer sequences.
  - **Strokes:** a Pencil stroke under a resting palm is one stroke, the palm
    ignored.
  - **Gestures:**
    - two fingers pinch and orbit;
    - a finger that becomes a pinch cancels its stroke;
    - two- and three-finger taps undo and redo;
    - a long press fires once.
  - **Pressure:** soft and hard Pencil strokes paint weights and texels
    proportionally.
  - **End to end:** headless Chromium, with real touch and pen events
    (`Input.dispatchTouchEvent`, pen `Input.dispatchMouseEvent` with
    force), on the Lockout cart's Mesh tab.

  *Done:*
  - **The layer:**
    - `tabletInput.ts` holds the samples, `strokePressure` (a gentle curve
      with a floor) and the pick reach (8, 11 and 24 px for a mouse, a Pencil
      and a finger).
    - `GestureRecognizer` holds a finger back until it moves past 8 px, so
      a tap picks and a drag strokes. A second finger cancels a stroke
      already begun and becomes a gesture.
    - `useTabletGestures.ts` shares state across the editor: Pencil
      seen, modifier toggles, the Fingers setting, and the workbench's
      undo/redo. Its `useGestures` hook wires the recogniser to a canvas,
      with a timer for long presses.
  - **The touch bar** (`TouchBar.tsx`) appears on the first touch or Pencil
    contact anywhere in the editor. It has Add, Remove and Loop (Shift, Ctrl
    and Alt), Fingers (auto, draw, navigate) and undo/redo, all 44 px
    targets.
  - **The Mesh tab's viewport:**
    - **Gestures:** every Edit mode takes the recogniser; two fingers orbit
      and pinch to zoom; a long press in Model mode is the Alt-click
      loop/ring select; a hovering Pencil moves the weight brush.
    - **Picks** (elements, edges, bones and gizmo handles) reach by pointer
      kind.
    - **Cancelling:** a cancelled stroke puts back its texels, weights, pose
      or gizmo drag.
    - **Clicks:** Ctrl-click removes from the selection, like Ctrl on a
      box, so the touch bar's Remove works on taps.
  - **Pressure:**
    - The weight brush's strength follows it.
    - The texture brush's size (down to 40%) and opacity follow it, set by
      a "Pencil pressure" choice: both, size, opacity or nothing. That
      applies on the model and in the UV view.

  *Tests:*
  - `tablet-input.test.ts` (15 tests) covers samples and pressure, pick
    reach, modifiers, the pressure brush, and the recogniser.
  - **The recogniser cases:** a mouse with its right button; a Pencil
    stroke under a resting and moving palm; a palm already down when the
    Pencil lands; tap versus stroke; a stroke turned into a pinch; two-
    and three-finger pans; undo and redo taps; long press; one finger
    navigating once a Pencil is used; hover; cancel.
  - `scripts/verify-editor-tablet.mjs` drives the Lockout cart's Mesh tab
    in an iPad-sized headless Chromium, with real touch and pen events.
    All 10 checks pass:
    - spreading two fingers zooms in (the model's share of the view goes
      from 5.2% to 34.8%), and a pinch edits nothing;
    - the touch bar appears, and two fingers orbit;
    - a tap selects; a long press selects the same 4-face ring as an
      Alt-click, where a tap selects 1 face;
    - a Pencil stroke under a moving palm is one undoable edit, and a
      two-finger tap undoes it;
    - a firm Pencil stroke changes the heat map 4.8 times as much as a
      light one;
    - the palm moved nothing.
  - **Against main without this item,** the pinch, the touch bar and the
    two-finger undo fail. The pinch actually shrank the model, from 5.2% to
    3.7%, as the two fingers fought as one drag.
- [x] **T2. Painting on a tablet.**
  - **Pencil:** the sprite pixel canvas, the map canvas and the texture
    painter's UV view take the Pencil as the brush, with fingers panning and
    pinch-zooming, and palm rejection.
  - **Pressure:** scales the texture painter in the UV view as on the model.
  - **Long press:** picks a colour (the eyedropper).

  *Done:*
  - **The canvases:** the sprite pixel canvas (Assets), the Voxel tab's
    sprite pad, the 2D map canvas and the UV view all take their input
    through the T1 recogniser, so:
    - the Pencil (or a mouse) is the brush;
    - one finger draws until a Pencil is used, then navigates;
    - a resting palm is ignored.
  - **Navigation:**
    - **Sprites:** two fingers scroll the panel, and a pinch zooms within
      the zoom slider's range.
    - **Map:** two fingers scroll the map, and a pinch steps through its
      S, M, L and XL zooms, one step per 25% of spread.
    - **UV view:** it now zooms (1× to 8×) inside a square that scrolls. A
      pinch keeps the point between the fingers in place, and two fingers
      pan.
  - **Cancelled strokes:** a stroke that a second finger turns into a
    gesture is put back.
    - **Sprites and the pad:** only the pixels the stroke changed are
      rewritten, because writing a pixel through the material surface
      re-stamps its material channels.
    - **Map:** each cell (or, on the pixels layer, each tile) is recorded
      the first time the stroke touches it. A stroke on a large map costs
      what it paints, not the map's size. Mouse strokes and fills skip the
      record.
  - **Long press:**
    - **Sprite canvas:** picks the colour, as Alt and the picker do.
    - **Map:** picks the colour on the pixels layer and the tile, as the
      brush, on the tiles layer.
    - **UV view:** picks the layer's colour or value (a new `pick` on the
      texture paint state).
    - **Sprite pad:** erases, as its right-click does.
  - **Pressure in the UV view** came with T1.

  *Tests:* `scripts/verify-editor-tablet-paint.mjs` drives an iPad-sized
  headless Chromium with real touch and pen events. All 14 checks pass.
  - **Sprites:**
    - one finger draws before a Pencil is used, and draws nothing after;
    - a stroke turned into a two-finger gesture is put back exactly;
    - a long press picks the painted colour;
    - spreading two fingers zooms 360 → 1440 px;
    - a Pencil stroke paints under a moving palm, and the palm paints
      nothing.
  - **Map:**
    - a cancelled stroke is put back;
    - a Pencil stroke paints under a palm;
    - a pinch steps the zoom (20480 → 30720 px);
    - two fingers scroll it.
  - **UV view:**
    - a Pencil stroke paints;
    - a long press picks the painted, blended colour (#cead89, which the
      view shows there);
    - a pinch zooms 236 → 400 px.

  **Against T1 without this item,** 10 of the 14 fail. A cancelled stroke
  stays painted, long presses pick nothing, pinches and two-finger pans do
  nothing, and once a Pencil is used fingers still draw. The palm, too,
  paints.

  The map ran in a GPU-less Chromium at first: the starter cart's map is
  1280 × 720 tiles, and that canvas crashed SwiftShader (on main as well),
  and at the L and XL zooms it was wider than a canvas can be. T4 fixes
  both.
- [x] **T3. The other views on a tablet.**
  - **Pinch zoom and two-finger navigation:** the Scene viewport, 3D map,
    voxel editor, scene play view, node graphs (graph, shader, script),
    curve editor, dope sheet and timeline.
  - **Long press:** where right-click opens a menu.

  *Done:*
  - **An adapter for views with mouse handlers of their own.**
    `useViewGestures` (in `useTabletGestures.ts`) puts a view's existing
    pointer handlers behind the recogniser, so the mouse and the Pencil
    behave exactly as before. For touch:
    - **Fingers:** one finger draws or picks until a Pencil is used.
    - **Navigation:** two fingers (or one, once a Pencil is used) move the
      view by driving its own navigation drag with a virtual pointer. Each
      view names that drag (`orbitDrag`, `panDrag`), so a finger orbit
      feels exactly like the mouse's.
    - **Pinch:** turns the view's own wheel, one notch per 12% of spread.
    - **Long press:** a right click (and a `contextmenu` event).
    - **Cancelled strokes:** a stroke a second finger turns into a gesture
      is ended without acting.

    It needed two small additions:
    - the recogniser's `nav-end` event, so the virtual drag ends when the
      fingers lift or a Pencil takes over;
    - the layer's `accept` and `passThrough` options, so a graph's nodes,
      ports and wires keep their own pointer handling while the background
      takes gestures.
  - **The views:**
    - **Scene viewport:** two fingers orbit (as Alt-drag), three pan (as
      the middle button), and a pinch dollies. A cancelled gizmo drag puts
      the objects back.
    - **Voxel editor:** a tap edits, two fingers orbit, a pinch zooms, and
      a long press removes, as its right-click does.
    - **3D map:** a tap edits, two fingers orbit, three pan (as Shift-drag),
      a pinch zooms, and a long press is the right click.
    - **Post-processing preview and the scene play view's free camera:**
      orbit, pan and dolly the same way.
    - **Material and script graphs:**
      - one or two fingers pan the background, and a pinch zooms about the
        fingers;
      - a finger still drags nodes and wires.
    - **Curve editor and dope sheet:**
      - fingertip-sized hit areas: 20-unit handles round the curve's
        handles, and a 27 px square round each 9 px key;
      - a key drag doesn't scroll the page.
    - **Timeline:** all buttons and sliders (T4 sizes them).
  - **Long press on buttons:** iPad Safari never sends `contextmenu` for a
    long press. `longPressProps` gives a button one, and the material
    picker's sprite chips use it for their right-click remove.

  *Tests:*
  - `tablet-input.test.ts` covers `nav-end`: after a two-finger move or tap,
    after a one-finger navigation (not after a tap), and when a Pencil
    lands mid-navigation.
  - `scripts/verify-editor-tablet-views.mjs` drives an iPad-sized headless
    Chromium with real touch events. All 14 checks pass:
    - **Voxel editor:**
      - two fingers orbit, and a pinch zooms (the model's share of the
        view goes from 1.6% to 5.4%), both editing nothing (9 voxels before
        and after);
      - a tap adds a voxel (9 → 10), and a long press there removes it
        (10 → 9).
    - **Scene viewport:** two fingers orbit, three fingers pan, and a pinch
      dollies, all without an edit. The pinch is exactly the wheel: 9 wheel
      notches out put back every pixel. The scene is compared through
      screenshots, because a WebGL canvas can't be read back reliably.
    - **Material graph:**
      - one finger pans the background, and two fingers pan;
      - a pinch zooms (grid 20 → 30 px);
      - a finger drags a node by its header (156 → 227 px).
  - **Against T2 without this item,** 5 of the 14 fail:
    - pinching zooms none of the three views (two fingers just fought as
      two drags);
    - a long press adds a voxel (10 → 11) instead of removing one;
    - a finger can't drag a graph node.

    The rest guard what already worked with one finger and must keep
    working.
- [x] **T4. Layout for touch.**
  - **Sizing:** under `(pointer: coarse)`, buttons, list rows, sliders and
    rails at 44 px targets.
  - **Panels:** collapse to fit an iPad in portrait. Already at an iPad's
    1180 px landscape width, the Mesh tab's Edit modes overflow the rail
    (Paint is clipped), and a large map's widest zooms exceed a canvas.
  - **Canvases:** no page zoom, text selection or callouts.
  - **Keys:** an on-screen equivalent for each remaining keyboard-only
    action, listed in the shortcut help.

  *Done:*
  - **The 2D map on an iPad.** The map canvas was the size of the whole map.
    iPad Safari won't make a canvas over 16.7M pixels, and the starter
    cart's 1280 × 720-tile map is 59M at the smallest zoom, so the Map tab
    drew nothing on an iPad at any zoom. (Its canvas also crashed headless
    SwiftShader.)
    - **The fix:** the canvas now covers only the part of the map in view,
      plus a margin. Drawing stays in map pixels through a translated
      context, and the window moves as the map or the page scrolls.
    - **Cost:** redraws touch only the cells in view, so painting a tile
      no longer rescans 921k cells.
  - **Sizing:** under `(pointer: coarse)`, which an iPad reports even with
    a Pencil:
    - every button, select and input in the editor is a 44 px target;
    - segments are 38 px in their 3 px track, so the track is 44 px;
    - colour inputs are 44 px, and checkboxes are 22 px;
    - sliders get a 44 px box.

    Exempt: the packed picker grids (palette swatches, sprite tiles), where
    the grid is the target, and buttons on a gesture surface (a graph node's
    header).
  - **Panels:**
    - **Mesh tab rail:** its two asides had inline widths wider than the
      workbench's 200 and 300 px tracks, so the rail spilled under the
      stage and was clipped (on desktop too). They now take their tracks,
      and the Edit modes wrap.
    - **3D tabs on a tablet:** they used to hide below 900 px wide, because
      a pinch orbit would fight the page. With the gesture layer holding
      the page still, they now hide only on a phone (under 600 px wide or
      500 px tall), so an iPad in portrait gets the Mesh, Scene and other
      3D tabs.
    - **Portrait order:** the stacked layout puts their viewport first, as
      it already did the sprite canvas, and drops the rail-collapse
      chevrons, which have no edge to sit on there.
    - **Touch bar:** folds away to one button when it covers something.
  - **Canvases:** every gesture surface carries `data-tablet-gestures`.
    The stylesheet gives those surfaces and every canvas no text selection,
    no press-and-hold callout and `touch-action: none`. Since iPad Safari
    can still pinch the page through `touch-action`, the touch bar's
    listener cancels touch moves and Safari's `gesture*` events that start
    on a surface. Elsewhere the page still zooms, for whoever needs it.
  - **Keys:**
    - **Selection bar:** the sprite selection's keyboard-only verbs are now
      buttons that share the keys' code: copy, cut, paste, flip, rotate,
      nudge, erase and clear.
    - **Everything else** in the shortcut help already had a button: the
      File menu, undo/redo, Run, the tabs, the tool rail, the brush slider
      and Play.
    - **The help** gains an "On a tablet" group listing the gestures.

  *Tests:* `scripts/verify-editor-tablet-layout.mjs` runs an emulated iPad
  (touch, coarse pointer, 2× pixels) and a phone. All 11 checks pass:
  - **Landscape:**
    - the pointer is coarse;
    - every control on the Assets, Map and Mesh tabs is a 44 px target;
    - the Mesh Edit modes sit inside the rail, clear of the stage, and
      Paint taps;
    - canvases are gesture surfaces with no selection or page gestures;
    - the sprite selection's Flip button changes the art, and Copy offers
      Paste.
  - **Portrait:**
    - nothing runs off the side;
    - at every map zoom, scrolled to the map's middle, the canvas is
      1.3–1.6M pixels (under iOS's 16.7M) and draws;
    - the Mesh tab opens with its viewport first on the page.
  - **Phone:** the 3D tabs still say they need a larger screen.

  **Against T3 without this item:**
  - the tabs, the cart title and many other controls are 25–33 px tall;
  - tapping the Map tab hangs the page on its 59M-pixel canvas, so the
    run stops there.

  The T1–T3 scripts still pass on top of this. Two T2 checks were made
  robust to the taller controls, which let the sprite panel scroll and move
  the UV view as the colour field scrolls into view. The map checks now run
  on the GPU browser too, which crashed before.

## Not in this roadmap

- **Pencil Pro squeeze and barrel roll, and Pencil double-tap:** not exposed
  to the web (see Conventions).
- **A native iPad app.**
