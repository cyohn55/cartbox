# @cartbox/player

Embeddable web cartridge player. Wraps the TIC-80 WASM build in a small, framework-agnostic API so any page
(gallery, cart page, external embed) can play a `.tic` cartridge.

## Public API (target)
```ts
import { mount } from "@cartbox/player";

const handle = mount(document.getElementById("player"), {
  cartUrl: "https://cdn.cartbox.dev/carts/abc123.tic",
  autostart: false,      // show a "Press ▶" poster first (mobile autoplay policies)
  controls: "touch",     // "touch" | "keyboard" | "auto"
  scale: "fit",          // integer-scale to container while preserving aspect
});

handle.pause();
handle.resume();
handle.destroy();        // free WASM instance + audio context
```

## Responsibilities
- Load + instantiate the TIC-80 WASM module once, feed it the cart bytes.
- Render to a `<canvas>`; integer-scale to the container, preserve the console aspect ratio.
- Input: keyboard mapping + an on-screen touch D-pad/buttons for mobile.
- Audio: create/resume `AudioContext` on first user gesture (mobile autoplay compliance).
- Lifecycle: clean teardown so many players can mount/unmount on a gallery page without leaks.

## Non-goals
- No editing. This is playback only. The editor lives in `apps/desktop`.
- No format changes. Consume the standard TIC-80 cart format unchanged for full catalog compatibility.

## Build dependency
Requires the WASM artifact from `packages/engine` (`npm run engine:build:wasm`). See that package's README.
