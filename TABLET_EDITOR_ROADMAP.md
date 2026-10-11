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

  The map runs in a GPU-less Chromium: the starter cart's map is
  1280 × 720 tiles, and that canvas crashes SwiftShader (on main as well).
  At the L and XL zooms it is wider than a canvas can be, so it draws
  blank. T4 should cap the zoom for large maps.
- [ ] **T3. The other views on a tablet.**
  - **Pinch zoom and two-finger navigation:** the Scene viewport, 3D map,
    voxel editor, scene play view, node graphs (graph, shader, script),
    curve editor, dope sheet and timeline.
  - **Long press:** where right-click opens a menu.
- [ ] **T4. Layout for touch.**
  - **Sizing:** under `(pointer: coarse)`, buttons, list rows, sliders and
    rails at 44 px targets.
  - **Panels:** collapse to fit an iPad in portrait. Already at an iPad's
    1180 px landscape width, the Mesh tab's Edit modes overflow the rail
    (Paint is clipped), and a large map's widest zooms exceed a canvas.
  - **Canvases:** no page zoom, text selection or callouts.
  - **Keys:** an on-screen equivalent for each remaining keyboard-only
    action, listed in the shortcut help.

## Not in this roadmap

- **Pencil Pro squeeze and barrel roll, and Pencil double-tap:** not exposed
  to the web (see Conventions).
- **A native iPad app.**
