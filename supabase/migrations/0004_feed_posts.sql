-- Community feed posts for the console homescreen.
--
-- The handheld home feed mixes live platform data (playable carts, replay
-- clips, achievement unlocks) with authored content that has no other home:
-- gaming news, looking-for-player invites, developer tips, trivia, and posts
-- from cartridge developers. Those authored kinds live here.
--
-- `meta` carries kind-specific structure (trivia choices/answer index, LFP
-- player counts, news links) so new kinds don't need schema changes.

create table if not exists feed_posts (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('news', 'lfp', 'dev_tip', 'trivia', 'dev_post')),
  author_id  uuid references profiles (id) on delete set null,
  cart_id    uuid references carts (id) on delete cascade,   -- post is about this cart (LFP, dev posts)
  title      text not null,
  body       text not null default '',
  meta       jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists feed_posts_created_idx on feed_posts (created_at desc);
create index if not exists feed_posts_kind_idx on feed_posts (kind, created_at desc);

alter table feed_posts enable row level security;

-- The feed is public; authoring is limited to the post's owner (server routes
-- use the service role and bypass RLS, matching the other tables).
drop policy if exists feed_posts_public_read on feed_posts;
create policy feed_posts_public_read on feed_posts
  for select using (true);

drop policy if exists feed_posts_author_write on feed_posts;
create policy feed_posts_author_write on feed_posts
  for all using (auth.uid() = author_id) with check (auth.uid() = author_id);
