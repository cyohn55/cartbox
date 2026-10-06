-- Named snapshots of a cart (ENGINE_PARITY_ROADMAP.md EP19): the whole cart
-- (its .tic bytes, every sidecar and its details) kept under a name, to go back
-- to later. The payload is gzipped JSON (see apps/web/src/lib/cartSnapshots.ts),
-- kept in object storage when it's configured (`object_key`), else inline here
-- as base64 (`payload`).
--
-- Snapshots belong to the cart, and only its owner reaches them: every read
-- and write goes through /api/carts/[cartId]/snapshots on the service role,
-- which checks ownership. (Deleting a cart drops its rows; objects it left in
-- storage are orphaned, as an offloaded mesh's are.)

create table if not exists cart_snapshots (
  id          uuid primary key,
  cart_id     uuid not null references carts (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 80),
  created_at  timestamptz not null default now(),
  -- Compressed bytes, as listed to the creator.
  size        integer not null check (size >= 0),
  object_key  text,
  payload     text,
  check (object_key is not null or payload is not null)
);

create index if not exists cart_snapshots_cart on cart_snapshots (cart_id, created_at desc);

-- Row-level security on with no policies: nothing is readable with the public
-- anon key; the API (service role) is the only way in.
alter table cart_snapshots enable row level security;
