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

---

## 3. The sidecars are the first era model, born in the wrong house

The most actionable finding in the current codebase.

`apps/web/src/app/edit/[cartId]/EditorWorkbench.tsx:81`:

```ts
const TABS = ["Code", "Assets", "Map", "World", "Scene", "Mesh", "Anim", "Weather", "FX", "SFX", "Music"] as const;
```

This list is **not gated on `modelId`**. `modelId` correctly drives palette
size, canvas geometry, sound channels and which WASM core loads — but every cart
gets every tab. A 240×136, 16-colour Classic cart is offered the World, Mesh,
Scene and Weather editors.

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
low-resolution. **Widen the interface now, while there are four models — not
later, with eight.** Retrofitting a capability block across eight models, two
engines, the replay format and the thumbnail renderer is the expensive version
of this change.

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

Meanwhile a working WebGPU triangle pipeline already exists, but only on the
authoring side, and scattered across route directories:

| File | Lines | Location |
|---|---|---|
| `MapGpuRenderer.ts` | 913 | `apps/web/src/app/edit/[cartId]/` |
| `WebGpuLitRenderer.ts` | 313 | `apps/web/src/app/edit/[cartId]/` |
| `WebGpuVoxelRenderer.ts` | 335 | `apps/web/src/app/onboarding/handheld/` |

1,561 lines of renderer living in Next.js page directories, drawing editor
previews only. An N64-era model cannot run at 60 fps in a browser tab on a CPU
rasteriser, so promoting these into `packages/player` stops being a cleanup and
becomes the foundation the entire era family stands on.

**The shape to copy** is `packages/player/src/lighting/createLightingLayer.ts`,
which already solves both hard parts: `getWebgpuDevice()` memoises one adapter
probe per page and returns `null` rather than throwing, and the factory owns
canvas creation because *"a canvas is locked to one context type once
`getContext` is called."* A `createSceneRenderer(doc, scene, w, h,
deviceProvider)` mirroring that signature gets WebGPU when available, software
when not, and `null` never.

**The constraint to respect:** the GPU path must *read back into the
framebuffer*, not present to its own swapchain. `MeshOverlaySurface` and
`WorldOverlaySurface` are decorators over the two-method `DisplaySurface`
interface; they write into an RGBA buffer and share a depth buffer with the
compositing step. A renderer that presents directly breaks lighting, post-FX,
and depth-correct occlusion. That means render-to-texture plus
`copyTextureToBuffer`, which costs a pipeline stall per frame — so at 240×136 the
software path may still win, and the real gain is in **triangle count**, not
resolution.

**Keeping the software path alive:** inject `() => Promise.resolve(null)` as the
device provider in tests so both backends run against the same fixtures, and
keep `renderMeshScene` as the reference implementation to assert GPU output
against. Otherwise the fallback rots and fails the first browser that needs it.

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

1. **Write the family down.** This document plus a pointer from `BUILD_PLAN.md`.
   Cheap, and it prevents years of drift toward an accidental general engine.
2. **Gate `TABS` on `modelId`.** Small change; immediately makes Classic feel
   like a fantasy console again, and establishes the pattern every era model
   will use.
3. **Promote the GPU renderer into `packages/player`** behind the
   `createLightingLayer` probe/fallback shape. Prerequisite for everything 3D
   (§5.1).
4. **Widen `ConsoleModel` with `RenderCaps`** (§4) while the model set is small.
5. **Build the PS1-era model.** Best first 3D era: cheapest constraints to
   enforce, highest aesthetic payoff. The existing 3D sidecars become its native
   format (§3), and the asset store lands here (§5.2).
6. **N64-era model.** Mostly a `RenderCaps` variation on PS1 plus mipmapping and
   the texture-cache limit. Cheap once PS1 exists.
7. **Creator-uploaded `wasm-app` titles.** Orthogonal to the era family; gated on
   serving player pages from a sandboxed origin, since the Emscripten JS glue is
   arbitrary same-origin JavaScript. See `games/README.md` for the ABI, which is
   already specified and validated by `assertImplementsAbi`.
8. **360-era tier, knowingly** (§2). This is where the platform becomes a general
   engine; do it deliberately, late, with the earlier tiers behind it.

---

## 7. The honest version

- **What this buys:** the TIC-80 seed catalog *and* a path to modern 3D, without
  either compromising the other. Classic never has to bend.
- **What it costs:** each era model is a real runtime with a real renderer.
  This is a multi-year family, not a feature.
- **Where it stops being a console family:** the 360 tier. Everything up to and
  including N64 is fixed-spec and doctrine-compliant. The 360 tier is a general
  engine, and calling it a "model" does not change that.
- **The failure mode to avoid:** arriving at a general engine by accretion.
  Each new sidecar column and each new 3D tab bolted onto Classic drifts toward
  that outcome without anyone deciding it. Deciding deliberately is cheaper than
  discovering you already decided.
