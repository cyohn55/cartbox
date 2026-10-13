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

- [ ] **P1. Materials.**
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
