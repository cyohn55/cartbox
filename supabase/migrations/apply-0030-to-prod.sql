-- Migration 0030 (storage garbage queue), for a one-off paste into the Supabase
-- dashboard SQL editor (Project > SQL Editor > New query > Run). Apply 0029
-- first (it creates cart_snapshots, which a trigger here watches).
--
-- The content of 0030_storage_garbage.sql, safe to re-run: the table is created
-- only if missing, and the functions and triggers are replaced.

create table if not exists storage_garbage (
  key        text primary key,
  queued_at  timestamptz not null default now()
);

-- Service role only (no policies).
alter table storage_garbage enable row level security;

create or replace function queue_snapshot_object() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if old.object_key is not null then
    insert into storage_garbage (key) values (old.object_key) on conflict do nothing;
  end if;
  return old;
end $$;

drop trigger if exists cart_snapshots_queue_object on cart_snapshots;
create trigger cart_snapshots_queue_object after delete on cart_snapshots
  for each row execute function queue_snapshot_object();

create or replace function queue_cart_objects() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  -- Keys only: a full URL is content kept elsewhere (see storage.ts publicUrl).
  if old.r2_key is not null and old.r2_key !~ '^https?://' then
    insert into storage_garbage (key) values (old.r2_key) on conflict do nothing;
  end if;
  insert into storage_garbage (key) values ('meshes/' || old.id || '.json') on conflict do nothing;
  return old;
end $$;

drop trigger if exists carts_queue_objects on carts;
create trigger carts_queue_objects after delete on carts
  for each row execute function queue_cart_objects();

-- Verification (read-only): the table, and both triggers.
select relrowsecurity as rls_on from pg_class where relname = 'storage_garbage';
select tgname from pg_trigger where tgname in ('cart_snapshots_queue_object', 'carts_queue_objects');
