-- Migration 0029 (cart snapshots), for a one-off paste into the Supabase
-- dashboard SQL editor (Project > SQL Editor > New query > Run).
--
-- The content of 0029_cart_snapshots.sql, safe to re-run: the table and index
-- are created only if missing. Nothing existing is touched; creators' snapshots
-- start landing here once they take one while signed in.

create table if not exists cart_snapshots (
  id          uuid primary key,
  cart_id     uuid not null references carts (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 80),
  created_at  timestamptz not null default now(),
  size        integer not null check (size >= 0),
  object_key  text,
  payload     text,
  check (object_key is not null or payload is not null)
);

create index if not exists cart_snapshots_cart on cart_snapshots (cart_id, created_at desc);

alter table cart_snapshots enable row level security;

-- Verification (read-only): RLS on, no policies.
select relrowsecurity as rls_on from pg_class where relname = 'cart_snapshots';
select count(*) as policies from pg_policies where tablename = 'cart_snapshots';
