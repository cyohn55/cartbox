# AAA Fidelity Roadmap: current-gen graphics from the Cartbox editor

## Goal

Cartbox's editor should produce assets and games whose image quality stands next to a current-generation AAA title: Unreal Engine 5, Frostbite, Decima or Halo Infinite's Slipspace. That means:

- physically based light in linear HDR;
- stable, filmic image quality;
- dynamic global illumination and soft shadows;
- dense geometry and believable atmosphere;
- characters that hold up in close-up;
- an asset pipeline that turns high-detail source art into all of the above.

This roadmap supersedes the open graphics items of `AAA_TIER_ROADMAP.md`. That file's Phase 0–4 groundwork (PBR fields, Cook-Torrance, IBL, shadows, SSAO, clustered lights) is what F0–F3 rebuild on a GPU-resident pipeline. The editor work of `EDITOR_PRO_ROADMAP.md` (terrain, splines, placement, kit, post volumes, level editor, budgets) stays. This roadmap gives those tools a renderer worth feeding.

## Where things stand (audit, October 2026)

The engine has a wide feature list, and Lockout and Beaver Creek show it. The renderer under it, though, was built to imitate consoles from the 1990s to the 2000s, and its architecture caps fidelity well before any single feature does.

**The root constraint is that the GPU is not the presentation path.**

- **Readback every frame.** WebGPU or WebGL2 draws the scene into an 8-bit `rgba8unorm` target, which is read back to the CPU every frame (`WebgpuSceneRenderer.ts:28-41`, `:2063`). So the frame shown is one to two frames old.
- **CPU work.** The CPU composites the frame and paints the sky, sun shafts and HUD into it (`MeshOverlaySurface.ts:1004-1137`).
- **Post.** The frame is then uploaded again to a single-pass WebGL1 post shader at `mediump` (`PostFxPass.ts:1-21`).
- **Consequences.** Everything after the scene pass sees display-referred 8-bit colour with no depth. The scene renders at the console model's framebuffer (1280×720 on the 360, 1920×1080 on "modern"), not at the device's. No compute shaders, indirect draws or workers are used anywhere.

| Area | Today | Current-gen AAA | Track |
| --- | --- | --- | --- |
| Colour pipeline | Gamma-space shading into rgba8, tone mapped per fragment before blending; albedo not sRGB-decoded | Linear HDR (rgba16float), physical light units, one tone map at the end | F0 |
| Frame | GPU→CPU readback, CPU sky and composite, WebGL1 post, model-fixed resolution | GPU-resident frame graph, native resolution with dynamic resolution and upscaling | F0 |
| Textures | RGBA8, one mip, no anisotropy; KTX2 transcoded to RGBA on load | Full mip chains, 16× anisotropy, BC7/BC5/ASTC on the GPU, mip streaming | F1 |
| BRDF and materials | GGX without energy compensation; derivative tangents; clearcoat, anisotropy, POM; no sheen, SSS, transmission or thin film; graph drives base colour, alpha, metal, roughness, emissive | Multiscatter GGX, stored tangents, the full KHR material set, SSS, a graph with normal, WPO and pixel depth offset, projected decals | F1 |
| Shadows | Sun map rasterised **on the CPU**, at most 1024² and 2 cascades, box PCF; local lights in 256² CPU tiles, at most 16; no contact shadows | GPU cascades or virtual shadow maps, PCSS, contact shadows, GPU local shadows | F2 |
| Lights | Directional, point and spot; windowed falloff; CPU clusters | Physical units and inverse-square falloff, area lights (LTC), IES, GPU clustering, emissive surfaces that light | F2 |
| GI and reflections | CPU-baked 8-bit lightmaps (ambient term only); 6-face ambient-cube probes; 8 LDR 128-px probes; 192×96 nearest-sampled IBL without split-sum; SSR; CPU SSAO not wired in play | HDR prefiltered IBL with a BRDF LUT; GTAO; HDR GPU-baked directional lightmaps; real-time probe GI (DDGI) and SSGI; denoised SSR | F3 |
| Temporal | TAA by camera reprojection only, on an LDR input; no velocity buffer, upscaler, motion blur or depth of field | HDR TAA with motion vectors, a temporal upscaler, motion blur, bokeh DOF, histogram exposure, HDR output | F4 |
| Atmosphere | CPU gradient sky dome, 2D cloud layers, analytic fog boxes, CPU screen-space shafts | Physically based sky (Hillaire), froxel volumetric fog with shadowed scattering, raymarched clouds, FFT water | F5 |
| Geometry | Discrete 2-level LODs, CPU culling, terrain ≤257² and CPU-meshed, foliage merged into block meshes | Cluster LOD hierarchy with GPU culling, GPU-instanced foliage, clipmap terrain with virtual texturing, world streaming | F6 |
| Characters | CPU linear-blend skinning, no morph targets, no hair or cloth | GPU skinning, morph targets and facial rigs, skin, eye and hair shaders, cloth, motion matching | F7 |
| VFX | CPU particles, at most 512 per effect, billboard meshes | GPU particles (compute), lit and sorted, depth collisions, volumetric smoke, destruction | F8 |
| Asset pipeline | OBJ and glTF; same-mesh AO, curvature and thickness bakes; base64 JSON sidecars; 4.5 MB body and 16 MB asset limits | High-to-low bakes, smart materials, scan import, HDR and IES import, a binary package format, direct-to-storage uploads, a CC0 asset library | F9 |
| Look dev | Viewport shares the game renderer, but no buffer view modes and no reference renderer | Buffer visualisers, complexity views, a look-dev stage, a path-traced reference, high-resolution capture | F10 |

These are the ten largest gaps, ranked by how much each costs the image. The audit's evidence for each is in the table above.

1. No linear or HDR pipeline.
2. No mips or anisotropy, and uncompressed textures.
3. LDR, unprefiltered IBL and reflection probes.
4. No dynamic GI or AO in play.
5. CPU-rasterised, low-resolution shadows.
6. A CPU-bound frame that is read back from the GPU.
7. A non-physical atmosphere.
8. Geometry scale.
9. A thin material model.
10. A temporal stack without motion vectors, and characters without morph targets.

## Ground rules

- **A new tier, `aaa`, is WebGPU-only.** The three-renderer parity rule (WebGL2, WebGPU and the software reference shade every feature alike) stays in force for every fantasy tier, PS1 through Xbox 360, whose output must not change. AAA features need compute, HDR targets and more bindings than WebGL2 or a CPU rasteriser can provide. For them, the **reference is a WebGPU path tracer** (F10b), not the software rasteriser.
  - *This is the one decision this roadmap needs from the project owner.*
- **Fallback, not failure.** On a browser without WebGPU, an `aaa` cart plays on the improved 360 pipeline, which keeps the linear colour and mips of F0b and F1a. It must still look right, if plainer.
- **Every feature carries:**
  - scalability levels (Low, Medium, High, Epic) with a cheap path for phones;
  - per-pass GPU timing in the profiler (P8);
  - editor controls;
  - a test: WebGPU parity on a real device via Dawn over lavapipe (`webgpu-parity.test.ts`), plus a reference-image comparison against the path tracer once F10b lands;
  - a note in this file.
- **Budgets.** The quality tiers have explicit targets:

  | Device | Level | Target |
  | --- | --- | --- |
  | Desktop discrete GPU | Epic | 1440p at 60 fps |
  | Desktop integrated GPU | High | 1080p at 60 fps, upscaled |
  | iPad (WebGPU) | Medium | 30 fps |
  | iPhone (WebGPU) | Medium | 30 fps |

  The budgets in `deviceBudgets.ts` gain an `aaa` row per device, including GPU milliseconds per pass.
- **Measured, not asserted.** Each phase ends with captures of a fixed reference scene set, compared before and after and against the path tracer:
  - Lockout;
  - Beaver Creek;
  - a look-dev stage;
  - the F11 showcase.
- One PR per item, or per part of an item. Each is merged when CI is green.

## Honest constraints

These shape the designs below and should not be rediscovered mid-phase.

- **WebGPU has no hardware ray tracing, mesh shaders or 64-bit atomics in core, and only partial bindless.**
  - Ray-traced effects are therefore **software ray tracing in compute**, over a BVH or signed distance fields, at low resolution with temporal accumulation and denoising.
  - Nanite's software rasteriser depends on 64-bit atomics. F6 uses cluster culling and indirect hardware raster instead, with a packed 32-bit visibility buffer as a later experiment.
  - Subgroups and `timestamp-query` are optional features. Every use needs a fallback.
- **Browser memory.** A desktop tab can use roughly 2–4 GB, and iOS Safari far less. AAA content is only viable with GPU-compressed textures, mip streaming and geometry streaming (F1, F6). The 8 GB "asset budget" of the modern model is not real on the web.
- **Download.** A current-gen scene is hundreds of megabytes of source art. Every pipeline:
  - ships compressed (Basis/KTX2, meshopt);
  - streams by distance and mip;
  - caches in the browser.

  The storage limits (4.5 MB request body, 16 MB per asset) move to direct-to-storage uploads (F9e).
- **Main-thread JS.** Culling, skinning, shadow rasterisation, SSAO and sky baking run on the main thread today. F0e moves them to the GPU or to workers, without which nothing above 1080p30 holds.
- **Art is the larger half of AAA.** Renderer features expose the quality of the content; they do not create it. F9 (the asset pipeline) and the F11 showcase content are as necessary as F0–F8.

## Tracks

### F0. Foundation: a GPU-resident, linear HDR frame

Everything else depends on this track. It contains no visible "feature", but its exit criterion is visible: Lockout and Beaver Creek render at native resolution and look *better* with no new content, because linear lighting and correct blending alone change the image.

- [ ] **F0a. Present from the GPU.**
  - On the `aaa` tier, the scene renders to the canvas through the WebGPU swapchain, with no readback.
  - The cart's 2D framebuffer becomes a texture composited on the GPU (the HUD and the TIC-80 layer), keyed exactly as `MeshOverlaySurface` keys it today.
  - The sky dome, sun shafts and vista backdrop move from CPU painting to GPU passes.
  - The overlay decorator chain (lighting layer, post-FX stack) gains a GPU-texture path, so a decorator consumes a texture rather than bytes.
  - *Exit:* zero `mapAsync` per frame on `aaa`, and the 1–2-frame overlay lag gone.
- [ ] **F0b. Linear HDR colour.**
  - The scene target becomes `rgba16float`, and albedo and emissive textures are sampled as sRGB.
  - All lighting runs in linear space, and blending happens in linear HDR. One tone map sits at the end of the frame.
  - Lights, sky and emissive take **physical units**: lux for the sun, candela or lumens for punctual lights, nits for emissive, EV100 for exposure. Editor conversion keeps existing scenes looking the same.
  - The fantasy tiers keep their byte space, pinned by their existing parity tests.
- [ ] **F0c. Frame graph.**
  - A declarative pass graph with transient, aliased resources, replacing the hand-ordered passes of `WebgpuSceneRenderer`.
  - It produces a depth prepass and a thin G-buffer of normal, roughness and material ID.
  - It produces a **velocity buffer**, with per-object motion that includes skinned and animated vertices.
  - Every pass is timed. Rendering is still forward+ for material flexibility; screen-space effects read the prepass buffers.
  - This also unblocks P6's deferred contact shadows and foliage SSAO.
- [ ] **F0d. The `aaa` tier.**
  - A console model on the dedicated Modern core (`packages/modern-core`, ENGINE_PARITY EP20b: a Lua 5.4 VM with direct engine calls and no command cap). `MODELS.modern` still points its `engineUrl` at the 360 core, and the tier ends that placeholder.
  - It renders at native device resolution × DPR, with dynamic resolution driven by the GPU frame time, and gives the 2D layer a scaled presentation.
  - It is listed on the home page with a starter scene. `modern` stays as the 1080p 360-pipeline tier.
- [ ] **F0e. Off the main thread.**
  - **Compute:** frustum and HZB occlusion culling, LOD selection, light clustering and skinning become compute passes with indirect draws.
  - **Workers:** asset decode (PNG, KTX2 transcode, meshopt), physics and navigation move to workers.
  - *Exit:* the main thread spends under 4 ms per frame in the renderer on Beaver Creek.

### F1. Textures and materials

- [ ] **F1a. Mips, anisotropy and GPU compression.**
  - Full mip chains, generated on the GPU, or kept from KTX2.
  - Trilinear filtering with 16× anisotropy.
  - KTX2/Basis is transcoded to the **native GPU format** rather than RGBA: BC7/BC5/BC4 on desktop, ASTC on Apple, ETC2 as the fallback.
  - Also unblocks the N64 model's true trilinear filtering (`renderCaps.ts:227-242`).
  - *Exit:* texture memory on Beaver Creek drops by at least 4×, with no minification shimmer at distance.
- [ ] **F1b. Texture streaming.** Mip streaming driven by GPU feedback: a sampler-feedback-style pass that records the mip each material wanted, under a texture-memory budget per scalability level, with residency in the profiler. It also covers texture arrays, or bindless where available, so materials stop competing for 16 bind slots.
- [ ] **F1c. BRDF upgrade.**
  - Multiscatter GGX energy compensation (Kulla-Conty, or Fdez-Agüera's LUT).
  - A height-correlated Smith visibility term.
  - Fresnel and split-sum on ambient specular, and specular occlusion from AO and bent normals.
  - **Stored MikkTSpace tangents**, so normal maps match Substance, Marmoset and Blender bakes exactly. Derivative tangents stay as the fallback.
- [ ] **F1d. The full material set.**
  - Sheen (Charlie distribution).
  - Transmission and volume (thickness, attenuation).
  - IOR and specular.
  - Iridescence (thin film).
  - Emissive strength.
  - Texture transforms.

  Each one maps to its glTF KHR extension on import and export. On top of these, separable **screen-space subsurface scattering** (Burley profile, Jimenez) for skin, wax, leaves and marble, with a transmission term for thin surfaces.
- [ ] **F1e. Material graph, production grade.**
  - New outputs: normal, world-position offset, pixel depth offset, refraction, subsurface colour.
  - Any number of texture samplers.
  - Material functions with reusable subgraphs, and layered materials that blend whole material stacks by masks (Unreal's Material Layers).
  - A static-switch permutation system, with a shader-compile cache to avoid hitches.
- [ ] **F1f. Projected decals.** Deferred, D-buffer-style box decals that modify base colour, normal, roughness and AO, with sorting, fade by angle and distance, and sharing of an atlas. They replace the quad-mesh decals for impacts, grime, leaks and road markings.

### F2. Shadows and lights

- [ ] **F2a. GPU cascaded shadows.**
  - Four cascades rendered on the GPU (no more CPU shadow rasteriser on `aaa`), with stable texel-snapped fitting.
  - Practical (log-linear) splits, cascade blending and a shadow-distance control.
  - Hardware comparison sampling, filtered with Poisson PCF or **PCSS** for contact-hardening penumbrae.
  - 2048–4096 per cascade, by level.
- [ ] **F2b. Virtual shadow maps.**
  - A 16K virtual shadow map, paged from a physical pool, with pages marked by the depth buffer and cached between frames for static geometry.
  - This is what makes shadow detail hold at every distance in UE5. It falls back to F2a on Medium and below.
- [ ] **F2c. Contact shadows.** A screen-space ray march toward each light against the depth prepass, so small-scale contact (feet, foliage, props) grounds every object. It closes EDITOR_PRO P6's deferred item.
- [ ] **F2d. Local light shadows on the GPU.** A larger atlas (4096² and up) with priority-based tile allocation by screen size, cached static tiles and PCF. It lifts the cap of 16 tiles.
- [ ] **F2e. Physical lights.**
  - Inverse-square falloff, with a range window for culling only.
  - Area lights (rectangle, disk, tube) with **LTC** (linearly transformed cosines).
  - IES profiles, imported in F9d.
  - Light temperature in Kelvin, and lighting channels.
  - GPU clustered culling (from F0e) with thousands of lights.
- [ ] **F2f. Emissive surfaces that light.** Emissive meshes contribute through GI (F3d and F3e), so the energy trim on a Forerunner wall lights the floor in front of it.

### F3. Global illumination and reflections

- [ ] **F3a. HDR image-based lighting.**
  - True HDR environments from imported `.hdr`/`.exr` (F9d) or the F5a sky.
  - Kept as cubemaps, with a GGX-prefiltered mip chain built in compute, a **split-sum BRDF LUT** and L2 spherical-harmonic irradiance.
  - It replaces the 192×96 nearest-sampled equirect and its roughness-to-average lerp.
- [ ] **F3b. HDR reflection probes.**
  - Cubemap probes captured on the GPU, then prefiltered and stored compressed (BC6H, or RGBM where it is not available).
  - Box and sphere parallax correction, and blended influence volumes with priorities.
  - Re-capture on demand in the editor; at runtime, when time of day changes.
- [ ] **F3c. GTAO with bent normals.** Ground-truth AO on the GPU from the depth prepass, at half resolution, temporally accumulated. Bent normals feed diffuse and specular occlusion. It replaces the unwired CPU SSAO.
- [ ] **F3d. GPU lightmapper.**
  - A compute path tracer, sharing its BVH with F10b, that bakes HDR **directional lightmaps** (L1 SH or ambient-highlight-direction) with any number of bounces, emissive surfaces as lights and area lights.
  - A denoiser (an edge-avoiding à-trous filter, or a small learned one), with seam stitching and texel-density control.
  - Baked **probe volumes** with L2 SH and visibility (to stop leaks) light dynamic objects.
  - Minutes in the browser rather than CPU-bound bakes in node, with `bake:map` kept for CI.
- [ ] **F3e. Real-time GI.**
  - **DDGI**: a probe grid whose irradiance and visibility are updated every frame by software ray tracing in compute, against a scene BVH or a global signed distance field.
  - **SSGI** for near-field detail on top.
  - Together they give moving lights, time of day and destructible scenery correct bounce light without a bake: the Lumen-class result, built from techniques WebGPU can run.
- [ ] **F3f. Reflections.**
  - Hierarchical-Z SSR with GGX importance sampling and a temporal denoiser.
  - Rough reflections that blend into F3b probes.
  - On Epic, ray-traced reflections from a low-resolution software BVH trace for off-screen objects.

### F4. Image quality and the camera

- [ ] **F4a. HDR TAA with motion vectors.** TAA in linear HDR before tone mapping, reprojecting with the F0c velocity buffer, and rejecting history with variance clipping in YCoCg. It adds reactive and transparency masks, so particles and water don't ghost.
- [ ] **F4b. Temporal upscaling.** An FSR 2-class upscaler built on F4a. It renders at 50–77% scale, reconstructs at native resolution and pairs with dynamic resolution (F0d). It is how integrated GPUs and phones reach the tier.
- [ ] **F4c. Physical camera.**
  - Aperture, shutter speed and ISO drive both exposure and effects:
    - **bokeh depth of field** (gather-based, with near/far fields and a shaped aperture);
    - **per-object motion blur** (McGuire-style tile max on velocity);
    - histogram **auto-exposure** on the GPU, with metering modes and exposure compensation, replacing the CPU 8-bit luminance read.
  - Post volumes (P6) blend all of it.
- [ ] **F4d. Tone mapping and output.**
  - Tone mappers: AgX, ACES 1.3 RRT/ODT and Khronos PBR Neutral, selectable per scene.
  - Grading in log or ACEScct space, and LUTs applied in the right space.
  - **HDR display output** where the browser supports it (WebGPU canvas `toneMapping: "extended"`).
  - Bloom from the HDR buffer (an energy-conserving mip-chain bloom, with lens dirt), replacing the threshold on the clipped LDR read-back.
- [ ] **F4e. Post on the GPU frame graph.** The WebGL1 single-pass post stack (`PostFxPass.ts`) becomes frame-graph passes at full precision. Every existing effect (CRT, dither, grain, aberration, flare and the rest) is kept, so the fantasy-tier looks still work on `aaa`.

### F5. Atmosphere, weather and water

- [ ] **F5a. Physically based sky.**
  - Hillaire's 2020 atmosphere: transmittance, multiple-scattering, sky-view and aerial-perspective LUTs.
  - Rayleigh, Mie and ozone parameters, a planet radius, and a sun and moon in physical units.
  - Time of day drives the sun, sky, IBL (F3a) and fog together.
  - The stylised dome and rings stay as a "painted sky" option.
- [ ] **F5b. Volumetric fog.** A froxel grid (for example 160×90×64) of scattering and extinction from height fog, local fog volumes and particles. It is lit by the sun with its shadow map, and by local lights with theirs, then temporally reprojected and integrated. **God rays emerge from it**, so the CPU screen-space shafts retire.
- [ ] **F5c. Volumetric clouds.** Raymarched clouds with a Nubis-style shape plus erosion noise and weather maps, multiple-scattering approximation, temporal amortisation at quarter resolution, cloud shadows on the ground and aerial perspective.
- [ ] **F5d. Water.**
  - FFT ocean, and Gerstner waves for lakes and rivers.
  - Depth-based absorption and scattering.
  - Screen-space caustics, shoreline and wake foam, and interactive ripples (a GPU height simulation).
  - An underwater post pass and refraction through the surface.
  - It completes the parts left open in `BEAVER_CREEK_ROADMAP.md` B5.
- [ ] **F5e. Weather.** Wetness, puddle and snow layers in the material system, driven by a global weather state and a height and occlusion mask: darkening, roughness changes and ripple normals in puddles. GPU rain and snow particles (F8a) collide with depth.

### F6. Geometry at scale

- [ ] **F6a. Cluster rendering.**
  - Meshes are built into 128-triangle clusters with a **cluster LOD hierarchy** (simplify groups of clusters, Nanite's DAG with an error metric), so detail is continuous and crack-free.
  - Compute culls clusters (frustum, backface cone, two-pass HZB occlusion) and selects LODs by screen-space error, then emits indirect draws.
  - Film-quality meshes (millions of triangles) become placeable without hand-made LODs. A packed 32-bit visibility buffer for micro-triangles is an experiment at the end of the phase, not a dependency.
- [ ] **F6b. GPU foliage.**
  - Instanced foliage culled per instance on the GPU with HZB, replacing the per-48 m merged block meshes.
  - Dithered LOD crossfade, and pivot-painter-style hierarchical wind (trunk, branch, leaf).
  - Octahedral impostors, replacing two crossed cards.
  - Translucency (F1d) on leaves and grass.
- [ ] **F6c. Terrain at scale.**
  - Clipmap or CDLOD terrain from heightfields of 4K and up, displaced in the vertex shader with no CPU meshing.
  - A **runtime virtual texture** that caches the blended terrain layers, decals and splines into pages, so terrain shading costs one sample at any layer count.
  - Displacement or POM on near layers, and real geometry vistas at distance in place of a panorama.
- [ ] **F6d. World streaming.**
  - The world is divided into a grid of cells, each streamed in by distance in a worker (geometry clusters, textures by mip, foliage, probes).
  - A world-partition editor shows what is loaded.
  - It builds on the distance-group streaming of `streaming.ts`.

### F7. Characters and animation

- [ ] **F7a. GPU skinning and morph targets.**
  - Compute skinning, with a dual-quaternion option and writing to the velocity buffer.
  - glTF morph targets on import, with sparse deltas and GPU blending.
  - Corrective shapes driven by joint angles.
- [ ] **F7b. Faces.** A facial rig standard (ARKit's 52 blend shapes, or FACS), with animation import, phoneme-driven lip sync from audio, and look-at with saccades.
- [ ] **F7c. Character shading.**
  - **Skin:** F1d SSS with a dual-lobe specular, micro-normal detail and cavity.
  - **Eyes:** a refractive cornea, an iris with parallax and caustic, and a wet tear line.
  - **Hair:** strand cards with Marschner or Kajiya-Kay anisotropic shading, alpha-to-coverage with TAA, depth-sorted opacity and shadowing.
  - **Teeth and mouth:** occlusion.
- [ ] **F7d. Cloth and secondary motion.** A GPU position-based dynamics cloth with skinned constraints, colliders from the ragdoll shapes and wind, plus jiggle and spring bones for straps, antennas and hair.
- [ ] **F7e. Animation quality.**
  - **Motion matching:** a pose database searched every few frames.
  - Full-body IK with foot placement on terrain.
  - Physics-driven ragdoll blending (powered ragdolls).
  - Root motion, and an animation compression format.
  - It builds on the state machines, blend spaces, IK and retargeting already present.

### F8. Visual effects

- [ ] **F8a. GPU particles.**
  - Compute-simulated particles in the millions, with emitters, forces, curl noise, and collisions against the depth buffer and SDF.
  - GPU sorting for blended particles, and lighting from clustered lights and probes.
  - Flipbooks with motion-vector blending, mesh particles and GPU ribbons.
  - It replaces the CPU billboard system at 512 per effect. A node graph authors emitters (Niagara-lite).
- [ ] **F8b. Volumetric effects.** Smoke, fire and explosions as raymarched 3D textures (baked simulations or a small GPU fluid solver), lit by the sun and lights, and casting into the F5b froxel fog.
- [ ] **F8c. Destruction.** Voronoi pre-fracture in the editor, physics-driven chunks with debris particles and dust, decals at the breaks, and GI that updates (F3e).

### F9. The asset pipeline for AAA content

- [ ] **F9a. High-to-low baking.**
  - Normal, AO, curvature, thickness, position and ID maps baked from a high-poly mesh onto a low-poly one.
  - Cages or ray distances, MikkTSpace-synced so bakes match F1c tangents, with anti-aliased supersampling.
  - This is the Marmoset and Substance baker workflow, and the foundation of every AAA prop.
- [ ] **F9b. Smart materials.**
  - Layer-based texturing in the Mesh tab: fill layers, masks generated from bakes (edge wear from curvature, dirt from AO, rust from position and gravity), anchors and brush strokes.
  - Exports to 4K texture sets, with UDIM support for heroes.
  - It turns the P1 texture generators and the I15 bakes into a Substance Painter-class workflow.
- [ ] **F9c. Scans and dense meshes.** Import of photogrammetry and scan meshes (millions of triangles), automatic delighting of albedo, auto-UV, and conversion to F6a clusters with no manual LODs. Decimation to a "game" proxy for collision.
- [ ] **F9d. Import completeness.**
  - FBX (through a WASM converter), USD/USDZ, and the full set of glTF KHR material extensions (F1d).
  - 8K textures, HDR environments (`.hdr`, `.exr`, KTX2 HDR), and IES profiles.
  - Per-platform texture compression on import.
- [ ] **F9e. Packaging and storage.**
  - A binary package format (chunked geometry, KTX2 and meshopt, a manifest), replacing base64 JSON sidecars.
  - **Direct-to-storage uploads**, past the 4.5 MB request body, with dedupe by content hash.
  - Asset validation: texel density, naming, budgets, missing maps.
- [ ] **F9f. Asset library.** In-editor search and import from CC0 libraries (Poly Haven, ambientCG), plus a Cartbox library of scanned surfaces, props and HDRIs prepared for the tier. These are licensed for redistribution and attributed.

### F10. Look development and the editor viewport

- [ ] **F10a. View modes.** The viewport shows exactly what the game renders, plus diagnostic views:
  - single buffers: lit, unlit, base colour, roughness, metallic, normals, AO, lighting only;
  - motion vectors;
  - complexity: shader complexity, light complexity, overdraw;
  - geometry and textures: LOD and cluster colouring, texel density, mip residency;
  - shadow cascades.
- [ ] **F10b. Path-traced reference.**
  - A progressive WebGPU compute path tracer over the scene BVH, using the same materials and lights. It is the ground truth for F0–F5 parity tests, the look-dev check, and the source for F3d bakes.
  - A **high-resolution capture** mode (accumulated, up to 8K) for marketing shots and the roadmap's reference images.
- [ ] **F10c. Look-dev stage.** A neutral scene with an HDRI turntable, a calibrated grey and chrome ball, a colour checker and light rigs, where any asset is checked under standard lighting before it ships.
- [ ] **F10d. Cinematics.** Timeline sequences (from the existing timeline) with the physical camera (F4c), focus pulls, camera shake and rails, plus offline rendering to video through F10b accumulation.

### F11. Showcase and acceptance

- [ ] **F11a. Lockout and Beaver Creek on `aaa`.** Both maps re-lit in physical units, with:
  - GPU-baked directional lightmaps plus DDGI;
  - a physically based sky with volumetric clouds, and froxel fog;
  - F9a-baked kit pieces with smart materials;
  - GPU foliage, F5d water and projected decals.

  Captures are compared before and after, at native resolution, at frame-time budget on each device class.
- [ ] **F11b. A photoreal reference scene.** A new map built entirely through the pipeline, for example a Forerunner ruin in a misty canyon at dusk:
  - scanned rock and foliage;
  - a cluster-rendered cliff;
  - hero props baked from high-poly;
  - a skinned, facially animated Spartan in close-up.

  It is the tier's public demonstration, and its frames are compared against the path tracer and against reference photography.

## Order

The order is by visual impact per unit of effort, with dependencies respected:

1. **Milestone A, "Correct light" (UE4-class baseline).** F0a → F0b → F0c → F1a → F1c → F3a → F4a → F4d → F4e → F0d.
   - Linear HDR, mips, prefiltered IBL and HDR TAA together close gaps 1, 2, 3 and 6, the four largest, and need no new content.
   - Deliver F11a captures at the end.
2. **Milestone B, "Grounded" (shadows and AO).** F2a → F2c → F3c → F2d → F2e → F3b → F1f.
   - Every object sits in its world: contact-hardening shadows, contact shadows, GTAO, HDR probes and decals.
3. **Milestone C, "Living light" (current-gen lighting).** F3d → F5a → F5b → F3e → F3f → F2f → F2b → F4b → F4c.
   - GPU bakes, physical sky, volumetric fog, real-time GI, upscaling and the physical camera. This is where the image reads as current-gen.
4. **Milestone D, "Content".** F9a → F9b → F9e → F9d → F10a → F10b → F10c → F1d → F1e → F1b.
   - The pipeline that makes AAA assets possible, and the reference renderer that keeps the renderer honest.
5. **Milestone E, "Scale".** F0e → F6a → F6b → F6c → F6d → F5c → F5d → F5e.
   - Dense worlds, big terrains, clouds, water and weather.
6. **Milestone F, "People and spectacle".** F7a → F7c → F7b → F7d → F7e → F8a → F8b → F8c → F9c → F9f → F10d.
7. **F11b**, the reference scene, is built throughout from Milestone D on, and finished last.

Milestones A and B lift every existing cart on the `aaa` tier. The image changes most per unit of work there, and they are the right place to start.
