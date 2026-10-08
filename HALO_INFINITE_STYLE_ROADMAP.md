# Halo Infinite art style roadmap

Editor and engine upgrades aimed at the Halo Infinite look, each applied to the
Lockout demo as it lands. Ordered by visual payoff per unit of work; each item
ships as its own PR with tests, and the Lockout demo uses it in the same PR.

Successor to [`HALO2_STYLE_ROADMAP.md`](HALO2_STYLE_ROADMAP.md), whose light,
surface and effects work (baked lighting, reflection probes, detail maps,
volumetric fog, particles, decals, shields) this builds on. Its three open
items move here: H12 becomes I9, H15 becomes I6, the rest of H16 becomes I12.

## Where Lockout stands

The engine already has most of the lighting a modern look needs: PBR
materials with normal, AO and emissive maps, cascaded sun shadows, spot and
point shadows, light and reflection probes, baked light maps, SSAO, bloom,
filmic tone mapping, grading, volumetric fog and shafts, lens flare, depth of
field, particles, decals, terrain, foliage, LOD and a material graph.

What separates Lockout from Halo Infinite, seen in a match:

- **Image quality.** No anti-aliasing anywhere: every edge is jagged.
- **Shapes and surfaces.** The arena is generated in code from boxes, wedges
  and fins with 256×256 noise textures. Infinite's Forerunner architecture is
  huge, sweeping, angular and layered, with crisp detail and worn metal.
- **Characters and first person.** Block-built Spartans; a flat white sword
  with no hands. Infinite has detailed armour, glossy visors, gloved hands and
  translucent plasma.
- **World.** A gradient sky over a floating arena. Infinite has painted
  skies, the ring overhead, clouds and distant country.
- **Light and colour.** Dark, teal-tinted interiors. Infinite is bright,
  saturated and warm.
- **HUD.** A pixel font and rectangles. Infinite's is thin, curved and
  holographic.

## Phase A — Image quality (cheap, engine-wide)

- [x] **I1. Anti-aliasing.** Multisampling (4×) in both GPU scene renderers,
      resolved before the frame is read back, so edges between surfaces are
      smooth and the coverage it reads back smooths silhouettes against the
      sky too. The held weapon, drawn by the software rasteriser, gets its
      outline smoothed. A render cap: on for the Xbox 360 tier (the real
      console's 4× MSAA) and the Modern tier; the retro tiers keep their
      crisp edges. Off on the low graphics preset.
      *Lockout:* clean edges on the towers, the trim and the sword.
      *Done:* `SceneDraw.antialias` asks the WebGPU and WebGL2 renderers for
      4× multisampling (off by default, so their byte-for-byte parity with the
      software rasteriser holds); texture coordinates are sampled at the
      centroid so edge samples never read past a triangle. The scene renders
      into multisampled colour and depth and resolves before readback;
      transparent and soft-particle passes and material graphs run
      multisampled too. An `antialias` render cap (on for Xbox 360 and Modern)
      and quality setting (on for high and medium) both have to allow it.
      The held weapon's outline is feathered by a pixel. Tested on real
      Chromium WebGL2 and a real WebGPU device: only edge pixels change, and
      only to values between their neighbours. Lockout (Xbox 360 tier) has it
      on.
- [x] **I2. Temporal anti-aliasing.** Jittered frames blended with history,
      reprojected with the camera, to calm the shimmer multisampling can't
      reach: thin trim, specular sparkle on metal, foliage cut-outs. With a
      sharpening pass. *Lockout:* the deck's panel lines stop crawling as you
      walk.
      *Done:* `SceneDraw.temporal` has the WebGPU and WebGL2 renderers jitter
      the projection through an 8-step Halton (2,3) sequence and resolve each
      frame on the GPU before readback (so the readback's lag doesn't matter):
      the history, in half floats, is reprojected through the frame's depth
      and both cameras, clamped to the new frame's 3×3 neighbourhood (so
      what moves or appears replaces it instead of ghosting), and blended at
      10%; a contrast-limited sharpen writes the output without feeding the
      history (`temporal.ts`). A `temporal` render cap (Xbox 360, whose
      Halo: Reach shipped a temporal anti-aliaser, and Modern) and quality
      setting (high and medium) both gate it; with it off, parity with the
      software rasteriser holds. Measured on real WebGPU and Chromium WebGL2
      against a 4×-supersampled frame of sub-pixel bars and a too-fine
      checkerboard, with and without multisampling: the error more than
      halves (8.0 → 3.2; 5.9 → 2.7 with MSAA), the first frame after a pan
      keeps the history, and the crawl as the camera drifts drops from 7.4
      to 2.0. It reprojects with the camera only, so a fast-moving object
      leans on the clamp rather than its own motion. Lockout has it on.
- [x] **I3. Screen-space reflections.** Polished floors and metal reflect
      what's on screen, falling back to the reflection probes where the
      screen has nothing. *Lockout:* the towers and bots reflected in the
      polished deck of bottom mid.
      *Done:* `SceneDraw.reflections` has the WebGPU and WebGL2 renderers draw
      Modern-tier surfaces with two more targets beside the colour: how much
      of a reflected colour reaches the screen (the specular weight carried
      through the tone map and fog, with the roughness) and what the probe or
      environment reflection added. A pass before readback (and before the
      temporal resolve) rebuilds each reflective pixel's position and normal
      from depth, marches the reflected ray across the depth buffer, and
      swaps the pixel it meets in for the probe's reflection, fading toward
      the screen's edges, with distance and roughness, and for rays turning
      back to the camera, so the probes stay where the screen has nothing
      (`reflections.ts`). Glass keeps a share of what's behind it. A
      `reflections` render cap (Xbox 360 and Modern) and quality setting
      (high and medium) gate it; with it off, parity with the software
      rasteriser holds. Tested on real WebGPU and Chromium WebGL2, alone and
      with multisampling and temporal anti-aliasing: a red and a blue panel
      on a polished floor each show in the floor on their own side, nothing
      but the floor changes, and the floor nearest the camera, whose rays
      leave the screen, keeps its probe reflection. Lockout's deck plates
      are polished (roughness 0.35) so the towers and soldiers show in them.
- [x] **I4. Material upgrades.** Clearcoat (a glossy layer over paint, for
      armour and visors), anisotropic highlights (brushed metal), parallax
      occlusion (depth in panel seams without geometry), and wear masks in the
      material graph (edges and cavities from a baked curvature map).
      *Lockout:* chipped edges on the walls, a lacquered armour finish.
      *Done:* `MeshMaterial` gains `clearcoat` and `clearcoatRoughness`,
      `anisotropy` and `anisotropyRotation`, and a relief map (`reliefImage`:
      height in R, curvature in G) with a `parallaxDepth` in world units, all
      stored and read defensively (`materialLayers.ts`) and carried to and from
      glTF as `KHR_materials_clearcoat` and `KHR_materials_anisotropy`. The
      software rasteriser and both GPU shaders shade them term for term: a
      second GGX lobe for the coat about the geometric normal (over normal-
      mapped bumps), its Fresnel dimming the base and its own sharp reflection
      of the sky and probes; Burley's anisotropic GGX along the UV gradient
      laid in the surface, with the reflection bent across the grain; and a
      16-layer parallax march into the relief that moves every map's UVs.
      The CPU takes each triangle's exact UV gradients, the GPU the screen
      derivatives. The material graph gains a *Curvature* input and a *Wear
      mask* node (edges or cavities, an amount, a sharpness and a breakup
      input), with an *Add edge wear* button and a *Worn edges* preset that
      chip whatever drives the colour to bare metal and settle grime in the
      seams. WebGL2 guarantees 16 texture units and the scene shader binds 16,
      so the relief rides in the occlusion map's G and B rather than a unit
      of its own (`occlusionWithRelief`); the uniform struct grows to 800
      bytes (stride 1024). The Material panel has Clearcoat, Brushed metal and
      Relief sections with a built-in panel relief. Tested against the
      software rasteriser on real WebGPU (Dawn on lavapipe) and Chromium
      WebGL2 with the key light and with a light list: within 1 of the
      software frame in every channel on both. Lockout's walls bake a relief
      from the height their normal map comes from and chip along their rims,
      the soldiers' paint and the first-person sleeves are lacquered, the
      visor is coated, and the weapons' gunmetal is brushed.
- [x] **I5. Refraction and distortion.** A pass that bends what's behind a
      surface: glass, plasma, shield shimmer, active camouflage, heat haze.
      *Lockout:* the shield flare and the sword's blade warp the view behind
      them.
      *Done:* `MeshMaterial` gains `refraction` (a bend by the surface normal
      seen from the camera) and `distortion` (a warp of drifting value noise),
      and a surface effect gains `distort`, which a shield's flare and recharge
      now carry (`refraction.ts`). Every renderer keeps the opaque scene and
      lets a refracting fragment read it at its own pixel pushed by the offset:
      a blended surface lays its colour over the bent view, an added one adds to
      it, a shield lets it through at its silhouette, and Active Camo's dropped
      pixels show it instead of the view straight behind. A nearer object is
      never pulled in: the pushed pixel counts only if the scene drew it behind
      the surface. The software rasteriser snapshots its frame as the
      see-through triangles begin. WebGPU copies the colour target (or resolves
      it, anti-aliased) between its two passes and binds it beside the depth it
      already reads for soft edges. WebGL2 has no free texture unit, so it packs
      the colour into the soft edges' depth copy: an RGBA32F texture with the
      depth in R and the 8-bit RGB as one exact integer in G. Refracting draws
      batch after the opaque scene, farthest first, covering what they bend.
      Drawn over what was already there, the software path also bends pixels it
      didn't draw, which is how the first-person sword on the front layer bends
      the scene. The GPU renderers bend only what they drew. The Material panel
      has Refraction and Shimmer for see-through materials and a Heat haze
      preset; Glass now bends. Tested against the software rasteriser on real
      WebGPU (Dawn on lavapipe) and Chromium WebGL2, including anti-aliased
      frames: within 1 of the software frame in every channel on both.
      *Lockout:* the energy sword has a faint additive sheath that bends and
      shimmers the view round its blade, and a shield's flare and recharge warp
      the scene at the body's edge. Active Camo's bend comes with the effect.

## Phase B — World and sky

- [ ] **I6. Imported sky.** An HDR panorama or cubemap in place of the
      procedural sky (it also lights the scene and fills the reflections),
      drifting cloud layers, and sky objects drawn at infinity (a ring, a
      planet, a distant structure). *Lockout:* a painted sky with the ring
      arching over the valley.
- [ ] **I7. Distant vistas.** Far terrain and backdrop meshes beyond the play
      space, cheap (impostors or one coarse level), fogged into the sky.
      *Lockout:* mountains and a forest edge around the gorge instead of a
      void.
- [ ] **I8. Light and colour pass.** An Infinite look for the lighting rig: a
      warm, strong sun, a bright sky fill, saturated team colours and a
      grading LUT; Lockout re-lit and re-baked to match. *Lockout:* bright
      noon on snow, with blue-grey metal and cyan light channels.

## Phase C — Characters and first person

- [ ] **I9. First-person arms and viewmodel animation.** Gloved hands holding
      each weapon, with idle sway, run bob, reload, melee and the sword's
      swing (supersedes H12). *Lockout:* arms on every weapon.
- [ ] **I10. Plasma weapons.** The energy sword as translucent emissive
      plasma: a hot core fading to blue edges, a glow halo, a swing trail, and
      the distortion from I5. *Lockout:* the sword, the plasma grenade.
- [ ] **I11. Spartans.** A higher-detail armour model with team-colour masks,
      a reflective visor (I3 and I4), and the armour's own animation set.
      *Lockout:* bots that read as Spartans at a distance.

## Phase D — Content and editor tools

- [ ] **I12. HUD authoring.** Vector (SDF) fonts at any size, arcs and curved
      bars as UI widgets, and a holographic style (thin lines, glow, a curve
      toward the edges) (supersedes the rest of H16). *Lockout:* the shield
      arc, the motion tracker and the ammo counter rebuilt in the UI tab.
- [ ] **I13. Asset pipeline for artist-made content.** Skinned glTF with its
      animations and material sets imported in one step, texture conventions
      (packed occlusion/roughness/metal maps), compressed textures by default,
      and a documented Blender workflow. The editor can't stand in for a 3D
      artist, so this is how real art gets in.
- [ ] **I14. Modular kits and blockout tools.** Snapping kit pieces edge to
      edge, prefab variants, and simple in-editor mesh editing (extrude,
      bevel, inset) for blockouts and quick fixes.
- [ ] **I15. Texture baking.** Bake ambient occlusion, curvature and
      thickness from a mesh in the editor, feeding the wear masks of I4.
- [ ] **I16. A Forerunner kit for Lockout.** The arena rebuilt from a designed
      modular kit: chamfered, layered, angular forms with inset light
      channels, at a higher texture resolution, using I4, I14 and I15.

## Phase E — Optional lighting tech

- [ ] **I17. Dynamic bounce light.** Probes that relight as lights move, so a
      time of day or a moving light still bounces (today's bounce is baked).
