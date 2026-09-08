-- Content-addressed asset store for carts whose content does not fit in a
-- cartridge (ERA_MODELS.md §5.2).
--
-- Two pieces: a global table of stored blobs keyed by content hash, and a
-- per-cart manifest naming the ones a cart references.
--
-- The split is what makes dedup work. Assets are shared across carts by hash,
-- so a tileset used by fifty remixes is one row and one object; the manifest is
-- what differs per cart. Storing the bytes' metadata on the cart instead would
-- make storage grow with forks rather than with originals.

-- One stored blob. Immutable: the hash *is* the identity, so a row is never
-- updated, only inserted or (by an offline sweep) deleted.
create table if not exists cart_assets (
  hash          text primary key,                 -- sha-256, lowercase hex
  bytes         integer not null check (bytes > 0),
  content_type  text not null,
  created_at    timestamptz not null default now()
);

-- Carts reference assets by name. JSON rather than a join table: a manifest is
-- read and written whole, always as part of the cart it belongs to, and never
-- queried across carts on the request path. The one query that does span carts
-- — the mark phase of an offline sweep for unreferenced assets — reads every
-- manifest anyway, so an index would not serve it.
alter table carts add column if not exists assets jsonb;

-- Supports that sweep, and any "how old is this asset" reporting.
create index if not exists cart_assets_created_at_idx on cart_assets (created_at);

-- No foreign key from the manifest into cart_assets, deliberately. A manifest
-- is JSON, so the database cannot enforce it; more importantly, a dangling
-- reference must degrade to "this asset is missing" (the cart still plays)
-- rather than blocking the write that introduced it. Validation lives in
-- cartAssetStore.ts, where a bad entry is dropped rather than fatal.

-- Row-level security. `carts` and `titles` enable it, so a new table without it
-- is writable by anyone holding the anon key — which is public by design.
-- (Service-role keys used by server routes bypass RLS; these protect the anon key.)
alter table cart_assets enable row level security;

-- Metadata is world-readable: it is a hash, a size and a MIME type, and the
-- bytes themselves already sit behind a public CDN URL derived from the hash.
-- Withholding the row would hide nothing while breaking any future client-side
-- read of a cart's manifest.
create policy cart_assets_public_read on cart_assets
  for select using (true);

-- No insert, update or delete policy, deliberately. Every write goes through
-- /api/carts/[cartId]/assets on the service role, which is what recomputes the
-- hash from the bytes. A client that could insert here could claim a hash it
-- never uploaded, or point a row at another creator's content — the exact
-- attack the route's server-side hashing exists to prevent. RLS with no write
-- policy denies all anon writes.
