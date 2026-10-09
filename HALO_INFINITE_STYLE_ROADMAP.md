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

- [x] **I6. Imported sky.** An HDR panorama or cubemap in place of the
      procedural sky (it also lights the scene and fills the reflections),
      drifting cloud layers, and sky objects drawn at infinity (a ring, a
      planet, a distant structure). *Lockout:* a painted sky with the ring
      arching over the valley.
      *Done:* the sky dome (`ProceduralSky`) gains three things
      (`skyLayers.ts`). An imported **panorama**: an equirectangular PNG, JPEG
      or Radiance `.hdr` (our own RGBE decoder, run-length scanlines included,
      exposed into 8 bits), kept as base64 in the lighting rig, turned and
      brightened, and baked in place of the procedural sky. Like that sky it is
      both the backdrop and the image-based light. **Sky objects** at infinity:
      a ring (a great-circle band with land, water and cloud on its inner face,
      rim walls, day under the sun's bearing and its own night opposite, hazed
      toward the horizon) and planets (a lit disc with a soft terminator, seas
      and an atmospheric halo), baked in front of the sky and behind its clouds
      and mountains, so metals reflect them. **Cloud layers** that drift: a
      tileable density map per layer on a plane overhead, composited over the
      backdrop every frame as the wind moves it, and laid once, at rest, over
      the reflections' copy. The Lighting panel imports a panorama (exposure,
      turn), adds rings and planets (colour, width or size, tilt) and cloud
      layers (cover, size, wind, opacity). A cubemap is not taken directly;
      an equirectangular export of it is. *Lockout:* the ring arches over the
      valley from one horizon to the other, a pale moon hangs in the east, and
      two decks of cloud drift across a lighter painted sky.
- [x] **I7. Distant vistas.** Far terrain and backdrop meshes beyond the play
      space, cheap (impostors or one coarse level), fogged into the sky.
      *Lockout:* mountains and a forest edge around the gorge instead of a
      void.
      *Done:* a terrain marked as a **vista** (`Terrain.vista`, with its
      `haze`) is a panoramic impostor (`vista.ts`). When the scene loads, it
      and any foliage set on it are drawn once into the sky panorama from the
      play space's centre. They are rendered through six 90° cube faces by the
      software rasteriser, lit by the rig, the sky's own light, the fog and a
      shadow map of their own. Then they are resampled to the panorama with
      soft, coverage-weighted edges, and the nearer of overlapping vistas
      wins. **Aerial haze** fades each pixel by its distance toward the air:
      the sky without its ring and planets, so those stay behind the range
      instead of ghosting through it. A vista costs nothing per frame. It
      shows on every backend (the backdrop is painted before the scene), metals
      reflect it, and it is re-drawn when an edit changes it or the rig. It
      stays out of the instances and the gameplay terrains: nothing stands on
      it, collides with it or frames the camera by it. It has no parallax,
      which is right where the play space is small next to the vista's
      distance. Baking takes about a second at load for Lockout's range, in
      the software rasteriser. The Terrain panel marks a terrain as a vista
      and sets its haze. *Lockout:* a 2.4 km far range (`lockoutVista`) with
      the near range and the gorge cut out of its middle. Forested valleys
      ring the near mountains, with dark pines on their gentle ground, and
      climb to a wall of snow-capped peaks that fade into the sky with
      distance. They show above the near ridges and through the notch in the
      east.
- [x] **I8. Light and colour pass.** An Infinite look for the lighting rig: a
      warm, strong sun, a bright sky fill, saturated team colours and a
      grading LUT; Lockout re-lit and re-baked to match. *Lockout:* bright
      noon on snow, with blue-grey metal and cyan light channels.
      *Done:* the post-process stack gains a **grading LUT** (`lutModel.ts`):
      a 3D lookup table, held by the single-pass shader as a strip of blue
      slices and read trilinearly (bilinear within a slice, the two slices
      either side mixed by hand). There are four built-in looks: Infinite
      (dull colour lifted, a touch of contrast, warm highlights over cool
      blue-teal shade), Warm noon, Cold steel and Bleach bypass. A `.cube`
      from any grading tool (up to 33³) can be imported in the FX tab and is
      kept on the effect stack, with a strength to blend it in. In a real
      browser every colour lands within 3 levels of the CPU reference. A rig
      can carry its own **team colours** (`SceneLighting.tints`): the armour
      palette carts tint from, entry by entry, re-tinted live when edited.
      The Lighting panel picks them, with a saturated set (`INFINITE_TINTS`)
      that holds up under a bright sun. There is also an **Infinite
      daylight** preset (`infiniteDaylightLighting`): a warm, strong sun about
      55° up, a bright blue sky fill from the far side, a clear noon dome
      that is also the image-based light, ACES, shadows and the saturated
      colours. *Lockout:* re-lit for noon. The sun is 52° up, warm and
      stronger, over a clear deep-blue dome, a lighter blue fill and thinner
      haze. Snow is whiter, the team colours are saturated, and the FX grade
      runs through the Infinite LUT (the split tone is down to a whisper).
      The light map and probes are re-baked for the new sun. The
      Forerunner metal keeps its blue-steel cast and its cyan channels.

## Phase C — Characters and first person

- [x] **I9. First-person arms and viewmodel animation.** Gloved hands holding
      each weapon, with idle sway, run bob, reload, melee and the sword's
      swing (supersedes H12). *Lockout:* arms on every weapon.
      *Done:* every Lockout viewmodel is skinned to a three-bone rig. The
      **root** carries the whole held assembly (sway, bob, a lunge, the raise
      on a swap), the **weapon** under it takes recoil and a reload's tilt, and
      the **left hand** under that leaves the gun in a reload to fetch the
      magazine, slaps it home and returns. Each weapon carries six clips:
      `idle` (a slow breathing sway), `run` (a stepping figure-eight bob),
      `fire` (kick back and muzzle up, harder on the shotgun and sniper),
      `reload`, `melee` (a lunge, the stock leading) and `ready` (raised from
      below). The sword's attack and melee are one swing, wound back to the
      right and carried across to the left, and a flourish stands in for its
      reload. A state machine runs it (EP17): a blend from idle to run by
      `speed`, and one-shot states on `fire`, `reload`, `melee` and `ready`
      triggers that play through and fade back; a shot during a shot starts
      the kick again. The cart only reports what happened, so the
      hand-rolled bob and kick are gone from its code. Storage: a skinned
      part bound wholly to one joint is now saved as just that joint, not 24
      bytes a vertex (read back into the same binding), so six rigs cost
      about 60 KB rather than 280. *Lockout:* arms on every weapon, swaying
      at rest, bobbing at a run, kicking on every shot, reloading
      hand-to-magazine, lunging on a melee and raising the new gun on a swap.
- [x] **I10. Plasma weapons.** The energy sword as translucent emissive
      plasma: a hot core fading to blue edges, a glow halo, a swing trail, and
      the distortion from I5. *Lockout:* the sword, the plasma grenade.
      *Done:* **plasma** (`plasma.ts`) is a material graph, so it runs alike
      on every renderer. Its emissive goes from a white-hot core face on to
      an electric-blue edge at the silhouette by the fresnel, flickered by
      noise drifting up through it. Its alpha goes from nearly opaque at the
      heart to faint at the edge. It has a black base (light adds nothing)
      and a faint shimmer of the view behind. The Material panel has a Plasma
      preset and the graph editor a Plasma graph. **Swing trails**
      (`meshTrails.ts`): a mesh can declare trails, each a segment in its
      own space (on a joint, for a skinned mesh) whose sweep over the last
      fraction of a second is drawn as an additive ribbon. The ribbon fades
      with age, is brightest at the segment's far end, and appears only above
      a speed. The player records every trailing object each frame and draws
      the ribbons on its layer, through the same path particles take. A
      front-layer object's trail is kept in the camera's space, so a held
      sword trails its swing, not the player's turning or running. Trails
      are stored on the mesh. *Lockout:* the sword's blade is plasma inside
      the I5 heat haze, which bends and shimmers the view as its halo, and
      its swing (I9) leaves an arc of blue light from the emitter to the
      tips. Grenades are now plasma grenades. Four copies are held in reserve
      and spawned on a throw: a boiling blue charge in a cage of dark prongs,
      trailing light and lighting what it passes. It sticks to the first
      soldier it reaches (not its thrower) and goes off in a ball of blue
      plasma. Until now grenades were invisible in flight.
- [x] **I11. Spartans.** A higher-detail armour model with team-colour masks,
      a reflective visor (I3 and I4), and the armour's own animation set.
      *Lockout:* bots that read as Spartans at a distance.
      *Done:* **team-colour masks** by part: a tintable material's `tintMix`
      is the share of the team colour it takes. At 1 (the default) the part
      is painted the colour outright, as before; below 1 the colour is mixed
      into its own, so trims and secondary plates pick up a hint of it. The
      Material panel has "Takes the team colour" and a share slider. Lockout's
      soldier is rebuilt as a **Spartan** on the same skeleton:
      - Team-colour plates: a layered chest plate, broad pauldrons,
        gauntlets, thigh plates and shin guards.
      - Brushed gunmetal trim that takes a fifth of the team colour: the
        chest core, collar, abdominal bands, knee and calf plates, boots with
        toe caps, cheek and neck guards, an ear module and a thruster pack.
      - A black undersuit.
      - A wraparound gold **visor**: a near-mirror (I3 reflects the arena in
        it) under a clear coat (I4), with a faint glow of its own.

      The **armour's own moves** join its clips: a melee (a step in, the
      stock driven across), a flinch when hit, and a landing that takes a
      jump in the knees. The state machine plays them on `melee` and `hit`
      triggers and after a fall, and dies from any of them. Storage: a skin
      binding where each vertex rides one joint is stored as a byte a vertex
      (not 24). The soldier is stored without normals, since its plates'
      faces share no corners and every renderer rebuilds the same flat
      normals, and its LODs are fingerprinted against the stored mesh. So the
      far more detailed Spartan stores lighter than the old soldier (88 KB
      against 90). *Lockout:* bots read as Spartans across the arena: broad
      pauldrons, a gold visor and the team colour in their plates. They swing
      their rifles up close and flinch when hit.

## Phase D — Content and editor tools

- [x] **I12. HUD authoring.** Vector (SDF) fonts at any size, arcs and curved
      bars as UI widgets, and a holographic style (thin lines, glow, a curve
      toward the edges) (supersedes the rest of H16). *Lockout:* the shield
      arc, the motion tracker and the ammo counter rebuilt in the UI tab.
      *Done:* a UI document can be `style: "holo"`, with a `curve` and a
      `glow`. The player draws holo documents in true colour over the
      finished frame. The console's own drawing still does the rest.
      - **Vector stroke font** (`strokeFont.ts`): every glyph is a few
        polylines on a 4 × 6 grid, drawn by its exact distance to them. Text
        is crisp at any `textSize`, and the same distance gives its glow.
      - **New widgets:**
        - `arc`: a `start` and `sweep` in degrees, split into `segments`
          and lit to its value's share over a dim track.
        - `radar`: rings, ticks, a turning sweep with a fading wake, and
          blips as x, y and kind triples (yours, hostile, objective).
      - **Look:** any holo widget takes an `rgb` colour or a "#rrggbb" tint
        binding and a line `thickness`. Glow eases smoothly to nothing. The
        whole document bows in toward the centre, like the inside of a visor.
      - **Cost:** the renderer (`holoHud.ts`) keeps each widget's light as a
        cached layer, and compositing a layer costs one multiply-add per
        touched pixel. Only a widget whose light changed is redrawn. The
        radar's sweep is kept apart from the radar and moves in 4° steps, so
        a steady HUD costs a composite and a sweep.
      - **Lua:** the cart's `ui.set`, `ui.show` and `ui.draw` send holo
        documents' bindings to the host as commands, once a frame and only
        what changed. Texts and lists go in chunks. The host keeps the state
        and draws it.
      - **UI tab:** a holo checkbox with curve and glow, a colour picker,
        text size, arc start, sweep and segments, line thickness, and a live
        preview drawn by the player's own renderer.

      *Lockout:* the console HUD keeps the score, feed and announcements.
      The new curved **visor** document now carries:
      - the segmented shield arc, flashing red when low, over the health arc;
      - the motion tracker, with hostile and objective blips under a
        turning sweep;
      - a large stroke-font ammo counter, with reserve and weapon name;
      - the plasma grenade count.
- [x] **I13. Asset pipeline for artist-made content.** Skinned glTF with its
      animations and material sets imported in one step, texture conventions
      (packed occlusion/roughness/metal maps), compressed textures by default,
      and a documented Blender workflow. The editor can't stand in for a 3D
      artist, so this is how real art gets in.
      *Done:* the editor's **Import 3D model** now takes everything a model
      brings, in one step:
      - its mesh, skeleton and clips;
      - a **state machine** to start from, one looping state per clip;
      - its PBR maps;
      - its **material sets** (`KHR_materials_variants`, up to 16), stored
        with the mesh.

      **Texture conventions:**
      - Images are read once each by glTF image index. A **packed ORM map**
        (R occlusion, G roughness, B metal) in both of its slots is therefore
        one image: stored, downloaded and decoded once.
      - A texture shared across materials or sets is kept once too.
      - The player decodes each distinct image once per mesh.

      **Material sets:** each placed copy chooses a set, which the scene
      entry stores as `variant`, the Mesh tab's **Material set** box edits
      and previews, and the player applies on load. Copies in the same set
      share one dressed mesh, and their LODs wear it. **Export .glb** now
      writes every PBR map once and the sets with them.

      **Compressed textures by default:** an import's PNG and JPEG maps are
      encoded to KTX2 with the Basis Universal encoder. It is vendored beside
      the transcoder and fetched only by the editor, only when there are maps
      to compress.
      - Colour maps are encoded as ETC1S, in sRGB.
      - Normal and ORM maps are encoded as near-lossless UASTC with RDO and
        Zstd, in linear space, and read raw from the source image.
      - KTX2 is kept by the existing rule: it must travel lighter, and also
        pay for the transcoder if the scene has none yet. So a prop keeps its
        PNG and a textured character goes compressed.
      - Everything the encoder writes, the player's transcoder reads back
        closely (tested for every kind).

      **Blender workflow:** `BLENDER_WORKFLOW.md` covers export settings,
      skeleton and clip rules, the Principled-BSDF-to-slot table with colour
      spaces, ORM packing, variants, compression, and the limits.
      *Lockout:* the Spartan ships with two armour sets the bots take turns
      wearing:
      - **Veteran:** the lacquer worn off to matte, scuffed plates, with
        bronze trim and an amber visor.
      - **Recon:** satin plates with brushed (anisotropic) trim and a cold
        silver visor.

      All keep the team colour.
      *Not yet:* skeletons and clips in GLB export, a second UV set and morph
      targets on import, and uploading textures to the GPU still compressed
      (KTX2 is transcoded to RGBA, so the saving is in download size).
- [x] **I14. Modular kits and blockout tools.** Snapping kit pieces edge to
      edge, prefab variants, and simple in-editor mesh editing (extrude,
      bevel, inset) for blockouts and quick fixes.
      *Done:* **mesh editing** (`meshEdit.ts`) works on faces as a modelling
      tool shows them: coplanar triangles that share vertices edge to edge.
      - **Extrude** moves a face along its normal and builds walls (negative:
        a recess).
      - **Inset** shrinks it in its plane, leaving a ring of quads.
      - **Bevel** insets and lifts or sinks the inner face, so the ring
        slopes: a chamfer, or a sunken channel.
      - Edits keep a mesh closed and consistently wound (tested by edge
        pairing and exact volumes), and flat-shade what they make.
      - New walls get texture coordinates at the face's own density.
      - The edited face keeps its triangles, so edits chain (inset, then
        extrude what's left).
      - The light map, which no longer fits, is dropped; skinned meshes are
        left to the modelling tool.

      **In the Mesh tab:** a click (not a drag) on the preview picks a face,
      using `renderMesh`'s own orbit camera (`orbitView`, `pickMeshTriangle`).
      The face is outlined, and Extrude, Inset and Bevel act on it. An edit
      remakes the object's LODs (other copies of the old model keep theirs).

      **Kit snapping** (`kitSnap.ts`, the viewport's **Kit** toggle): a
      dragged piece whose box comes within reach of another's opposite face
      closes the gap without passing into it. Along the other two axes it
      lines its edges up — floor to floor, face to face, or centred.

      **Prefab variants:** a variant is a prefab made from another (its
      base), with its own full nodes, which is all the runtime sees. Applying
      a change to the base updates the variant:
      - every field the variant had left matching the base takes the new
        value;
      - parts new to the base are added;
      - parts the base dropped go, unless the variant had changed them.

      Then the variant's copies and its own variants follow. A variant can
      also wear another material set (`variant` on prefab nodes). The prefab
      library makes variants and marks them ◇, with their change count.
      *Lockout:* a starter **Forerunner kit** in its prefab library, on a
      4 m grid, every piece modelled with the editor's own face edits from a
      box:
      - a wall with a bevelled, recessed front plate and a chamfered top;
      - a **lit wall**, a variant of the wall that adds a glowing light
        channel in the recess;
      - a pillar with a chamfered cap and sunken side panels;
      - a seamed floor tile.

      The arena's rebuild from them is I16.
- [ ] **I15. Texture baking.** Bake ambient occlusion, curvature and
      thickness from a mesh in the editor, feeding the wear masks of I4.
- [ ] **I16. A Forerunner kit for Lockout.** The arena rebuilt from a designed
      modular kit: chamfered, layered, angular forms with inset light
      channels, at a higher texture resolution, using I4, I14 and I15.

## Phase E — Optional lighting tech

- [ ] **I17. Dynamic bounce light.** Probes that relight as lights move, so a
      time of day or a moving light still bounces (today's bounce is baked).
