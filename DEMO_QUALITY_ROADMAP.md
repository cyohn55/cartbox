# Demo quality roadmap: Lockout and Beaver Creek

A review of the two arena demos (`/lockout` and `/lockout?map=beaver`) for **visual fidelity**, **performance** and **gameplay**, and the work it recommends.

Most of the renderer work these demos need has already shipped through `AAA_FIDELITY_ROADMAP.md` (F0–F10), and most of the content work is already named in `BEAVER_CREEK_ROADMAP.md` (B2, B9, B10). This roadmap does not repeat either. It does three things:

- it orders the open items of those roadmaps that block the demos (F0e, F11a, B2, B9, B10, H12, H13) by what they cost the player;
- it adds the items those roadmaps don't cover, found in this review;
- it adds a **gameplay track**, which no roadmap has had since the sandbox (A1–A2, E1–E5) and the netcode (L1–L8) shipped.

## How the review was done

- **Code.** The cart's Lua (`lockoutCode` in `lockoutSeed.ts`), both seeds, the map registry (`arenaMaps.ts`), the demo page (`apps/web/src/app/lockout/LockoutGame.tsx`) and the WebGPU renderer.
- **Images.** The F11a-1 captures in `captures/f11a/`.
  - They predate F11a-9 to F11a-13 (the physical re-light and albedo calibration), so they show the AAA path's look before those items landed. They are evidence for content problems (geometry, textures, sky, foliage), which those items don't touch, and only weak evidence for tone and exposure.
- **Measurement.** Each map's sidecar was built and parsed in Node on this container (one run, desktop-class V8, no GPU):

  | Map | Sidecar build | JSON parse | Size |
  | --- | --- | --- | --- |
  | Lockout | 2,020 ms | 7 ms | 2.70 MB |
  | Beaver Creek | 2,423 ms | 5 ms | 2.68 MB |

  No frame times could be taken: this environment has only SwiftShader, on which an AAA Lockout frame takes minutes (F11a-11).

## Findings

### Visual fidelity

**Beaver Creek has Lockout's sky.** `BEAVER_LIGHTING` spreads `LOCKOUT_LIGHTING` (`beaverCreekSeed.ts:704`), so a midday canyon at 600 m sits under the painted sky of an arena 3 km up. In every Beaver capture, the band above the canyon rim is near-black navy. B7's "midday grade and sky for the valley" was left open in B9.

**Beaver Creek has no vista.** The canyon rim meets the sky directly, with the rim's trees silhouetted against it. Lockout has a far terrain and a far forest (`lockoutVista`, `LOCKOUT_VISTA_FOREST`), and Beaver has neither. This is also left in B9.

**The canyon's terrain is under-resolved.** Beaver's grass, sandstone and mud are **128² albedo-only** textures (`beaverTextures`), with no normal or roughness maps, over a 66 m × 32 m floor and walls up to 24 m. Lockout's surfaces are 256² with normal maps. In the captures, the sandstone strata smear into streaks across the slopes, and the grass tiles visibly. Lockout's chasm walls show the same **UV stretching**, vertically. B6's triplanar mapping fixed it on Beaver's cliffs but was never applied to Lockout's terrain.

**The foliage is primitive.** The `broadleaf` and `pine` presets (`foliagePresets.ts`) are faceted solid crowns and stacked cones. They read as placeholder art at any distance closer than the impostor switch (32 m), which is where the trees on the rims are seen from the bases.

**Lockout's snow patches are hard-edged polygons.** `snowPatch` builds flat octagons over the deck (`lockoutSeed.ts:875`). From any height they read as white stickers. F5e already provides a weather layer in the material system (snow driven by a height and occlusion mask) that would blend them into the deck.

**The bases and Spartans are still grey box and block-built.** Both are already named: B9 ("the bases rebuilt from the Forerunner kit", the cave, mud and wet stone at the creek) and B10 (Mark VII-style Spartans).

**The lens stack is heavy.** Every capture carries a large sun starburst, a ghost disc and wide bloom. On the AAA path, contrast fell 6–29% in all seven views (F11a-1). F11a-3 to F11a-5 corrected the sky, bloom and curve to match the authored look. No item has yet re-tuned the authored look itself, which was made for the byte path.

### Performance

**Each map's sidecar is synthesised in the browser on the main thread.** `arenaMap(id).sidecar()` generates the geometry, bakes the procedural textures, encodes PNGs, and serialises a ~2.7 MB JSON string with base64 images, all before the player decodes any of it. That took **2.0–2.4 s per map** here, which projects to several seconds on a phone. The page then holds the string, the parsed scene, the decoded images and their GPU copies at once.

**Both maps ship in one bundle.** `arenaMaps.ts` statically imports both seeds, Beaver's textures and both maps' generated light maps, probes and kit maps (about 600 KB of base64 in TypeScript). Every visitor downloads and evaluates the generators and bakes for both maps, whichever map they play. B2 ("a shared asset pack and a sidecar per map") is still open.

These two together are the most likely cause of the open iOS question in `BEAVER_CREEK_ROADMAP.md`, where pressing Play does nothing on an iPhone or iPad. A memory-pressure reload in iOS Safari matches this peak-memory profile.

**The default frame is read back to the CPU.** The 360 tier draws through WebGPU or WebGL2, reads the frame back and composites it on the CPU. The gpuPacing fix (F11a) stopped the 1 fps collapse by shrinking the render to as little as 0.35 of the frame. GPU presentation (F0a, `?present=gpu`), which holds the byte path within half a level, is still opt-in. In a first-person shooter, the one to two frames of latency the readback adds go straight to input lag.

**Pipelines compile synchronously.** There are 43 `createRenderPipeline`/`createComputePipeline` call sites in `packages/player/src/render`. Only the material-graph variants use the async form. On real hardware this shows as **first-use hitches**: the first explosion, the first plasma bolt, and the first time a cascade or GI pass is enabled.

**The main-thread exit of F0e is unmet, and nobody has measured it on hardware.** The renderer's JS measured 4.2–5.5 ms a frame in Node against an exit of 4 ms. F11a's captures and per-device frame times both need a real GPU. Until there is one, no performance or fidelity claim about these demos can be checked.

### Gameplay

**Auto-aim decides every locked shot, whatever the aim-assist setting.** `player_fire` always calls `auto_target` (`lockoutSeed.ts:5506`), and a lock re-aims the shot at the enemy's chest, at y + 1.2 (`:5556`). The lock is wide and imprecise in three ways:

- **Wide:** the cone is 0.28 rad (16°) of yaw.
- **Yaw only:** it ignores pitch, so an enemy on another level is locked.
- **Nearest first:** it takes the nearest enemy, not the one under the reticle (`:5271`).

This has four consequences:

1. Turning aim assist **Off** in the controller settings (C3) only stops the pitch nudge. Bullet magnetism stays at full strength.
2. A mouse player's precision is discarded whenever any enemy is within 16°.
3. A shot aimed at a far enemy hits a nearer one that is off-reticle.
4. **Headshots are effectively impossible with zero-spread weapons.** A shot counts as a headshot when it passes above y + 1.5 (`:5591`). A shot locked at the chest only gets there through spread, and the Sniper Rifle and Beam Rifle have none. Their 3× headshot multiplier never applies.

**Hitboxes are one sphere.** A target is hit when the ray passes within 0.9 m of a point at chest height (`:5571`). The "head" is the part of that sphere above 1.5 m, which reaches 0.4 m above the top of a 1.7 m Spartan.

**Bots hit by dice roll.** Each bot shot hits with a flat probability: 30% with shields on and 50% without (`:5809`). Distance, weapon spread, the target's movement and cover do not change it, and a random 12% of hits are headshots. Bots also have no aiming to speak of:

- they turn to face a target instantly (`:5797`), with no reaction time or tracking error;
- they pick targets only within 40 m (`:5775`), so a sniper bot never uses its 150 m range;
- they **never throw grenades** (only the player calls `throw_grenade`);
- they never retreat to recharge shields or seek cover;
- there is **no difficulty setting**.

**Spawns are random.** `respawn` picks a uniformly random point from the team's spawns or the whole list (`:4451`). Nothing checks how close enemies are or whether they can see the spawn, so spawn kills are routine on a map the size of Lockout.

**Movement is minimal.** Velocity is instant, with no acceleration or air control (`move_soldier`). There is no sprint, clamber or slide, no crouch input (crouch is in the net state word but nothing sets it), and no dedicated melee or reload action. Melee fires automatically on Fire within 2.4 m, and reloading happens only on an empty magazine.

**Explosive and plasma weapons are hitscan.** Rockets, the Fuel Rod Gun, the Brute Shot, the Concussion Rifle and plasma bolts resolve instantly on the ray, and their trails are drawn along it. They cannot be dodged, which flattens the Halo sandbox they homage. Grenades are already real projectiles, replicated by the host, and are the model to follow.

**Matches have little feedback.** There are spree and multikill announcements, but no medals, assists, post-game carnage report or killcam (H13 open).

## Ground rules

- **Each item ships as its own PR with tests, merged when CI is green.**
- **The fantasy tiers don't change.** Every visual item that changes shading keeps the WebGL2/WebGPU/software parity rule for PS1 through the 360. Items marked *AAA* change the `aaa` tier only.
- **Gameplay stays deterministic and predicted.** Every movement or combat change is a step of the host's tick that a guest predicts and replays (L6, L7). Its tests include the network lab (L2) and the HD/Modern core comparison.
- **Original homages, faithful layouts** (`BEAVER_CREEK_ROADMAP.md`). The art is ours.
- **Measured, not asserted.** No performance item is closed on SwiftShader numbers. R1 provides the hardware.

## Track R: runtime performance

- [ ] **R1. A hardware measurement lab.**
  - One self-hosted runner, or a fixed set of manual machines, covering four device classes: a desktop discrete GPU, a desktop integrated GPU, an iPad and an iPhone. The `aaa` budgets in `deviceBudgets.ts` already name these classes.
  - `CBX_GPU=1 node scripts/capture-aaa.mjs` and `scripts/measure-main-thread.mjs` run on each class, plus a new **Lua tick profile** that times the cart's `TIC()` with 1, 4 and 7 bots.
  - Results go to `captures/<date>/` with `report.json`, as F11a-1's do.
  - *Closes:* F11a's captures and per-device frame times, and F0e's browser reading.
  - *Acceptance:* both maps captured from F11a's seven views on all four classes, with scene, presenter and main-thread times, and a frame-time histogram from a 2-minute bot match.

- [ ] **R2. Prebuilt map packages, loaded on demand** (completes B2).
  - Each map's sidecar is built **at build time**, not in the browser, into F9e's binary package format: KTX2 textures (F1a), meshopt geometry and a content-hashed URL.
  - The shared pack (Spartans, viewmodels, pickups, kit, sounds, effects, UI) is built once.
  - `arenaMaps.ts` registers each map by a dynamic `import()`, and the seeds, texture generators and generated bakes move out of the play bundle into the editor's.
  - The page fetches the shared pack and the chosen map's package while the lobby is open. It caches both (Cache Storage) and decodes on workers (F0e-2).
  - *Acceptance:* the `/lockout` play bundle contains no seed or generator code, and the time from Play to the first frame is measured on R1's iPhone.
  - *Tests:* the package round-trips to the same scene as the runtime build, byte for byte after decode; the play bundle has no import of `lockoutSeed` or `beaverCreekSeed`; the stale-bake check (B1) covers the packages.

- [ ] **R3. A peak-memory budget for phones.**
  - Measure the page's peak JS heap and GPU memory on R1's iPhone and iPad through a match on each map.
  - Then set an iOS row in `deviceBudgets.ts` and enforce it at load: texture mip bias, foliage density and shadow resolution step down to fit.
  - *Acceptance:* Play starts a match on R1's iPhone and iPad on both maps, which closes the open iOS question in `BEAVER_CREEK_ROADMAP.md`.

- [ ] **R4. GPU presentation by default.**
  - On WebGPU, the 360 tier presents from the GPU (F0a) without `?present=gpu`. The readback path remains for WebGL2 and for captures.
  - *Acceptance:* input-to-photon latency measured on R1's desktop classes (a high-speed camera or a flash-on-click test), before and after.
  - *Tests:* the default chooses GPU presentation on WebGPU and readback on WebGL2; F0a's parity test holds.

- [ ] **R5. Pipeline warm-up.**
  - Every pipeline either map can use (its material permutations, effects, equipment, explosions, GI and fog passes) is created with `createRenderPipelineAsync`/`createComputePipelineAsync` while the lobby and intro play.
  - The match starts when the warm-up is done, or after a timeout, past which the rest compile in the background.
  - *Acceptance:* no frame over 50 ms in R1's 2-minute match after the intro, on every device class.
  - *Tests:* the warm-up set covers every pipeline the match creates (a match that creates one outside it fails the test).

- [ ] **R6. Shader cost by quality** (finishes what the 1 fps fix found).
  - The fix found per-pixel shading to be the cost: a constant shader drew about 40× faster.
  - Each material compiles to a variant that leaves out the features it doesn't use (clearcoat, anisotropy, POM, refraction) and the features the quality level has turned off.
  - Half-resolution passes where the level allows: SSR, GTAO, volumetric fog.
  - *Acceptance:* the 360 tier holds 60 fps at native resolution on R1's integrated GPU without gpuPacing stepping down, and the `aaa` tier meets its budgets (High: 1080p60 upscaled; Medium: 30 fps on iPad).

## Track V: visual fidelity

- [ ] **V1. Beaver Creek's own sky and grade** (B7, left in B9).
  - A midday valley sky of its own: painted for the fantasy tiers, and F5a's physical sky at 600 m with fair-weather cumulus (F5c) on the AAA tier.
  - A grade tuned for a green canyon at noon.
  - *Tests:* `BEAVER_LIGHTING` no longer spreads Lockout's sky; the bakes are current.

- [ ] **V2. Beaver Creek's vista** (left in B9).
  - Far terrain beyond the rim (`Terrain` with a hole over the canyon, as `lockoutVista` does), a far forest layer, and distant ridges that hide the horizon line.
  - *Acceptance:* no view from inside the playable volume shows the sky below the rim's height.

- [ ] **V3. Terrain surfaces at resolution.**
  - Beaver's grass, sandstone and mud go from 128² albedo-only to 512² (Medium) and 1024² (High and up), with normal, roughness and height maps for height-based layer blending.
  - Each layer gains a **detail map** (H3) for close range and **macro variation** (a low-frequency tint) to break the tiling at range.
  - Mud and wet stone at the creek's edge (left in B9) blend by distance to the water.
  - Lockout's chasm walls take B6's triplanar mapping.
  - KTX2 throughout (F1a), streamed by mip (F1b), so the memory cost is bounded by R3.
  - *Tests:* the sidecar or package stays under budget; no surface stretches more than 2:1 (the triplanar test, extended to Lockout).

- [ ] **V4. Foliage worth looking at.**
  - The `broadleaf` and `pine` presets are rebuilt as branch geometry with **alpha-tested leaf cards** (F1a's hashed cut-out test). They get F6b's GPU foliage, the wind's sway (B6) and impostors baked from the new meshes.
  - The grass gains a second, denser card type near the camera, culled by distance.
  - *Tests:* the triangle budget per preset and LOD; the impostor matches the mesh's silhouette within a tolerance.

- [ ] **V5. Lockout's snow as a material layer.**
  - `snowPatch` and `drift` geometry give way to F5e's snow layer, driven by a painted mask, height and upward-facing occlusion, so snow gathers in corners and against walls with soft edges.
  - The drifts stay as geometry where they change the silhouette.
  - *Tests:* the arena's collision is unchanged; every tier draws the layer (fantasy tiers through the blended-terrain path).

- [ ] **V6. A lens and grade pass, measured.**
  - After R1's fresh captures, re-tune both maps' authored post: the starburst, ghost and bloom spread, kept for a look into the sun but no longer over every frame with the sun on screen, plus contrast and exposure.
  - Done on the fantasy tiers' rig (which the AAA re-light derives from) and checked against F10b's path-traced reference on the AAA tier.
  - *Acceptance:* contrast within 5% of the 360 tier's on every capture view, and a sun-in-view ghost no more than 10% of the frame's area.

- [ ] **V7. The bases and the cave** (B9). This is B9's item, listed here only for order.

- [ ] **V8. Mark VII Spartans and first-person motion** (B10, H12). These are B10's and H12's items, listed here only for order.
  - H12's reload, melee and run-bob clips land with G4's explicit melee and reload actions, which give them something to play on.

## Track G: gameplay

- [ ] **G0. A balance harness.**
  - The bot-match runner the tests already use ("a minute of Free for All has kills") runs N bot-only matches per map and game type, headless, and writes per-match statistics:
    - kills by weapon;
    - time to kill;
    - spawn kills (a death within 3 s of spawning);
    - deaths by place, as a heat map over the map's top view;
    - pad pickups;
    - match length.
  - *Acceptance:* a baseline report for both maps in `captures/balance/`, which G2–G5 compare against.

- [ ] **G1. An honest aim model.**
  - **The setting governs the assist.** Bullet magnetism follows the aim-assist setting (C3): Off has none, Standard keeps a narrow cone scaled by weapon (wider for automatics, narrow for precision weapons), and Strong keeps today's feel.
  - **The lock takes the enemy nearest the reticle,** measured by angle in both yaw and pitch, not the nearest in distance.
  - **Magnetism bends the shot toward the point the reticle is on,** not toward the chest, so a shot at the head stays at the head.
  - **Hitboxes:** a head sphere and a body capsule per soldier, posed by the animator's head and chest joints, replace the single 0.9 m sphere. The host judges against the same shapes, with L6's rewind.
  - The 8-button keyboard scheme, which has no pitch, keeps its auto-pitch.
  - *Tests:*
    - with assist Off, a shot 10° off a target misses;
    - a target nearer in distance but farther from the reticle is not locked;
    - a zero-spread headshot on a Sniper Rifle applies its multiplier;
    - the host and guest agree on a headshot in the network lab.

- [ ] **G2. Bots that aim and think.**
  - **Aim:** each shot's hit chance comes from an aim error that starts wide when a bot acquires a target and converges over its reaction time. The error grows with the target's angular speed, the weapon's spread and the distance. Facing turns at a capped rate.
  - **Difficulty:** Easy, Normal, Heroic and Legendary in the lobby, scaling reaction time, convergence and turn rate.
  - **Behaviour:**
    - grenades thrown at targets in cover or clustered;
    - a retreat to recharge when shields break, to a nav node out of the attacker's sight;
    - a pull toward power weapons on their timers;
    - engagement range from the weapon (a sniper bot engages past 40 m).
  - *Acceptance:* in G0's harness, Normal bots' accuracy falls with range and target speed, and a Legendary bot beats an Easy bot in at least 90% of 1v1 duels.
  - *Tests:* the difficulty survives a save and the match word; bots throw grenades; a bot with broken shields breaks line of sight within 3 s when a route exists.

- [ ] **G3. Safe spawns.**
  - Each candidate spawn is scored by:
    - its distance to living enemies;
    - whether any enemy can see it;
    - nearby teammates (in team modes);
    - recent deaths near it.

    The best of a random top few is chosen, so spawns stay unpredictable.
  - The host decides, as it does today.
  - *Acceptance:* spawn kills fall by at least half in G0's harness on both maps.
  - *Tests:* a spawn in an enemy's view is never chosen while a hidden one exists.

- [ ] **G4. Movement and actions.**
  - Acceleration and deceleration on the ground, and reduced air control, tuned so a strafe still reads as Halo.
  - **Crouch** (the net word already carries it): it lowers the eye and hitbox and hides the soldier from the radar.
  - **Explicit melee and reload actions** on their own keys and buttons (EP15), with auto-melee kept as an option for the 8-button scheme.
  - **Sprint and clamber** as a per-game-type option (Infinite's movement on, Halo 3's off), since they change the maps' routes.
  - All of it is predicted moves (L7).
  - *Tests:* each action replays identically on host and guest; Lockout's and Beaver's routes stay walkable (navmesh tests) with clamber off; a crouched soldier's head sphere is lower.

- [ ] **G5. Projectiles that fly.**
  - Rockets, the Fuel Rod Gun, the Brute Shot, the Concussion Rifle, plasma bolts and needles become projectiles with speed, gravity where it applies, and homing for needles. They are simulated by the host and replicated as events, as grenades are.
  - The ballistic precision rifles stay hitscan.
  - Bots lead moving targets with projectile weapons.
  - *Acceptance:* in G0's harness, rocket kills on targets beyond 20 m fall measurably.
  - *Tests:* a projectile hits the same target on host and guest; a side-stepping target dodges a rocket fired from 30 m; a needle homes.

- [ ] **G6. Match feedback.**
  - **Medals:** multikills, sprees, headshot, melee, plasma stick, and objective medals.
  - **Kill assists**, scored in Slayer.
  - A **post-game carnage report**: kills, deaths, assists, accuracy, best weapon and medals.
  - **Killcam** (H13): the killer's last 3 s from the host's snapshots (L4).
  - *Tests:* medals and assists agree on host and guest; the carnage report's totals match the scoreboard.

- [ ] **G7. Beaver Creek's layout confirmed and tuned.**
  - Confirm the layout list in `BEAVER_CREEK_ROADMAP.md` against the reference (its first open question). Resolve its departures:
    - the open roof versus an upper floor with a window;
    - the cave (with V7).
  - Tune pad timers and placements from G0's pickup and death heat maps.
  - *Tests:* B8's tests hold; the validator passes.

## Order

The order is set by what blocks the most else, then by what the player feels most.

1. **Measured and correct:** R1, then G1. R1 is the precondition for closing anything in Track R and for V6. G1 is a correctness defect (precision weapons can't headshot, and the assist setting doesn't govern the assist), and it is small.
2. **Playable everywhere:** R2, R3, R4, R5. R2 and R3 likely fix the iOS failure, and they must land before V1–V5 add texture and foliage weight.
3. **Plays like an arena shooter:** G0, then G2, G3, G5 and G4. G0 first, so the rest are judged by numbers. G4 last, as its sprint and clamber option is the most open design question.
4. **Looks the part:** V1, V2, V3, V5, V4, then V6. V6 comes last, as it tunes the frame the others produce.
5. **Characters and polish:** V7, V8, G6, G7 and R6. R6 is re-measured once the content is final.

## Open questions

- **Hardware for R1.** Self-hosted GPU runners, a device cloud, or a fixed set of the owner's machines run by hand. The roadmap needs one of them, and nothing in this environment can stand in for it.
- **Is the wide lock a design choice?** It may have been deliberate for the single-stick 8-button scheme. G1 keeps it there and on Strong, and the owner should confirm that Standard narrows it.
- **Movement era.** Should sprint and clamber (Infinite) be on by default, or Halo 3's movement? The maps were laid out for the latter.
- **The default bot difficulty** for the demo's first match (Normal is suggested).
