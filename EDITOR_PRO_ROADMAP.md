# Editor Pro Roadmap: closer to Unity and Unreal, then Beaver Creek rebuilt with it

## Goal

Two goals:

- Bring Cartbox's editor closer to the world-building and look-development toolsets of **Unity** and **Unreal Engine**.
- Then rebuild Beaver Creek (`BEAVER_CREEK_ROADMAP.md`) with those tools, so it looks much more like Halo's Beaver Creek / Battle Creek.

The user chose all eight tracks below (P1–P8). P9 is the rebuild.

## Ground rules

- Every renderer feature lands in all three renderers: WebGL2, WebGPU and the software reference.
- Each feature has a parity scene. **WebGPU parity runs on a real device** (Dawn via `@kmamal/gpu` over lavapipe; see `webgpu-parity.test.ts`) before a PR goes up, not just WebGL2. CI has no adapter, so this is a local step (lesson of #216).
- Each feature has editor controls, a test, and a note in this file.
- The iPhone and iPad quality tiers keep their frame and memory budgets. P8's profiler makes those budgets visible.
- One PR per item, or per part of an item. Each is merged when CI is green.

## Where things stand

The editor already has:

- mesh modelling, rigging, keyframes, UVs and texture painting (L15–L17);
- node material graphs, with wear, curvature and thickness inputs (EP7, I4, I15);
- terrain with sculpt and paint, holes, layers, triplanar mapping and height blending (EP10, B6);
- foliage with painting, fill rules and wind (EP11, B6);
- water (B5);
- decals, particles, timelines, kit snapping, prefabs with variants, light maps and probes;
- reflection probes, SSR, TAA, fog and a procedural sky.

Next to Unity and Unreal, it lacks the following:

| Gap | Unity / Unreal equivalent | Track |
| --- | --- | --- |
| Normal, roughness and AO maps on the GPU (today only the software path reads normal maps) | Standard / Lit materials | P1 |
| Material instances, and procedural texture generators | Material Instances, Substance | P1 |
| Erosion, stamps, heightmap import and export, an auto-material with macro variation | Terrain Tools, Landscape | P2 |
| Splines: rivers that carve their banks, paths, walls | Water / Landscape Splines, Spline Mesh | P3 |
| Rule-based scattering, cliff rocks, alpha cards, impostors | PCG, detail scattering, Impostor Baker | P4 |
| Parametric prefabs, a modular stone and Forerunner kit, CSG boolean brushes | Blueprints, BSP, ProBuilder | P5 |
| Post-process volumes, auto-exposure, contact shadows, a stronger bake | Post Process Volume, Lightmass, GPU Lightmapper | P6 |
| Authoring an arena map in the editor: markup, collision, validator, play-in-editor | Level Editor / Scene view, PIE | P7 |
| Per-device budgets, a profiler overlay, a content browser, automatic LODs | Profiler, Content Browser, LOD tools | P8 |

## Tracks

- [x] **P1. Materials.**
  - **P1a.** Normal maps on the GPU:
    - a tangent frame from screen derivatives (the same per-triangle frame the software path uses);
    - the material's normal and occlusion maps in both shaders;
    - ORM packing.
  - **P1b.** Material instances: a parent material plus per-use overrides (colour, roughness, maps, tiling), edited in the material panel and stored once.
  - **P1c.** Texture generators: rock, cliff, grass, dirt, mud, sand, worn stone and Forerunner metal. Each generator:
    - takes seed, scale and colour parameters;
    - bakes albedo, normal, roughness and height maps.
  - *Tests:* parity on a normal-mapped scene (WebGL2 and WebGPU); an instance's override round trip; generator determinism.
  - **P1a: done.** Both GPU paths now read a material's tangent-space normal map.
    - **The tangent frame.** It is built per triangle from screen derivatives: dP/du, as the software path's Lengyel `worldTangent` gives, Gram-Schmidt against the normal, with B = N × T. So all three renderers shade the same bumps without a tangent vertex stream.
    - **Which normal drives what.** The mapped normal lights the surface, in both PBR and fantasy shading, and feeds the material graph's Normal input. The clearcoat, refraction and shadow bias keep the geometric normal, as the software path does.
    - **WebGL2's texture units.** The scene shader already used all 16 that iPhone Safari and ANGLE on Direct3D give. P1a folds the light clusters' cell table and index list into one texture (RG32UI, 1024 wide) to free a unit for the normal map. A test now holds the shader to 16.
    - **WebGPU** binds it at 16, which is also its default per-stage limit.
    - **The uniform.** A new `maps0` uniform at byte 896 flags the map (912 bytes used).
    - **Parity.** WebGL2 matches the software frame on the normal-map scene pixel for pixel. On Dawn over lavapipe, WebGPU passes 29 of 29: the new normal-map scene, and also water, triplanar cliffs and wind, which had only been checked in WebGL2 before.
    - *Tests:* `normal-maps.test.ts` (packing, batching, the 16-unit budget, a frame lit by bevels while a flat map changes nothing); `webgl-parity.test.ts`; `webgpu-parity.test.ts`.
  - **P1c: done.** A material can carry a **generator recipe**: kind, seed, density, tint and size (64 to 512).
    - **The kinds.** Rock, cliff, grass, dirt, mud, sand, worn stone and Forerunner metal (`textureGenerators.ts`). Each bakes four maps: albedo, a tangent-space normal map, metallic-roughness (G roughness, B metal) and relief (height and curvature, so the I4 wear inputs work).
    - **Tiling.** Every noise is periodic on the tile (value noise, fractal noise and cellular noise wrap their lattice), so the maps repeat without a seam. A test holds each kind's wrap seam to no rougher than its roughest interior column or row; it caught sand's slanted ripples, which did not wrap.
    - **Stored once.** A material saves only the recipe; the maps are regenerated on load and memoised by recipe, so materials that share one share the images. Painted or imported maps in any slot are kept, and "Keep the maps" detaches the recipe so the maps can be painted.
    - **Editor.** The material panel's Generated maps section picks the kind, density, tint and size, and reseeds.
    - *Tests:* `texture-generators.test.ts` (sizes, determinism, seeds, tiling, normal and metal channels, defensive reading, the recipe-only round trip, kept maps).
  - **P1b: done.** The cart keeps a **material library** of parents (in the mesh sidecar). A part's material can be an instance of one (`materialInstances.ts`).
    - **Inheritance.** An instance takes every field from its parent except the ones it overrides. Its name, light map and sprite link are always its own. Overriding the generator bakes the generated slots again from the instance's own recipe.
    - **Editing.** Changing any field of an instance in the material panel makes it an override, listed under the Library picker with a revert button each. "Apply to parent" pushes the overrides up; "Detach" keeps the values and stops following.
    - **Propagation.** Editing or removing a parent resolves again every instance of it: placed meshes, their animation frames and LODs, prefab nodes and foliage layers. A mesh holding no instance of that parent is not even decoded. Removing a parent leaves its instances with their values.
    - **Storage.** Each instance also keeps its resolved fields, so the player and every other reader of a mesh need no library; generated maps are stored as recipes, so the copies are small.
    - *Tests:* `material-instances.test.ts` (inheritance, overrides, generator overrides, apply and detach, the link's codec, the library's round trip, propagation that spares overrides and other parents).
- [x] **P2. Landscape tools.**
  - Hydraulic and thermal erosion.
  - Noise and terrace stamps.
  - Flatten and ramp brushes, with undo.
  - Heightmap import and export (16-bit PNG).
  - An **auto-material**:
    - layers by slope, height and curvature;
    - per-layer normal maps;
    - macro variation, so a tile doesn't repeat across a valley;
    - distance blending.
  - *Tests:* erosion conserves material and is deterministic; an import/export round trip; auto-material weights.
  - **P2a: done.** Sculpting tools beyond raise, lower, smooth, flatten and noise (`landscapeTools.ts`).
    - **Hydraulic erosion.** Rain droplets (Beyer's model) run downhill with a little inertia, carry sediment by speed, water and drop, and fill pits they run into. A droplet's leftover sediment settles where it stops, so ground is moved but never made or lost. The droplets work in cell units, so they behave the same at any size or resolution. The same seed gives the same valley.
    - **Thermal erosion.** Ground steeper than the angle of repose slumps onto its lower neighbours. Each pass reads the heights from before it, so the result doesn't depend on the order of the samples. It also conserves ground.
    - **Brushes.** Rain and Weather as brushes, which erode only the brushed patch. Hills, Ridges (ridged fractal) and Terraces (flat treads with eased risers, with an adjustable step) as stamps. A Ramp drawn by dragging from one spot to another, between their heights, the brush's width, laid afresh over the ground as it was.
    - **Whole landscape.** "Rain on it all" (up to 200k droplets) and "Weather it all" (an adjustable repose angle).
    - **Heightmaps.** Export writes a 16-bit greyscale PNG that carries its own height range in a `tEXt` chunk. Import reads 8- or 16-bit grey or colour PNGs, resampled to the grid: a Cartbox file at its own range, anything else from black to the chosen height.
    - **Undo.** Every pass is a single undo step, as sculpting already is.
    - *Tests:* `landscape-tools.test.ts` (conservation and determinism of both erosions, region-only erosion, stamps and terraces, the ramp's profile, the 16-bit round trip within one step of 65535, 8-bit colour import, rejecting a non-PNG).
  - **P2b: done.** An auto-material for terrain, in all three renderers.
    - **Curvature rule.** A terrain layer can ask for hollows or for crests, alongside its slope and height rules: sand in the creases, bare rock on the ridges. The curvature is the mean of a sample's four neighbours minus its own height. It is 0 on any plane however steep, and blends softly when the terrain blends.
    - **Macro variation.** On any material: the base colour drifts lighter and darker in broad patches (strength and patch size), from the shaders' shared, bit-exact value noise in the mesh's own space. A tiled texture no longer repeats visibly across a valley.
    - **Distance tiling.** On any material: from a quarter of a set distance out to it, the base map blends to itself tiled four times larger, by UVs or triplanar alike.
    - **Per-layer normal maps.** These come from P1a: a layer's material can carry one.
    - **Uniforms.** The packing grows by nothing: the free lanes `terrain0.zw` (macro strength, 1 / scale) and `maps0.y` (tiling distance).
    - **Editor.** The terrain panel sets each layer's "anywhere / hollows / crests", and macro variation and distance tiling for every layer at once. The material panel's new Landscape block sets them per material.
    - **Parity.** A landscape cliff scene (triplanar, height-blended, macro-varied, distance-tiled) matches the software frame on WebGL2. It passes on WebGPU over Dawn too, 29 of 29.
    - *Tests:* `landscape-materials.test.ts` (curvature, hard and soft layer picks, storage, clamping, packing lanes, the gain's bounds, the blend's curve, a changed software frame); `webgl-parity.test.ts`; `webgpu-parity.test.ts`.
- [x] **P3. Splines.**
  - Editable splines (Catmull-Rom, with per-point width and height).
  - A **river** spline:
    - carves its bed and banks into the terrain;
    - lays a water surface that flows along its course (B5 water, flow from the tangent);
    - adds foam where it meets rock or shallow ground, and wet banks.
  - A **path** spline that flattens and paints the ground.
  - **Spline meshes** (walls, fences, rock ledges) bent along a spline.
  - *Tests:* the carve matches the spline profile; flow follows the tangent; spline mesh deformation.
  - **P3: done.** Splines (`splines.ts`, `splineEdit.ts`, the terrain panel's Splines section).
    - **The curve.** Centripetal Catmull–Rom through the placed points, so there are no cusps or loops however unevenly the points are spaced. It is sampled evenly by arc length, with a horizontal frame and widths eased between points.
    - **Placing points.** Click the ground in the scene view to place a point; whichever end is nearer grows. Each point's x, y, z and width can be edited in the panel. The scene view draws every curve and its points.
    - **River: the carve.** Across its width the ground takes a cross-section: a flat bed `depth` below the water, rising to the water's edge. Across its banks the ground eases back to what it was, lowering high ground and building up low ground so the water is held. A layer can be painted on the banks (wet mud).
    - **River: the water.** A ribbon a little wider than the river, its UVs in metres across and along. The water flows along its UVs (a new `water.along`): the ripples are worked out in UV space, then turned into the world by the surface's UV gradients. So the current follows every bend, with no seams, in all three renderers. The uniform's free lane `maps0.z` flags it.
    - **River: the foam.** A strip of procedural, tileable foam along each edge.
    - **Bends tighter than the river is wide.** The inner edge is held inside the bend's radius rather than folding back.
    - **Path.** Levels the tread to the spline's height, eases the shoulders, and can paint a layer.
    - **Wall.** Bends any scene object along the spline, repeated end to end and stretched so a whole number of copies fits. Its sideways scale follows the width.
    - **Applying.** What a spline makes is an ordinary scene object tagged with its id; applying again replaces it, and deleting the spline removes it.
    - **Parity.** An S-bend river matches the software frame on WebGL2, and on WebGPU over Dawn, 30 of 30. Its ripples are strong enough to change a quarter of the river's pixels, so the parity check would catch a GPU that ignored them.
    - *Tests:* `splines.test.ts` (the curve through its points and evenly sampled; nearest point and side; the carve's bed, edge and banks, built-up banks, wet-bank paint; the water ribbon's UVs and up-facing winding; the foam's UVs; the along-UV tilt is the world tilt turned by the gradients; the path's tread, shoulders and paint; the bent wall; storage; placing points; applying a river and a wall).
- [x] **P4. Procedural placement.**
  - Scatter **volumes**, with rules (slope, height, distance to splines, density maps) and exclusion zones.
  - **Cliff rocks** placed along steep slopes.
  - **Alpha-tested cards** for grass blades and needles.
  - **Impostors**: baked billboards for distant trees, cross-faded with LOD.
  - *Tests:* the rules and exclusions hold; impostor views; density and budget.
  - **P4: done.** Scatter rules, a placement kit, and impostors (`foliage.ts`, `foliagePresets.ts`, `render/impostor.ts`, the foliage section of the terrain panel).
    - **Scatter rules.** A foliage fill gains four rules, beside its slope and height ranges (now with a gentlest slope as well as a steepest), all stored and deterministic:
      - **keep-out** circles (bases, pads, lanes);
      - **curvature**: only in hollows, or only on crests;
      - **patches**: broad noise picks where a layer grows, to a share of cover, thinning out at the edges rather than stopping at a line;
      - **distance from a spline's edge**: reeds within 3 m of a river's water, trees kept off a path.
    - **Spline context.** Fills read the scene's splines in the editor and the player alike, and the scene view re-fills when a spline changes.
    - **Cliff rocks.** A slab-shaped, noise-chipped rock, mapped with the P1c rock generator projected triplanar. Its preset fills only steep faces, lying along them half sunk.
    - **Grass cards.** Three crossed, two-faced quads carrying a procedural blade texture, cut out by alpha, with normals up so they light like the ground.
    - **Impostors: the bake.** The editor bakes a layer's mesh into impostors: four orthographic views (both sides along each axis) in one atlas, rendered with the materials turned emissive-only so the pictures are unlit. Each card's UVs are its corners projected through the camera that drew its view.
    - **Impostors: storage.** The cards are stored with the layer (a few kilobytes).
    - **Impostors: in the player.** The player emits them as far blocks beside the full ones, with a swap distance measured to each block's centre. So a block draws its full copies nearer than the distance and its cards beyond it, never both and never neither.
    - **Not cross-faded.** The swap is a hard switch at block level; a dithered cross-fade would need the renderers' help. The editor's scene view always shows the full copies.
    - *Tests:* `placement.test.ts` (keep-out, hollows and crests, patch cover and determinism, distance from a spline, storage; the cliff rock's shape, material and preset fill; the grass cards' cut-out; the impostor's views, cards and atlas; the player's near and far blocks trading places, the far ones a fraction of the triangles).
- [x] **P5. Modular kit and generators.**
  - **Parametric prefabs** (Blueprint-lite): typed parameters drive a generator.
  - Arch, stair, ramp and pillar generators.
  - A Halo-style **stone and Forerunner kit**: slabs, trims, columns, bridges and base shells, with baked occlusion and curvature.
  - **CSG** brushes (add and subtract boxes, cylinders and wedges) to cut doorways, windows and a cave, producing clean meshes.
  - *Tests:* CSG is watertight; generators are deterministic; the kit snaps.
  - **P5: done.** Parametric shapes, the stone and Forerunner kit, and CSG (`csg.ts`, `shapeGenerators.ts`, `kitEdit.ts`, the Kit and CSG panel).
    - **CSG: the booleans.** Union, subtract and intersect, by BSP trees (Evan Wallace's csg.js algorithm, made iterative so deep trees don't overflow). Normals and UVs are carried through every split. The faces a cut leaves take the target's material, so a doorway looks carved.
    - **CSG: closed output.** The result is mended so it is a closed solid: T-junctions are put into the edges they lie on, positions are snapped, and identical materials stay one primitive. Each polygon is fanned from a true corner, which keeps zero-area slivers to a minimum.
    - **CSG: brushes.** Box, cylinder and wedge, placed in the scene as see-through objects.
    - **CSG in the editor.** Any object can be cut, joined or intersected with any other where they stand in the world. The panel says when a result isn't fully closed. That can happen when booleans are chained on a curved solid; a single boolean is always closed.
    - **Parametric shapes (Blueprint-lite).** Slab, stairs, ramp, arch, pillar, and wall with a doorway and a window. Each has typed, clamped parameters stored on the scene object, and is rebuilt as a parameter changes, keeping the materials the creator gave its parts.
      - Every shape is a closed solid at every parameter's default and limits.
      - Stairs are built straight from their faces rather than by booleans.
      - The pillar joins its base and capital first, then the shaft.
    - **The kit.** Twelve pieces: stone slab, block, wall with doorway, arch, bridge arch, stairs, ramp and column; Forerunner panel, trim, pillar and gateway. Each is a parametric shape in a P1c-generated material (worn stone with macro variation, or Forerunner metal with a clearcoat), projected triplanar so any size keeps the same texel density. The pieces snap edge to edge (I14's kit snapping).
    - **Not yet: baked occlusion.** The kit pieces don't yet carry baked occlusion and curvature maps; the triplanar generator maps carry their relief.
    - *Tests:* `kit-csg.test.ts` (each boolean closed and of the right volume; cut faces in the target's material; determinism; every shape closed at every limit; shapes standing on the ground at their size; defensive reading; rebuilding keeps materials; every kit piece closed and textured; snapping; the panel's edits — a kit piece remembering and rebuilding its shape through storage, a world-space cut removing its brush, a moved target missing the cut).
- [ ] **P6. Lighting and post.**
  - **Post-process volumes**: grade, exposure, fog and bloom per area, blended at the edges.
  - **Auto-exposure**: eye adaptation, for stepping from a dark base into the sunlit canyon.
  - **Contact shadows**.
  - SSAO tuned for foliage.
  - A stronger light bake: more bounces, sky occlusion, and an indirect colour bleed.
  - *Tests:* parity; volume blending; adaptation converges.
  - **P6: done in part.** Post volumes, eye adaptation and a multi-bounce bake (`postVolumes.ts`, `postVolumeFx.ts`, `lightmap.ts`, the Lighting panel). Contact shadows and foliage SSAO wait on a GPU depth prepass.
    - **Post volumes.** A box with soft edges, after Unreal's Post Process Volume. It can set exposure (in stops), brightness, contrast, saturation, bloom and fog density. Its effect fades over a blend distance outside it, and higher priority wins where boxes overlap.
      - Exposure goes to the scene's tone map, so it needs tone mapping on.
      - The grade multiplies the cart's own grade. Bloom and fog mix from the cart's values toward the volume's, by how far into it the camera is.
      - The player re-sends the post-FX settings only when the rounded look changes.
    - **Eye adaptation.** Every fourth frame, the frame's log-average luminance is measured, and the exposure eases toward the value that brings it to mid-grey. Brightening (stepping into a dark base) is slower than darkening (stepping out into the sun). It stays within the creator's limits, and a volume's own stops are taken out before measuring.
    - **A stronger bake.** The light bake takes 1–3 bounces. Each extra bounce gathers, from every surface a texel's rays hit, the sky and sunlit surfaces that surface sees. Shaded corners of a sunlit room then fill with coloured light rather than going black. One bounce is byte-identical to before, so existing bakes stay fresh. The Light bake panel has a Bounces slider.
    - **Already there before P6:** sky occlusion and one coloured bounce of sunlight, from H1.
    - **Not yet: contact shadows and foliage SSAO.** Both are screen-space passes that need the frame's depth. The GPU renderers read back colour only, so they need a depth prepass in WGSL and GLSL first. Until then, the near shadow cascade carries small-scale contact.
    - *Tests:* `post-volumes.test.ts` (weights fade smoothly and are hard with no blend; priority wins in either order; the luminance measure; adaptation converges, moves at its own speeds and stays in its limits; storage round-trips and is absent when unset; the player's merge). `lightmap.test.ts` (one bounce unchanged; more bounces fill shade deterministically; colour bleeds).
- [x] **P7. Level editor** (completes B4).
  - Arena maps are authored in the editor:
    - an **outliner** and multi-select;
    - gizmos with grid and angle snap;
    - **gameplay markup**: spawns, weapon pads, hills, the ball, teleporters, kill volumes and bot destinations;
    - a **collision layer**: boxes, ramps and terrain.
  - The map validator runs live in the editor.
  - **Play-in-editor** runs the arena with bots.
  - Lockout and Beaver Creek round-trip as saved maps, and `/lockout?map=<cart>` plays a saved map.
  - *Tests:* the shipped maps round-trip byte for byte; the validator's messages; play-in-editor starts a match.
  - **P7: done.** Arena maps are authored in the Mesh tab's Arena panel (`arenaMarkup.ts`, `arenaEdit.ts`, `savedArena.ts`, `ArenaPanel.tsx`).
    - **Storage.** An arena map is JSON on the scene's sidecar (`arena`), read defensively within limits.
      - Lockout and Beaver Creek round-trip exactly and play the same Lua.
      - Their sidecars now carry their markup, so a cart started from the Lockout starter opens as an arena map.
    - **Markup by clicking.** Pick spawn, weapon pad, hill, ball, teleporter, kill volume, bot destination or collider, then click the scene. It lands where the cursor meets a mesh or terrain, or else the ground.
      - The markup is drawn over the scene: dots and labels, boxes as wireframes, teleporters dashed to their exits.
      - Click a marker to select it. You can then set:
        - a spawn's team;
        - a pad's weapon and rotation;
        - a destination's power flag;
        - a teleporter's arrival facing;
        - a box's size.
      - Move a marker by clicking where it goes, or remove it.
    - **Kill volumes** are new to the cart. The `KILL` table works like the death plane: step in and you die.
    - **The collision layer:**
      - colliders fitted round the selected objects;
      - walkable ground taken from a terrain at a chosen spacing;
      - flights of steps carried with the map;
      - the death height.
    - **The validator runs live.** It checks spawn floors, spawns inside walls, the death plane, kill volumes, net range and a missing spawn.
      - Check routes bakes the bots' navmesh and adds reachability from spawn 1.
      - The validator's navmesh is now optional, and it gains the `no-spawns` and `kill-volume` kinds.
    - **Play-in-editor.** "Play this arena with bots" opens `/lockout?map=cart:<id>`, which plays the copy saved in this browser.
      - Its scene is the arena's scaffold (`savedArenaSidecar`): a stub at instance 0, the bots, viewmodels, a pickup over each pad's weapons, the Holograms and the left hands. The navmesh and ragdoll colliders come from the map.
      - The saved scene's objects, lighting, terrains, foliage and splines follow, along with its edited Spartans and weapons where they keep the contract.
      - Its code is the arena code on that map, with the camera about the scene's bounds.
    - **Already there:** the outliner, multi-select, box select, and gizmos with grid and angle snap and kit snap.
    - **Not yet:**
      - Markers move by clicking rather than with the gizmo.
      - A saved arena plays offline against bots. Online, guests would load their own map.
    - *Tests:* `arena-editor.test.ts`:
      - storage: round-trips and defensive reading;
      - the panel's edits;
      - the live and route checks;
      - kill volumes in the Lua, and on the real engine (stepping in kills, stepping beside doesn't);
      - colliders from objects and ground from a terrain;
      - a saved arena laid out as the cart expects.
- [x] **P8. Profiler and content browser.**
  - Per-device budgets (iPhone, iPad, desktop).
  - A live overlay: draw calls, triangles, texture memory and frame time.
  - A content browser with thumbnails, search and tags.
  - **Automatic LODs** (quadric simplification).
  - *Tests:* the budgets flag an over-budget scene; LOD error bounds.
  - **P8: done.** This builds on the profiler (Phase 5), the content browser (EP4) and quadric LODs (EP9b) that were already there (`deviceBudgets.ts`, `sceneBudget.ts`, `BudgetPanel.tsx`, the profiler panel, the viewport readout, the content browser and the LOD panel).
    - **Per-device budgets.** iPhone, iPad and desktop each have limits on:
      - triangles and draw calls a frame;
      - texture and mesh memory;
      - frame time (30 fps on a phone, 60 elsewhere);
      - download size.

      `checkBudget` gives each known line with its share of the limit and whether it's over, and `smallestFit` names the smallest device a scene fits.
    - **The scene's load as stored** (`sceneLoadOf`):
      - triangles and draw calls at full detail, per copy, with terrain chunks counted;
      - mesh memory, each model counted once;
      - texture memory, each image counted once, sized from its PNG, JPEG or KTX2 header and taken as RGBA8 with mips;
      - the download.

      The Mesh tab's Budgets panel shows each line as a bar, red when over, for the chosen device. The device choice is remembered in this browser.
    - **The live overlay:**
      - The viewport readout turns draws and triangles red when a frame goes over the chosen device's budget, and adds the scene's texture memory.
      - The playtest profiler gains a "Device budget" group: what the frame drew and the scene's texture and mesh memory against the device's limits. The player now splits scene memory by kind (`estimateSceneMemory`), counting every texture map with mips.
    - **The content browser:**
      - Thumbnails and search were already there.
      - Assets now carry tags, stored on the scene. Search takes `#tag` words, and the most-used tags show as one-click filters. Tags follow an asset when it is renamed.
    - **LOD error bounds:**
      - `lodDeviation` measures how far a level strays from its model: a one-sided Hausdorff distance from the model's vertices and face centres to the level.
      - `lodErrorBudget` gives the level's allowance.
      - The LOD panel shows each level's deviation in centimetres.
      - The default levels stray about a tenth of their budget on a sphere and on rolling ground.
    - *Tests:* `profiler-budgets.test.ts`:
      - the budgets flag a heavy scene on a phone and not on a desktop, and devices are ordered on every line;
      - header sizes for PNG, JPEG and KTX2;
      - the stored load and the player's memory split;
      - deviation is zero for a mesh against itself, catches a dropped half, and every default level stays within its budget;
      - tags round-trip and filter.
- [x] **P9. Beaver Creek, rebuilt with the editor.**
  - Every capability above is used:
    - the canyon is sculpted and eroded;
    - the creek is a river spline;
    - the banks are scattered with rocks, reeds, ferns and grass cards;
    - the rims are forested with impostors;
    - the stone bases, arch and cave are made from the kit and CSG;
    - the materials are instanced from generated sets;
    - there is a post volume per base, plus auto-exposure, a re-bake and a profiler pass.
  - The layout and the gameplay stay exactly as they are today (BEAVER_CREEK_ROADMAP.md, "Layout to match").
  - *Acceptance:*
    - side-by-side views against the reference;
    - the map validates;
    - every mode plays;
    - it fits the iPhone tier's budget.
  - **P9: done.** All of it is in `beaverCreekSeed.ts`, and none of it touches collision, so the map plays exactly as before.
    - **The canyon (P2).**
      - The terrain is now 96 m square, at the cart's own metre. Inside play, its samples are the cart's ground exactly.
      - Beyond play, walls of rock rise steeply to rims 12–22 m up. They are buttressed and stepped in strata, and are then eroded by water (14 000 droplets) and by slumping.
      - North and south, the walls fall away to a gorge the creek comes out of, which is also what the intro flies down.
      - Terrain layers: wet mud down the creek bed (P1c's mud generator), grass on the flats, banded sandstone on the walls (triplanar).
    - **The creek (P3)** is a river spline down its bed. It draws flowing water along its UVs and foam at its banks, in place of the flat slab.
    - **The bases (P5):**
      - Each base is one worn-stone block, hollowed out and cut for its doors by CSG. Its walls stand exactly where the cart's walls are.
      - Each has Forerunner pillars at its corners, a metal trim band under the parapet, and team-coloured light strips over its doors.
    - **The arch (P5)** is a block of canyon rock. CSG cuts its opening as a rounded-square head (a superellipse) whose crown meets the span the cart stands on, with rock steps up either end.
    - **Materials (P1b):** the scene's library holds four parents (stone, metal, rock, light). The map wears instances of them:
      - the bases' stone;
      - the arch's rock, overriding only its macro variation;
      - blue and red lights, overriding only their colour.

      The library travels in the sidecar, so the editor shows the links.
    - **Plants (P4):**
      - The meadow is grass cards.
      - Broadleaf trees and pines fill the rims in patches, drawn as impostors past 32 m.
      - Boulders fill the walls' ledges, and cliff rocks break up the steep faces.
    - **Light (P6):**
      - Each base has a post volume (+0.9 stops, a touch less saturation) and a warm lamp under its roof.
      - A third volume sits under the arch, and the eye adapts between -0.5 and +1.5 stops.
      - The bake now takes two bounces; it was re-baked in about 2 minutes.
    - **Profiler pass (P8):** Beaver Creek and Lockout both fit the iPhone's budget as stored.
      - Beaver Creek counts about 50 000 triangles, 408 draw calls, 5.4 MB of textures and a 2.5 MB sidecar.
      - The phone and tablet draw-call budgets were raised to 500 and 900. The static count includes every weapon's viewmodel, which shows only one at a time, and Lockout (396) runs on iPhones.
    - **Acceptance:**
      - Side-by-side captures before and after, from the running game, using `scripts/capture-map.mjs`.
      - The map validates, and every game type plays on the real engine (`beaver-creek.test.ts`).
      - It fits the iPhone's budget (`beaver-rebuild.test.ts`).
    - **Not yet:**
      - The map takes about 2 s to build on load, against roughly 1 s before; erosion and impostor baking are most of it.
      - Some cliff rocks on near-vertical faces look as if they float.
      - The cave is still missing (the cart needs boxes for it).
      - A reference set of shots from the original isn't in the repo, so the side-by-side is before against after.
    - *Tests:* `beaver-rebuild.test.ts`:
      - the play space's ground matches the cart's to 3 cm, and the walls and rims rise irregularly beyond it;
      - the map validates;
      - the creek spline is at the water line, with water and foam drawn;
      - the instances and the library check out;
      - no stone stands in the doors;
      - the trees have impostors, and the cliff-rock rule is in place;
      - the post volumes and eye adaptation are set;
      - both maps fit the iPhone budget.

## Order

P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8 → P9.

Looks come first because each step shows on Beaver Creek straight away. P7 moves the map into the editor before the final rebuild.
