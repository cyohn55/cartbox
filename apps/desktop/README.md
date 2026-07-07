# apps/desktop — Editor app (Tauri)

The paid one-time desktop app: a reskinned TIC-80 editor plus the features PICO-8 lacks — cloud sync,
one-click multi-target export, and "Publish to Cartbox."

## Why Tauri
Small binaries, native performance, Rust shell. Wraps the TIC-80 editor and adds an account/sync/export layer
around it without shipping a full browser (vs. Electron).

## Added value over base TIC-80 (this is what people pay for)
- **Account + cloud sync**: sign in; carts sync across machines via R2.
- **One-click export**: web (playable embed link), Windows/Mac/Linux binaries, mobile-web/PWA. ← top request.
- **Publish to Cartbox**: push a cart straight into the marketplace publish flow.
- **Polished onboarding**: guided first-cart, templates, better defaults.

## Distribution
Sell on **itch.io** (one-time $14.99–$19.99). Prepare the **Steam** page early (long review lead time).
The free web player (`apps/web`) is the top-of-funnel; the desktop app is the paid conversion.

## Build
`npm run tauri:dev --workspace apps/desktop` (dev) · `npm run tauri:build` (release).
Depends on the native engine build from `packages/engine`.
