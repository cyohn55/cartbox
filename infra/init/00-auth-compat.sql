-- Supabase compatibility shim for a plain Postgres container.
--
-- Our schema (apps/web/db/schema.sql) references Supabase's `auth` schema:
-- foreign keys to auth.users and RLS policies that call auth.uid(). A vanilla
-- Postgres image has neither, so this runs FIRST (alphabetical init order) to
-- provide just enough of that surface for the schema to apply and for local,
-- non-auth work (render worker, direct SQL) to function.
--
-- Real environments use the full Supabase stack (via the Supabase CLI or a
-- hosted project), where auth.users and auth.uid() already exist; there this
-- shim is not used.

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

-- In local (superuser) sessions RLS is bypassed, so returning null is fine.
create or replace function auth.uid()
  returns uuid
  language sql
  stable
as $$ select null::uuid $$;
