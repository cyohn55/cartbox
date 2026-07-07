# Multi-Model Console + Unified Platform

> The product is a **platform that hosts several fantasy-console "models,"**
> unified by one model-agnostic social/meta layer. Models are *what you create
> in* (Classic, Pro, Voxel — each with fixed specs). The platform is *where
> creations live and how players engage* (profiles, avatars, replays,
> achievements) and works identically across every model.
>
> Constraints stay sacred — but *per model*, not globally. No free-form sliders:
> that would dissolve the aesthetic, the approachability, and the fixed-spec
> assumptions the platform layer depends on.

---

## 1. The `ConsoleModel` abstraction

A model is a **fixed spec + a runtime**. Everything that currently hard-codes
240×136 / 60fps reads from a descriptor instead.

```ts
export type ModelId = "classic" | "pro" | "voxel";

export interface ConsoleModel {
  id: ModelId;
  label: string;
  kind: "raster2d" | "voxel3d";

  // Display — the runtime always presents a 2D RGBA framebuffer to blit,
  // even the voxel model (it rasterizes its 3D scene to this buffer).
  width: number;
  height: number;
  pixelBytes: number;        // 4 (RGBA)

  fps: number;               // fixed timestep
  audioChannels: number;
  sampleRate: number;

  paletteSize: number;       // enforced by the editor, informational at runtime
  cartSizeBytes: number;

  engineUrl: string;         // the WASM build that runs this model
  inputs: Array<"gamepad" | "mouse" | "keyboard">;
}
```

**Key insight that keeps this cheap:** every model — including voxel — outputs a
2D RGBA framebuffer for display. So the player's blit path, the thumbnail
renderer, and the framebuffer read (`cbx_screen_ptr`) stay **model-agnostic**;
only the dimensions and the engine URL change. A voxel model swaps the *runtime*
behind the same adapter interface (`loadCartridge / tick / readFramebuffer`), not
the whole pipeline.

## 2. Model registry

```ts
export const MODELS: Record<ModelId, ConsoleModel> = {
  classic: {
    id: "classic", label: "Classic", kind: "raster2d",
    width: 240, height: 136, pixelBytes: 4, fps: 60,
    audioChannels: 2, sampleRate: 44100,
    paletteSize: 16, cartSizeBytes: 64 * 1024,
    engineUrl: "/engine/classic/tic80.js",
    inputs: ["gamepad", "mouse", "keyboard"],
  },
  pro: {
    id: "pro", label: "Pro", kind: "raster2d",
    width: 640, height: 360, pixelBytes: 4, fps: 60, // 16:9; Classic 2x (480x272) pillarboxed inside
    audioChannels: 8, sampleRate: 44100,
    paletteSize: 64, cartSizeBytes: 1024 * 1024,
    engineUrl: "/engine/pro/engine.js",
    inputs: ["gamepad", "mouse", "keyboard"],
  },
  voxel: {
    id: "voxel", label: "Voxel", kind: "voxel3d",
    width: 320, height: 180, pixelBytes: 4, fps: 60,
    audioChannels: 8, sampleRate: 44100,
    paletteSize: 256, cartSizeBytes: 2 * 1024 * 1024,
    engineUrl: "/engine/voxel/engine.js",
    inputs: ["gamepad", "mouse"],
  },
};
```

(Kept in code, versioned alongside the runtimes, rather than a DB table — the set
is small and tightly coupled to each engine build.)

## 3. How each subsystem parameterizes

- **Player** — `mount(el, { cartUrl, modelId })` looks up the model, loads its
  `engineUrl`, sizes the canvas from `width/height`, and computes framebuffer
  bytes as `width * height * pixelBytes`. `constants.ts` becomes the `classic`
  entry; `display.ts` / `player.ts` read the model, not globals.
- **Engine adapter** — the same `cbx_*` contract for all raster models; the voxel
  runtime implements the same `ConsoleInstance` interface behind a different
  engine. Screen size comes from the model.
- **Replays** — `{ modelId, cartId, cartHash, seed, inputStream }`. The input
  encoding is per-model (voxel may add look/analog axes); verification loads that
  model's headless engine (the render worker already runs engines out of browser).
- **Mailbox** — `cbx_mailbox_ptr` per runtime; the event record format is shared
  across models.
- **Thumbnails** — the render worker picks the cart's model engine and reads a
  framebuffer sized by the model.

## 4. Schema additions

```sql
alter table carts add column console_model text not null default 'classic';
alter table replays add column model_id text not null default 'classic';
-- scores reference the replay that produced them (verification re-runs it)
```

Models themselves live in code, not the DB.

## 5. Presentation: the virtual handheld (browser controller overlay)

**Yes — it runs in the browser today, and a skinnable handheld shell is a
first-class, cross-model feature.** The player already has a `TouchInput` class
rendering an on-screen D-pad + buttons; this promotes it to a themed *virtual
handheld*:

- **Portrait** — screen on top, controls stacked below (Game Boy vertical).
- **Landscape** — controls flank the screen left/right (modern handheld / AYN
  Thor style), with the game centered.
- **Auto-switch** on device orientation (`matchMedia("(orientation: …)")`), or a
  manual toggle.
- **Skins** — a "shell" is just a CSS/sprite theme (grey brick, translucent
  overlay, neon, …). Cosmetic; could even be a cosmetic unlock on the platform.
- **Wiring** — buttons map to the same `GamepadState` bitmask the engine reads;
  the button set is per-model (`model.inputs`). Add `navigator.vibrate` haptics on
  press.

This is the software realization of the handheld fantasy, it's pure frontend, and
it reuses input plumbing that already exists.

## 6. Physical & hardware — the honest version

**Q: can players download games to real Game Boy / GBA cartridges?**

**Literal answer: no — that isn't feasible.** Our games are TIC-80-family VM
programs (Lua/JS on a 240×136, 16-color virtual machine). A real Game Boy is a
different CPU and much weaker hardware (160×144, 4 shades, 8 KB RAM, no floats);
GBA is closer but still a major per-game native port. Putting a VM game on that
silicon would mean **rewriting each game in native code**, and most games exceed
the hardware anyway. "Game Boy" is also a Nintendo trademark. So the literal
feature is a dead end.

**But the *desire* — a tangible cartridge, playing on a real handheld — is
deliverable two ways:**

1. **NFC / QR collectible cartridges (near-term, feasible, a revenue line).**
   Produce physical cartridge-shaped collectibles carrying an NFC tag or QR that
   launches the game in the web player. Creators sell tangible editions of their
   games; the platform handles fulfillment and takes a cut. You get the
   cartridge-nostalgia and a merch business without the impossible port.
2. **A dedicated handheld (long-horizon hardware bet).** The runtime already runs
   on Raspberry-Pi-class hardware; a Playdate-style device that runs our models
   natively and loads games from the platform is the *true* "physical
   cartridge/handheld" version — **our own system**, not GBA. That's a real but
   separate hardware company, not a near-term feature.

Not on the table: literal GB/GBA repro carts of VM games.

## 7. Sequencing (feeds the build plan)

1. **Classic + Platform P1** (profiles, avatars, replays) — built **model-aware**
   from day one so later models are additive, not a rewrite.
2. **Virtual handheld overlay** — early, cheap, high delight; cross-model.
3. **Pro 2D model** — first console expansion (a second fixed spec of the same
   engine family; TIC-80 already exposes bits-per-pixel / bank options to base it
   on).
4. **Platform P2 / P3** — achievements, leaderboards, replay verification.
5. **NFC / QR collectible carts** — tangible merch + monetization.
6. **Voxel model** — the ambitious later tier (largest single build; no free
   engine to stand on — see PLATFORM_LAYER §voxel).
7. **Dedicated handheld** — long-horizon hardware.

## 8. Do-it-now item

Make the schema and player **model-aware immediately** (cheap now, expensive to
retrofit): add `console_model` to carts, turn `constants.ts` into the `classic`
`ConsoleModel`, and thread `modelId` through `mount()`, the engine adapter, the
replay format, and the render worker. Classic then ships on a frame that Pro and
Voxel slot into later.
