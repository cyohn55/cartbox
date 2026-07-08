-- Featured clips on the player profile.
--
-- The console profile shows three clips the player is proud of. The player
-- picks them explicitly; when they haven't picked (empty array), the profile
-- falls back to their three most recent replays. Stored as an ordered array of
-- replay ids on the profile row — the order the player chose is the order the
-- profile displays.

alter table profiles
  add column if not exists featured_clips uuid[] not null default '{}';
