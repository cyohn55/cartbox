-- Objects left in storage by deleted rows: a queue the API empties.
--
-- A cart's .tic (r2_key), its offloaded mesh (meshes/<id>.json) and its
-- snapshots' payloads (cart_snapshots.object_key, EP19) live in object storage,
-- which the database cannot reach. Carts are deleted in the database itself
-- (an owner's row delete under RLS, or a profile's cascade), and a cascade
-- deletes the snapshot rows too — so these triggers queue each orphaned key
-- here, and the API deletes the objects as it goes (storageGarbage.ts).
-- Deleting a key that isn't there is a no-op, so a guess (every cart's mesh
-- key, offloaded or not) costs nothing.

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
