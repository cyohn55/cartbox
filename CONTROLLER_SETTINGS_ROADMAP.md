# Controller settings roadmap

A game's Start menu should let a player tune how every input device plays, as
Halo Infinite and Call of Duty do. That covers how far a stick moves before it
counts, how lean turns into turning, how fast the view can turn and how aim
assist behaves, on a controller, on a touchscreen and with a mouse. Each item
ships as its own PR with tests.

## Where the controls stand

`packages/player/src/controls.ts` holds the settings and the pure transforms;
the Start menu (`apps/web/src/app/lockout/StartMenu.tsx`) edits them.

**What a player can set today:**
- invert the look stick's vertical axis;
- one look sensitivity (0.25–3), which scales the right stick before the game
  reads it;
- controller button mapping, in two presets or one by one;
- keyboard keys, and the game's input actions (EP15);
- the on-screen pad's size and opacity.

**What is fixed:**
- **Dead zones:** a controller stick has a radial dead zone of 0.18, and a
  touch stick 0.12.
- **Triggers:** they press past half-way.
- **Sensitivity:** it only makes the stick reach full lean sooner. The stick
  goes to the game as −1..1, so nothing turns faster than the game's own
  maximum (C2 lifts this for a game that reads its look gain).
- **Response curve:** the game applies its own. Lockout eases its turn as
  lean², and its pitch the same way.
- **Aim assist:** Lockout's auto-aim (pitch eased toward a locked enemy) is
  always on (C3 makes it a setting).
- **Zoom:** held, never toggled (C3 lets any action toggle).
- **No vibration** (C3 adds it).
- **No mouse look and no gyro** (C4a adds the mouse; C4b the gyro).

## Inspiration

**Halo Infinite (controller):**
- look sensitivity, horizontal and vertical separately;
- look acceleration;
- per stick: axial dead zone, radial dead zone and max input threshold;
- zoom sensitivity;
- invert look;
- button and stick layouts;
- hold or toggle for zoom, crouch and sprint;
- vibration.

**Call of Duty (controller):**
- horizontal and vertical stick sensitivity;
- ADS sensitivity multipliers;
- an aim response curve (Standard, Linear, Dynamic);
- left and right stick minimum and maximum dead zones;
- L2/R2 trigger dead zones;
- stick layouts (Default, Southpaw, Legacy, Legacy Southpaw);
- aim assist (off, or one of several types);
- vibration, and hold or toggle per action;
- gyro aiming on supported pads and phones.

## Conventions

- **Host-side by default.** Everything that can be done in the player (dead
  zones, curves, layouts, triggers, toggles) applies to every cart without
  the cart doing anything.
- **Opt-in for the rest.** What needs the game to cooperate (turning faster
  than its own maximum, zoom sensitivity, aim assist strength) goes through a
  small SDK call the cart opts into, as `cartbox.stick` already does. A cart
  that never calls it plays exactly as before.
- **Pure and tested.** The transforms are pure functions over plain numbers,
  unit-tested without a DOM or a gamepad.
- **Saved settings still load.** Settings saved before a change load as
  before, and a new field falls back to its default.

## Items

- [x] **C1. Stick tuning.**
  - **Per physical stick (left and right), as Halo and CoD have them:**
    - an axial dead zone (each axis on its own, so a straight push stays
      straight);
    - a radial dead zone (the stick's distance from centre);
    - a max input threshold: how far out counts as full lean.
  - **Look:**
    - horizontal and vertical sensitivity separately;
    - invert horizontal as well as vertical;
    - a response curve: Standard, Dynamic (an S-curve: fine near centre,
      steepest mid-way), Precision (slower near centre) or Responsive
      (quicker off centre).
  - **Stick layout:** Default, Southpaw (sticks swapped), Legacy (left stick
    moves and turns, right stick strafes and looks up and down) and Legacy
    Southpaw.
  - **Triggers:** how far LT and RT must be pulled to press.
  - **The Start menu's controller section:** these settings, and a live
    picture of each stick. It shows the raw position, the dead zones and
    threshold, and what the game receives.
  - **Done.**
    - **The pipeline:** `readPad` shapes each physical stick with
      `shapeStick` (axial, then radial between the dead zone and the max
      input, rescaled), then maps the sticks to move and look with
      `layoutSticks`. Dead zones belong to the physical stick, so a drifting
      stick keeps its fix in any layout. `applyLookSettings` then curves the
      look stick's distance (keeping its direction), scales each axis by its
      sensitivity and inverts it; that applies to the touch pad's look stick
      too. Triggers press at their own pull; a trigger that only reports on
      or off presses when on.
    - **Saved settings:** every new field is optional and defaults to how the
      controls always played (a 0.18 radial dead zone, half-way triggers,
      Standard, Default). A save from before them loads with vertical
      sensitivity following horizontal. Values out of range are clamped, and
      full lean always lies at least 0.1 past the dead zone.
    - **The menu:** the Controls tab has Look (both sensitivities, the
      curve, both inverts), Controller sticks (layout, the live picture,
      three sliders per stick) and Triggers, with a reset for just those.
      The live picture polls the first connected pad while the menu is open
      and draws each stick's raw position (hollow), its reading after the
      dead zones (filled), the zones and the full-lean ring, each trigger's
      pull against its press point, and the move and look the game receives.
      The touch pad's size and opacity moved to their own Touch tab, and
      Button mapping gained a reset for buttons and keys.
    - **Still capped here:** sensitivity above 1 only reaches full lean
      sooner, as before; C2 lifts the cap for a game that reads its look
      gain.
    - **Tests:** `Unit Tests/stick-tuning.test.ts` (dead zones, curves,
      sensitivity and inversion per axis, layouts, triggers, old saves);
      `scripts/verify-controller-settings.mjs` drives the menu in Lockout
      with a fake controller and checks what the game receives as the
      layout, a dead zone and a trigger pull change, and that they are kept.
- [x] **C2. Look speed the game honours.**
  - **A look-gain channel:** `cartbox.lookgain(zoomed)` returns horizontal and
    vertical multipliers the host writes before every tick. A cart that calls
    it multiplies its turn rate by them, so sensitivity above 1 really turns
    faster, and the host stops pre-scaling the stick.
  - **Zoom sensitivity:** a multiplier applied while the game says it is
    zoomed, like CoD's ADS sensitivity.
  - **Look acceleration, as Halo has it:** holding the look stick at full lean
    ramps the turn speed up after a short delay.
  - **Lockout uses it.**
  - **Done.**
    - **Where the gains travel:** pmem is full and the input block's 16
      bytes are taken, so the gains share the stick channel's opt-in word,
      pmem 69. `cartbox.lookgain` writes a second magic there ("STK2"); from
      the next tick the host writes the gains in its place (horizontal,
      vertical and zoom, each ×32 in a byte so ×3 at full acceleration
      fits, under a six-bit marker with two bits kept for C3), and
      `cartbox.stick` leaves either alone. A cart that only calls
      `cartbox.stick` still sees "STK1" and gets the stick pre-scaled, as
      before.
    - **The host:** `feedSticks` reads the channel with `stickChannel`. For
      a gain cart it sends the look stick curved and inverted but unscaled,
      and packs `lookGains` (each sensitivity times the acceleration boost,
      and the zoom multiplier). A replay feeds no sticks and plain gains.
    - **Look acceleration:** held at 95% lean or more for 9 ticks (0.15 s),
      the boost eases up over 30 ticks to 1 + the setting (0–10 in the menu,
      0 by default).
    - **Lockout:** it turns by `rx·|rx|·TURN·2.2·gh` and pitches by
      `ry·|ry|·0.045·gv`, with `gh, gv = cartbox.lookgain(p.zoom)`.
    - **The menu:** the Look section gains Zoom sensitivity (×0.25–2) and
      Look acceleration, and the live picture shows the turn and pitch speed
      beside the look stick. Its note says which settings the game reads.
    - **Tests:** `Unit Tests/look-gain.test.ts` (the gain word, the
      channel, the unscaled stick, acceleration, saves);
      `Unit Tests/analog-sticks.test.ts` runs the real engine: `lookgain`
      returns the host's gains (times zoom when zoomed), `stick` leaves them
      in place, and Lockout turns twice as far at ×2.
- [x] **C3. Aim assist, hold or toggle, and vibration.**
  - **Aim assist:** Off, Standard or Strong, read by the cart
    (`cartbox.aimassist()`). Lockout scales its auto-pitch by it and slows the
    turn near a target.
  - **Hold or toggle per input action** (zoom, for one), done in the host:
    a toggled action latches on a press.
  - **Vibration:** on or off, plus an intensity, through the Gamepad API's
    rumble. `cartbox.rumble(strength, ms)` lets a game ask for it; Lockout
    rumbles when it fires, takes a hit and lands a melee.
  - **Done.**
    - **Aim assist:** the level (0 off, 1 standard, 2 strong) rides in the
      two bits C2 kept in the gain word's marker byte, so
      `cartbox.aimassist()` reads it for a cart that calls `lookgain`, and
      answers 1 before then. In Lockout, Standard is how it always played.
      Off stops the auto-aim's pitch nudge once the player has aimed by hand.
      Strong doubles that nudge and slows the stick's turn by 30% while a
      locked enemy is in the aim cone (aim friction). Keyboard play, which
      has no pitch control, keeps its pitch easing at every level.
    - **Hold or toggle:** `applyActionToggles` runs in the host's
      `heldActions`. A toggled action flips on each new press of its
      controls, whichever device presses it. What it returns is the mask a
      replay records, so replays play toggles back as they were. The menu
      sets each action under Button mapping → Actions, and Reset actions
      clears the toggles.
    - **Vibration:** `cartbox.rumble` emits mailbox event 5 (strength ×255,
      ms). The player plays it itself, as well as passing it to `onEvent`.
      `rumbleEffect` applies the player's vibration switch and strength and
      caps it at 1.5 s, and the controller in use plays a `dual-rumble`. On
      a touch device with no controller, `navigator.vibrate` buzzes for the
      strong ones (strength 0.5 or more). Nothing rumbles in a replay or
      under the menu. Lockout rumbles lightly for a shot (a little more for
      the shotgun's spread), strongly for a melee, and for a hit by how much
      it took. It watches its own shields and health fall, so it works
      online too.
    - **Tests:** `Unit Tests/aim-assist-toggle-rumble.test.ts` covers
      toggles latching, the rumble effect, the rumble event, the aim assist
      bits and saves. `Unit Tests/analog-sticks.test.ts` checks that
      `aimassist` reads the level and `rumble` reaches the mailbox in the
      real engine. `Unit Tests/input-actions.test.ts` checks that Lockout
      asks for a rumble when it fires. `scripts/verify-controller-settings.mjs`
      sets zoom to toggle, then plays a match with a fake controller and
      checks that firing plays a `dual-rumble` on it.
- [x] **C4a. Every device its own: profiles and the mouse.**
  - **Device profiles:** the look settings (sensitivity, curve) are kept
    separately for a controller, for touch and for the mouse. Each device's
    input is shaped by its own before it reaches the game.
  - **Mouse look on a computer:** click to capture the pointer, and the mouse
    turns and pitches through the look-gain channel, with its own sensitivity
    and curve.
  - **Done.**
    - **Profiles:** `touchLook` and `mouseLook` each hold a sensitivity per
      axis and a curve; the controller's are the top-level settings.
      Inversion, zoom sensitivity, look acceleration and aim assist stay the
      player's, shared. `GamepadState.lookDevice` says which device is
      looking this tick: whichever leans further, with the mouse winning
      while it moves. `feedSticks` shapes the look with that device's profile
      (`lookProfileFor`) and sends its gains. A save from before loads with
      touch looking exactly as the controller did. Dead zones stay per
      physical stick (C1), so they are already the controller's alone.
    - **The mouse:** `MouseLook` (`mouseLook.ts`) captures the pointer on a
      click when the player has mouse look on; that click doesn't also
      fire. While captured, each tick's movement becomes look lean at 12 px
      per tick for full lean (`mouseLean`), and the buttons become keys
      (`Mouse0` left, `Mouse1` middle, `Mouse2` right) that any input action
      can bind. Lockout binds left click to fire and right click to zoom.
      The mouse profile starts on Responsive (√lean), so a game that eases
      its turn by lean², as Lockout does, turns in step with the mouse. Look
      acceleration is a stick's and never applies to the mouse. The menu,
      Esc and turning mouse look off all let the mouse go.
    - **The menu:** a Mouse tab (mouse look, its sensitivity per axis and
      curve) and a Look section on the Touch tab.
    - **Tests:** `Unit Tests/device-look.test.ts` (profiles, old saves, mouse
      lean, which device looks);
      `scripts/verify-controller-settings.mjs` turns mouse look on, checks
      that a click captures the mouse (pointer lock faked, as headless has
      none) and that a left click fires in a Lockout match.
- [x] **C4b. Touch and gyro.**
  - **Touch:**
    - look by dragging anywhere on the right of the screen;
    - a fixed or floating move stick (one that appears where the thumb lands).
  - **Gyro aim on phones and tablets:** turning the device aims, always or
    only while zoomed. It has its own sensitivity, and asks the motion
    permission iOS needs.
  - **Done.**
    - **Drag to look:** with the touch pad set to look by dragging, a
      transparent zone over the right of the screen (under every control)
      takes one finger in place of the right stick. The drag since the last
      tick becomes the touch look stick: 2% of the screen's shorter side
      reads as full lean (`dragLean`), so it is the same on any screen.
      It looks with the touch profile, and look acceleration leaves it
      alone.
    - **Floating stick:** a zone over the left of the screen brings the move
      stick to wherever the thumb lands, and the thumb drives it from there
      (the stick's `grab`, tracked on the zone). On release it goes home.
    - **Gyro aim:** `GyroLook` (`gyroLook.ts`) reads DeviceMotion's rotation
      rate while gyro aim is on, on a touch device. `gyroLean` maps it to the
      screen whichever way the device is held (screen.orientation.angle):
      turning right looks right, tilting the top away looks up. Full lean is
      150°/s, and below 3°/s reads as still. It looks with its own profile
      when it turns further than the sticks lean. "Only while zoomed" follows
      the game's input action named `zoom`, held or toggled on. Turning it on
      in the menu asks iOS for motion (`askMotionPermission`); if refused,
      the menu says so. The direction mapping comes from the DeviceMotion
      axes and is unit-tested per orientation; it has not been tried on a
      phone in hand.
    - **The menu:** the Touch tab gains Look with (stick or drag), Gyro aim
      with its own sensitivity and curve, and Floating move stick.
    - **Tests:** `Unit Tests/device-look.test.ts` (drag lean, the gyro per
      orientation, tremor, its profile, saves). `scripts/verify-touch-look.mjs`
      plays Lockout on a landscape phone with real CDP touches. It checks the
      look zone replaces the right stick, a drag plays, the move stick comes
      to the thumb and goes home, and motion is read without error.

## Not in this roadmap

- **Per-weapon sensitivity, and per-zoom-level multipliers beyond one zoom
  level:** Lockout has one zoom.
- **Pad-specific features the web cannot reach:** adaptive triggers, paddles
  and touchpads.
