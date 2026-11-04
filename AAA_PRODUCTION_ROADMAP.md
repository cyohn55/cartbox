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
  - *Tests (`gpu-test-runner.test.ts`, 13):* the import detection (dynamic with and without vite's comment, template strings, static and multi-line imports; not comments, plain strings, similar package names or other paths); discovery (nested, sorted, relative, `.test.ts` only, and this repository's 60-odd suites with the parity suite); the report check (a clean run; skip, todo and failure named; a file that died before its tests; no tests; an unreported file, and not under a shard; no report at all); the shard flag in both spellings; the probe naming its adapter and destroying the device, and saying what to install for a missing package or adapter.
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
- [x] **M3. Async pipelines and a warm-up.** Every `createRenderPipeline`/`createComputePipeline` goes through one cache with `create*PipelineAsync`, and a scene's pipelines are compiled behind the loading screen. Completes R5. **Done; R5's shipped manifests and hardware check are left.**
  - **One cache per device** (`render/pipelineCache.ts`). All 47 pipeline sites in 21 files go through `pipelineCache(device).render/compute`, memoized by descriptor (shader modules and layouts by identity, everything else by value, labels ignored), with `renderAsync/computeAsync` compiling off the frame where the device can. The device is shared per page (`getWebgpuDevice`), so a renderer made again (resize, quality change, the editor's viewport beside a play view) compiles nothing twice.
  - **One shader module per WGSL source, one layout per descriptor.** The 40 `createShaderModule` sites and the 37 bind group and pipeline layout sites go through `shaderModule`, `bindGroupLayout` and `pipelineLayout`, which make equal ones once (equal layouts are interchangeable in WebGPU) and remember what made them. So the same pipeline asked for twice has the same key, and every pipeline can be written down.
  - **A recorded warm-up**, as engines keep a recorded pipeline-state cache: each pipeline a renderer asks for becomes a recipe (its descriptor with WGSL for modules and descriptors for layouts). The renderer saves the manifest of what it asked for after its first frame, and again after any late compile (`PipelineManifestStore`, localStorage, each WGSL source stored once, at most 512 recipes, recipes not asked for again dropping out). `createSceneRenderer` compiles the stored manifest asynchronously before building the renderer, waiting at most 3 s behind the loading screen.
  - **Counted.** A synchronous compile after the first frame is *late*, a likely hitch. Render stats carry `pipelines` (compiled, compiled off the frame, reused, late, pending), and the playtest profiler shows them, warning on late ones.
  - *Measured on Dawn* (`pipeline-cache.test.ts`): a session renders two plain frames, then adds a see-through box and turns MSAA on, so 7 of its 24 pipelines compile late. A fresh device warmed from that session's manifest compiles all 24 off the frame and **none late**, and draws the same three frames bit for bit. Before layouts were recorded only 5 of the 24 could be, and 5 were still late; that is why layouts go through the cache.
  - *Left:* the very first load on a browser has no manifest, so it still compiles as it meets things. R5's fix for its maps is a manifest recorded from a scripted match and shipped with each map's package (R2), plus its hardware acceptance (no frame over 50 ms, R1). Pipelines whose layout is taken off an "auto" pipeline (2 sites) can't be recorded.
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
- [ ] **D2. Angle-preserving unwrap with seams.** LSCM over user-marked seams (with automatic seams from curvature as a default), keeping `uvUnwrap.ts`'s box projection as an option, and the same packer.
- [ ] **D3. GPU texture formats on import.** Imported maps (glTF, FBX, CC0 libraries) transcode to KTX2 on import, not only on save.
- [ ] **D4. Sidecars as packages.** The mesh sidecar routes store `.cbpk` (F9e's format and upload path), with JSON kept as a read path for old carts.
- [ ] **D5. A build-time cook.** A cart's sidecars become content-hashed packages at publish, so a player never synthesises content. Generalises R2 from the two arena maps to every cart.
- [ ] **D6. A DCC live link.** A Blender add-on that pushes the selected objects to an open editor tab over a local socket, extending `BLENDER_WORKFLOW.md`.

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
  - *Left:* names for the layers (a scene-wide list, so "Players" and "Glass" read better than 3 and 5).
- *Tests (S1–S3):*
  - `physics-scale.test.ts` (9): the spec's layer and mask, kept and clamped; the groups' bit layout. On Rapier, a body passing through a plate on a layer its mask leaves out while another rests on it; a character walking through a wall its mask leaves out and stopped by one it keeps; masked rays through the block's commands. Every query: a body, a static and an unknown object, rays with and without a mask, a miss, a zero direction, a sweep, the hash against the block's. Contacts paged past 10 a step and a trigger's 40 contents in two pages; 100 bodies, 64 on a block core with 36 reported dropped, all on the dedicated core.
  - On the real Modern core with the player's SDK, 150 crates on layer 1, a trigger and a body on layer 3: a ray hits the floor on the cart's first tick, in the call, and `cartbox.hit(0)` agrees; masked rays miss and hit as their layers say; a sweep in slot 40; more than 48 contacts in one step; the 150th crate read landed; all 150 in the trigger; the layer-3 body falls through the floor.
  - `physics.test.ts` (+1): on the real Xbox 360 TIC-80 core, rays and a sweep masked by `cartbox.layers` through the block (fixed point included), and a body on its own layer falling through the floor.
- [x] **S4. Projectiles.** A projectile body with CCD, gravity, drag and an impact event; host-replicated like Lockout's grenades. G5 is its first user. **Done on the dedicated core; G5 is left to use it.**
  - **Swept, not simulated as a body.** Each tick the physics session moves every projectile: gravity (`PROJECTILE_GRAVITY` × its scale) and drag change its velocity, then its sphere is swept along the tick's travel (`shapecast`, or a ray at radius 0). Nothing thinner than a tick's travel is missed, so this is continuous collision by construction, through the backend the session already uses. A hit ends it and reports the object, point, normal and speed; it pushes a dynamic body it hit (impulse = velocity × push). Outliving its life ends it with an expiry. Its owner is passed through, and a mask limits the layers it hits (S3).
  - **Deterministic.** The flight uses only + − × ÷ and `sqrt`, which IEEE 754 rounds the same in every browser, and the sweeps go through the deterministic backend. Two runs give identical impacts.
  - **From Lua** (dedicated core; the calls answer nil and an empty list on the block cores, whose block has no room): `cartbox.fire(x, y, z, vx, vy, vz, {radius, gravity, drag, life, owner, mask, push})` → id; `cartbox.projectile(id)` → position and velocity while it flies; `cartbox.impacts()` → the last step's hits and expiries (paged, 3 per answer); `cartbox.stop(id)`. Up to 1,024 in flight. A cart draws them with `cartbox.place`, uncapped there.
  - *Not here:* replication. The engine flies a shot the same on every machine given the same fire calls; which machine fires, and how a guest predicts it, is the cart's netcode (L5–L7), and G5 is where Lockout's rockets, plasma and Fuel Rod move onto it.
  - *Tests (`projectiles.test.ts`, 7):* a horizontal shot lands where its arc says (≈61 ticks, ≈20.2 m); a 600 m/s bullet hits a 5 cm wall a per-tick check would step over; the owner and a masked layer passed through, a crate shoved; drag, expiry at its life, a stop; the cap and a shot from NaN refused; identical impacts in two deterministic worlds; and from Lua on the real Modern core, 50 shots at 400 m/s all hit a 5 cm wall, followed and read.
- [ ] **S5. Joints and vehicles.** A prismatic (slider) joint beside the hinge, ball, fixed, spring and rope joints `JointSpec` already has *(corrected: this item first listed joints that exist)*; a ray-cast vehicle (Rapier's controller) with an editor preset.

### K. Gameplay framework and scripting

- [ ] **K1. Lua modules.** A cart holds several script files, loaded by `require` from the cart (not the file system), on both cores, with the replay contract unchanged.
- [ ] **K2. A language service.** Completion of `cartbox.*` from `sdkReference.ts`, locals and module members; diagnostics from a Lua parser (undefined globals, arity of SDK calls); go to definition across modules.
- [ ] **K3. Incremental highlighting.** A tokeniser that carries line-start state, so long strings and block comments stay correct while only changed lines re-tokenise.
- [ ] **K4. Behaviour trees and a blackboard.** Authored in the graph editor, run per agent from a component, deterministic, with a debugger view of the running node. G2's bots are its first user.
- [ ] **K5. Perception.** Sight cones with line of sight (S2's rays), hearing from sound events, memory with decay, feeding K4's blackboard.
- [ ] **K6. Damage, abilities and tags.** Health and shield components, damage events with type and hit zone, multi-shape hitboxes on skeletons, cooldown-and-cost abilities, and gameplay tags to gate them.

### U. Audio

- [ ] **U1. Reverb zones.** Convolution reverb per volume, with impulse responses imported or generated from the volume's size and materials, blended at the edges.
- [ ] **U2. Occlusion and obstruction.** Rays from listener to emitter set a low-pass and gain, smoothed over time.
- [ ] **U3. A mixer.** Buses with sends, sidechain ducking (dialogue over music), snapshots blended by gameplay state, and a limiter on the master.
- [ ] **U4. Streamed, adaptive music.** Long tracks stream rather than decode whole; layers and stingers switch on beat from cart calls.
- [ ] **U5. Sound variation.** Containers with random, sequence and switch choices, pitch and volume randomisation, and per-surface footstep and impact sets from physics materials.

### N. Networking

- [ ] **N1. Entity replication.** Any object can be marked replicated, with priority, relevancy by distance and delta compression, beyond the 4 words per player.
- [ ] **N2. A headless authoritative host.** The cart runs headless (the verification worker already does) as a room's host, so no player is the authority.
- [ ] **N3. Lag compensation.** The host rewinds hitboxes to the shooter's view time for hit tests, bounded by a maximum.

### W. Team workflow

- [ ] **W1. Delta undo.** Undo records the changed sidecars and engine banks, not the whole cart, with no fixed count but a memory budget.
- [ ] **W2. Co-editing.** Presence and live edits of the scene and sidecars between editors of one cart (a CRDT over the existing realtime channel), with locks for binary assets.
- [ ] **W3. Branches.** Snapshots become branches that can be compared and merged per object.

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
