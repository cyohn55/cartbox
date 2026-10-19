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
      - The engine samples textures at (u, 1 − v), so its bitangent `w · (n × t)` points up V. That is MikkTSpace's own sign and the opposite of glTF's, so w is flipped on import and export.
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
    - *Found, not changed:* imported glTF UVs are stored as glTF writes them (V down), while the engine samples V up (as OBJ and its own meshes are). So an imported glTF's textures show flipped vertically. Fixing it means flipping V on glTF import and export, which would change the look of meshes already saved in carts; that needs a decision. When it lands, the tangent conversion becomes w = glTF's w.
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
  - **F3a-1, the IBL on the GPU: done.** The linear-light shader (the `aaa` tier) lights from the environment as Karis's split-sum IBL (`render/ibl.ts`). The Modern tier keeps the panorama and lerp for its parity with the software rasteriser.
    - **The source** is the environment in linear light: its panorama, or its sky/horizon/ground gradient, decoded from authored colour and scaled by its intensity, as the shader's `envColorDir` reads it. It is uploaded as half floats with its own mips.
    - **The cube** (128², six levels) is built in compute. Each level is the GGX lobe of its roughness (level / 5), importance-sampled with 128 mip-filtered samples (Křivánek and Colbert).
      - The coarsest source level read keeps eight rows: an equirect's mips weight a polar texel as an equatorial one, and reading past that pulled the poles' light into wide lobes (8% at full roughness, now 2%).
      - The shader samples it trilinearly at `roughness × 5`, through its own sampler at group 1 binding 9. The cube takes over binding 7 in this variant, because the fragment stage's 16 sampled textures are all bound.
      - It is rebuilt only when the environment changes: its gradient and intensity, or the identity of its map. On Beaver Creek it is built once.
    - **The diffuse light** is L2 SH irradiance, projected on the CPU and convolved with the clamped cosine (Ramamoorthi and Hanrahan), carried in the frame uniform. Before, it was the radiance straight along the normal, not the irradiance over the hemisphere.
    - Reflection probes still mix in their nearest panoramas, blurred toward their average (F3b).
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
- [ ] **F4d. Tone mapping and output.**
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
- [ ] **F4e. Post on the GPU frame graph.** (Partly ahead of time: F0a ported the stack to WGSL for GPU-presented frames; what remains is running it on the HDR frame graph of F0b/F0c.) The WebGL1 single-pass post stack (`PostFxPass.ts`) becomes frame-graph passes at full precision. Every existing effect (CRT, dither, grain, aberration, flare and the rest) is kept, so the fantasy-tier looks still work on `aaa`.

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
