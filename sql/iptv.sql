-- CineAura IPTV accounts (panel > IPTV). Run in the Supabase SQL editor.
-- Extends the existing public.iptv table; safe to run more than once.
--   type        : 'free' (visible to every member) | 'premium' (visible only to owner_id)
--   kind        : 'xtream' | 'm3u'
--   owner_id    : member_id of the member who benefits from a premium account
--   epg_url     : programme guide (XMLTV) of the account. Optional: an M3U import
--                 fills it from the playlist's url-tvg, and an empty value on an
--                 Xtream account means the provider's own xmltv.php.
--   assigned_at : when the premium account was given to owner_id
--   expires_at  : assigned_at + duration (empty = no end date)
alter table public.iptv add column if not exists kind text default 'xtream';
alter table public.iptv add column if not exists xstream_server text default '';
alter table public.iptv add column if not exists created_by text default '';
alter table public.iptv add column if not exists created_at timestamptz default now();
alter table public.iptv add column if not exists epg_url text default '';
alter table public.iptv add column if not exists assigned_at timestamptz;
alter table public.iptv add column if not exists expires_at timestamptz;
create index if not exists iptv_owner_idx on public.iptv (owner_id);
create index if not exists iptv_type_idx on public.iptv (type);

-- Premium accounts given before assigned_at existed start counting from their creation.
update public.iptv set assigned_at = coalesce(created_at, now())
where assigned_at is null and owner_id is not null and owner_id <> '' and lower(coalesce(type, '')) <> 'free';

comment on column public.iptv.epg_url is 'Programme guide (XMLTV) URL; empty on an Xtream account = <server>/xmltv.php';
comment on column public.iptv.assigned_at is 'When the premium account was given to owner_id';
comment on column public.iptv.expires_at is 'End of the premium account (assigned_at + duration); empty = no end date';

-- Reload the API schema so the new columns can be written at once.
notify pgrst, 'reload schema';
