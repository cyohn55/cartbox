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
- [ ] **P2. Landscape tools.**
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
- [ ] **P3. Splines.**
  - Editable splines (Catmull-Rom, with per-point width and height).
  - A **river** spline:
    - carves its bed and banks into the terrain;
    - lays a water surface that flows along its course (B5 water, flow from the tangent);
    - adds foam where it meets rock or shallow ground, and wet banks.
  - A **path** spline that flattens and paints the ground.
  - **Spline meshes** (walls, fences, rock ledges) bent along a spline.
  - *Tests:* the carve matches the spline profile; flow follows the tangent; spline mesh deformation.
- [ ] **P4. Procedural placement.**
  - Scatter **volumes**, with rules (slope, height, distance to splines, density maps) and exclusion zones.
  - **Cliff rocks** placed along steep slopes.
  - **Alpha-tested cards** for grass blades and needles.
  - **Impostors**: baked billboards for distant trees, cross-faded with LOD.
  - *Tests:* the rules and exclusions hold; impostor views; density and budget.
- [ ] **P5. Modular kit and generators.**
  - **Parametric prefabs** (Blueprint-lite): typed parameters drive a generator.
  - Arch, stair, ramp and pillar generators.
  - A Halo-style **stone and Forerunner kit**: slabs, trims, columns, bridges and base shells, with baked occlusion and curvature.
  - **CSG** brushes (add and subtract boxes, cylinders and wedges) to cut doorways, windows and a cave, producing clean meshes.
  - *Tests:* CSG is watertight; generators are deterministic; the kit snaps.
- [ ] **P6. Lighting and post.**
  - **Post-process volumes**: grade, exposure, fog and bloom per area, blended at the edges.
  - **Auto-exposure**: eye adaptation, for stepping from a dark base into the sunlit canyon.
  - **Contact shadows**.
  - SSAO tuned for foliage.
  - A stronger light bake: more bounces, sky occlusion, and an indirect colour bleed.
  - *Tests:* parity; volume blending; adaptation converges.
- [ ] **P7. Level editor** (completes B4).
  - Arena maps are authored in the editor:
    - an **outliner** and multi-select;
    - gizmos with grid and angle snap;
    - **gameplay markup**: spawns, weapon pads, hills, the ball, teleporters, kill volumes and bot destinations;
    - a **collision layer**: boxes, ramps and terrain.
  - The map validator runs live in the editor.
  - **Play-in-editor** runs the arena with bots.
  - Lockout and Beaver Creek round-trip as saved maps, and `/lockout?map=<cart>` plays a saved map.
  - *Tests:* the shipped maps round-trip byte for byte; the validator's messages; play-in-editor starts a match.
- [ ] **P8. Profiler and content browser.**
  - Per-device budgets (iPhone, iPad, desktop).
  - A live overlay: draw calls, triangles, texture memory and frame time.
  - A content browser with thumbnails, search and tags.
  - **Automatic LODs** (quadric simplification).
  - *Tests:* the budgets flag an over-budget scene; LOD error bounds.
- [ ] **P9. Beaver Creek, rebuilt with the editor.**
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

## Order

P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8 → P9.

Looks come first because each step shows on Beaver Creek straight away. P7 moves the map into the editor before the final rebuild.
