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

- [x] **F0a. Present from the GPU.**
  - On the `aaa` tier, the scene renders to the canvas through the WebGPU swapchain, with no readback.
  - The cart's 2D framebuffer becomes a texture composited on the GPU (the HUD and the TIC-80 layer), keyed exactly as `MeshOverlaySurface` keys it today.
  - The sky dome, sun shafts and vista backdrop move from CPU painting to GPU passes.
  - The overlay decorator chain (lighting layer, post-FX stack) gains a GPU-texture path, so a decorator consumes a texture rather than bytes.
  - *Exit:* zero `mapAsync` per frame on `aaa`, and the 1–2-frame overlay lag gone.
  - **F0a: done.** The `aaa` tier (a model of its own, WebGPU-only; without WebGPU it plays as Modern) presents its 3D frame from the GPU. The frame never comes back to the CPU.
    - **The scene and the held weapon.** Both renderers draw into textures (`renderToTexture`) instead of reading back.
    - **The presenter** (`render/gpuPresent.ts`, on the renderer's own device) runs the CPU's per-frame work as GPU passes:
      - the sky dome, its sun's glow and drifting clouds, a ray a pixel;
      - the sun shafts' mask and gather;
      - the composite: scene over base, shafts, weapon, the cart's frame keyed on top as a HUD, then the holo UI as a premultiplied layer;
      - the eye-adaptation luminance and the sun's visibility, reduced in one compute workgroup. That reduction is the only readback left: sixteen bytes, asynchronously.
    - **The post stack moved too.** It was pulled forward from F4e, because sampling a WebGPU canvas from the WebGL1 post pass is a fragile cross-API copy every frame. `fx/gpuPostFx.ts` is the WebGL pass and its dual-Kawase bloom pyramid in WGSL, effect for effect.
    - **On the page.** A GPU-presented page creates no WebGL context at all. Lockout and Beaver Creek can be tried on the path with `/lockout?present=gpu`; the `gpuPresent` player option opts any mesh scene in.
    - *Tests:*
      - `gpu-present.test.ts` (Dawn): the kept texture is the readback byte for byte; the sky matches the CPU backdrop ray for ray (within 2 levels); the full composite with shafts, HUD and holo is within half a level of the byte path on average, and so are the measurements; the post stack runs in the presenter.
      - `gpu-postfx.test.ts` (Chromium): the WGSL stack against the WebGL pass is within 1 level on Lockout's stack, and identical with every effect on.
    - *Left for later:*
      - The cart's frame and the holo layer are still CPU-drawn and uploaded each frame; F0e retires the uploads where nothing changed.
      - The frame is still 8-bit and display-referred (F0b), at the model's 1080p (F0d).
      - The path applies only with nothing CPU-drawn between the scene and the screen. 2D relighting, weather, the HD-2D world, sprite backdrops and foreground placements keep the byte path.
      - This container's headless Chromium renders WebGPU to textures but doesn't display a WebGPU canvas. So the in-browser check here read the canvas's texture back through a test hook. Showing on a real screen still wants a look on a real device.
- [x] **F0b. Linear HDR colour.**
  - The scene target becomes `rgba16float`, and albedo and emissive textures are sampled as sRGB.
  - All lighting runs in linear space, and blending happens in linear HDR. One tone map sits at the end of the frame.
  - Lights, sky and emissive take **physical units**: lux for the sun, candela or lumens for punctual lights, nits for emissive, EV100 for exposure. Editor conversion keeps existing scenes looking the same.
  - The fantasy tiers keep their byte space, pinned by their existing parity tests.
  - **F0b-1, linear HDR: done.** On the `aaa` tier (`RenderCaps.linearHdr`, or the `linearHdr` player option on a GPU-presented scene), the scene renders in linear HDR. Physical light units are still to come (F0b-2).
    - **The scene target is `rgba16float`.** That covers the colour, MSAA, SSR, reflection and TAA targets, and the held weapon.
    - **Authored colour is decoded from sRGB in the shader.** This covers albedo, emissive, light and rim colours, the ambient floor, the environment gradient, the environment map, reflection probes and effect tints. Light maps, light probes and AO stay as they are, because they are factors rather than colours.
    - **Lighting and blending run in linear space, with no clamp.** Fog mixes in linear, and the shader's own tone map is skipped. Nothing is clamped until the end, so a highlight above 1 survives to the tone map.
    - **The tone map runs once, in the presenter.** The scene, sky, shafts and weapon blend in linear. The scene's ACES tone map and exposure then apply, and the result is encoded to sRGB. The cart's HUD and the holo layer are composited after that, unmapped. Eye adaptation measures the linear, exposed frame.
    - **What changes on screen.** Half-lit surfaces read brighter and saturated colours stay richer, which is what linear lighting should do. An existing scene therefore looks different on `aaa` than on Modern; F0b-2's unit conversion is where it gets calibrated. Unlit colour, an untone-mapped sky and the HUD come out as they did.
    - **Where it applies.** It is on only where the frame is GPU-presented. A page without a WebGPU canvas rebuilds the renderer in byte space, and so do the fantasy tiers. Try it with `/lockout?hdr=1`.
    - *Tests:* `gpu-present.test.ts` (Dawn), new "linear HDR" suite:
      - unlit HDR matches the byte path within 2 levels;
      - a half-lit surface comes out at `srgb(lin(c)·0.5)`;
      - ACES with exposure maps as expected, and the HUD after it stays unmapped;
      - the measured luminance is linear × exposure;
      - an untone-mapped sky matches the byte sky.
  - **F0b-2, physical light units: done.** With this, F0b is complete.
    - **The calibration** (`model/physicalLight.ts`). Rigs keep the renderer's units, and physical units are a fixed, exact conversion. It uses the photographic model, in which 1.2 · 2^EV100 nits saturates, with exposure 1 at EV100 15 (a sunny day). So one unit of luminance is 39,322 nits, and a unit sun is about 123.5 klx. EV100 `ev` is exposure 2^(15 − ev).
      - Because the conversion is fixed and lossless, an existing scene looks the same in either units. No stored scene, renderer input or cart API changed.
    - **Inverse-square falloff.** `SceneLight.falloff: "inverseSquare"` is 1/d² (d in metres, floored at 1 cm), windowed by (1 − (d/range)⁴)² to nothing at its range. It is what gives a candela its meaning.
      - It is in all three renderers (software, WebGL, WebGPU) and in the probe relight. Existing lights keep the (1 − d/range)² fade, so parity holds.
      - Switching a light's falloff keeps it as bright halfway to its range.
    - **In the editor.** The Lighting panel gains a Units switch, Relative or Physical; it is only a display choice and is saved with the rig.
      - In Physical, sky luminance and the ambient fill read in nits, exposure in EV100, a sun in lux, an inverse-square light in candela, and a fading light in lux next to it. Their sliders move in decades.
      - A point or spot light gains a Falloff switch, Fade or Inverse square.
      - The material panel shows emissive strength as a luminance in nits. The colour picker now keeps an emissive above 1 (one that blooms) instead of clamping it.
    - **What it shows about existing scenes.** Beaver Creek's sun reads about 420 klx at EV 14.9, roughly four times a real noon sun. The art is lit hot for a display-referred pipeline, so it's worth re-balancing once F3's physical sky lands.
    - *Left for later:*
      - Cart lights from Lua (`light3d`, `sun3d`) stay in the renderer's units: the mailbox's 16-bit ×256 encoding can't hold lux.
      - The sky dome's own colours are display colours, not nits; F3's physical sky takes that over.
      - Measured auto-exposure stays relative stops around the authored exposure.
    - *Tests:*
      - `physical-light-units.test.ts`: the calibration and its round trips, the falloff and its window, the switch keeping brightness, the packed flag, and the rig's units and falloff surviving a save.
      - `webgpu-parity.test.ts` and `webgl-parity.test.ts` now include inverse-square point and spot lights, matching the software rasteriser.
- [x] **F0c. Frame graph.**
  - A declarative pass graph with transient, aliased resources, replacing the hand-ordered passes of `WebgpuSceneRenderer`.
  - It produces a depth prepass and a thin G-buffer of normal, roughness and material ID.
  - It produces a **velocity buffer**, with per-object motion that includes skinned and animated vertices.
  - Every pass is timed. Rendering is still forward+ for material flexibility; screen-space effects read the prepass buffers.
  - This also unblocks P6's deferred contact shadows and foliage SSAO.
  - **F0c-1, the frame graph: done.** `render/frameGraph.ts`: a frame is built each time as passes and the textures they read and write. Compiling it is pure, with no device needed, so it is tested on its own.
    - **It culls.** It keeps a pass that writes an imported texture (one that outlives the frame) or is marked kept, and anything those passes need. The rest never encode.
    - **It allocates.** A transient lives from the first kept pass that uses it to the last. Its usage flags come from how the passes use it. Transients of the same shape whose lives don't overlap share one texture. A pool keeps them across frames, so a steady frame creates nothing and an idle one is destroyed after 120 frames.
    - **It times.** Every kept render and compute pass gets its own timestamps (`GraphTimer`) when the device has `timestamp-query`. `RenderStats.passes` carries them, and the editor's profiler lists them under "GPU frame".
    - **WebGPU frames go through it.** `WebgpuSceneRenderer` builds every frame as a graph, with no change to what it draws:
      - opaque;
      - the copy behind refraction;
      - see-through;
      - reflections and their copy back;
      - the TAA resolve and sharpen;
      - the readback.
      - The MSAA colour and the reflection targets (with their multisampled twins) are now transients. The textures cached bind groups sample (the depth, the refraction copy and the TAA history) stay imported.
    - *Tests:*
      - `frame-graph.test.ts` (pure): culling, order, lifetimes and aliasing, usage, declaration errors, the pool and the timestamp arithmetic.
      - On Dawn: an aliased frame encodes correctly, and the scene renderer names and times its passes and makes no new transients on a steady frame.
      - The WebGPU parity suites (MSAA, TAA, reflections, refraction, see-through) are unchanged and pass.
  - **F0c-2, the depth prepass and thin G-buffer: done.** With `prepass` on a frame (the `aaa` tier's `prepass` cap, on GPU-presented frames; `/lockout?hdr=1` turns it on), the graph's first pass is `prepass`.
    - **What it draws.** Every batch the opaque pipeline draws: opaque and cut-out, not refracting. Its depth goes into the frame's depth and its thin G-buffer into an rgba16float the renderer owns:
      - xy = the octahedral world normal facing the viewer, normal mapped;
      - z = roughness (the material's, its map's, or its graph's);
      - w = a material ID, 1 and up per material in the frame, 0 where nothing opaque drew.
    - **What it drops.** Exactly the pixels `fs` drops (a cut-out, a near-transparent texel including a graph's alpha, Active Camo's screen door), with the same parallax UVs. So its depth is the depth shading would have left.
    - **The opaque pass after it.** It loads that depth and tests less-or-equal, so each visible pixel is shaded once. The vertex position is `@invariant`, so both passes compute the same depth.
    - **Anti-aliased frames.** The prepass is multisampled with the frame and resolves its G-buffer.
    - **For screen-space effects.** `prepassTargets` hands out the depth and the G-buffer for the frame.
    - *Tests:*
      - `webgpu-parity.test.ts` now runs its whole real-device suite a second time with the prepass on, and every comparison with the software rasteriser holds unchanged. That covers cut-outs, Active Camo, material graphs, parallax, normal maps, refraction, see-through, soft edges, lights, shadows and probes.
      - `frame-graph.test.ts` reads the G-buffer back for a plain and an anti-aliased frame: each quad's normal, roughness and ID, nothing in the corner, nothing for a see-through quad, and the prepass running first.
  - **F0c-3, the velocity buffer: done.** With this, F0c is complete. The prepass also writes an rg16float velocity buffer (`prepassTargets.velocity`): how far each opaque pixel moved on screen since last frame, in UV units (x right, y down), so its last position is uv − velocity.
    - **The camera.** This frame's and last frame's view-projection, both without the TAA jitter, so a still scene under TAA reads still.
    - **Each object.** Its `previousModel` when the caller gives one. Otherwise it is matched to last frame's copy of the same mesh (its LOD chain's first) at the same place among that mesh's copies, before culling so a copy leaving the view doesn't shift the rest. An object with no match reads as not having moved.
    - **Each skinned or animated vertex.** A dynamic mesh copies its vertices to a second buffer before each upload, and the prepass reads last frame's positions from it.
    - **Wind-swayed foliage.** It bends by last frame's wind.
    - **How it is drawn.** The motion transforms ride after the frame's transforms in the instance buffer (`motion0.x`); the previous wind is `wind1`. A `vs_prepass` vertex stage wraps the scene's own vertex function, so the depth stays the same.
    - *Tests:* `frame-graph.test.ts` on Dawn checks:
      - a still scene reads zero, and so does an empty pixel;
      - a camera pan reads the velocity the projection predicts;
      - an object moved 0.3, with its previous model given or matched to last frame's copy, reads its projected shift;
      - a dynamic mesh whose vertices moved reads the same;
      - a jittered TAA frame reads zero.
      - The parity suite passes with the prepass on, and Chromium creates the targets and pipelines without errors.
    - *Left for later:* F4a's TAA reprojects with it; until then nothing reads it. Particles and debris that come and go can mismatch for a frame (they read as having moved from another copy's place), and the TAA's rejection will handle that.
- [x] **F0d. The `aaa` tier.**
  - A console model on the dedicated Modern core (`packages/modern-core`, ENGINE_PARITY EP20b: a Lua 5.4 VM with direct engine calls and no command cap). `MODELS.modern` still points its `engineUrl` at the 360 core, and the tier ends that placeholder.
  - It renders at native device resolution × DPR, with dynamic resolution driven by the GPU frame time, and gives the 2D layer a scaled presentation.
  - It is listed on the home page with a starter scene. `modern` stays as the 1080p 360-pipeline tier.
  - **F0d-1, its own core and starter: done.**
    - **The dedicated Modern core is the tier's own.** An `aaa` cart runs there unless it asks not to (`runsOnDirectCore`): a Lua 5.4 VM whose calls into the 3D engine are calls, with no command cap. Players find the core beside whatever engine they are given (`directCoreBeside`), behind any base path, and exports carry it.
    - **Its 2D layer is the HD cores' 1280×720 frame.** The tier declared Modern's 1920×1080, but both cores it could run on are laid out for 1280×720: the 360 core is compiled at that size, so its frame was read 1920 pixels a row, and the dedicated core's HD layout does not fit 1080p at all. The player and editor specs now say 1280×720. The 3D frame is not bound to it (F0d-2).
      - *Found, not fixed here:* `modern` still declares 1920×1080 on the 1280×720 360 core, so its 2D layer is read the same wrong way.
    - **The editor runs it.** Its playtest prelude used Lua's `debug` library, which the dedicated core's sandbox leaves out, so any cart on that core (a Modern scene that chose it, too) failed to start in the editor.
      - The console and traces now work without `debug`. Breakpoints and stepping need it: on this core the Debugger button says so instead.
      - Giving the core TIC-80's `debug` library means rebuilding it with Emscripten 3.1.64, which this environment can't download; it is left for a core rebuild.
      - A cart the core rejects now shows the core's own error, not just "rejected".
    - **A starter and the home page.** `/edit/new?model=aaa` opens on Beaver Creek on the tier (the `aaa` starter), and the home page lists the tier. The Mesh tab shows the dedicated core as the tier's own instead of offering it.
    - *Tests (`aaa-tier-core.test.ts`):* which carts run on which core; finding the core beside an engine URL; exports carrying it; the 2D spec in the player and the editor; on the real core, an `aaa` cart booting and drawing a 1280-wide frame (and the HD layout refusing 1080p); the starter.
    - In Chromium: `/edit/new?model=aaa` opens Beaver Creek on the HD core, and Run plays it on the dedicated core, presented by WebGPU at 1280×720, with no GPU errors. It looks the same as the `xbox360` starter.
  - **F0d-2, the display's own resolution: done.**
    - **The frame follows the display.** With the tier's `nativeResolution` cap (or `/lockout?hdr=1`), the WebGPU canvas's backing store is its CSS size in device pixels (`nativeBackingSize`), up to 4K with its shape kept, and follows the page as it resizes.
    - **The 3D renders at it.** The presenter's frame takes the canvas's size (`GpuPresenter.resize`), and the scene and the held weapon render at it.
      - The scene renderer changes size between frames (`resize`): its colour and depth, the refraction copy, the G-buffer and velocity, the multisampled depth, the TAA history (which starts over) and the readback are remade. Meshes, textures and pipelines stay, and the frame graph's transients follow by themselves.
    - **The 2D layer is scaled to it.** The cart's frame, HUD and holo UI stay 1280×720 and are drawn to the frame texel by texel (nearest), so the HUD's key colours stay exact. Every pass that reads a layer of another size (compose, the shaft mask, the measurements) maps the frame's pixel to its texel (`loadScaled`), which is the same texel when the sizes match: frames at the model's size come out as before.
    - *Tests (`native-resolution.test.ts`):* the backing size, at a pixel ratio and capped; on Dawn, a 32×16 layer presented into a 64×32 frame lands each pixel on its 2×2 exactly; the scene renderer, with multisampling, TAA, the prepass and reflections on, renders at 64×36, 96×54 and 48×27 in turn with no validation error and the frame drawn right at each.
    - In Chromium at a pixel ratio of 2, Beaver Creek on `aaa` (960×540 CSS) presents a 1920×1080 frame with no GPU errors.
  - **F0d-3, dynamic resolution: done.** With the tier's `dynamicResolution` cap (or `/lockout?hdr=1`), the 3D renders at a share of the native frame chosen from the GPU's frame time (`render/dynamicResolution.ts`):
    - It reads the frame's GPU time (the scene's passes and the presenter's), smoothed. A browser that can't time the GPU gives no reading, and the scale holds.
    - Down fast, up slow: over 95% of the budget it drops at once to the scale whose pixels fit 85% (time goes with the square of the scale); well under (70%) for two seconds, it climbs one step. Each change waits a few frames for the late readings to catch up.
    - The scale moves in twentieths between a half and one, so a size it used comes back to the same targets.
    - The presenter filters a smaller scene and held weapon up to the frame (bilinear); one the frame's size is still read texel for texel.
    - The profiler shows the 3D resolution and its share of the frame when it isn't all of it.
    - *Tests (`dynamic-resolution.test.ts`):* the steps; whole while the GPU keeps up; a GPU at 1.5 budgets drops once, within a third of a second, to 0.75 and holds; never under a half; back up a step at a time when there is room; held with no reading; on Dawn, a half-size scene filtered up, flat in its flats and blended across an edge.
    - In Chromium (SwiftShader, with timestamp queries) at a pixel ratio of 2, Beaver Creek's 1920×1080 frame renders its 3D at 960×540, the floor, with no GPU errors.
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
  - **F1a-1, mips and anisotropy: done.** On the `aaa` tier (the `mipmaps` cap; the `mipmaps` player option; `/lockout?hdr=1`), every 3D texture gets a full mip chain, sampled trilinearly at 16× anisotropy.
    - **Made on the GPU** (`render/mipmaps.ts`). Each level is drawn from the one above.
      - Colour maps (base, emissive, blend surface) go through an `rgba8unorm-srgb` view, so they average in linear light. A distant black-and-white checker reads as the grey it looks like (188), not the darker byte average (128).
      - Data maps (metal-roughness, occlusion and relief, normal, light map, detail) average as stored.
    - **Cut-outs keep their coverage.** A colour map with see-through texels is mipped on the CPU instead. Each level's alpha is rescaled so the share of texels passing the cutoff matches full size (Castaño), and transparent texels take the level's mean colour so edges don't fringe dark. Plain averaging would thin foliage cards away with distance.
    - **Where it applies.** The fantasy tiers are untouched, so they keep parity with the software rasteriser, which has no mips; `trilinear` still means bilinear there.
    - *Tests:* `mipmaps.test.ts` covers:
      - the chain arithmetic;
      - linear-light versus byte averaging on Dawn;
      - coverage-preserving levels;
      - on Dawn, a receding one-texel checker: shimmer between two camera positions 3 cm apart falls from about 20 levels to 0, and the far floor reads the linear-light grey;
      - a far field of cut-out cards stays about half covered.
      - In Chromium, Beaver Creek mips 17 textures and samples them anisotropically, with no errors.
    - *Left for later:*
      - The coarsest levels of a cut-out have too few texels to hold its coverage exactly, so the farthest cards round to more or less covered.
      - Mips cost texture memory a third more until compression lands.
      - F1a-2 transcodes KTX2 to BC7/ASTC/ETC2 with its mips kept, and F1a-3 ships Beaver Creek's textures compressed for the 4× memory exit.
  - **F1a-2, KTX2 to the GPU's own formats: done.**
    - **The encoder writes the whole mip chain** (`setMipGen(true)`, renormalised for normal maps). The GPU can't make a compressed texture's mips, so they ride in the file, about a third larger.
    - **The transcoder** (`ktx2Decoder.ts`) still gives every path the RGBA top level. Given a renderer's `gpuFormats`, it also transcodes the whole chain into the first one it can (`DecodedTexture.gpu`): BC7 on desktop, ASTC 4×4 on Apple and mobile, ETC2 the fallback. That is a byte a texel, a quarter of RGBA's.
      - A file without its full chain, or not a whole number of 4×4 blocks, keeps the RGBA path, where the renderer makes the mips.
    - **The device and renderer.** The device requests `texture-compression-bc`, `-astc` and `-etc2` where the adapter has them. The `aaa` renderer advertises the formats (`SceneRenderer.textureFormats`), the mesh overlay passes them to its KTX2 decoder, and the upload takes the compressed chain level by level.
      - A cut-out colour map keeps the RGBA path, for its coverage-preserving mips.
    - **The memory estimate** counts a compressed texture's own bytes (`textureMemory`).
    - *Tests:* `ktx2-native.test.ts` covers:
      - transcoding to each format, with sizes per level;
      - no chain without formats, for an unknown format, or for a file without mips;
      - the memory estimate under a third of RGBA-with-mips;
      - the device's format order;
      - on Dawn, the BC7 chain uploaded as `bc7-rgba-unorm` and drawn within BC7's error of the RGBA path (mean under 6 levels).
    - *Left for later:* BC5/BC4 for two- and one-channel maps need the shaders to rebuild the missing channels (a normal's z), so every map is BC7, ASTC or ETC2 for now.
  - **F1a-3, Beaver Creek compressed: done.**
    - **Half a byte a texel.** An opaque ETC1S texture (colour, a light map) now transcodes to the GPU's half-byte forms where the device has them: BC1 on desktop, ETC2 RGB on mobile. Data maps (UASTC) and anything with alpha keep a byte a texel.
    - **A texture bake** (`npm run bake:map <id> textures`). It encodes each image of a map's sidecar to KTX2 with its mips into a generated table (`beaverCreekTextures.generated.ts`), keyed by the image's bytes.
      - Each occlusion map is baked packed with its relief, as the player packs them at load (I4). That occlusion image carries the packed KTX2 (`ktx2Relief`) and decodes straight to the packed texture.
      - A cut-out's colour map is left as it is, for its coverage-preserving mips.
      - `map-bakes.test.ts` fails when the table no longer matches the sidecar's images.
    - **The sidecar** gives each baked image its KTX2 beside its PNG (`EncodedImage.ktx2`). Only a renderer that samples compressed formats decodes it; every fantasy tier still decodes the PNG, so Beaver Creek looks as it did there. The Lockout page now passes the KTX2 transcoder, which loads only when a texture needs it.
    - **What it saves.** Beaver Creek's textures were 1.57 MB as one-level RGBA before F1a, and 2.10 MB as RGBA with mips. They are now **448 KB**: the light map and terrain in BC1, the packed occlusion maps in BC7, and the cut-outs in RGBA with coverage mips. That is **4.7×** less than the same textures mipped, the like-for-like (no shimmer needs the mips), and **3.5×** less than the one-level RGBA they were before.
    - *Tests:*
      - `beaver-texture-memory.test.ts` measures that drop.
      - `ktx2-native.test.ts` checks the half-byte formats: opaque ETC1S goes to BC1 or ETC2 RGB, while data and alpha keep BC7.
      - In Chromium, Beaver Creek's light map and terrain upload as BC1, with no errors.
    - *Left for F1a:*
      - The four cut-out textures, about 175 KB of the 448, stay RGBA. Compressing them needs alpha-to-coverage (or coverage-preserving mips the encoder can't make), and that would take the measure past 4× against the one-level baseline too.
      - The N64 model's true trilinear filtering needs the software rasteriser's own mips.
- [ ] **F1b. Texture streaming.** Mip streaming driven by GPU feedback: a sampler-feedback-style pass that records the mip each material wanted, under a texture-memory budget per scalability level, with residency in the profiler. It also covers texture arrays, or bindless where available, so materials stop competing for 16 bind slots.
- [ ] **F1c. BRDF upgrade.**
  - Multiscatter GGX energy compensation (Kulla-Conty, or Fdez-Agüera's LUT).
  - A height-correlated Smith visibility term.
  - Fresnel and split-sum on ambient specular, and specular occlusion from AO and bent normals.
  - **Stored MikkTSpace tangents**, so normal maps match Substance, Marmoset and Blender bakes exactly. Derivative tangents stay as the fallback.
  - **F1c-1, the BRDF: done.** The linear-light shader (the `aaa` tier) shades with the AAA BRDF (`render/brdf.ts`). The Modern tier's shader keeps its term-for-term match with the software rasteriser.
    - **Height-correlated Smith visibility** (Heitz) replaces the separable Schlick-GGX, for every light and the sun.
    - **The specular is normalised against the diffuse.** The engine's diffuse is `albedo · N·L` rather than `albedo / π`, so the specular lobe takes the π the old path left out; highlights were π times too dim.
    - **The split-sum DFG** (Karis) weights the environment's reflection by `f0·A + B` rather than `f0`. A dielectric now reflects more toward grazing (Fresnel on ambient), and a rough one less.
      - The 32×32 table is integrated once on the CPU by GGX importance sampling with the same visibility, and read from a storage buffer: all 16 of the fragment stage's sampled textures are bound.
    - **Multiple scattering** (Kulla-Conty, in Fdez-Agüera's closed form) adds back what single-scatter GGX loses, up to 70% for a rough metal. The environment gets it as a lobe, each light as a scale on its specular.
      - The diffuse beneath keeps only what the reflection leaves (`1 − E`), so a white dielectric in a white furnace stays at 1 rather than gaining its reflection (1.04).
    - **Specular occlusion from AO** (Lagarde): a crevice reflects less of the sky, by an amount that narrows with a smoother lobe.
    - **Fix: linear light is no longer clamped at 1** before the presenter's tone map. Since F0b, `finishAlpha` and `finishRefracted` had clamped every highlight to 1 in the half-float target too.
    - *Tests:* `brdf.test.ts` covers:
      - the table against a brute-force hemisphere integral (within 0.01);
      - white-furnace energy, Fresnel toward grazing, and specular occlusion;
      - that only the linear shader carries the new terms.
      - On Dawn, the linear output lands on the CPU's numbers: a white furnace reads 1 (±1%) for metals and dielectrics, rough or smooth; a black dielectric's reflection head-on and at 75° matches `f0·A + B` within 3%; and a rough metal's highlight matches D·V·π times its compensation within 2%, over 1 and unclamped.
      - In Chromium, Beaver Creek on the `aaa` tier compiles the four linear-light shaders with the table, with no errors.
    - *Left for F1c:*
      - Bent normals for specular occlusion: no bake makes them yet (F9).
      - The clearcoat lobe keeps its Schlick visibility.
  - **F1c-2, stored MikkTSpace tangents: done.**
    - **The model.** A primitive can carry tangents (`MeshPrimitive.tangents`, `x,y,z,w`) through the sidecar and glTF (`TANGENT`).
      - A node's transform moves them with its own 3×3; a mirroring one flips w.
      - The engine samples textures at (u, 1 − v), so its bitangent `w · (n × t)` points up V: MikkTSpace's own sign, and glTF's once glTF's V is flipped into the engine's on import (below).
    - **Made on import** (`model/tangents.ts`). A normal-mapped primitive that arrives without tangents gets MikkTSpace's, from its WebAssembly build: vendored in `src/vendor/mikktspace` (42 KB), loaded only in the editor and only for such an import.
      - MikkTSpace takes unwelded triangles, so the primitive is unwelded, given its tangents, and welded again. A vertex splits only where its corners disagree, at a UV seam or a mirrored island.
    - **On the GPU.** The WebGPU vertex grows to 64 bytes with the tangent at location 7. Zeros (w = 0) mark a primitive without tangents, or a live skinned copy, whose tangents would stay in bind pose.
      - The linear-light shader decodes a normal map in the stored frame as it was baked: normal and tangent unit at each vertex, interpolated and left unnormalised, with the bitangent `w · (n × t)`.
      - Without one it keeps the derivative frame, which is all the Modern tier, WebGL2 and the software rasteriser use. The prepass's G-buffer normal goes through the same `mappedNormal`.
    - *Tests:* `tangents.test.ts` covers:
      - the vendored module loading in Node through the browser loader;
      - U-aligned tangents with w = +1 on a plain quad;
      - a mirrored island splitting only its shared edge, with opposite w;
      - generation only where needed;
      - the sidecar and glTF round trips;
      - the 64-byte interleave.
      - On Dawn, the generated frame decodes a map as the derivative frame does on a plain layout (within 2%, along U and up V). A stored frame that differs is the one used, and w flips the bitangent.
      - In Chromium, Beaver Creek on the `aaa` tier draws with 64-byte pipelines and the four tangent-aware shaders, with no errors.
    - *Found, then fixed:* imported glTF UVs were stored as glTF writes them (V down) while the engine samples V up (as OBJ and its own meshes are), so an imported glTF's textures showed flipped vertically. glTF's V is now flipped on import and export (`flipV` in `gltfCodec.ts`), with the tangents' w carried over as it is. Meshes already saved in a cart keep the coordinates they were stored with; importing the file again gives the corrected ones.
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
- [x] **F1f. Projected decals.** Deferred, D-buffer-style box decals that modify base colour, normal, roughness and AO, with sorting, fade by angle and distance, and sharing of an atlas. They replace the quad-mesh decals for impacts, grime, leaks and road markings.
  - **F1f-1, projected box decals: done** on the `aaa` tier. They replace the decal marks' quads there; every other tier keeps the quads.
    - **Boxes** (`editor/render/projectedDecals.ts`). A mark is a box on its surface: half its size across and along (turned by its spin), and a quarter of it out of and into the surface.
      - It carries its decal's tile, what is left of it, and its glow. A cart-laid mark fades smoothly over the last third of its life, where the quads dissolved frame by frame.
      - They are ordered permanent first, then the oldest, so a fresh mark lies over an old one (`DecalSystem.liveMarks`).
    - **The atlas** is shared. Every decal's pattern is drawn once to a 64² tile in two planes:
      - colour, with coverage in alpha, supersampled so the edge is soft rather than dithered;
      - surface: the normal its relief bends (a pock sinks, a glyph is cut in, frost stands), its roughness and its occlusion.
    - **On the GPU** (`player/render/decalBuffer.ts`), the boxes and tiles share one storage buffer at group 1 binding 13. The fragment stage's 16 sampled textures are all bound, so the tiles are filtered by hand, as the DFG and LTC tables are.
      - A box is three rows taking a world point into it, its tile, alpha and glow, and its surface normal. The frame takes up to 256, the nearest the camera.
    - **In the shader**, before a surface is lit, each box round the point lays its tile over it by its coverage. The tile's coverage is faded:
      - as the surface turns from the box's normal (so a floor's mark doesn't run up a wall);
      - toward the box's depth;
      - and as the mark fades.
      - It replaces the base colour, roughness and metalness (a mark is paint, not metal), multiplies in its occlusion, bends the normal by its relief and adds its glow.
      - Only opaque and cut-out surfaces that don't refract take decals.
    - *Tests:* `projected-decals.test.ts` covers:
      - the tiles' coverage and relief, the box's frame, the order and fade, and the packed boxes (rows into the box, the nearest kept, in order) and tiles;
      - on Dawn: a decal paints a lit white surface its colour; it fades with the mark; it misses a surface outside its box or turned from it, and a see-through one; it glows by its glow and occludes by its tile.
      - `shadowCascade.test.ts`: on the AAA tier the player hands over boxes and tiles, draws no decal quads, and draws the tiles once.
    - **Still to do:**
      - Grime, leaks and road markings authored as boxes of their own (the marks' presets are what exists now).
      - Excluding moving objects that pass through a box, by a receiver flag.
      - Culling boxes per cluster instead of looping all of a frame's 256.

### F2. Shadows and lights

- [x] **F2a. GPU cascaded shadows.**
  - Four cascades rendered on the GPU (no more CPU shadow rasteriser on `aaa`), with stable texel-snapped fitting.
  - Practical (log-linear) splits, cascade blending and a shadow-distance control.
  - Hardware comparison sampling, filtered with Poisson PCF or **PCSS** for contact-hardening penumbrae.
  - 2048–4096 per cascade, by level.
  - **F2a-1, four GPU cascades: done.** On `aaa` the sun's shadow is no longer rasterised on the CPU. The linear-light renderer draws it itself, on the GPU, every frame (`cascades.ts`, `WebgpuSceneRenderer.ts`).
    - **Fitting.** The view out to the shadow distance is cut by practical splits (λ = 0.75).
      - Each slice is covered by its bounding sphere, whose size depends only on its depths and the lens, so a cascade never resizes as the camera turns.
      - The sphere's centre snaps to the cascade's texel grid in the sun's frame, so an edge moves only in whole texels as the camera moves.
      - Each light backs off by a reach (the scene's span) beyond its slice, so a tower outside the view still shades it.
    - **Drawing.** Each cascade is a depth-only pass into one layer of a `depth32float` array (2048² by default, or the quality preset's map if larger), with slope-scaled raster bias. Wind bends the casters as it bends what is drawn.
      - What casts comes from the player, not the camera's draw list: everything still and casting (gathered again only when the posed set changes, as the CPU map redraws) plus what moved this frame.
      - Foliage casts within its cull distance, and a layer with impostors always from its full copies, never its crossed cards. Beaver Creek's meadow grass (45 m) no longer shades the ground past where it is drawn, and a rim tree shown as cards still casts its crown.
      - Cut-out casters still draw solid, as on the CPU map; alpha-tested casters are F2a-2.
    - **Testing.** A point is tested in the first cascade that holds it, pushed toward the sun by one to nine texels as the light grazes, and filtered over a 3×3 grid of hardware comparisons, each itself bilinear.
      - The outer tenth of a cascade fades into the next, and past the last into full light.
    - **The shadow distance.** It is the rig's `shadowDistance` (the Lighting tab's *AAA shadow reach*, 5–2000 m), or the scene's span held to 30–400 m when it sets none.
      - A caller that gives the linear-light renderer only a CPU map gets cascades of what it draws, 80 m out.
      - The other tiers keep the CPU map and its near cascade unchanged.
    - **Captures** (SwiftShader, 1920×1080):
      - Lockout's overview keeps its shadow layout. Lit deck tiles show as they did (0.73 against 0.72), so nothing self-shadows.
      - The frame reads darker (0.535 against 0.60) because this session's sky was darker, which lowers the sky's fill. The time the match took to load moved the sky, not the shadow.
      - Settling the views took as long as before (16 minutes against 13 to 17).
      - Beaver Creek's overview: the rim trees' crowns now lie sharp and dark down the canyon walls, where the CPU map's 1024² over the whole map left soft, faint smudges. The first capture also showed foliage past its cull distance still casting; that is what the foliage rule above fixes. The recapture with the fix did not finish: the dev server hit the session's two-hour limit for background work.
    - *Tests:*
      - `cascades.test.ts`: the splits lean logarithmic; the lens reads off the projection; each slice's corners fall inside its cascade, at depth 0 to 1; a caster toward the sun stays in front of the light. Turning the camera never resizes a cascade, and moving it moves a point by whole texels (fails without the snap).
      - `cascade-shadows.test.ts` (Dawn): the cascades leave the lit floor as it was, and a box the camera never draws darkens the floor under it to under 0.05.
      - `shadowCascade.test.ts`: on a GPU-presented AAA frame the player hands over the casters and sun in place of a CPU map, gathers the still ones once, reaches the rig's distance, and casts nothing with shadows off; the distance parses within its bounds and clears.
      - `shadowCascade.test.ts`, foliage: a bush past its cull distance never casts, a layer's full copies cast past their impostor swap, and its cards never do (fails under the draw rule).
  - **F2a-2, contact-hardening penumbrae, map size by level and cut-out casters: done.** With this, F2a is complete.
    - **PCSS** (`cascades.ts`, `CASCADE_SHADOW_WGSL`). Each test first searches the map round the point for what stands between it and the sun: 16 Poisson taps, read with `textureLoad`, as far round as an occluder at the light could blur it.
      - The blockers' average depth, times the cascade's depth span, is how far above the point they stand. Times the sun's size, that is the penumbra's width.
      - The filter is 16 hardware comparisons over that width, from a texel and a half at contact to 16 texels. Both tap sets turn per pixel by interleaved gradient noise, which TAA resolves.
      - The sun's size is the real sun's 0.53° (`SUN_SOFTNESS`), or four times it for a rig with soft shadows (`SunShadow.softness`).
    - **Map size by level.** The quality presets' `cascadeMapSize` is 4096 on high and 2048 on medium; low casts no shadows.
      - The maps are `depth16unorm`, so four 4096² layers take 128 MB rather than 256. Over a cascade's depth span (a few hundred metres at most) that still resolves a few millimetres.
    - **Cut-out casters.** A `mask` material casts through a second caster pipeline whose fragment stage drops what the scene drops: the base colour's alpha times its map's, against the material's threshold. Grass cards and leaf cards cast their shapes, not their quads.
      - Each cut-out caster's group binds the casters' uniforms and transforms, plus its base map. It is cached against the buffers and map it was made from.
    - *Tests:*
      - `cascade-shadows.test.ts` (Dawn):
        - a plate held 3 m over the floor blurs its edge over 4 pixels or more, more than 2 pixels wider than the same plate at 0.3 m (fails with the filter's width fixed);
        - a card opaque on one half and clear on the other shadows only under its opaque half (fails without the cut-out's discard).
      - `cascades.test.ts`: a metre toward the sun moves a point's depth by one metre's share of its cascade's span.
      - `shadowCascade.test.ts`: the high preset casts 4096² maps and medium 2048²; the real sun's size, four times it with soft shadows.
- [ ] **F2b. Virtual shadow maps.**
  - A 16K virtual shadow map, paged from a physical pool, with pages marked by the depth buffer and cached between frames for static geometry.
  - This is what makes shadow detail hold at every distance in UE5. It falls back to F2a on Medium and below.
- [x] **F2c. Contact shadows.** A screen-space ray march toward each light against the depth prepass, so small-scale contact (feet, foliage, props) grounds every object. It closes EDITOR_PRO P6's deferred item.
  - **F2c-1, the sun's contact shadows: done.** After the depth prepass, a full-screen pass (`contactShadows.ts`) marches each pixel 0.6 m toward the sun across the prepass's depths in 16 steps, jittered per pixel so TAA resolves the banding.
    - **The hit test.** A step is in shadow when the depth buffer holds a surface in front of it by no more than a thickness (0.2 m, plus the step and a share of the distance). So it neither misses a thin caster nor shadows what is merely behind a wall.
    - **Fades.** The term fades toward the screen's edges, where the depths run out, and from 30 to 50 m, where the cascades already resolve contact.
    - **Where it lands.** The pass writes an `rg16float` target the linear-light shader binds in its SSAO slot, so the fragment stage stays within its 16 textures:
      - **g** is the contact term, multiplied into the sun's shadow (`shadowFactor`) on opaque and cut-out surfaces, the only ones in the prepass;
      - **r** carries a CPU occlusion buffer through when a caller hands one over, so that slot still serves it.
    - **When it runs.** Only on frames with a prepass and a casting sun; the `aaa` model turns the prepass on.
  - **F2c-2, contact from spot and point lights: done as F2d-3.** With it, F2c is complete.
    - Marching per light in the shading loop needs the prepass's depth bound while the opaque pass draws. That means a read-only depth attachment and its own pipelines.
    - F2d rebuilds those lights' shadows on the GPU anyway.
    - *Tests:*
      - `contact-shadows.test.ts` (Dawn), with a box the cascades are told not to cast from:
        - with the prepass, the floor beside the box's foot away from the sun drops below half its light (fails with the contact term taken out);
        - toward the sun, and past the march's reach, the floor stays lit;
        - without the prepass, the floor by the box stays lit.
      - The pass's uniforms turn the sun into view space.
- [x] **F2d. Local light shadows on the GPU.** A larger atlas (4096² and up) with priority-based tile allocation by screen size, cached static tiles and PCF. It lifts the cap of 16 tiles.
  - **F2d-1, the GPU atlas, its sized tiles and hardware PCF: done** (`localAtlas.ts`). On `aaa`, spot and point lights' shadows are no longer rasterised on the CPU. The linear-light renderer draws them itself each frame into one 4096² `depth32float` atlas.
    - **Tiles by what they cover.** Each casting light is weighed by how much of the screen its range can cover from the camera: its range over its distance, against half the view's height.
      - It gets 1024² tiles from a coverage of 0.5, 512² from 0.15, and 256² below that: one for a spot, six faces for a point light.
      - The tiles come from a buddy allocator over the atlas, the largest lights first. A light that doesn't fit at its size tries the next smaller one.
      - Up to 64 tiles a frame, four times the old cap. A light left out casts no shadow.
    - **Drawing.** One pass draws the casters (solid, then cut-out through their material's discard) through each face, a viewport and scissor per tile, from the same caster batches as the sun's cascades.
      - Each face's GL-style projection is remapped to WebGPU's 0..1 depth for drawing.
    - **Testing.** The shader still reads distances, with the CPU tiles' `linear` terms and world-unit bias.
      - It turns the biased distance back into a depth, and filters a 3×3 grid of hardware comparisons, each bilinear, kept two texels inside the tile.
      - The comparison sampler is the cascades', so the fragment stage gains no sampler.
    - **The player.** On a GPU-presented AAA frame it skips the CPU tiles and hands over the frame's casters (the sun's, or the same set gathered without one).
      - A caller that gives the linear-light renderer only CPU tiles gets GPU tiles of what it draws.
      - The other tiers keep their CPU tiles.
    - *Still to come:* contact shadows from these lights (F2d-3, from F2c-2).
  - **F2d-2, cached tiles: done.** The atlas is kept from frame to frame, and a still lamp's map is drawn once.
    - **The same rects.** The lights that cover the most still pick the sizes, but the tiles are placed largest first and then by light. So the same sizes land on the same rects as the camera moves, whatever order the lights take on screen.
    - **When a tile is drawn again.** Only when:
      - its key changes: the light's position, direction, range or cone, its face or rect, or the still casters (`SceneDraw.localShadowKey`, the player's static shadow key and how much foliage is in reach);
      - or something that moves (`localShadowMoved`) reaches the light now, or did when the tile was last drawn, so its old shadow is taken away.
    - **How.** A tile drawn again has its rect cleared to the far plane by a quad writing depth 1, then takes this frame's casters; every other rect keeps its depths.
      - A ledger of which rect holds whose map forgets any rect a draw overlaps.
      - A caller with no still key gets every tile drawn every frame, as before.
    - *Tests:*
      - `local-shadows-gpu.test.ts`:
        - two lights that swap order on screen keep their rects;
        - the ledger redraws on a new key, a moved light, a mover now or last time, and an overlapping draw.
      - On Dawn, one renderer over five frames:
        - a box's shadow stays when the box is taken out under the same still key (the map wasn't drawn again; fails with every tile always drawn);
        - it goes with a new key, comes back with the box as a mover, and goes again the frame after the mover leaves.
      - `shadowCascade.test.ts`: the player hands over the still key, the same the next frame, and no movers.
  - **F2d-3, contact shadows from spot and point lights: done.** With it, F2d is complete (and F2c with it).
    - **The prepass's depths, bound as the scene shades.** On a frame with a prepass, the opaque pass now holds its depths read-only: the opaque pipeline writes none, as the prepass already did. It binds them in the group the see-through pass already used.
      - The frame uniform gains the view-projection as drawn (jittered under TAA) and the depth → distance terms.
    - **The march.** Each shadowed spot or point light's test (`localShadow`) ends with a march from the shaded point toward the light, 10 steps to 0.4 m (or half the distance to the light), jittered per pixel.
      - A step is in shadow when the depths hold a surface in front of it by no more than 0.2 m plus half its distance.
      - Opaque and cut-out surfaces only, as with the sun's.
    - *Tests:* `local-shadows-gpu.test.ts` (Dawn):
      - with the prepass, the floor at the foot of a box on the far side from a low point light drops below half its light, though the box isn't given to the tiles as a caster (fails with the march taken out);
      - past the march's reach, the floor stays lit;
      - the shadow, cache, contact and GTAO suites pass with the opaque pass's depths read-only.
    - *Tests:*
      - `local-shadows-gpu.test.ts`:
        - lights near, mid-way and far get 1024², 512² and 256² tiles, each pointing at its own first tile;
        - a point light's six faces run in a row, and no two tiles overlap or leave the atlas;
        - a crowd that wants more than fits shrinks some lights and leaves the rest out, within 64 tiles;
        - the allocator never hands a block out twice.
      - On Dawn: a spot light and a point light each shade the floor under a box the camera never draws to under 15% of its light, and leave the floor beside it as lit as without the box (both fail with the test returning lit).
      - `shadowCascade.test.ts`: the AAA player hands over its casters for a rig with a casting point light, and none without one.
- [x] **F2e. Physical lights.** (IES with F9d, GPU clustering with F0e, area-light shadows later.)
  - Inverse-square falloff, with a range window for culling only.
  - Area lights (rectangle, disk, tube) with **LTC** (linearly transformed cosines).
  - IES profiles, imported in F9d.
  - Light temperature in Kelvin, and lighting channels.
  - GPU clustered culling (from F0e) with thousands of lights.
  - Inverse-square falloff with its range window was done in F0b (`SceneLight.falloff: "inverseSquare"`).
  - **F2e-1, temperature and lighting channels: done**, on every renderer (the software rasteriser, WebGL2, and both WebGPU variants), in parity.
    - **Temperature.** `SceneLight.temperature` is in kelvin (`render/lightTemperature.ts`).
      - The chromaticity is the Planckian locus as Kim et al. fit it with cubics, 1667–25 000 K. It is taken to linear sRGB, divided by 6500 K's so 6500 K is white, and scaled to unit luminance. A temperature therefore changes a light's colour, not its brightness, as a photometric intensity requires.
      - The tint goes over the authored colour in linear light (decoded, tinted, re-encoded), so the linear-light shader gets exactly the tint and the byte-space ones a colour that reads the same.
      - The renderers read it through `lightColor`: `packLights` for the GPU loops, the software rasteriser's light list, and the probe relight's bounce lights.
      - When a cart sets the sun (`cartbox.sun3d`), its colour replaces the authored key's temperature.
    - **Lighting channels.** There are eight. `SceneLight.channels` and `MeshSceneInstance.lightChannels` are bit masks, both the first channel when absent. A light lights an instance when the masks share a bit. This applies to the sun, point and spot lights, but not the ambient or image-based light.
      - On the GPU, a light's mask rides above the inverse-square bit in `d3.w`, and a draw's mask in `motion0.y` (now also declared in the WebGL2 block).
      - `batchInstances` splits a primitive's copies by mask.
      - The software rasteriser filters the list per instance. An instance on none of the rig's channels gets one dark light, so it stays on the rig's path.
    - **Authoring.** The scene object carries `lightChannels`, through the sidecar (`setMeshLightChannels`) and the scene parse. The Lighting panel edits each light's temperature (Colour only / Kelvin, 1700–12 000 K) and its channels; the object panel edits "Lit on channels".
    - *Tests:* `physical-lights.test.ts` covers:
      - the locus against CIE illuminant A (2848 K under today's second radiation constant) and 6500 K;
      - unit luminance, and white at 6500 K;
      - the linear-light tint;
      - packing, batching and the save;
      - the software rasteriser's channels;
      - the bounce lights.
      - Both `webgpu-parity.test.ts` and `webgl-parity.test.ts` gain a scene with warm and cool lights on split channels, one mesh on two masks, against the software rasteriser.
  - **F2e-2, area lights: done.** `SceneLight.kind: "area"` is a rectangle, a disk or a tube (`shape`, `size` in metres, `tangent`), glowing with a luminance (it reads in nits).
    - **On the linear-light shader** it is shaded with linearly transformed cosines (Heitz, Dupuy, Hill and Neubelt 2016; `render/ltc.ts`).
      - The fitted GGX tables are Heitz's, as three.js ships them (MIT). They are stored as half floats (`ltcTables.ts`) and read bilinearly from a storage buffer at group 1 binding 10, as the fragment stage's 16 sampled textures are all bound.
      - The diffuse is the polygon's form factor times the albedo and the luminance, with no 1/π, as the renderer's diffuse carries none. When the polygon is wholly above the horizon the form factor is exact; otherwise it is Heitz's clipped sphere.
      - The specular is the lobe's integral, scaled by the fitted norm and Fresnel terms (Karis's split), times the multiple-scattering compensation (F1c). The lobe always takes the clipped sphere, as its tables were fitted to be read: read exactly, it comes out up to 23% off a brute-force integral.
      - The shapes:
        - a rectangle is its four corners;
        - a disk is an area-matched octagon;
        - a tube is the rectangle through its axis that faces the point, a cap's worth (πr/4) longer each end.
      - A rectangle and a disk light only the side they face; a tube lights all round.
    - **Everywhere else** an area light is the punctual light it is from far off (`areaAsPunctual`, `editor/render/areaLights.ts`). This covers the software rasteriser, WebGL2, the byte-space WebGPU shader and the probe relight.
      - A rectangle or disk becomes a spot of L·A/π, inverse square, with an 89° cone and no inner part. The cone's fade is within 0.1 of a Lambertian emitter's cosine.
      - A tube becomes a point of L × its side-on area / π.
      - Far off, the LTC diffuse is the same light, within 1%.
    - **The light record** grows to five vec4s (`LIGHT_FLOATS` 20): d4.xyz is the tangent, d2.yz the half size, d3.xyz the lit face's normal, and kinds 3, 4 and 5 are rectangle, disk and tube. Area lights cast no shadows yet.
    - **Authoring:** the Lighting panel adds an Area kind, with its shape (Panel, Disk, Tube), size, facing and tangent, and luminance in nits in physical units.
    - *Tests:* `area-lights.test.ts` covers:
      - the CPU mirror: a rectangle's diffuse against the closed form, both under it and off to one side, and a disk's against R²/(R² + h²); the lobe within 5% of a brute-force GGX integral, across roughness and view;
      - lighting from the faced side only, and a tube from any side;
      - the far-off equivalence with the punctual light;
      - packing and the save;
      - on Dawn, the shader within 2% of the mirror for each shape, dielectric and metal, and dark behind a rectangle.
      - A thin tube under a tight lobe is left out of the Dawn test: there the highlight moves 4.5% a centimetre, and f32 lands about 5% off f64.
      - The parity scenes on WebGPU and WebGL2 carry an area light, shaded as its punctual light, against the software rasteriser.
  - **Still to do:**
    - IES profiles wait on their importer (F9d).
    - GPU clustering is F0e's.
    - Area-light shadows.
- [ ] **F2f. Emissive surfaces that light.** Emissive meshes contribute through GI (F3d and F3e), so the energy trim on a Forerunner wall lights the floor in front of it.

### F3. Global illumination and reflections

- [ ] **F3a. HDR image-based lighting.**
  - True HDR environments from imported `.hdr`/`.exr` (F9d) or the F5a sky.
  - Kept as cubemaps, with a GGX-prefiltered mip chain built in compute, a **split-sum BRDF LUT** and L2 spherical-harmonic irradiance.
  - It replaces the 192×96 nearest-sampled equirect and its roughness-to-average lerp.
  - **F3a-1, the IBL on the GPU: done.** The linear-light shader (the `aaa` tier) lights from the environment as Karis's split-sum IBL (`render/ibl.ts`). The Modern tier keeps the panorama and lerp for its parity with the software rasteriser.
    - **The source** is the environment in linear light: its panorama, or its sky/horizon/ground gradient, decoded from authored colour and scaled by its intensity, as the shader's `envColorDir` reads it. It is uploaded as half floats with its own mips.
    - **The cube** (128², six levels) is built in compute. Each level is the GGX lobe of its roughness (level / 5), importance-sampled with 128 mip-filtered samples (Křivánek and Colbert).
      - The coarsest source level read keeps eight rows: an equirect's mips weight a polar texel as an equatorial one, and reading past that pulled the poles' light into wide lobes (8% at full roughness, now 2%).
      - The shader samples it trilinearly at `roughness × 5`, through its own sampler at group 1 binding 9. The cube takes over binding 7 in this variant, because the fragment stage's 16 sampled textures are all bound.
      - It is rebuilt only when the environment changes: its gradient and intensity, or the identity of its map. On Beaver Creek it is built once.
    - **The diffuse light** is L2 SH irradiance, projected on the CPU and convolved with the clamped cosine (Ramamoorthi and Hanrahan), carried in the frame uniform. Before, it was the radiance straight along the normal, not the irradiance over the hemisphere.
    - Reflection probes mixed in their nearest panoramas, blurred toward their average, until F3b-1 captured them on the GPU.
    - *Tests:* `ibl.test.ts` covers:
      - the gradient in linear light;
      - SH irradiance against a brute-force cosine integral (within L2's 5% of the brightest channel; exact for a constant sky).
      - On Dawn: each face's sharp level is the panorama where WebGPU samples it (face orientation); rough levels match a 20 000-sample CPU GGX integral within 4%; a rough white floor gets the sky's irradiance and a mirror the zenith.
      - The white furnace in `brdf.test.ts` still reads 1, now through the cube and SH.
      - In Chromium, Beaver Creek on the `aaa` tier builds its cube once, with no errors.
  - **F3a-2, true HDR environments: done.** An imported Radiance `.hdr` sky (I6) now reaches the IBL as its own linear radiance rather than the 8 bits it is exposed into for the backdrop.
    - `EnvironmentLight.hdr` holds it, resampled to the reflections' 192×96 in linear light (`resampleHdr`: the 8-bit resample's yaw and wrap, scaled by the panorama's exposure). The AAA tier's IBL lights from it in place of `map`; every other path keeps `map`.
    - **Held under 32** (`HDR_SKY_LIGHT_MAX`, a white sky being 1). The scene's directional light is its sun, so the panorama's own disc (often thousands) would light it a second time. Bright cloud and the sun's glow stay within that ceiling.
    - *Tests (`ibl.test.ts`):* the resample keeps its range, holds the disc under the ceiling and turns by its yaw like the 8-bit sky; the IBL prefers it over the map. On Dawn, a mirror under an HDR sky shows the zenith's radiance of 12 unclipped.
    - *Left for F3a:*
      - The sky's procedural objects, clouds and distant vistas are drawn into the 8-bit panorama only, so an HDR sky's IBL doesn't see them. A procedural sky (no import) still lights through its 8 bits until the F5a sky is built in linear light.
      - `.exr` import waits for F9d.
- [x] **F3b. HDR reflection probes.** (Compressed storage later; see below.)
  - Cubemap probes captured on the GPU, then prefiltered and stored compressed (BC6H, or RGBM where it is not available).
  - Box and sphere parallax correction, and blended influence volumes with priorities.
  - Re-capture on demand in the editor; at runtime, when time of day changes.
  - **F3b-1, GPU-captured HDR probes: done** on the `aaa` tier (`render/probeCapture.ts`). They replace the CPU-baked 8-bit panoramas there, read nearest and blurred toward their average. Every other tier keeps those, and the AAA tier no longer bakes them.
    - **Capture.** A second linear-light renderer (128², with no probes of its own) draws each probe's six faces from its capture point, linear and unclamped: the still scene, under the frame's lights, sun cascades and sky.
      - The faces go into a six-layer array with its mips (`MipmapGenerator` now takes array layers).
    - **Prefilter.** In compute, as the sky's cube is (F3a), each of the cube's six levels is written in WebGPU's cube layout.
      - The faces are read by direction, with the sky composited where nothing drew.
      - Each level is the GGX lobe of its roughness, importance-sampled with mip-filtered samples.
      - Every probe sits in one `rgba16float` cube array (128², 6 × 8 layers, about 8 MB), bound at group 0 binding 12 in this variant.
    - **Shading.** `envReflect` takes the probes in priority order: `priority` (new, −10 to 10 in the editor), then the smaller volume, which is the CPU bake's order too (`probeOrder`).
      - Each probe takes its influence's share of what the probes before it left. The sky's lobe takes the rest, so overlapping probes blend rather than one cutting off at another's edge.
      - A box probe is box-projected. A sphere probe (`shape: "sphere"`, `radius`, new) is projected onto its sphere and fades in from its edge; the other tiers take its bounds.
      - Each probe is sampled trilinearly at the roughness's level, as the sky is.
    - **Re-capture.** The player hands the renderer the probes, the still scene and a key (`SceneDraw.reflectionCapture`). The key covers the probes, the sky's map or gradient, the key light (direction to about half a degree, colour, intensity and temperature) and the static scene.
      - When the key changes (a time of day, a relit sky), the probes are captured again, one per frame, highest priority first.
      - A probe that hasn't moved keeps its cube bound meanwhile; a moved or new one is skipped until it is captured, so nothing pops.
    - **Authoring:** the Lighting panel's probes gain a Box or Sphere shape (with a radius) and a priority.
    - *Tests:* `hdr-probes.test.ts` covers the order and the packed records, and on Dawn:
      - a room of six coloured glowing walls captures each wall onto the cube face WebGPU reads for its direction, with the roughest level a blend of them;
      - a mirror in the room reflects the wall it faces, box- and sphere-projected, and the black sky when the probe is elsewhere;
      - a key change captures again a probe a frame, keeping the unmoved probe's cube throughout.
      - `shadowCascade.test.ts`: on the AAA tier the player hands over the probes and still scene, bakes no CPU panoramas, and holds its key while nothing changes.
    - **Still to do:**
      - BC6H storage needs a GPU encoder (the half-float array is 8 MB at most).
      - Re-capture on demand in the editor waits for the editor's own AAA viewport. At runtime the probes already follow the light.
- [ ] **F3c. GTAO with bent normals.** Ground-truth AO on the GPU from the depth prepass, at half resolution, temporally accumulated. Bent normals feed diffuse and specular occlusion. It replaces the unwired CPU SSAO.
  - **F3c-1, GTAO, its accumulation and bent normals: done** (`gtao.ts`). On every frame with a prepass, the linear-light renderer works out ambient occlusion on the GPU before it shades (`SceneDraw.ambientOcclusion: false` turns it off).
    - **Half resolution.** Each texel takes two screen directions, turned per pixel and per frame by interleaved gradient noise, and walks six steps each way out to 1.2 m.
      - It keeps the highest horizon either side. A sample past 0.6 of the radius fades out toward it, so a distant wall doesn't occlude.
      - The open arc, clamped to the hemisphere about the G-buffer's normal projected into the slice, is integrated in closed form (Jimenez et al. 2016).
      - The middle of each open arc, weighted by its width, gives the bent normal.
    - **Accumulation.** Each frame blends into a half-resolution history (an eighth of the new frame), reprojected through the velocity buffer. The history is clamped to the current frame's 3×3 range, so a moving object leaves no ghost.
    - **Up to full resolution.** The contact pass (F2c) now also resolves GTAO. It weights the four nearest half-resolution texels by bilinear weight times how near their depths are to the pixel's, so an edge never bleeds.
      - Its target grows to `rgba16float`: AO in r, the sun's contact in g, the bent normal (octahedron-encoded, world space) in ba.
    - **In the shader.**
      - The visibility joins the material's occlusion, with Jimenez's multi-bounce fit giving back a share by the albedo. So it reaches the diffuse fill and the split-sum specular occlusion alike.
      - The bent normal is where the sky's SH irradiance is read.
      - Opaque and cut-out surfaces only, as in F2c. The CPU SSAO path stands down while GTAO is on.
    - *Tests:*
      - `gtao.test.ts` (Dawn), ambient light alone on a dark floor (so the bounce gives little back), a metre-high box standing on it, seen from the side:
        - the floor a tenth of a metre from the box's face drops below 85% of open floor's light (fails with GTAO's visibility held at 1);
        - with GTAO off the two match within 3%, and open floor keeps at least 93% of its light;
        - the uniforms carry the radius, slices, frame and history flag.
      - The F2c and prepass suites (frame graph, HDR TAA, scene renderer, native resolution, parity) pass with GTAO on.
- [x] **F3d. GPU lightmapper.** (Re-baking the shipped maps waits on F11a; see below.)
  - A compute path tracer, sharing its BVH with F10b, that bakes HDR **directional lightmaps** (L1 SH or ambient-highlight-direction) with any number of bounces, emissive surfaces as lights and area lights.
  - A denoiser (an edge-avoiding à-trous filter, or a small learned one), with seam stitching and texel-density control.
  - Baked **probe volumes** with L2 SH and visibility (to stop leaks) light dynamic objects.
  - Minutes in the browser rather than CPU-bound bakes in node, with `bake:map` kept for CI.
  - **F3d-1, the GPU path tracer and HDR directional light maps: done** (`render/gpuLightmapper.ts`, `model/hdrLightmap.ts`). With WebGPU, the editor's Bake lighting runs on the GPU and gives each still object the AAA tier's HDR light map beside the 8-bit one every other tier reads. Without WebGPU, and in `bake:map`, the CPU bake runs as before.
    - **The scene** is the CPU bake's own triangle BVH (`buildBvh`, now carrying each triangle's emissive colour), flattened into storage buffers: two words per node, a corner and two edges per triangle, and its albedo and emission in linear light.
    - **The texels** are the CPU bake's (`lightmapTexels`, split out of `bakeLightmap`, whose output is byte-identical): each one's surface point and interpolated normal.
    - **The paths.** Each leaves its texel along a cosine-weighted direction (the first stratified over the bake and turned per texel) and bounces diffusely up to `bounces` times (0–8).
      - Open sky gives the sky's radiance, the IBL's own linear panorama (F3a).
      - A surface gives its emission, so emissive meshes light what sees them.
      - Each surface a path bounces off is lit by the rig's directional lights (up to four), a shadow ray each.
      - The texel's own sunlight is left out: the live cascades (F2a) draw it, as Unreal's stationary lights do.
      - Dispatches are bounded (64 Ki texels, 512 Ki paths a submit), so none nears a GPU's watchdog.
    - **What a texel keeps.**
      - Its irradiance over π in linear light, in the sky's SH irradiance's units.
      - The light's dominant direction (luminance-weighted and cosine-weighted, so ⅔ of the normal under a uniform sky).
      - The share of the sky's light that came through unblocked.
      - The 8-bit ambient scale, which is the irradiance over the open sky's, per channel, so the fantasy tiers' maps carry the bounce's tint as before.
      - The maps are blurred within each chart and grown past its edges, as the CPU bake's are.
    - **Storage.** `MeshMaterial.lightmapHdrImage` is one 8-bit PNG twice the atlas's height: Radiance RGBE irradiance over the direction (xyz · 0.5 + 0.5) and visibility.
      - It is decoded by our own PNG decoder (`decodePngRgba`, new), because a browser's premultiplied alpha would wreck the exponent.
      - It is stripped wherever the 8-bit map is (a topology edit, a re-layout, a material instance's parent, a clear), and a CPU rebake drops it.
      - It is never re-encoded as KTX2.
    - **Shading (AAA tier).** Binding 11 becomes a texture array in the linear variant: the HDR map's two rgba16float layers, or the 8-bit map as one layer (`ssaoMeta.z` = 2 or 1).
      - With an HDR map, the diffuse fill is its irradiance in place of the sky's SH irradiance, rebalanced for the shading normal by a half-Lambert about the dominant direction. This is exact at the baked normal, so a normal map still reads under baked light (`directionalIrradiance` mirrors it).
      - The sky visibility joins the specular occlusion of the environment's reflection. GTAO stays on top for near-field contact.
      - Without one, the 8-bit map scales the fill as before. The byte variant and the other renderers never read the HDR map.
    - **In the editor.** Up to eight bounces on the GPU (three on the CPU), four paths for each of the CPU's rays, and "Baking on the GPU…" while it runs.
    - *Tests (`gpu-lightmapper.test.ts`):*
      - RGBE and the stored PNG round-trip, and `decodePngRgba` keeps alpha exactly.
      - The directional rebalance is exact at the baked normal, brighter toward the light and flat without one.
      - The BVH flattens with its leaves and linear materials.
      - On Dawn:
        - open floor under a uniform sky reads the sky's radiance, all of the sky and the ⅔ direction;
        - the floor at a tall black wall's foot gets half the sky (0.47–0.53), from the open side;
        - a dark box's floor is lit by its glowing ceiling at the analytic view factor (±5%);
        - a sunlit red wall bleeds red onto the floor with one bounce and not with none;
        - three bounces in a white pit give more than 1.5× no bounce;
        - a bake is deterministic.
      - In the renderer, the HDR map's irradiance replaces the sky's linearly and in its colour, its visibility occludes the reflection, an 8-bit map still scales the fill on the AAA tier, and the byte path ignores the HDR map.
      - The editor's scene bake on the GPU gives every still object both maps, and a CPU rebake or a clear takes the HDR one away.
      - `lightmap.test.ts` and the map bakes pass unchanged.
  - **F3d-2, finishing the bake: done.** The GPU bake's maps are now finished, in order, by dropping texels inside geometry, denoising on the GPU, growing past chart edges, and stitching seams (`gpuLightmapper.ts`, `lightmap.ts`). It replaces F3d-1's two 3×3 blurs. The CPU bake is unchanged.
    - **Texels inside geometry.**
      - The BVH now carries the side each triangle faces by its authored normals (`Bvh.front`, the mean of its corners' normals, else its winding's).
      - The tracer counts a texel's first rays that meet the back of a surface. Past 60% of them (`backfaceLimit`), the texel lies inside something, such as a floor texel under a box's foot, and is dropped.
      - It is filled from its valid neighbours by the dilation, so the floor beside the box neither darkens nor lets the box's dark inside out. Under a 1 m box at 8 texels a metre, all 64 texels under it are dropped, and the texel just inside its edge reads 0.99 of the one just outside, against 0 when kept.
      - A floor behind a one-sided wall loses nothing: at most half its rays meet the wall's back.
    - **The denoiser** is an edge-avoiding à-trous wavelet (Dammertz et al. 2010) in compute: four passes 1, 2, 4 and 8 texels apart, with a B3-spline kernel.
      - A neighbour is weighed by how near its normal is (to the 32nd power) and how near it lies to this texel's plane, so a corner doesn't blur across.
      - A neighbour farther in the world than its atlas step allows is skipped: another chart that merely sits beside this one in the atlas.
      - A neighbour is also weighed by how near its luminance is, against 1.5 standard deviations of this texel's mean. The tracer now sums each path's squared luminance for that variance, prefiltered over the texel's 3×3 as in SVGF, and the variance is filtered through the passes too. A well-converged texel is therefore left nearly as it is.
      - **Measured** on a sunlit red wall's two-bounce light on the floor: at 8 paths a texel, the error against a 1024-path bake fell to 0.45 of the raw bake's, and at 32 paths to 0.53.
      - A wider luminance stop blurred more real gradient than it removed noise (4σ over five passes left 0.74 of the error). The cost is a little bias on smooth peaks: the glowing ceiling's view factor at the floor's centre now reads 0.97 of the analytic one, against 0.995 raw.
    - **Seams.** `lightmapSeams` finds every edge two triangles share in the world that sits in two places in the atlas: two charts' borders, or a curved patch's triangles, each its own chart. It samples each seam about every half texel along its longer side, as four bilinear taps either side.
      - `stitchLightmapSeams` solves least squares by conjugate gradients, for every channel: the lookups either side agree, and each texel stays near its value (stiffness 0.01).
      - A hinge between a black floor and a white wall closes from a step of over 0.9 to under 0.1. Texels no seam touches keep their values exactly.
    - **Texel density per object.** `MeshSidecarEntry.lightmapScale` (¼ to 4×, powers of two, stored only when not 1) multiplies the bake's Detail for that object. The object's lighting panel gains a "Light map detail" slider, so a piece seen up close takes more texels and a far wall fewer.
    - *Tests (`lightmap-finish.test.ts`):*
      - Seams are found on a hinge and not on a flat quad, and stitching closes them while leaving untouched texels alone.
      - The density snaps, survives a save, stores nothing at 1 and scales the baked atlas.
      - On Dawn:
        - the box's foot (about 64 texels dropped, the edge kept bright, and dark without the limit);
        - the one-sided wall (none dropped);
        - the red wall's bounce denoised to under 0.6 of the noisy error;
        - a synthetic floor beside a wall in the atlas and the world: noise halved, mean kept, nothing crossing the corner, unbaked texels left alone.
      - F3d-1's suite passes with the finish on.
  - **F3d-3, baked probe volumes: done** (`model/probeVolume.ts`, `bakeProbeVolumeGpu`). With WebGPU, the editor's bake makes its light probes a probe volume, which the AAA tier lights everything without a light map by: characters, physics bodies, what moves. The other tiers get their ambient cubes derived from the same bake. Without WebGPU, the CPU's ambient cubes are baked as before.
    - **The bake.** Each probe casts rays over the whole sphere: a Fibonacci set over the bake, turned per probe about the vertical. They run through the same paths as a light map's texels (the tracer's path is now one function, `pathFrom`, shared by both kernels).
      - The radiance is projected onto L2 SH, convolved with the clamped cosine and over π, as the sky's is (F3a). Unlike a texel's, a probe's light includes the sun on the surfaces it sees: those are what light a mover beside them.
      - It also keeps the share of the sky's light that reached it.
      - A probe is dropped as invalid when over 60% of its rays meet the backs of surfaces.
      - Like DDGI (Majercik et al. 2019), it keeps the mean distance each 8 × 8 octahedral texel's rays travelled, and the mean of its square, capped at 1.5 times the spacing.
      - The grid is planned at most 49 probes a side (`planProbeVolume`), so the volume texture stays within a 3D texture's width, and 4096 probes in all.
    - **Storage.** `SceneLighting.probeVolume` stores half floats per probe: 27 SH values, visibility, validity and 128 depth moments. The scene's environment decodes it once per stored object.
    - **Shading (AAA tier).** The volume rides in the probe grid's own 3D texture (group 1 binding 6), 41 texels a probe along x. `probeMin.w` = 2 marks it, so no binding is added; the fragment stage's storage buffers are all taken.
      - A surface without a light map blends the eight probes round it, pushed out along its normal by 0.3 of the spacing.
      - Each probe is weighed trilinearly, by a wrapped cosine toward it (DDGI's (½(1 + cos))² + 0.2), and by Chebyshev's bound on that probe seeing the point, cubed. A bright room's probes therefore don't light a point behind the wall they see.
      - The result replaces the sky's SH irradiance in the diffuse, and its sky visibility joins the reflection's specular occlusion, as an HDR light map's do (F3d-1).
      - With no valid probe seeing the point, the sky lights it.
      - `sampleProbeVolume` is the CPU mirror, and the shader matches it.
    - **The other tiers' ambient cubes** (`ambientCubesFromVolume`): each face is the probe's irradiance along it over the open sky's (the rig's sky SH), per channel, as a light map's ambient scale is. An invalid probe takes its valid neighbours' mean. The byte variant and the other renderers read only them.
    - **In the editor.** Sixteen rays a probe for each of the CPU's rays, the same bounces as the light maps. A CPU rebake drops a stale volume, and Clear takes it with the cubes.
    - *Tests (`probe-volume.test.ts`):*
      - The plan's axis cap; the octahedral map covers every texel, and its inverse round-trips.
      - Storage round-trips as halves, and a malformed volume is refused.
      - The sampling is trilinear between probes that see the point. A wall the bright probes see 1 m off keeps their light from a point behind it (0.3 or more open, under 0.05 walled). Invalid probes are skipped, and null comes back with none.
      - The ambient cubes are ratios over the sky, and an invalid probe is filled from its neighbours.
      - On Dawn:
        - an empty uniform sky gives its radiance every way, all of the sky, and depths at the cap;
        - a metre above a wide grey floor, the sky is above (±7%), the floor's bounce below at its linear albedo (±15%), half the sky is visible, and the floor reads a metre down;
        - a probe inside a closed box is dropped;
        - the renderer lights a floor without a light map as the mirror says, within the reflection's few %, and keeps the light behind the wall, while the byte path is unchanged;
        - the editor's GPU bake stores the volume and the cubes, the environment hands the volume over, and a CPU rebake or a clear takes it away.
  - **F3d-4, what the renderer lights by: done** (`gpuLightmapper.ts`, `model/bakeSurface.ts`, `sceneSkyEnvironment`). The GPU bake now takes every light of the rig, each surface's textured albedo and metalness, and the sky the player draws. Light maps and the probe volume take them alike, through the shared `pathFrom`. The CPU bake is unchanged.
    - **Local lights' bounce.** The lights move from the uniform to a storage buffer (group 0 binding 7, five vec4s a light): up to four directional, then up to 256 point, spot and area lights (`packBakeLights`, `bakeLights`).
      - At each surface a path bounces off, every directional light is traced as before. One local light is picked by what it would give there unshadowed, with a tenth of the choice spread evenly so that no light is ever unpickable. Its light over the chance of picking it comes through one shadow ray.
      - With many lights that is one ray where each light's would be many, and the estimate stays unbiased: one bright, seven dim and one out-of-reach light give the single light's 0.4 ρI within 5%.
      - A point or spot light falls off as `distanceFalloff` does (inverse square windowed to its range, or (1 − d/range)²), and a spot narrows by the shader's smoothstep cone.
      - An area light (F2e-2) is sampled at one point on its rectangle or disk, or on the rectangle a tube shows the point, as the LTC shader takes it. That point gives luminance × both cosines × area / π d², the renderer's diffuse units, from its lit face only.
      - A light lights only what shares one of its lighting channels (F2e). The triangle's channels ride in its albedo's w, from `Occluder.lightChannels`.
      - As with the sun, the texel's own direct light from them is left out, because the live lights draw it.
    - **Metalness.** A surface bounces albedo × (1 − metalness), as the renderer's diffuse does. It adds a metal's own colour as far as the metal is rough: a rough metal's reflection is spread the way a diffuser's is, while a mirror's goes one way and is the reflection probes' (F3b) to carry.
      - The metalness and roughness are the renderer's own (`resolvePbr`). A material that isn't shaded as PBR has none.
    - **Textured albedo.** `Occluder.surfaces` carries each primitive's decoded base-colour and metal/roughness maps (`bakeSurfaces`). `buildBvh` reads each triangle's albedo from its map, in place of the factor × 0.55.
      - The read is the map's mean over the triangle's UV footprint: the mip level whose texel is about the footprint's size, read trilinearly at the centroid with wrap (`footprintMean`), in linear light for a base-colour map and as data for a metal/roughness map.
      - A triangle that tiles the map reads its mean; a sliver of a trim sheet reads its strip.
      - The editor decodes PNGs with our own decoder and anything else with the browser's (KTX2 through the transcoder). A map neither can read keeps the old factor.
    - **The sky the player draws.** `sceneSkyEnvironment` gives the environment the surface lights by: the rig's gradient, or its procedural or imported sky baked with its objects, clouds and vistas (I6, I7), carrying an HDR sky's own light (F3a-2).
      - The surface's two sky bakes now share `litBySky` with it. The light maps, the probe volume and the other tiers' ambient cubes all take this sky in place of the gradient.
    - *Tests (`bake-lights.test.ts`):*
      - A map's footprint mean: its whole mean, a sliver's strip, a tiled triangle's mean, and sRGB decoded only for colour.
      - `buildBvh` per triangle under a map: its albedo, metalness and channels. Without one, the plain BVH is unchanged (× 0.55, no metal).
      - The bounce share at each metalness and roughness, and the channels in the packed material.
      - `bakeSurfaces` resolves as the renderer does and asks for the metal/roughness map as data.
      - The packed light records, and a rig's lights in linear light with their temperature.
      - On Dawn, a black floor under a wide grey ceiling (ρ = 0.5) 1 m up, lit by a light just above the floor, so only the ceiling's bounce reaches the floor. Each case is checked against the closed-form integral 2ρ ∫ r · E(d) / d⁴ dr:
        - an inverse-square point light gives 0.4 ρI, and a ranged one its (1 − d/range)² integral, each within 4%;
        - a spot light gives its cone's integral within 5%, and none when it points away;
        - a 10 cm rectangle and a disk of the same area give ρLA / 3π within 5%, and the rectangle none when it faces away;
        - a light on another channel gives none, and the same light on a shared channel gives the full bounce;
        - nine lights picked among give the sum without bias;
        - a mirror metal gives none, and a half-rough metal half the dielectric's bounce;
        - a white-factored ceiling with a red map bleeds red, where without its decoded map it bled the factor × 0.55's grey.
      - The editor's scene bake under an orange procedural sky over a blue gradient: the floor reads the drawn sky's cosine integral within 5% in every channel.
      - The F3d-1 to F3d-3 suites pass unchanged.
    - *Left for F3d:*
      - Re-baking Lockout and Beaver Creek with HDR maps, which waits on F11a's physical re-light.
      - The CPU bake could take the seam stitching, the local lights and the maps too. It is left byte-identical for now, so `bake:map`'s stored maps don't move.
      - Emissive maps (the bake takes the emissive factor) and a smooth surface's specular bounce (caustics) are not baked.
- [ ] **F3e. Real-time GI.**
  - **DDGI**: a probe grid whose irradiance and visibility are updated every frame by software ray tracing in compute, against a scene BVH or a global signed distance field.
  - **SSGI** for near-field detail on top.
  - Together they give moving lights, time of day and destructible scenery correct bounce light without a bake: the Lumen-class result, built from techniques WebGPU can run.
- [ ] **F3f. Reflections.**
  - Hierarchical-Z SSR with GGX importance sampling and a temporal denoiser.
  - Rough reflections that blend into F3b probes.
  - On Epic, ray-traced reflections from a low-resolution software BVH trace for off-screen objects.

### F4. Image quality and the camera

- [x] **F4a. HDR TAA with motion vectors.** TAA in linear HDR before tone mapping, reprojecting with the F0c velocity buffer, and rejecting history with variance clipping in YCoCg. It adds reactive and transparency masks, so particles and water don't ghost.
  - **Done.** On the `aaa` tier (linear HDR, with the prepass), the I2 resolve becomes `hdrTemporalShaderWgsl` (`render/temporal.ts`). The Modern tier keeps I2's.
    - **Reprojects with the velocity buffer.** Each pixel takes the velocity of the nearest surface in its 3×3, so an edge moves with what is in front of it. Nothing drawn (the sky behind) still reprojects by depth and the two cameras.
    - **Reads the history Catmull-Rom**, five bilinear taps, so it doesn't soften a little more each frame.
    - **Clips the history to the neighbourhood's variance box in YCoCg** (Salvi, γ = 1), toward the box's centre. The box is grown to hold the pixel's own colour: without that, a lone highlight of 40 on a wall of 0.5 was clipped to 1.8.
    - **Works on Karis's reversible tone map** of the colour, so one HDR sparkle neither dominates the average nor flickers.
    - **The reactive mask** is made as FSR 2 makes its own. The opaque scene is copied before the see-through draws, and a pass after them (before the reflections land) measures how much they changed each pixel, tone-mapped. The resolve takes that much more of the new frame, so particles and water, whose motion the velocity buffer doesn't hold, don't drag the surface behind them along.
      - To do so, a frame with see-through draws now draws them in their own pass on this tier (as soft edges and refraction already did).
    - *Tests (`hdr-taa.test.ts`).* On Dawn, on synthetic frames:
      - the history comes from where the velocity says;
      - a stale history outside the box is clipped into it;
      - a highlight of 40 keeps its value;
      - a reactive pixel takes the new frame where plain TAA keeps mostly history;
      - the mask marks what the see-through pass changed and nothing else.
      - Through the renderer: a still HDR scene converges to itself within 2%; a moving square leaves no trail; a see-through pane whose glow changes every frame shows the current frame's.
      - In Chromium, Beaver Creek on `aaa` runs the HDR resolve and its reactive mask with no errors.
- [ ] **F4b. Temporal upscaling.** An FSR 2-class upscaler built on F4a. It renders at 50–77% scale, reconstructs at native resolution and pairs with dynamic resolution (F0d). It is how integrated GPUs and phones reach the tier.
- [ ] **F4c. Physical camera.**
  - Aperture, shutter speed and ISO drive both exposure and effects:
    - **bokeh depth of field** (gather-based, with near/far fields and a shaped aperture);
    - **per-object motion blur** (McGuire-style tile max on velocity);
    - histogram **auto-exposure** on the GPU, with metering modes and exposure compensation, replacing the CPU 8-bit luminance read.
  - Post volumes (P6) blend all of it.
- [x] **F4d. Tone mapping and output.**
  - Tone mappers: AgX, ACES 1.3 RRT/ODT and Khronos PBR Neutral, selectable per scene.
  - Grading in log or ACEScct space, and LUTs applied in the right space.
  - **HDR display output** where the browser supports it (WebGPU canvas `toneMapping: "extended"`).
  - Bloom from the HDR buffer (an energy-conserving mip-chain bloom, with lens dirt), replacing the threshold on the clipped LDR read-back.
  - **F4d-1, tone mappers and HDR bloom: done.**
    - **The curve is the scene's** (`SceneLighting.tonemapper`, `ToneMap.operator`, the Lighting tab). The AAA tier's presenter maps its linear frame through it (`render/toneMappers.ts`, WGSL and TypeScript term for term):
      - **filmic**, Narkowicz's per-channel ACES fit: every tier's since F0b, still the default, so no scene changes;
      - **ACES**, Hill's fit of the RRT and ODT through AP1;
      - **AgX**, Wrensch's fit, so a saturated light goes to white without the hue skew;
      - **Neutral**, Khronos PBR Neutral, which leaves colours under 0.76 as authored.
      - Every other tier keeps filmic. Auto-exposure and post-volume exposure keep the choice.
    - **Bloom from the HDR frame** (`render/hdrBloom.ts`). With the post stack's bloom on, a linear frame is composited in light into a half-float target before its tone map and blurred down a mip chain and back up (Jimenez):
      - 13-tap downsamples, the first with Karis's average so a lone sparkle can't flicker the glow; 3×3 tents added back up; three to six levels by the bloom's radius.
      - Nothing is thresholded. The glow, over the levels it summed, is mixed in by the strength (a sixth per unit), so light is moved into it rather than added: a light of 60 glows and one of 1.2 hardly does.
      - The post stack's own thresholded bloom stands down on that path.
    - *Tests (`tone-mappers.test.ts`):*
      - filmic matches the existing curve exactly; every curve maps any light into 0..1, rising with it;
      - Neutral keeps a base colour under its knee; AgX and ACES take a saturated red toward white where filmic keeps it red;
      - the choice survives storage and reaches the tone map.
      - On Dawn: the presenter's output through each curve matches the TypeScript within 2/255; a light of 60 glows eight texels out where one of 1.2 barely does; the chain over its levels keeps the frame's mean light (within 1%).
      - In Chromium, Beaver Creek on `aaa` blooms from the HDR frame, with no errors.
    - *Left for F4d:* lens dirt; grading and LUTs in log space; HDR display output (F4d-2).
  - **F4d-2, grading, HDR output and lens dirt: done.**
    - **The grade runs before the tone map** (`render/grading.ts`, WGSL and TypeScript term for term). On a linear frame the post stack's brightness, contrast and saturation move into the presenter, and the post stack's own 8-bit grade stands down:
      - brightness is an exposure gain;
      - saturation works about the Rec.709 luma, in linear light;
      - contrast works in ACEScct about 18% grey, so it scales stops (at 1.5, two stops over grey become three) instead of pivoting on display 0.5 and clipping highlights.
      - A LUT stays where it is authored, on the display image after the tone map.
    - **HDR display output.** Where the display reports `(dynamic-range: high)` and the canvas accepts `rgba16float` with `toneMapping: { mode: "extended" }` (read back from `getConfiguration()`, else unconfigured), the curve rolls off to 3× SDR white instead of 1. It is exposed so 18% grey shows where SDR shows it: the picture is the same, and its highlights go further.
      - *Until F4e:* only frames without a post stack reached the display extended, because the post stack clamped to 0..1. F4e-1 lifts that.
    - **Lens dirt** (the bloom's *Lens dirt* slider): soft procedural smudges, on two grid scales, that the HDR bloom lights. It adds only where there is glow.
    - *Tests (`grading.test.ts`):*
      - ACEScct round-trips; the grade is neutral at 1, 1, 1; contrast scales stops about grey; saturation 0 gives the luma.
      - Every curve's extended output keeps grey and takes a highlight past 1.5, up to the headroom.
      - On Dawn: the presenter's graded output matches the TypeScript within 2.5/255; an extended `rgba16float` target holds values over 1.1 where SDR clips, with grey matching SDR; lens dirt only brightens the glow.
      - In Chromium, Beaver Creek on `aaa` compiles the grade and dirt with no errors; with an HDR display reported, the canvas keeps `rgba16float` with extended tone mapping.
- [x] **F4e. Post on the GPU frame graph.** (Partly ahead of time: F0a ported the stack to WGSL for GPU-presented frames; what remains is running it on the HDR frame graph of F0b/F0c.) The WebGL1 single-pass post stack (`PostFxPass.ts`) becomes frame-graph passes at full precision. Every existing effect (CRT, dither, grain, aberration, flare and the rest) is kept, so the fantasy-tier looks still work on `aaa`.
  - **F4e-1, the presenter on the frame graph, at full precision: done.**
    - **Its frame is a graph** (`GpuPresenter.present`): sky, shaft mask, shafts, linear composite, bloom, tone map (or one compose), post and measure are passes over the graph's transients. They are pooled from frame to frame, so a steady frame makes no new targets, and the presenter no longer keeps targets of its own.
      - Each pass is timed when the device has `timestamp-query`. The profiler lists them after the scene's, as `present: …`, and adds them to the GPU frame time.
      - A graph pass that encodes several (the bloom chains) spans its timestamps over them (`timingSpan`).
      - A bloom too small for a frame no longer leaves the linear composite un-tone-mapped: the chain's shape is known before the frame is built.
    - **The post stack reads the composite at full precision.** On a linear frame the composite it reads is half-float, not 8-bit, so the frame is rounded once, at the end, not before every effect too.
    - **An HDR display through the post stack.** The stack knows the brightest its target shows (`HDR_PEAK`, the headroom sRGB-encoded) and clamps there instead of at 1. A LUT grades the displayable range and a highlight past it rides along. So frames with a post stack now reach the display extended too (F4d-2's limit, lifted).
    - Every effect is the same one, in the same order, so the fantasy-tier looks are unchanged on `aaa`. The WebGPU post parity suites pass as they were.
    - *Tests (`post-in-graph.test.ts`):*
      - the timing split, and the stack's range (white for SDR, the headroom on an HDR display);
      - on Dawn: a vignetted fine ramp lands within 0.7 of a step of the TypeScript (through an 8-bit composite it was 0.97 out); a light of 40 stays past SDR white through the post stack on an extended target, never past the headroom; the passes are named and timed, and a steady frame makes no new targets.
      - In Chromium, Beaver Creek on `aaa` (whose post stack is on) presents with no GPU or compile errors; with an HDR display reported, the canvas keeps `rgba16float` with extended tone mapping and the post stack runs on it.
    - *Left for F4e-2:* the lens effects in linear light, before the tone map.
  - **F4e-2, the lens effects in light: done.** On a linear frame with a post stack, a lens pass (`render/lensFx.ts`) runs between the linear composite and the tone map. It runs the display stack's own WGSL for these effects, word for word and in its order, and the display stack's copies stand down (`splitLens`):
    - **Sampling in light:** aberration, tilt-shift and the wet-floor reflection sample the linear frame. A defocused highlight stays bright (its light is blurred, not its clipped value). An image without highlights comes out as it did: under a per-channel curve the aberration commutes with it.
    - **God rays and streaks gather the same pixels, and a clipped light as bright as it is.** The bright pass picks a pixel by how bright it shows (graded and through the scene's curve), against the same threshold. It gathers what the pixel showed until that nears white (`CLIP_KNEE`, 0.9); past that, what an HDR display shows. So a light of 40 streaks harder than one of 2, where both had clipped to white, up to the 3× headroom.
      - They were authored as light added over the display image, so they gather in display units into a glare target, and the tone map adds it after its curve. Added as light before the curve, a light of 2's streak showed about seven times brighter; gathered as an HDR display shows every light (no knee), one under white still streaked a fifth brighter.
    - **The screen's own shape stays in display space.** With the kaleidoscope or the CRT curvature on, the scanlines, dither and the rest follow the folded or bent screen, so every effect stays in the display stack, as it was.
    - Flare and vignette stay after the tone map. The flare is procedural (drawn from the sun's measured visibility, not gathered from the frame), and the vignette was authored as a darkening of the display image.
    - *Tests (`lens-fx.test.ts`):*
      - the split (the five effects move, curvature or the kaleidoscope keeps them) and the bright pass's block;
      - on Dawn: an aberrated colour ramp matches the TypeScript within 2/255; a light of 40 streaks past what it clipped to (1.3×) and harder than one of 2, where on the display image they streaked alike, and a light under white streaks within 1/255 of before; a light that shows under the threshold gathers nothing; a defocused light of 40 stays bright where its clipped value spread dim, with the band in focus unchanged; the graph runs linear composite, bloom, lens, tone map, post.
      - In Chromium, Beaver Creek on `aaa` (SDR, and with an HDR display reported) presents with no GPU or compile errors. No shipped map turns on these effects, so the lens pass itself is exercised on Dawn (Chromium's WebGPU implementation).

### F5. Atmosphere, weather and water

- [ ] **F5a. Physically based sky.**
  - Hillaire's 2020 atmosphere: transmittance, multiple-scattering, sky-view and aerial-perspective LUTs.
  - Rayleigh, Mie and ozone parameters, a planet radius, and a sun and moon in physical units.
  - Time of day drives the sun, sky, IBL (F3a) and fog together.
  - The stylised dome and rings stay as a "painted sky" option.
  - **F5a-1, Hillaire's atmosphere and its sky: done** (`model/atmosphere.ts`, `render/atmosphere.ts`). A sky dome gains a Physical mode (`ProceduralSky.atmosphere`) beside Gradient and Mountains. The AAA tier draws it per pixel in physical units; every tier is lit by it.
    - **The medium** is Earth's by default (Hillaire 2020, in km):
      - Rayleigh scattering (5.802, 13.558, 33.1)·10⁻³ with an 8 km scale height;
      - Mie scattering 3.996·10⁻³ and absorption 4.4·10⁻³ with 1.2 km, Cornette–Shanks's phase at g = 0.8;
      - ozone absorption (0.65, 1.881, 0.085)·10⁻³ in a tent 30 km wide about 25 km up;
      - a 6360 km planet with 100 km of air and a ground albedo of 0.3.
      - A creator scales the air, haze and ozone against Earth's, and sets the Mie anisotropy, the ground's albedo, the altitude, the planet's radius and the sun's size. The settings are stored sparsely and read defensively (`parseAtmosphere`).
    - **The sun is the key light above the air.** Its linear colour × intensity is the sun's radiance in the renderer's units, so 1 is about 123.5 klx (F0b-2). The scattering takes π times that, because the renderer's diffuse carries no 1/π.
      - `atmosphereLighting` tints the key light by the transmittance toward it, folding in its temperature: 0.94, 0.86, 0.76 at noon, orange near the horizon, and black once the sun has set.
      - It aims the sky's own sun along the key light, so the shafts and the lens flare follow it. The player's frame lighting and the light bake both take it.
    - **The CPU reference** builds the LUTs once per medium, in about 0.8 s:
      - the transmittance LUT (256 × 64, Bruneton's mapping, 128 steps a ray);
      - the multiple-scattering LUT (32 × 32: Ψ_ms over the sun's zenith cosine and the height, 64 Fibonacci directions of 20 steps, L₂ / (1 − f_ms));
      - and `skyRadiance` from them: single scattering under both phases, the multiple scattering, and the lit ground, in 32 quadratically spaced steps with Hillaire's energy-conserving integration.
    - **On the GPU** (`GpuAtmosphere`) the same three passes run in compute, line for line: the transmittance and multiple-scattering LUTs once per medium, and the sky view (192 × 108, Hillaire's mapping: finer toward the sun and the horizon) whenever the sun moves.
    - **The AAA backdrop.** On a linear frame, the presenter's sky pass reads the sky view per pixel and adds the sun's disc: its illuminance over its solid angle through the air, held under 30 000. The frame tone-maps it with the scene. A byte-space frame draws the painted copy as before.
    - **Every tier's light** comes through the imported-sky path (I6). The atmosphere renders an HDR panorama (256 × 128) under the key light:
      - exposed into the 8-bit copy at the rig's exposure, the other tiers' backdrop and reflections;
      - resampled as the AAA tier's IBL light (F3a-2);
      - and, through `sceneSkyEnvironment`, the light bake's sky (F3d-4).
    - **Authoring.** The Lighting panel's Sky dome gains Physical, with Air, Haze, Ozone, Sun glow, Ground albedo, Altitude and Sun size. The painted controls hide, and the painted sky's settings are kept for switching back.
    - *Tests (`atmosphere.test.ts`):*
      - Settings parse, resolve to Earth and survive a save.
      - The transmittance LUT maps both ways, and the zenith's optical depth matches its closed form within 0.1%.
      - Both phases integrate to 1 over the sphere.
      - The sky is blue overhead at noon, red toward a setting sun and under 2% of noon once the sun has set. The noon horizon is brighter than the zenith.
      - A high sun's clear-sky diffuse light is 6–25% of the direct beam, and haze whitens the horizon.
      - The key light is tinted (orange at 3°) with the other lights left alone, and the disc's radiance × its solid angle is π × the transmitted sun.
      - The sky view maps both ways, with the horizon at its middle row.
      - On Dawn:
        - the GPU's transmittance, multiple-scattering and sky-view LUTs match the CPU's texel by texel within 0.5%, 1% and 2%, and are not rebuilt for an unchanged sun;
        - the presenter's backdrop is the CPU's sky radiance per pixel within 4/255, with the disc past white where the sun is;
        - the GPU bake lights an open floor by the atmosphere's sky within 5%, blue where the gradient was not.
      - The scene's environment carries the atmosphere's HDR light, and its 8-bit copy is blue overhead.
      - The player hands the presenter the atmosphere, its sun above the air and the disc, and lights the renderer by the tinted key light and the atmosphere's light.
  - **F5a-2, aerial perspective and the time of day: done** (`aerialColumn` and `bakeAerialPerspective` in `model/atmosphere.ts`; `AERIAL_WGSL` and `GpuAtmosphere.aerial` in `render/atmosphere.ts`). On the AAA tier, every surface stands behind the air between it and the eye, and a sun that moves re-lights the sky's light.
    - **The volume** is Hillaire's froxel LUT over the camera's frustum:
      - 16 × 16 columns across the screen, each a view ray through its centre;
      - 32 slices along each, spaced quadratically out to 32 km, so the first slice's centre is 8 m out and half the slices fall inside 8 km;
      - each froxel holds the light the air scatters toward the eye up to it, and the mean transmittance to it.
      - A column is integrated slice after slice (4 steps a slice) with the sky's own energy-conserving step, over the transmittance and multiple-scattering LUTs. It is rebuilt in compute for every camera that draws, one thread a column, so the probes' cube faces get their own.
      - The ray passes under the planet's ground as air at its foot, since the scene's ground is the scene's. Looking down from a ridge still hazes the valley.
    - **Why a uniform buffer.** The AAA scene shader already binds the 16 sampled textures and 8 storage buffers a stage gets on every device. So the volume is kept as half floats in one 64 KB uniform buffer (two froxels a `vec4<u32>`), and filtered trilinearly by hand.
    - **In the shader**, after the fog, each fragment finds its froxel from its world position through the camera's axes and focal terms, and its slice from its distance.
      - The colour becomes colour × T + L, with L taken by coverage, since it is premultiplied after.
      - An additive surface is only dimmed.
      - Nearer than the first slice's centre, the air fades toward none.
    - **Scale.** At ×1 a metre is a metre, so only kilometres haze over. The Lighting panel's **Aerial distance** (0–50, stored as `aerialScale`, 0 to 100) lays the haze of a large landscape over a small map. 0 turns it off.
    - **Time of day.** When the key light above the air turns past about half a degree, or brightens or reddens a step (`physicalSunKey`, a cart's `cartbox.sun3d` included), the player re-renders the atmosphere's light for where the sun now is:
      - 96 × 48, a row a frame (about 1.5 ms of CPU), so a sunset re-lights in under a second;
      - then it is upsampled to the IBL's 192 × 96 and swapped in whole, never half done.
      - The AAA tier rebuilds its prefiltered IBL and SH from it. Its reflection probes re-capture, as their key follows the environment.
      - The other tiers' 8-bit reflections copy is made from it.
    - *Tests (`aerial-perspective.test.ts`):*
      - The setting parses in range, defaults to Earth's ×1 and survives a save. The slices map both ways, and a froxel column points along its camera ray.
      - A short level stretch passes light as `exp(−σ_t d)` of the air at the eye's height (to 0.05%), and gathers a uniform slab's closed form `S/σ_t (1 − e^{−σ_t d})` (to 5%).
      - Straight up, the volume thickens with each slice and its far end is 90–102% of the zenith's sky. Distant things go blue; tenfold aerosol hazes more; a set sun leaves the air dark.
      - The volume is laid out as the shader reads it, a froxel's centre samples as itself, and the eye sees clear air. The frame's terms are off without a sky, for an orthographic camera, or at ×0.
      - The player hands the AAA scene the air. After `cartbox.sun3d` lowers the sun, the environment keeps its old light until every row is drawn, then takes the new sky whole: within 5% of `skyRadiance` for the new sun, dimmer than at 40°, and with a new 8-bit copy.
      - On Dawn:
        - the GPU's volume is the CPU's froxel by froxel, within 1% for the light and 0.002 for the transmittance;
        - a grey wall 3 km of air away (300 m at ×10) is colour × T + L of the CPU's volume within 2%, bluer for it, and is untouched at ×0 or without a sky.
    - *Left for F5a:*
      - The fantasy tiers' backdrop (the 1536 × 768 painted copy) keeps the sun it was baked for. Only their reflections follow the time of day.
      - A time-of-day re-light drops the distant vistas from the reflections copy, which are drawn only at load.
      - The probe volume and light maps are baked for one sun. Re-lighting them as the sun moves is real-time GI (F3e).
      - The volume carries no shadows: the air in a mountain's shadow still glows. F5b's froxel fog, which marches the sun's cascades, will bring them.
      - **F5a-3**: the moon and the night sky in physical units.
      - The painted sky's objects, cloud layers and distant vistas draw over the other tiers' copy of the physical sky, but not over the AAA backdrop. F5c's clouds and a composite of the vistas will bring them back there.
      - The CPU LUTs take about 0.8 s at load. A worker, or reading the GPU's LUTs back on the AAA tier, would hide that.
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
  - **F11a-1, the Milestone A captures: done.** `captures/f11a/` holds Lockout and Beaver Creek from seven fixed views. Each is shown before (the Xbox 360 tier's shading at its 1280×720 frame) and after (the AAA tier's Milestone A path at the display's resolution, 1920×1080 here), with what each frame measured (`report.json`) and a README with the findings.
    - **How they are made** (`scripts/capture-aaa.mjs`):
      - `/lockout?capture=1` hands the script the player.
      - The script starts a match, skips the intro, and puts the editor camera on each view.
      - It times the frame while the game plays. Then it pauses and steps 20 frames for TAA's history to settle.
      - It reads the presented frame back through the new `PlayerHandle.captureFrame()`, since a screenshot of a WebGPU canvas can come out blank. The canvas is made copyable on the first capture; an extended frame is clipped at SDR white.
      - `?dynres=0` holds the after frames at full native size.
    - **What they show:**
      - Colour is richer (chroma up 21–54% in six of seven views) at the same brightness.
      - Contrast is lower in every view (6–29%), from three sources:
        - Lockout's display-referred painted sky is exposed and tone-mapped with the scene: its blue pales while lit surfaces come out about 0.6 stop darker.
        - Beaver Creek's fog now mixes in linear light and lifts the far canyon.
        - The sun's bloom spreads wider.
      - **Beaver Creek's creek water reads as a bright, speckled pattern on the AAA path.** F11a-2 traced it.
    - **Left for later** (next):
      - Calibrate the AAA path against the authored look: the painted sky as display-referred under the tone curve, fog density in linear light, bloom spread.
      - Then the re-light in physical units, once F3's physical sky replaces the painted one.
    - **Frame time:** only on SwiftShader here, a software GPU, so a floor and not a device class.
      - At 2.25× the pixels, Beaver Creek's scene costs 1.3× as much and the presenter about 4×.
      - Lockout's scene frames ran past the frame-graph timer's 10 s sanity bound, so they have no scene time.
      - Per-device numbers need the same run with `CBX_GPU=1` on real hardware.
    - *Tests (`frame-capture.test.ts`):* rows unpadded and BGRA swizzled; an extended frame clipped at white; and on Dawn, the frame just presented read back to every capture waiting on it.
  - **F11a-2, see-through tints and reflectivity in linear light: done.** Tracing Beaver Creek's creek water on the AAA path found two faults, now fixed in `WebgpuSceneRenderer`'s linear-light shader:
    - **A refracting surface's tint mixes as the display shows it.** The surface and what is behind it are both exposed, put through the curve and sRGB-encoded, mixed by the surface's alpha, then turned back into the light that shows the result. The curve's inverse is closed-form.
      - The tint is authored for the display, and the byte path mixes in display space. Mixed in linear light, the water's dark teal (0.02, 0.07, 0.10 linear) only dimmed the creek bed, and its colour was lost.
      - This covers refracting draws (the creek, Lockout's shields and sword), which already composite over the scene behind them in the shader. A plain blend still mixes in hardware, in linear light.
    - **Reflectivity scales the environment's reflection but never past all the light.** `min(specE · reflectivity, 1)` is the weight. At grazing, the creek's reflectivity of 1.3 had it reflect more light than came in.
    - **What the creek's look is otherwise.** Low over the water, Fresnel makes it nearly a mirror, and the ripples tilt the reflection between the canyon walls and the sky. That is how rippled water behaves; the byte path has no Fresnel, so it never showed. With reflection off the creek reads as water. Its ripples and reflectivity were tuned on the byte path, and calming them on this tier is the water pass's (F5d).
    - `scripts/capture-aaa.mjs` takes `[views] [tiers]` to capture only some, e.g. `… beaver http://localhost:3100 1.5 creek after`.
    - *Tests:*
      - `see-through-hdr.test.ts` (Dawn): a refracting tint over the scene equals the display-space mix within 3%, and is far from the linear one. Beaver Creek's water over sand reads blue over red, as on the byte path. Both fail without the fix.
      - `ibl.test.ts`: reflectivity 2 doubles a dark dielectric's reflection, but leaves a white mirror's at what the sky sends. That case fails without the cap.
  - **F11a-3, the painted sky and fog as authored: done.** Two display-referred parts of the maps' look now come out on the AAA tier as they were authored on the byte path:
    - **The painted sky shows as painted** (`gpuPresent.ts`). The sky dome is display art. A linear frame used to tone-map it a second time, which deepened and shifted its blues. It now takes the light the curve maps back to the painting: the filmic curve's inverse, closed-form, divided by the frame's exposure. The sky holds steady as the eye adapts, as on the byte path, and still blooms as light.
    - **Fog mixes as the display shows it** (`WebgpuSceneRenderer.ts`). The byte path mixes its display colour into the tone-mapped surface; mixed in linear light, it lifted the distance far more.
      - Now the surface is taken to what the display shows, mixed with the fog colour there, and turned back into light.
      - Only the change is applied (`mixAsShown`), so a light past white keeps what it has over it, and a glow in thin fog still glows.
    - **What it does to the captures.**
      - Lockout's overview gets its painted sky back. Contrast rises from 0.186 to 0.227 (the byte path's is 0.262), and mean luminance falls from 0.67 to 0.51 (the byte path's is 0.60).
      - Beaver Creek's overview loses the veil the fog laid over the canyon. Contrast rises from 0.256 to 0.265 (the byte path's is 0.319) and chroma from 0.208 to 0.252, while mean luminance falls from 0.65 to 0.59 (the byte path's is 0.66).
      - In both maps the frame is now darker than the byte path's, by 0.07 to 0.09 in mean luminance. Part of that is the bloom, below.
    - **What is left: the bloom.** Lockout's post stack was tuned with the byte path's thresholded bloom, which adds light to everything past 0.9.
      - On Dawn, with the whole stack on, a flat bright field shows 252 on the byte path and 236 on the AAA tier.
      - With the bloom off they show 239 and 236, and with no stack at all they match.
      - The HDR bloom (F4d-1) moves light rather than adding it, by design, so lit surfaces read darker than the art was tuned for.
      - Whether the AAA tier should add the authored brightening back (as F4e-2 does for streaks, in display units after the curve) or keep the physical bloom was the next decision: F11a-4 adds it back, and keeps the physical bloom as a switch.
    - *Tests:*
      - `gpu-present.test.ts` (Dawn): under the tone map, at exposures 0.4, 1.1 and 3, the painted sky matches the byte path's within 2 levels. It fails without the inverse.
      - `see-through-hdr.test.ts` (Dawn): a fogged surface equals the display-space mix with the fog colour within 3%, where the linear mix lifted it at least 10% (fails without the change). A glow of 8 in thin fog keeps most of its light.
  - **F11a-4, the bloom as authored: done.** The AAA tier now blooms as the maps were tuned: the post stack's own bloom, thresholded on the frame as shown and added over it. Before, the physical bloom (F4d-1) moved light into its glow and left lit surfaces darker than the art.
    - **Past white it still gathers light** (`gpuPresent.ts`). On the byte path, a light of 60 and one of 2 both clip to white and bloom alike.
      - The tone map's pass now writes, beside the frame, what the bloom gathers: the frame as shown, and from 0.9 of white the light an HDR display would show past it, the lens pass's rule (F4e-2).
      - The post stack's bright pass and pyramid read that instead of the frame. Under 0.9 of white the two are the same, so the glow is the byte path's.
      - Only the scene and the held weapon gather past white. The base (the painted sky, a backdrop) is display art and blooms as painted, so the painted sun glows as it was drawn to.
      - The glare, the HUD and the holo UI are handled as before: the bloom gathers the frame without the lens pass's glare, as the post stack did, and the HUD and holo cover what they cover.
    - **The physical bloom is kept for physical light.** The bloom's new *Physical (AAA)* switch runs F4d-1's energy-conserving chain instead, for a scene lit in physical units (F11a's re-light). Lens dirt now lights either bloom; the post stack's draws the same smudges.
    - **What it does to the captures** (overviews, against F11a-3's):
      - Lockout: mean luminance rises from 0.51 to 0.55 (the byte path's is 0.60), and contrast from 0.227 to 0.258, all but the byte path's 0.262.
      - Beaver Creek: mean luminance rises from 0.59 to 0.64 (the byte path's is 0.66), and contrast from 0.265 to 0.295 (the byte path's is 0.319).
      - The frames are still 0.03 to 0.05 darker in mean luminance than the byte path's, on lit surfaces. That rest of the gap is still to trace.
    - **Still to calibrate:** a plain colour backdrop is still decoded and tone-mapped with the scene on the AAA tier, where F11a-3 gave the painted sky the curve's inverse. No map ships one, so it waits.
    - *Tests:*
      - `bloom-as-authored.test.ts` (Dawn):
        - A lit square and a coloured patch under white bloom as the byte path does, within 3 levels. The physical bloom shows the square at least 5 levels darker.
        - A light of 60 blooms at least 15% harder than one of 2 that clips alike (fails without the gather).
        - A near-white backdrop blooms less than the same light drawn in the scene (fails without the gate).
        - The frame runs as one compose pass and the post stack.
      - `grading.test.ts`: lens dirt lights both blooms.
      - The F4d graph tests (`post-in-graph`, `lens-fx`, `tone-mappers`) now ask for the physical bloom.
  - **F11a-5, the tone curve as authored, as an option: done.** It traced what F11a-4 left to the tone curve, tried the byte path's curve as the default, and kept it as a switch when the captures showed it trades one gap for another.
    - **The byte path's shader maps its display-space shading.** For a fully lit surface it shows `aces(1.1 · v)` on sRGB values. The AAA tier maps linear light, `encode(aces(1.1 · x))`, which is the physically right curve but not the one the maps were tuned under.
      - On a real scene renderer, a fully lit 0.3 surface showed 118 on the byte path and 96 on the AAA tier; a 0.8 one showed 196 and 218. In ambient alone the gap was 88 against 44.
    - **As authored, the curve maps the light's encoding** (`toneMappers.ts`, `shownWith`): `aces(exposure · encode(x))`. A fully lit surface then shows as the byte path shows it (128, 166 and 197 for those surfaces); the lighting itself stays linear.
      - Everything that models how a pixel shows follows the same rule: the presenter's tone map and its HDR-display output, the bloom's gather (F11a-4), the painted sky's inverse (F11a-3), the lens pass's bright pass (F4e-2), and the scene renderer's fog and see-through mixes (F11a-2, F11a-3).
      - On an HDR display the authored curve's white moves to the headroom's encoding, with grey kept where SDR shows it (`extendedExposure`'s authored domain).
    - **Why it is not the default.** Linear lighting already makes partial light read brighter once encoded (half the light shows at about 0.75 of the colour, not 0.5); the authored curve then lifts it again.
      - Lockout's overview: mean luminance 0.55 to 0.60 (the byte path's is 0.60), but contrast 0.258 to 0.223 (the byte path's is 0.262), with the shade (0.2 to 0.4 on the byte path) going from 0.03 dark to 0.05 bright.
      - Beaver Creek's overview: mean 0.64 to 0.72 (the byte path's is 0.66), contrast 0.295 to 0.237 (0.319), and its shade 0.23 too bright: the canyon reads washed out.
      - So the rig's *AAA curve* setting (`SceneLighting.authoredCurve`) defaults to *Physical*; *As authored* is there for a scene that wants its lit surfaces exactly as tuned.
    - **What is left is in the light, not the curve.** Lockout's sunlit surfaces (0.8 to 0.9 on the byte path) are about 0.07 dark under either curve. That is the next thing to trace: the direct light's energy on the AAA path against the byte path's.
    - *Tests:*
      - `curve-as-authored.test.ts`: the authored curve shows a fully lit surface exactly as the byte path's shader does; grey holds on an HDR display in both domains; the rig maps physically unless it asks for the authored curve, and the choice survives a save. On Dawn, lit 0.3, 0.5 and 0.8 surfaces show within 12 levels of the byte path under the authored curve (the rest is the AAA tier's BRDF), where the physical curve is more than 2.5 times as far off.
      - `gpu-present.test.ts`: the painted sky shows as painted under either curve, at exposures 0.4, 1.1 and 3.
      - `see-through-hdr.test.ts`: fog mixes as the display shows it under the authored curve.
      - `bloom-as-authored.test.ts`: the bloom matches the byte path's under either curve.
      - Taking out the presenter's, the sky's or the scene renderer's authored branch fails its test.
  - **F11a-6, where the lit-surface gap lives: traced.** Lockout's real scene was rendered on Dawn on both paths, with every texture decoded as the player decodes it and the rig as the map ships it. The AAA frame's mean luminance is 0.33 where the byte path's is 0.41, as in the captures.
    - **Ruled out** (each moves the gap by under 0.01, in the scene or in the captures):
      - the depth prepass and the HDR TAA it enables, and mipmaps (Lockout captured with each off);
      - the light probes, the 39 energy lights and the environment map;
      - a texture's decode: an albedo map and the same colour as a factor show identically on both paths.
    - **Not the fix:** light intensities read as display-referred (raised to 2.2) overshoot, to 0.47 under the physical curve and 0.48 under the authored one.
    - **By material**, under the physical curve and then the authored one (luminance; the byte path's first):
      - Snow (0.91) and the wall panels (0.52) match within 0.02 under either.
      - The cliff rock (dark albedo, rough): 0.24 against 0.15, then 0.27. The physical curve crushes it; the authored one over-lifts it.
      - The underside (metal 0.6, dark albedo): 0.46 against 0.35, then 0.47. The authored curve matches it.
      - The deck: 0.66 against 0.56, then 0.60, and as far off with its metal taken out. The gap there is the deck's own shading (rough 0.7, polished, normal-mapped plates), not the curve or the metal, and is the next thing to look at.
    - So no single global change closes the gap: what is left is per material. The look-dev stage (F10c), a grey and chrome ball and a colour checker under each tier, is the tool for the rest; the physical re-light (with F5a) replaces the byte path's look as the reference.
  - **F11a-7, the deck's gap: traced to its albedo, not its shading.** The deck was rendered alone on Dawn on both paths, one of its inputs changed at a time (luminance, byte path first; then the AAA path under the physical curve and the authored one).
    - **Its maps don't hold it.**
      - Without its normal map it is 0.683 against 0.568, and without its metal-roughness map 0.626 against 0.577.
      - Its albedo map, or its metal-roughness map, flattened to its mean, moves it by about 0.01; so does dropping its light map, detail map or relief.
      - Without its albedo map, at its factor of about 0.9, the gap turns round: 0.815 against 0.862 (0.788 authored).
    - **What holds it is how each path answers albedo.** A plain grey deck (no maps, metal 0, rough 0.7), byte path against AAA:

      | albedo | byte | AAA, physical | AAA, authored |
      | --- | --- | --- | --- |
      | 0.2 | 0.604 | 0.408 | 0.509 |
      | 0.4 | 0.774 | 0.679 | 0.667 |
      | 0.6 | 0.845 | 0.829 | 0.762 |
      | 0.8 | 0.885 | 0.901 | 0.820 |
      | 1.0 | 0.911 | 0.939 | 0.858 |

      - The byte path shades the authored, encoded albedo as if it were reflectance, so a 0.2 albedo lights as 0.2 rather than its linear 0.033, under a rig tuned that way.
      - Its answer to albedo is flat, darks lifted. The AAA path's is physically steeper, as each material's own gap in F11a-6 shows: dark materials darker, light ones lighter.
      - Roughness doesn't move it (rough 1 is within 0.01). Metal 0.4 leaves the authored curve on the byte path's values at 0.2 and 0.6, and over it at 1.
    - **Not the fix: albedo left encoded** (shaded as authored, as an option would). Every material overshoots: the deck reads 0.782 against 0.661, the rock 0.393 against 0.240, and the frame 0.544 against 0.409 (0.585 authored). The byte path's rig was tuned for its own answer as a whole, not for linear light with encoded albedo.
    - So the deck needs nothing of its own. Its gap is the one F11a-6 found in every material, from albedos and a rig tuned under byte-space lighting. The authored curve already matches the frame's mean (0.414 against 0.409).
    - What closes it per material is the physical re-light this item calls for: albedos re-measured for linear light, with F10c's look-dev balls and colour checker, and lights in physical units, with F5a's sky. It comes after Milestone C's lighting.
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
