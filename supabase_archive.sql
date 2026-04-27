-- Run in Supabase SQL Editor (service_role used by bot / server).

-- Chat archive rows (fed by Discord bot message listener)
CREATE TABLE IF NOT EXISTS public.archive_messages (
  channel_id text NOT NULL,
  message_id text NOT NULL,
  guild_id text NOT NULL,
  author_id text NOT NULL,
  author_tag text,
  author_username text,
  author_avatar_hash text,
  content text,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  embeds jsonb NOT NULL DEFAULT '[]'::jsonb,
  stickers jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at_discord timestamptz NOT NULL,
  logged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, message_id)
);

CREATE INDEX IF NOT EXISTS archive_messages_channel_created_idx
  ON public.archive_messages (channel_id, created_at_discord DESC);

ALTER TABLE public.archive_messages ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.archive_messages IS 'Discord message archive for 6xs.lol (written by bot, read by Node with service_role).';

-- Per-channel nuke timer: restart-safe (no purge on boot; next run at next_nuke_at)
CREATE TABLE IF NOT EXISTS public.archive_nuke_schedule (
  channel_id text PRIMARY KEY,
  next_nuke_at timestamptz NOT NULL
);

ALTER TABLE public.archive_nuke_schedule ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.archive_nuke_schedule IS 'Next scheduled channel wipe; avoids nuking immediately when the bot restarts.';

-- Visitor / archive page access logs (IP, user-agent) for admin
CREATE TABLE IF NOT EXISTS public.archive_access_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_user_id text,
  ip text,
  user_agent text,
  path text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS archive_access_logs_created_idx
  ON public.archive_access_logs (created_at DESC);

ALTER TABLE public.archive_access_logs ENABLE ROW LEVEL SECURITY;
