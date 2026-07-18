-- Catalog titles (Browse Phase 1).
--
-- A `title` is a curated, playable thing that is not a user-authored cart:
-- an open-source game, publisher-released freeware, or an open-source engine
-- whose commercial data the player supplies themselves. Carts stay in `carts`
-- (user-generated, owner-scoped, simple RLS); titles are curated and ownerless
-- by default, so they get their own table rather than extra nullable columns on
-- `carts` that would tangle the owner-based policies there.
--
-- The distribution rule this schema exists to enforce: we host code freely, and
-- assets only where a license or publisher grant permits redistribution. Tier C
-- ships the engine only and the player supplies the data client-side.

-- ---------------------------------------------------------------------------
-- License classification
-- ---------------------------------------------------------------------------

-- Whether a license permits commercial distribution, and therefore whether a
-- title carrying it may ever be priced. Non-commercial asset licenses (the
-- CC *-NC family, common in open-source games) forbid a paid listing outright,
-- so this is a correctness constraint on money, not a policy preference.
--
-- Authoritative for enforcement. apps/web/src/lib/licensing.ts mirrors this list
-- for UI gating; "Unit Tests/catalog-titles.test.ts" parses this function and
-- asserts the two agree, so the mirror cannot drift silently.
create or replace function public.license_permits_commercial(license text)
returns boolean
language sql
immutable
as $$
  select license in (
    'gpl-2.0',
    'gpl-3.0',
    'agpl-3.0',
    'lgpl-2.1',
    'lgpl-3.0',
    'mit',
    'bsd-2-clause',
    'bsd-3-clause',
    'apache-2.0',
    'zlib',
    'mpl-2.0',
    'cc0-1.0',
    'cc-by-4.0',
    'cc-by-sa-4.0',
    'proprietary-licensed'
  );
$$;

-- ---------------------------------------------------------------------------
-- Titles
-- ---------------------------------------------------------------------------

create table if not exists titles (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,
  name          text not null,
  description   text not null default '',
  tags          text[] not null default '{}',

  -- Which player implementation runs this title. The web app resolves this to a
  -- lazily-loaded runtime module (see apps/web/src/lib/titleRuntime.ts).
  runtime       text not null check (runtime in (
                  'cartbox-classic', 'cartbox-pro', 'wasm-app',
                  'scummvm', 'dos', 'libretro')),

  -- Where the playable data comes from. 'user-supplied' is the Tier C path:
  -- assets stay in the player's browser and never reach our storage.
  asset_source  text not null check (asset_source in (
                  'bundled', 'user-supplied', 'freeware-fetch')),

  -- Content tier (see the roadmap). Kept as a column so the distribution rule is
  -- queryable and testable rather than living only in prose.
  tier          text not null check (tier in ('A', 'B', 'C')),

  license           text not null,
  license_text_key  text,             -- object key of the full license text (GPL source offer, etc.)
  source_url        text,             -- upstream project / publisher grant
  bundle_key        text,             -- object key of the engine + bundled assets, when we host them

  -- Curation record. { source, score, retrieved_at } — see the roadmap's
  -- "curation bar, as data". Stored so additions stay auditable and re-runnable.
  acclaim       jsonb,

  -- Free by default. Only a verified rightsholder primary may raise this, and
  -- only on a commercially-licensable, non-freeware title (see the trigger).
  price_cents   integer not null default 0 check (price_cents >= 0),

  plays         integer not null default 0,
  thumb_key     text,
  published     boolean not null default false,
  created_at    timestamptz not null default now(),

  -- Tier C exists precisely because we may not ship the data; a bundled asset
  -- source would contradict the tier's whole reason for existing.
  constraint titles_tier_c_is_user_supplied
    check (tier <> 'C' or asset_source = 'user-supplied'),

  -- Publisher freeware grants cover redistribution, never resale.
  constraint titles_freeware_is_free
    check (tier <> 'B' or price_cents = 0),

  -- A price on a license that forbids commercial distribution would breach it.
  constraint titles_price_requires_commercial_license
    check (price_cents = 0 or public.license_permits_commercial(license))
);

create index if not exists titles_published_created_idx on titles (published, created_at desc);
create index if not exists titles_tags_idx on titles using gin (tags);
create index if not exists titles_runtime_idx on titles (runtime);

-- ---------------------------------------------------------------------------
-- Claims
-- ---------------------------------------------------------------------------

-- Who may administer a title's listing. A title may carry several stewards, so
-- this is a join table rather than a column on `titles`.
--
-- Levels:
--   steward      — may edit the listing (metadata, artwork, links, manifests).
--   rightsholder — may additionally set a price. Requires the heavier proof
--                  standard, because this is the level that moves money.
--
-- Exactly one claim per title is primary. The primary is the account
-- representative: only they may grant and revoke subordinate stewards, and
-- pricing authority belongs to the primary alone — it never delegates.
create table if not exists title_claims (
  id           uuid primary key default gen_random_uuid(),
  title_id     uuid not null references titles (id) on delete cascade,
  profile_id   uuid not null references profiles (id) on delete cascade,

  level        text not null default 'steward' check (level in ('steward', 'rightsholder')),
  is_primary   boolean not null default false,

  -- 'pending' claims have no authority; review promotes them to 'active'.
  -- 'suspended' parks authority during a dispute without destroying the claim.
  status       text not null default 'pending'
                 check (status in ('pending', 'active', 'suspended', 'revoked')),

  -- Which primary delegated this claim. Null for a primary (nobody grants it;
  -- review does). Recorded because succession review needs the grant chain.
  granted_by   uuid references profiles (id) on delete set null,

  -- Drives the inactivity signal that makes a transfer claim reviewable.
  last_active_at timestamptz not null default now(),
  created_at     timestamptz not null default now(),

  unique (title_id, profile_id),

  -- Subordinates are delegated by a primary; a primary is not granted by anyone.
  constraint title_claims_grant_chain
    check ((is_primary and granted_by is null) or (not is_primary and granted_by is not null))
);

-- "At most one primary per title" is a group-wide invariant, which a check
-- constraint cannot express (checks see one row at a time) — it has to be a
-- partial unique index. Only live claims occupy the slot, so a revoked primary
-- frees it for a successor.
create unique index if not exists title_claims_one_primary_idx
  on title_claims (title_id)
  where is_primary and status in ('pending', 'active');

create index if not exists title_claims_profile_idx on title_claims (profile_id);

-- ---------------------------------------------------------------------------
-- Pricing authority
-- ---------------------------------------------------------------------------

-- A price may only stand while the title has an active primary claim at
-- rightsholder level. Enforced in the database rather than the UI because this
-- is the field that moves money, and it spans two tables — beyond what a check
-- constraint can see.
create or replace function public.assert_title_pricing_authority()
returns trigger
language plpgsql
as $$
begin
  if new.price_cents > 0 and not exists (
    select 1
      from title_claims
     where title_claims.title_id = new.id
       and title_claims.is_primary
       and title_claims.status = 'active'
       and title_claims.level = 'rightsholder'
  ) then
    raise exception
      'title % cannot be priced: requires an active primary claim at rightsholder level',
      new.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger titles_pricing_authority
  before insert or update of price_cents on titles
  for each row execute function public.assert_title_pricing_authority();

-- Losing rightsholder authority must not leave a price standing: a forfeited or
-- suspended claim reverts the title to free. Existing entitlements survive by
-- construction — purchases are never deleted here.
create or replace function public.revert_price_on_claim_change()
returns trigger
language plpgsql
as $$
begin
  if old.is_primary and old.status = 'active' and old.level = 'rightsholder'
     and (new.status <> 'active' or new.level <> 'rightsholder' or not new.is_primary)
  then
    update titles set price_cents = 0 where id = old.title_id and price_cents > 0;
  end if;
  return new;
end;
$$;

create trigger title_claims_revert_price
  after update on title_claims
  for each row execute function public.revert_price_on_claim_change();

-- ---------------------------------------------------------------------------
-- Entitlements
-- ---------------------------------------------------------------------------

-- A purchase entitles either a cart or a title, never both and never neither.
-- Adding a nullable sibling column (rather than reshaping the table) leaves the
-- existing cart purchase path and its Stripe webhook idempotency untouched.
alter table purchases
  add column if not exists title_id uuid references titles (id) on delete cascade;

alter table purchases alter column cart_id drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'purchases_exactly_one_subject'
  ) then
    alter table purchases
      add constraint purchases_exactly_one_subject
      check ((cart_id is null) <> (title_id is null));
  end if;
end;
$$;

create unique index if not exists purchases_buyer_title_idx
  on purchases (buyer_id, title_id)
  where title_id is not null;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

-- Published titles are world-readable. Writes go through service-role server
-- routes (which bypass RLS) so that claim authority and the pricing rules above
-- are checked in one place rather than re-encoded as policy predicates.
alter table titles enable row level security;

create policy titles_public_read on titles
  for select using (published = true);

alter table title_claims enable row level security;

-- A claimant may see their own claims; the roster is otherwise not public.
create policy title_claims_self_read on title_claims
  for select using (auth.uid() = profile_id);

grant select on titles to anon, authenticated;
grant select on title_claims to authenticated;
