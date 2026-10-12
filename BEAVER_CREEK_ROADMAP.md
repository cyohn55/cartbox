# Beaver Creek roadmap

A second multiplayer map, **Beaver Creek** (Halo 2's remake of Halo: Combat Evolved's Battle Creek). It plays every mode, with bots, offline and online, and carries Lockout's whole sandbox:

- the 22 weapons (`LOCKOUT_ARSENAL_ROADMAP.md`);
- the grenades;
- the equipment (`LOCKOUT_EQUIPMENT_ROADMAP.md`).

On the way, the editor and renderer learn what an outdoor Halo Infinite map needs, and the Spartans are rebuilt toward Infinite's Mark VII look.

This roadmap takes over Phase C of `LOCKOUT_MULTIPLAYER_ROADMAP.md`:

| This roadmap | Takes over |
| --- | --- |
| B1 | L9 |
| B2 | L10 |
| B3 | L11 |
| B8 and B9 | L12 |

Beaver Creek replaces the Forerunner outpost L12 imagined.

## Ground rules

- **Original homages, faithful layouts.** The art is ours: no meshes, textures or sounds are taken from Halo or from rips of it. The Sketchfab models linked with the request are references for layout and look only.
- **The layout plays like the original.** It has the same:
  - bases;
  - routes and sightlines;
  - heights and distances (scaled to Lockout's units: a Spartan is 1.8 m tall and walks 4.5 m/s);
  - weapon spawns and teleporters.

  Where the art departs from Halo, the collision does not.
- **Everything a map is can be made by hand.** Maps are also built from code, as Lockout is, but nothing about a map should need code: its model, its collision and its markup can all be authored in the editor or in Blender (B4).
- **One sidecar per map.** Shared assets (Spartans, weapons, sounds, effects, UI) ship once. A match loads only its own map. This also cuts the memory a match needs, which matters on iPhone and iPad: see "Open questions".
- **Each item ships as its own PR with tests, merged when CI is green.**

## Where things stand

**Spartans can be made by hand today:**
- **In Blender:** export the soldier to GLB, reshape, rig and paint it there, and bring it back with the Mesh tab's **Replace model**. `BLENDER_WORKFLOW.md` covers the round trip (L13, L14).
- **In the editor:** vertex/edge/face modelling, pose mode, weight painting, the dope sheet, UV unwrap and texture painting (L15–L17).
- **In the demo:** `/lockout?assets=<cart>` plays a saved cart's Spartans, viewmodels and pickups.

**Maps cannot be made by hand yet.** The demo never takes its arena from a saved cart:
- A map's collision, spawns, weapon pads, hills, ball spawn, bot destinations and navmesh come from tables written in code (`ArenaMap`, `forerunnerArena.ts`).
- Terrain is visual only: nothing can stand on it.
- The light map, probes and kit maps are baked by Lockout-only scripts.

**The renderer** has:
- PBR with clearcoat, anisotropy and refraction;
- shadow maps with a near cascade;
- SSAO;
- light maps and probes with dynamic bounce;
- reflection probes and SSR;
- TAA and MSAA;
- a procedural sky with clouds;
- height and volume fog with light shafts;
- terrain with up to four blended layers;
- foliage instancing;
- decals, particles and trails.

It has none of the following, all of which an outdoor Infinite map leans on:
- **water;**
- **wind sway** for grass and trees;
- **triplanar** rock on steep terrain;
- **walkable terrain.**

## Layout to match (to be confirmed)

From memory of Battle Creek and Beaver Creek. The linked model can't be opened from the build sandbox, so each point is to be checked against it. Corrections change only the map's data (B8), not the work around it.

1. **A small, symmetric box canyon**, longer than it is wide. Two identical bases stand at its ends and face each other.
2. **A shallow creek runs through the middle**, wadeable. It is crossed by a **natural rock arch** that players can stand on.
3. **Each base has two storeys.**
   - The ground floor opens toward the creek and holds the flag.
   - A ramp inside climbs to the upper floor, whose window overlooks the middle.
   - The roof can be stood on.
4. **Grassy banks and ledges line the canyon's sides**, with trees, boulders and a short cave or tunnel. The ledges are high ground over the creek.
5. **Teleporters link each base to the far side of the map.**
6. **Weapons:**
   - Sniper Rifles at the bases.
   - The Rocket Launcher in the middle, by the creek and the arch.
   - Rifles, SMGs and Covenant weapons along the banks.
   - Grenades by the bases.

   On our map the pads rotate through the sandbox as Lockout's do, each pad starting on its Halo weapon.
7. **Spawns:**
   - Team modes spawn each team in and around its own base.
   - Free for All spawns spread round the whole map.

## Phase A: maps as data, and by hand

- [x] **B1. Bakes that know their map** (L9).
  - One command, `npm run bake:map <id>`, bakes a map's light map, probes and kit maps into that map's own generated files.
  - A stale bake fails CI for every map instead of silently falling back to unlit.
  - Probes get the freshness check they lack today.
  - *Lockout:* bakes through the same command.
  - *Tests:* changing a map's geometry without re-baking fails its test.
  - **Done.**
    - `mapBakes.ts` holds `MAP_BAKES`: each map's layout, its light-map, probe and kit bakers, its stored fingerprints, and its generated files.
    - `npm run bake:map <id> [lightmap,probes,kit]` (`scripts/bake-map.mjs`, through `Unit Tests/map-bake.test.ts`) bakes the parts asked for. The old `bake:lockout*` scripts now call it.
    - `Unit Tests/map-bakes.test.ts` checks every registered map's light map, probes (new) and kit maps, and names the command to run.
    - Re-baking Lockout through it reproduced the stored light map, probes and kit maps byte for byte; only their header comments changed.

- [ ] **B2. A shared asset pack and a sidecar per map** (L10).
  - The Spartans, viewmodels, pickups, kit, sounds, effects, UI, actions and strings move into a shared pack.
  - Each map's sidecar holds only its own geometry, terrain, lighting, probes, navmesh and markup, and references the pack.
  - The cart is built per map, from that map's `ArenaMap`. Pad rotations and Pickup placement come from the map's markers, not Lockout's.
  - The title menu picks the map. The host's match word carries the map's id online, and matchmaking playlists rotate maps.
  - The page loads only the chosen map's sidecar.
  - *Lockout:* plays as before, from its own sidecar plus the pack. A match holds one map's data plus the pack, never two maps.
  - *Tests:* each map loads with the pack; both stay under budget; a guest loads the host's map.

- [ ] **B3. Collision from the map's own geometry** (L11).
  - A map's collision is its own layer: boxes, ramps and walkable terrain.
  - Terrain gets collision in the cart (a heightfield the soldier stands and walks on) and goes into the bot navmesh.
  - Deployables (Drop Wall and the rest) learn the heights a canyon needs. Today they are limited to ±25.6 m.
  - A **map validator** checks that:
    - every spawn stands on floor;
    - the navmesh reaches every destination, hill, pad and spawn;
    - no visible geometry stands proud of the collision where a player would catch on it;
    - nothing falls through the death plane;
    - the map is under budget.
  - *Lockout:* passes the validator.
  - *Tests:* the validator flags each failure on purpose-broken maps, and a soldier walks up a terrain slope.

- [ ] **B4. Maps made by hand.** A map can be built in the editor, in Blender, or both, and played in the demo.
  - **Its model:** a scene of meshes, terrain, foliage, water, lights and sky, imported as GLB from Blender (`BLENDER_WORKFLOW.md` gains a maps chapter) or modelled with L15–L17's tools.
  - **Its collision (B3's layer):** boxes and ramps placed with kit snapping, and terrain sculpted with the existing brushes. The collision can be generated from the model's walkable faces as a starting point and then edited.
  - **Its markup:** spawns (any team), weapon pads with their rotations, hills, the ball spawn, bot destinations and power positions, teleporters and the death plane. Each is placed and dragged in the viewport.
  - **Validation:** the editor runs B3's validator on save and lists what to fix.
  - **Play:** `/lockout?map=<cart>` plays a saved cart's map with the shared pack, offline and online. A guest receives the host's map.
  - *Beaver Creek:* its collision and markup open in the editor. Moving a pad or a spawn there and playing the result moves it in the game.
  - *Tests:* a map authored only through the editor's model (no code) passes the validator, and its bots reach every pad and hill.

## Phase B: outdoor visual quality (editor and renderer)

Each item lands in all three renderers (WebGL2, WebGPU, and the software reference), with editor controls, and keeps to the quality tiers so the iPad and iPhone tiers stay playable.

- [ ] **B5. Water.**
  - A water surface material:
    - scrolling normal maps in two directions along a flow;
    - refraction of the creek bed, with depth tint and fog;
    - sky and SSR reflection with Fresnel;
    - foam where it meets the shore or rocks (soft depth);
    - small ripples where soldiers wade and rounds land (decal-driven).
  - In the editor, a water body is drawn as a polygon over terrain at a height, with its flow direction and colours.
  - *Tests:* renderer parity on a water scene; the flow moves; the depth tint deepens with depth.

- [ ] **B6. Living terrain and foliage.**
  - Terrain layers take **triplanar** projection on steep slopes, so cliffs aren't stretched, and **height-blended** transitions (rock pokes through grass at the right places).
  - Foliage gets **wind**: grass and tree crowns sway by height, with gusts, from one wind direction shared with particles.
  - **Alpha-tested foliage cards:** grass blades and pine needles, with a cheap far LOD.
  - New presets for creek-bank plants: tall grass, reeds, ferns, broadleaf and pine trees, mossy boulders.
  - The editor's foliage panel gains the wind controls and the presets.
  - *Tests:* parity; sway is zero at the root and grows with height; triplanar matches planar on flat ground.

- [ ] **B7. Infinite-style daylight.**
  - Soft shadows with more than one cascade, sized for a canyon.
  - Contact shadows under small props.
  - SSAO tuned for foliage.
  - Sun shafts through tree crowns.
  - A grade and a sky for a clear midday valley.
  - In the editor, the lighting panel gains the cascade and contact-shadow controls.
  - *Tests:* parity; cascade transitions without seams; performance within each quality tier's budget.

## Phase C: Beaver Creek

- [ ] **B8. The blockout: Beaver Creek plays.**
  - The layout above as an `ArenaMap`: collision (boxes, ramps, terrain), team and FFA spawns, bot destinations and power positions, hills, the ball spawn and the death plane.
  - Weapon pads where Halo's are, rotating through the full sandbox.
  - **Teleporters:** new to the cart, so they work in any map's markup, are replicated online and are used by bots.
  - Grey-box visuals at this stage.
  - Every mode plays on it, offline and online, with bots.
  - *Tests:*
    - the validator passes;
    - bots reach every pad and both bases;
    - a teleporter carries a soldier, and a bot uses one;
    - an 8-player online match on the network lab stays in sync;
    - the HD and Modern cores match frame for frame.

- [ ] **B9. The art pass: Beaver Creek looks the part.**
  - Terrain sculpted and painted: grass, mud, wet stone, rock walls.
  - The creek in B5's water, and boulders and trees with B6's wind.
  - The two bases as Forerunner structures built from the kit, with their own panels.
  - The arch, a vista beyond the canyon rim, and B7's daylight.
  - Its own bakes through B1.
  - *Acceptance:* a short report in this item counting what the map needed of its own against what it reused, with bake times and sidecar size.
  - *Tests:* the map is under budget; the bakes are current; parity.

## Phase D: Spartans

- [ ] **B10. Mark VII-style Spartans.** The soldier rebuilt toward Infinite's look:
  - **Form:** a broader, layered silhouette; a dark ribbed undersuit showing at the joints; armour plates with chamfered edges and panel lines; a chest rig; shoulder pauldrons; thigh and shin plates; and a helmet with Infinite's proportions and a wide gold visor.
  - **Materials:**
    - armour paint with clearcoat and edge wear, through the material graph's wear nodes;
    - a fabric undersuit with sheen;
    - an iridescent visor;
    - team colour on the main plates (`tintMix`), and armour sets as material variants.
  - **The contract:** the same joint names, clips, animator parameters and ragdoll joints, so the cart, the demo's `?assets=` and every existing clip keep working.
  - LODs for distance, and the first-person sleeves and gloves to match.
  - It stays editable by hand: it exports to GLB and imports back unchanged (L14), and every L15–L17 tool works on it.
  - *Tests:* the contract holds; the round trip is lossless; the triangle budget holds at each LOD; every clip plays.

## Order

B1 → B2 → B3 → B8 (Beaver Creek plays in grey box) → B5, B6, B7 → B9 → B10 → B4.

B4 waits until B3 has made collision a layer and B8 has given the editor a real map to open. B10 can move earlier if Spartans are wanted sooner.

## Open questions

- **The layout list above** needs confirming against the reference model.
- **iPhone/iPad:** pressing Play on the main demo does nothing on the user's device. A memory reload by iOS Safari is suspected and not yet confirmed. B2's sidecar-per-map lowers what a match holds. The cause is to be confirmed on a device before B5–B10 add weight.
