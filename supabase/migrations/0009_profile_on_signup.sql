-- Create a profile the moment an account is created, using the username the
-- player chose at signup (carried in auth user metadata as `handle`).
--
-- Before this, profiles were materialised lazily on first cart save with an
-- auto-generated handle; now every account has a profile with its chosen
-- username from the start. The lazy path in the cart-save route stays as a
-- fallback for accounts created by other means (it is a no-op once this exists).

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  wanted text := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'handle'), ''),
    'maker-' || substr(replace(new.id::text, '-', ''), 1, 12)
  );
  final_handle text := wanted;
begin
  -- The signup form pre-checks availability, but guard the rare race here so
  -- account creation never fails on a duplicate handle: fall back to a suffixed
  -- handle the player can rename later.
  if exists (select 1 from public.profiles where handle = final_handle) then
    final_handle := left(wanted, 24) || '_' || substr(replace(new.id::text, '-', ''), 1, 4);
  end if;

  insert into public.profiles (id, handle, display_name)
  values (
    new.id,
    final_handle,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), final_handle)
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();
