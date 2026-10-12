# Lockout equipment roadmap

Lockout gains the abilities other Halo games added to the sandbox:
- **From Halo 2 and 3:** dual wielding, Halo 3's Power Drain and Regenerator.
- **From Reach:** the Jetpack and the Hologram (a decoy).
- **From Infinite:** the Grappleshot, the Repulsor and the Drop Wall.

A **loadout** picker chooses what a player spawns with: weapons, a second gun to dual wield, and a piece of equipment. Each item ships as its own PR with tests.

## Where Lockout stands

- **Two weapon slots:** six weapons from five pads, and two plasma grenades.
- **No equipment and no loadouts.** A game type sets the starting weapon, plus a Magnum.
- **Online play is host-authoritative (LOCKOUT_MULTIPLAYER_ROADMAP.md L5–L8):**
  - a guest sends inputs (`EV.INPUT`, one a tick) and predicts its own moves;
  - the host moves every soldier and judges every hit;
  - what everyone must see (shots, swings, grenades, pickups) goes out as events.
- **Tight limits:**
  - the cart is close to Lua's 200 locals a chunk;
  - all 15 event kinds are named, though `EV.HIT` (1) and `EV.HEALTH` (13) are never sent;
  - a soldier's four net words have only 4 spare bits (w2, bits 28–31);
  - a guest's input word has 8 spare bits (the second word, bits 24–31).

## Conventions

- **One equipment slot**, as in Infinite. A piece of equipment has charges, or fuel for the Jetpack, and a recharge. It's used with a new input action, `equipment`: E on a keyboard, RB on a controller, and a touch button.
- **Movement abilities run in `move_soldier`:**
  - the Jetpack's thrust;
  - the Grappleshot's pull;
  - the Repulsor's knockback (a horizontal velocity that decays).

  The equipment held and the `equipment` button travel in the guest's input word, so the host moves a guest exactly as the guest predicts itself. A guest's aim pitch is rounded the way it's sent, as its yaw already is.
- **Deployables share one event kind**, `EV.EQUIP`, with a sub-kind and a 3-bit id per owner. It takes kind 1, declared as `EV.HIT` but never sent. These are the Drop Wall, the Hologram, the Power Drain and the Regenerator.
  - An owner's deployable starts from a state every browser reproduces to the bit, as a grenade does.
  - The host applies what touches health or shields: a drain, a regeneration, a wall soaking shots.
- **No new top-level locals.** The new systems live in global tables (`EQ`, `LOADOUTS`, …) and global functions.
- **Bots use what they spawn with**, by simple rules: jetpack up to a target above, wall off when hurt, and so on.
- **Saved careers and settings keep loading.** The default loadout is "Standard" (the game type's weapon and a Magnum, no equipment), so a match plays exactly as before until a player picks another.

## Items

- [x] **E1. Loadouts, the equipment slot, and the Jetpack.**
  - **Loadouts:** a list, each with a primary, a secondary (or a second gun to dual wield, E5) and a piece of equipment.
    - Picked on the title screen (Left/Right).
    - Picked while waiting to respawn (the swap button cycles it), taking effect on the next spawn.
    - Remembered in the career save.
    - SWAT and Team Snipers keep their fixed weapons.
  - **The `equipment` input action:**
    - E, RB, or a new touch button.
    - The touch pad gains a button for every input action no face button carries: grenade, zoom, equipment. The layout editor can move them like any other.
  - **The visor shows** the equipment, its charges or recharge, and the Jetpack's fuel.
  - **The Jetpack (Reach):**
    - Hold equipment to rise. Fuel drains in the air and refills on the ground.
    - Flames and a roar, which others see and hear (a "jetting" bit in the net state).
  - **Bots** with a Jetpack rise toward a target above them.
  - **Done.**
    - **Loadouts:** `LOADOUTS` holds Standard (the game type's weapon and a Magnum, kept through a life as always) and Jetpack (BR, Magnum, Jetpack).
      - A non-Standard loadout is given at every spawn (`eq_on_spawn`, called from `respawn`; on a guest, when the host respawns it).
      - Left/Right on the title screen picks it. While dead, the swap button cycles the next life's. Swap is used there because a stick still held from the fight would otherwise change it.
      - The pick is kept in the career save. Game types with `fixed` weapons (SWAT, Team Snipers) always spawn Standard.
    - **Bots** carry equipment, at random, only when the player has picked a loadout with equipment (online, the host). A Standard match is Lockout exactly as before, and the existing bot-driven tests keep their behaviour.
    - **The Jetpack** runs in `move_soldier` (`eq_move`): held, it lifts by 0.05 a tick toward a top speed of 0.12, for 150 ticks of fuel. Fuel refills at 1.5 a tick on the ground once the button is let go.
      - A guest's input word carries its equipment's id and the button, held and pressed (bits 24–28 of the second word). The host flies the guest with the very same steps.
      - The guest keeps the fuel with each pending input, so a replay after a correction starts from the right tank.
      - The net state carries "jetting" and the equipment's id (w2 bits 28–31). Everyone draws the flames (`jetflame`), a glow and the roar (`jet`).
    - **Bots fly:** a bot with a Jetpack and a target more than 2.5 m above it, within 14 m, leaves its navmesh agent, thrusts up toward the target and drifts over, still fighting. It takes its agent up again when it lands.
    - **Touch:** `TouchInput.setActionButtons` adds a pill button for each input action with no console button. Layout ids `act:<name>` let the layout editor move and resize them, and the player merges them into the held actions.
    - **The visor:** the equipment's name (right, under the grenades), and the Jetpack's fuel as an arc left of the reticle.
    - **Tests:** `Unit Tests/lockout-equipment.test.ts`, on the real engine:
      - the Jetpack lifts while its fuel lasts, and refills on the ground once let go;
      - a Standard spawn has nothing;
      - Left/Right picks a loadout, and swap while dead cycles the next life's;
      - online, the host flies a guest the same flight as the guest's own prediction (a few ticks later, to the centimetre, with at most one correction), and sees its flames.

      `scripts/verify-touch-layout.mjs` checks that the action buttons show and move.

- [x] **E2. The Grappleshot and the Repulsor (Infinite).**
  - **Grappleshot:** fires a line along the aim; if it meets a surface within 25 m, it pulls the soldier there. Jump lets go. 3 charges, recharging.
  - **Repulsor:**
    - A blast in front that throws enemies back.
    - Against a wall close ahead, it throws the user away instead.
    - Recharges over 10 s.
  - **Bots** grapple up to targets and repulse close enemies.
  - **Done.**
    - **Loadouts:** Grappleshot (BR, Magnum) and Repulsor (SMG, Magnum) join Standard and Jetpack.
    - **Charges** (`eq_recharge`): the Grappleshot has 3, one back every 7 s; the Repulsor has 1, back in 10 s. The visor shows the count after the name, and the next charge's recharge on the arc the Jetpack's fuel uses.
    - **The Grappleshot** (`grapple`, in `move_soldier`):
      - A press casts a line from the eye along the aim. It costs a charge only if it meets a surface within 25 m.
      - While it holds, it pulls at 0.42 a tick toward the point (walls still stop the soldier).
      - It lets go on arrival, on a stall, after 2 s, on a jump or on another press. The pull carries on as a swing, with a hop.
    - **The Repulsor** (`repulse`):
      - A wall or the floor within 2.5 m along the aim throws its wearer back off it (aimed at the feet, it's a launch).
      - Every soldier within 6 m, in a 60° cone ahead and in sight, is thrown away and up.
      - A throw is a sideways speed that dies away (`kx`/`kz`, run in `eq_move`), faster on the ground.
      - Grenades fly on as thrown: every browser flies a grenade from its one throw, and a mid-air push would split them.
    - **Online:**
      - **The guest's aim.** A guest's pitch is rounded as it's sent before it moves, so a grapple goes where the host will cast it.
      - **What the guest keeps.** A guest keeps its fall and its equipment's state with each input (`EQ_KEEP`). A replay starts from those (quietly, `EQ_QUIET`: no effects or events twice).
      - **One event kind.** `EV.EQUIP` (kind 1, the never-sent `EV.HIT`) carries three things: a grapple's line, a blast (for others to draw), and a throw.
      - **Throws.** Throws are the host's to apply. It throws its copy of a guest after the last input it applied, at the very speed it sends. The guest throws itself after that same input and replays its inputs since (`guest_knock`), the view eased as for a correction.
      - **The net state** carries the grapple's line being out, on the Jetpack's "jetting" bit.
    - **Bots:**
      - A bot with a Grappleshot, a charge and a target over 2.5 m above it (or 16–24 m off) casts at the floor at the target's feet. It leaves its agent to ride the line (`bot_swing`), and takes its agent up again once it's down and still.
      - A thrown bot does the same.
      - A bot with a Repulsor blasts an enemy within 4 m.
    - **Tests** (`Unit Tests/lockout-equipment.test.ts`):
      - A grapple pulls the player 4 m up a wall to within 0.55 m of where it held, and its charge comes back.
      - A bot grapples 3.7 m up and lands back on its agent.
      - A blast throws a bot from 3 m to 6 m and back onto its agent.
      - Aimed at the feet, a blast launches its wearer 2 m up.
      - Online, the host pulls a guest the very path the guest predicts (4 ticks later, to the centimetre), and a guest the host's blast throws throws itself the host's way to the centimetre, with one correction.
- [x] **E3. The Drop Wall (Infinite) and the Hologram (Reach).**
  - **Drop Wall:**
    - An energy wall set down in front.
    - It stops shots both ways (every hit test, the host's included), soaks 150 damage, and lasts 10 s.
  - **Hologram:** a copy of the user that runs where they aim for 6 s. Bots fire on it, and a hit pops it.
  - **Done.**
    - **Loadouts:**
      - Drop Wall: BR, Magnum. One charge, back in 15 s.
      - Hologram: BR, SMG. One charge, back in 12 s.
    - **What's been set down** lives in `DEPLOY`, everyone's, in every browser:
      - The soldier's own browser sets one down (`deploy`); the host does so for its bots.
      - It tells the others with `EV.EQUIP` kind 3: what, its number, where (to the centimetre across and 5 cm up) and its facing (a 64th of a turn). The owner keeps the same rounded spot, so every browser's copy stands in the same place.
      - It's not done in a guest's replay. The host leaves a guest's to the guest, who tells it.
      - One of each a soldier at most.
    - **The Drop Wall** is a 3.2 m × 2.2 m panel of blue plasma (the `drop wall` prefab, eight in reserve), 1.6 m ahead, square to the facing.
      - **What it stops:**
        - `seg_blocked` and `seg_first` see it (`wall_cross`), so it stops every shot: the player's, a guest's as the host judges it, and the sparks.
        - The bots still see through it, and their rounds strike it.
        - Movement, grapples and Repulsor launches pass through (`solid` tests).
      - **Damage:**
        - It soaks the round's damage (`shot_wall`), where damage is judged: offline, or on the host.
        - The host says when it breaks (kind 4), and every browser takes it down.
        - It runs out after 10 s on its own.
    - **The Hologram** is a soldier instance (two at once: instances 19 and 20, at rest scale until placed — `cartbox.place`, with the new `cartbox.look` for its owner's armour, since the seven bots and the viewmodel fill a frame's eight poses), in its owner's armour and running.
      - **How it runs:** the way its owner faced, for 6 s, through the very moves a soldier makes, so it runs the same path in every browser. It fades in its last half second, and is gone if it runs off the edge.
      - **What it fools:** bots take an enemy's Hologram for a target and fire on it.
      - **Popping it:** a hit from a bot or a player pops it, hurting nobody. Whoever popped it tells the rest.
    - **Bots** set a wall down between them and whoever broke their shield. Now and then they send a Hologram off to one side of a fight.
    - **Saved Spartans** dress the Holograms too. A cart saved before they existed lends them its first bot's model.
    - **Grenades** pass through a Drop Wall, flying as thrown in every browser.
    - **Tests** (`Unit Tests/lockout-equipment.test.ts`):
      - A wall takes all of a bot's rounds meant for the player (143 soaked over 171 ticks), breaks, and then the rounds reach the player.
      - A bot goes for a Hologram and pops it.
      - The player's shot pops an enemy's Hologram.
      - Online: a guest's wall stands on the host at the same spot, stops the host's shots, and when the host breaks it, it goes on the guest too.
      - Online: a guest's Hologram runs on the host to the same spot.
- [ ] **E4. The Power Drain and the Regenerator (Halo 3).**
  - **Power Drain:** a device that's thrown and lands. It pulses for 4 s, stripping the shields of everyone near it, its thrower included.
  - **Regenerator:** a device set down that recharges everyone's shields within 5 m for 10 s, and holds off damage-free recharge waits.
- [ ] **E5. Dual wielding (Halo 2/3).**
  - **What dual-wields:** the SMG and the Magnum, in matching or mixed pairs, from a loadout or by picking a second one-handed gun off a pad while holding swap.
  - **Firing:** the right gun on fire, the left on the grenade action. No grenades while dual wielding.
  - **Drawing it:** a mirrored left-hand viewmodel; others see it in the net state.

## Not in this roadmap

- **Vehicles**, and equipment that only matters to them (an EMP's vehicle stall).
- **New weapons** beyond the SMG and the Magnum for dual wielding.
