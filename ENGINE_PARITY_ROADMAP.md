# Engine Parity Roadmap — the editor against Unity and Unreal Engine 5

[`ENGINE_ROADMAP.md`](ENGINE_ROADMAP.md) took Cartbox from a fantasy console to
a web game engine: scene objects, physics, skeletal animation, streaming, a
debugger and profiler. [`HALO2_STYLE_ROADMAP.md`](HALO2_STYLE_ROADMAP.md) then
filled in the rendering and game feel a Halo 2–style shooter needs. What is
left between Cartbox and Unity or Unreal is mostly the **editor**, a few
**rendering capabilities** you can't author today, and the **game systems**
those engines ship out of the box.

This roadmap closes those gaps. Every item is one pull request, merged when CI
is green. Each item is applied to the Lockout demo wherever it fits, so it is
exercised in a real game.

## Guardrails

- **Web first.** Everything runs in the browser, on WebGPU with the WebGL2 and
  software fallbacks. Unreal features that need native hardware (Nanite's
  virtualised geometry, Lumen's ray-traced GI, MetaHumans) are out of scope;
  the closest web-sized equivalent is listed instead.
- **One look everywhere.** A feature that changes pixels lands in the software
  rasteriser, WGSL and GLSL together, with parity tests.
- **Stored in the cart.** Everything an author makes is saved in the cart's
  sidecars and round-trips through save and load. The editor never holds state
  the game can't read.
- **Fantasy tiers untouched.** Era models (PS1, N64…) keep their limits. New
  capabilities are opt-in, mostly on the Modern (Xbox 360) tier.

## What already matches

Scene hierarchy, inspector and prefabs; physics with joints, triggers and shape
casts; skeletal animation with a state machine, IK and a timeline; navmesh and
agents; level streaming; baked lightmaps, reflection probes, terrain, decals,
particles, fog and post-processing; a debugger, profiler, console, pause/step
and global undo; WebGPU with WebGL2 and software fallbacks.

## Phase A — The scene editor

The biggest gap. Unity's Scene view and Unreal's level viewport are where most
of the work happens; Cartbox's Mesh tab still edits in a small CPU-drawn
preview.

- [x] **EP1. GPU scene viewport.** The Mesh tab's scene view fills its panel
      and resizes with it, drawn by the same GPU renderer the game uses
      (WebGPU, then WebGL2, then software). A free camera: orbit, pan, dolly,
      and fly with the right mouse button held (WASD/QE, Shift to go faster,
      the wheel sets the speed). F frames the selection and Home frames
      everything. Perspective, top, front and side views (the last three
      orthographic). A ground grid that geometry hides, and a stats readout:
      backend, frame time, draw calls, triangles.
      *Done:* the scene view is drawn by `createSceneRenderer`, the factory
      the player uses, at the panel's full size: up to 1920×1080 on a GPU,
      and at most 640×400 on the software fallback. It redraws only when
      something changes, plus a few frames for the GPU's frame-behind
      readback to catch up. The camera (`viewportCamera.ts`) moves like a
      level editor's:
      - orbit with a left drag (or Alt+drag under any tool);
      - pan with a middle or Shift drag;
      - dolly with the wheel;
      - look and fly with a right drag plus WASD/QE, Shift to go faster, and
        the wheel setting the speed;
      - F and Home to frame the selection or everything;
      - top, front and side orthographic views.

      Picking rays come from the same camera, so they agree with what's drawn
      in every view. The grid's spacing follows the camera's distance, and
      geometry hides it. A Fog toggle clears the view when the scene is seen
      from far out. Lockout's arena edits in it at full size on WebGL2.
- [x] **EP2. Transform gizmos and snapping.** Real handles in the viewport:
      move arrows with plane squares, rotate rings, and scale boxes with a
      uniform centre, in local or world space. W/E/R switch tools. Snapping
      to a grid step, an angle step and a scale step, with Ctrl to flip it
      for a drag. "Drop to surface" puts the selection on whatever is below.
      *Done:* the maths is pure functions in `gizmo.ts`:
      - **Handles:** arrows, plane squares and a camera-facing centre for
        move; a ring per axis for rotate; box-tipped arms and a uniform
        centre for scale.
      - **Size:** handles stay the same size on screen, and highlight when
        hovered.
      - **Exact drags:** every drag is measured from where it started, so
        snapping is exact and nothing drifts. Move snaps world coordinates
        (or distances along local axes), rotate snaps the angle, and scale
        snaps the result.
      - **Rotation:** turns about a world axis through the object's own
        origin, and stays correct for children of rotated parents.
      - **Scale:** always along the object's own axes.

      Q/W/E/R switch tools, X toggles world and local, Snap with three step
      menus (Ctrl flips it for a drag), and End (or Drop) puts the selection
      on whatever is beneath it.

      Clicks now pick by triangles (`meshRaycast.ts`) instead of bounding
      boxes, so a soldier standing in the arena is selectable. GPU renderers
      gained `settle()`: it shows the newest finished frame without
      submitting another and says when it's current. That keeps an editor
      that draws on demand correct on slow GPUs, where readbacks take many
      frames.
- [x] **EP3. Selection and object operations.** Shift/Ctrl-click to multi-select
      in the viewport and the hierarchy, and box select by dragging. Gizmos
      move a selection together. Duplicate (Ctrl+D), copy and paste (also
      between carts, through the clipboard), delete, hide, isolate and lock.
      *Done:* the Mesh tab keeps a selection of any number of objects, the
      last one the primary that the inspector and gizmo follow.
      - **Selecting:** Shift-click adds and Ctrl/Cmd-click toggles, in the
        viewport and in the hierarchy. With a transform tool, dragging on
        empty space box-selects (with Shift or Ctrl too). Alt+drag orbits,
        and Alt+Shift+drag or the middle button pans.
      - **Group moves:** one gizmo drag moves every selected root. They move
        by the same amount, turn about the axis through the primary's origin,
        and scale by the primary's change along their own axes.
      - **Operations** (`sceneSelection.ts`) work on whole subtrees:
        - Ctrl+D duplicates in place, with "(1)"-style names, keeping a
          prefab link only when the whole placed copy comes along.
        - Ctrl+C/V copy and paste through the system clipboard, so objects
          paste between carts and land where they were in the world. Pasted
          text is checked as strictly as a stored sidecar.
        - Delete removes the selection with everything under it.
        - H hides, Shift+H isolates, Alt+H shows everything, L locks, Ctrl+A
          selects all, and Escape deselects.
      - **Hide and lock** are editor-only, with an eye and a lock on every
        hierarchy row. Hidden objects aren't drawn or picked in the scene
        view; locked ones can't be picked or moved there.

      The hierarchy also has Duplicate, Copy, Paste, Delete, Isolate and Show
      all buttons. Every operation undoes like any other edit.
- [x] **EP4. Content browser.** One panel for a cart's assets (meshes, prefabs,
      textures, materials, sounds, effects) with folders, search and
      thumbnails. Drag an asset into the viewport to place it, find what uses
      an asset, and rename safely.
      *Done:* a drawer under the Mesh tab's view lists every asset the scene
      is built from (`contentBrowser.ts`):
      - each distinct mesh, with how many objects share it;
      - prefabs, with their copies;
      - the materials and textures inside the meshes;
      - particle effects, decals and debris.

      Assets sit in folders by kind and are searchable. Meshes and prefabs
      get rendered thumbnails, textures their image, and materials a shaded
      swatch.
      - **Placing:** drag a mesh or prefab into the scene view and it lands on
        the surface under the cursor (or the ground); double-click or Place
        puts it where the view is looking.
      - **Finding uses:** an asset's details list the objects that use it
        (Select picks them), what else in the scene names it, and the code
        lines that name it.
      - **Safe renames** carry the new name everywhere: debris sources for a
        prefab, every mesh and every debris `without` list for a material,
        and the marks for a decal. Optionally, the code's string literals
        follow too.

      Sounds aren't in it yet; they arrive with audio assets in EP12. The
      Lockout starter lists 54 assets, including the soldier mesh shared by
      its seven bots.
- [x] **EP5. Play in the editor.** Play the game inside the scene viewport,
      pause and step it, and eject to a free camera to look around. Edits made
      while playing (transforms, materials, lighting) show immediately and are
      reverted on stop unless you keep them.
      *Done:* "▶ Play in scene" runs the cart inside the Mesh tab's view, with
      the same inputs as the Run overlay. The hierarchy, inspector and content
      browser stay usable beside it.
      - **Controls:** Pause, Resume and Step. Eject hands the game's 3D camera
        to a free camera, with the scene view's orbit, pan, dolly and
        right-drag WASD fly (`PlayerHandle.setEditorCamera`). "Back to the
        game's camera" returns it.
      - **Live edits:** changes made while playing are pushed into the running
        scene from the next frame, without a restart
        (`PlayerHandle.updateMeshScene` → `MeshOverlaySurface.applySceneEdits`).
        That covers placements (children follow their parents), meshes and
        materials (textures re-decoded), and the lighting rig (sky and image
        light re-baked); the cached static shadow is redrawn.
      - **Structural changes:** adding, removing or re-parenting objects is
        refused while playing, and the view says it shows on the next run.
      - **Stop** puts the scene back as it was when Play was pressed, unless
        "Keep changes" is ticked.

      Lockout plays in the view, a match runs, Eject looks down on the gorge,
      and raising the arena while it plays lifts it at once.

## Phase B — Rendering you can author

- [x] **EP6. Transparency.** Material blend modes (opaque, masked, blended,
      additive) with a sorted transparent pass in all three renderers, soft
      particles, and glass and water. *Lockout:* the energy barriers and the
      shield-door glass become true translucency.

      *Done:*
      - **Alpha modes:** a material can be opaque, cut out ("mask", with a
        threshold), blended or additive. The mode is stored with the mesh and
        round-trips through glTF (MASK and BLEND; additive exports as BLEND).
      - **The transparent pass:** in the software rasteriser, WebGL2 and
        WebGPU, see-through surfaces draw after the opaque scene, farthest
        first, testing depth but never writing it, and they cast no shadow.
        The GPU paths output premultiplied colour, and the composite lays it
        over the cart's pixels; additive surfaces add light with no coverage.
        Parity tests hold all three renderers to the same picture.
      - **Material editor:** a Transparency control (opaque / cut-out /
        blended / additive), a cut-out threshold, and Glass and Water presets.
      - **Particles** blend for real: soft-edged sprites, with glowing effects
        additive, instead of dithered cut-outs.
      - **Lockout:** it has no barriers or glass, so the item lands in its
        effects. Smoke, sparks, shield flares and plasma now blend and glow
        over the arena. The cyan energy trim stays opaque: drawn additively
        over the white walls it washed out to white.
      - **Soft particles** (fading where a sprite meets the geometry behind
        it) need the opaque depth readable during the transparent pass, so
        they moved to EP6b.
- [x] **EP6b. Soft particles.** Copy the opaque pass's depth so the transparent
      pass can read it, and fade sprites where they meet the surface behind
      them (all three renderers). *Lockout:* grenade smoke stops cutting hard
      lines into the deck and walls.

      *Done:*
      - **Soft depth:** a blended or additive material can fade out over
        `softDepth` world units as it nears the opaque surface behind it.
        Both depths are turned back into view distance through the projection.
        An orthographic view keeps hard edges.
      - **Reading the opaque depth:**
        - The software rasteriser reads its own depth buffer, which the
          transparent pass never writes.
        - WebGL2 copies the depth into a texture once, as the see-through
          batches begin.
        - WebGPU draws them in a second pass with the depth attached read-only
          and bound for the shader.
        - Parity tests hold all three renderers to the same picture.
      - **Particles** get a soft depth of half their size. In Lockout, grenade
        smoke, dust and sparks fade into the deck and walls instead of cutting
        a line.
      - **Material editor:** a Soft edge slider for see-through and additive
        materials. The Water preset fades out at the shore.
- [x] **EP7. Material graph.** A node-based material editor (textures, maths,
      time, UVs, fresnel, noise) feeding the PBR inputs, compiled to WGSL and
      GLSL and interpreted on the CPU, as Unity's Shader Graph and Unreal's
      Material Editor do.

      *Done:*
      - **The graph:** a material can carry a graph of 35 kinds of node:
        - surface inputs: UV, world position, normal, view direction, time,
          and the material's own colour and alpha;
        - patterns: texture, value noise with octaves, fresnel;
        - maths: arithmetic, mix, clamp, step/smoothstep, trig, dot, length,
          split and combine.

        It is wired into base colour, alpha, emissive, metallic and
        roughness. It's stored with the mesh, validated on load, and a
        material with a graph always takes the PBR path.
      - **One graph, three runs:** the compiler orders the graph into
        straight-line steps, dropping loops and unreachable nodes. The
        software rasteriser interprets the steps per pixel. WebGPU and WebGL2
        splice them into their fragment shaders, with one cached
        pipeline/program variant per distinct graph. The noise hashes with
        integer maths, so all three agree. Parity tests hold the GPUs to the
        software picture.
      - **The node editor:** opened from the material panel ("Material
        graph…"):
        - a palette and starter graphs (flowing energy, marble, fresnel glow,
          dissolve, scrolling texture);
        - drag-to-wire, with wires that would loop refused;
        - params edited on each node;
        - pan and zoom, opening fitted to the graph;
        - a live preview sphere.
      - **Lockout:** the energy trim and weapon markers run on a graph. Bands
        of light flow diagonally across the arena over the trim's slow breath.
- [ ] **EP8. Shadows and many lights.** Cascaded sun shadows, spot lights,
      shadows from spot and point lights, and clustered light culling so a
      scene can hold dozens of lights.
- [ ] **EP9. Light probes and LODs.** A baked grid of light probes, so moving
      objects pick up the baked bounce light (the web-sized answer to Lumen),
      and LOD chains generated automatically on import (the web-sized answer
      to Nanite).

## Phase C — World building

- [ ] **EP10. Terrain tools.** Create a terrain in the editor, sculpt it
      (raise, lower, smooth, flatten, noise), paint its material layers, and
      cut holes, as Unity's Terrain tools and Unreal's Landscape mode do.
- [ ] **EP11. Foliage.** Paint instanced meshes (grass, rocks, trees) with
      density, random scale and rotation, alignment to the slope, and a
      distance cull. *Lockout:* rocks and snow drifts across the gorge.

## Phase D — Game systems

- [ ] **EP12. Audio.** Import sound files (Ogg, MP3, WAV), a mixer with buses,
      and 3D positional sound on objects through Web Audio, driven from Lua.
      This covers `HALO2_STYLE_ROADMAP.md` H14. *Lockout:* weapon sounds,
      gorge wind and the announcer.
- [ ] **EP13. UI system.** Widget layouts authored in the editor (anchors,
      text, images, buttons, sliders, lists) with controller focus navigation,
      driven from Lua. *Lockout:* the start menu and HUD become UI documents.
- [ ] **EP14. Components.** Reusable Lua behaviours attached to objects in the
      inspector, with fields you edit there and lifecycle callbacks (start,
      update, collision, trigger), the way Unity's components work.
- [ ] **EP15. Input actions and save data.** Named actions with per-device
      bindings, and structured saves (local, and cloud for signed-in players).
- [ ] **EP16. Visual scripting.** A node graph that compiles to Lua, for
      gameplay logic without code, in the spirit of Unreal's Blueprints.

## Phase E — Content and shipping

- [ ] **EP17. Animation authoring.** Keyframe any property, a curve editor,
      clip editing, blend spaces and retargeting between skeletons.
- [ ] **EP18. Standalone export.** Export a game as a self-contained HTML
      bundle (a zip for itch.io), and as an installable app that plays
      offline.
- [ ] **EP19. History, localisation and accessibility.** Named snapshots of a
      cart with restore; string tables for localisation; text size,
      colour-blind and remapping settings as engine features.
- [ ] **EP20. A dedicated Modern core.** Game code on the Modern tier currently
      runs in a TIC-80–derived core and reaches the 3D engine through a
      command channel capped at 64 commands a tick. A dedicated core with a
      direct scripting API lifts that cap and is the foundation for scale.
