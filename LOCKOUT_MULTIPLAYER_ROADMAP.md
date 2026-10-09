# Lockout multiplayer and maps roadmap

Two tracks that turn Lockout from a good-looking demo into a game people
play together: **netcode** fit for a competitive arena shooter, and a
**second map** built to prove the kit and bake pipeline are reusable rather
than hand-tuned to one arena. Each item ships as its own PR with tests, and
Lockout uses it in the same PR.

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

- [ ] **L1. The map as data.** Lockout's gameplay geometry and markup become
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
- [ ] **L2. A network lab.** A simulated network for the in-memory hub, with
      latency, jitter, loss, reordering and a bandwidth cap, plus a headless
      harness that runs 2 to 8 real Lockout engines in one room. It reports
      per-client bytes per second and how far each client's view of every
      Spartan drifts from that Spartan's owner.
      *Lockout:* today's netcode measured at 0, 80 and 200 ms, giving the
      numbers the next phase must beat.
      *Tests:* the harness's reports are deterministic for a fixed seed.

## Phase B — Netcode

- [ ] **L3. Direct transport.** WebRTC data channels between peers, with an
      unreliable channel for state and a reliable one for events, signalled
      over the existing Supabase Realtime room. The relay remains the
      fallback per peer. Messages switch from JSON to a packed binary format,
      and the send rate rises to 30 Hz.
      *Lockout:* lower latency and room for more state.
      *Tests:* the codec round-trips; a peer falls back to the relay when
      ICE fails; the lab shows bytes per second within budget at 8 players.
- [ ] **L4. Snapshots and interpolation.** Timestamped snapshots on a shared
      tick clock, aligned with each peer's offset measured by ping. Remote
      Spartans are drawn about 100 ms in the past, interpolated between real
      snapshots rather than eased, with a short capped extrapolation through
      loss. The state grows to carry pitch, crouch and airborne state, the
      weapon in hand, firing, reloading, and grenades held.
      *Lockout:* remote Spartans move smoothly, aim where they really look,
      and animate their actual actions (the I9 and I11 clips).
      *Tests:* in the lab, interpolation error at 80 ms with 5% loss stays
      under a set bound, and a Spartan never snaps under normal play.
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

## Not in this roadmap

- A dedicated server or TURN relay. Both need infrastructure; the host model
  (L6–L8) moves to a headless host unchanged if one appears.
- Rollback, for the reasons above.
- Ranked matchmaking, accounts and anti-cheat beyond the host's sanity checks.
- Follow-ups carried from the previous roadmap:
  - GLB export of skeletons and clips;
  - a second UV set and morph targets on glTF import;
  - GPU-compressed texture upload;
  - directional light maps, so light-mapped surfaces follow a moving sun.
