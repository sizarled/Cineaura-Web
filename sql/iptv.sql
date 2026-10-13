-- CineAura IPTV accounts (panel > IPTV). Run in the Supabase SQL editor.
-- Extends the existing public.iptv table; safe to run more than once.
--   type      : 'free' (visible to every member) | 'premium' (visible only to owner_id)
--   kind      : 'xtream' | 'm3u'
--   owner_id  : member_id of the member who benefits from a premium account
alter table public.iptv add column if not exists kind text default 'xtream';
alter table public.iptv add column if not exists xstream_server text default '';
alter table public.iptv add column if not exists created_by text default '';
alter table public.iptv add column if not exists created_at timestamptz default now();
create index if not exists iptv_owner_idx on public.iptv (owner_id);
create index if not exists iptv_type_idx on public.iptv (type);
