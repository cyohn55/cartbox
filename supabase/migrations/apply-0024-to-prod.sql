-- Migration 0024 (cart asset store), for a one-off paste into the Supabase
-- dashboard SQL editor (Project > SQL Editor > New query > Run).
--
-- This is a convenience wrapper, not a new migration: it is the content of
-- 0024_cart_assets.sql, made safe to run against a database that already holds
-- carts. Re-running it is a no-op rather than an error, which matters because
-- the dashboard makes it easy to hit Run twice.
--
-- Nothing here rewrites existing data. Every cart keeps working exactly as it
-- does today; the new column starts null, and meshes only begin using it on
-- their next save.
--
-- Order of business:
--   1. the assets table
--   2. the manifest column on carts
--   3. row-level security
--   4. verification (read-only, safe to re-run on its own)

-- ---------------------------------------------------------------------------
-- 1. One row per stored blob, keyed by content hash.
-- ---------------------------------------------------------------------------

create table if not exists cart_assets (
  hash          text primary key,                 -- sha-256, lowercase hex
  bytes         integer not null check (bytes > 0),
  content_type  text not null,
  created_at    timestamptz not null default now()
);

create index if not exists cart_assets_created_at_idx on cart_assets (created_at);

-- ---------------------------------------------------------------------------
-- 2. The per-cart manifest.
-- ---------------------------------------------------------------------------

-- Starts null on every existing row, which the app reads as "no assets" — so
-- this is additive and no cart changes behaviour until it is next saved.
alter table carts add column if not exists assets jsonb;

-- ---------------------------------------------------------------------------
-- 3. Row-level security.
-- ---------------------------------------------------------------------------
--
-- `carts`, `titles` and the rest enable RLS, so a new table without it would be
-- readable AND writable by anyone holding the anon key — which is public by
-- design. Service-role keys used by the server routes bypass RLS; this protects
-- the anon key.
--
-- Read is public: a row is a hash, a size and a MIME type, and the bytes
-- already sit behind a public CDN URL derived from that hash. There is no
-- insert/update/delete policy on purpose — every write goes through
-- /api/carts/[cartId]/assets on the service role, which recomputes the hash
-- from the uploaded bytes. A client that could insert here could claim a hash
-- it never uploaded, or point a row at another creator's content. RLS with no
-- write policy denies all anon writes.

alter table cart_assets enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'cart_assets' and policyname = 'cart_assets_public_read'
  ) then
    create policy cart_assets_public_read on cart_assets for select using (true);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Verification. Read-only — run this alone any time to check the state.
-- ---------------------------------------------------------------------------

select
  (select count(*) from information_schema.tables
     where table_schema = 'public' and table_name = 'cart_assets')          as cart_assets_table,      -- expect 1
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'carts'
       and column_name = 'assets')                                          as carts_assets_column,    -- expect 1
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename = 'cart_assets')             as cart_assets_policies,   -- expect 1 (read only)
  (select relrowsecurity from pg_class
     where oid = 'public.cart_assets'::regclass)                            as rls_enabled,            -- expect true
  (select count(*) from cart_assets)                                        as stored_assets,          -- expect 0 on first run
  (select count(*) from carts where assets is not null)                     as carts_with_manifests;   -- expect 0 on first run

-- After this runs, saving a cart that has a textured mesh should move its
-- textures into the store. To confirm, re-run the verification query: both
-- counts above become non-zero, and the cart's `mesh` column gets smaller.
--
-- To check the storage side is configured too (the app degrades to inline
-- storage without it, silently and safely), confirm R2_BUCKET,
-- R2_PUBLIC_BASE_URL and the R2 credentials are set in the Vercel project.
