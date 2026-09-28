# Halo 2 art style roadmap

Editor and engine upgrades aimed at the Halo 2 look, each applied to the
Lockout demo as it lands. Ordered by visual payoff per unit of work; each item
ships as its own PR with tests, and the Lockout demo uses it in the same PR.

Companion to [`ENGINE_ROADMAP.md`](ENGINE_ROADMAP.md) (which tracks the
general Unity/UE5 gap); items here that close a line there tick it off too.

## Phase A — Light and surface (the biggest step toward the look)

- [x] **H1. Baked lighting.** Halo 2's soft, grounded look is baked radiosity:
      dark creases where walls meet floors, soft shade under overhangs, light
      bouncing off snow. The editor bakes a light map for a scene's still
      objects — sky visibility (ambient occlusion) and one bounce of sky and
      sun light — into a second UV set it lays out itself, and every renderer
      (software, WebGL2, WebGPU) multiplies the ambient and sky light by it.
      *Editor:* a "Bake lighting" panel in the Mesh tab, beside Navigation.
      *Lockout:* the arena ships baked.
      *Done:* `lightmap.ts` unwraps planar charts into a power-of-two atlas and
      traces sky visibility plus a sun bounce against a BVH; a mesh stores the
      light map once however many primitives share it. Lockout's 512² bake is
      stored with a fingerprint of the geometry it was made for (`npm run
      bake:lockout` redoes it); the editor's "Baked lighting" panel bakes any
      scene's still objects.
- [x] **H2. Reflection probes.** Forerunner metal is bump-mapped and
      reflective; today it can only reflect the sky dome. Placed probes bake
      a small panorama of the scene around them, and nearby metal reflects
      that instead of the sky (box-projected so reflections line up with the
      walls). *Lockout:* probes in bottom mid, the towers and the walkway.
      *Done:* probes live on the lighting rig as a capture point and a box
      each (the Lighting panel edits them); the player bakes their panoramas
      from six cube faces after the scene loads, one probe per tick, into one
      atlas. Every renderer picks the smallest box around a fragment, fades it
      in over a unit from the box's faces, and box-projects the reflection.
      Lockout has five: bottom mid, the walkway, both towers and the arena.
- [x] **H3. Material upgrades.** Detail textures (a second, finely tiled map
      blended in up close), animated emissive (scroll and pulse, so energy
      lines flow), and a fresnel/rim term with a reflection mask.
      *Lockout:* grain on the walls up close, pulsing cyan trim.
      *Done:* materials carry a detail map (with scale and strength; it fades
      out between 3 and 12 units), an emissive scroll and pulse, a rim (colour,
      power, strength), a reflectivity and a reflection mask read from the
      metallic-roughness map's alpha — edited under "Surface effects" in the
      Material panel, with a built-in grain for the detail map. All three
      renderers match pixel for pixel. Lockout's walls and deck share one
      grain, the trim breathes with the panels' glow, and the metal gets a
      cold rim with reflections masked to its polished panels.
- [x] **H4. Terrain blending and shadows.** Snow and rock blend smoothly by
      slope and height instead of splitting per triangle, and cliffs can cast
      into the play area's shadow. *Lockout:* soft drifts and wind-scoured
      ridges; the gorge walls shade the deck at low sun.
      *Done:* a terrain's `blend` band gives each vertex soft layer weights
      (smoothstep across its slope and height bounds, the edge wandered by
      noise); triangles where two layers meet go into a blended primitive
      whose material mixes in the other layer's albedo and roughness by a
      per-vertex weight (an eleventh vertex float, in all three renderers).
      `castShadows` puts the terrain into the static shadow map, with the
      light backed off and its bias scaled so thin casters still shadow.
      Lockout's snow drifts into the rock, and the gorge walls cast.

## Phase B — Effects (makes a fight read as Halo)

- [x] **H5. 3D particles.** World-space emitters the cart can fire in bursts
      (`cartbox.burst`) — sparks, plasma, explosions, blowing snow, glowing
      trails — with an editor preview. The existing screen-space weather stays.
      *Lockout:* bullet sparks, grenade blasts, sword trail, snow off ledges.
      *Done:* effects (six presets, every field tunable) live on the mesh
      sidecar; `cartbox.burst(name, x, y, z, dx, dy, dz, scale)` rides the
      runtime block to the player, which simulates them and draws them as
      camera-facing billboards in the scene — depth-tested, glowing ones
      emissive for bloom — identically on every backend. The Mesh tab's
      "Particle effects" panel previews each one looping. Lockout sparks off
      walls and shields, blasts grenades with smoke, trails the sword swipe
      and blows snow off its high ledges.
- [x] **H6. Decals.** Projected marks that fade: bullet pocks, plasma scorch,
      grenade burns, plus authored glyphs and frost streaks.
      *Lockout:* impact marks where shots land.
      *Done:* decals (five presets: pock, scorch, burn, glyph, frost) live on
      the mesh sidecar with size, life, tint and glow. `cartbox.decal(name, x,
      y, z, nx, ny, nz, scale)` lays a mark flat on a surface; it fades over the
      end of its life and the oldest is recycled past a cap. The scene can also
      carry permanent marks placed in the Mesh tab's "Decals" panel, which
      previews each decal on a wall. Marks are quads just off the surface,
      drawn in the scene (depth-tested, glowing ones emissive) on every
      backend. Lockout leaves pocks where shots hit walls and burns where
      grenades go off, and carries Forerunner glyphs on the towers and frost
      streaks on the high ledges.
- [x] **H7. Volumetric fog and light shafts.** Height fog and fog volumes;
      sun shafts through gaps. *Lockout:* mist pooling in the chasm.
      *Done:* the fog gains a height layer (dense below a base, thinning
      exponentially above), up to four fog volumes (boxes of mist, densest at
      their floor) and a sun glow, all integrated exactly along the ray from the
      eye — the same maths in the software rasteriser, WGSL and GLSL (the GPU
      matches the CPU to a level). Sun shafts are a screen-space pass over the
      finished frame: open sky near the sun, found by comparing the frame with
      its sky backdrop, streams past the geometry's edges, so it is identical on
      every backend. The Lighting panel edits the new fog layers and the shafts,
      and the Mesh tab's viewport now shows the fog. Lockout's chasm fills with
      a cloud sea under the deck, the haze brightens toward the sun, and beams
      break past the towers and the walkway.
- [ ] **H8. Sun glare and lens flare** in the post-effects stack.

## Phase C — Characters and feel (mostly existing features)

- [ ] **H9. Ragdoll deaths.** Killed soldiers go limp on physics joints and
      tumble; cosmetic, simulated locally, so online play is unaffected.
- [ ] **H10. Cosmetic physics debris.** Ejected shell casings and dropped
      weapons as spawned physics props (prefabs + bodies), local only.
- [ ] **H11. Shield effects.** A per-pose material override: the shield flare
      when hit, the recharge shimmer, and an Active Camo refraction.
- [ ] **H12. Viewmodel animation.** Reload, melee and run-bob clips on the
      held weapons, and first-person arms.
- [ ] **H13. More timelines.** A killcam and a post-game camera sweep.

## Phase D — World and presentation

- [ ] **H14. Audio.** Imported sound files, a mixer, and 3D positional sound
      through Web Audio. *Lockout:* weapon sounds, gorge wind, the announcer.
- [ ] **H15. Imported skybox.** A painted cubemap or HDR sky in place of the
      procedural one, with drifting clouds.
- [ ] **H16. HUD authoring.** Build a HUD (arcs, bars, radar, icons) in the
      editor instead of hand-coding rectangles.
