# Platform Layer — turning the store into a platform

> The pivot: not "a marketplace for TIC-80 carts" but **the social/meta platform
> the fantasy-console world lacks** — profiles, custom avatars, replays,
> achievements, leaderboards, showcases. Neither TIC-80 nor PICO-8 has any of
> this. That gap is the only genuinely differentiated version of this idea.

The console (TIC-80) is table stakes; you get it free. The web player and store
are the substrate (already scaffolded). This document sketches the layer on top
that would make the product *more* than PICO-8 rather than equivalent to it.

---

## 1. Feature set, organized by what it costs to ship

The critical axis is **adoption dependency**: some features you ship unilaterally
(they need no cooperation from creators), others require creators to instrument
their carts. Ship the first kind to build an audience; use it to pull the second.

| Feature | Needs creator work? | Effort | Notes |
|---|---|---|---|
| Profiles + follows + favorites | No | Low | Extends existing `profiles` table |
| **Custom avatars** (Mii/Xbox-style) | No | Med | Pixel-part compositor — on-brand for the aesthetic |
| **Replays** (auto-recorded) | No | Med | Host captures input; playback is deterministic |
| Play counts / trending | No | Low | Already partly in the schema |
| **Achievements** | Yes (SDK) | Med | Cart emits unlock events via the bridge |
| **Leaderboards** | Yes (SDK) | Med | Cart emits scores; replay-verifiable |
| **Verified scores / anti-cheat** | Yes (SDK) | Med | Server re-runs the replay to confirm |
| Showcases (pin achievements on profile) | No (once achievements exist) | Low | Pure web feature |

**Ship order follows the dependency:** avatars + profiles + replays need zero
creators, so they launch first and give people a reason to be here. Achievements
and leaderboards come once there's an audience worth instrumenting carts for.

---

## 2. Architecture

Three mechanisms carry the whole platform. Two of them fall out almost for free
from what's already built.

### 2a. The cart ↔ platform bridge (memory mailbox)

TIC-80's sandbox has no API for a cart to call the host. But the player already
reads engine state straight out of WASM memory (`cbx_screen_ptr` returns a
framebuffer pointer that the host reads each frame). The bridge uses the same
trick in reverse:

- Reserve a **mailbox region** in TIC-80 RAM (the existing `pmem` persistent-
  memory area — 256×32-bit — is the natural vehicle for the simple case; a
  dedicated reserved region for a richer event ring buffer).
- The cart writes structured events there — `{type, id, value}` records — using
  ordinary `poke()`/`pmem()` calls, wrapped in a friendly SDK (§4).
- Add one shim export, `cbx_mailbox_ptr(handle)`, symmetric to `cbx_screen_ptr`.
  The host reads the region **each frame**, diffs it, and forwards new events
  (achievement unlocked, score posted) to the platform API.

No engine fork required — it's a small shim addition plus a documented cart-side
convention. This is the same WASM-memory-reading pattern already proven in
`packages/engine/shim.c`.

### 2b. Deterministic replays (nearly free)

A fantasy console is **deterministic**: fixed 60 Hz, a deterministic VM, and — in
this build — a virtual clock the host controls (the `cbx_counter`/`cbx_frequency`
callbacks). The player already samples a **per-frame gamepad bitmask**. So a
replay is just:

```
replay = { cartId, cartHash, rngSeed, inputStream[] }   // one bitmask per frame
```

Input is tiny (a few KB for minutes of play). Playback feeds the stream back into
a fresh console frame by frame; determinism guarantees an identical result. The
recording side needs **no creator work** — it's entirely host-side capture.

Requirement for faithful playback: the cart must be deterministic (seeded RNG,
time only from the provided clock, no external I/O). Carts that qualify get a
"verifiable" badge; others still get best-effort replays.

### 2c. Server-side verification (reuses the render worker)

This is the payoff of 2a + 2b. To trust a submitted leaderboard score, the server
**re-runs the replay headlessly** and reads the mailbox score at the end:

- The headless Node engine + batch-worker infrastructure already exists
  (`services/render` runs the same WASM core out of the browser).
- Replay the recorded `inputStream` into a fresh console, read `cbx_mailbox_ptr`,
  confirm the final score matches the claim.

Deterministic replay verification is anti-cheat that large platforms struggle to
do; here it's a direct consequence of the engine you already built.

---

## 3. Custom avatars (the fun, unilateral feature)

A **Mii/Xbox-style pixel avatar compositor**, fitting the 16-color aesthetic:

- Avatar = a set of layered part choices (body, face, hair, eyes, accessory,
  palette) stored as a small JSON: `{ parts: {...}, palette: [...] }`.
- Rendered client-side by stacking part sprites; also renders to a static PNG for
  use next to cart listings, comments, and leaderboard rows.
- Parts are themselves tiny sprite sheets — creators could even *submit* avatar
  parts, feeding the marketplace loop.
- Zero engine involvement; pure web feature. High delight-to-effort ratio, and it
  gives every visitor an identity before they've played anything.

---

## 4. Creator SDK (`cartbox.lua` / `cartbox.js`)

So creators don't hand-write memory pokes, ship a tiny include:

```lua
-- in a cart:
cartbox.unlock("first_blood")      -- fire an achievement
cartbox.progress("distance", 1200) -- update a stat
cartbox.score(4200)                -- post to the leaderboard
```

Under the hood these write event records to the mailbox region. Adoption cost for
a creator is a few lines — the deliberate design goal, because achievements and
leaderboards live or die on adoption.

---

## 5. Data model additions (on top of the existing schema)

```
profiles      += avatar_json, bio           -- extend existing table
achievements    (id, cart_id, key, title, icon_key, secret)
unlocks         (profile_id, achievement_id, unlocked_at)   -- entitlement-style
scores          (cart_id, profile_id, value, replay_id, verified, created_at)
replays         (id, cart_id, profile_id, cart_hash, seed, input_r2_key, created_at)
showcase        (profile_id, achievement_id, slot)          -- pinned items
avatar_parts    (id, category, sprite_key, submitted_by)    -- optional UGC
```

Scores reference the replay that produced them; `verified` flips true after
server re-run (§2c).

---

## 6. Build phasing

Layered on the existing marketplace (Phases 2–3), which is the substrate.

- **P1 — Identity & replays (no creators needed).** Profiles, avatar compositor,
  auto-recorded replays + a replay viewer. Ships value on day one to anyone,
  independent of content. *~4–6 weeks.*
- **P2 — The bridge & meta (needs SDK adoption).** `cbx_mailbox_ptr` shim, the
  `cartbox` SDK, achievements, leaderboards, showcases. Seed adoption with a few
  first-party carts that use the SDK. *~6–8 weeks.*
- **P3 — Trust & anti-cheat.** Server-side replay verification (reuse the render
  worker), verified leaderboards, moderation. *~4 weeks.*

---

## 7. Honest risks

- **Adoption chicken-and-egg (the big one).** Achievements/leaderboards are
  worthless until creators instrument carts, and creators won't until there's an
  audience. Mitigation: P1 features need no creators, so build the audience first;
  seed P2 with first-party carts. But this is a real, unsolved go-to-market risk.
- **Determinism limits replay/verification.** Only deterministic carts get
  verified scores. That's a subset, and it constrains what "verified leaderboard"
  can cover.
- **Scope.** This is a *platform*, not a store — months of work, a broader surface
  to maintain, and a higher bar to feel polished.
- **The TAM question doesn't go away.** A richer product does not enlarge the
  audience. The fundamental risk remains: is the tiny-games / fantasy-console
  crowd big enough to sustain a platform business? Everything above is moot if the
  answer is no. This deserves an honest market-sizing pass *before* building P1.

---

## 8. Recommendation

The platform layer is the only version of this idea that is genuinely
differentiated rather than "PICO-8 with a checkout button," and its hardest piece
(verified replays) is nearly free given the deterministic engine + headless worker
already built. **But** it is a materially bigger bet than the store, and it does
not answer the market-size question — it makes the product better, not the
audience larger.

Concrete next step: **do a market-sizing / demand pass first** (how many active
TIC-80 + fantasy-console creators and players actually exist, and would they use
this), and only then build **P1** (avatars + profiles + replays), since that slice
delivers standalone value with no dependence on creator adoption.
