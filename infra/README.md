# Local development — booting Cartbox

Two moving parts back the app: **Supabase** (Postgres + Auth) and **object
storage** (Cloudflare R2 in production, MinIO locally). Below is the fastest path
to a running local stack.

## 1. Install workspace dependencies

From the monorepo root (`Working/tic80-console/`):

```bash
npm install         # links all @cartbox/* workspaces and pulls deps
```

## 2. Bring up database + storage

```bash
docker compose -f infra/docker-compose.yml up -d
```

This starts:
- **Postgres** on `localhost:54322`, pre-loaded with the auth shim and our schema.
- **MinIO** (S3-compatible R2 stand-in) on `localhost:9000` (console `:9001`),
  with the `cartbox-carts` bucket created and set to public-read.

> The Postgres container is enough for the render worker and direct SQL. For
> full **Auth** (sign-in, sessions, RLS with a real `auth.uid()`), also run the
> Supabase CLI in step 3 — hand-rolling GoTrue/Kong in compose is fragile, so we
> defer that to the tool Supabase maintains.

## 3. Supabase Auth (for end-to-end login + entitlements)

```bash
# one-time
npx supabase init
cp apps/web/db/schema.sql supabase/migrations/0001_init.sql

# start local Supabase (Postgres + Auth + Studio + Storage)
npx supabase start
```

`supabase start` prints the local **API URL**, **anon key**, and
**service_role key**. Put them in `.env.local` (see below). When using the
Supabase CLI's own Postgres, you can skip the compose `db` service and keep only
`minio` for R2.

## 4. Configure environment

```bash
cp infra/.env.example apps/web/.env.local
# fill SUPABASE_* from `supabase start`; the R2_* defaults already match MinIO
```

## 5. Build the engine, then run

```bash
npm run engine:build:wasm            # produces packages/engine/dist/tic80.js
npm run dev --workspace apps/web     # marketplace at http://localhost:3000
ENGINE_URL=./packages/engine/dist/tic80.js npm run start --workspace services/render
```

## Verifying auth end-to-end
1. Sign in on the web app (Supabase Auth writes the session cookie).
2. Middleware (`apps/web/src/middleware.ts`) refreshes the token each request.
3. Visit a **paid** cart's `/play/[cartId]` — the server component calls
   `getServerUserId()` and checks `purchases`, so an owner sees the player and a
   non-owner sees the buy button.

## Teardown
```bash
docker compose -f infra/docker-compose.yml down       # keep data
docker compose -f infra/docker-compose.yml down -v     # wipe volumes
npx supabase stop
```
