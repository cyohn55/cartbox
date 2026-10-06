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
- [x] **EP8. Shadows and many lights.** Cascaded sun shadows, spot lights,
      shadows from spot and point lights, and clustered light culling so a
      scene can hold dozens of lights.

      *Done (lights; the shadows are EP8b and EP8c):*
      - **Spot lights:** a point light narrowed to a cone, full inside its
        inner angle and fading to nothing at its outer one. They're authored
        in the lighting panel (aim, cone, soft edge) and shaded the same in
        all three renderers.
      - **Clustered light culling:** each frame the view is cut into
        16 × 9 × 24 cells (screen tiles by exponential depth slices). Each
        ranged light is listed in the cells its reach touches: a sphere
        against the cell's box, conservatively.
        - The GPU fragment shades the global lights (sun, unranged), then only
          its own cell's list. WebGPU reads the cells from storage buffers,
          WebGL2 from integer textures.
        - A light contributes exactly nothing past its range, so the picture
          is the same as shading every light. The software rasteriser,
          still the reference, skips lights that can't reach a triangle.
        - WebGL2 holds 128 lights, WebGPU any number, each cell up to 64.
      - **Lighting panel:** a big rig lists each light as one row (kind,
        colour, position), opened one at a time.
      - **Lockout:** 40 lights. Cyan pools along every energy strip and vent
        and at the weapon markers, plus two floodlights from the towers onto
        the walkway.
- [x] **EP8b. Cascaded sun shadows.** Split the view's depth into cascades,
      each with its own sun shadow map, fitted and stabilised (texel-snapped)
      to its slice, so near shadows stay sharp while far ones still reach the
      horizon. *Lockout:* crisp shadows at your feet and across the whole map.

      *Done:*
      - **Near cascade:** the main map still covers the whole scene. A second
        map of the same size covers a box round the camera: 30 % of the
        scene's radius, 4–24 m, so several times sharper.
      - **Stabilised:** its centre snaps to a grid half the box's size, so it
        doesn't shimmer as the camera moves. Its static depth is cached like
        the main map's and redrawn only when the camera crosses a cell. Moving
        objects are drawn over it each frame, uploading only the changed rects.
      - **Choosing a map:** each fragment uses the near map when its world
        position sits well inside it (95 % of its extent), else the main map.
        This is the same in the software rasteriser, WGSL and GLSL, and the GPUs
        pack both maps side by side in one texture.
      - **Quality:** a high-quality feature; medium and low keep the single
        map. The movers now use the static map's light reach too.
      - **Lockout:** shadows at your feet are crisp while the far map still
        covers the arena.
- [x] **EP8c. Spot and point light shadows.** Shadow maps for spot lights
      (perspective) and point lights (six faces), packed in an atlas and
      shared by all three renderers. *Lockout:* the tower floodlights throw
      the walkway rails' shadows.

      *Done:*
      - **Casting lights:** a ranged spot or point light can cast
        (`castShadows`, a toggle in the lighting panel).
        - A spot gets a perspective shadow map down its cone; a point light
          gets six 90° faces.
        - Each map is a 256² tile in one 1024² atlas, up to 16 tiles, handed
          out in light order.
      - **Comparing distances:** each fragment projects into its light's
        tile (a point light's face chosen by the dominant axis) and compares
        distance from the light, not perspective depth. So the bias is a
        constant few centimetres in world units, slope-scaled, with 2×2 PCF.
      - **All three renderers:** the software rasteriser, WGSL (the atlas and
        tile views in bind group 1) and GLSL (an atlas texture plus uniform
        arrays). Parity tests hold them to the same picture.
      - **Runtime:** the overlay caches each light's tiles of everything
        still, until the light or the still set changes, and draws the movers
        over a copy each frame. The editor's scene view shows them too.
      - **Lockout:** the two tower floodlights cast. The walkway rails and
        anyone crossing throw shadows down the deck.
- [x] **EP9. Light probes and LODs.** A baked grid of light probes, so moving
      objects pick up the baked bounce light (the web-sized answer to Lumen),
      and LOD chains generated automatically on import (the web-sized answer
      to Nanite).

      *Done (light probes; LOD generation is EP9b):*
      - **The grid:** a baked grid of ambient-cube probes over the scene,
        about 2.5 m apart and up to 4096. At each probe, each of the six axis
        faces holds what a light-map texel facing that way would: sky
        visibility and one bounce of sun. The bake uses the light map's own
        ray tracer and the same units.
      - **Sampling:** a surface without a light map scales its ambient and
        sky fill by the grid. It blends trilinearly between probes and across
        the three faces its normal leans toward, weighted by the normal's
        squared components.
      - **All three renderers:** the software rasteriser, WGSL and GLSL
        sample a float 3D texture by hand, so all three agree. Parity tests
        hold them to the same picture.
      - **Storage and baking:** the grid is stored with the scene's lighting
        as bytes, like a light map. "Bake lighting" now bakes it over the
        still objects after their light maps (with a spacing control), and
        Clear removes it.
      - **Lockout:** ships a baked 14 × 12 × 13 grid
        (`npm run bake:lockout-probes`, checked against the arena's layout
        fingerprint). The soldiers darken in the pit and under the walkway
        and pick up the snow's bounce in the open.
- [x] **EP9b. LOD generation.** Simplify a mesh into a chain of lighter
      levels (quadric-error edge collapse, keeping UV seams and borders) on
      import or on demand, stored with the object and swapped by camera
      distance (the runtime already selects LODs). *Lockout:* the soldiers
      and debris drop to light meshes across the arena.

      *Done:*
      - **The simplifier:** quadric-error half-edge collapse. A level keeps
        the original vertices and rewrites only the triangle list, so it
        shares its base's vertex arrays (positions, normals, UVs, skin
        weights) and costs only its indices. Borders and UV seams stay put, no
        collapse may flip a triangle, and a level stops at an error budget
        rather than distort the shape.
      - **Hard-edged meshes:** a faceted mesh such as Lockout's (every vertex
        on a crease) is simplified across its creases when it has no
        textures. Each corner then takes the vertex whose normal best fits
        its new face. Parts as plain as a box are left whole, and parts too
        small to see far off are dropped.
      - **Levels:** two by default, at about half and a quarter, taking over
        at 12 and 30 times the mesh's radius.
      - **Storage:** levels are stored on the object as indices, with a
        fingerprint of the geometry they were made from, so levels left over
        from older geometry are refused. A model placed many times stores
        them once in the sidecar's library.
      - **Runtime:** reads them into each instance's chain, and the overlay
        and the scene view draw by distance. Distance is measured in the
        mesh's own units, so a small copy drops detail sooner. A skinned
        object's levels ride its live, posed buffers, a tinted one's are
        tinted too, and debris wears its source's levels.
      - **Editor:** a Level of detail panel (Generate, Regenerate, Clear,
        each level's triangles and distance, a warning when stale) that
        covers every copy of the model. A heavy import (2,000+ triangles) gets
        LODs on the way in.
      - **Lockout:** the soldiers drop from 512 to 392 and then 292
        triangles, and the dropped weapons to about a fifth.

## Phase C — World building

- [x] **EP10. Terrain tools.** Create a terrain in the editor, sculpt it
      (raise, lower, smooth, flatten, noise), paint its material layers, and
      cut holes, as Unity's Terrain tools and Unreal's Landscape mode do.

      *Done:*
      - **Terrain panel** (Mesh tab): add a flat terrain of any size and
        detail. It starts with rock on steep faces, snow up high, grass
        elsewhere, and a paint-only dirt layer. Pick a tool, set the brush
        size and strength, and drag over the ground in the scene view; Alt
        still orbits. The brush's rim is drawn on the ground under the cursor.
      - **Sculpting:** raise, lower, smooth, flatten (to the height where the
        stroke starts) and noise, each on a round soft-edged brush. A stroke's
        dabs are spaced along the cursor's path, so a fast drag lays as much
        as a slow one, and a whole stroke is one undo step.
      - **Painting:** a splat map, one byte per layer per height sample. The
        first dab bakes the layers' slope and height rules into it, so
        painting starts from what the terrain already shows. Neighbouring
        layers blend per vertex through the existing blended-layer path, so
        all three renderers draw it unchanged. Layer colours can be edited,
        and "Clear paint" hands the terrain back to its rules.
      - **Holes:** cut or fill cells. A hole has no triangles at any detail
        level and no height, so picking passes through it.
      - **Storage:** heights, splat map, holes (as bits) and paint-only
        layers survive the sidecar. A sidecar holding only a terrain is now
        kept on save (it used to be dropped as empty), and the scene view
        frames a terrain-only scene.
- [x] **EP11. Foliage.** Paint instanced meshes (grass, rocks, trees) with
      density, random scale and rotation, alignment to the slope, and a
      distance cull. *Lockout:* rocks and snow drifts across the gorge.

      *Done:*
      - **Layers:** a foliage layer is a mesh on a terrain with a density,
        a random size range, slope alignment (0 = upright like a tree, 1 =
        along the ground like a rock), sink, and a draw distance. Each copy
        is turned at random.
      - **Painting:** a brush paints copies (kept a spacing apart, so dabs
        fill in rather than pile up) and erases them.
      - **Filling by rules:** steepest slope, a height range and a circle to
        keep clear, scattered from a seed, with Reseed. A fill costs nothing
        per copy on the sidecar; painted copies cost six bytes each.
      - **On the ground:** copies store where they stand, not their height,
        so each is set on the terrain when the scene loads. Sculpting
        afterwards keeps them on it, and they skip holes and the floor.
      - **Drawing:** copies merge into one mesh per 48 m block, so a layer
        is a few draws. A block past the layer's draw distance (scaled by the
        quality preset) isn't drawn. Blocks count as landscape: they don't
        set the framing, and they cast into the shadow map only when their
        terrain does.
      - **Editor:** a Foliage section in the Terrain panel. Add a layer from
        a built-in mesh (boulder, snow drift, grass tuft, pine) or a copy of
        a scene object's mesh; Paint or Erase it with the brush; edit its
        settings; turn on Fill; clear the painted copies; remove the layer.
        The scene view draws the layers. A layer's mesh shares the sidecar's
        library with the objects, and a terrain's foliage goes when the
        terrain is deleted.
      - **Lockout:** about 190 boulders on the range's slopes and 120 snow
        drifts on its flats, filled by rules and kept clear of the gorge. They
        add about 8 KB to the sidecar.

## Phase D — Game systems

- [x] **EP12. Audio.** Import sound files (Ogg, MP3, WAV), a mixer with buses,
      and 3D positional sound on objects through Web Audio, driven from Lua.
      This covers `HALO2_STYLE_ROADMAP.md` H14. *Lockout:* weapon sounds,
      gorge wind and the announcer.

      *Done:*
      - **Sounds** come from an imported file (Ogg, MP3, WAV, up to 2 MB), a
        **synth** recipe, or **speech**. A synth recipe is a few voices of
        noise or a waveform, with pitch and filter sweeps and an envelope,
        rendered when the scene loads. The built-ins are rifle, smg, shotgun,
        sniper, pistol, swing, explosion, wind, laser, pickup, click and jump;
        naming one costs a few bytes. Speech is a line the browser's voice
        reads out, for an announcer.
      - **Mixer:** every sound plays through a bus (sfx, music, voice,
        ambience, or the scene's own) into a master. The master joins the
        console's own output, so the player's volume and pause cover it too.
      - **Positional sound:** a sound with a range pans and fades linearly
        with distance from the camera, which is the listener.
      - **Emitters** loop from the start, everywhere at once or on an object
        (following it).
      - **From Lua:** `cartbox.sound(s, x, y, z, volume, pitch)` plays once.
        `cartbox.loop(slot, s, volume, x, y, z)` holds a loop in one of 16
        slots, sending only changes. `cartbox.mix(bus, volume)` sets a bus.
        All go through the runtime's command channel; one-shots are dropped
        on silent frames (stepping, off 1× speed) and capped at 24 voices.
      - **Editor:** a Sound panel lists each sound with ▶ preview, name, bus,
        volume, 3D range and loop. You can add a synth or a spoken line,
        import a file, set the mixer's bus levels, and add ambience emitters.
      - **Lockout:**
        - every weapon's report and the sword's swing (a bot's shots heard
          from where it stands, panned and fading);
        - grenade blasts and the wind moaning through the gorge;
        - the announcer calling multikills, sprees and the juggernaut.
        - It costs 1.7 KB on the sidecar, which now sits just under its
          1.4 MB budget. Lockout's code passed 64 KB and now spans two code
          banks, which the cartridge already supported.
- [x] **EP13. UI system.** Widget layouts authored in the editor (anchors,
      text, images, buttons, sliders, lists) with controller focus navigation,
      driven from Lua. *Lockout:* the start menu and HUD become UI documents.

      *Done:*
      - **Documents** are trees of widgets: panel, text, button, bar,
        slider, list and image. A widget is placed by an anchor on its
        parent, its own pivot, an offset and a size, so a layout fits any
        console's screen. What it shows comes from bindings: `{key}` in
        text, a bar's or slider's fill, a list's items (with per-row
        colours), visibility and colour.
      - **Focus:** moves between buttons, sliders and lists by position (the
        nearest one in the direction pressed). A list moves its selection
        and a slider its value before focus leaves them.
      - **Runtime:** the documents are laid out for the console's screen
        when the cart loads. The generated Lua draws them with the console's
        own `rect`, `print` and `spr`, so they are pixel-exact in the cart's
        frame (over the 3D scene in HUD mode).
      - **From Lua:**
        - `cartbox.ui.show/hide/shown` put a document up and take it down;
        - `set/get` read and write bindings;
        - `update()` handles the d-pad and A, returning what was pressed;
        - `on(id, fn)` calls a function on a press;
        - `focus/focused` and `select/selected` read and set focus and a
          list's selection;
        - `draw()` draws every shown document.
        - The SDK carries no-op defaults.
      - **Editor:** a UI tab:
        - documents (new, rename, delete) and a widget tree (add at the top
          or inside a panel, reorder, delete);
        - a preview at the console's resolution in the cart's palette: click
          to select, drag to move, arrow keys try the focus;
        - preview values typed as `key=value`;
        - an inspector with an anchor grid, offset, size, text, font size,
          alignment, palette swatches and bindings.
        - Documents are stored with the scene sidecar and handed to the
          player by every host.
      - **Lockout:** the HUD (shield and health bars, weapon, ammo, mode,
        score line, kill feed, announcer, respawn notice) and the start menu
        (game-type list and hints) are UI documents. The reticle, grenade
        pips and motion tracker stay drawn in code. Run without its
        documents, the menu falls back to its plain list. The sidecar budget
        guard moves to 1.5 MB: large sidecars are offloaded to object storage
        above 512 KB, and a save stays well inside the request limit.
- [x] **EP14. Components.** Reusable Lua behaviours attached to objects in the
      inspector, with fields you edit there and lifecycle callbacks (start,
      update, collision, trigger), the way Unity's components work.

      *Done:*
      - **Scripts:** a component is a named Lua script. Lines like
        `-- @field speed number 2` declare its fields, of four types:
        number, bool, text, and object (a scene object picked by name). It
        defines any of these callbacks:
        - `start(self)`;
        - `update(self, dt)`, before the cart's TIC;
        - `late(self, dt)`, after the cart's TIC;
        - `collision(self, other, started)`;
        - `trigger(self, other, entered)`.
      - **Copies:** each object a component is on gets its own `self`, which
        holds:
        - its field values (the object's own, else the defaults), with
          object fields resolved to objects;
        - `obj` (the object it's on);
        - `origin` (where the scene placed the object, in world space).

        Each script runs in its own environment, so its globals don't collide
        with the cart's or another script's.
      - **Errors:** a script that doesn't compile, or a callback that errors,
        is reported with `trace` and stops only that copy.
      - **Prefabs:** a reserve prefab copy's components start when the copy
        is spawned, and again each time it comes back.
      - **From Lua:**
        - `cartbox.component(obj, name)` reads another object's copy.
        - `cartbox.place(obj, x, y, z, yaw, pitch, roll, scale)` puts any
          object somewhere and leaves it there; `cartbox.place(obj)` sends it
          home. It goes through the runtime block, so it has no limit on how
          many objects it moves (a pose uses one of only 8 slots per frame).
      - **Editor:** in the Mesh tab:
        - a Components panel to add, rename and delete scripts and edit their
          code (a rename follows the script onto every object);
        - an inspector section to attach a script to the selected object and
          set its fields (a number, a checkbox, text, or an object picker).
        - Scripts and attachments are stored in the scene sidecar and carried
          by prefabs.
      - **Lockout:** a weapon floats over each spawn pad: its first-person
        model without the hands, stored without normals to keep the sidecar
        under budget. A `Pickup` component turns it and bobs it while the
        weapon is there to take, and hides it while the pad recharges or when
        the game type leaves that weapon out.
- [x] **EP15. Input actions.** Named actions with per-device bindings.

      *Done:*
      - **Actions:** an action has a name ("jump", "fire", "reload") and is
        bound to keyboard keys, controller buttons and console buttons. Console
        buttons also cover the on-screen pad and the player's button mapping.
        A key or controller button an action binds belongs to that action: it
        no longer also presses the console button it's mapped to.
      - **Runtime:** each tick the host works out which actions are held, from
        every device, with the player's rebinding applied. It writes that mask,
        with the last tick's, into a 16-byte input block just below the debug
        block. The block is in free RAM on every core, including Classic's last
        few hundred bytes, clear of TIC-80's system font.
      - **Replays:** the mask is recorded in replays above the 8 console-button
        bits, so a replay plays the actions back. Verification feeds it to the
        input block and never to the engine's other gamepad bytes.
      - **From Lua:**
        - `cartbox.action(name)` is held;
        - `actionp` is pressed this tick, `actionr` released this tick;
        - `actions()` lists them;
        - `actionlabel(name, device)` gives the bindings for a prompt ("G / Q").
        - Without the host's block, an action answers from its console
          buttons. The SDK carries no-op defaults.
      - **Editor:** an Input tab with a table of actions:
        - name;
        - keys (press to bind);
        - controller buttons;
        - console-button checkboxes;
        - a light that shows each action held as you press its bindings.

        Actions are stored in the scene sidecar and passed by every host.
      - **Rebinding:** players rebind an action's key and controller button,
        saved in their control settings (`actionBindings`).
      - **SDK reference:** the Code tab's reference gains sound, UI,
        components and input-action entries.
      - **Lockout:**
        - fire, jump, swap, grenade and zoom are actions, each keeping its
          console button;
        - Space jumps, Tab swaps, G, Q or LT throws a grenade, and Shift or a
          right-stick click zooms;
        - the Start menu's button-mapping page rebinds them.
        - A side effect: the A press that starts a match no longer also fires
          a stray shot.
- [x] **EP15b. Save data.** Structured saves (local, and cloud for signed-in
      players).

      *Done:*
      - **From Lua:**
        - `cartbox.save(t)` saves a table as JSON (numbers, strings, booleans
          and tables of them), or returns false and why: too big, or a
          function in it.
        - `cartbox.load()` returns the last save from the cart's first line.
        - `cartbox.erase()` forgets it.
      - **Runtime:**
        - The last save reaches the cart as code (a prelude written at load).
        - A new save comes back through a save block below the input block:
          16 KB on the larger cores, 448 bytes on Classic.
        - It is a flag the cart sets and the host clears in the same tick,
          because Classic's core clears that RAM between frames.
      - **Keeping saves:**
        - The play page keeps each cart's save in the browser.
        - For a signed-in player it also keeps it in their account (a new
          `cart_saves` table, migration 0028; private by row-level security,
          written only through `/api/carts/[cartId]/save`). Whichever copy is
          newer wins, and a burst of saves settles before the account's copy
          is written.
        - The editor's playtests keep their own browser copy, apart from
          players' saves, and the run overlay has Clear save.
      - **SDK reference:** a save-data group.
      - **Lockout:** a career record: matches, wins, kills, deaths. It is saved
        at the end of each match and shown on the title menu. The menu's
        control hints now name the new action keys.
- [x] **EP16. Visual scripting.** A node graph that compiles to Lua, for
      gameplay logic without code, in the spirit of Unreal's Blueprints.

      *Done:*
      - **Graphs are components** (EP14): a visual script compiles to a
        component's Lua. So it attaches to objects in the inspector, its
        variables are the component's fields (set per object), and it runs
        wherever components run. The code is always recompiled from the graph
        and never trusted as stored.
      - **Nodes:**
        - events: on start, every tick, on an input action, every so many
          seconds, on collision, on trigger;
        - flow: branch, sequence, loop;
        - actions: set a variable, place an object, spawn and despawn, play a
          sound, set a UI value, show a UI document, post a score, print, call
          a cart function;
        - values: constants, variables, this object and where it was placed,
          find an object, time, random, action held, ask a cart function;
        - maths and logic: add, subtract, multiply, divide, min, max, sin,
          cos, abs, floor, comparisons, and, or, not, join text.
      - **Wires:** white execution wires order the actions; coloured data
        wires carry values, and only join pins that fit. An exec output leads
        to one place and a data input takes one value. An unwired input uses
        the value typed beside it.
      - **Compiler:** one callback per kind of event. Action and timer events
        run from update. Data nodes become expressions and flow nodes become
        `if`, `for` and sequences. A chain that loops back on itself stops
        rather than compiling forever.
      - **Editor:**
        - the Mesh tab's Components panel gains "New visual script" and "Edit
          graph";
        - the graph editor has a palette by category, a canvas (drag, pan,
          zoom, wire, unwire), variables, and the compiled Lua beside it,
          read-only.
      - **Lockout:** the weapon Pickup (EP14) is now a visual script that
          compiles to the same behaviour. It's exercised by the real-engine
          pickup test.

## Phase E — Content and shipping

- [x] **EP17. Animation authoring.** Keyframe any property, a curve editor
      and clip editing.

      *Done:*
      - **Curves:** any timeline key (camera, object, value) can ease into the
        next along its own curve. The curve is a cubic Bézier from (0,0) to
        (1,1), as CSS's cubic-bezier, and its handles may overshoot for
        anticipation and bounce. The curve editor drags the two handles and
        has presets.
      - **Value tracks** keyframe any property:
        - a value track is a named number keyed over time;
        - `cartbox.timelinevalue(name)` reads it (it rides a new region of the
          runtime block), and a visual-script node reads it too;
        - a track named `bus:<name>` sets that mixer bus's volume.
        - The Timelines panel plots each value track over time, with its keys
          and the playhead.
      - **Clip editing** in the Mesh tab's Animation panel:
        - rename;
        - trim a span into a new clip (keys added at the cut so the motion
          starts and stops where it was);
        - change the speed;
        - make a reversed copy;
        - duplicate and delete.
      - **Lockout:** the intro's letterbox slides in and out from a
        "letterbox" value track, and the wind fades up on the ambience bus.
- [x] **EP17b. Blend spaces and retargeting.** Two-parameter blend spaces in
      the state machine, and playing one skeleton's clips on another by joint
      names.

      *Done:*
      - **Blend spaces:**
        - A blend state can take a second number parameter, which makes it a
          2D blend space: clips are placed on a plane (forward speed ×
          sideways speed, say).
        - They are mixed by gradient band interpolation, so each clip plays
          exactly at its own point, mixes ease between neighbours, and the
          weights always sum to 1.
        - The runtime now blends any number of clips by weight (1D blends
          unchanged), keeping them in step at the same fraction of their
          lengths.
        - The Animator panel picks the second parameter, gives each clip a
          second coordinate, and plots the space.
      - **Retargeting:**
        - The Animation panel's "Copy clips from another object…" copies a
          skeleton's clips onto the selected one.
        - Joints match by name, ignoring case, rig prefixes and separators.
          Rotations carry the motion relative to each rest pose.
        - The root's travel is scaled by the skeletons' heights. Other
          translations and scale keys are dropped, so bones keep the target's
          proportions.
      - **Lockout:**
        - The soldiers move on a 2D blend space: idle, run, back-pedal (the
          run reversed) and a strafe to each side.
        - Each soldier is fed its forward and sideways speed relative to the
          way it faces, so a bot that keeps its gun on a target while moving
          strafes and back-pedals.
- [x] **EP18. Standalone export.** Export a game as a self-contained HTML
      bundle (a zip for itch.io), and as an installable app that plays
      offline.

      *Done:*
      - **One HTML file:**
        - The editor's File menu has "Export game…", which downloads the game
          as a single page.
        - The page carries everything inline: the cartridge, the editor-made
          data (3D scene, world, effects, backdrop, weather, collision), the
          engine core for the cart's console model, and the player.
        - It carries the physics engine (the deterministic build when asked)
          or the KTX2 transcoder only when the scene uses them.
        - It plays opened straight from disk or from any web host, starting on
          the first click, tap or key (browsers only allow sound after a
          gesture).
        - Saves stay in each player's browser.
      - **A zip for itch.io:** that page as index.html, plus a web app
        manifest, two icons and a service worker. Served over HTTPS (itch.io,
        any static host), the game installs as an app, and once loaded it plays
        with no connection. The service worker caches every file, named for
        that game and build, and clears only its own older caches.
      - **How it's built:**
        - The player gained an `engineWasm` option, so the engine glue can be
          imported from a blob URL.
        - The runtime, Rapier and the transcoder are each bundled with esbuild
          into one self-contained module (apps/web/scripts/build-standalone.mjs,
          which runs before `next build` and `next dev`).
        - The page's data rides in one JSON block with every "<" escaped, so
          nothing in it can close the block.
        - A small ZIP writer uses the editor's own DEFLATE encoder.
      - **Lockout:** the lobby has "Play offline" with two downloads, one HTML
        file and an installable zip. Both play against bots with no server.
      - **A Start menu in every export:** a controller's Start, Esc / Enter /
        P or the ≡ button pauses the game. The menu offers resume, full screen,
        volume and the player's accessibility settings, which apply at once.
        (So an exported Lockout has its menu too.)
      - **Tests** cover the zip writer, which parts a game needs, the page's
        data block, the manifest, service worker and icons, and Lockout's
        export. Three tests run in a real browser:
        - an exported cart opened from disk runs and saves;
        - the zip, served locally, installs its service worker and boots again
          with the network off;
        - Lockout boots on the Modern core from one file.
- [x] **EP19. History: named snapshots.** Named snapshots of a cart with
      restore.

      *Done:*
      - **Taking one:** File → Snapshots… keeps the whole cart under a name:
        its .tic bytes, every sidecar and its details (exactly what Save
        writes).
      - **Restoring:**
        - The editor first says what will change, by part: code, sprites,
          map, sound… then each layer by name, the details and the console
          model.
        - It snapshots the current state ("Before restoring …") before
          replacing anything, so a restore can itself be undone.
        - The restored cart is unsaved work until Save.
      - **Where they're kept:**
        - Signed in, in the account:
          - The API is `/api/carts/[cartId]/snapshots`, owner only.
          - Payloads go to object storage, or inline on the row when storage
            isn't configured.
          - Migration 0029 adds the table with row-level security on and no
            policies.
        - Signed out, on the static build, or on a server the migration
          hasn't reached yet: in this browser's IndexedDB.
      - **Nothing left behind:** when a cart is deleted in the database (an
        owner's delete, an account's cascade), triggers queue its .tic, its
        offloaded mesh and its snapshots' payloads (migration 0030), and the API
        deletes those objects a few at a time as it writes to storage.
      - **Limits:** a snapshot is gzipped JSON, re-validated when it's opened
        (a damaged layer is dropped, not trusted). A cart keeps up to 50, each
        up to 24 MB compressed.
      - **Tests** cover names, the codec, the change summary, the upload rules,
        both stores (the account's against a stand-in API, the browser's on
        real IndexedDB in Chromium) and the migration.
- [x] **EP19b. Localisation and accessibility.** String tables for
      localisation; text size, colour-blind and remapping settings as engine
      features.

      *Done:*
      - **String tables:**
        - A new Text tab lists every player-facing text under a key, in each
          language the cart speaks. One language is the ★ fallback.
        - Untranslated cells are flagged, and keys the UI uses but the table
          lacks can be added in one go.
        - The table is stored in the scene sidecar.
      - **Lua:**
        - `cartbox.text(key, ...)`: `{1}`, `{2}`… fill from the arguments,
          `{name}` from a table, so word order can differ by language.
        - `cartbox.language()`, `languages()` and `setlanguage(code)`.
        - A UI widget whose text is `@key` shows that key's text.
        - Without a table, the base SDK answers with the key itself.
      - **Choosing a language:**
        - The player gets the first of their languages that the cart has
          ("es-MX" finds "es", "pt" finds "pt-br"), else the fallback.
        - Their order is a chosen language first, then the browser's.
        - The playtest can run in any of the cart's languages.
      - **Accessibility settings, kept once per browser and honoured by every
        cart:**
        - *Text size* (×1, ×1.5, ×2): UI text is drawn at whole steps larger,
          stepping back only where it would overflow its widget. Carts read it
          with `cartbox.textscale()`.
        - *Colour filters:* correction (daltonisation) for protanopia,
          deuteranopia and tritanopia, or high contrast.
          - It is applied to the finished frame as an SVG colour matrix, so it
            works for every renderer and changes at once.
          - Carts read it with `cartbox.colorfilter()`.
          - The playtest can also *simulate* each type, to see the cart as a
            colour-blind player does.
        - *Remapping* stays with each game's control settings (EP15).
        - Text size, colour filter and language all change *while a game
          runs*. The host writes them into the input block before each tick
          and the cart reads them there. A language the cart chose itself with
          `setlanguage` holds until the player picks another.
      - **Where the settings appear:** under the player on the play page, in
        the playtest, in exported games (EP18), and in Lockout's Start menu
        (Display → Accessibility).
      - **Lockout** speaks English and Spanish, written in ASCII for the
        console font:
        - its UI's fixed texts, game type names and weapon names;
        - the in-match messages: announcements, multikills and sprees, pickups,
          the kill feed and the status line.
        - Names are relabelled as the menu and HUD draw, so a language switch
          shows mid-match. Its sidecar budget is raised to 1.55 MB for the
          table.
      - **Tests** cover:
        - the table reader, language choice, translation, missing keys and UI
          keys;
        - colour correction (it moves apart what each type confuses and leaves
          greys alone), high contrast, text-size stepping and the
          preferences;
        - the Lua API and UI `@key` texts at the player's text size, in the
          real engine;
        - Lockout's table;
        - an exported game in Chromium that plays in the player's language,
          reports their text size and colour filter to the cart, and filters
          the frame.
- [x] **EP20. Lift the Modern tier's command cap.** Game code on the Modern
      tier runs in a TIC-80–derived core and reaches the 3D engine through a
      command channel capped at 64 commands a tick.

      *Done:*
      - **The overflow command ring:**
        - On the HD core behind the Modern and Xbox 360 models, commands past
          the runtime block's 64 continue into a 128 KB ring in the core's
          free RAM, just below the save block.
        - That is another 4,095 a tick: 4,159 in all, 65× the old cap.
        - The cart's code doesn't change: `cartbox.place`, spawn, play, sound,
          burst, impulses and the rest simply stop being dropped.
        - The host reads the block's commands, then the ring's, so their order
          is kept. It empties the ring after every tick.
        - Every core whose free RAM affords a ring has one: 128 KB on the Pro
          core (Pro, Portrait) too, so 4,159 commands a tick; 64 KB on the era
          core (PS1, N64), so 2,111. Classic keeps the 8 KB block alone: its
          free RAM is the block's.
      - **Lockout** runs on the HD core, so it gets the higher cap as it is.
      - **Tests:**
        - where the ring sits (only on the HD core, clear of TIC-80's own RAM
          and the other blocks);
        - in the real HD engine:
          - a cart drawing heavily for ten frames never touches the ring's
            RAM;
          - 300, then 5,000, then 10 placements in successive ticks arrive in
            order, up to exactly the new cap;
          - without the host reading the ring, only the block's 64 arrive.
- [ ] **EP20b. A dedicated Modern core.** A core of its own for the Modern
      tier, a Lua VM with a direct scripting API into the 3D engine (calls
      rather than a command channel), is still the foundation for scale.
      - It is a new WebAssembly runtime, not a feature of this one: cart
        loading, the 2D layer, sound and input would all be reimplemented
        around it.
      - Building it needs the Emscripten toolchain, which this repository
        builds cores with in CI (build-engine-cores.yml) but doesn't vendor.
      - EP20 removes the cap that most limited carts today, so this can follow
        as a project of its own.
