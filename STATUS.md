# Cartbox — build status & how to see it

A fantasy-console **platform** built on TIC-80 (MIT): play tiny games in the
browser, make/sell them, and — the differentiator — a social/meta layer with
deterministic replays, server-verified scores, achievements, avatars, and
profiles. This file is the map: what exists, and how to look at each piece.

## How to see it (fastest first)

| Want to… | Do this |
|---|---|
| **See the engine + player run in a browser** | The demo server is running on port **8099** → open `http://localhost:8099/packages/player/examples/smoke-test.html` (press ▶). If it's not up: `npm run serve:demo` from `Working/tic80-console`. |
| **Prove the engine renders (headless)** | `npm run verify:engine` → renders a real cart, prints PASS. |
| **Run the test suite** | From the repo root: `npx vitest run --config "Working/tic80-console/vitest.config.ts"` → **62 tests**. |
| **Typecheck the web app** | From `Working/tic80-console`: `npx tsc --noEmit -p apps/web/tsconfig.json`. |
| **Build the web app** | `cd apps/web && npx next build` (needs the `NEXT_PUBLIC_*` env; see infra/.env.example). |
| **Boot the whole thing locally (one command)** | Install Docker + the Supabase CLI, then `npm run bootstrap` — brings up Supabase + MinIO, applies the schema, seeds a demo cart/achievement/user, wires the engine, writes `.env.local`. Then `npm run dev --workspace apps/web` → `http://localhost:3000` (demo login `demo@cartbox.dev` / `demo1234`). |
| **Run the verification worker** | `node --env-file=apps/web/.env.local services/render/src/index.js --verify --watch` (verifies submitted scores + grants achievements). |
| **Read the plan/design** | `BUILD_PLAN.md`, `PLATFORM_LAYER.md`, `CONSOLE_MODELS.md`, `MVP_3_tic80_pro_console.md`. |

## What's built

### Engine + player (proven end-to-end)
- **`packages/engine`** — TIC-80 compiled to WASM via a thin `cbx_*` C shim
  (`shim.c`), built by `scripts/build-wasm.sh`. Exposes framebuffer, audio, input,
  a per-console deterministic clock, and the **event mailbox** (pmem-backed).
- **`packages/player`** (`@cartbox/player`) — the embeddable player: model-aware,
  fixed-timestep loop, canvas/audio/touch, **deterministic replays**, RNG seeding,
  the **mailbox decoder**, replay **verification**, and the **cartbox SDK**.
- Proven: the engine renders real carts (headless + in-browser screenshots), and
  determinism/replay/mailbox/verification/achievements are each proven end-to-end
  through the real WASM engine.

### Multi-model architecture
- `ConsoleModel` registry (`models.ts`): **classic** (240×136), **pro**, **voxel**
  are fixed specs; the player/replays/thumbnails parameterize per model. Carts
  carry a `console_model`.

### Platform P1 — identity & replays
- **Deterministic replays** (record + playback + serialization), **RNG seed
  injection** (Lua), a **replay viewer** page, and the **Mii-style avatar**
  compositor + profiles.

### Platform P2 — meta & anti-cheat
- **Mailbox bridge + cartbox SDK** (`cartbox.unlock/score/progress`), **score
  submission**, a **verification worker** that re-runs replays headlessly to
  confirm scores and **grant achievements** (tamper-proof), plus **achievement
  registration**, leaderboards, and profile **trophies**.

### Web app (typechecks + builds; needs services to run)
- Next.js App Router: home, browse, `play/[cartId]`, `replay/[id]`,
  `profile/[handle]`, `profile/edit`, `login`, jams — plus API routes for carts,
  checkout, replays, scores, achievements, avatar, jams, and the Stripe webhook.
- **Sign-in** (email+password via Supabase Auth) with SSR session middleware.

## Test status
- **62 unit tests** (player scaling/input, replay, cart seeding, mailbox,
  verification, achievements, avatar, pricing, slug, jam, thumbnail render).
- Web app: **`tsc --noEmit` clean** and **`next build` succeeds** (16 routes).

## What still needs doing (honest)
- **Provisioning:** Supabase + R2 + Stripe must be stood up (infra/README.md) for
  the app and the workers to actually run.
- **Lua-only** for RNG seeding + the SDK (other script languages: additive).
- **Voxel/Pro models** are registered specs, not yet built engines.
- **Not shipped:** unlock-only verification (no score), NFC/collectible carts, the
  desktop editor (Tauri), and real sprite art for avatars (placeholders now).
