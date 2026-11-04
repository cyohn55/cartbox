# AAA Production Roadmap: beyond the renderer

## Goal

`AAA_FIDELITY_ROADMAP.md` gave Cartbox a renderer with a current-generation feature list: virtual shadow maps, probe GI and SSGI, HDR TAA with upscaling, volumetrics, GPU culling, GPU skinning, a path-traced reference. Its tracks F0–F10 are checked off, and spot checks of the code (`virtualShadows.ts`, `motionMatching.ts`) find real implementations, not stubs.

The editor still cannot make an AAA game. The captures in `captures/f11a` and `captures/demo-quality` show block-built characters, cone trees and stretched 128² textures under that renderer. The limits now sit **outside the renderer**:

- nothing the renderer does has been verified on a GPU in CI, or measured on hardware;
- the main thread's frame budget is spent before gameplay runs;
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
| Main thread | ~14.5 ms of renderer JS per frame on Beaver Creek (F0e); physics, navigation and Lua on the same thread; two workers, both decoders | Simulation, render submission and streaming on separate threads; < 4 ms render JS | M |
| Pipelines | 43 synchronous `create*Pipeline` sites | Async compilation, a warm-up, no first-use hitches | M (with R5) |
| Modelling | Box modelling: loop cut, subdivide, mirror, extrude/inset/bevel; sculpting only on voxel and hexel lattices | DCC round-trip; sculpt and retopo stay in DCC tools | D |
| UVs | `uvUnwrap.ts` projects each face on its dominant axis | Angle-preserving unwrap (LSCM/ABF) with user seams | D |
| Import | FBX: geometry, first UV set and diffuse colour (no skin, animation or textures); USD in 213 lines; KTX2 on import open | Rigged, animated, textured FBX and glTF; USD stages; GPU formats on import | D |
| Storage | `.cbpk` packages built (F9e) but mesh sidecars still save as base64 JSON; maps synthesised in the browser (R2 open) | A build-time cook to content-hashed packages | D |
| Simulation caps | 64 dynamic bodies (bodies past it silently dropped, `physicsSession.ts:309`), 16 rays, 16 nav agents, 16 joints, 32 prefab copies, on every core | Thousands of bodies; caps set by budget, not protocol | S |
| Queries | Rays and sweeps answer on the next tick | Same-frame scene queries | S |
| Physics features | No CCD, no collision layers in `PhysicsSpec`, revolute joints only, no vehicles | CCD projectiles, filter masks, joint set, vehicles | S |
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
- [ ] **Q3. Reference-image regression.** Fixed views of Lockout, Beaver Creek, the look-dev stage and the ruin scene, rendered on Q1's device and compared against stored references with a perceptual metric (FLIP or SSIM), so a change that alters the AAA image is seen in review.
- [ ] **Q4. Hardware numbers.** R1's lab. Listed for order only.

### M. The main thread

- [ ] **M1. Transforms and uniforms on the GPU.** The ~3.7 ms of per-copy `mvp`/`lightMvp` multiplication and the ~5 ms of uniform packing F0e measured move into a compute pass over the instance buffer (`gpuTransforms.ts` is the start). *Exit:* F0e's < 4 ms on Beaver Creek, measured on R1.
- [ ] **M2. Physics and navigation on a worker.** Rapier and the crowd step on a worker one tick ahead, through a transferable state block, with the host keeping the deterministic order. The cart sees the same state on the same tick as today.
- [ ] **M3. Async pipelines and a warm-up.** Every `createRenderPipeline`/`createComputePipeline` goes through one cache with `create*PipelineAsync`, and a scene's pipelines are compiled behind the loading screen. Completes R5.
- [ ] **M4. The scene's parse on a worker.** R2a's remaining 0.7–0.9 s on Beaver Creek.

### D. Content pipeline

- [ ] **D1. FBX skinning, animation and textures.** Clusters to skin weights, `AnimationStack`/`AnimationCurveNode` to clips, and the material's texture connections (diffuse, normal, specular/roughness, emissive), up to glTF parity. *Tests:* Mixamo-style and Blender-exported fixtures.
- [ ] **D2. Angle-preserving unwrap with seams.** LSCM over user-marked seams (with automatic seams from curvature as a default), keeping `uvUnwrap.ts`'s box projection as an option, and the same packer.
- [ ] **D3. GPU texture formats on import.** Imported maps (glTF, FBX, CC0 libraries) transcode to KTX2 on import, not only on save.
- [ ] **D4. Sidecars as packages.** The mesh sidecar routes store `.cbpk` (F9e's format and upload path), with JSON kept as a read path for old carts.
- [ ] **D5. A build-time cook.** A cart's sidecars become content-hashed packages at publish, so a player never synthesises content. Generalises R2 from the two arena maps to every cart.
- [ ] **D6. A DCC live link.** A Blender add-on that pushes the selected objects to an open editor tab over a local socket, extending `BLENDER_WORKFLOW.md`.

### S. Simulation runtime

- [ ] **S1. Caps from the budget, not the protocol.** On the `modern` and `aaa` tiers, physics bodies, rays, agents, joints and prefab copies are sized from the cart's budget, through the Modern core's direct calls. Fantasy tiers keep the RAM block. A body past any cap is reported in the editor, never dropped silently.
- [ ] **S2. Same-frame queries.** On the Modern core, `cartbox.ray` and `cartbox.sweep` answer in the call, against the world as last stepped.
- [ ] **S3. Collision layers.** A layer and a mask per `PhysicsSpec` (Rapier's collision groups), with rays and sweeps taking a mask.
- [ ] **S4. Projectiles.** A projectile body with CCD, gravity, drag and an impact event; host-replicated like Lockout's grenades. G5 is its first user.
- [ ] **S5. Joints and vehicles.** Fixed, spherical, prismatic and spring joints in `JointSpec`; a ray-cast vehicle (Rapier's controller) with an editor preset.

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
2. **M1, M3, M2.** The frame has room for gameplay.
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
