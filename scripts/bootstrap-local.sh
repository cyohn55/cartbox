#!/usr/bin/env bash
#
# One-command local bootstrap: brings up Supabase (auth + Postgres) and MinIO
# (R2), applies the schema, seeds a demo cart + achievement + user, wires the
# engine into the web app, and writes apps/web/.env.local. After it finishes,
# run `npm run dev --workspace apps/web` and open http://localhost:3000.
#
# Prereqs (install first): docker, the Supabase CLI, node 20+.
#   https://supabase.com/docs/guides/cli   https://docs.docker.com
#
# Usage (from the monorepo root, Working/tic80-console):
#   bash scripts/bootstrap-local.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE="$ROOT/apps/web/.env.local"

# --- Preconditions -----------------------------------------------------------
for tool in docker supabase node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' is required but not installed." >&2; exit 1; }
done
if [ ! -f "$ROOT/packages/engine/dist/tic80.js" ]; then
  echo "error: engine not built. Run 'npm run engine:build:wasm' first." >&2
  exit 1
fi

echo "==> Installing workspace deps (if needed)"
npm install --silent

# --- 1. Supabase (auth + database) -------------------------------------------
if [ ! -f "$ROOT/supabase/config.toml" ]; then
  echo "==> supabase init"
  supabase init
fi
mkdir -p "$ROOT/supabase/migrations"
cp "$ROOT/apps/web/db/schema.sql" "$ROOT/supabase/migrations/0001_init.sql"

echo "==> Starting Supabase (this pulls containers on first run)"
supabase start
supabase db reset --no-seed >/dev/null 2>&1 || supabase db reset >/dev/null 2>&1 || true

# Capture the local keys.
eval "$(supabase status -o env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY)=')"

# --- 2. MinIO (R2 stand-in) --------------------------------------------------
echo "==> Starting MinIO (R2)"
docker compose -f "$ROOT/infra/docker-compose.yml" up -d minio minio-setup

# --- 3. Engine into the web app ----------------------------------------------
echo "==> Publishing engine to apps/web/public/engine"
mkdir -p "$ROOT/apps/web/public/engine"
cp "$ROOT/packages/engine/dist/tic80.js" "$ROOT/packages/engine/dist/tic80.wasm" "$ROOT/apps/web/public/engine/"

# --- 4. Environment ----------------------------------------------------------
echo "==> Writing $ENV_FILE"
cat > "$ENV_FILE" <<ENV
SUPABASE_URL=${API_URL}
SUPABASE_ANON_KEY=${ANON_KEY}
SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}
NEXT_PUBLIC_SUPABASE_URL=${API_URL}
NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON_KEY}

R2_ENDPOINT=http://127.0.0.1:9000
R2_ACCESS_KEY_ID=cartbox
R2_SECRET_ACCESS_KEY=cartbox-secret
R2_BUCKET=cartbox-carts
R2_PUBLIC_BASE_URL=http://127.0.0.1:9000/cartbox-carts

NEXT_PUBLIC_ENGINE_URL=/engine/tic80.js
ENGINE_URL=./packages/engine/dist/tic80.js

STRIPE_SECRET_KEY=sk_test_placeholder
STRIPE_WEBHOOK_SECRET=whsec_placeholder
ENV

# --- 5. Seed demo content ----------------------------------------------------
echo "==> Seeding demo cart + achievement + user"
node --env-file="$ENV_FILE" "$ROOT/scripts/seed.mjs"

cat <<DONE

Bootstrap complete.

  Web app:    npm run dev --workspace apps/web   ->  http://localhost:3000
  Worker:     ENGINE_URL=./packages/engine/dist/tic80.js \\
              node --env-file=apps/web/.env.local services/render/src/index.js --verify --watch
  Studio:     http://127.0.0.1:54323   (Supabase)
  Demo login: demo@cartbox.dev / demo1234

Play the seeded cart, hold the right arrow to score + unlock, press Submit,
then run the worker (above) to verify and grant.
DONE
