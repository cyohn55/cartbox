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
- [ ] **A2. The heavy weapons.**
  - Rocket Launcher.
  - Spartan Laser (charges, then fires).
  - Fuel Rod Gun.
  - Brute Shot.
  - Concussion Rifle (throws what it hits).
  - Gravity Hammer (smashes and throws everyone in front).
  - **Pads:** these join the rotations, and a new pad on the arena floor carries the heaviest.

## Not in this roadmap

- **Turrets, vehicles, and anything only a vehicle carries.**
- **Flight time, bounce and arc for projectiles** (see above).
