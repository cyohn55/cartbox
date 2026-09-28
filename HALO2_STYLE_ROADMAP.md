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
- [ ] **H3. Material upgrades.** Detail textures (a second, finely tiled map
      blended in up close), animated emissive (scroll and pulse, so energy
      lines flow), and a fresnel/rim term with a reflection mask.
      *Lockout:* grain on the walls up close, pulsing cyan trim.
- [ ] **H4. Terrain blending and shadows.** Snow and rock blend smoothly by
      slope and height instead of splitting per triangle, and cliffs can cast
      into the play area's shadow. *Lockout:* soft drifts and wind-scoured
      ridges; the gorge walls shade the deck at low sun.

## Phase B — Effects (makes a fight read as Halo)

- [ ] **H5. 3D particles.** World-space emitters the cart can fire in bursts
      (`cartbox.burst`) — sparks, plasma, explosions, blowing snow, glowing
      trails — with an editor preview. The existing screen-space weather stays.
      *Lockout:* bullet sparks, grenade blasts, sword trail, snow off ledges.
- [ ] **H6. Decals.** Projected marks that fade: bullet pocks, plasma scorch,
      grenade burns, plus authored glyphs and frost streaks.
      *Lockout:* impact marks where shots land.
- [ ] **H7. Volumetric fog and light shafts.** Height fog and fog volumes;
      sun shafts through gaps. *Lockout:* mist pooling in the chasm.
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
