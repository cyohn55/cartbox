# Lockout multiplayer and maps roadmap

Three tracks that turn Lockout from a good-looking demo into a game people
play and make together: **netcode** fit for a competitive arena shooter, a
**second map** built to prove the kit and bake pipeline are reusable rather
than hand-tuned to one arena, and **authoring Lockout's assets in the
editor** — the Spartans, weapons and pickups edited there and played in the
demo, as an artist would in Blender. Each item ships as its own PR with
tests, and Lockout uses it in the same PR.

Successor to [`HALO_INFINITE_STYLE_ROADMAP.md`](HALO_INFINITE_STYLE_ROADMAP.md),
whose kit (I14, I16), texture baking (I15) and dynamic bounce (I17) the
second map builds on. It also takes over the open item in
[`ENGINE_ROADMAP.md`](ENGINE_ROADMAP.md): "authoritative server or rollback
netcode for competitive multiplayer".

## Where Lockout stands

**Online play exists, and is casual-grade.** Eight slots, matchmaking and
room codes, all seven modes online (`/lockout`). The model is
**client-authoritative state sync**:

- Each browser runs its own copy of the cart and is authoritative for its own
  Spartan. The lowest slot is the host: it runs the bots, the objective and
  the scores.
- Each slot publishes **3 state words** (position in 16-bit centimetres, yaw,
  health, half the shields, weapon, dead, moving, team). There is no pitch,
  ammo or grenade count.
- Updates are sent as JSON over **Supabase Realtime broadcast**, a relay
  through Supabase's servers, every 4, 6 or 8 ticks (15, 10 or 7.5 Hz by
  room size).
- Remote Spartans are eased toward their latest state (k = 0.35), snapping
  when more than 4 m off.
- A shooter reports a hit to its victim, and the victim announces the kill.
  **Shots, tracers and grenades are not replicated:** each client sees only
  its own.
- No tick alignment, no acknowledgements, no lag compensation, and nothing
  stops a modified client from teleporting or never dying.
- Each browser seeds `math.random` differently, and neither core can save and
  restore its state, so there is no rollback.

**The map is code, not data.** The arena isn't assembled from the kit: the
I16 panels are re-made inline over hand-placed collision boxes.

- Every coordinate is a literal in `lockoutSeed.ts`: colliders, ramps,
  spawns (8, with no team bases), 57 bot destinations, hills, the ball spawn
  and the death plane.
- The Lua gets its `COL`, `SPN`, `ROAM` and `HILLS` tables pasted into its
  source.
- The three bakes (light map, probes, kit maps) are vitest files writing
  generated `.ts` files at hard-coded paths. **When one goes stale, the game
  silently falls back to unlit or plain.**
- One cart holds one scene, with one navmesh, one lighting rig, one set of
  probes and one set of terrains.
- The sidecar has about **55 KB of headroom** under its 1.9 MB budget.
- The editor and the seed disagree. Editing Lockout's geometry in the editor
  doesn't move its Lua colliders, and the editor bakes navigation from
  visible triangles where Lockout bakes it from colliders.

## Decisions

- **Host-authoritative, not rollback.** Rollback needs every browser to
  simulate identically and to snapshot and restore the whole core at 60 Hz.
  Neither core can, and copying a Lua heap several times a frame is not
  practical. Arena shooters, Halo included, use an authoritative simulation
  with client prediction and lag compensation. Without our own servers, the
  authority is the room's host browser, a listen server, as in Halo 2 and
  Halo 3's matchmaking. A dedicated headless host stays possible
  later, because the host is just a cart instance.
- **Peer-to-peer transport, relay as fallback.** WebRTC data channels, with
  Supabase Realtime kept for signalling and as the fallback when a direct
  connection fails. A TURN server is infrastructure we don't have; until
  then, peers that can't connect directly keep today's relay.
- **One sidecar per map, shared assets apart.** Two Lockout-quality maps
  don't fit one 1.9 MB sidecar, and the Spartans, viewmodels and kit would be
  duplicated. Shared assets move to a pack that every map's sidecar
  references.

## Phase A — Foundations

- [x] **L1. The map as data.** Lockout's gameplay geometry and markup become
      one `ArenaMap` description:
      - colliders and ramps;
      - spawns with teams;
      - bot destinations and power positions;
      - hills, the ball spawn and the death plane;
      - pickups and weapon markers.

      The Lua tables are generated from it, and the cart's code reads them
      instead of carrying literals, so the same code can play any map.
      `tier()` and `panelledPrism()` move out of the seed into a reusable
      Forerunner-kit module.
      *Lockout:* plays exactly as before.
      *Tests:* the generated tables equal today's literals; the HD and Modern
      cores still match frame for frame on Lockout; and a second, tiny test
      map runs on the same code.
      *Done:* `forerunnerArena.ts` holds `ArenaMap` and its tables:
      - `arenaLua` writes `COL`, `SPN`, `SPT` (spawn teams), `MRK`, `MW`,
        `ROAM`, `POWER`, `HILLS`, `BALL` and `DEATH_Y`;
      - `arenaColliders` turns solids and flights into collider boxes;
      - `arenaCenter` centres a map with no mesh of its own.

      The cart's code is `lockoutCode(map, center)`:
      - it reads its hills, ball spawn and death plane from the map;
      - it picks among the map's spawns, however many there are;
      - in a team game it spawns each Spartan on its own team's spawns, when
        the map has any.

      `forerunnerBuilder()` holds the kit's arena builders (`tier`,
      `panelledPrism`, `ramp`, `fin`, `column`, `prism`). It gathers its
      light channels itself instead of in a module global.
      *Lockout:* `LOCKOUT_MAP`. The six tables Lockout carried before (`COL`,
      `SPN`, `MRK`, `MW`, `ROAM`, `POWER`) are byte-identical (pinned by
      hash), and so is the whole sidecar. In `arena-map.test.ts`, a tiny
      two-team map runs on the real engine: every bot spawns on it, and in
      Team Slayer each team spawns on its own side.
- [x] **L2. A network lab.** A simulated network for the in-memory hub, with
      latency, jitter, loss, reordering and a bandwidth cap, plus a headless
      harness that runs 2 to 8 real Lockout engines in one room. It reports
      per-client bytes per second and how far each client's view of every
      Spartan drifts from that Spartan's owner.
      *Lockout:* today's netcode measured at 0, 80 and 200 ms, giving the
      numbers the next phase must beat.
      *Tests:* the harness's reports are deterministic for a fixed seed.
      *Done:* `netLab.ts` in the player has two parts.
      - **`SimulatedNetHub`:** a NetSession transport on a virtual clock. A
        seeded random stream applies one-way latency, jitter (which
        reorders), loss and a per-sender uplink cap that queues messages.
        Each message is delivered at its own arrival time.
      - **`runNetLab`:** plays N real carts in one room over the hub. It
        compares, every tick, where each slot's owner has it (from the
        owner's outbox) with where every other client draws it. It reports
        drift (mean, p95, max) for human players and for everything,
        bytes/s per client, and messages sent, delivered and lost.

      Lockout's adapter (`Unit Tests/helpers/lockoutNetLab.ts`) reads
      positions from the centimetre state words and from the observers' mesh
      poses. The baseline, for two players over 10 s:

      | Latency | Drift mean | Drift p95 | Drift max | Host sends |
      | ---: | ---: | ---: | ---: | ---: |
      | 0 ms | 0.31 m | 0.73 m | 1.71 m | 2.7 KB/s |
      | 80 ms | 0.65 m | 1.45 m | 1.75 m | 2.7 KB/s |
      | 200 ms | 1.18 m | 2.58 m | 2.74 m | 2.7 KB/s |

      Eight players at 80 ms with 5% loss drift 1.16 m on average (p95
      1.99 m). The host sends 0.3 KB/s (it owns no bots then) and receives
      1.6 KB/s.

## Phase B — Netcode

- [x] **L3. Direct transport.** WebRTC data channels between peers, with an
      unreliable channel for state and a reliable one for events, signalled
      over the existing Supabase Realtime room. The relay remains the
      fallback per peer. Messages switch from JSON to a packed binary format,
      and the send rate rises to 30 Hz.
      *Lockout:* lower latency and room for more state.
      *Tests:* the codec round-trips; a peer falls back to the relay when
      ICE fails; the lab shows bytes per second within budget at 8 players.
      *Done:*
      - **`netCodec.ts`** packs a message into little-endian binary. It
        comes to about a third of the JSON for Lockout's full 32-bit state
        words. Sessions now count their traffic in these bytes.
      - **`DirectTransport`** opens a WebRTC link to every peer, signalled
        over the room's relay. The lower id offers. Each link has an
        unordered, no-retransmit `state` channel and a reliable `events`
        channel.
      - **Relay fallback:** a peer whose link fails, or doesn't open within
        5 s, stays on the relay. The relay copy names its recipients, so
        every peer gets each message exactly once.
      - **Rate:** with every peer direct, the session sends at 30 Hz
        (`NetTransport.sendInterval`).
      - **Supabase:** the relay carries packed messages as base64. Online
        rooms use `DirectTransport` over it, with public STUN only.

      *Lab, 80 ms:* at the same latency, 30 Hz alone cuts remote drift from
      0.65 m to 0.58 m (p95 1.45 m to 1.26 m). The host sends 2.9 KB/s,
      against 1.5 KB/s packed at the relay's rate (2.7 KB/s as JSON).
      Eight players over direct links drift 0.79 m (1.16 m over the relay).
      The host sends 0.5 KB/s and receives 2.7 KB/s. The larger gain online
      is losing the relay's server hop, which a simulated link can't show;
      the cart's easing toward each snapshot is L4's to replace.
- [x] **L4. Snapshots and interpolation.** Timestamped snapshots on a shared
      tick clock, aligned with each peer's offset measured by ping. Remote
      Spartans are drawn about 100 ms in the past, interpolated between real
      snapshots rather than eased, with a short capped extrapolation through
      loss. The state grows to carry pitch, crouch and airborne state, the
      weapon in hand, firing, reloading, and grenades held.
      *Lockout:* remote Spartans move smoothly, aim where they really look,
      and animate their actual actions (the I9 and I11 clips).
      *Tests:* in the lab, interpolation error at 80 ms with 5% loss stays
      under a set bound, and a Spartan never snaps under normal play.
      *Done:*
      - **The shared clock** is the host's. A guest pings it (every 100 ms
        for its first five answers, then every half second), and the host
        echoes each ping in its next message with when it heard it and when
        it answered. The guest keeps the NTP estimate from the fastest of its
        last eight round trips. A guest 7.3 s off settles within 20 ms of the
        host in two seconds over an 80 ± 20 ms link.
      - **Stamps:** every message carries when its states were taken on that
        clock. A snapshot overtaken on the way is dropped, so the newest
        always stands.
      - **The view lag:** the session also measures how old snapshots are
        when they arrive. It rises at once with the slowest link and eases
        down slowly. The cart draws everyone at the shared clock less that
        lag less 100 ms: 100 ms behind the newest data, all at one moment.
      - **The inbox** (`netplay.ts`) now holds the clock, the view lag (in
        the header's top byte), four state words a slot and each slot's
        stamp. Events in and out drop to 14 and 6 a tick to make room, and
        the SDK queues the rest (`cartbox.netsend`). `cartbox.netclock()`
        and the six-value `cartbox.netpeer()` give a cart all of it.
      - **Lockout** keeps each remote Spartan's last snapshots and draws it
        between the two either side of the render time. Where the next one
        is late, it carries on along its last step for up to 100 ms, then
        holds.
      - **The fourth word** carries pitch, airborne, crouched, firing,
        reloading, a melee swing, grenades held, a life counter (bumped by a
        respawn, so nobody slides across the map) and a hit counter.
      - **What the others see:** remote Spartans aim chest and head where
        their owner looks, and play the I11 air, land, melee, hit and die
        moves from those bits. A shot flashes at the muzzle.
      - **Not carried:** Lockout has no crouch yet, and the third-person
        soldier has no reload clip, so those bits ride along unused for now.

      *Lab, the same 10 s run as L2/L3* (`lockout-interpolation.test.ts`; the
      lab now also measures error against where the owner was at the
      observer's render time, and snaps):
      - **80 ms ± 20, 5% loss:** interpolation error mean 0.5 cm, p95
        0.9 cm, no snap, largest extra step 4 cm.
      - **150 ms ± 30, 5% loss:** error p95 1 cm, no snap.
      - **8 players at 80 ms:** error p95 3 cm, no snap. The host sends
        1.0 KB/s and receives 4.1 KB/s.
      - **The price:** a remote Spartan is drawn about 0.84 m behind its
        owner's present at 80 ms (0.58 m when eased toward the newest
        snapshot), which L6's lag compensation pays back.
      - **Traffic:** four words a slot put a two-player host at 3.9 KB/s
        over direct links (2.9 KB/s with three).

      On two engines in one room, the host's copy of a guest follows its
      pitch to within 0.02 rad, sees every jump for as long as it lasts, and
      flashes its shots.
- [ ] **L5. Replicated combat.** Every shot, tracer, muzzle flash, melee,
      grenade throw, sword lunge and pickup becomes an event every client
      sees. A grenade is thrown with its starting state and a shared seed,
      so every client simulates the same arc.
      *Lockout:* everyone sees the same fight: the plasma trails, the
      grenades and the I17 bounce light from them.
      *Tests:* two clients' grenades land within a few centimetres of each
      other; every shot one client fires appears on the others.
- [ ] **L6. Authoritative hits with lag compensation.** A client sends its
      shot (origin, direction, the tick it saw) to the host. The host rewinds
      every Spartan's hitbox to what that shooter saw, decides the hit, and
      owns health, shields, kills and scores. The shooter shows a predicted
      hit marker at once, and the host confirms or corrects it. The host
      also sanity-checks movement speed, fire rate and ammo.
      *Lockout:* hits register where they were aimed at 150 ms; a modified
      client can't refuse to die or fire faster than its weapon.
      *Tests:* the lab replays the same duel at 0 and 150 ms and gets the
      same hits; a client claiming an impossible move or shot is corrected.
- [ ] **L7. Predicted, reconciled movement.** Clients send inputs; the host
      moves every Spartan; each client predicts its own movement and replays
      unacknowledged inputs over each correction. Movement and collision are
      already Lua over the map's boxes (L1), so prediction re-runs the same
      functions.
      *Lockout:* movement stays as responsive as offline, and the host's
      word is final.
      *Tests:* with no loss, a client's predicted path matches the host's;
      after an injected correction, the client converges within a few
      frames without a visible snap.
- [ ] **L8. Host migration and joining mid-match.** When the host leaves, the
      next host takes over the whole match: bots, objective, scores, the
      clock and grenades in flight. A client joining mid-match receives a
      full snapshot. A dropped client can rejoin into its old slot.
      *Lockout:* a match survives its host leaving, and friends can join a
      game already running. The stale "Cartbox has no netcode" header in the
      cart goes.
      *Tests:* in the lab, the host leaves mid-Oddball and the match
      continues with scores and the ball intact; a mid-match joiner sees the
      same state as everyone else within a second.

## Phase C — A second map

- [ ] **L9. Bakes that know their map.** One `bake:map <id>` command bakes
      a map's light map, probes and kit maps into that map's own generated
      files. A stale bake fails CI, for every map, instead of silently
      falling back. Probes get the currency check they lack today.
      *Lockout:* bakes through the same command.
      *Tests:* changing a map's geometry without re-baking fails its test.
- [ ] **L10. Shared assets and a sidecar per map.** The Spartans,
      viewmodels, pickups, kit and sounds move to a shared asset pack. Each
      map's sidecar holds only its own geometry, terrains, lighting, probes
      and navmesh, and references the pack. The cart picks a map by id; the
      match word carries it online, and the playlists rotate maps.
      *Lockout:* the arena's sidecar shrinks by the shared assets (about
      0.6 MB), giving each map its own room under the budget.
      *Tests:* a map loads with the pack; both maps stay under budget; a
      room's guests load the host's map.
- [ ] **L11. Blockout to collision.** In the editor, a map's collision
      blockout is its own layer: boxes and ramps authored with kit snapping.
      Colliders, the bot navmesh and the Lua tables come from that layer, so
      editing the map in the editor keeps play and visuals in step. A map
      validator checks that:
      - every spawn stands on floor;
      - the navmesh reaches every destination and hill;
      - no visible geometry stands proud of the collision;
      - nothing falls through the death plane;
      - the map is under budget.

      *Lockout:* passes the validator.
      *Tests:* the validator flags each failure on purpose-broken maps.
- [ ] **L12. The second map.** A map built differently from Lockout, so the
      pipeline is tested rather than repeated: a larger, asymmetric
      two-base Forerunner outpost on terrain, with team spawns, at another
      time of day (evening, the sky's sun moved by `cartbox.sun3d`), and
      with a vista of its own. It is assembled from kit prefabs placed in
      the editor (I14), with its own baked maps (I15), and lit and bounced
      by the same bakes (I17). Every existing mode plays on it, bots
      included, offline and online.
      *Acceptance (the reusability test):* a short report in this item
      counts what the map needed of its own (code, bake settings, new kit
      pieces) against what it reused, with bake times and sidecar size.
      Anything that had to be special-cased becomes a follow-up.
      *Tests:* the validator passes; the HD and Modern cores match frame for
      frame on it; the lab's 8-player match on it stays within its bounds.

## Phase D — Authoring Lockout's assets in the editor

Where the editor stands: materials (every PBR field, team-colour masks, the
material graph), clips (trim, speed, reverse, retarget by joint name) and
animator state machines are editable, and a static mesh takes face extrude,
inset and bevel. But:

- **Skinned meshes are locked.** Face edits refuse a mesh with joints and
  weights, so the Spartans and the first-person viewmodels can't be reshaped
  at all.
- **No modelling below the face.** No vertex or edge selection, no moving,
  rotating or scaling parts of a mesh, no merge, delete, loop cut, subdivide
  or mirror.
- **No rig or keyframe tools.** Bones are a list of names: no skeleton view,
  pose mode, weight painting or per-bone keys.
- **No texture work.** No UV view, no painting, no uploading a texture into a
  material slot, and a material set's materials can only be chosen, not
  edited.
- **No round trip.** GLB export writes no skin, weights, clips or second UV
  set, so a rigged asset can't go to Blender and back; and an import always
  adds a new object rather than replacing one.
- **The demo can't see edits.** `/lockout` builds its assets from code every
  time. Edits saved in the editor play only in the user's own copy of the
  cart, and the cart's code finds its Spartans and weapons by fixed object
  index, joint, clip and parameter names, so a replaced asset has to keep
  them.

The order below gets edited Spartans into the demo first, through Blender,
then brings the tools into the editor.

- [x] **L13. Lockout's assets as editable data.** The Spartans, viewmodels,
      pickups and kit become an asset pack (the one L10 shares between maps)
      that the demo loads, instead of rebuilding them from code. Opening the
      pack in the editor and saving it updates the demo. An import can
      **replace** an object's mesh in place, keeping its index, animator and
      variants, and checks the contract the cart relies on: the same joint
      names (`chest`, `head`, …), clip names and animator parameters, or it
      says which are missing.
      *Lockout:* a Spartan edited and saved in the editor plays in `/lockout`.
      *Tests:* replacing the soldier keeps every bot's index and animator; a
      replacement missing `head` or `run` is flagged; the demo loads the
      saved pack.
      *Done:* the demo reads a saved cart, not a separate pack. Moving the
      shared assets into a pack of their own stays with L10, where two maps
      need it.
      - **The editor:** the Mesh tab's **Replace model** (`meshReplace.ts`)
        puts an imported model in place of the selected object and every
        copy of it, so all seven bots change together. Each keeps its id,
        place, animator and props. A material set the new model lacks is
        dropped, and LODs are remade.
      - **The contract:** before replacing, the editor checks that the new
        model keeps the old one's joints and clips, the clips the objects'
        state machines play, and the material sets they wear. If any are
        missing it says which and asks before replacing.
      - **The demo:** `/lockout?assets=<cart>` reads that cart's saved copy
        in this browser. It plays the cart's Spartans, viewmodels and
        pickups in place of its own, but never its arena, lighting or code
        (`lockoutAssets.ts`). An asset whose replacement breaks the contract
        keeps the demo's model, and the lobby says why.
      - **The link:** a Lockout cart's Mesh tab links straight to the demo
        with its assets.

      *Lockout:* a Spartan exported as GLB (L14), reshaped as Blender would
      and brought back plays on every bot in the demo, with its joints and
      clips intact (`lockout-assets.test.ts`).
- [x] **L14. A rigged round trip with Blender.** GLB export writes skins
      (joints, weights, inverse bind matrices), animation clips, the second UV
      set and material sets, so a Spartan exported, edited in Blender and
      re-imported comes back rigged and animated.
      `BLENDER_WORKFLOW.md` documents the round trip both ways.
      *Lockout:* the soldier and every viewmodel survive export and
      re-import unchanged.
      *Tests:* export then import is lossless for positions, weights, joints
      and clip keys; Blender-shaped files (from the fixtures) import as
      before.
      *Done:* `encodeGlb` in `gltfCodec.ts` writes a skinned mesh's rig.
      - **The skeleton:** one node per joint, in skin order, with its name and
        rest transform. A root's `base` (the armature object it came in
        under) becomes its parent node.
      - **The skin:** `skins[0]` with its inverse binds, and `JOINTS_0`
        (bytes) and `WEIGHTS_0` on every bound primitive. A rigid part,
        stored as one joint or a byte per vertex, is written as four
        influences per vertex. Weights that don't sum to 1 are normalised.
      - **The clips:** one animation per clip, with linear or stepped
        samplers, and each set of key times written once. A clip that holds
        past its last key keeps its length in `extras.duration`.
      - **The rest:** the second UV set as `TEXCOORD_1`, and the material
        sets as before. An unbound part goes on a mesh node of its own, so
        the primitives keep their order.

      Import now reads `TEXCOORD_1` as `uvs2` and the clip length. It also
      takes a bind that is the rest pose to within float32 rounding as
      exactly that, so vertices and inverse binds come back bit for bit.
      An unskinned export is byte-identical to before (pinned by hash), and
      the Blender-shaped arm fixture imports identically.
      *Lockout:* the Spartan exports as a **124 KB** GLB (46 KB without its
      rig before), and the viewmodels as 45 to 84 KB. In
      `gltf-round-trip.test.ts`, the soldier and all six viewmodels come back
      with their stored form unchanged: positions, indices, bindings (in
      the same compact form), joints, rest pose, inverse binds, every clip's
      keys and length, and the material sets. Normals match to within 1e-6.
      The written files pass a structural check: accessor counts, weights
      summing to 1, joints in range, and channels on joints. LODs, trails,
      state machines and cart-only material settings stay in the cart.
- [ ] **L15. Modelling in the editor.** Vertex, edge and face selection
      (click, box and loop select) with a move, rotate and scale gizmo for
      the selection, plus merge, delete, loop cut, subdivide, mirror and add
      primitive. Edits on a skinned mesh carry its weights: a moved vertex
      keeps its own, and new vertices blend their neighbours'.
      *Lockout:* reshape a Spartan's helmet or a weapon's stock in the editor,
      and it still animates.
      *Tests:* each operation keeps the mesh closed and consistently wound;
      skinned edits keep every vertex's weights normalised and the clips
      playing.
- [ ] **L16. Rigging and keyframes.** The skeleton drawn over the mesh; a pose
      mode to rotate bones; weight painting (add, subtract, smooth, normalise)
      with a heat-map view; and a dope sheet that keys bones on a clip, with
      the timeline's easing curves.
      *Lockout:* tune a Spartan's run or author a new taunt clip in the editor.
      *Tests:* painted weights stay normalised; a keyed clip plays back
      through the existing animator the same as an imported one.
- [ ] **L17. UVs and texture painting.** A UV view with unwrap and island
      editing, painting into a material's base colour, roughness/metal and
      emissive maps (with the team-colour mask as a paintable layer),
      uploading an image into any material slot, and editing a material set's
      materials.
      *Lockout:* repaint a Spartan's armour or design a new armour set in the
      editor.
      *Tests:* painting writes the right texels through the UVs; a re-saved
      material set round-trips through GLB export (L14).

## Not in this roadmap

- A dedicated server or TURN relay. Both need infrastructure; the host model
  (L6–L8) moves to a headless host unchanged if one appears.
- Rollback, for the reasons above.
- Ranked matchmaking, accounts and anti-cheat beyond the host's sanity checks.
- Sculpting and booleans in the editor; Blender remains the tool for those.
- Follow-ups carried from the previous roadmap (GLB export of skeletons and
  clips moved into L14):
  - morph targets on glTF import (a second UV set rides with L14);
  - GPU-compressed texture upload;
  - directional light maps, so light-mapped surfaces follow a moving sun.
