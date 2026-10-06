-- Migration 0028 (cart save data), for a one-off paste into the Supabase
-- dashboard SQL editor (Project > SQL Editor > New query > Run).
--
-- The content of 0028_cart_saves.sql, safe to re-run: the table is created
-- only if missing and the policy is dropped and recreated. Nothing existing is
-- touched; carts start saving to it once a signed-in player saves.

create table if not exists cart_saves (
  profile_id  uuid not null references profiles (id) on delete cascade,
  cart_id     uuid not null references carts (id) on delete cascade,
  data        jsonb not null check (octet_length(data::text) <= 20000),
  updated_at  timestamptz not null default now(),
  primary key (profile_id, cart_id)
);

alter table cart_saves enable row level security;

drop policy if exists cart_saves_owner_read on cart_saves;
create policy cart_saves_owner_read on cart_saves
  for select using (auth.uid() = profile_id);

-- Verification (read-only): RLS on, one policy.
select relrowsecurity as rls_on from pg_class where relname = 'cart_saves';
select policyname from pg_policies where tablename = 'cart_saves';
