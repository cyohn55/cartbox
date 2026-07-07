# Build Plan — Fantasy Console + Cartridge Marketplace

> Working codename: **Cartbox** (rename before launch). Built on nesbox/TIC-80 (MIT).
> Target: solo-developer MVP in **6–10 weeks**, shippable in vertical slices.

---

## Guiding principles

1. **Marketplace first, editor second.** TIC-80's engine already exists and is excellent. The business is the *distribution layer* (gallery, payments, remix, jams). Build web/marketplace value before touching the desktop app.
2. **Ship playable in the browser on day one of real work.** A public URL where anyone can play an existing `.tic` cartridge is the earliest thing that proves the whole idea and can seed a waitlist.
3. **Stay compatible with the existing TIC-80 cartridge format.** Don't fork the VM's behavior — inherit the entire existing catalog of community carts as instant seed content.
4. **Respect the community.** Contribute fixes upstream, credit TIC-80 prominently, lead with creator revenue-share as the reason to join. Never present it as a replacement for the free tool.

---

## Tech stack (chosen for one developer)

| Layer | Choice | Why |
|---|---|---|
| Marketplace web app + API | **Next.js (App Router) on Vercel** | One codebase for landing, gallery, play pages, and API routes |
| Web cartridge player | **TIC-80 compiled to WASM** | TIC-80 already targets WASM; reuse it as an embeddable player |
| Database | **Postgres (Supabase)** | Managed, includes auth + row-level security |
| Auth | **Supabase Auth** (or Clerk) | Email + GitHub/Discord OAuth (this community lives on Discord) |
| File storage | **Cloudflare R2** | Cheap egress for cart binaries + thumbnails, S3-compatible |
| Payments | **Stripe + Stripe Connect** | Connect handles creator payouts + KYC |
| Desktop app | **Tauri** (Rust shell + web UI) | Tiny binaries, wraps the editor; lighter than Electron |
| Distribution | **itch.io first, Steam page in parallel** | itch.io is where this audience already is |

---

## Milestones

### Phase 0 — Foundations & validation (Week 0, ~3–5 days)
Goal: a public presence collecting signups while the engine builds.
- [ ] **Landing page live** collecting emails (`/landing` in this repo → deploy to Vercel/Netlify). *Acceptance: real form submissions land in a table/inbox.*
- [ ] Pick + register the name and domain; basic brand (logo, palette).
- [ ] Fork TIC-80; get the **native build** compiling locally. *Acceptance: `tic80` runs and loads a sample cart.*
- [ ] Get the **WASM build** compiling. *Acceptance: the WASM player loads a `.tic` in a local browser page.*
- [ ] License review pass: confirm MIT obligations (retain copyright/license text in the app "About" + repo NOTICE). Document any bundled third-party assets.

### Phase 1 — Embeddable web player (Weeks 1–2)
Goal: anyone can play any TIC-80 cartridge at a public URL.
- [ ] `packages/player`: wrap TIC-80 WASM in a clean JS loader (`mount(el, cartUrl)`), pause/resume, mobile touch controls, fullscreen.
- [ ] `/play/[cartId]` page renders the player from an R2-hosted cart.
- [ ] Responsive + touch D-pad/buttons for mobile web.
- [ ] *Acceptance: share a link, a stranger plays the cart on their phone with no install.*

### Phase 2 — Marketplace core (Weeks 2–4)
Goal: creators publish carts; visitors browse and play. No money yet.
- [ ] Auth (email + Discord/GitHub OAuth) and user profiles.
- [ ] **Publish flow**: upload a `.tic`, auto-extract title/author/thumbnail (render a frame), pick tags + license, publish. *Acceptance: a cart goes from upload to a live public page in <60s.*
- [ ] **Gallery**: browse, search, tag filters, "featured" and "trending" rails.
- [ ] Cart page: playable embed + description + author + like/favorite + comments (v1 comments optional).
- [ ] Seed content: import a curated set of permissively-licensed community carts (with attribution + creator opt-in) so the gallery isn't empty.

### Phase 3 — Monetization (Weeks 4–6)
Goal: creators sell carts; you take a cut.
- [ ] **Stripe Connect** onboarding for creators (Express accounts, KYC).
- [ ] Paid carts: free playable demo + pay-to-unlock full/source. Price set by creator.
- [ ] Checkout + entitlement (buyer's library of unlocked carts).
- [ ] **Platform take-rate 10–15%** on paid sales; automated payouts.
- [ ] Optional **$3–5/mo creator tier**: private carts, sales analytics, priority featuring.
- [ ] *Acceptance: a test creator receives a real payout minus fee; buyer sees purchase in their library.*

### Phase 4 — Desktop app + modern export (Weeks 6–8)
Goal: the paid one-time app with the features PICO-8 lacks.
- [ ] **Tauri wrapper** around the (reskinned) TIC-80 editor.
- [ ] **Cloud sync**: sign in, carts sync across machines via R2.
- [ ] **One-click export**: web (playable embed link), Windows/Mac/Linux binaries, and **mobile-web/PWA** — the top community request.
- [ ] "Publish to Cartbox" button straight from the editor → Phase 2 flow.
- [ ] *Acceptance: from a fresh machine, sign in → your carts appear → export a playable web build in one click.*

### Phase 5 — Jams, polish & launch (Weeks 8–10)
Goal: launch with a growth loop.
- [ ] **Game jam tooling**: create a jam (theme, deadline), submit carts, voting, results page. This is the proven community growth engine.
- [ ] Sell desktop app on **itch.io** (one-time $14.99–$19.99); set up the **Steam** page (review lead time is long — start early).
- [ ] Onboarding polish, empty states, docs/quickstart, a starter cart.
- [ ] **Launch event**: run the first jam yourself with a small prize pool + the revenue-share announcement as the hook.

---

## Definition of "MVP done"
A creator can: install the paid desktop app → make a cart → one-click publish → sell it → get paid; and a visitor can play any cart free in the browser on mobile. A jam is live to drive the first wave of content.

## Cost model (watch these)
- **COGS is tiny** vs. the SuperSplat option — no GPU. Main costs: Vercel, Supabase, R2 egress (cheap), Stripe fees.
- Stripe + Connect fees come out of the take-rate; price the take-rate (10–15%) above blended payment cost so marketplace sales are gross-margin positive from sale #1.

## Top risks & mitigations
- **Empty-marketplace cold start** → seed with opted-in community carts + run the launch jam yourself.
- **Community backlash** ("monetizing a free tool") → upstream contributions, prominent credit, creator revenue-share framing, keep the free web player genuinely free.
- **Cart-format drift** → pin to TIC-80's format; treat the VM as compatibility-frozen, add value only in the shell/marketplace.
- **Steam/itch policy + payout KYC** → start store pages and Stripe Connect setup in Phase 0/3, not launch week.

## Immediate next actions (this week)
1. Deploy the landing page and start collecting emails.
2. Fork TIC-80 and get both native + WASM builds green.
3. Lock the name/domain and set up the monorepo (see README scaffold).

---

## Roadmap beyond the store (platform + multi-model)

The MVP above is the substrate. The differentiated product is the platform layer
plus multiple console models. See `PLATFORM_LAYER.md` (social/meta features) and
`CONSOLE_MODELS.md` (the multi-model architecture) for detail. Sequencing:

1. **Classic console + Marketplace** (Phases 2–3 above) — built **model-aware**
   from day one (`console_model` on carts; the player, replays, mailbox, and
   thumbnail worker parameterize per model spec).
2. **Platform P1 — identity & replays**: profiles, Mii/Xbox-style avatar
   compositor, auto-recorded deterministic replays. No creator adoption needed.
3. **Virtual handheld overlay**: skinnable on-screen controller (Game Boy portrait
   / AYN-Thor landscape), auto-switching on orientation. Cross-model, frontend-only.
4. **Pro 2D model**: first console expansion (larger fixed spec).
5. **Platform P2/P3 — meta & trust**: the cart↔platform memory mailbox + `cartbox`
   SDK, achievements, leaderboards, then server-side replay verification (reuses
   the headless render worker) and showcases.
6. **NFC/QR collectible cartridges**: tangible editions that launch the web game —
   the realistic "physical cartridge" (literal GB/GBA carts are not feasible; see
   `CONSOLE_MODELS.md` §6).
7. **Voxel model**: the ambitious later tier — largest single build (no free engine
   to stand on, unlike TIC-80 for 2D).
8. **Dedicated handheld** (long-horizon): a Playdate-style device running the
   models natively — a separate hardware business.

Load-bearing decision: keep everything **model-aware now** so Pro and Voxel are
additive rather than a rewrite.
