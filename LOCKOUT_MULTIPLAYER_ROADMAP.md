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
- [x] **L5. Replicated combat.** Every shot, tracer, muzzle flash, melee,
      grenade throw, sword lunge and pickup becomes an event every client
      sees. A grenade is thrown with its starting state and a shared seed,
      so every client simulates the same arc.
      *Lockout:* everyone sees the same fight: the plasma trails, the
      grenades and the I17 bounce light from them.
      *Tests:* two clients' grenades land within a few centimetres of each
      other; every shot one client fires appears on the others.
      *Done:* six new event kinds in Lockout, each two words.
      - **A shot:** its shooter, weapon, direction (yaw and pitch, 1e-4
        rad), how far it flew (cm) and what it hit (nothing, a wall, a body
        or a shield). Every shot is sent, the player's own and, from the
        host, every bot's.
      - **Shown in step:** a browser holds the others' shots, swings and
        throws for the same 100 ms it draws them behind, then plays each
        from where its owner is drawn. A shot gets its sound, a muzzle flash
        (a light), a tracer, and sparks and a pock where it struck a wall or
        a flare where it struck a shield.
      - **A new `tracer` effect** (a glowing trail laid from the muzzle to
        where the round stopped) now marks every round in the arena: the
        player's own, the bots', and the others'.
      - **A melee swing** (a sword lunge among them) is shown with its slash
        and sound.
      - **A grenade** goes out as two events: where it was thrown from (to
        the centimetre) and which way. The thrower simulates from that same
        rounded start state, so every browser runs a bit-identical arc.
        Others launch a replica that lights the arena as it flies, does no
        damage (the thrower's browser deals that), and sticks only where the
        thrower says, by a third event. Lockout's arc has nothing random in
        it, so the shared start state is the shared seed.
      - **A pickup** empties the pad on every browser. The pads' respawn
        clocks now run every tick on every browser; before, each counted
        only while its own player was alive, so pads drifted apart.

      *Lockout* (`lockout-combat.test.ts`, two engines in one room): the
      guest fired 44 shots and the host showed all 44. The host's bots fired
      558 and the guest had shown 556 when the run ended, the last two still
      inside the 100 ms display delay; none was shown twice. A guest's two
      grenades went off at the same centimetre on both browsers. The pads
      stood the same on both 95% of the time or more (a pickup reaches the
      other a few ticks late). The bots' shots add about 0.4 KB/s to a
      two-player host over direct links (3.9 to 4.3 KB/s).
- [x] **L6. Authoritative hits with lag compensation.** A client sends its
      shot (origin, direction, the tick it saw) to the host. The host rewinds
      every Spartan's hitbox to what that shooter saw, decides the hit, and
      owns health, shields, kills and scores. The shooter shows a predicted
      hit marker at once, and the host confirms or corrects it. The host
      also sanity-checks movement speed, fire rate and ammo.
      *Lockout:* hits register where they were aimed at 150 ms; a modified
      client can't refuse to die or fire faster than its weapon.
      *Tests:* the lab replays the same duel at 0 and 150 ms and gets the
      same hits; a client claiming an impossible move or shot is corrected.
      *Done:*
      - **Whose word counts:** each event in the inbox now carries the slot
        that sent it (`cartbox.netevents()` gives `{a, b, from}`). Lockout
        takes kills, scores, the objective, health and verdicts only from
        the host (slot 0). A soldier's shots, swings, throws and pickups
        count only from that soldier, or from the host for its bots. The
        inbox makes room by taking 12 events a tick, down from 14.
      - **A guest's shot:**
        - The shot event (L5) now carries where the guest aimed.
        - A second event carries when it fired on the shared clock, how far
          behind it drew the others (its view lag plus 100 ms), its spread's
          seed, and whether it thinks it hit.
        - The spread now comes from that seed, so the host replays the very
          pellets the guest fired. Origins come from the guest's own
          snapshots at its fire time.
      - **The host's judgement:**
        - It keeps about a second of every soldier's positions on the
          shared clock: its own and its bots' each tick, the guests' from
          their snapshots.
        - It rewinds everyone to what the guest saw and runs the guest's
          own hit test against them (melee: whom it swung at, if within
          reach then).
        - It applies the damage, which owns health, shields, kills and
          scores, and answers with a verdict.
      - **The hit marker:** it shows at once, on a guest as its own guess.
        The verdict keeps it white, or turns it red for a miss.
      - **The host owns health:**
        - A guest's `damage()` does nothing; the host's does it all,
          grenade splash included (even a guest's grenade, through the
          host's replica).
        - Shields recharge on the host, and each guest gets its health from
          the host as it changes.
        - Only the host kills, except a guest falling off the arena.
      - **Sanity checks:** the host refuses a guest's shot from the dead,
        faster than its weapon fires, or past a full load of ammo for that
        weapon (topped up when it picks one up). It also refuses a move
        further than a soldier could run (11 m/s and 2.5 m of slack, over
        up to 0.6 s), and a new life the guest never died for. It sends the
        guest back to its last good place.
      - **Can't refuse to die:**
        - A soldier the host has killed stays dead on the host until it
          respawns, and not before the respawn time.
        - Every other browser holds it dead until it shows a new life.
      - **Lockout's Lua** had reached 192 of Lua's 200 locals in a chunk;
        event and impact kinds now sit in two tables (174).

      *Lockout* (`lockout-authority.test.ts`, two engines over the lab's
      links):
      - **The duel:** the guest stands and fires at the host's player
        strafing at full run 8.8 m away.
        - At 0 ms the host confirmed 108 of the guest's 108 predicted hits;
          at 150 ms, 107 of 107.
        - Judged on the host's present instead (lag compensation off), 23
          of 107.
      - **An impossible move:** a guest that jumps 12 m sideways is put back
        within a quarter of a second.
      - **A cheating guest:** one that sends each shot twice, faster than
        its rifle, has every second copy refused. One that ignores being
        killed stays dead on the host however long it says it's alive.
      - **The lab:** events now ride the lab's links as on L3's reliable
        channel. A lost message's events arrive a round trip late instead
        of never, because a lost kill would now leave a guest alive
        forever.
- [x] **L7. Predicted, reconciled movement.** Clients send inputs; the host
      moves every Spartan; each client predicts its own movement and replays
      unacknowledged inputs over each correction. Movement and collision are
      already Lua over the map's boxes (L1), so prediction re-runs the same
      functions.
      *Lockout:* movement stays as responsive as offline, and the host's
      word is final.
      *Tests:* with no loss, a client's predicted path matches the host's;
      after an injected correction, the client converges within a few
      frames without a visible snap.
      *Done:*
      - **One movement function:** `move_soldier(e, forward, right, facing,
        jump)` is a tick of any Spartan's own movement: the walk along the
        map's boxes and the jump and fall, now written for any soldier
        rather than only the local player.
      - **Rounded inputs:** the player's controls become an input every
        tick: forward and right in 127ths, facing to 1e-4 rad, pitch, a jump
        and a number. Every browser moves by that same rounded input.
      - **A guest:**
        - It sends each input as a reliable event (the last event kind, 15)
          and no longer publishes its own state in a match.
        - It moves at once by its own input: its prediction.
        - It keeps the inputs the host hasn't yet acknowledged.
      - **The host:**
        - It moves each guest's soldier by its inputs as they arrive: one a
          tick, two while a late burst catches up.
        - It publishes every soldier, with the number of the guest's last
          input it applied and its vertical speed (13 bits).
        - It respawns guests itself.
        - It judges each of a guest's shots once it has applied the input
          the shot was fired on, from where that input put the guest.
      - **Reconciling:**
        - A guest checks the host's state for its own slot against its own
          guess for that input. A session now hands a player its own slot's
          state too.
        - Within 3 cm (what the host's centimetres can say), nothing
          happens.
        - Otherwise it takes the host's state, replays its inputs since, and
          eases the difference out of the view, 20% a frame.
        - Its health, death and respawn are the host's.
      - **What went:**
        - L6's checks on a guest's claimed positions: a guest no longer
          claims any, so a move no soldier could make can't reach the host
          at all.
        - Its own respawn: only the host respawns it.
        - Pushes out of bodies for guests, which the host doesn't apply to
          the soldiers it moves by inputs (offline and the host's own
          player still get pushed).
        - Bug fix: a soldier's "moving" flag was never set for human
          players, so others always saw their legs standing still; it is
          now set by the movement itself.
        - Bug fix: a guest joining a match from the lobby was left marked
          dead.

      *Lockout* (`lockout-prediction.test.ts`, two engines over 80 ± 10 ms
      links):
      - **Prediction:** a guest lapping the central floor (running, turning,
        strafing and jumping for 25 s) moves on the very tick it presses
        forward. It needed no correction at all: the host's copy followed
        its predicted path 7 ticks behind to within a millimetre.
      - **A correction:** the host moving its copy 60 cm sideways is one
        correction on the guest. The full 60 cm is held back as an offset
        and closes 20% a frame: under 8 cm left after ten frames, under 1 cm
        after twenty, the view never stepping more than 13 cm in a frame.
      - **Grenades and shots** still land and register as in L5 and L6. The
        duel still confirms 108/108 and 107/107.
      - **Traffic:** a guest sends 0.7 KB/s (sixty inputs a second); a host
        4.6 to 4.8 KB/s, since it sends every soldier. In a room of 8 a guest
        receives 8.6 KB/s, partly the others' inputs, which ride to everyone
        though only the host needs them.
- [x] **L8. Host migration and joining mid-match.** When the host leaves, the
      next host takes over the whole match: bots, objective, scores, the
      clock and grenades in flight. A client joining mid-match receives a
      full snapshot. A dropped client can rejoin into its old slot.
      *Lockout:* a match survives its host leaving, and friends can join a
      game already running. The stale "Cartbox has no netcode" header in the
      cart goes.
      *Tests:* in the lab, the host leaves mid-Oddball and the match
      continues with scores and the ball intact; a mid-match joiner sees the
      same state as everyone else within a second.

      *Done:*
      - **Slots that stick:** the host keeps the room's roster (player id to
        slot) and sends it with its events, once a second and on any change.
        - A player who leaves keeps its slot held for 60 s. Coming back with
          the same id within that time gives it the same slot, and its
          score with it.
        - Nobody else moves up when a player leaves, so no soldier changes
          hands mid-match.
        - The host is the present player with the lowest slot. A session
          takes a roster only from that player, so two would-be hosts
          settle on one. The host's slot reaches the cart in pmem 66 and as
          `net()`'s sixth value.
      - **Migration:** the next host takes every slot it now drives from
        where it stands, as it stands: bots keep their positions, health
        and weapons, and only a dead one is respawned. It carries on
        sending the objective and scores, now team scores too, so the match
        goes on with the ball, scores and clock intact. Guests trust events
        from the host's slot, wherever it is.
      - **Joining mid-match:** when a player joins a match under way, the
        host sends at once every score, both team scores, the objective and
        each empty pad with what's left of its wait. The newcomer sees
        everyone else through the states every player publishes anyway.
      - **The header:** the stale "Cartbox has no netcode" note in the cart
        is gone.

      *Lockout* (`lockout-migration.test.ts`, real engines over 30 ± 5 ms
      links):
      - **Host leaving mid-Oddball:** with three players 20 s into a match,
        the host leaves. The player in slot 1 takes over in its own slot,
        and slot 2 keeps its slot. Both stay in the match, no score goes
        backwards, and they agree on every score and on the ball's carrier.
        Scoring carries on under the new host for the next 15 s.
      - **Joining Team Slayer under way:** a third player joining 30 s in
        has the host's team and player scores in under a second.
      - **Rejoining:** a player dropped for two seconds of a Free for All
        comes back into slot 2 with its score.

      *Limits:*
      - Grenades already in the air aren't sent to a newcomer, so it misses
        their blasts until they land.
      - Inputs still ride to every guest, though only the host needs them.
      - In the browser, a player's id is new each page load, so rejoining
        keeps the slot across a dropped connection but not across a reload.

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
- [x] **L15. Modelling in the editor.** Vertex, edge and face selection
      (click, box and loop select) with a move, rotate and scale gizmo for
      the selection, plus merge, delete, loop cut, subdivide, mirror and add
      primitive. Edits on a skinned mesh carry its weights: a moved vertex
      keeps its own, and new vertices blend their neighbours'.
      *Lockout:* reshape a Spartan's helmet or a weapon's stock in the editor,
      and it still animates.
      *Tests:* each operation keeps the mesh closed and consistently wound;
      skinned edits keep every vertex's weights normalised and the clips
      playing.
      *Done:* `meshModel.ts` models one level up from the stored triangles.
      - **What it selects:** a vertex is a weld (every split copy at one
        position, so a moved corner never tears), a face is a polygon as I14
        finds it, and an edge is a side of one. Click picks among the
        clicked face's own corners or sides, so nothing behind is picked. Box
        selects through the mesh. Alt+click selects an edge loop, its
        vertices, or (in face mode) the ring of quads it crosses. Linked
        grows to whole pieces, and a bone's menu selects what it carries.
      - **The edits:** move, rotate and scale about the selection's centre,
        by the gizmo or by numbers. Merge collapses to the centre. Delete
        fills the hole it leaves. Loop cut splits the faces where its ring
        stops too. Subdivide splits a convex face into a quad per corner,
        and its neighbours take the new vertices. Mirror flips whole pieces
        across a centre plane or copies them, turning their triangles round.
        Add primitive makes a cube, cylinder, cone or sphere.
      - **Skinned meshes:** face extrude, inset and bevel no longer refuse
        them. A moved vertex keeps its weights. A new one blends its
        neighbours' (the four strongest, normalised to 1). A mirrored piece
        moves to the mirrored joint (`upperarm_l` ↔ `upperarm_r`), and an
        added one rides the bones nearest it, or one you name.
      - **The editor:** the Mesh tab's **Edit: Model** mode shows the
        wireframe, the selection and the gizmo over the preview. Right-drag
        orbits, and 1/2/3, G/R/S, A and Delete are shortcuts. The **Model**
        panel holds the numeric transform and the operations. The preview
        frames the stored mesh, so a drag in progress doesn't move the camera.

      In `mesh-modelling.test.ts`, every operation leaves a cube, and a
      skinned two-bone cube, closed and wound outward: no open, repeated or
      collapsed edge, and the volumes come out right. Examples are a 2 → 1
      frustum, a corner sliced off at 8 − 4/3, and four primitive kinds
      within 15% of their round volumes. Every vertex's weights sum to 1
      within 1e-5. A loop cut halfway up the bend gives its new vertices
      exactly half of each bone.
      *Lockout:* the soldier's helmet, selected by `head` (136 welds across
      plates, trim and visor), is scaled 15% broader and 25% taller. It stays
      closed, nothing below the neck moves, and all 10 clips play through
      the cart's animator with the helmet's 408 vertices riding the head.
      A crest, a loop cut across the crown, a subdivided brow and an
      extruded chin keep it closed, weighted and animating. The ear module
      mirrored onto the other side rides the head. The battle rifle
      viewmodel's stock, pulled 4 cm back, plays all six of its clips on the
      `weapon` joint.
- [x] **L16. Rigging and keyframes.** The skeleton drawn over the mesh; a pose
      mode to rotate bones; weight painting (add, subtract, smooth, normalise)
      with a heat-map view; and a dope sheet that keys bones on a clip, with
      the timeline's easing curves.
      *Lockout:* tune a Spartan's run or author a new taunt clip in the editor.
      *Tests:* painted weights stay normalised; a keyed clip plays back
      through the existing animator the same as an imported one.
      *Done:* the Mesh tab's **Edit** control gains **Pose** and **Weights**
      for a skinned mesh.
      - **Pose mode** (`poseMode.ts`) draws the skeleton over the posed mesh,
        a bone from each joint to its children. A click picks a joint, or the
        joint that swings the bone clicked. The rotate gizmo turns it about
        the world's axes, and the **Pose** panel's angles turn it about its
        own. It keys the picked bone, or every bone moved, at the playhead
        with an ease.
      - **The dope sheet** (`dopeSheet.ts`, under the preview) has a row per
        bone and a diamond per key. Click a track to scrub, and drag a key to
        retime it. A picked key takes any of the timeline's eases (linear,
        smooth, step, or its own curve in the curve editor), and can be
        deleted. **New clip** starts a taunt.
      - **How keys play:** a keyed bone's channels are baked from its keys.
        A linear span is two keys, and a step holds until 1 ms before the
        next. A smooth or curved span is sampled 30 times a second. The keys
        themselves are stored with the clip (`AnimationClip.keys`), so the
        sheet edits keys, not samples. A bone of an imported clip shows its
        channels' own keys, and keying it leaves every other bone's channels
        untouched. The player is unchanged: a keyed clip is an ordinary clip
        to the animator and to GLB export.
      - **Weight painting** (`weightPaint.ts`): a brush sphere in bind space,
        fading smoothly to its edge. Add and subtract move the bone's share,
        and the vertex's other bones make up the difference. A bone taken off
        a vertex it carried alone hands it to its parent. Smooth blends toward
        the edge neighbours, and normalise rescales and drops slivers. The
        four strongest bones are kept, and every split copy of a vertex
        agrees. The heat map shades each front-facing triangle by its
        weight: blue for none, through green, to red for all.

      In `rigging-keyframes.test.ts`, every brush leaves every vertex
      summing to 1 within 1e-6. A subtract on the helmet crown hands exactly
      the faded strength to `chest`. Loose weights summing to 1.6 normalise.
      Eases bake as promised, for example smoothstep(¼) = 0.156 of the way
      in angle a quarter of the way through a smooth span. Keys survive the
      cart's save and load.
      *Lockout:* a 1.6 s taunt (right arm raised and pumped, chest turned,
      head nodding) is keyed through pose mode: 23 keys on 14 bones, baked to
      165 samples. Played through the cart's animator for 96 ticks, it
      matches the same clip exported to GLB and re-imported to within 1e-5
      on every skinning matrix. Its hand rises more than 20 cm at the peak.
      The run is tuned with a 0.15 rad deeper chest lean keyed between two of
      its keys. Through the animator, the chest leans exactly that much
      further there, and the legs and hips are unchanged.
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
