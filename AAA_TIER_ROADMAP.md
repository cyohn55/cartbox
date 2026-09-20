# AAA Tier Roadmap — photoreal + fantasy console, one web editor

**Status:** living document. Update the checkboxes and "Status" lines as phases land.
**Owner:** engine/editor team. **Last updated:** 2026-09-20.

## The vision

Cartbox should let users create and play **both** fantasy-console games (the
existing capped PS1/N64/360-style tiers) **and** photorealistic, modern-AAA-style
games — all running well in a browser, from one editor and one asset/cart format.

## The core design principle

Do **not** fork the product. The codebase already has the two ingredients that
make "both worlds" clean:

1. **A tiered model system** — `ConsoleModel` + `RenderCaps` (`packages/player/src/models.ts`).
   Each tier declares its own limits (poly budget, texture-cache bytes, filtering,
   vertex precision, `programmableShaders`).
2. **A dual renderer** — `SoftwareSceneRenderer` *and* `WebgpuSceneRenderer`
   (`packages/player/src/render/`), selected at runtime by `createSceneRenderer`.

So the AAA path is an **additive top tier** ("Modern"), whose `RenderCaps` are
effectively unbounded and which routes to a richer WebGPU pipeline. Fantasy tiers
keep their caps and must render **byte-identically** to today. One editor, one
cart/scene/asset format, tier-gated rendering, additive features that never touch
the capped tiers. The repo's existing discipline (`RenderCaps`, `webgpuCanHonour`,
committed-`dist` parity checks, per-model asset budgets) is exactly what keeps the
two worlds isolated.

## Non-negotiables / guardrails

- **No regressions to fantasy tiers.** Every AAA feature is gated on the tier or
  on a material carrying new (optional) PBR fields; absent those, output is
  byte-identical. Enforced by tests + the `check:dist` parity gate.
- **WebGPU is required for the Modern tier.** Provide a "requires WebGPU" gate
  (and, later, a WebGL2 fallback). Verify iPadOS 17+ / Safari support.
- **Legal / UGC.** Users bring their own assets; the platform must never ship
  copyrighted AAA content. Licensing + moderation matter at scale.
- **"Web photoreal" ≈ last-gen AAA / stylized-photoreal at 1080p60**, not the
  top-end native flagship. Set expectations there.

## Honest scope

This is a multi-month engine **and** editor initiative — effectively a compact
modern web 3D engine living beside the fantasy console. The biggest single piece
is arguably the **3D authoring UX**, not the renderer. Shader work (WGSL) cannot
be verified in CI (no GPU device), so the software rasteriser is kept as the
verifiable reference/fallback path and shaders are validated in-browser.

---

## Phases

Each phase is independently shippable and gated so it cannot regress fantasy tiers.

### Phase 0 — glTF PBR passthrough on import
Wire the glTF/OBJ importer to carry the maps it already parses past base-color:
metallic-roughness, normal, occlusion, emissive + factors. Needs the Phase 2
data-model fields to land in. Biggest fidelity jump per unit effort; mostly
asset-side.
- [x] `MeshMaterial` PBR fields (see Phase 2 data model)
- [x] `gltfCodec` reads `metallicRoughnessTexture`, `normalTexture`,
      `occlusionTexture`, `emissiveTexture` + `metallicFactor`/`roughnessFactor`/`emissiveFactor`
- [x] Round-trip tests (import → material fields populated)

**Status:** landed (data model + importer passthrough).

### Phase 1 — "Modern" tier stub
Add a top tier so the architecture is real end to end.
- [x] `MODERN_RASTER_CAPS` (unbounded budgets, `programmableShaders: true`) + `MODELS.modern`
- [x] Editor `ConsoleModelSpec` for `modern`
- [x] Web wiring: `resolveModelId`, `SELECTABLE_MODEL_IDS`, badge, engine URL,
      runtime id + migration whitelist
- [ ] Dedicated modern engine core (today it reuses the 360 core as a placeholder)
- [ ] Home-page catalog entry + starter polish

**Status:** stub landed — selectable via `?model=modern`, renders through the
existing path; a dedicated core + catalog polish remain.

### Phase 2 — PBR material model + shading
- [x] **Data model:** optional PBR fields on `MeshMaterial`
      (`metallicRoughnessImage`, `occlusionImage`, `emissiveImage`,
      `metallicFactor`, `roughnessFactor`, `emissiveFactor`) + serialize/deserialize.
      With Phase 0 this means an imported glTF **retains its PBR maps end-to-end**
      through the sidecar today, even before the shading lights them.
- [x] **Software rasteriser reference path:** metallic-roughness BRDF
      (Cook-Torrance: GGX NDF, Schlick-GGX geometry, Fresnel-Schlick, F0 =
      mix(0.04, albedo, metallic)) with a constant ambient/IBL stand-in term and
      an AO + emissive term, gated so non-PBR materials are byte-identical.
      Threads the new maps through the rasteriser (`renderMeshScene` →
      `drawMesh`/`eachTriangle` → `rasterizeTriangle`) + `MeshOverlaySurface`
      decode + `renderCaps.capTextures`. Verified with headless renders +
      `meshRasterizerPbr.test.ts`.
- [x] **Phase 2b — WebGPU PBR shader:** Cook-Torrance in WGSL on
      `WebgpuSceneRenderer`, gated on a `pbr` flag and mirroring the software
      branch term for term. Threads the metallic-roughness/occlusion/emissive
      maps + factors through the uniform layout (`scenePacking.ts`, pure + tested)
      and three new texture bindings. The fantasy Lambert path stays
      byte-identical; the PBR path can't be *byte*-identical (float32-vs-float64
      GGX/`pow`), so a tolerant device-only case in `webgpu-parity.test.ts` is the
      on-hardware gate. *Still non-linear byte space* (HDR is Phase 4). **Known
      follow-up:** tangent-space normal maps + the fantasy material-map specular
      are not yet on the GPU path — the software rasteriser remains the reference
      for those.

**Status:** Phase 2 complete — data model, software reference path, and the
WebGPU WGSL shader all landed. An imported glTF's PBR maps now light through the
metallic-roughness BRDF on both backends (software verified in CI; WebGPU
validated in-browser / on a real device). Shading is in the engine's non-linear
byte space for now — a linear/gamma-correct HDR pipeline is Phase 4.

### Phase 3 — Environment lighting + shadows
- [ ] Image-based lighting (HDRI environment cubemap): realistic ambient + reflections
- [ ] Directional (sun) cascaded shadow maps

### Phase 4 — HDR pipeline + more lights
- [ ] HDR + ACES tonemapping + exposure
- [ ] SSAO
- [ ] Clustered / forward+ lighting to lift the 6-light mailbox cap

### Phase 5 — "Runs well on the web" asset pipeline
- [ ] glTF import with Draco / meshopt geometry compression
- [ ] KTX2 / Basis texture compression + mipmaps
- [ ] LODs, frustum + occlusion culling, instancing
- [ ] Streaming for large scenes

### Phase 6 — 3D authoring UX (largest scope)
- [ ] Scene editor: place / transform meshes, gizmos
- [ ] Material editor (PBR channels), lighting + skybox authoring
- [ ] Asset browser + import UX for glTF/textures

---

## Where things live (engineering map)

| Concern | File(s) |
| --- | --- |
| Tiers + caps | `packages/player/src/models.ts` |
| Software mesh renderer | `packages/player/src/render/sceneRenderer.ts`, `packages/editor/src/render/meshRasterizer.ts` |
| WebGPU mesh renderer | `packages/player/src/render/WebgpuSceneRenderer.ts` |
| Renderer selection | `packages/player/src/render/createSceneRenderer.ts` |
| Mesh material model | `packages/editor/src/model/MeshAsset.ts` |
| glTF / OBJ import | `packages/editor/src/model/gltfCodec.ts`, `objCodec.ts`, `apps/web/src/lib/meshImport.ts` |
| Editor model specs | `packages/editor/src/model/consoleModel*.ts` |
| Web model wiring | `apps/web/src/lib/consoleModel.ts`, `starter.ts`, `titleRuntime.ts` |
| Runtime whitelist | `supabase/migrations/*_runtimes.sql` |
