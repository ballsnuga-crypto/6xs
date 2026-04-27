-- If you already ran an older supabase_archive.sql, run this once to add new columns/tables.

CREATE TABLE IF NOT EXISTS public.archive_nuke_schedule (
  channel_id text PRIMARY KEY,
  next_nuke_at timestamptz NOT NULL
);

ALTER TABLE public.archive_messages
  ADD COLUMN IF NOT EXISTS author_username text;

ALTER TABLE public.archive_messages
  ADD COLUMN IF NOT EXISTS author_avatar_hash text;

ALTER TABLE public.archive_messages
  ADD COLUMN IF NOT EXISTS stickers jsonb NOT NULL DEFAULT '[]'::jsonb;
