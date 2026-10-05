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
- [x] **H8. Sun glare and lens flare** in the post-effects stack.
      *Done:* a "Sun glare & lens flare" post effect: a soft glow and a
      six-pointed starburst round the sun, and five tinted lens ghosts strung
      from it through the frame centre, all in the one post pass (its maths in
      `flareModel.ts`, unit-tested). In a 3D scene with a sky dome the first-
      person overlay reports each frame where the sun is and how much of its
      disc still shows the sky, eased, so the flare tracks the sun and fades as
      a tower slides across it; elsewhere it sits at the effect's source point.
      Glare, ghosts, size and colour are editable in the FX tab. Lockout's sun
      flares over the towers and the ghosts cross the frame.

## Phase C — Characters and feel (mostly existing features)

- [x] **H9. Ragdoll deaths.** Killed soldiers go limp on physics joints and
      tumble; cosmetic, simulated locally, so online play is unaffected.
      *Done:* `cartbox.ragdoll(obj, ix, iy, iz, joint)` turns a skinned object
      into a ragdoll — a Verlet body of its own (a particle per joint, bones
      held to length, siblings keeping the torso rigid, grandparent limits so a
      knee bends but never folds) that lands on the scene's static bodies and
      authored collider boxes, rests on its armour (radii fitted to the mesh
      round each bone) and sleeps once settled. The skeleton's pose is rebuilt
      from it every frame, over the animation and IK, and it stays where it fell
      however the object is moved; `cartbox.unragdoll` stands it back up. It
      runs apart from the physics world, so the deterministic checksum and
      online play never see it. The Mesh tab's Animation panel can drop a
      skeleton as a ragdoll to preview it. Lockout's soldiers are thrown away
      from whoever killed them (harder for a headshot) onto the arena's own
      collider boxes, and lie there until just before they respawn.
- [x] **H10. Cosmetic physics debris.** Ejected shell casings and dropped
      weapons as spawned physics props (prefabs + bodies), local only.
      *Done:* debris definitions on the mesh sidecar each wear the look of a
      prefab (whose mesh never sits in the level) or a scene object, optionally
      leaving parts off by material. `cartbox.debris(name, x, y, z, vx, vy, vz,
      scale)` throws a copy, which the player simulates as a small rigid body of
      its own — its box's eight corners held rigid, landing on the scene's
      static bodies and ragdoll colliders with the definition's bounce and
      friction, spinning, settling, then shrinking away at the end of its life,
      the oldest recycled past a cap. Like the ragdolls it never touches the
      physics world, so online play is unaffected. The Mesh tab's "Debris" panel
      edits the definitions and previews them tumbling onto a floor. Lockout
      ejects brass casings with every shot (the player's and nearby bots') and
      drops a killed soldier's weapon — the first-person model without its
      hands — to clatter on the deck.
- [x] **H11. Shield effects.** A per-pose material override: the shield flare
      when hit, the recharge shimmer, and an Active Camo refraction.
      *Done:* a scene instance can carry a surface effect over its PBR
      materials: a fresnel rim added to the material's, an untextured glow,
      bands of light climbing the body, and camo. All three renderers draw it
      the same way. Camo is screen-door transparency: an ordered-dither pattern
      that crawls with time and drops the same pixels on the CPU, in WGSL and
      in GLSL. None of the renderers blends, so it is a see-through outline
      rather than true refraction. `cartbox.shield(obj, flare, shimmer, camo)`
      sets a standing effect on an object and everything under it. Only
      changes are sent, so a cart can call it every tick. The gold flare, the
      white-gold shimmer and the cool camo edge come from one mapping
      (`shieldEffect`). The Mesh tab's "Shield effects" sliders preview it on
      the selected object. Lockout soldiers' shields flare gold where they're
      hit and fade over a few ticks. Shields now recharge, Halo-style: after
      4 s without a hit they refill over 2 s, shimmering as they climb, and a
      soldier another browser owns shimmers too.
- [ ] **H12. Viewmodel animation.** Reload, melee and run-bob clips on the
      held weapons, and first-person arms.
- [ ] **H13. More timelines.** A killcam and a post-game camera sweep.

## Phase D — World and presentation

- [x] **H14. Audio.** Imported sound files, a mixer, and 3D positional sound
      through Web Audio. *Lockout:* weapon sounds, gorge wind, the announcer.
      *Done as ENGINE_PARITY_ROADMAP.md EP12.*
- [ ] **H15. Imported skybox.** A painted cubemap or HDR sky in place of the
      procedural one, with drifting clouds.
- [ ] **H16. HUD authoring.** Build a HUD (arcs, bars, radar, icons) in the
      editor instead of hand-coding rectangles.
      *Partly done by ENGINE_PARITY_ROADMAP.md EP13:* bars, text, lists and
      icons are authored in the UI tab and Lockout's HUD is a UI document;
      arcs and the radar are still drawn in code.
