# AAA Production Roadmap: beyond the renderer

## Goal

`AAA_FIDELITY_ROADMAP.md` gave Cartbox a renderer with a current-generation feature list: virtual shadow maps, probe GI and SSGI, HDR TAA with upscaling, volumetrics, GPU culling, GPU skinning, a path-traced reference. Its tracks F0–F10 are checked off, and spot checks of the code (`virtualShadows.ts`, `motionMatching.ts`) find real implementations, not stubs.

The editor still cannot make an AAA game. The captures in `captures/f11a` and `captures/demo-quality` show block-built characters, cone trees and stretched 128² textures under that renderer. The limits now sit **outside the renderer**:

- nothing the renderer does has been verified on a GPU in CI, or measured on hardware;
- the main thread's frame budget has not been measured on hardware, and physics, navigation and Lua all share it;
- the editor can neither author nor import AAA-density content;
- the gameplay runtime is built on fixed-size shared-memory protocols from a fantasy console;
- there is no gameplay framework (AI, combat, projectiles), and the script tooling does not scale;
- audio and networking are at prototype level;
- the editor is built for one person, not a team.

This roadmap closes those gaps. It does not repeat the open items of other roadmaps; where one already owns a piece, the item here points to it.

## Where things stand (audit, November 2026)

| Area | Today | AAA expectation | Track |
| --- | --- | --- | --- |
| Verification | 67 test files that need a WebGPU adapter all skip in CI (`ci.yml`, `describe.skipIf(!device)`); run by hand on lavapipe | Every shader validated per change on a GPU device; frame times from hardware | Q |
| Budgets | `deviceBudgets.ts` has iPhone, iPad and desktop rows; no `aaa` row, no integrated-GPU class, no GPU ms per pass | Per-tier, per-device budgets enforced in the editor | Q |
| Main thread | Renderer JS 4.2–5.5 ms a frame on Beaver Creek in Node after F0e-3 and F0e-4 (from 14.5 ms), against F0e's 4 ms exit; never measured in a browser on hardware; physics, navigation and Lua on the same thread by design (F0e-5) | Measured on hardware; simulation that scales without stalling the frame | M |
| Pipelines | 43 synchronous `create*Pipeline` sites | Async compilation, a warm-up, no first-use hitches | M (with R5) |
| Modelling | Box modelling: loop cut, subdivide, mirror, extrude/inset/bevel; sculpting only on voxel and hexel lattices | DCC round-trip; sculpt and retopo stay in DCC tools | D |
| UVs | `uvUnwrap.ts` projects each face on its dominant axis | Angle-preserving unwrap (LSCM/ABF) with user seams | D |
| Import | FBX: geometry, first UV set and diffuse colour (no skin, animation or textures); USD in 213 lines; KTX2 on import open | Rigged, animated, textured FBX and glTF; USD stages; GPU formats on import | D |
| Storage | `.cbpk` packages built (F9e) but mesh sidecars still save as base64 JSON; maps synthesised in the browser (R2 open) | A build-time cook to content-hashed packages | D |
| Simulation caps | 64 dynamic bodies (bodies past it silently dropped, `physicsSession.ts:309`), 16 rays, 16 nav agents, 16 joints, 32 prefab copies, on every core | Thousands of bodies; caps set by budget, not protocol | S |
| Queries | Rays and sweeps answer on the next tick | Same-frame scene queries | S |
| Physics features | No CCD; no collision layers in `PhysicsSpec` (S3 adds them); hinge, ball, fixed, spring and rope joints but no slider; no vehicles | CCD projectiles, filter masks, the full joint set, vehicles | S |
| Gameplay framework | Components (5 callbacks) and a script graph; no AI, perception, damage, abilities or tags | Behaviour trees, perception, a damage and ability framework | K |
| Script tooling | Textarea editor; no modules, autocomplete or diagnostics; Lockout is one 7,000-line string | Modules, a language service, incremental highlighting | K |
| Audio | `soundSystem.ts` (280 lines): buffers, buses, `PannerNode`, 24 voices | Reverb zones, occlusion, ducking and snapshots, adaptive streamed music | U |
| Networking | 8 slots × 4 state words; 30 Hz direct, 7.5–15 Hz relay; peer host; players and events only | Entity replication; an authoritative host; lag compensation | N |
| Team workflow | Whole-cart undo snapshots (60); a snapshots panel; one editor at a time | Delta undo; co-editing; branches and merges of scene data | W |
| Content | 128² albedo-only terrain, cone trees, block-built Spartans | A reference set through the whole pipeline | Z |

## Ground rules

- **The fantasy tiers don't change.** As in every roadmap here: PS1 through the 360 render and simulate byte-identically. Items that raise caps raise them for the `modern` and `aaa` tiers, or behind a cart's opt-in, and keep the fantasy protocols as they are.
- **Deterministic and replayable.** Gameplay changes keep the replay and verification contract (`replay.ts`, `verify.ts`) and the network lab (L2).
- **Measured, not asserted.** Performance items close on hardware numbers (R1), never on SwiftShader or lavapipe alone. Correctness items close on tests.
- **Each item ships as its own PR with tests, merged when CI is green.** Each carries a note in this file when it lands.
- **Pure, DOM-free models** in `packages/editor`, as the codebase already does, so every item is testable in Node.

## Honest constraints

- **No hardware in this environment.** Track Q can put a software Vulkan device (lavapipe) in CI, which proves that drivers accept the shaders and that the pictures match. It cannot measure frame times. R1 (`DEMO_QUALITY_ROADMAP.md`) owns the hardware.
- **The web platform's ceiling holds.** WebGPU has no hardware ray tracing, mesh shaders or 64-bit atomics; a tab gets 2–4 GB, iOS far less. The target remains last-generation AAA or stylised photoreal at 1080p60, as `AAA_FIDELITY_ROADMAP.md` sets it.
- **Sculpting and retopology belong in DCC tools.** Track D makes Cartbox an excellent *destination* for Blender, ZBrush and Substance output before it competes with them.

## Tracks

### Q. Verification and budgets

- [x] **Q1. WebGPU suites in CI on lavapipe.** **Done.**
  - A CI job installs Mesa's software Vulkan (`mesa-vulkan-drivers`) and `@kmamal/gpu@0.2.0` (not a devDependency; see `webgpu-parity.test.ts`) and runs every test file that needs an adapter.
  - The files are found by the import, not listed by hand, so a new GPU test joins the job without anyone remembering to add it.
  - The job fails if the adapter is missing, so the suites can never skip silently again.
  - *Acceptance:* the job runs on every pull request, and all GPU suites pass or are fixed.
  - **What landed.**
    - `npm run test:gpu` (`scripts/test-gpu.mjs`, logic in `scripts/lib/gpuTests.mjs`):
      - asks Dawn for an adapter first and prints which ("mesa software llvmpipe … Mesa 25.2.8" here), failing with what to install when there is none, rather than letting 67 files skip;
      - finds the suites by a real `import()` or `import … from` of `@kmamal/gpu` (a mention in a comment or string doesn't count), so a new suite joins by being written;
      - runs them with vitest's JSON report beside the usual output, then fails on any test that didn't pass (skipped, todo, failed), a file that failed outside its tests, a file with no tests, or a file asked for and never reported (except under `--shard`).
      - `--list` names the suites; anything else passes on to vitest.
    - `ci.yml` gains a `gpu` job on `ubuntu-latest`: lavapipe from apt, `npm ci`, Dawn with `--no-save`, then `npm run test:gpu`.
    - The note that CI can't run these (`EDITOR_PRO_ROADMAP.md`'s ground rules) and `webgpu-parity.test.ts`'s header now point to the job.
  - **Measured** on this container (4 cores, Ubuntu 24.04's Mesa 25.2.8, as `ubuntu-latest` installs): all **67 files, 615 tests pass in 296 s**, with no skips. One job, no shards. Every suite already passed; none needed a fix.
  - *Verified by hand:* with no Vulkan driver (`VK_ICD_FILENAMES` pointed nowhere) the run stops at the probe, exit 1; with every test filtered out (`-t` matching none) it fails listing each skipped test, exit 1; a clean shard exits 0.
  - *Tests (`gpu-test-runner.test.ts`, 14):* the worker cap, and a caller's own count kept; the import detection (dynamic with and without vite's comment, template strings, static and multi-line imports; not comments, plain strings, similar package names or other paths); discovery (nested, sorted, relative, `.test.ts` only, and this repository's 60-odd suites with the parity suite); the report check (a clean run; skip, todo and failure named; a file that died before its tests; no tests; an unreported file, and not under a shard; no report at all); the shard flag in both spellings; the probe naming its adapter and destroying the device, and saying what to install for a missing package or adapter.
  - **Two workers** (`GPU_WORKERS`, `withWorkerCap`). By the week's end the job held 70 files, and at vitest's default parallelism a run lost a worker four times in five: Dawn's Node binding (`@kmamal/gpu` 0.2.0) dies natively (a fatal N-API error in a callback scope) when many processes drive lavapipe at once, and the suite that worker held, most often `webgpu-parity.test.ts`, never reported. It isn't new: the commit before this week's work lost one run in five the same way, and every suite passes on its own. So the runner caps the workers at two unless told otherwise (`--maxWorkers=…` wins), and at two, four runs in four passed whole, all 70 files and 646 tests, in about six minutes. It is a load at which the binding holds, not a fix of the binding. `npm test` on a machine with Dawn installed runs the GPU suites at full parallelism and can still lose that worker; the CI job that installs Dawn is this one.
  - The pipeline-manifest recorder (`map-pipelines.test.ts`) defines its recording test only when recording, and its checks only when not, since a skipped test fails this job.
  - *Left:* frame times, which lavapipe can't give (Q4/R1); Q3's reference images will run in this job.
- [x] **Q2. An `aaa` budget row, and an integrated-GPU class.** **Done, with provisional numbers.**
  - `deviceBudgets.ts` gains an `aaa` tier per device (desktop discrete, desktop integrated, iPad, iPhone) with triangles, draw calls, texture and mesh bytes, download bytes and GPU milliseconds per pass, as `AAA_FIDELITY_ROADMAP.md`'s ground rules require.
  - The Budget panel reads it for `aaa` carts.
  - **What landed** (`editor model/deviceBudgets.ts`).
    - **A second table, by tier.** `AAA_DEVICE_BUDGETS` covers four classes, smallest first: iPhone, iPad, an integrated GPU and a discrete GPU. Each class carries its quality level and output resolution. Every call takes an optional `BudgetTier`, `fantasy` by default, so the fantasy tiers' table and every existing caller are unchanged. An integrated GPU on a fantasy cart checks as the desktop, which those tiers don't split.
    - **The numbers are provisional** (`AAA_BUDGETS_PROVISIONAL`, which the editor shows), set from `AAA_FIDELITY_ROADMAP.md`'s targets until R1 measures them:

      | Class | Level | Output | Frame | Triangles | Draws | Textures | Meshes | Download |
      | --- | --- | --- | --- | --- | --- | --- | --- | --- |
      | iPhone | Medium | the screen's, upscaled | 33.3 ms | 600k | 700 | 256 MB | 96 MB | 48 MB |
      | iPad | Medium | the screen's, upscaled | 33.3 ms | 1.2M | 1,200 | 512 MB | 160 MB | 64 MB |
      | Integrated GPU | High | 1080p, upscaled | 16.7 ms | 3M | 2,500 | 1 GB | 384 MB | 160 MB |
      | Discrete GPU | Epic | 1440p | 16.7 ms | 8M | 5,000 | 2 GB | 768 MB | 256 MB |

      Each is above the fantasy tiers' figure for the same device. Triangles and draws count what reaches the raster after GPU culling and cluster LOD. Textures are counted, as everywhere in this file, decoded to RGBA8 with mips; the tier stores them in BC7 or ASTC at a quarter of that or less. Downloads stop at F9e's 256 MB direct-upload ceiling.
    - **GPU milliseconds per group of passes.** `passGroup` sorts every frame-graph pass by name into seven groups. The presenter's `present: ` prefix is dropped, and a dotted sub-pass goes with its root. Each group gets a fixed share of the class's frame time, 0.9 in all, leaving a tenth for the browser's compositing and for spikes:

      | Group | Passes | Share |
      | --- | --- | --- |
      | Culling and depth | `cull.*`, `hiz`, `prepass`, `texture feedback`, `lights.cluster` | 8% |
      | Shadows | cascades, virtual shadows (`vsm.*`), local and contact shadows | 14% |
      | Scene shading | `opaque`, `see-through`, `behind`, particles, `sss.*` | 27% |
      | GI, AO and reflections | `gtao`, `ssgi`, `dynamic gi`, `reflections` | 18% |
      | Sky, fog and volumes | `sky`, `volumetric fog`, `volumes`, shafts | 8% |
      | Temporal and post | `taa`, `upscale`, `motion`, `dof`, bloom, lens, tone map, compose, `measure`, view modes | 13% |
      | Other | `readback`, and anything unsorted | 2% |

      `checkPassBudget` sums a frame's pass times (the profiler's `passes`) by group against those budgets.
  - **The editor.**
    - On an `aaa` cart, the Mesh tab's **Budgets** panel offers the four classes and names the level, resolution and frame rate of the one chosen, marked provisional. Its fit line reads "Fits an integrated GPU and up." (`fitSummary`, with the right article for each device).
    - The viewport's readout checks draws, triangles and textures against the same table.
    - The playtest **Profiler** lists one GPU line per group that ran: its time against its budget, the passes in it, and a warning when it is over. Its device list follows the tier too.
    - The device choice is still remembered per browser, and now includes the integrated GPU.
  - *Tests (`aaa-budgets.test.ts`, 13):*
    - the fantasy table is the default, and its checks, smallest fit and budgets are unchanged; an integrated GPU on it checks as the desktop;
    - the AAA classes grow monotonically in every scene line and exceed the fantasy figure on each shared device;
    - the targets hold (Epic 1440p60, High 1080p60 upscaled, Medium at 30 fps on both iOS classes, downloads within the upload ceiling), and the table is marked provisional;
    - the shares sum to 0.9, and each class's pass budgets are its frame time times those shares;
    - a scene's check and smallest fit on each tier;
    - the fit sentences;
    - `passGroup` on sub-passes, the presenter's prefix and unknown names;
    - `checkPassBudget`'s sums, order and over flags, with NaN left out and a negative time counted as none, and a phone allowed twice a desktop's milliseconds;
    - **a scan of the renderer's source**: every pass name `addPass`, `scenePass` or `blurPass` declares (comments skipped, 60-odd names) sorts into a group other than Other, except the readback. Removing `dof` from the table fails the test, naming `dof.prefilter`, `dof.gather` and `dof.composite`. So a new pass can't hide in Other.
  - *Left:* the numbers themselves, which R1 measures and Q4 confirms (then clear `AAA_BUDGETS_PROVISIONAL`); enforcing the budgets at load (R3 does this for phones).
- [x] **Q3. Reference-image regression.** Fixed views of Lockout, Beaver Creek, the look-dev stage and the ruin scene, rendered on Q1's device and compared against stored references with a perceptual metric (FLIP or SSIM), so a change that alters the AAA image is seen in review. **Done.**
  - `reference-images.test.ts` renders eight views at 160×90 on the GPU job's device: the look-dev stage under the studio, noon, overcast, golden-hour and night rigs, and the Forerunner ruin, Lockout and Beaver Creek. The scenes are drawn *as the game draws them*: the player's own mesh overlay builds each draw, and its renderer (the real WebGPU one, behind a proxy) keeps the frame on the GPU for the test to read back. One frame each from a fresh renderer, so nothing temporal accumulates.
  - Each frame is tone-mapped with the draw's own exposure (Reinhard, sRGB) and compared on luminance by mean SSIM over 8×8 windows (at least 0.97) and by the mean absolute channel difference (at most 2/255). A failing frame is written out and its path named in the failure.
  - References live in `Unit Tests/fixtures/reference-images/`. `CBX_UPDATE_REFERENCES=1 npm run test:gpu -- -t "reference images"` rewrites them, committed with the change that meant to alter the picture. A missing reference fails rather than skips, so `test:gpu` catches it. Being a GPU suite, it runs in CI's `gpu` job.
  - What the images are: the scene pass's linear output, before the presenter's sky, grade, bloom and lens. That is the AAA shading this guards; the presenter has its own GPU suites.
  - *Tests (10):* the measure itself (an image matches itself; a brightness shift and noise are told apart; exposure changes the 8-bit picture), and the eight views against their references, twice over on lavapipe.
- [ ] **Q4. Hardware numbers.** R1's lab. Listed for order only.

### M. The main thread

- [ ] **M1. F0e's exit, measured.** *(Corrected: this item first asked for the transforms and uniforms on the GPU, which F0e-3 and F0e-4 had already done.)*
  - F0e-3 moved each copy's transforms to a compute pass and F0e-4 kept per-draw uniforms between frames. Together they took the renderer's JS on Beaver Creek from about 14.5 ms to **4.2–5.5 ms** a frame in Node, against F0e's 4 ms exit.
  - What remains is spread thin (batching, planning the cull, bind groups, encoding, each under about 0.6 ms). It has never been measured in a browser on hardware: the first `aaa` frame on SwiftShader didn't finish in five minutes.
  - *Exit:* `scripts/measure-main-thread.mjs` with `CBX_GPU=1` on R1's four classes, and the largest remaining cost cut if the exit isn't met there.
- [ ] **M2. Physics that scales without stalling the frame.** *(Corrected: this item first asked to move physics and navigation onto a worker.)*
  - F0e-5 kept both on the main thread on purpose. They are steps of the deterministic tick that netplay replays, and a worker's answer can't be promised by a fixed tick without blocking for it. Neither shipped map has physics bodies, and navigation runs only when a cart sends agents. That reasoning stands.
  - The question returns with S1: once a cart can have hundreds of bodies, measure the step's cost on R1's phones first.
  - Only if it threatens the frame, choose between a worker stepped in lockstep (the main thread waiting at the tick's edge) and a cheaper step on the main thread (sleeping islands, a lower solver iteration count per tier), keeping replays exact either way.
- [x] **M3. Async pipelines and a warm-up.** Every `createRenderPipeline`/`createComputePipeline` goes through one cache with `create*PipelineAsync`, and a scene's pipelines are compiled behind the loading screen. Completes R5. **Done, with R5's shipped manifests; its hardware check is left (Q4).**
  - **One cache per device** (`render/pipelineCache.ts`). All 47 pipeline sites in 21 files go through `pipelineCache(device).render/compute`, memoized by descriptor (shader modules and layouts by identity, everything else by value, labels ignored), with `renderAsync/computeAsync` compiling off the frame where the device can. The device is shared per page (`getWebgpuDevice`), so a renderer made again (resize, quality change, the editor's viewport beside a play view) compiles nothing twice.
  - **One shader module per WGSL source, one layout per descriptor.** The 40 `createShaderModule` sites and the 37 bind group and pipeline layout sites go through `shaderModule`, `bindGroupLayout` and `pipelineLayout`, which make equal ones once (equal layouts are interchangeable in WebGPU) and remember what made them. So the same pipeline asked for twice has the same key, and every pipeline can be written down.
  - **A recorded warm-up**, as engines keep a recorded pipeline-state cache: each pipeline a renderer asks for becomes a recipe (its descriptor with WGSL for modules and descriptors for layouts). The renderer saves the manifest of what it asked for after its first frame, and again after any late compile (`PipelineManifestStore`, localStorage, each WGSL source stored once, at most 512 recipes, recipes not asked for again dropping out). `createSceneRenderer` compiles the stored manifest asynchronously before building the renderer, waiting at most 3 s behind the loading screen.
  - **Counted.** A synchronous compile after the first frame is *late*, a likely hitch. Render stats carry `pipelines` (compiled, compiled off the frame, reused, late, pending), and the playtest profiler shows them, warning on late ones.
  - *Measured on Dawn* (`pipeline-cache.test.ts`): a session renders two plain frames, then adds a see-through box and turns MSAA on, so 7 of its 24 pipelines compile late. A fresh device warmed from that session's manifest compiles all 24 off the frame and **none late**, and draws the same three frames bit for bit. Before layouts were recorded only 5 of the 24 could be, and 5 were still late; that is why layouts go through the cache.
  - **Shipped manifests per map.** The very first load on a browser has no stored manifest, so each map now ships one. `npm run record:pipelines <map>` draws the map on a real device (Dawn; lavapipe does) as Lockout draws it: its model (xbox360), the player's own mesh overlay, and the texture-mode renderer the GPU presenter uses. It draws six views around the arena (each side, high and low, fitted and close), two frames each, and writes the cache's manifest to `apps/web/public/pipelines/<map>.json` in the store's text form (`packPipelineManifest`, each WGSL source once). Lockout is 12 pipelines (300 KB, served compressed) and Beaver Creek 6 (150 KB, 40 KB gzipped).
    - The Lockout page fetches the map's file alongside its sidecar (`fetchMapPipelines`, best effort: a missing, malformed, failing or 2-second-slow file is no manifest) and passes it as `PlayerOptions.pipelineManifest`.
    - The player passes the unpacked recipes to `createSceneRenderer`, whose warm-up compiles the shipped and stored manifests together (`mergeManifests`: each recipe once, at most 512).
    - *A guard:* on the GPU job, a fresh device warmed from the shipped file alone must draw those views with nothing late and nothing compiled synchronously. A shader change that leaves a file stale fails there until it is re-recorded.
  - *Left:* the recorder draws the map's views, not a scripted match, so pipelines that only gameplay asks for (a weapon's effect, the HUD's presenter passes) are still learned by the browser's own manifest on the first match. It records the default path, not `?hdr=1`'s linear-HDR one. R5's hardware acceptance (no frame over 50 ms, R1) needs Q4's lab. Pipelines whose layout is taken off an "auto" pipeline (2 sites) can't be recorded.
  - *Tests (`map-pipelines.test.ts`, 13):* the text form round-tripping with each shader once and being what the store keeps; nothing read from a missing, malformed or older one; merging without repeats within the cap; shipped and stored manifests warmed together; the fetch's URL, its best-effort answers and its timeout; each shipped file readable with every shader written down; and on lavapipe, each map drawn from a fresh device warmed by its file alone with nothing late.
  - *Tests (`pipeline-cache.test.ts`, 9):* keys (identity, value, labels); memoization and late counting after the first frame; async compiles serving later synchronous requests, one in flight per key, and the fallback without async entry points; one cache per device and one module per source; recipes written and read back to the same key, unrecordable ones refused, malformed ones rejected; a manifest recorded and a warm-up making every later request a reuse with nothing late; the store's WGSL dedupe, its cap and its survival of missing, broken, older or blocked storage; the warm-up's time budget; and the Dawn session pair above. The whole GPU suite (67 files) passes through the cache.
- [x] **M4. The scene's parse on a worker.** R2a's remaining 0.7–0.9 s on Beaver Creek. **Done; the browser timing is still to re-measure.**
  - The worker that already builds a map's sidecar while the lobby is open (R2a) now parses it too, and posts the parsed scene with every buffer under it transferred, not copied (`meshSceneTransferables`: each distinct buffer once, though thousands of views share them). A parsed scene is plain data (objects, arrays and typed arrays, checked on Lockout and Beaver Creek), so it crosses whole. In Node the parse it moves costs about 0.4 s on Lockout and 1.0 s on Beaver Creek.
  - The loader carries the scene to the page, which mounts it instead of parsing. Where the `?assets=` cart rewrote the sidecar, or no worker could run, the page parses as before.
  - *Tests (`scene-parse-worker.test.ts`, 4):* one buffer listed once however many views share it; Lockout's scene crossing a structured clone with its 100-plus buffers moved, its digest (every byte and every field) unchanged, the sender's buffers emptied; the real worker script, run against a stand-in `self`, posting Lockout's parsed scene and exactly its buffers to transfer; the loader handing the scene through, and none from a build on the page's thread.
  - *Left:* re-running `scripts/measure-play.mjs` in a browser to put a number on Play-to-mount after it (needs the web app served).

### D. Content pipeline

- [x] **D1. FBX skinning, animation and textures.** Clusters to skin weights, `AnimationStack`/`AnimationCurveNode` to clips, and the material's texture connections (diffuse, normal, specular/roughness, emissive), up to glTF parity. *Tests:* Mixamo-style and Blender-exported fixtures. **Done, on built fixtures; real exporter files are left.**
  - **Skin** (`fbxCodec.ts`). Each mesh's Skin deformer and its Clusters: the bones they name, and the LimbNodes between them, become joints, parents first, at their rest transforms. A bone's `PreRotation` is honoured (Maya and Mixamo set it), in static models too. A root's `base` carries the unit scale and the nodes above it. Each Cluster's `TransformLink` gives its joint's inverse bind; each vertex keeps its four strongest weights, normalised.
  - **Animation.** Each `AnimationStack` is a clip, named as the file names it. A bone's `Lcl Translation`, `Rotation` and `Scaling` curve nodes are sampled at the union of their keys (FBX ticks, from the stack's first key); Euler keys become quaternions kept on one hemisphere, so linear blending doesn't spin the long way round. A missing axis takes the curve node's default.
  - **Textures.** A material's `DiffuseColor`, `NormalMap` and `EmissiveColor` textures (and Maya's `baseColor` and `normalCamera`): embedded in a `Video`'s `Content` (raw in binary files, base64 in ASCII), or among files supplied by name. `fbxReferencedFiles` lists the ones a file names but doesn't embed, and the Mesh tab's import passes every file picked with the FBX. A textured base colour takes a white factor.
  - *Tests (`fbx-skin.test.ts`, 4):* a binary FBX 7400 built in the test, a two-quad strip on a root and a tip bone: joints, parents and weights read; skinned with the engine's own `skinVertices`, the rest pose gives the bind shape, and the clip's 90° turn of the tip moves an all-tip vertex and a half-and-half one exactly where they should go; the same in centimetres; an embedded PNG and a normal map supplied by file, and the import without it. The 17 existing import tests still pass with `PreRotation` honoured.
  - *Left:* fixtures exported by real tools (Mixamo, Blender, Maya), which this environment can't produce; roughness and metalness maps (FBX has no standard slot for them; Stingray PBS and Arnold name their own); blend shapes; rotation orders other than XYZ, and pivots and offsets past `PreRotation`.
- [x] **D2. Angle-preserving unwrap with seams.** LSCM over user-marked seams (with automatic seams from curvature as a default), keeping `uvUnwrap.ts`'s box projection as an option, and the same packer. **Done; seams from the Mesh tab's edge selection are left.**
  - `unwrapConformal` (`uvLscm.ts`): least-squares conformal maps (Lévy et al. 2002). Vertices are welded by position, so a hard edge's split normals don't cut a chart. Seams are the edges given (vertex pairs) plus, by default, every crease sharper than 60° and every open edge. Triangles join into charts across the rest; corners join only across edges that join within a chart, so a vertex on a seam becomes one chart vertex a side and the chart truly opens there. A chart no cut opens (a closed smooth surface) is split by the way its faces face.
  - Each chart is flattened by LSCM: per triangle in its own plane, (z₂−z₁)U₀ + (z₀−z₂)U₁ + (z₁−z₀)U₂ = 0, two far-apart vertices pinned, the least-squares system solved by conjugate gradients. It is turned the way it winds (never mirrored), scaled to its surface area so texel density is even, and packed by the box projection's packer. Skin weights and every other attribute follow the split.
  - `angleDistortion` measures it: each triangle's angles in 3D against UV, area-weighted.
  - **The editor.** The paint panel's Unwrap and Re-unwrap offer Box or Conformal, with the crease angle to cut at, and show the part's distortion.
  - *Tests (`uv-conformal.test.ts`, 5):* a flat grid laid down as itself (distortion under 10⁻⁴, nothing split); a tube cut by a marked seam unrolled into one chart under 0.02 rad, five times better than the box projection, with exactly its seam's seven vertices split and every triangle wound one way; a cube cut at its creases into six square charts that don't overlap; a closed sphere split and flattened with nothing mirrored, better than the box projection; skin joints kept through the split.
  - *Left:* marking seams on the model (the Mesh tab's edge selection, handed to the unwrap); for charts LSCM folds, ABF++ or a boundary-first flattening.
- [x] **D3. GPU texture formats on import.** Imported maps (glTF, FBX, CC0 libraries) transcode to KTX2 on import, not only on save. **Done.**
  - Model files already went through I13's compression on import (`prepareImport`: KTX2 by the platform's plan when it travels lighter); FBX now does too with its textures (D1). The CC0 libraries' models and materials (F9f) skipped it, waiting for the save; they now go through the same rule as they're imported: `compressMeshTextures` for a model, and `compressMaterialTextures` (new) for a material, which compresses its maps through a one-primitive holder, each shared image (a packed occlusion/roughness map) once.
  - *Tests (`import-compression.test.ts`, 2):* a library material's colour, normal and packed data maps become KTX2, the shared one encoded once and still shared, the encoder loaded once, the material's other fields kept; a map that won't decode kept as it was; a material without PNG or JPEG maps never loads the encoder. `ktx2-encoding.test.ts` (6) passes unchanged.
  - *Left:* HDRIs stay Radiance `.hdr` (no BC6H/ASTC-HDR encoder here).
- [x] **D4. Sidecars as packages.** The mesh sidecar routes store `.cbpk` (F9e's format and upload path), with JSON kept as a read path for old carts. **Done.**
  - **On save** (`sidecarStorage.ts`), after the texture offload, each mesh in the sidecar (placed entries, animation frames, LOD levels, the shared library, prefab nodes) of 4 KB or more of JSON is packed (`extractMeshPackages`, `meshPackages.ts`), its geometry squeezed by meshoptimizer's codecs, stored in the cart asset store as `application/vnd.cartbox.package`, filed in the manifest as `mesh-<hash>` (so the sweep sees it), and replaced by `@pkg:<hash>`. Each distinct mesh is packed once. `@lib:` references and small meshes stay as they are. It is best effort, like the texture offload: any failure stores the sidecar the old way.
  - **On load** (the editor's `loadSidecars`, and the play page before it works out which textures to stream), `inlineMeshPackages` puts each reference back as the JSON every reader parses, with its images as asset refs again for the texture inlining or streaming that follows. Old inline sidecars pass through untouched. A package that can't be fetched or read leaves its reference, and the sidecar reader drops only the objects that used it.
  - **The package now carries what it dropped:** images whose bytes live in the asset store (their `ref`), each map's KTX2 twin and relief packing, one copy of an image two slots share, morph targets and the cluster hierarchy (both as chunks: the vertex codec for cluster indices, since the index codec may rotate a triangle's corners), and the mesh's morph weights, springs, fracture and dual-quaternion flag. Its `rest` (skin, clips, trails, variants) is serialized over one stand-in primitive per primitive; until now it was serialized over none, which the JSON codec rejects, so any skinned package failed to read. The texture offload now walks LOD levels too.
  - *Tests (`mesh-packages.test.ts`, 6):*
    - A package keeps asset refs, KTX2 twins, a shared image as one object, morph targets and weights, byte-identical through the JSON codec.
    - A dense mesh's cluster hierarchy round-trips identically, in under half its JSON size.
    - A sidecar's distinct meshes (in entries, frames, LODs, the library and prefabs) become three packages; the row shrinks tenfold; every mesh reads back identical; the `@lib:` reference and the small mesh are untouched.
    - After the texture offload, the packages hold geometry only, and the images inline afterwards.
    - An old sidecar reads unchanged. A missing package, or failing storage, drops only the objects that used it.
    - Lockout's whole sidecar (skinned viewmodels and bots included) packs smaller in total and reads back with every entry identical.
  - *Left:* the client still receives JSON, rebuilt on the server. Fetching packages straight from the CDN and parsing them on M4's worker is D5's player half. A variant's images still ride inline in the manifest.
- [x] **D5. A build-time cook.** A cart's sidecars become content-hashed packages at publish, so a player never synthesises content. Generalises R2 from the two arena maps to every cart. **Done for materials (meshes', terrain layers' and the library's) and for packages, which the player now fetches itself. Terrain meshing at load is left.**
  - **What a load made.** A material with a texture generator (P1c) stores only its recipe, and every load (the player's and the editor's) baked its four maps on the main thread: noise per texel, normals from slopes, a relief map.
  - **The cook** (`cookMeshSidecar`, `meshCook.ts`) runs first in the mesh save path, before the texture offload and the packaging. Each mesh with a recipe is written with `serializeMeshAsset(mesh, { cook: true })`: its maps, compressed, sit beside the recipe, and `cooked: {key, slots}` names the recipe they came from and the slots they fill. A slot holding the material's own image keeps it. The offload then makes the maps content-addressed textures, shared by every cart with the same recipe and streamed like any texture.
  - **Loading.** `deserializeMaterial` uses cooked maps when the recipe still matches its key, and bakes as before when it doesn't (a hand-edited recipe, or an old cart). It counts the cooked maps as the generator's (`adoptGeneratedImage`), so the editor's own saves still send only the recipe and the server cooks again; the cook is idempotent, keeping maps that came cooked (asset refs included) as they came.
  - **Through packages.** The package carries the cooked state (`$cooked`), and reads the material without its recipe so nothing is baked. The load path re-serializes with `cook`, so cooked maps reach the client cooked.
  - *Tests (`mesh-cook.test.ts`, 4):*
    - The cook writes the four maps and their slots. A load of the cooked mesh asks the generator for nothing (`generatorRequestCount` unchanged), where a load of the uncooked one asks once. The maps are the compressed bake.
    - A load then an editor save stores the recipe alone again, while a normal map of the material's own is kept and isn't counted as cooked.
    - A recipe edited after cooking bakes again. A sidecar with no recipe passes through byte for byte.
    - Through the whole save path (four textures offloaded, one package) and the load path, the mesh still loads asking for nothing, with the cooked maps' bytes.
  - **The player fetches packages itself** (`meshPackageLoader.ts`, `meshPackages.worker.ts`). The play page no longer fetches each package and rebuilds the scene's JSON on the server: it hands the client the packages' URLs (content-addressed, so the CDN caches them for good) and the manifest's sizes, so the page carries neither the geometry nor the images.
    - The client fetches the packages in parallel (six at a time) and checks each against its hash, since bytes that don't hash to their name aren't the package. It decodes them with meshoptimizer and parses the scene on a worker (M4), which hands the parsed scene's buffers back rather than copying them. The cart starts once they're in.
    - **Textures inside packages** are only visible once the packages are in, so the client lists the streamed textures then (`streamedMeshTextures`, the same function the server uses for a scene without packages), with their levels and objects as before.
    - **Fallbacks:** a package that can't be fetched, doesn't match its hash or can't be decoded keeps its reference, which the scene's reader drops, so it costs its objects, never the cart. Without a worker, or when the worker fails or answers with an error, the same work runs on the page's thread. If the asset URLs can't be made (no public storage URL), the server inlines packages and textures as before.
  - *Tests (`mesh-package-loader.test.ts`, 7):*
    - the client's result is byte for byte the server's inlining, each package fetched once, and with textures back, the original scene;
    - a tampered package (one byte flipped) is refused by its hash and costs only its objects, as do a 404 and a network failure;
    - fetches run in parallel within the limit, and a package the sidecar doesn't use isn't fetched;
    - textures inside packages are listed once they're in, with sizes and URLs;
    - on a worker (ended after its answer), and on this thread with no workers, a crashed worker, an error answer, or a worker that can't be made;
    - the worker module itself, fetching, decoding and answering with all four objects parsed.
  - **Terrain layers and library materials** (`meshCook.ts`, `meshTextureAssets.ts`). These materials sit in the sidecar as objects (`terrains[].layers[].material`, `materials[].material`), not as mesh strings, so neither the cook nor the texture offload reached them, and every load baked their recipes. Now the cook bakes them like a mesh's material, and the offload then lifts their maps into the asset store (cooking them inline would have put megabytes of PNG in the row). They stream at start, since no level or object owns them.
    - **On the AAA tier,** a terrain drawn from its heightfield (F6c) decodes its layers' maps apart from its blocks, once, from the placeholders. Streamed textures now reach it as well: `supplyImages` re-decodes the layers a batch fills, with every image supplied so far, so a later batch doesn't lose an earlier one. The terrain stays the same object, so its GPU copy re-bakes its virtual texture for the new maps rather than being made again. A terrain rebuilt after an edit keeps what was supplied.
  - *Tests (`terrain-cook.test.ts`, 4):* a terrain layer's and a library material's recipes baked at save, so a load asks the generator for nothing; a material without a recipe, and a sidecar with nothing to cook, left as they were, and cooking twice a no-op; the cooked maps lifted into the store (the row shrinking to a quarter or less), listed to stream at start, and put back byte for byte; and on the AAA path, a heightfield terrain's layers re-decoded as their textures arrive, keeping earlier ones, with the terrain the same object, and a texture the ground doesn't use changing nothing there. Without the `supplyImages` change, that last test fails.
  - *Left:*
    - **Terrain meshing at load.** The player still builds each terrain's blocks from its heights as the scene loads. Shipping them meshed would trade that time for download size, and is worth doing only where measurements (M1, Q4) show the meshing matters.
    - **Terrain meshing** (`terrainMesh`) at load.
    - **The arena maps' prebuilt packages:** R2's remainder in `DEMO_QUALITY_ROADMAP.md`.
- [x] **D6. A DCC live link.** A Blender add-on that pushes the selected objects to an open editor tab over a local socket, extending `BLENDER_WORKFLOW.md`. **Done.**
  - **The add-on** (`tools/blender/cartbox_live_link.py`) runs a minimal WebSocket server on 127.0.0.1:9877, in plain Python with no dependencies. Its sidebar has Start link, Push selection, and Push on save. Each selected object is exported as a GLB with its transforms applied and sent under its name.
  - **The editor** connects with the Mesh tab's Live link panel (`liveLink.ts`), since a browser can connect out but not listen. Each model is imported as the Import button does it: in place of the object of its name (place, props, animator and copies kept, LODs remade), or added.
  - `BLENDER_WORKFLOW.md` has a section on it.
  - *Tests (`live-link.test.ts`, 2):*
    - a pushed model replaces the object of its name, which keeps its place, or is added beside it;
    - the add-on's server, run under Python without Blender, pushes a GLB over a real WebSocket to the editor's client, which decodes it intact.
  - *Left:* untested inside Blender here (its export calls are the documented `export_scene.gltf`); pushing materials' edits without geometry; Maya and Houdini.

### S. Simulation runtime

- [x] **S1. Caps from the budget, not the protocol.** On the `modern` and `aaa` tiers, physics bodies, rays, agents, joints and prefab copies are sized from the cart's budget, through the Modern core's direct calls. Fantasy tiers keep the RAM block. A body past any cap is reported in the editor, never dropped silently. **Done (S1a, S1b).**
  - **S1a: physics reads by query on the dedicated core: done.**
    - **Why the caps existed.** Every physics read (`cartbox.body`, `hit`, `contacts`, `inside`, `physicshash`) came from the 8 KB block at the end of RAM, which holds 64 moving bodies, 16 ray slots, 48 contact events and 64 trigger overlaps. `physicsSlots` never even created a moving body past the 64th. The Modern core already sent commands as calls (EP20b); its `_cbx_query` hook answered nil.
    - **The query path.** Six query ops (`PHYS_Q_*` in `protocol.ts`): a body's state; options and a cast for a ray or sweep; contact events and a trigger's contents, paged to fit the core's 32 numbers an answer (10 events, 30 objects a page); the state hash. `PhysicsSession.query` answers from the world as last stepped. `RuntimeChannel.query` forwards to it, `DirectConsole.setQuery` takes the handler, and the player connects them for a cart on the dedicated core.
    - **The same numbers on both kinds of core.** Query answers are quantized to the block's own precision (`asBlock`: 1/1024 for positions, velocities, times and distances; agent facings at the block word's 1/10000 rad), so a cart reads identical values on the dedicated core and on a TIC-80–derived one, and `modern-core-parity` holds with the query path live. *(Found after S1b first landed: that parity test's harness never gave the dedicated console a query handler, and with one, exact doubles made Lockout's RAM drift from the HD core's at frame 120. The harness now mirrors the player, and the answers are quantized.)*
    - **The Lua.** The runtime SDK checks for `_cbx_query` once. Where it exists, those calls read by query, with object indices back as integers and pages read in turn. Elsewhere nothing changed. The host still writes the block on the dedicated core (capped as before), so its RAM is what it was; `modern-core-parity` passes unchanged.
    - **The cap.** Moving bodies are capped by core: the block's 64 (`PHYS_MAX_BODIES`) on the TIC-80–derived cores, `DIRECT_MAX_BODIES` = 4,096 on the dedicated one. The SDK's slot table and the session take the same cap, so they agree on which bodies exist. It is a per-core ceiling, not a per-device budget: scaling it to a phone waits on M2's measurement of the step's cost.
    - **Nothing dropped silently.** The session records the bodies past its cap (`dropped`) and the player warns once in the console. The Physics panel shows, in red, how many moving bodies the scene has (prefab copies included, `bodyCapacity`), how many its core runs and how many it leaves out, and that the dedicated core runs 4,096.
  - **S1b: the rest of the runtime past the block: done.**
    - Four more query ops: an object's animation playback (clip, time, state machine state), its clip events (paged), a watched joint's world position and an agent's state. `cartbox.anim`, `state`, `events`, `joint` and `agentpos` use them on the dedicated core, where the block holds 64 animated objects, 32 events, 16 joints and 16 agents. The animation session and the crowd answer one object at a time (`playbackOf`, `eventsOf`, `agentState`), not by listing everything per query.
    - `RuntimeChannel` takes `{ direct }`: there it keeps every agent key (1,024) and up to 1,024 watched joints; on the block cores still 16 of each.
    - **Prefab pools.** A scene keeps up to 256 copies of a prefab (`MAX_PREFAB_POOL_DIRECT`). The generated SDK hands out 32 on a TIC-80–derived core and all of them on the dedicated core (`runtimeSdkLua`'s `maxPool`). The editor's copies field allows 256 only for a cart on the dedicated core.
    - *Tests (`runtime-scale.test.ts`, 4):* pools parsed to 256 and the SDK's spawn table by core; the channel's limits (17th agent and joint refused on a block core, 30 and 20 kept on the dedicated one) and its queries; on the real Modern core, 80 animated arms, 40 watched joints, 30 agents and 40 spawned copies read and made from Lua, and 32 copies where the SDK is generated for a block core.
  - *Still per core, not per device:* these ceilings are fixed. Scaling them to a phone waits on M2's measurements.
- [x] **S2. Same-frame queries.** On the Modern core, `cartbox.ray` and `cartbox.sweep` answer in the call, against the world as last stepped. **Done.**
  - On the dedicated core a ray or sweep is cast inside the call. It returns what `cartbox.hit` would (hit, object, point, normal, distance) and stores it for `cartbox.hit(slot)`, so carts written for the next-tick pattern still work. Any slot number works, not just 0–15.
  - **Before the first step.** Rapier builds the structure rays search during a step, so a cart casting on its first tick found nothing. A query before any step now refreshes it with a zero-length step (`PhysicsBackend.refreshQueries`), which moves nothing and changes no velocity in either Rapier build, checked. It runs only then, so carts on the block cores, which never query, are unchanged.
  - The TIC-80–derived cores keep the next-tick answer: their Lua can't call the host mid-tick.
- [x] **S3. Collision layers.** A layer and a mask per `PhysicsSpec` (Rapier's collision groups), with rays and sweeps taking a mask. **Done.**
  - `PhysicsSpec.layer` (0–15, absent = 0) and `mask` (a bit per layer, absent = all), kept only when not the default. Two bodies touch only when each one's mask holds the other's layer; a trigger detects only the layers in its mask; a character walks through what its mask leaves out.
  - In Rapier, `physicsGroups` gives memberships in the high 16 bits and the filter in the low. Every collider now gets its groups, because Rapier's own default puts a collider on every layer, which would let a masked ray hit an unlayered floor (found by the tests). Scenes without layers collide exactly as before: the full suite is unchanged.
  - **Rays and sweeps** take a mask as a last argument (`queryGroups`: every membership, the mask as filter), through `PHYS_OP_CAST`'s spare value on the block cores and `PHYS_Q_CAST` on the dedicated one. `cartbox.layers(0, 2)` builds a mask.
  - **The editor.** The Physics panel has a layer picker and a row of 16 toggles for the layers it collides with (or, for a trigger, detects). The SDK reference documents the mask, `cartbox.layers` and the same-frame answer.
  - **Layer names.** `PhysicsWorldSettings.layerNames` is a scene-wide list, by layer number (at most 16 names of 24 characters, control characters dropped, trailing blanks trimmed), so "Players" and "Glass" read better than 3 and 5. The Physics world panel edits them, each body's layer picker and toggles show "3 Players", and the player hands them to the cart (`physicsLayerNamesLua`), so `cartbox.layers("Players", "Glass")` takes names as well as numbers. An unknown name adds nothing, and a name used twice means its first layer.
- *Tests (S1–S3):*
  - `physics-scale.test.ts` (12): layer names read, labelled and handed to Lua, and `cartbox.layers` taking them on the real Modern core; the spec's layer and mask, kept and clamped; the groups' bit layout. On Rapier, a body passing through a plate on a layer its mask leaves out while another rests on it; a character walking through a wall its mask leaves out and stopped by one it keeps; masked rays through the block's commands. Every query: a body, a static and an unknown object, rays with and without a mask, a miss, a zero direction, a sweep, the hash against the block's. Contacts paged past 10 a step and a trigger's 40 contents in two pages; 100 bodies, 64 on a block core with 36 reported dropped, all on the dedicated core.
  - On the real Modern core with the player's SDK, 150 crates on layer 1, a trigger and a body on layer 3: a ray hits the floor on the cart's first tick, in the call, and `cartbox.hit(0)` agrees; masked rays miss and hit as their layers say; a sweep in slot 40; more than 48 contacts in one step; the 150th crate read landed; all 150 in the trigger; the layer-3 body falls through the floor.
  - `physics.test.ts` (+1): on the real Xbox 360 TIC-80 core, rays and a sweep masked by `cartbox.layers` through the block (fixed point included), and a body on its own layer falling through the floor.
- [x] **S4. Projectiles.** A projectile body with CCD, gravity, drag and an impact event; host-replicated like Lockout's grenades. G5 is its first user. **Done on the dedicated core; G5 is left to use it.**
  - **Swept, not simulated as a body.** Each tick the physics session moves every projectile: gravity (`PROJECTILE_GRAVITY` × its scale) and drag change its velocity, then its sphere is swept along the tick's travel (`shapecast`, or a ray at radius 0). Nothing thinner than a tick's travel is missed, so this is continuous collision by construction, through the backend the session already uses. A hit ends it and reports the object, point, normal and speed; it pushes a dynamic body it hit (impulse = velocity × push). Outliving its life ends it with an expiry. Its owner is passed through, and a mask limits the layers it hits (S3).
  - **Deterministic.** The flight uses only + − × ÷ and `sqrt`, which IEEE 754 rounds the same in every browser, and the sweeps go through the deterministic backend. Two runs give identical impacts.
  - **From Lua** (dedicated core; the calls answer nil and an empty list on the block cores, whose block has no room): `cartbox.fire(x, y, z, vx, vy, vz, {radius, gravity, drag, life, owner, mask, push})` → id; `cartbox.projectile(id)` → position and velocity while it flies; `cartbox.impacts()` → the last step's hits and expiries (paged, 3 per answer); `cartbox.stop(id)`. Up to 1,024 in flight. A cart draws them with `cartbox.place`, uncapped there.
  - *Not here:* replication. The engine flies a shot the same on every machine given the same fire calls; which machine fires, and how a guest predicts it, is the cart's netcode (L5–L7), and G5 is where Lockout's rockets, plasma and Fuel Rod move onto it.
  - *Tests (`projectiles.test.ts`, 7):* a horizontal shot lands where its arc says (≈61 ticks, ≈20.2 m); a 600 m/s bullet hits a 5 cm wall a per-tick check would step over; the owner and a masked layer passed through, a crate shoved; drag, expiry at its life, a stop; the cap and a shot from NaN refused; identical impacts in two deterministic worlds; and from Lua on the real Modern core, 50 shots at 400 m/s all hit a 5 cm wall, followed and read.
- [x] **S5. Joints and vehicles.** A prismatic (slider) joint beside the hinge, ball, fixed, spring and rope joints `JointSpec` already has *(corrected: this item first listed joints that exist)*; a ray-cast vehicle (Rapier's controller) with an editor preset. **Done.**
  - **The slider** (`JointKind` `"slider"`) slides along one of the object's own axes and doesn't turn: lifts, pistons, sliding doors. It has optional limits in metres either side of where it starts, and `cartbox.motor` drives it in metres a second. It is Rapier's prismatic joint on the hinge's frames. Rapier's coordinate runs from the body to what it's tied to, so the backend negates the limits and the motor's speed, and gives the motor enough gain to lift what it carries.
  - **The vehicle** (`PhysicsSpec.vehicle`, `VehicleSpec`) makes a dynamic body the chassis of Rapier's ray-cast vehicle controller.
    - Forward is the chassis's own +Z. Each wheel has a spring point, a radius, whether it steers and whether it's driven (all wheels, if none is marked). The vehicle has engine and brake forces, a steering lock, suspension length, stiffness, compression and relaxation damping, and grip.
    - Each step, the session hands the cart's inputs to the wheels, and the backend updates every awake vehicle before the world moves. A chassis asleep on its springs stays asleep.
    - Wheels are rays, not bodies. Objects under the chassis named in `visual` are drawn as them: placed at the end of their springs, steered, and rolled by the wheel's rotation, through the session's overrides.
  - **Lua:**
    - `cartbox.drive(obj, throttle, steer, brake)` (op 42) takes throttle −1..1, steer −1..1 (positive turns left) and brake 0..1, held until changed.
    - `cartbox.vehicle(obj)` returns the forward speed, and on the dedicated core also the wheels on the ground and the wheel count (`PHYS_Q_VEHICLE`, 115). Elsewhere it returns the speed from the body.
    - The deterministic build rounds the vehicle's settings and inputs like every other number.
  - **The editor:** the joint menu has Slider (axis and limits in metres). A dynamic body has a Vehicle switch with the car preset (`DEFAULT_VEHICLE`: four wheels on a 2 × 4 m chassis, front steered, rear driven) and its settings. **Add wheel objects** (`vehicleKit.ts`) puts a tyre cylinder under the chassis for each named wheel, its scale undoing the chassis's so the wheels stay round.
  - *Tests:*
    - `vehicles.test.ts` (7):
      - the slider is read with its axis and limits, holds a lift against gravity, slides it to its 3 m stop under a motor, and never turns it;
      - the vehicle is read only on a dynamic body;
      - the car rests on all four springs, at rest as its body reads too; under full throttle it sets off straight along +Z, steering left turns it toward +X, and braking stops it;
      - its wheel objects sit at their corners a radius off the floor, the front ones steer and the driven ones roll;
      - the Lua calls compile to the op and the query;
      - the preset adds four round wheels under a stretched chassis, once.
    - `physics.test.ts` adds a cart on the Xbox 360 core that drives a car and raises a sliding gate from Lua, reading the speed back.
  - *Left:* a vehicle in a prefab's reserve copies (a spawned copy is a plain body); wheel contact on the TIC-80–derived cores (the block has no room); engine curves and gears; a vehicle camera preset.

### K. Gameplay framework and scripting

- [x] **K1. Lua modules.** A cart holds several script files, loaded by `require` from the cart (not the file system), on both cores, with the replay contract unchanged. **Done.**
  - **Where they live.** The files are sections of the cart's one code text (`--#module name` … `--#end`, `luaModules.ts`), so the .tic format, the code banks, saving, remixing and replays are unchanged. Names are Lua identifiers joined by dots (`ai.patrol`), up to 64 modules.
  - **How they run.** Before the cart runs, the player (`bundleLuaModules`, first in its preparation) lifts each section into a prelude that registers it as a function and defines `require`: each module runs once, on its first `require`, with its own locals; a cycle gets `true`, as Lua's own gives; a module the cart doesn't hold is an error naming it. It is plain Lua with no `load` and no file system, so it runs the same on the TIC-80–derived cores and on the Modern core's sandbox. The sections' lines are blanked in place, so the main file's line numbers, which errors, tracebacks and breakpoints use, don't move.
  - **The editor.** The code tab has a Files list for a Lua cart: All code (the line numbers errors and breakpoints use) and each module, edited on its own, with + Module and remove. An error jump switches back to All code.
  - *Tests (`lua-modules.test.ts`, 7):*
    - the split finds the modules and keeps the main file's line numbers; it reports an unclosed section, a repeated name and a bad one; code without modules runs as written;
    - the editor's list, read, write, add and remove leave the rest of the code untouched;
    - on the Modern core, each module loads once with its own locals (a module requiring another included); a missing module is named, and an error in the main file keeps its line below the prelude;
    - on the Xbox 360 core the same cart gives the same answers.
  - *Left:* an error inside a module reports a prelude line, not the module's own (K2's go-to-definition can map it back); a .tic exported for stock TIC-80 still carries the sections as plain code.
- [x] **K2. A language service.** Completion of `cartbox.*` from `sdkReference.ts`, locals and module members; diagnostics from a Lua parser (undefined globals, arity of SDK calls); go to definition across modules. **Done, from tokens rather than a full parser.**
  - `luaLanguage.ts` reads the code's tokens outside comments and strings (K3's line tokenizer).
    - `local` and parameters declare names. A name assigned at a statement's start, or named by `function`, is a global the cart defines.
    - `local m = require("x")` binds `m` to K1's module `x`, whose `function M.f` and `M.f =` (on the table it returns) are its members.
    - Scopes are not tracked: a local anywhere in the code counts throughout it, which errs toward silence.
  - **Diagnostics:**
    - K1's module problems, and a `require` of a module the cart doesn't hold (errors);
    - a name used but declared nowhere, and not a Lua or TIC-80 built-in (a warning, usually a typo); fields, table keys and strings are skipped;
    - an SDK call given more arguments than its signature in `sdkReference.ts` takes.
  - **Completion:** after `cartbox.`, the SDK with signatures; after a required module's name and a dot, its members; elsewhere the locals, globals, built-ins and keywords that match.
  - **Go to definition:** a member through its module's name, a module from its `require`, a local or a global.
  - **The code tab:** a Problems list (click to jump), Ctrl+Space for suggestions, and F12 to go to the definition, from a module's own view too.
  - *Tests (`lua-language.test.ts`, 6):*
    - an undefined global is flagged, but nothing declared, built in, a field or in a string;
    - an SDK call with too many arguments is flagged with the right count, and so are a missing module and an unclosed module;
    - the SDK completes after `cartbox.` with its signature; a required module's members and the matching names in scope complete;
    - definitions are found for a member in another module, a module from its require, a local function and a global.
  - *Left:* a real parser (scopes, shadowing, the type of a value), arity for calls to the cart's own functions, and an error in a module mapped to its own line.
- [x] **K3. Incremental highlighting.** A tokeniser that carries line-start state, so long strings and block comments stay correct while only changed lines re-tokenise. **Done.**
  - `tokenizeLine(line, state)` starts a line in a state: nothing, or a block comment, long string or quoted string still open with the text that closes it. It returns the tokens and the state the next line starts in.
  - `LineTokenCache.update(source)` keeps the lines, their start states and their tokens. It re-tokenises from the first changed line, and stops at the first unchanged line past the edit whose start state is the one it had.
  - The code tab renders from it: a keystroke costs its line, and opening or closing a block comment costs the lines it reaches.
  - It also removes the whole-document tokenizer's slice of the rest of the text at every character, which was quadratic in the code's length.
  - *Tests (`incremental-highlight.test.ts`, 5):*
    - every character is coloured as the whole-document tokenizer colours it: a sample with block comments, long strings and escaped quotes, 300 random Lua fragments, and a C-style language;
    - in a 2,000-line document, typing on a line re-tokenises 1 line;
    - opening a block comment re-tokenises the 1,900 lines it swallows, typing inside it 1, and pasting an open-and-close pair 11;
    - lines added and removed come out right.
- [x] **K4. Behaviour trees and a blackboard.** Authored in the graph editor, run per agent from a component, deterministic, with a debugger view of the running node. G2's bots are its first user. **Done, authored in an outline rather than the graph editor; G2's bots aren't moved onto it.**
  - **The model** (`behaviourTree.ts`), stored in the mesh sidecar's `behaviours` and read defensively (unknown types, repeated ids, oversized trees dropped):
    - composites: `sequence`, which keeps its place while a child runs; `selector`, which is reactive (it tries its children in priority order every tick, so a branch whose condition comes true takes over and the one that was running is reset); `parallel` with a `need`;
    - decorators: `inverter`, `succeeder`, `repeat` (a count, or forever), `cooldown`;
    - leaves: `wait`, `condition` (a blackboard key against a value), `set`, and `action` (a function the cart registers).
  - **The runtime** is Lua the player puts ahead of the cart's code. `cartbox.bt.new(tree, agent)` gives an instance with its own blackboard, `cartbox.bt.tick(instance, dt)` runs a step, and `cartbox.bt.action(name, fn)` registers an action. Time is the `dt` the cart passes, and there is no randomness, so a tree decides the same on every machine and in every replay. It runs from a component's `update` as from anywhere.
  - **The debugger view:** `cartbox.bt.running(instance)` returns the running node's path, root to leaf. `cartbox.bt.watch(instance)` traces it to the editor's console each time it changes.
  - **The editor:** a Behaviour trees panel in the Mesh tab edits each tree as an outline. You can add a child of any type, edit a node's label, key, test, value, seconds, count or need, remove it, and add or delete trees.
  - *Tests (`behaviour-trees.test.ts`, 6, on the Modern core):*
    - the reader keeps what's valid; trees round-trip through the sidecar and the player's scene; edits find nodes at any depth with fresh ids;
    - a guard patrols (walk, a 0.5 s rest, a marked lap on tick 7) and takes over to chase the moment it sees a target, the patrol stopping;
    - a repeat counts its taps and a cooldown gates the fire to at most once each 0.5 s;
    - two runs decide identically, and the console shows `root > patrol > walk`, then `rest`, then `root > chase > run at it`.
  - *Left:* authoring on the graph editor's canvas; a live highlight of the running node in the panel (the console carries it today); G2's bots moved onto trees; K5's perception writing the blackboard.
- [x] **K5. Perception.** Sight cones with line of sight (S2's rays), hearing from sound events, memory with decay, feeding K4's blackboard. **Done.**
  - `perception.ts`: Lua the player puts in when a cart has behaviour trees or names `cartbox.sense`.
    - `cartbox.sense.new{fov, range, hearing, memory}` makes a perceiver.
    - `cartbox.sense.look(p, eye, facing, candidates)` sees what's inside the cone and in range with a line of sight. That is S2's same-frame ray on the dedicated core (visible when the ray reaches it or hits nothing), or a `los` function the cart gives.
    - `cartbox.sense.noise(x, y, z, loudness, source)` makes a sound each perceiver hears once, within loudness × hearing metres.
    - `cartbox.sense.update(p, dt, position, blackboard)` ages and forgets memories, and writes `target`, `target_x/y/z`, `target_seen`, `target_age` and `alert` (1 when sensed, fading over the memory) into a K4 blackboard.
  - It is in order and uses only the cart's inputs, so a replay perceives the same.
  - *Tests (`perception.test.ts`, 4, on the Modern core):*
    - it is put in only when needed;
    - of five candidates, only the one in the cone, in range and not behind a wall is seen;
    - a noise within its loudness is heard (the far one isn't), its alert fades to half at half the memory, and it's forgotten after;
    - a K4 guard idles, searches when it hears a noise behind it, and chases once it sees the intruder.
  - *Left:* line of sight on the TIC-80–derived cores (their rays answer a tick late, so it defaults to clear there); sound events raised by the mixer's own playback (U3) rather than by the cart.
- [x] **K6. Damage, abilities and tags.** Health and shield components, damage events with type and hit zone, multi-shape hitboxes on skeletons, cooldown-and-cost abilities, and gameplay tags to gate them. **Done.**
  - `gameplay.ts` is Lua the player puts in when the cart names any of it.
  - **Tags** (`cartbox.tags`) are hierarchical by dots, so `state.stunned` counts as `state`, and reference-counted.
  - **Health and damage:** `cartbox.health.new{max, shield, shieldDelay, shieldRate, resist, zones}` and `cartbox.damage(target, amount, {type, zone, source})`.
    - Resistance applies by damage type, and a multiplier by hit zone.
    - The shield takes damage first and recharges after a delay without hits; `true` damage skips it.
    - Each hit queues `hit`, `shield_broken` and `death` events for `cartbox.damage.events()`. The dead take nothing.
  - **Hitboxes:** spheres and capsules placed on a skeleton's joints, from the positions the cart reads with `cartbox.joint`. `cartbox.hitbox.ray` returns the nearest zone a shot hits, its distance and its multiplier; on a tie, the earlier shape (list the head first) wins.
  - **Abilities:** `cartbox.ability.try` checks the cooldown, the owner's resources, all of `requires` and none of `blocked`. It then pays, starts the cooldown and grants its tags for its duration, and `update` runs the clocks.
  - *Tests (`gameplay.test.ts`, 6, on the Modern core):*
    - it is put in only when named;
    - tags match by hierarchy;
    - damage goes through the shield first and is scaled by type and zone; the target dies once and the five events come in order;
    - the shield waits out its delay, then recharges;
    - on a skeleton, a head-height shot hits the head at ×2, a chest shot the body capsule, and one overhead misses;
    - a dash is gated by its cooldown, its energy cost and a stun tag, and grants `state.dashing` for 0.3 s.
  - *Left:* hitbox shapes authored on the skeleton in the editor; replicating health over the netcode (N1); Lockout moved onto it.

### U. Audio

- [x] **U1. Reverb zones.** Convolution reverb per volume, with impulse responses imported or generated from the volume's size and materials, blended at the edges. **Done for generated responses; importing one is left.**
  - `SceneAudio.reverbZones` holds boxes, each with a decay, damping, wet level and edge fade. Each gets a ConvolverNode fed by every bus's send (`SoundBus.reverb`).
  - Its stereo impulse response is generated (`reverbImpulse`): seeded noise decaying to −60 dB at the decay, with its highs damped faster as the tail ages.
  - The editor's "from size" sets the decay by Sabine's formula from the box and its damping.
  - Each frame the listener's place sets each zone's send (`reverbSends`): full inside, fading across the edge, and overlapping zones crossfading.
- [x] **U2. Occlusion and obstruction.** Rays from listener to emitter set a low-pass and gain, smoothed over time. **Done (occlusion; obstruction, a partial path round the wall, is left).**
  - With `SceneAudio.occlusion` on, each positional sound gets a low-pass and a gain before its panner.
  - Each frame the player tests the line from the camera to the sound with the physics world's ray (`PhysicsSession.lineBlocked`), eases toward it (`smoothToward`), and maps it to a cutoff and gain (`occlusionFilter`, from open to 500 Hz and −12 dB behind a wall).
- [x] **U3. A mixer.** Buses with sends, sidechain ducking (dialogue over music), snapshots blended by gameplay state, and a limiter on the master. **Done.**
  - **Routing:** buses route into a parent (loops refused) and send to the reverb.
  - **Ducking:** a bus can be ducked by another while anything plays on it, eased in over its attack and out over its release (`duckGain`).
  - **Snapshots:** saved bus volumes, blended to with `cartbox.snapshot(name, seconds)`; buses a snapshot doesn't name keep their level.
  - **Limiter:** a DynamicsCompressor at the master's end (−1 dB by default).
- [x] **U4. Streamed, adaptive music.** Long tracks stream rather than decode whole; layers and stingers switch on beat from cart calls. **Done.**
  - `SceneAudio.music` tracks have a tempo, beats to a bar, and layers (looping sounds started together).
  - `cartbox.music(track)` starts one with its first layer up.
  - `cartbox.layer(track, n, on)` brings a layer in or out on the next bar.
  - `cartbox.stinger(sound)` plays on the next beat (`nextBeat`).
  - A file sound marked `stream` plays through a media element as it loads, not decoded whole; it falls back to decoding where the page can't stream.
- [x] **U5. Sound variation.** Containers with random, sequence and switch choices, pitch and volume randomisation, and per-surface footstep and impact sets from physics materials. **Done; surfaces come from a cart-set switch rather than from physics materials.**
  - A sound's `variation` picks among it and its variants:
    - `random`, never the same twice running;
    - `sequence`;
    - `switch`, which plays the case for a switch's value (`cartbox.switch("surface", "metal")`).
  - Each play spreads pitch and volume by its ± amounts, from a seeded generator, so a replay sounds the same.
- *U1–U5 together:*
  - **The editor:** an Audio track panel beside Sounds covers each bus's parent and duck, saving snapshots, the limiter, reverb zones (with "from size"), occlusion, music tracks and their layers, and each sound's variation and streaming.
  - **Lua:** `cartbox.snapshot`, `music`, `layer`, `stinger` and `switch` go out as op 43, names resolved in Lua.
  - *Tests (`audio-track.test.ts`, 12):*
    - **Reading:** the reader keeps routing, ducks, snapshots, zones, music and variation, and drops names that point at nothing and parent loops.
    - **Pure parts:**
      - Sabine's decay orders a hall over a room and stone over curtains;
      - the impulse falls more than 40 dB by its decay, is seeded, and has a channel each;
      - zones fade at their edges and crossfade where they overlap;
      - a wall gives 500 Hz and −12 dB;
      - a duck reaches 0.3 and releases slowly;
      - a snapshot blends only its buses;
      - changes land on the beat and on the bar;
      - variants never repeat, run in sequence, and follow a switch.
    - **The sound system** (on a stand-in context with filters, convolvers and a compressor):
      - buses route into their parents and through the limiter;
      - the hall's send follows the listener in and out;
      - music ducks to 0.3 under a line, and a snapshot blends over its time;
      - a sound behind a wall is muffled and one in the open isn't;
      - variants don't repeat and the switch's case plays;
      - a track's layers start together, a layer comes in on the bar, and a stinger lands on the beat.
    - **The real engine:** a cart's five calls arrive as the right commands. The existing sound suites pass unchanged.
  - *Left:* importing an impulse response; obstruction (sound bending round a corner); surfaces read from physics materials; the music's tempo map beyond one fixed tempo.

### N. Networking

- [x] **N1. Entity replication.** Any object can be marked replicated, with priority, relevancy by distance and delta compression, beyond the 4 words per player. **Done.**
  - **Marking:** an object marked replicated (the Physics panel's checkbox, with a priority) has its pose sent by the host to every other player. Guests draw it there over everything else.
  - **What's sent** (`net/replication.ts`): position to 1/256 m and rotation as a quaternion to 1/16384, quantized so both ends compare integers.
  - **Priority and relevancy:** each send, an entity's score grows by its priority times its relevance to the nearest player's camera (each guest reports its own; 1 within `near`, 0 beyond `far`, and never sent past it). The highest scores fill the packet's byte budget, so the rest catch up over the next sends.
  - **Delta compression:**
    - Guests ack the newest packet and a bit for each of the 32 before it.
    - The host deltas each entity against the newest packet that carried it and that every guest got, sending only the changed fields. An entity unchanged since then costs nothing.
    - Loss costs size, never correctness.
  - **Transport:** it rides the session's messages (`x` and `xa`), the binary codec's spare flag, and the direct links' unreliable state channel.
  - *Tests (`replication.test.ts`, 6):*
    - two guests converge on the host's poses to the quantization's precision;
    - a still scene of 40 sends nothing, and one moved crate sends one field, 40× smaller than the full packet;
    - 200 ticks of 30% loss (different for each guest) and late packets end with both guests exact;
    - priority and nearness order a tight budget, out-of-range entities are never sent, and the far ones get their turns;
    - it rides two real sessions over the memory hub, and the codec round-trips it;
    - the flag survives the sidecar and the player's scene.
  - *Left:* interpolation between replicated poses on guests (they snap to each packet, which is smooth at 30 Hz over direct links but not over the relay); replicating values other than poses.
- [ ] **N2. A headless authoritative host.** The cart runs headless (the verification worker already does) as a room's host, so no player is the authority. **The session side is done; running it on a server is left.**
  - A peer whose presence name starts `dedicated:` (`DEDICATED_HOST_NAME`) is the room's host wherever it joins, and takes slot 0 in a room it opens.
  - It holds a slot but isn't counted among the players (the inbox's humans mask).
  - The cart is told: bit 3 of the host word, read in Lua as `cartbox.net()`'s seventh value (`local mode, slot, humans, match, status, hostslot, dedicated = cartbox.net()`), so the cart can leave it out of the match. The SDK reference documents all seven.
  - *Tests (`dedicated-host.test.ts`, 3):*
    - a dedicated host joining after two players is host for all three once their rosters settle; the cart sees it flagged and not counted;
    - without one, the lowest slot hosts as before;
    - on the real Modern core, a cart's `cartbox.net()` reports the host's slot and whether it is dedicated.
  - *Blocked here:* a server process to run the cart headless on the relay's realtime channel (a hosted service, and its credentials). Lockout playing no soldier of its own when it is that host waits on it, since a match against a headless host can only be checked with one running.
- [x] **N3. Lag compensation.** The host rewinds hitboxes to the shooter's view time for hit tests, bounded by a maximum. **Done, as part of K6's runtime.**
  - `cartbox.rewind.new{max}` keeps each target's joint positions as the host records them each tick (`record`).
  - `cartbox.rewind.ray(history, targets, t, now, shot)` places each target's K6 hitboxes where they were at the shooter's view time t, interpolated between ticks and clamped to `max` seconds back, and returns the nearest target, zone, distance and multiplier.
  - The shooter's view time is its shot's stamp less its view lag, both of which the net inbox already carries (L4).
  - *Test (in `gameplay.test.ts`, on the Modern core):* a target running at 10 m/s is missed where it is now but hit where the shooter saw it 0.07 s ago, and a shooter claiming 0.4 s gets the 0.2 s maximum.
  - *Left:* moving Lockout's own L6 compensation onto it.

### W. Team workflow

- [x] **W1. Delta undo.** Undo records the changed sidecars and engine banks, not the whole cart, with no fixed count but a memory budget. **Done.**
  - `DeltaHistory` keeps the present whole and every other step as a patch, with the same interface as EditHistory: record, undo, redo, a fork dropping redo.
  - The editor's codec (`historyDelta.ts`) makes a cart's patch from the runs of its .tic bytes that changed (runs closer than 16 bytes merged) and the sidecars that changed. Sidecar values are immutable, so an unchanged one is the same object and costs nothing. Each value's size is measured once.
  - `useEditorHistory` holds a 48 MB budget instead of 60 whole snapshots. Steps are forgotten oldest first only past it, so there is no fixed count.
  - *Tests (`delta-history.test.ts`, 4):*
    - byte patches round-trip any change, a change of length included;
    - a walk of undos and redos through 20 edits gives exactly what whole snapshots gave, and an edit after undoing forks the future;
    - 200 small edits of a 300 KB cart keep all 201 steps in under 40 KB (whole snapshots: 60 MB), and undo all the way back exactly;
    - a 10 KB budget forgets the oldest steps and still undoes what it holds;
    - a sidecar edit costs that sidecar only.
  - `cart-snapshot.test.ts` passes unchanged.
- [x] **W2. Co-editing.** Presence and live edits of the scene and sidecars between editors of one cart (a CRDT over the existing realtime channel), with locks for binary assets. **Done for the sidecars, in the editor, over the hosted channel (or this browser's tabs). The .tic's banks don't travel yet, and the hosted channel is untried against the live service.**
  - **The data:** the sidecars are split into objects as W3 splits them: each sidecar, each placed scene object, the scene's settings and its object order. Each object is a last-writer-wins register stamped with a Lamport clock and the writer's id, so every editor settles on the same cart whatever order edits arrive in. Edits to different objects all survive; for the same object, the later edit wins everywhere.
  - **Joining:** a newcomer's hello is answered with every register, and merging is idempotent.
  - **Presence:** a name and a selection, gone after a silence.
  - **Locks** for binary assets are registers too, so two who grab one at once agree on the holder.
  - **Transports:** any broadcast channel, with a BroadcastChannel transport for tabs of one browser.
  - **The hosted channel** (`coEditRealtime.ts`): one Supabase Realtime broadcast channel per cart (`cartbox-coedit:<cart>`), the service netplay's rooms already use, so co-editing needs no server code. A scene object with its geometry, or a newcomer's catch-up, can be far larger than a broadcast may carry, so each message travels in parts of 100,000 characters, put back together in any order at the far end; a repeated part counts once, a malformed one is ignored, and a message whose parts stop coming is dropped after 30 s. What is said before the channel opens (the session's hello) waits for it. Without Supabase (the static demo build) it falls back to the tabs of one browser.
  - **In the editor** (`useCoEdit`, `CoEditPanel`): File ▸ Edit together… turns it on, takes a name (kept in this browser) and lists who else is editing and what they have selected. The session keeps running with the dialog closed. Every local change to a sidecar goes out as the objects it changed; someone else's edit lands layer by layer through the history's own `setSidecar`, so a burst of them is one undo step, and only the layers that differ are set (a scene rebuilt from its objects is compared parsed, so a reordering of its fields isn't a change). A merged change comes back as no ops, so nothing echoes.
  - *Limits:* changes travel from when it's on: what each editor did before stays theirs until saved (the shared start has no stamp, so turning it on never overwrites anyone's work). The code and the sprite, map and sound banks (the .tic) don't travel yet; one person edits those at a time. Undo undoes a remote edit too, as a step on the timeline. The hosted path is tested against a fake Realtime hub, not the live service.
  - *Tests (`co-edit-wiring.test.ts`, 7):* parts put back together in any order, repeats and malformed parts ignored, a stalled message dropped, a small message sent whole; over a fake Realtime hub, a newcomer caught up on a 300 KB object (in parts) and edits carried both ways, another cart's channel hearing nothing, and what's sent before the channel opens held until it does; the editor applying only the layers that differ (a reordered scene isn't one); and two editors applying each other's merges settling on the same cart with no echo.
  - *Tests (`co-edit.test.ts`, 6):*
    - sidecars round-trip through the object split, order kept;
    - three editors' concurrent edits to different objects all survive, a contested object settles identically everywhere, and the result is the same with delivery reversed;
    - additions, deletions and other sidecars travel, and the editor hears of others' edits;
    - a newcomer is brought up to date;
    - presence shows a selection and expires;
    - a lock grabbed by two at once ends with one agreed holder, and frees on unlock.
  - *Blocked here:* the hosted realtime channel (a service to configure), and the editor's own sidecar flow driving `edit` and taking `apply` (with presence drawn in the viewport).
- [x] **W3. Branches.** Snapshots become branches that can be compared and merged per object. **Done.**
  - **Objects** (`cartBranches.ts`):
    - each .tic chunk (code, sprites, map… per bank);
    - each sidecar, with the mesh sidecar split into each placed object by its id plus the rest of the scene as one;
    - the details and the console model.
  - **Compare:** `compareBranches` lists each object added, removed or changed.
  - **Merge:** `mergeBranches(base, ours, theirs, choose)` is three-way against a common ancestor.
    - An object only one side changed takes that side; one both changed the same way takes it; one both changed differently is a conflict the caller resolves.
    - Without an ancestor, every difference is the caller's.
    - The .tic is rebuilt from the chosen chunks. The scene keeps ours' object order with theirs' additions, and the union of both mesh libraries, so a taken object finds its meshes.
  - **The editor:** each snapshot has Merge…. It lists the differences with a tick for "take it from the snapshot". With a common ancestor picked, one-sided changes merge by themselves and only conflicts are left to tick. The cart is snapshotted first, so a merge can be undone.
  - *Tests (`cart-branches.test.ts`, 3):*
    - differences are listed per object (code, one moved crate, an added lamp);
    - a three-way merge keeps our door and code and their crate, lamp, sprite and library;
    - a crate both moved is one conflict, resolved either way;
    - without an ancestor every difference is a choice, a deletion included.
  - *Left:* named branch lines (a snapshot's parent recorded, so the ancestor is found rather than picked); merging inside one scene object (its transform from one side, its material from the other).

### Z. Reference content

- [ ] **Z1. A reference set through the pipeline.** A character (rigged, animated, faced), a hero prop, a terrain set with full PBR maps and a foliage set, each made in DCC tools and brought in through D1–D5, then measured on Q2's budgets. It proves the pipeline and separates renderer faults from content faults.

## Order

1. **Q1, then Q2.** Nothing else can be judged until the shaders run in CI and the budgets exist.
2. **M3, then M1 on R1's hardware.** No first-use hitches, and the frame's cost known. M2 waits for S1.
3. **S1, S2, S3.** The runtime's structural limits go, before frameworks are built on them.
4. **D1, D2, D3, D4.** Content can come in.
5. **K1, K2, K3**, then **K6, S4, K4, K5.** Scripts scale, then the framework.
6. **U1–U5.**
7. **D5, Z1, Q3.**
8. **N1–N3, W1–W3.**

## Open questions

- **Is a headless authoritative host (N2) in scope?** It needs servers to run, which the platform does not have today.
- **Co-editing (W2) and the realtime service's limits.** The relay's message rate shaped netplay (7.5–15 Hz); co-editing may need its own channel.
- **Lua forever?** K1–K3 make Lua scale. A typed language (TypeScript to Lua, or Luau's types) would scale further, at the cost of a compiler in the editor.
