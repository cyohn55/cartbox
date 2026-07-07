# apps/web — Marketplace & gallery (Next.js App Router)

The public product: landing → gallery → play pages → creator dashboard → checkout. Also hosts the API routes.

## Routes (target)
```
/                     Marketing home (can absorb /landing after launch)
/browse               Gallery: search, tags, featured, trending
/play/[cartId]        Cart page: embedded @cartbox/player + details + buy/unlock
/u/[handle]           Creator profile + their carts
/publish              Upload/publish flow (auth required)
/dashboard            Creator: sales, payouts, analytics (auth required)
/jams , /jams/[slug]  Game jam list + jam page (submit, vote, results)
/api/carts            CRUD + upload (writes to R2, metadata to Postgres)
/api/checkout         Stripe Checkout session for a paid cart
/api/webhooks/stripe  Payment + Connect payout webhooks → entitlements
```

## Data model (first cut)
- `users` (id, handle, email, stripe_account_id, tier)
- `carts` (id, owner_id, title, slug, tags[], license, price_cents, r2_key, thumb_key, plays, created_at)
- `purchases` (id, buyer_id, cart_id, amount_cents, platform_fee_cents, created_at)
- `jams` (id, slug, theme, starts_at, ends_at) + `jam_entries` (jam_id, cart_id, votes)

## Key flows
- **Publish**: validate `.tic` → store in R2 → render a thumbnail frame (headless player) → row in `carts`.
- **Buy**: Stripe Checkout (destination charge to creator's Connect account, `application_fee` = platform take) → webhook grants entitlement.
- **Play**: fetch cart bytes from R2/CDN → `@cartbox/player`. Increment `plays`.

## Stack
Next.js (App Router) · Supabase (Postgres + Auth) · Cloudflare R2 · Stripe Connect · Tailwind + `@cartbox/ui`.
