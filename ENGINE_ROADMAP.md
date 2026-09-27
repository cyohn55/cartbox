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
- [ ] **Play-in-editor inspection.** While the cart runs in the editor, select an
      object to see its live transform and properties.

**Status:** in progress. Landed: the data model, runtime hierarchy, Lua API
(`cartbox.find / prop / tagged / hastag / parent / children / objname / objects`),
the Mesh tab's Hierarchy tree plus Parent, Tags and Properties in the Inspector,
re-parenting that keeps an object where it is in the world, and prefabs (save,
place, apply to all copies keeping each copy's own changes, revert, unlink).
Next: live inspection while playing, and spawning prefab copies from Lua at run
time.

## Phase 2 — Physics

- [x] Rigid bodies (static, dynamic, kinematic) and colliders (box, sphere, capsule,
      static triangle mesh) set per object in the Inspector, simulated by Rapier
      (WebAssembly) — downloaded only for carts that have bodies.
- [x] Character controller (slides along walls, climbs slopes and steps, snaps to
      the ground, reports grounded) via `cartbox.move`.
- [x] Raycasts from Lua (`cartbox.ray` / `cartbox.hit`, one tick later), plus
      `cartbox.body`, `impulse`, `velocity`, `teleport`.
- [ ] Trigger volumes, shape casts and collision events.
- [ ] Joints (hinges, springs) and per-body gravity / damping settings.
- [ ] Deterministic mode across browsers for netplay (Rapier's deterministic build).

**Status:** foundation landed. The host runs the world at a fixed 1/60 s step and
trades state and commands with the cart through an 8 KB block at the end of RAM
(its address per engine core is checked against the real builds by a test).

## Phase 3 — Animation

- [ ] Skeletal meshes: skinning in both renderers (software reference + WebGPU).
- [ ] glTF skin and animation-clip import.
- [ ] Animation state machine with blending and events (walk ↔ run ↔ shoot), driven
      from Lua parameters.
- [ ] Two-bone IK and look-at (feet on slopes, aiming).
- [ ] Timeline / sequencer for cutscenes and scripted camera moves.

## Phase 4 — Web asset pipeline and reach

- [ ] Meshopt / Draco geometry compression on glTF import.
- [ ] KTX2 / Basis texture compression with mipmaps.
- [ ] GPU instancing for repeated meshes (WebGPU).
- [ ] Asset bundles and streaming: load a level's assets on demand, with a loading
      screen and progress.
- [ ] WebGL2 fallback renderer for browsers without WebGPU.
- [ ] Download-size and load-time budget shown in the editor per cart.
- [ ] Quality presets (resolution scale, shadows, effects) chosen per device.

## Phase 5 — Debugging and profiling

- [ ] Lua debugger: breakpoints, stepping, variable watches, call stack.
- [ ] Pause, step one frame, and time scale while playing in the editor.
- [ ] Profiler: CPU (Lua vs render vs audio), GPU passes, draw calls, triangles,
      memory, network bytes.
- [ ] In-editor console for `trace()` output and runtime errors, linked to code lines.

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
