-- Save data (ENGINE_PARITY_ROADMAP.md EP15b): what a cart saved with
-- cartbox.save, per player and cart, so a signed-in player's progress follows
-- them between browsers.
--
-- One row per (player, cart): a cart saves one table (as JSON), written whole
-- each time, so there is nothing to join or version. The browser keeps its own
-- copy too; when both exist, the newer `updated_at` wins.

create table if not exists cart_saves (
  profile_id  uuid not null references profiles (id) on delete cascade,
  cart_id     uuid not null references carts (id) on delete cascade,
  -- At most 16 KB of JSON (the largest save block, see saveSdk.ts); checked by
  -- the route, and here so a direct write can't grow a row past it either.
  data        jsonb not null check (octet_length(data::text) <= 20000),
  updated_at  timestamptz not null default now(),
  primary key (profile_id, cart_id)
);

-- Row-level security. Saves are private: the default grants give anon and
-- authenticated a table-level select, so without a policy every player's saves
-- would be readable with the public anon key.
alter table cart_saves enable row level security;

create policy cart_saves_owner_read on cart_saves
  for select using (auth.uid() = profile_id);

-- No write policies, deliberately: every write goes through
-- /api/carts/[cartId]/save on the service role, which resolves the player from
-- their session and caps the size.
