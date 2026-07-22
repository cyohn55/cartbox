# Deploying the Cartbox app to Vercel (server mode)

This moves the **real** app off GitHub Pages. Pages can only serve the static
export (`output: "export"`), so today the API routes, Supabase server calls,
Stripe webhooks, and Middleware are all dead there. Vercel runs the Next.js
server, so all of that works — which is the prerequisite for purchases, a live
DB-backed catalog, and (later) multiplayer.

Proven deployable: `next build` (without `NEXT_PUBLIC_STATIC_EXPORT`) succeeds and
emits the dynamic API routes (`/api/titles`, `/api/carts`, `/api/webhooks/stripe`,
`/api/console/*`, …), server-rendered pages, and Middleware.

## 1. Connect the repo (one-time, in the Vercel dashboard)

1. **New Project → Import** the `cyohn55/cartbox` GitHub repo.
2. **Root Directory: `apps/web`.** The repo is an npm-workspaces monorepo;
   Vercel detects the workspace root (the lockfile) and installs from there.
   Leave the Install and Build commands on their **defaults** — overriding them
   (`npm ci` in the subfolder, etc.) breaks workspace resolution. `vercel.json`
   here only pins the framework.
3. Framework preset is auto-detected as **Next.js**. Node 18+.

## 2. Environment variables (Project → Settings → Environment Variables)

Copy the values from your local `apps/web/.env.local`. Grouped by exposure:

**Public (inlined into the client bundle):**
| Var | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `NEXT_PUBLIC_ENGINE_URL` | Cartbox Classic engine URL |
| `NEXT_PUBLIC_PRO_ENGINE_URL` | Cartbox Pro engine URL |

**Server-only (runtime secrets):**
| Var | Purpose |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Supabase (server) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase admin (server writes) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Purchases + webhook verification |
| `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL` | Cloudflare R2 (thumbnails today; game bundles in step 2) |

### ⚠️ Do NOT set `NEXT_PUBLIC_STATIC_EXPORT`
Leave it **unset** (or `0`). Setting it to `1` re-enables `output: "export"` and
strips the entire backend again — the exact limitation you're leaving behind.
`NEXT_PUBLIC_BASE_PATH` should also be **empty** on Vercel (it exists only for the
GitHub Pages subpath).

## 3. After the first deploy

- Point the **Stripe webhook** endpoint at `https://<your-vercel-domain>/api/webhooks/stripe`
  (Stripe Dashboard → Webhooks), and confirm `STRIPE_WEBHOOK_SECRET` matches.
- Add Supabase Auth redirect URLs for the Vercel domain if you use hosted auth.
- If the Stripe webhook ever times out, add `export const maxDuration = 30` to
  `src/app/api/webhooks/stripe/route.ts` (Next App-Router route config — this is
  the idiomatic place, not `vercel.json`).

## 4. Game bundles via Cloudflare R2 (step 2 — implemented)

The emulated-game runtimes (`public/{quake,cube2,doom,scummvm,supertux,dosbox,games}`)
are **gitignored and generated at build time** (~694 MB total — far past Pages'
limits), and several (`doom`, `scummvm`, `supertux`) need an **Emscripten**
toolchain Vercel's build doesn't have. So they aren't built on Vercel; they're
served from **Cloudflare R2**:

- **CI builds + uploads.** `.github/workflows/deploy-pages.yml` builds every engine
  (it already had the Emscripten ones; step 2 added `fetch-quake` + `fetch-cube2`),
  then runs `scripts/publish-bundles-r2.mjs` to upload the bundles to R2. That step
  is skipped automatically if the R2 secrets aren't set.
- **App serves same-origin, proxied to R2.** `next.config.mjs` rewrites the bundle
  paths (`/cube2/:path*`, `/quake/:path*`, …) to `GAME_CDN_URL` when set. The
  browser still requests **same-origin** URLs, so the iframe runtimes' input
  bridges (which reach into the same-origin iframe) keep working — no app code
  changes.

### One-time setup
1. **R2 bucket** for bundles (reuse the thumbnails bucket or make a dedicated one).
   Give it a public base URL (an `https://pub-xxx.r2.dev` dev URL or a custom
   domain like `https://cdn.cartbox.app`).
2. **GitHub repo secrets** (so the workflow can upload): `R2_ENDPOINT`,
   `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
3. **Vercel env:** set `GAME_CDN_URL` to that public base URL. Leave it unset in
   local dev (the bundles are served from `public/` there).
4. Trigger the Pages workflow once (push or *Run workflow*) to populate R2.

### Verify
After a deploy, `https://<vercel-domain>/cube2/bb.wasm` should return the file
(proxied from R2), and the Cube 2 / Quake titles should boot in Browse.

### Cost note + the zero-egress optimization (step 2b, not yet done)
The rewrite **proxies** bytes through Vercel, so Vercel's bandwidth is metered
(R2→Vercel egress is free; Vercel→user is not). This already fixes the immediate
pain — repo size, the 100 MB/file limit, and getting games onto Vercel. For true
zero-egress, serve bundles **directly** from R2/Cloudflare CDN (cross-origin);
that requires moving the iframe input bridges from same-origin DOM access to
**postMessage**, and enabling CORS on the R2 bucket. Staged as a follow-up.

The core platform — user carts, live catalog, profiles, purchases — works on
Vercel independent of any of this.

## 5. Coexistence with GitHub Pages
`deploy-pages.yml` stays as-is; Pages remains the free static demo. Vercel becomes
production. Nothing about the static path is removed — you're adding a real host,
not migrating away from the demo.
