# Engine Roadmap — from fantasy console to a web game engine

**Status:** living document. Tick the boxes and update each phase's **Status** line as work lands.
**Last updated:** 2026-09-25.

## Why this exists

Cartbox already renders well: tiered console models, PBR, image-based lighting,
shadows, SSAO, HDR and bloom (tracked in [`AAA_TIER_ROADMAP.md`](AAA_TIER_ROADMAP.md)),
plus particles, a shader editor, voxel and 3D-world tools, chip audio, netplay and
one-click publishing to the web. What it lacks, compared with Unity or Unreal
Engine 5, is mostly **how a game is structured and built**:

- There are no scene objects. A cart places meshes in the editor, then moves them
  each frame from Lua by slot number (`cartbox.meshpose(index, ...)`). Nothing has a
  name the code can find, a parent, or data of its own.
- There is no physics, navigation, skeletal animation or UI system. Lockout's
  movement, bullets, bot pathing and menus are all hand-written.
- The asset pipeline doesn't yet do what the web needs (compressed geometry and
  textures, streaming), and there is no WebGL2 fallback for browsers without WebGPU.
- There is no debugger or profiler.

This roadmap closes those gaps **for web games specifically**: small downloads,
fast first frame, phones and tablets as first-class targets, and multiplayer in the
browser.

## Guardrails

- **Existing carts keep working, byte for byte.** Every new sidecar field is
  optional; a cart that doesn't use a feature renders and plays exactly as before.
  Enforced by tests and the `check:dist` parity gate.
- **Lua stays the language.** New runtime features are exposed as `cartbox.*` SDK
  calls, injected the same way the SDK is. A second language (TypeScript) is a later,
  separate decision.
- **The web is the platform.** A feature isn't done until it works in the static
  build and on an iPad-class device, and its download cost is known.
- **Each phase ships in small PRs**, each one useful on its own.

---

## Phase 1 — Scene objects (hierarchy, inspector, prefabs)

The foundation everything else attaches to, like Unity's GameObjects or Unreal's
Actors. Today a mesh instance has an id, a name and a transform.

- [x] **Data model.** Optional `parent`, `tags` and `props` (custom properties:
      numbers, strings, booleans) on mesh sidecar entries. A child's world transform
      is its parent's world transform times its own; cycles and dangling parents are
      ignored, not fatal.
- [x] **Runtime hierarchy.** Moving a parent from Lua (`meshpose`) carries its
      children along; the static shadow cache treats a posed object's children as
      moving too.
- [x] **Lua API.** `cartbox.find(name)` returns an object's slot, `cartbox.prop(obj, key)`
      reads an authored property, `cartbox.tagged(tag)` lists objects with a tag. Code
      stops depending on slot numbers.
- [x] **Editor: Hierarchy and Inspector.** A tree of the scene's objects (rename,
      re-parent, select) and an inspector for the selected object's name, parent,
      transform, tags and properties.
- [x] **Prefabs.** Save an object and its children as a reusable asset; place
      copies; edits to the prefab flow to every copy unless overridden.
- [x] **Spawning at run time.** Each prefab keeps a reserve of copies (set per
      prefab); `cartbox.spawn(prefab, x, y, z, …)` places one — physics bodies
      included — and `cartbox.despawn` puts it back.
- [x] **Play-in-editor inspection.** The playtest's Objects panel shows every
      object's live position, visibility, body state (velocity, grounded) and
      spawn state, filterable by name or tag.

**Status:** done for this phase: data model, runtime hierarchy, Lua API, the
Hierarchy and Inspector, keep-in-place re-parenting, prefabs, run-time spawning
and live inspection. Later: nested prefabs, picking objects in the game view.

## Phase 2 — Physics

- [x] Rigid bodies (static, dynamic, kinematic) and colliders (box, sphere, capsule,
      static triangle mesh) set per object in the Inspector, simulated by Rapier
      (WebAssembly) — downloaded only for carts that have bodies.
- [x] Character controller (slides along walls, climbs slopes and steps, snaps to
      the ground, reports grounded) via `cartbox.move`.
- [x] Raycasts from Lua (`cartbox.ray` / `cartbox.hit`, one tick later), plus
      `cartbox.body`, `impulse`, `velocity`, `teleport`.
- [x] Trigger zones (`cartbox.entered` / `exited` / `inside`) and collision events
      (`cartbox.contacts`); triggers don't block characters or rays.
- [x] Per-body gravity multiplier and damping.
- [x] Shape casts: `cartbox.sweep` sweeps a sphere, box or capsule and reports
      through the same slots as rays; rays and sweeps can ignore their caster.
- [x] Joints: hinge (angle limits, a motor via `cartbox.motor`), ball, weld, spring
      and rope, set on a dynamic body in the Inspector. A joint ties the object to
      its nearest ancestor with a body (or the world), so joints work inside prefabs;
      `cartbox.unjoin` breaks one.
- [x] Deterministic mode (Mesh tab → Physics world): Rapier's cross-platform
      deterministic build, with every host-computed input rounded onto a fixed grid,
      and `cartbox.physicshash()` so players can compare states and catch a desync.

**Status:** bodies, character controller, raycasts, shape casts, triggers, contact
events, per-body gravity / damping, joints and a deterministic mode landed — Phase 2
is complete. The host runs the world at a fixed 1/60 s step and
trades state and commands with the cart through an 8 KB block at the end of RAM
(its address per engine core is checked against the real builds by a test).

## Phase 3 — Animation

- [x] Skeletal meshes: skinned on the CPU into buffers both renderers draw (the
      software reference reads them; WebGPU re-uploads a mesh when its pose changes).
      Moving the skinning itself onto the GPU is a later optimization.
- [x] glTF skin and animation-clip import (meshes parented to a bone ride on it);
      clips play by themselves (the first, looping) and switch with a crossfade from
      Lua (`cartbox.play`, `cartbox.anim`, `cartbox.clips`); the Mesh tab previews them.
- [x] Animation state machine with blending and events (walk ↔ run ↔ shoot), driven
      from Lua parameters: number / bool / trigger parameters, states playing a clip or
      a 1D blend (clips kept in step), transitions with conditions, exit times and
      crossfades, and named clip events — authored in the Mesh tab, driven with
      `cartbox.set` / `trigger` / `setstate`, read with `cartbox.state` / `events`.
- [x] Two-bone IK and look-at (feet on slopes, aiming): `cartbox.ik` bends the chain
      ending at a joint to a world-space target (toward an optional pole),
      `cartbox.lookat` turns a joint toward a point within a limit, and `cartbox.joint`
      reads a joint's world position — layered on whatever clip or state is playing.
- [x] Timeline / sequencer for cutscenes and scripted camera moves: camera, object,
      animation-cue and event tracks with linear / smooth (spline) / step easing,
      authored in the Mesh tab (camera keyed from the Scene view, scrubbed and
      previewed there), played with `cartbox.playtimeline` or on autoplay, looping or
      holding their last frame. Phase 3 is complete.

## Phase 4 — Web asset pipeline and reach

- [x] Meshopt / Draco geometry compression on glTF import: `EXT_meshopt_compression`
      and `KHR_draco_mesh_compression` files (gltfpack, gltf-transform, exporters'
      "compress" options) decode on import, in the Mesh tab and from the library. The
      WebAssembly decoders load only when a file needs one.
- [x] KTX2 / Basis textures: glTF `KHR_texture_basisu` textures import and are
      transcoded to RGBA by the official Basis Universal transcoder. A scene keeps them
      compressed only when that saves more than the transcoder costs players (~254 KB
      gzipped); otherwise they become PNG on import, and players never fetch it. Mipmaps
      aren't used: every renderer samples the top level, as it does for PNG/JPEG.
- [x] GPU instancing for repeated meshes (WebGPU): every copy of a primitive that
      binds the same textures is one instanced draw, with each copy's transforms in a
      storage buffer. The picture stays byte-identical to the software rasteriser
      (checked on a real device by `webgpu-parity.test.ts`).
- [x] Asset bundles and streaming: load a level's assets on demand, with a loading
      screen and progress.
  - [x] Textures stream after the cart starts: saved scenes keep every texture in
        the content-addressed cart asset store, and the play page starts the cart on
        geometry alone, fetching the textures from their immutable URLs with a progress
        bar and swapping each one in as it lands. The download budget shows
        "playable after".
  - [x] Levels: objects belong to named levels (or are always loaded), one level is
        current at a time, and only its objects draw and simulate. `cartbox.level("cave")`
        switches — a published cart streams that level's textures first, with a
        progress bar, and `cartbox.level()` reports the current level, the one loading
        and its progress. Levels are named and assigned in the Mesh tab.
- [x] WebGL2 fallback renderer for browsers without WebGPU: the same shading, instanced
      batching and asynchronous readback as the WebGPU path, chosen when WebGPU isn't
      available (before the software rasteriser). It is byte-identical to the software
      rasteriser on the fantasy tiers in Chromium on a hardware-precision rasteriser,
      checked by `webgl-parity.test.ts`.
- [x] Download-size and load-time budget shown in the editor per cart (⋯ → Download
      size): engine core, cartridge, 3D scene (split into geometry / textures /
      animation, heaviest meshes named), physics engine when bodies need it, other data
      and uploads — gzipped as sent — with load times on slow 4G / 4G / broadband and
      tips on what would shrink it.
- [x] Quality presets (low / medium / high) chosen per device: "auto" picks from core
      count, memory, phone/tablet and whether the GPU renderer came up. Presets set
      shadows and their map size, the first-person 3D resolution cap, and switch off
      bloom and chromatic aberration on low. Players choose in the Start menu; the
      playtest has a quality switch to preview a weak device; carts' hosts use the
      `quality` option and `setQuality()`.

## Phase 5 — Debugging and profiling

- [x] Lua debugger: breakpoints, stepping, variable watches, call stack.
      Click a line number in the Code tab to set a breakpoint; the playtest
      stops there mid-frame, showing the code around the stop, the call stack,
      the stopped function's locals and upvalues, and watch expressions
      evaluated in that scope. Continue (F8), step over (F10), into (F11) and
      out (Shift+F11). Lua can't pause from a debug hook, so the playtest adds
      a hook call at the start of each statement line (on the same line, so
      line numbers don't move) and runs `TIC` in a coroutine the hooks can
      yield from. It costs about 20 ns per statement, so the debugger is on
      only when a run starts with breakpoints, or when switched on (which
      restarts the cart).
- [x] Pause, step one frame, and time scale while playing in the editor. The
      playtest has Step (while paused) and a 0.25×–2× speed control, with a frame
      counter; sound mutes away from 1×.
- [x] Profiler: CPU (Lua vs render vs audio), GPU passes, draw calls, triangles,
      memory, network bytes. The playtest's Profiler panel shows each frame's
      main-thread time against the frame budget: the cart's tick (Lua, 2D drawing
      and chip sound run inside the engine together), physics and runtime,
      render (with the shadow map, sky and 3D scene passes), audio and network.
      It also shows the renderer's draw calls, objects and triangles, the GPU
      time of the scene pass where the browser allows timing it (WebGPU
      timestamp queries, WebGL2 timer queries), engine, scene and page memory,
      and multiplayer bytes per second.
- [x] In-editor console for `trace()` output and runtime errors, linked to code lines.
      A playtest-only prelude sends `trace()` through a debug block in free RAM
      (below the runtime block) and replaces `debug.traceback` so errors name
      cart lines with a short call stack (`line 4: … at hit:4 < TIC:12`); each
      line opens the Code tab there. Error line numbers everywhere now account
      for the injected SDK code above the cart's own.

## Phase 6 — Game systems

- [ ] **Navigation:** bake a navmesh from the scene; agents with pathfinding and
      avoidance (`cartbox.path`, `cartbox.agent`). Replaces hand-placed waypoints.
- [ ] **UI system:** anchored layouts, text, images, buttons, sliders and focus
      navigation for controllers, authored in the editor and driven from Lua.
      Menus like Lockout's Start menu become part of the game.
- [ ] **Audio:** import real sound files (Ogg/MP3), a mixer with buses, and 3D
      positional sound through Web Audio, alongside the chip tools.
- [ ] **Input actions:** named actions with per-device bindings (building on the
      Start menu's rebinding), exposed to Lua.
- [ ] **Save data:** structured saves with cloud sync for signed-in players.

## Phase 7 — Rendering extras

Tracked in detail in [`AAA_TIER_ROADMAP.md`](AAA_TIER_ROADMAP.md); listed here for
completeness.

- [ ] Clustered lighting for many lights; cascaded shadow maps.
- [ ] True HDR environments with prefiltered mips; reflection and light probes.
- [ ] Baked lightmaps.
- [ ] Terrain, foliage, decals, volumetric fog.
- [ ] A dedicated Modern-tier engine core (it currently reuses the Xbox 360 core).

## Phase 8 — Collaboration and shipping

- [ ] Real-time multi-user editing of a cart.
- [ ] Version history with named snapshots and restore.
- [ ] Authoritative server or rollback netcode for competitive multiplayer
      (today's netplay relays through Supabase Realtime).
- [ ] Export to a standalone HTML bundle / itch.io embed; installable PWA with
      offline play.
- [ ] Localization and accessibility settings (text size, colour-blind modes,
      remapping) as engine features.

---

## Suggested order

1. Scene objects (Phase 1) — everything else attaches to objects.
2. Physics (Phase 2) — the biggest saving in hand-written game code.
3. Animation (Phase 3) — needed for any character-driven game.
4. Web pipeline and WebGL2 fallback (Phase 4) — decides who can play and how fast.
5. Debugging and profiling (Phase 5) — gets steadily more valuable as games grow.

Phases 6–8 can run alongside these once their foundations exist.
