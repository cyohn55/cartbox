-- Cartbox database schema (Postgres / Supabase).
-- Covers Phase 2 (carts, profiles), Phase 3 (purchases), and Phase 5 (jams).
-- Apply with: supabase db push  (or psql -f db/schema.sql).

-- Creators. Mirrors Supabase auth.users and holds marketplace-specific fields.
create table if not exists profiles (
  id                uuid primary key references auth.users (id) on delete cascade,
  handle            text unique not null,
  display_name      text,
  bio               text not null default '',
  avatar_json       jsonb,                       -- Mii-style avatar part choices (Platform P1)
  voxel_avatar      jsonb,                       -- console voxel-character spec (see migration 0006)
  stripe_account_id text,                       -- Stripe Connect account (Phase 3)
  tier              text not null default 'free' check (tier in ('free', 'creator')),
  featured_clips    uuid[] not null default '{}', -- ordered replay ids the player showcases (see migration 0005)
  created_at        timestamptz not null default now()
);

-- Cartridges. One row per published (or draft) cart.
create table if not exists carts (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references profiles (id) on delete cascade,
  title       text not null,
  slug        text not null,
  description text not null default '',
  tags        text[] not null default '{}',
  license       text not null default 'all-rights-reserved',
  console_model text not null default 'classic',                    -- which fantasy-console model
  price_cents   integer not null default 0 check (price_cents >= 0),  -- 0 = free
  r2_key      text not null,                     -- object key of the .tic in R2
  thumb_key   text,                              -- object key of the rendered thumbnail
  plays       integer not null default 0,
  published   boolean not null default false,
  rig         jsonb,                             -- editor-only character rig (multi-plane parallax preview)
  fx          jsonb,                             -- post-processing effect stack, applied by the player at runtime
  created_at  timestamptz not null default now(),
  unique (owner_id, slug)
);

create index if not exists carts_published_created_idx on carts (published, created_at desc);
create index if not exists carts_tags_idx on carts using gin (tags);

-- Purchases double as the entitlement record: a row means the buyer owns the cart.
create table if not exists purchases (
  id                    uuid primary key default gen_random_uuid(),
  buyer_id              uuid not null references profiles (id) on delete cascade,
  cart_id               uuid not null references carts (id) on delete cascade,
  amount_cents          integer not null,
  platform_fee_cents    integer not null,
  stripe_payment_intent text unique,             -- idempotency key for the webhook
  created_at            timestamptz not null default now(),
  unique (buyer_id, cart_id)
);

-- Replays (Platform P1). The serialized input stream lives in R2; this row is
-- the index + metadata. A score (Platform P2) will reference the replay that
-- produced it, so it can be re-run and verified.
create table if not exists replays (
  id          uuid primary key default gen_random_uuid(),
  cart_id     uuid not null references carts (id) on delete cascade,
  player_id   uuid references profiles (id) on delete set null,
  model_id    text not null default 'classic',
  cart_hash   text not null,                    -- must match the cart's bytes to be playable
  seed        integer not null default 0,
  frame_count integer not null,
  data_r2_key text not null,                    -- serialized replay JSON in object storage
  verify_status text not null default 'none'    -- unlock-only verification queue
    check (verify_status in ('none', 'pending', 'done')),
  created_at  timestamptz not null default now()
);

create index if not exists replays_cart_idx on replays (cart_id, created_at desc);
create index if not exists replays_verify_idx on replays (created_at) where verify_status = 'pending';

-- Leaderboard scores (Platform P2). A score is submitted with the replay that
-- produced it and starts 'pending'; the verification worker re-runs the replay
-- headlessly and sets 'verified' or 'rejected'.
create table if not exists scores (
  id            uuid primary key default gen_random_uuid(),
  cart_id       uuid not null references carts (id) on delete cascade,
  profile_id    uuid references profiles (id) on delete set null,
  replay_id     uuid not null references replays (id) on delete cascade,
  claimed_value integer not null,
  status        text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),
  created_at    timestamptz not null default now()
);

-- Leaderboard read path: best verified score per cart.
create index if not exists scores_leaderboard_idx
  on scores (cart_id, claimed_value desc)
  where status = 'verified';
create index if not exists scores_pending_idx on scores (created_at) where status = 'pending';

-- Achievements (Platform P2). Registered per cart by its owner. `hash` is the
-- FNV-1a of `key` so the verification worker can map a mailbox unlock (which
-- carries the hash) back to the achievement. Stored as bigint since the hash is
-- an unsigned 32-bit value.
create table if not exists achievements (
  id          uuid primary key default gen_random_uuid(),
  cart_id     uuid not null references carts (id) on delete cascade,
  key         text not null,                    -- e.g. "first_blood"
  hash        bigint not null,                  -- FNV-1a(key), matches the mailbox id
  title       text not null,
  description text not null default '',
  points      integer not null default 0,
  secret      boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (cart_id, key)
);

create index if not exists achievements_hash_idx on achievements (cart_id, hash);

-- Unlocks: a row means the player earned the achievement (granted only from a
-- verified replay run).
create table if not exists unlocks (
  profile_id     uuid not null references profiles (id) on delete cascade,
  achievement_id uuid not null references achievements (id) on delete cascade,
  unlocked_at    timestamptz not null default now(),
  primary key (profile_id, achievement_id)
);

-- Community feed posts for the console homescreen (see migration 0004).
-- Authored feed content: gaming news, looking-for-player invites, developer
-- tips, trivia, and cartridge-developer posts. `meta` carries kind-specific
-- structure (trivia choices, LFP player counts, news links).
create table if not exists feed_posts (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('news', 'lfp', 'dev_tip', 'trivia', 'dev_post')),
  author_id  uuid references profiles (id) on delete set null,
  cart_id    uuid references carts (id) on delete cascade,
  title      text not null,
  body       text not null default '',
  meta       jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists feed_posts_created_idx on feed_posts (created_at desc);
create index if not exists feed_posts_kind_idx on feed_posts (kind, created_at desc);

-- Game jams (Phase 5) and their entries.
create table if not exists jams (
  id         uuid primary key default gen_random_uuid(),
  slug       text unique not null,
  title      text not null,
  theme      text,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table if not exists jam_entries (
  jam_id       uuid references jams (id) on delete cascade,
  cart_id      uuid references carts (id) on delete cascade,
  votes        integer not null default 0,
  submitted_at timestamptz not null default now(),
  primary key (jam_id, cart_id)
);

-- Row-level security: published carts are world-readable; writes are owner-only.
-- (Service-role keys used by server routes bypass RLS; these protect the anon key.)
alter table carts enable row level security;

create policy carts_public_read on carts
  for select using (published = true);

create policy carts_owner_write on carts
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

alter table purchases enable row level security;

create policy purchases_owner_read on purchases
  for select using (auth.uid() = buyer_id);

alter table feed_posts enable row level security;

create policy feed_posts_public_read on feed_posts
  for select using (true);

create policy feed_posts_author_write on feed_posts
  for all using (auth.uid() = author_id) with check (auth.uid() = author_id);

-- Role grants. RLS only filters rows; a role still needs table-level privileges
-- to touch a table at all. Bypassing RLS (service_role) is not a substitute for
-- these grants, so server routes 42501 ("permission denied") without them.
grant usage on schema public to anon, authenticated, service_role;

grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant select on all tables in schema public to anon, authenticated;

-- Apply the same defaults to tables/sequences created by later migrations.
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant select on tables to anon, authenticated;
