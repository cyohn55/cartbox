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

### 5.1a What the GPU path's tests do and do not cover

Stated plainly, because a renderer that has never run on a GPU is a liability
if its status is vague.

**Covered:** the packing and layout (uniform offsets including WGSL's 16-byte
mat3x3 column padding, vertex stride against the pipeline descriptor, readback
row unpadding, light resolution); the full renderer class driven through a
recording fake device (bind group layout, dynamic offsets per draw, geometry
uploaded once per mesh, transparent clear, aligned readback stride, the software
warm-up, compositing a landed readback, teardown, and surviving a device that
starts throwing); and the software path asserted byte-identical to
`renderMeshScene`.

**Not covered, and not coverable here:** WGSL compilation, and whether the GPU
output matches the software rasteriser pixel for pixel. Both need a real
adapter. The Chromium available in CI exposes no `navigator.gpu` at all, so
there is no software-adapter fallback to test against either.

One hardware-only defect was already caught by review rather than by a test: an
`"auto"` pipeline layout infers the uniform binding *without* a dynamic offset,
which would have made every `setBindGroup` call in the frame fail on a device
while passing everything runnable here. The layout is now explicit, and its
`hasDynamicOffset` and `minBindingSize` are pinned by test. **The first run on
real hardware should be treated as the real test.**

### 5.2 Asset storage breaks at the PS1 tier, not the 360 tier

Cart size ceilings today: Classic 64 KB → Pro 1 MB → Voxel 2 MB, with
`MAX_CART_BYTES = 2 * 1024 * 1024` hard-enforced in both `apps/web/src/app/api/carts/route.ts`
and `apps/web/src/app/api/carts/[cartId]/route.ts`.

Textured 3D content does not fit in that at any era. So the cart must stop being
one blob and become **a manifest plus content-addressed blobs in R2** — an
asset store, versioned and deduplicated, with the cartridge row pointing at it.

This is the largest single piece of work in the plan, and it arrives with the
*first* 3D era model rather than the last. Budget for it accordingly.

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
   (§5.1). Not verified on real hardware: see §5.3.
4. ~~**Widen `ConsoleModel` with `RenderCaps`.**~~ **Done** (§4).
5. **Build the PS1-era model.** Best first 3D era: cheapest constraints to
   enforce, highest aesthetic payoff. The existing 3D sidecars become its native
   format (§3), and the asset store lands here (§5.2).
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
