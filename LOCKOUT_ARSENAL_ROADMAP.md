# Lockout arsenal roadmap

Lockout gains the rest of the weapons Halo's multiplayer sandbox is known for, and every gun Halo 2 and 3 let a Spartan dual wield.

**Lockout already has six weapons:** the Battle Rifle, SMG, Shotgun, Sniper Rifle, Magnum and Energy Sword. The SMG and the Magnum dual wield (LOCKOUT_EQUIPMENT_ROADMAP.md E5).

All designs are original homages, modelled in code like the rest of Lockout.

## Conventions

- **One weapon list** (`LOCKOUT_VIEWMODELS`, in `lockoutSeed.ts`). It orders the viewmodel instances, and it gives each weapon its index in the net state and in the shot and swing events.
  - The cart's `WLIST` and `WIDX` are written from it, as are the left-hand viewmodels (`VM_LEFT`) and the Pickup instances.
  - The index takes 5 bits (up to 32 weapons). The net state finds the extra two by carrying a soldier's facing to 1/2500 of a radian instead of 1/10000.
- **Pads rotate.** Each pad has a list of weapons, and each time its weapon is taken, the pad moves on to the next one in the list.
  - The rotation travels with the pickup event, and with the catch-up a new player gets, so every browser shows the same weapon on each pad.
  - Each weapon on a pad has its own Pickup instance there. The Pickup component shows only the one that's up.
- **Weapons are hitscan.** A shot hits the first body or wall along its line, as Lockout's guns always have.
  - Explosive weapons go off where their shot lands, and damage everyone near, the firer included.
  - Rockets, fuel rods and grenades have no flight time: an arena this small is crossed in a blink.
- **Damage goes through `weapon_hit`.** It applies a weapon's plasma bias (more against shields, less against health) and its needles' supercombine.
- **The host still judges every guest's shot**, now with its weapon's own rules: overcharge, splash, area melee.
- **Bots fight with everything** they pick up, under the same rules.

## Items

- [x] **A1. The dual wielders and the rifles.**
  - **One-handed, and dual wield:**
    - Plasma Pistol (overcharge strips shields).
    - Plasma Rifle.
    - Needler (homing; seven needles supercombine).
    - Spiker.
    - Mauler (a one-handed shotgun).
  - **Two-handed:**
    - Assault Rifle.
    - DMR.
    - Covenant Carbine.
    - Needle Rifle (three needles supercombine).
    - Beam Rifle.
  - **Loadouts:** Assault (AR and Magnum), Covenant (Carbine and Plasma Pistol), and dual pairs of the new one-handers.
  - **Pads:** the pads rotate through all of the above.
  - **Done.**
    - Ten weapons join `LOCKOUT_VIEWMODELS`, each with its own viewmodel (Covenant pieces in a violet shell with a glowing core, Brute pieces in iron), shot sound and tracer (plasma bolts, needles, the Beam Rifle's beam).
    - **Plasma** bites shields harder than health: the Plasma Pistol does double against shields and half against health, the Plasma Rifle 1.5 and 0.7. Holding fire on the Plasma Pistol for three-quarters of a second and letting go fires an **overcharge** that strips any shield, for ten rounds.
    - **Needles** home (a wider aim cone), stick, and **supercombine**: the seventh Needler needle, or the third from a Needle Rifle, bursts for 70 (45). A soldier's needles fade after two and a half seconds without another.
    - The five one-handers dual wield like the SMG and the Magnum, the left one on the grenade action. Seven new loadouts.
    - The five pads turn through 15 weapons: the sniper pad through the Sniper and Beam Rifles, the BR pad through the four precision rifles, the shotgun pad through the Shotgun and the Mauler, the sword pit keeps the sword, and the SMG pad turns through the six automatics and the Plasma Pistol.
    - Online, the weapon index is 5 bits, each pad's rotation travels with its pickup and with a newcomer's catch-up, and the host judges overcharge and supercombine.
    - In Oddball, a bot with a fight on goes for a loose ball within 15 m on its own level.
    - Tests: `Unit Tests/lockout-arsenal.test.ts`. The mesh sidecar budget is raised to 2.4 MB.
- [x] **A2. The heavy weapons.**
  - Rocket Launcher.
  - Spartan Laser (charges, then fires).
  - Fuel Rod Gun.
  - Brute Shot.
  - Concussion Rifle (throws what it hits).
  - Gravity Hammer (smashes and throws everyone in front).
  - **Pads:** these join the rotations, and a new pad on the arena floor carries the heaviest.
  - **Done.**
    - Six weapons join `LOCKOUT_VIEWMODELS`, each with its own viewmodel, report and streak (a rocket's smoky exhaust, the laser's red line). The hammer is held and swung like the sword.
    - **Explosive rounds** (`blast`, `bdmg`, `knock` in `W`) go off a step short of where they stop, through `blast_at`. Damage falls off from the heart to the edge, nothing solid may stand between, and the blast throws soldiers from it. The firer is hurt too, except by the hammer (`safe`).
    - Every browser shows the fireball from the shot event. Hurt is judged where hits are: offline, or on the host, which replays a guest's round to where it stopped.
    - The stats, as a blast's damage at its heart and its radius:
      - **Rocket Launcher:** 80 direct plus 140 within 4 m, so one rocket kills a full-shielded soldier. Two rounds, four spare.
      - **Fuel Rod Gun:** 75 within 2.6 m.
      - **Brute Shot:** 50 within 2.2 m.
      - **Concussion Rifle:** 30 within 2.8 m, and a hard throw.
      - **Gravity Hammer:** a swing whose smash at its wielder's feet ahead does 150 within 3.2 m and throws everyone in it.
    - The **Spartan Laser** fires only after its trigger is held for a second, whining as it charges. Let go early and the charge is lost. One beam (210) kills. Bots charge it too.
    - **Bots** fire them all, but never an explosive into their own blast.
    - **Pads:**
      - The sniper tower adds the Spartan Laser.
      - The shotgun nook adds the Brute Shot and the Concussion Rifle.
      - The sword pit adds the Gravity Hammer.
      - A sixth pad, out on the arena floor, turns between the Rocket Launcher and the Fuel Rod Gun.
    - **Rounds no longer pass through walls close by.** A round's first 5 m are traced on their own (`ray_first`): the arena's ray test skips the first 2% of its segment, which at a 90 m range let a shot through anything within 1.8 m.
    - The arena's light map and light probes are re-baked for the new pad (`npm run bake:lockout`, `bake:lockout-probes`). A scene may define 32 kinds of debris, up from 16, so every weapon but the sword can still be dropped.
    - Tests: `Unit Tests/lockout-arsenal.test.ts`. The mesh sidecar budget is raised to 2.8 MB (it is about 2.7 MB).

## Not in this roadmap

- **Turrets, vehicles, and anything only a vehicle carries.**
- **Flight time, bounce and arc for projectiles** (see above).
