# Era Models — one console family, one era per model

> The direction: **Classic (TIC-80) stays its own separate entity**, and the
> model family grows *sideways* into new fixed specs that each replicate a
> distinct era of gaming history — an 8-bit tier (today's Classic), a PS1 tier,
> an N64 tier, and eventually a 360 tier — living alongside the WebGPU/WASM
> catalog rather than being grafted onto the cartridge.
>
> This extends `CONSOLE_MODELS.md`, which established the `ConsoleModel`
> abstraction and the multi-model platform. That document parameterizes models
> by *spec* (resolution, palette, channels). This one parameterizes them by
> *rendering era*, which is the axis the next three models vary on.

---

## 1. The decision this settles

There is a long-running tension in the repo between two framings:

- `BUILD_PLAN.md` — "Fantasy Console + Cartridge Marketplace." Principle 3:
  *"Stay compatible with the existing TIC-80 cartridge format. Don't fork the
  VM's behavior — inherit the entire existing catalog of community carts as
  instant seed content."*
- The direction the editor has actually drifted — eleven sidecar payloads, four
  3D authoring tabs, a WebGPU renderer — which is engine-shaped, not
  console-shaped.

The tension reads as a binary: *is the cartridge the product, or is it the
starter tier?* It isn't. **The cartridge is a family, one format per era.**

Classic remains byte-compatible with TIC-80 forever, because Classic is one
member of the family rather than the trunk everything else has to grow out of.
The seed-catalog strategy survives intact. The ceiling comes from adding
*siblings*, not from stretching Classic.

`models.ts` already states this doctrine, written before the era framing existed:

> *"A model is a fixed hardware spec plus the WASM runtime that runs it.
> Threading a model through the player/engine/replay/thumbnail paths (instead of
> hard-coding 240x136 / 60fps) is what makes additional models — Pro, Voxel —
> **additive rather than a rewrite**."*
>
> *"Constraints stay fixed **per model**. There are deliberately no free-form
> toggles: that would dissolve the aesthetic and break the fixed-spec
> assumptions the platform layer depends on."*

That second paragraph *is* the era-console thesis. A PS1 model is not "3D mode."
It is a fixed spec whose constraints are the aesthetic.

---

## 2. Which eras are console-shaped (and which is not)

This is the load-bearing planning question, because it determines how far the
family can extend before it stops being a family.

### PS1 and N64 — ideal targets

Both are fixed-function hardware whose *limitations are the look*. That is
exactly what a fantasy console wants: rules to enforce, not features to build.

| Era trait | PS1 | N64 |
|---|---|---|
| Depth | No z-buffer — painter's-algorithm sorting, surfaces punch through | Z-buffer |
| Texture mapping | Affine (the characteristic swimming/warping) | Perspective-correct |
| Vertex precision | Integer coordinates — the characteristic jitter | Floating point |
| Filtering | None (crunchy, aliased texels) | Trilinear mipmapping (the era's softness) |
| Texture budget | Small VRAM pages | **4 KB texture cache** — the defining constraint |
| Colour | 15-bit + dithering | 16/32-bit, often with heavy fog |
| Shading | Gouraud | Gouraud + fog to hide draw distance |

Every row is a rule the runtime enforces, not a system a creator configures. A
creator targeting either gets a distinctive, instantly-legible look *for free* —
which is the entire fantasy-console value proposition, transposed forward two
hardware generations.

Neither needs free-form toggles. Both fit the doctrine in §1 exactly.

### Xbox 360 — not console-shaped

The 360's defining feature is **programmable shaders** — unified shader
architecture, floating-point pipelines, HDR, normal and shadow maps. A 360 model
means letting creators write shaders, which means free-form toggles, which is
precisely what the model doctrine forbids. There is no fixed spec to enforce,
because the whole point of that generation was that the spec stopped
constraining the look.

So a 360 tier is a **general engine wearing a console costume**. That is not a
reason to drop it — it is a reason to see it clearly and schedule it honestly:

- It should come last, funded by the earlier tiers' content and revenue.
- It is where WebGPU genuinely earns its keep.
- The existing post-FX and lighting stack (`PostFxPass`, `WebgpuLightingLayer`,
  `createLightingLayer.ts`) is already its seed.

None of these models need be *literally* faithful. TIC-80 is not literally any
8-bit machine. An era model should pick constraints that **evoke** the era
rather than reproduce the silicon — which is what keeps asset budgets sane
(see §5).

Note that the ladder stops at the last *era*, and an era is by definition a
historical ceiling. A model that targets the best the web can do today is not an
era model at all; it is a different kind of tier, and it needs stating
separately — see §7.

---

## 3. The sidecars are the first era model, born in the wrong house

The most actionable finding in the current codebase.

The tab list in `EditorWorkbench.tsx` was a flat constant:

```ts
const TABS = ["Code", "Assets", "Map", "World", "Scene", "Mesh", "Anim", "Weather", "FX", "SFX", "Music"] as const;
```

It was **not gated on `modelId`**. `modelId` correctly drove palette size,
canvas geometry, sound channels and which WASM core loaded — but every cart got
every tab, so a 240×136, 16-colour Classic cart was offered the World and Mesh
editors.

**Shipped** (`editorTabs.ts`): a 2D model now hides the two tabs that open an
orbit camera. Scene, Anim, Weather and FX dress a 2D frame, so they stay
everywhere. The rule that makes the gate safe is that a spatial tab also shows
when the *cart* already carries that sidecar's data — carts saved before the
gate keep their tab and can still empty it, so nothing is stranded. The
Ctrl+1..9 order is derived from the same resolved set, so a numeric shortcut can
never select a hidden tab.

Alongside it, eleven sidecar payloads (`fx`, `rig`, `materials`, `voxel`,
`mesh`, `world`, `scene`, `anim`, `particles`, `collision`, `flags`) exist
*because a `.tic` cannot hold that data*, so it was bolted into Postgres columns
beside the cart. Four of them — `mesh`, `world`, `collision`, `flags` — are
marked `optionalColumn: true`, meaning they tolerate not existing at all.

Read against this roadmap, that is not a TIC-80 feature set. Meshes, materials,
a rig, a collision map, a world grid: **that is the PS1/N64-era cartridge
format, prototyped as attachments to the wrong console.**

Which gives a clean resolution rather than a deletion. Those tabs and payloads
*move out* of Classic and *become* the first era model's native format. Classic
goes back to being a clean TIC-80 editor — genuinely its own separate entity —
and nothing built so far is thrown away.

**The rule to protect:** every 3D feature added to the Classic editor is a PS1
feature in the wrong house, and it makes the eventual split more expensive.

---

## 4. `ConsoleModel` needs a rendering-capability block

Today `ConsoleModel` describes a *display* (width, height, fps, palette,
channels, cart size, engine URL). Era models vary on *rendering semantics*,
which it cannot currently express. `kind: "raster2d" | "voxel3d"` is the seam
this extends.

```ts
export interface RenderCaps {
  /** Painter's-algorithm sorting when false — the PS1 look. */
  zBuffer: boolean;
  /** Affine texture mapping when false — the PS1 texture warp. */
  perspectiveCorrect: boolean;
  textureFiltering: "none" | "bilinear" | "trilinear";
  /** Integer vertex coordinates produce the PS1 wobble. */
  vertexPrecision: "integer" | "float";
  /** N64's defining constraint. Bytes; 0 = unbounded. */
  textureCacheBytes: number;
  /** Enforced ceiling on triangles submitted per frame. */
  polyBudget: number;
  /** Whether creators may supply shaders. True only for the 360 tier. */
  programmableShaders: boolean;
}
```

This is what makes a PS1 model *feel* like PS1 rather than merely look
low-resolution. Widening the interface while there are four models is much
cheaper than retrofitting a capability block across eight models, two engines,
the replay format and the thumbnail renderer.

**Shipped** (`packages/player/src/models.ts`): `RenderCaps` as above, required
on every `ConsoleModel`. All four shipping models declare the same
`SOFTWARE_RASTER_CAPS` — correct rather than lazy, because they rasterise
triangles through the same overlay surfaces — so the field is truthful today and
the seam is real. `programmableShaders` is the line between a fantasy console
and the Unlimited tier (§7), and is pinned `false` for every model by test.

`console_model text not null default 'classic'` already exists in
`0001_init.sql`, so the database discriminator needs no migration to add eras.
Models stay in code, per `CONSOLE_MODELS.md` §2.

---

### 4a. Which caps are actually enforced

A descriptor nothing reads is a comment with a type annotation. `RenderCaps` is
now read — but only partly, and the split is worth stating because it decides
what the PS1 tier still needs.

| Cap | Enforced | Where | Software | WebGPU |
|---|---|---|---|---|
| `polyBudget` | **Yes** | Scene pre-pass | ✓ | ✓ |
| `textureCacheBytes` | **Yes** | Scene pre-pass | ✓ | ✓ |
| `textureFiltering` | **Yes** | Rasteriser | ✓ | ✓ (sampler) |
| `zBuffer` | **Yes** | Rasteriser | ✓ | declines → software |
| `perspectiveCorrect` | **Yes** | Rasteriser | ✓ | declines → software |
| `vertexPrecision` | **Yes** | Rasteriser | ✓ | declines → software |
| `programmableShaders` | n/a | — | False for every console model by definition | |

**Why that line falls where it does.** The two enforced caps are properties of
the *scene*, so they can be applied above the renderer — `CappedSceneRenderer`
wraps whichever backend is live, and the software rasteriser and the GPU obey a
model's limits identically. That matters more than it sounds: an era model's
constraints belong to the model, not to the viewer's graphics stack. A cart that
overruns a poly budget must overrun it the same way on both.

The other four are properties of *rasterisation*, in the per-pixel loop.
`renderMeshScene` now takes a `RasterStyle` carrying all four, defaulting to
exactly what it always did so the editor's previews are untouched:

- **No depth buffer** disables the depth test and write, and the scene path then
  collects every triangle in the *whole scene* and sorts it back-to-front — an
  ordering table, which is what hardware without a depth buffer actually did.
  Sorting per instance would not do: the artefact that defines the look is
  triangles resolving wrongly *within* and across objects.
- **Affine interpolation** uses the screen-space barycentric weights directly
  instead of weighting by 1/w. This is the texture swimming of the era.
- **Integer vertex precision** rounds projected vertices to whole pixels — the
  wobble of a transform unit with no subpixel precision.
- **Filtering** adds a bilinear path to the texture sampler.

**Which backend takes a model is now decided by its era.** WebGPU handles
filtering (it is only a sampler setting) but *declines* the other three, so the
factory falls back to software for a model that needs them. That is deliberate,
not a gap:

- No depth buffer would need a per-*triangle* sort across the scene every frame,
  which on the GPU means rebuilding and re-uploading index buffers and destroying
  the geometry cache the renderer is built around. Sorting whole draws instead
  would be coarser than the software path and break parity — worse than not
  offering it.
- Affine interpolation and vertex snapping are both reachable in WGSL
  (`@interpolate(linear)`, rounding in the vertex shader) but each needs a shader
  variant, and shader variants cannot be verified without a device (§5.1a).

This lands well rather than awkwardly: a console with no depth buffer and integer
vertices is a low-polygon, low-resolution machine, which is exactly the workload
the software rasteriser already handles. An N64-era model — depth-buffered,
perspective-correct, filtered — is the tier that actually needs GPU throughput,
and it keeps it. `trilinear` maps to bilinear on *both* backends until a mip
chain exists, so parity holds and both gain real trilinear at once.

**Enforcement choices worth knowing**, since both are visible to creators:

- The poly budget cuts at *instance* granularity, and always draws the first
  instance even if it alone busts the budget. Slicing index buffers mid-mesh
  would allocate fresh geometry every frame and miss the renderer's upload
  cache; and a single over-budget object is a content problem for the editor to
  flag, not something the runtime should silently blank. So the budget bounds
  scene complexity *across objects*, which is what a poly budget is for.
- The texture cache halves textures with a box filter until they fit. That is
  not an approximation of the N64 look — it *is* the N64 look. Its 4KB cache is
  why that era reads soft and low-resolution. Results are memoised by source
  texture, because the GPU renderer caches uploads by object identity and a cap
  returning fresh objects each frame would be worse than no cap at all.

## 5. Two things the era roadmap forces

### 5.1 The player needs a GPU triangle path — it is a prerequisite, not a polish item

`packages/player/src/mesh/MeshOverlaySurface.ts` states the current position
outright:

> *"This is Phase 2 of the mesh asset feature: **the runtime has no GPU triangle
> path**, so the same pure software rasteriser the editor previews with
> (`renderMeshScene` in `@cartbox/editor`) draws the meshes straight into the
> framebuffer here."*

WebGPU code already existed on the authoring side, scattered across route
directories — but a correction to an earlier reading of it, because it changes
the size of the job:

| File | Lines | Location | Draws |
|---|---|---|---|
| `MapGpuRenderer.ts` | 913 | `apps/web/src/app/edit/[cartId]/` | A voxel surface mesh (`voxelModelToMesh`) |
| `WebGpuVoxelRenderer.ts` | 335 | `apps/web/src/app/onboarding/handheld/` | Instanced cubes |
| `WebGpuLitRenderer.ts` | 313 | `apps/web/src/app/edit/[cartId]/` | A full-screen sprite-lighting pass — no geometry at all |

Only the first is a general triangle pipeline, and none of the three consumes
the `MeshAsset` vertex format the player's overlays actually carry. So this was
never a file move. `MapGpuRenderer` is the proven *pattern* — device handling,
depth, passes, readback-free presentation — and the player needed a renderer
written against it, not relocated from it.

An N64-era model cannot run at 60 fps in a browser tab on a CPU rasteriser, so
that renderer is the foundation the entire era family stands on.

**Shipped** (`packages/player/src/render/`):

- `sceneRenderer.ts` — the seam. Both overlays called `renderMeshScene`
  *directly*, which is precisely why there was no GPU path: the rasteriser was a
  function they invoked, not a dependency they could be handed. They now draw
  through a `SceneRenderer`.
- `WebgpuSceneRenderer.ts` — the GPU path, shading matched to the software
  rasteriser exactly: two-sided Lambert with an ambient floor, nearest-sampled
  wrapped textures, glTF's flipped V, the same alpha-discard threshold, and the
  same non-inverse-transpose normal basis. Parity is the contract — a cart must
  not look different depending on the viewer's browser.
- `scenePacking.ts` — the pure half (uniform layout, vertex interleaving,
  readback unpadding, light resolution), so the parts that fail silently on a
  GPU are the parts covered by tests.
- `createSceneRenderer.ts` — the probe-and-fall-back factory. Unlike
  `createLightingLayer` it never returns null: the software path needs nothing
  from the platform, so no caller needs a third branch.

The player builds one renderer per cart, shared by both overlays, and only when
something 3D is declared — a plain 2D cart never touches WebGPU.

**The shape to copy** is `packages/player/src/lighting/createLightingLayer.ts`,
which already solves both hard parts: `getWebgpuDevice()` memoises one adapter
probe per page and returns `null` rather than throwing, and the factory owns
canvas creation because *"a canvas is locked to one context type once
`getContext` is called."* A `createSceneRenderer(doc, scene, w, h,
deviceProvider)` mirroring that signature gets WebGPU when available, software
when not, and `null` never.

**The constraint that shaped it:** the GPU path must *read back into the
framebuffer*, not present to its own swapchain. The overlays are decorators over
the two-method `DisplaySurface` interface, so their output has to flow onward
through lighting and post-FX; a renderer that presents directly breaks grading,
bloom and depth-correct occlusion.

That collides with `blit` being synchronous while GPU readback is not. Resolved
by rendering one frame behind: the renderer submits the current frame and
composites the most recently *completed* readback, typically one to two frames
old, on the overlay only — the cart's own 2D frame is never delayed. Waiting on
`mapAsync` inside `blit` would turn a GPU win into a pipeline bubble worse than
the CPU path it replaces. Until the first readback lands, the software
rasteriser draws, so there is no pop-in on the opening frames.

The depth buffer turned out not to need reading back at all: it is scratch
internal to a single `renderMeshScene` call and no caller reads it, so the GPU
path keeps depth on the GPU. That is now stated in `SceneDraw`, since a future
caller reading it would be a real bug.

**Keeping the software path alive:** `createSceneRenderer` takes an injectable
device provider, so passing one that resolves null forces the software path in
tests; the software renderer is asserted byte-identical to `renderMeshScene`;
and it is the live warm-up path on every cart's opening frames rather than code
that only runs on someone else's browser.

### 5.1a What the GPU path's tests cover

**The GPU path has been verified on a real WebGPU device.** The WGSL compiles,
the pipeline builds, and its output is **byte-identical** to the software
rasteriser — zero differing channels across a scene of angled, overlapping,
textured and untextured instances. `Unit Tests/webgpu-parity.test.ts` is that
check, and its header says how to run it.

**How, with no GPU:** Dawn bound into Node (`@kmamal/gpu`) on top of Mesa's
software Vulkan (`mesa-vulkan-drivers`, providing the lavapipe ICD). Playwright's
bundled Chromium ships without WebGPU — `navigator.gpu` is undefined regardless
of flags, headless or headed — so the browser is a dead end for this; Node is
not. Pin `@kmamal/gpu@0.2.0`: 0.2.1 has a binding bug where `createView()`
passes a swizzle field Dawn rejects, unrelated to any Cartbox code.

The test is opt-in — it skips unless the binding is installed, because a ~100MB
native dependency should not be in every `npm install` to serve one suite.

**Also covered, without a device:** the packing and layout (uniform offsets
including WGSL's 16-byte mat3x3 column padding, vertex stride against the
pipeline descriptor, readback row unpadding, light resolution); and the renderer
class driven through a recording fake (bind group layout, dynamic offsets per
draw, geometry uploaded once per mesh, transparent clear, aligned readback
stride, the software warm-up, compositing a landed readback, teardown, and
surviving a device that starts throwing).

**Still not covered:** parity was measured on a software Vulkan implementation.
A discrete GPU could differ in float precision or rasterisation fill rules, so
the exact-equality assertion may need a tolerance on real silicon. Treat a
mismatch there as new information about hardware, not as a regression.

Worth recording: one hardware-only defect was caught by review before any of
this ran. An `"auto"` pipeline layout infers the uniform binding *without* a
dynamic offset, which would have failed every `setBindGroup` call on a device
while passing every runnable test. The layout is explicit, and its
`hasDynamicOffset` and `minBindingSize` are pinned by test.

### 5.2 Asset storage breaks at the PS1 tier, not the 360 tier

Cart size ceilings today: Classic 64 KB → Pro 1 MB → Voxel 2 MB, with
`MAX_CART_BYTES = 2 * 1024 * 1024` hard-enforced in both `apps/web/src/app/api/carts/route.ts`
and `apps/web/src/app/api/carts/[cartId]/route.ts`.

Textured 3D content does not fit in that at any era. So the cart must stop being
one blob and become **a manifest plus content-addressed blobs in R2** — an
asset store, versioned and deduplicated, with the cartridge row pointing at it.

This is the largest single piece of work in the plan, and it arrives with the
*first* 3D era model rather than the last. Budget for it accordingly.

**Shipped — the foundation, not yet the wiring:**

- `cartAssetStore.ts` — the pure format. Assets are addressed by SHA-256, so
  dedup is global and free (a tileset shared by fifty remixes is stored once,
  which is the difference between storage growing with forks and growing with
  originals), assets are immutable and cache forever, and re-saving a cart
  re-uploads nothing.
- `cartAssetStorage.ts` — R2 and Postgres, writing **blob, then row, then
  manifest**. Every failure between those steps leaves orphaned bytes, which is
  a bill; the reverse order would leave a dangling reference, which is a missing
  texture the player sees.
- `ConsoleModel.assetBudgetBytes` — the allowance is **per model**, same
  doctrine as every other limit here. An era model picks a budget that evokes
  its generation rather than reproducing a disc, and a cartridge-only model
  cannot silently acquire an asset store. Every shipping model is `0`, pinned by
  test: **the first non-zero budget is the first era model.**
- `POST/GET /api/carts/[cartId]/assets`, and migration `0024_cart_assets.sql`.

**Wired up:** mesh textures no longer live as base64 inside the mesh sidecar.
`serializeMeshAsset` still embeds them, but the storage layer lifts each one
into the asset store on write and puts it back on read, so nothing downstream —
the deserializer, either renderer, the editor — knows it happened. Carts with
inline bytes keep working untouched, the round trip is byte-identical, and a
texture that cannot be fetched degrades to an untextured surface rather than
failing the mesh.

Two rules that fell out of building it:

- **Offloaded textures are recorded in the cart's manifest** (`mesh-<hash>`),
  and the offload is *skipped entirely* if the manifest cannot be read. A cart
  must never reference an asset it did not also record: an unrecorded reference
  is invisible to the sweep below, which would then delete a texture in use.
- **The offload does not check the model's budget.** The budget bounds how much
  a cart may *carry*; offloading changes where existing content lives, not how
  much there is. Charging for it would make a cartridge-only model (budget 0)
  unable to save a textured mesh it could save yesterday.

**Still not done:** the editor has no upload UI of its own, and no garbage
collection reclaims unreferenced blobs. The latter is a real decision rather
than an omission — assets are shared by hash, so
"this cart dropped it" never means "nobody wants it", and deleting on
dereference would let one creator's edit break another's published cart. It
wants an offline mark-and-sweep with a grace period, not a request-path delete.

One thing this surfaced: `apps/web` resolves `@cartbox/player` to a **tracked,
prebuilt `dist/`** that had gone stale — stale enough that nothing in the web app
could see `RenderCaps` at all. It is rebuilt here, but the arrangement is a trap
worth removing: the web app should compile against the package's source, or the
build should be enforced, rather than silently type-checking against a snapshot.

An era model may still choose a deliberate ceiling far below historical fidelity
(a "PS1-era" model capped at 32 MB rather than a 660 MB disc) — that is a design
choice available at every tier, and consistent with TIC-80 not literally being
any real machine.

---

## 6. Sequencing

1. ~~**Write the family down.**~~ **Done** — this document, plus a pointer from
   `BUILD_PLAN.md` scoping its TIC-80 principle to Classic.
2. ~~**Gate the tab list on the model.**~~ **Done** — `editorTabs.ts` (§3).
3. ~~**Give the player a GPU triangle path**~~ **Done** — `packages/player/src/render/`
   (§5.1), and verified byte-identical to the software path on a real WebGPU
   device (§5.1a).
4. ~~**Widen `ConsoleModel` with `RenderCaps`.**~~ **Done** (§4), and every cap
   is now enforced (§4a) — the scene-level pair above the backend, the
   rasterisation-level four inside it, with the backend chosen by what the
   model's era needs. **The renderer can now express a PS1-era look.**
5. **Build the PS1-era model.** *Started.* The spec, its `RenderCaps`, its
   asset budget and its core build script are in; what remains is building the
   core binary and letting creators select it. See §9.
6. **N64-era model.** Mostly a `RenderCaps` variation on PS1 plus mipmapping and
   the texture-cache limit. Cheap once PS1 exists.
7. **Creator-uploaded `wasm-app` titles.** Gated on serving player pages from a
   sandboxed origin, since the Emscripten JS glue is arbitrary same-origin
   JavaScript. See `games/README.md` for the ABI, already specified and
   validated by `assertImplementsAbi`. This is **on the critical path for the
   Unlimited tier, not orthogonal to it** (§7) — both deliver a creator-authored
   WASM module against a host-owned ABI, approached from opposite ends.
8. **360-era tier, knowingly** (§2). This is where the platform becomes a general
   engine; do it deliberately, late, with the earlier tiers behind it.
9. **Unlimited tier** (§7) — the 360 tier with the era ceiling removed. Its
   *runtime* falls out of steps 3–8; its *tooling* is a separate long product.

---

## 7. The Unlimited tier — best-possible web engine, no era ceiling

**This is not in the era ladder above, and it needs to be stated explicitly,
because the ladder cannot reach it.** Every tier in §2 is defined by a
historical ceiling: a PS1 model is *good* precisely because it refuses to draw
what a PS1 could not. Even the 360 tier is a 2005 ceiling. A creator who wants
the most capable thing the web can render today is not served by any of them.

So the family has two kinds of member:

| | Era models | Unlimited |
|---|---|---|
| Defined by | A historical spec | The current capability of WebGPU/WASM |
| Constraints | Fixed, enforced, aesthetic | None beyond the browser's |
| `programmableShaders` | `false` | `true` |
| Resolution | Fixed framebuffer | Canvas-native, device pixel ratio |
| Cartridge | Format per era | A project: manifest + content-addressed blobs |
| Game code | Interpreted script buffer (Classic) / era runtime | A creator-compiled WASM module |
| Spec stability | Frozen at ship | Moves as the platform moves |
| Value proposition | Constraints make good-looking work easy | Nothing is in your way |

**Unlimited is deliberately not a fantasy console.** It breaks the `models.ts`
doctrine — "no free-form toggles: that would dissolve the aesthetic" — on
purpose, which is fine so long as it is declared rather than smuggled in one
sidecar at a time. The `RenderCaps.programmableShaders` flag exists to make that
line explicit in code: it is `false` for every console model, and the tier that
sets it `true` is announcing that it is a different kind of thing.

### It converges with the `wasm-app` runtime

The most useful structural observation, and the one that makes this tractable:
**Unlimited and creator-uploaded `wasm-app` titles are the same system
approached from two directions.**

- `wasm-app` today is *bring your own engine, we host it*: seven exported
  functions (`games/README.md`), a host-owned framebuffer, clock, input and save
  storage. Eight ported games already run on it.
- Unlimited is *use our engine tooling, which compiles to the same target*.

Both end at a creator-authored WASM module driven by a host that owns the frame
loop. They should share one ABI — a v2 of the Cartbox Game ABI that adds a
WebGPU device handle and an asset-fetch callback to the existing seven exports —
rather than growing two runtimes that do the same job. This is why step 7 in §6
is on the critical path rather than beside it.

### What is genuinely hard here

Split the tier honestly, because the two halves have very different costs:

- **The Unlimited *runtime*** — a WebGPU renderer, a WASM ABI, an asset
  pipeline, a scene format — is largely a **byproduct of shipping the era
  tiers**. §5.1 builds the renderer, §5.2 builds the asset store, the N64 tier
  forces texture streaming, the 360 tier forces shader plumbing. Removing the
  constraints from that stack is a much smaller step than building it.
- **The Unlimited *tooling*** — "the best possible engine tooling" — is a
  separate multi-year product competing with Unity, Godot and Bevy on the web.
  Nothing in this roadmap shortens that, and no amount of sequencing makes it
  cheap.

The strategically useful part is that **the era ladder is a good way to build
toward Unlimited rather than a detour from it.** Each tier forces one piece of a
modern engine into existence under constraints tight enough to make it
tractable, shippable, and revenue-generating on the way. Building the general
engine first means building all of it before anything ships.

### Where it sits

Unlimited should be declared in this document from the start so the architecture
leaves room for it, and built last. It is deliberately **not** added to
`MODELS` yet: a model id with invented specs and no engine creates dead code
paths through `ENGINE_URL_BY_MODEL`, the badge map and the runtime registry, for
a tier whose spec cannot be written until the renderer exists. `voxel` already
demonstrates the cost of a defined-but-unbuilt model.

---

## 8. The honest version

- **What this buys:** the TIC-80 seed catalog *and* a path to modern 3D, without
  either compromising the other. Classic never has to bend.
- **What it costs:** each era model is a real runtime with a real renderer.
  This is a multi-year family, not a feature.
- **Where it stops being a console family:** the 360 tier. Everything up to and
  including N64 is fixed-spec and doctrine-compliant. The 360 tier is a general
  engine, and calling it a "model" does not change that. The Unlimited tier (§7)
  is openly one, which is the better way to hold it.
- **What the plan does not shorten:** Unlimited's *tooling*. The era ladder
  builds Unlimited's runtime incrementally and profitably; it does nothing to
  make a Unity-class editor cheaper. Do not let the roadmap imply otherwise.
- **The failure mode to avoid:** arriving at a general engine by accretion.
  Each new sidecar column and each new 3D tab bolted onto Classic drifts toward
  that outcome without anyone deciding it. Deciding deliberately is cheaper than
  discovering you already decided.


---

## 9. PS1 — the first era model

Declared in `MODELS.ps1` / `PS1_MODEL`, with `build-ps1-wasm.sh` to produce its
core. It is **defined but not yet selectable**, exactly as `voxel` is: the model
resolves, the editor knows its geometry, and `ENGINE_URL_BY_MODEL` falls back to
the Classic core until the PS1 one is built and deployed.

### The spec, and why each number

| | | |
|---|---|---|
| Frame | 320×240 | The era's NTSC frame, and 4:3 rather than the Pro models' 16:9 — the aspect ratio is as much a period signal as the pixels, and a widescreen PS1 game reads as a remaster |
| `fps` | 60 | See below |
| Palette | 256 | 8-bit CLUT textures were the era's workhorse; authentic rather than a compromise |
| `cartSizeBytes` | 2 MB | Code, HUD art and sound. **Not** geometry |
| `assetBudgetBytes` | 660 MB | A CD-ROM. The disc is the defining physical fact about this generation — it is why its games have full-motion video, streamed audio and textured worlds where the cartridge eras did not. Picking a smaller figure to keep pressure on the artist would invent a constraint the hardware did not have |
| `kind` | `poly3d` | A new rasteriser family — games are textured triangle scenes. The editor's spatial tabs key off this |

`RenderCaps`: no depth buffer, affine interpolation, integer vertices,
unfiltered texels, a **64KB texture cache** (one 256×256 8-bit page) and a
**3,000-triangle** frame budget.

**On the frame rate.** Those games ran at 30fps, and it is tempting to encode
that. But 30fps was a *consequence* of the polygon budget, not a design goal —
so the model constrains the geometry and stays at 60. Modelling the cause rather
than the symptom means a cart that stays within budget feels good to play, while
one that does not is over budget rather than merely slow.

**On the disc.** The budget is a real CD-ROM rather than a smaller figure chosen
to keep pressure on the artist, and that follows the same rule as every other
number here: the frame is 320×240 because that is the frame, and the texture
cache is 64KB because that is the page. Inventing a storage limit the hardware
did not have would be the one arbitrary figure in the spec.

The era's *look* does not come from storage in any case. It comes from the 64KB
texture page and the 3,000-triangle frame — caps that bind on every frame, where
the disc only ever bound on the whole game. A creator with a disc to fill still
cannot put a large texture on screen.

The practical consequence is a hosting one, not an aesthetic one: a cart may
reference up to 660MB of R2 storage. Content addressing takes most of the sting
out of that — a texture shared across fifty remixes is stored once — but the
garbage collection in §5.2 stops being a nice-to-have at this budget, and the
per-asset cap (16MB) is what still bounds any single upload.

### What this turned out to be

Less than expected, and worth recording. **A PS1 model is not a new engine.**
The 3D comes from the player's mesh and world overlay surfaces, which already
composite textured triangles over whatever frame the core produces; the core
only supplies the 2D framebuffer, the script VM, sound and the cartridge memory
map. So the core is a *parameterised rebuild* of the same TIC-80-derived engine
— `build-ps1-wasm.sh` is the Pro script with a different fixed spec, structurally
identical on purpose.

Everything else the tier needs already landed: the renderer honours the era caps
(§4a), the software path takes models WebGPU declines, and the asset store holds
what the cartridge cannot (§5.2).

### Building a core, and a correction

An earlier revision of this section said the core "needs the Emscripten SDK,
which no CI here has". **That was wrong**, and it is worth recording why, because
the mistake cost this model a release: `deploy-pages.yml` has installed
Emscripten via `mymindstorm/setup-emsdk` for as long as the game engines have
been built — five times over, with caching, for Doom, ScummVM, SuperTux,
OpenTyrian, OpenTTD and Cave Story. The toolchain was never the blocker.

The real gap was smaller and much less visible. `packages/engine/README.md`
describes TIC-80 as a git submodule at `packages/engine/tic80`, but the
repository has no `.gitmodules`, that path is gitignored, and the documented
`git submodule update --init` therefore does nothing at all. The source simply
was not there, and no script fetched it — so the build failed at its
precondition check and the failure read as "no toolchain".

`scripts/prepare-tic80.mjs` is that missing step: it clones TIC-80 at the pinned
commit the patches were authored against and applies both of them. A plain clone
rather than a submodule, deliberately — the patches carry `index` lines naming
the blobs they expect, so they apply at that commit and nowhere else, and
"whatever HEAD is today" is not a valid input to a reproducible build.

```bash
npm run engine:prepare      # fetch + patch TIC-80 at the pinned commit
npm run engine:build:ps1    # -> packages/engine/dist/ps1/engine.{js,wasm}
```

`.github/workflows/build-engine-cores.yml` runs exactly that on any change to
`shim.c`, the patches, the build scripts or the prepare script. It uploads the
core as an artifact and deliberately neither commits nor deploys one: promoting
a core changes what every cart on that model runs on, which is a human decision.

### What is left

1. ~~**Build the core**~~ — done. `packages/engine/dist/ps1/` and
   `apps/web/public/engine/ps1/` hold the built core, and
   `ENGINE_URL_BY_MODEL.ps1` points at it rather than falling back to Classic —
   a fallback would silently run a PS1 cart on a 240x136 4bpp machine, which is
   worse than not loading. `ps1-core-build.test.ts` proves the binary was
   compiled at the PS1 spec rather than being Classic under another name: the
   three cores report three different cartridge memory maps, PS1's sits between
   Classic's and Pro's as its resolution implies, and its music-track packing is
   the eight-channel one.
2. ~~**Make it selectable**~~ — done. `ps1` is in `SELECTABLE_MODEL_IDS`, the home
   page offers it as a link rather than a notice, and `cartbox-ps1` is a
   registered runtime. That last part needed a migration: `titles.runtime` is
   constrained to a whitelist, and a catalog row naming a runtime missing from it
   is rejected on insert with no visible error — the omission that once hid
   SuperTux, Quake and Cube 2 from Browse. **0025 has to be applied to
   production** (`supabase/migrations/apply-0025-to-prod.sql`); until it is, PS1
   carts author and play, and only publishing one to the catalog fails.

   Shipping it before item 4 is a deliberate trade: the model cannot be judged
   without being usable, so it goes out to be looked at rather than waiting to be
   perfect.
3. ~~**An editor upload path for textures**~~ — done. The editor's **Files** tab
   uploads, lists and removes assets against the model's budget. It is gated on
   `assetBudgetBytes > 0`, which today means PS1 alone — so with item 2 done it is
   now reachable: open a PS1 cart and the More menu carries **Files**, showing
   `0 B of 660 MB`. The tab also shows for any cart already storing assets
   whatever its model, so nothing a cart is paying for can become unreachable.
4. **Verify the look on real content.** The only item left, and now the only one
   that matters. Every era trait is unit-tested as a descriptor and as rasteriser
   behaviour, and the core is proven to be compiled at the PS1 spec rather than
   Classic under another name — but none of that is evidence about how a PS1 cart
   *looks*. Nobody has built one and judged whether it reads as the era. That
   test cannot be automated, and the model is selectable now precisely so it can
   be taken.
