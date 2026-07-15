-- A per-user working copy of the handheld pixel-editor drawing, so a draft
-- resumes across devices (not just within one browser's localStorage).
--
-- The value is opaque to the server: base64 of the gzip-compressed serialised
-- paint document. It is validated only on the client when re-opened (gunzip +
-- deserialize with dimension checks), so the column just stores text. Nullable;
-- cleared when the player designs the handheld another way.

alter table public.profiles
  add column if not exists handheld_draft text;
