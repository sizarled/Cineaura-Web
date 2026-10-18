-- ============================================================
-- Members' IPTV lists (IPTV.html, Dashboard > IPTV > Your lists, Search.html > Channels,
-- Listchannels.html?list=IPL…)
-- Run in the Supabase SQL editor AFTER profile.sql, dashboard.sql and content.sql
-- (safe to run more than once).
--
-- What members can do
--   * IPTV.html: a search box and the IPTV lists (M3U playlists) that members published,
--     as far as the visitor may see them. "Publish a list": a name, a description, the
--     playlist (the link of an .m3u file, or a file uploaded to Storage: bucket IPTV,
--     folder Playlist) and who sees it.
--   * Dashboard > IPTV > Your lists: the member's own lists; open, edit, read the
--     channels again, copy the link, delete.
--   * Listchannels.html?list=IPL…: the channels of a list with the channel player.
--   * Search.html > Channels (site_search, sql/search.sql): the channels of the public and
--     exclusive lists (an exclusive one with its lock), the lists themselves, a private list
--     with a "Request to join" button.
--   * Dashboard > IPTV > Your lists > Requests: the requests to join a private list.
--
-- Visibility
--   public     everyone, visitors included
--   exclusive  signed-in members only, who meet EVERY criterion the publisher ticked:
--              followers of the publisher, one of the countries, one of the languages
--              (the site language saved on the member's profile; when none is saved,
--              the language of their country), an account level (LV) at least, a
--              membership at least (Silver < Gold < Diamond, the plan in force), and one
--              of the passwords the publisher set: asked even from a member who meets
--              every other criterion, once (iptv_list_unlock), until the passwords change
--   private    only the members the publisher listed by username or member id; they
--              are told in the bell. A private list shows in Search.html and IPTV.html
--              (its name, its publisher and a "Request to join" button, never its
--              channels) unless the publisher ticked "Don't show it in search results";
--              a request goes to the publisher (bell, Dashboard > IPTV > Your lists), who
--              accepts it (the member is added to the list) or declines it
--   The publisher always sees their own lists. Nothing of a banned publisher is shown.
--   An exclusive list shows to everybody with its criteria and a lock; it opens for the
--   members who meet them.
--
-- Ranking points (Search.html): the minutes members watch its channels (iptv_list_minute,
-- the channel player, once a minute), recommend / don't recommend (iptv_list_vote), the
-- shares of its link (iptv_list_share) and the valid reports (sql/search.sql).
--
-- Uploaded files
--   The browser uploads the file to IPTV/Playlist/<member id>-<20 random letters>.m3u, a
--   new name for every upload (no x-upsert). The policy at the end allows exactly that:
--   an upload (INSERT) under such a name for a member who is not banned. No listing, no
--   replacing, no deleting with the public key. Only the publisher and the members who
--   may see a list get its address (iptv_list_open), so the random name keeps the file of
--   an exclusive or private list out of sight. A file left behind by an edit or by a
--   deleted list stays in Storage (Supabase dashboard > Storage > IPTV > Playlist).
--   If the bucket limits the file types, allow audio/x-mpegurl.
--
-- The channels of a list (name, group, logo and type; never the stream links) are read by
-- the publisher's browser when the list is saved, and kept in iptv_list_channels for the
-- channel search. The player always reads the playlist itself.
--
-- The team (Panel > Content > IPTV lists, section 6): every list of the site; one can be
-- suspended (hidden from everybody but its publisher, who reads why and cannot show it
-- again), restored or deleted (iptv_lists_admin, iptv_list_moderate).
--
-- Every table is closed to the public API; pages go through the functions below. Like
-- the rest of the site (no Supabase Auth), the functions trust the member id the browser
-- sends.
-- ============================================================

-- ------------------------------------------------------------------ 1. tables
create table if not exists public.iptv_lists (
  list_id text primary key,
  owner_id text not null,
  owner_username text not null default '',
  name text not null,
  description text not null default '',
  source text not null default 'link',
  m3u_url text not null default '',
  storage_path text not null default '',
  epg_url text not null default '',
  visibility text not null default 'public',
  excl_followers boolean not null default false,
  excl_countries text not null default '',
  excl_languages text not null default '',
  channel_count integer not null default 0,
  group_count integer not null default 0,
  live_count integer not null default 0,
  movie_count integer not null default 0,
  series_count integer not null default 0,
  sig text not null default '',
  views bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  indexed_at timestamptz
);

do $$
begin
  alter table public.iptv_lists add constraint iptv_lists_vis_check check (visibility in ('public', 'exclusive', 'private'));
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table public.iptv_lists add constraint iptv_lists_source_check check (source in ('link', 'upload'));
exception when duplicate_object then null;
end $$;

create index if not exists iptv_lists_owner_idx on public.iptv_lists (owner_id, updated_at desc);
create index if not exists iptv_lists_updated_idx on public.iptv_lists (updated_at desc);

comment on table public.iptv_lists is 'IPTV lists (M3U playlists) published by members. Read and written through the iptv_list* functions only.';
comment on column public.iptv_lists.m3u_url is 'source = link: the address of the playlist';
comment on column public.iptv_lists.storage_path is 'source = upload: Playlist/<member id>-<random>.m3u in the Storage bucket IPTV';
comment on column public.iptv_lists.excl_countries is 'exclusive: country codes (MA,FR,…), empty = every country';
comment on column public.iptv_lists.excl_languages is 'exclusive: site languages (en,ar,fr,de,es,nl,it), empty = every language';
comment on column public.iptv_lists.sig is 'Fingerprint of the channels last read (the publisher''s page reads them again when it changes)';
comment on column public.iptv_lists.indexed_at is 'When the channels were last read; other members see the list from then on';

-- private lists: who may see them
create table if not exists public.iptv_list_access (
  list_id text not null references public.iptv_lists (list_id) on delete cascade,
  member_id text not null,
  username text not null default '',
  added_at timestamptz not null default now(),
  primary key (list_id, member_id)
);
create index if not exists iptv_list_access_member_idx on public.iptv_list_access (member_id);

-- the channels of every list, for the channel search (no stream links)
create table if not exists public.iptv_list_channels (
  list_id text not null references public.iptv_lists (list_id) on delete cascade,
  pos integer not null,
  name text not null,
  group_name text not null default '',
  logo text not null default '',
  kind text not null default 'live',
  ckey text not null default '',
  primary key (list_id, pos)
);

-- Panel > Content > IPTV lists: suspended by the team (hidden from everybody but the publisher)
alter table public.iptv_lists add column if not exists suspended_at timestamptz;
alter table public.iptv_lists add column if not exists suspended_reason text not null default '';
alter table public.iptv_lists add column if not exists suspended_by text not null default '';

-- one view per member (or visitor address) and day
create table if not exists public.iptv_list_views (
  list_id text not null references public.iptv_lists (list_id) on delete cascade,
  viewer text not null,
  day date not null default current_date,
  primary key (list_id, viewer, day)
);

-- (round 31) more criteria for an exclusive list, its passwords, a private list kept out of the
-- search, and what the ranking points of Search.html count
alter table public.iptv_lists add column if not exists excl_level smallint not null default 0;
alter table public.iptv_lists add column if not exists excl_plan text not null default '';
alter table public.iptv_lists add column if not exists pass_hashes text[] not null default '{}';
alter table public.iptv_lists add column if not exists pass_ver integer not null default 0;
alter table public.iptv_lists add column if not exists search_hidden boolean not null default false;
alter table public.iptv_lists add column if not exists watch_minutes bigint not null default 0;
alter table public.iptv_lists add column if not exists likes integer not null default 0;
alter table public.iptv_lists add column if not exists dislikes integer not null default 0;
alter table public.iptv_lists add column if not exists shares integer not null default 0;
do $$
begin
  alter table public.iptv_lists add constraint iptv_lists_level_check check (excl_level between 0 and 10);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table public.iptv_lists add constraint iptv_lists_plan_check check (excl_plan in ('', 'Silver', 'Gold', 'Diamond'));
exception when duplicate_object then null;
end $$;
comment on column public.iptv_lists.excl_level is 'exclusive: the account level (LV) a member needs at least, 0 = any';
comment on column public.iptv_lists.excl_plan is 'exclusive: the membership a member needs at least (Silver < Gold < Diamond, the plan in force), empty = any';
comment on column public.iptv_lists.pass_hashes is 'exclusive: sha256(list id || '':'' || password) of each password; any one of them opens the list';
comment on column public.iptv_lists.pass_ver is 'Goes up when the passwords change: the members who had opened the list are asked again';
comment on column public.iptv_lists.search_hidden is 'private: kept out of Search.html and IPTV.html (else its name shows with a Request to join button)';

-- the members who typed a right password (for the passwords of version ver)
create table if not exists public.iptv_list_unlocks (
  list_id text not null references public.iptv_lists (list_id) on delete cascade,
  member_id text not null,
  ver integer not null default 0,
  unlocked_at timestamptz not null default now(),
  primary key (list_id, member_id)
);
-- wrong passwords: 5 in 15 minutes and the member waits
create table if not exists public.iptv_list_pass_fails (
  id bigint generated always as identity primary key,
  list_id text not null,
  member_id text not null,
  at timestamptz not null default now()
);
create index if not exists iptv_list_pass_fails_member_idx on public.iptv_list_pass_fails (member_id, at desc);

-- requests to join a private list
create table if not exists public.iptv_list_requests (
  id bigint generated always as identity primary key,
  list_id text not null references public.iptv_lists (list_id) on delete cascade,
  member_id text not null,
  username text not null default '',
  note text not null default '',
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  constraint iptv_list_requests_status check (status in ('pending', 'approved', 'rejected')),
  constraint iptv_list_requests_note check (char_length(note) <= 300)
);
create unique index if not exists iptv_list_requests_one_open on public.iptv_list_requests (list_id, member_id) where status = 'pending';
create index if not exists iptv_list_requests_list_idx on public.iptv_list_requests (list_id, created_at desc);
create index if not exists iptv_list_requests_member_idx on public.iptv_list_requests (member_id, created_at desc);

-- recommend (+1) / don't recommend (-1) a list
create table if not exists public.iptv_list_votes (
  list_id text not null references public.iptv_lists (list_id) on delete cascade,
  member_id text not null,
  vote smallint not null,
  created_at timestamptz not null default now(),
  primary key (list_id, member_id),
  constraint iptv_list_votes_vote check (vote in (-1, 1))
);

-- the shares of its link (a share button clicked), once per viewer, network and 10 minutes
create table if not exists public.iptv_list_shares (
  id bigint generated always as identity primary key,
  list_id text not null references public.iptv_lists (list_id) on delete cascade,
  viewer text not null,
  network text not null default '',
  at timestamptz not null default now()
);
create index if not exists iptv_list_shares_idx on public.iptv_list_shares (list_id, viewer, network, at desc);

-- the minutes watched of each channel of a list, per day
create table if not exists public.iptv_list_minutes (
  list_id text not null references public.iptv_lists (list_id) on delete cascade,
  ckey text not null,
  day date not null default current_date,
  minutes integer not null default 0,
  primary key (list_id, ckey, day)
);

-- Words found anywhere in a channel name ("sport" in "beIN Sports 1"): trigram indexes when
-- the extension can be enabled; the search works without them, only slower on big lists.
do $$
begin
  create extension if not exists pg_trgm with schema extensions;
  execute 'create index if not exists iptv_list_channels_trgm_idx on public.iptv_list_channels using gin (lower(name) gin_trgm_ops)';
  execute 'create index if not exists iptv_list_channels_group_trgm_idx on public.iptv_list_channels using gin (lower(group_name) gin_trgm_ops)';
exception when others then
  raise notice 'pg_trgm is not available: the channel search reads the names one by one.';
end $$;

-- nothing of this is open to the public API
do $$
declare t text; pol record;
begin
  foreach t in array array['iptv_lists', 'iptv_list_access', 'iptv_list_channels', 'iptv_list_views',
                           'iptv_list_unlocks', 'iptv_list_pass_fails', 'iptv_list_requests', 'iptv_list_votes',
                           'iptv_list_shares', 'iptv_list_minutes']
  loop
    execute format('alter table public.%I enable row level security', t);
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ------------------------------------------------------------------ 2. who may see what
-- A member who is not banned; NULL otherwise.
create or replace function public._iptvl_viewer(p_member text) returns public.members
language sql stable security definer set search_path = public as $$
  select m.* from public.members m
  where m.member_id = btrim(coalesce(p_member, ''))
    and btrim(coalesce(p_member, '')) <> ''
    and lower(btrim(coalesce(m.status, ''))) not in ('banned', 'blocked')
    and coalesce(m.status, '') <> 'محظور'
$$;

create or replace function public._iptvl_banned(p_member text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.members m
    where m.member_id = p_member
      and (lower(btrim(coalesce(m.status, ''))) in ('banned', 'blocked') or m.status = 'محظور'))
$$;

-- Restricted by Panel > Accounts: a temporary ban, or a partial ban on posts or links.
create or replace function public._iptvl_blocked(p_member text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare s record; feats text[];
begin
  if to_regclass('public.sanctions') is null then return false; end if;
  select features, temp_until into s from public.sanctions where member_id = p_member;
  if not found then return false; end if;
  if s.temp_until is not null and s.temp_until > now() then return true; end if;
  feats := string_to_array(replace(coalesce(s.features, ''), ' ', ''), ',');
  return 'posts' = any (feats) or 'links' = any (feats);
end $$;

-- The language of a member for the exclusive lists: the site language saved on their
-- profile (Settings), else the language of their country (as js/prefs.js), else English.
create or replace function public._iptvl_lang(p_member text, p_country text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select lower(btrim(p.language)) from public.profiles p
      where p.member_id = p_member and lower(btrim(coalesce(p.language, ''))) in ('en', 'ar', 'fr', 'de', 'es', 'nl', 'it')
      limit 1),
    case
      when upper(coalesce(p_country, '')) = any (string_to_array('MA DZ TN LY EG SA AE QA KW BH OM JO LB SY IQ YE SD PS MR DJ SO KM', ' ')) then 'ar'
      when upper(coalesce(p_country, '')) = any (string_to_array('FR BE LU MC SN CI CM CD CG GA MG ML BF NE TG BJ GN HT', ' ')) then 'fr'
      when upper(coalesce(p_country, '')) = any (string_to_array('DE AT CH LI', ' ')) then 'de'
      when upper(coalesce(p_country, '')) = any (string_to_array('ES MX AR CO CL PE VE EC GT CU BO DO HN PY SV NI CR PA UY PR GQ', ' ')) then 'es'
      when upper(coalesce(p_country, '')) = any (string_to_array('NL SR', ' ')) then 'nl'
      when upper(coalesce(p_country, '')) = any (string_to_array('IT SM VA', ' ')) then 'it'
      else 'en'
    end)
$$;

-- (round 31) the account level of a member (LV0 … LV10 = LV Max, sql/point_levels.sql), and the
-- membership in force (a paid plan that ended counts as Free)
create or replace function public._iptvl_level(p_member text) returns int
language plpgsql stable security definer set search_path = public as $$
begin
  if to_regprocedure('public.points_level(bigint)') is null or to_regprocedure('public._points(text)') is null then
    return 0;
  end if;
  return public.points_level(coalesce((public._points(p_member)->>'earned')::bigint, 0));
end $$;

create or replace function public._iptvl_plan(m public.members) returns text
language sql stable as $$
  select case when initcap(lower(btrim(coalesce(m.membership_type, '')))) in ('Silver', 'Gold', 'Diamond')
                   and (m.membership_expires_at is null or m.membership_expires_at > now())
              then initcap(lower(btrim(m.membership_type))) else 'Free' end
$$;

create or replace function public._iptvl_plan_rank(p_plan text) returns int
language sql immutable as $$
  select case initcap(lower(btrim(coalesce(p_plan, '')))) when 'Diamond' then 3 when 'Gold' then 2 when 'Silver' then 1 else 0 end
$$;

-- 'ok', or why the member may not see the list: gone | private | signin | followers |
-- country | language | level | plan | password. The publisher always sees their own lists;
-- a list the team suspended (Panel > Content) is gone for everybody else. The password
-- comes last: it is asked from a member who meets every other criterion.
create or replace function public._iptvl_access(l public.iptv_lists, p_member text) returns text
language plpgsql stable security definer set search_path = public as $$
declare m public.members;
begin
  p_member := btrim(coalesce(p_member, ''));
  if p_member <> '' and l.owner_id = p_member then return 'ok'; end if;
  if l.suspended_at is not null then return 'gone'; end if;
  if public._iptvl_banned(l.owner_id) then return 'gone'; end if;
  if l.visibility = 'public' then return 'ok'; end if;
  m := public._iptvl_viewer(p_member);
  if l.visibility = 'private' then
    if m.member_id is null or not exists (
      select 1 from public.iptv_list_access a where a.list_id = l.list_id and a.member_id = m.member_id
    ) then
      return 'private';
    end if;
    return 'ok';
  end if;
  -- exclusive: signed-in members who meet every criterion
  if m.member_id is null then return 'signin'; end if;
  if l.excl_followers and not exists (
    select 1 from public.follows f
    where f.follower_id = m.member_id and f.following_id = l.owner_id and f.status = 'accepted'
  ) then
    return 'followers';
  end if;
  if btrim(l.excl_countries) <> ''
     and not (upper(btrim(coalesce(m.country, ''))) = any (string_to_array(l.excl_countries, ','))) then
    return 'country';
  end if;
  if btrim(l.excl_languages) <> ''
     and not (public._iptvl_lang(m.member_id, m.country) = any (string_to_array(l.excl_languages, ','))) then
    return 'language';
  end if;
  if coalesce(l.excl_level, 0) > 0 then
    if public._iptvl_level(m.member_id) < l.excl_level then return 'level'; end if;
  end if;
  if coalesce(l.excl_plan, '') <> '' then
    if public._iptvl_plan_rank(public._iptvl_plan(m)) < public._iptvl_plan_rank(l.excl_plan) then return 'plan'; end if;
  end if;
  if coalesce(array_length(l.pass_hashes, 1), 0) > 0 and not exists (
    select 1 from public.iptv_list_unlocks u where u.list_id = l.list_id and u.member_id = m.member_id and u.ver = l.pass_ver
  ) then
    return 'password';
  end if;
  return 'ok';
end $$;

-- A list as a card (IPTV.html, the dashboard, Search.html). Its address is never part of it,
-- nor its passwords (the publisher gets how many there are).
create or replace function public._iptvl_card(l public.iptv_lists, p_member text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', l.list_id, 'name', l.name, 'description', left(l.description, 300),
    'visibility', l.visibility, 'followers', l.excl_followers,
    'countries', l.excl_countries, 'languages', l.excl_languages,
    'level', coalesce(l.excl_level, 0), 'plan', coalesce(l.excl_plan, ''),
    'password', coalesce(array_length(l.pass_hashes, 1), 0) > 0,
    'channels', l.channel_count, 'groups', l.group_count,
    'live', l.live_count, 'movies', l.movie_count, 'series', l.series_count,
    'views', l.views, 'source', l.source, 'epg', l.epg_url <> '',
    'minutes', coalesce(l.watch_minutes, 0), 'likes', coalesce(l.likes, 0), 'dislikes', coalesce(l.dislikes, 0),
    'shares', coalesce(l.shares, 0),
    'vote', coalesce((select v.vote from public.iptv_list_votes v
                       where v.list_id = l.list_id and v.member_id = btrim(coalesce(p_member, ''))), 0),
    'created_at', l.created_at, 'updated_at', l.updated_at, 'ready', l.indexed_at is not null,
    'owner_id', l.owner_id,
    'owner', coalesce((select m.username from public.members m where m.member_id = l.owner_id), l.owner_username),
    'owner_avatar', coalesce((select p.avatar_url from public.profiles p where p.member_id = l.owner_id), ''),
    'mine', l.owner_id = btrim(coalesce(p_member, '')),
    -- only the publisher ever gets the card of a suspended list
    'suspended', case when l.suspended_at is not null
                      then jsonb_build_object('reason', l.suspended_reason, 'at', l.suspended_at) end)
  || case when l.owner_id = btrim(coalesce(p_member, '')) and btrim(coalesce(p_member, '')) <> ''
          then jsonb_build_object('passwords', coalesce(array_length(l.pass_hashes, 1), 0), 'hidden', l.search_hidden,
                                  'requests', (select count(*) from public.iptv_list_requests r
                                                where r.list_id = l.list_id and r.status = 'pending'))
          else '{}'::jsonb end
$$;

-- "a, b; c" or ["a", "b"] -> the distinct values, upper or lower case
create or replace function public._iptvl_codes(v jsonb, p_upper boolean) returns text[]
language sql immutable as $$
  select coalesce(array_agg(distinct x order by x), '{}') from (
    select case when p_upper then upper(btrim(x)) else lower(btrim(x)) end as x
    from regexp_split_to_table(
      case when jsonb_typeof(v) = 'array' then (select string_agg(e, ',') from jsonb_array_elements_text(v) as e)
           when jsonb_typeof(v) = 'string' then v #>> '{}'
           else '' end, '[,;[:space:]]+') as x
  ) s where x <> ''
$$;

-- ------------------------------------------------------------------ 3. publishing
-- d: { id (to edit one), name, description, source: link | upload, url (link),
--      path (upload: Playlist/<member id>-<20 letters>.m3u), epg, visibility,
--      followers, countries, languages, level (0-10), plan ('' | Silver | Gold | Diamond),
--      passwords[] (exclusive; left out: the passwords stay as they are, [] removes them),
--      people[] (private: usernames or ids), hidden (private: kept out of the search) }
-- -> { ok: true, id, created, notified }
--    { ok: false, reason: member | blocked | bad_request | not_found | limit | name |
--      description | source | url | path | file | visibility | criteria | password |
--      people (+ bad[]) | busy }
create or replace function public.iptv_list_save(p_member text, d jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  m public.members; l public.iptv_lists; lid text := nullif(btrim(coalesce(d->>'id', '')), '');
  is_new boolean; nm text; descr text; src text; url text := ''; pth text := ''; epg text; vis text;
  fol boolean := false; ctys text[] := '{}'; langs text[] := '{}'; people text[] := '{}';
  bad text[] := '{}'; ids text[] := '{}'; names text[] := '{}'; fresh text[] := '{}';
  x text; mid text; uname text; i int := 0; n int := 0;
  lvl int := 0; pln text := ''; pws text[] := '{}'; hashes text[]; pw_given boolean; hid boolean := false; npw int := 0;
begin
  m := public._iptvl_viewer(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if public._iptvl_blocked(m.member_id) then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  if jsonb_typeof(d) is distinct from 'object' then return jsonb_build_object('ok', false, 'reason', 'bad_request'); end if;
  is_new := lid is null;
  if is_new then
    if (select count(*) from public.iptv_lists where owner_id = m.member_id and created_at > now() - interval '1 day') >= 20
       or (select count(*) from public.iptv_lists where owner_id = m.member_id) >= 200 then
      return jsonb_build_object('ok', false, 'reason', 'limit');
    end if;
  else
    select * into l from public.iptv_lists where list_id = lid and owner_id = m.member_id for update;
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  end if;

  nm := btrim(regexp_replace(coalesce(d->>'name', ''), '[[:cntrl:]]+', ' ', 'g'));
  if char_length(nm) < 1 or char_length(nm) > 80 then return jsonb_build_object('ok', false, 'reason', 'name'); end if;
  descr := btrim(regexp_replace(coalesce(d->>'description', ''), E'[\\x01-\\x09\\x0B\\x0C\\x0E-\\x1F\\x7F]+', ' ', 'g'));
  if char_length(descr) > 1000 then return jsonb_build_object('ok', false, 'reason', 'description'); end if;
  src := lower(coalesce(nullif(d->>'source', ''), 'link'));
  if src not in ('link', 'upload') then return jsonb_build_object('ok', false, 'reason', 'source'); end if;
  if src = 'link' then
    url := btrim(coalesce(d->>'url', ''));
    if url !~* '^https?://[^/?#[:space:]]+' or length(url) > 2000 or url ~ '[[:space:]<>"`]' then
      return jsonb_build_object('ok', false, 'reason', 'url');
    end if;
    -- the playlist of one of their lists the team suspended cannot come back in another list
    if exists (select 1 from public.iptv_lists x where x.owner_id = m.member_id and x.m3u_url = url
                 and x.suspended_at is not null and x.list_id is distinct from lid) then
      return jsonb_build_object('ok', false, 'reason', 'suspended');
    end if;
  else
    pth := btrim(coalesce(d->>'path', ''));
    if pth !~ '^Playlist/ID[0-9]{1,20}-[A-Za-z0-9]{20}\.m3u8?$' or split_part(substr(pth, 10), '-', 1) <> m.member_id then
      return jsonb_build_object('ok', false, 'reason', 'path');
    end if;
    -- the file must be there (skipped where storage.objects can't be read)
    begin
      if not exists (select 1 from storage.objects o where o.bucket_id = 'IPTV' and o.name = pth) then
        return jsonb_build_object('ok', false, 'reason', 'file');
      end if;
    exception when others then null;
    end;
  end if;
  epg := btrim(coalesce(d->>'epg', ''));
  if epg <> '' and (epg !~* '^https?://[^/?#[:space:]]+' or length(epg) > 2000 or epg ~ '[[:space:]<>"`]') then epg := ''; end if;
  vis := coalesce(nullif(d->>'visibility', ''), 'public');
  if vis not in ('public', 'exclusive', 'private') then return jsonb_build_object('ok', false, 'reason', 'visibility'); end if;

  -- the passwords: the ones sent, or (left out of d) the ones the list has
  pw_given := d ? 'passwords';
  if pw_given then
    if jsonb_typeof(d->'passwords') is distinct from 'array' then return jsonb_build_object('ok', false, 'reason', 'password'); end if;
    select coalesce(array_agg(distinct v), '{}') into pws from (
      select btrim(e) as v from jsonb_array_elements_text(d->'passwords') as e
    ) s where v <> '';
    if coalesce(array_length(pws, 1), 0) > 10
       or exists (select 1 from unnest(pws) as v where char_length(v) < 4 or char_length(v) > 64) then
      return jsonb_build_object('ok', false, 'reason', 'password');
    end if;
  end if;

  if vis = 'exclusive' then
    fol := lower(coalesce(d->>'followers', '')) in ('true', '1', 'yes', 'on');
    select coalesce(array_agg(c), '{}') into ctys from unnest(public._iptvl_codes(d->'countries', true)) as c where c ~ '^[A-Z]{2}$';
    select coalesce(array_agg(c), '{}') into langs from unnest(public._iptvl_codes(d->'languages', false)) as c
      where c in ('en', 'ar', 'fr', 'de', 'es', 'nl', 'it');
    if coalesce(array_length(ctys, 1), 0) > 60 then return jsonb_build_object('ok', false, 'reason', 'criteria'); end if;
    lvl := case when coalesce(d->>'level', '') ~ '^[0-9]{1,2}$' then (d->>'level')::int else 0 end;
    if lvl > 10 then return jsonb_build_object('ok', false, 'reason', 'criteria'); end if;
    pln := initcap(lower(btrim(coalesce(d->>'plan', ''))));
    if pln in ('', 'Free', 'Any') then pln := ''; end if;
    if pln not in ('', 'Silver', 'Gold', 'Diamond') then return jsonb_build_object('ok', false, 'reason', 'criteria'); end if;
    npw := coalesce(array_length(pws, 1), 0);
    if not pw_given and not is_new then npw := coalesce(array_length(l.pass_hashes, 1), 0); end if;
    if not fol and coalesce(array_length(ctys, 1), 0) = 0 and coalesce(array_length(langs, 1), 0) = 0
       and lvl = 0 and pln = '' and npw = 0 then
      return jsonb_build_object('ok', false, 'reason', 'criteria');
    end if;
  end if;
  hid := vis = 'private' and lower(coalesce(d->>'hidden', '')) in ('true', '1', 'yes', 'on');

  if vis = 'private' then
    select coalesce(array_agg(distinct v), '{}') into people from (
      select btrim(regexp_replace(e, '^@+', '')) as v
      from jsonb_array_elements_text(case when jsonb_typeof(d->'people') = 'array' then d->'people' else '[]'::jsonb end) as e
    ) s where v <> '';
    if coalesce(array_length(people, 1), 0) > 200 then return jsonb_build_object('ok', false, 'reason', 'people'); end if;
    foreach x in array people loop
      mid := null;
      uname := null;
      if char_length(x) <= 60 then
        select mm.member_id, mm.username into mid, uname
        from public.members mm
        where (lower(mm.username) = lower(x) or upper(mm.member_id) = upper(x))
          and lower(btrim(coalesce(mm.status, ''))) not in ('banned', 'blocked') and coalesce(mm.status, '') <> 'محظور'
        order by (upper(mm.member_id) = upper(x)) desc
        limit 1;
      end if;
      if mid is null then
        bad := bad || x;
      elsif mid <> m.member_id and not (mid = any (ids)) then
        ids := ids || mid;
        names := names || uname;
      end if;
    end loop;
    if coalesce(array_length(bad, 1), 0) > 0 then
      return jsonb_build_object('ok', false, 'reason', 'people', 'bad', to_jsonb(bad));
    end if;
    if coalesce(array_length(ids, 1), 0) = 0 then return jsonb_build_object('ok', false, 'reason', 'people'); end if;
  end if;

  if is_new then
    loop
      lid := 'IPL' || lpad((floor(random() * 1e9))::bigint::text, 9, '0');
      exit when not exists (select 1 from public.iptv_lists where list_id = lid);
      i := i + 1;
      if i > 20 then return jsonb_build_object('ok', false, 'reason', 'busy'); end if;
    end loop;
    insert into public.iptv_lists (list_id, owner_id, owner_username, name, description, source, m3u_url, storage_path,
                                   epg_url, visibility, excl_followers, excl_countries, excl_languages)
    values (lid, m.member_id, m.username, nm, descr, src, url, pth, epg, vis, fol,
            array_to_string(ctys, ','), array_to_string(langs, ','));
  else
    update public.iptv_lists set
      owner_username = m.username, name = nm, description = descr, source = src, m3u_url = url, storage_path = pth,
      epg_url = epg, visibility = vis, excl_followers = fol,
      excl_countries = array_to_string(ctys, ','), excl_languages = array_to_string(langs, ','), updated_at = now()
    where list_id = lid;
    -- another playlist: its channels are read again (iptv_list_index)
    if l.source <> src or l.m3u_url <> url or l.storage_path <> pth then
      delete from public.iptv_list_channels where list_id = lid;
      update public.iptv_lists set channel_count = 0, group_count = 0, live_count = 0, movie_count = 0,
                                   series_count = 0, sig = '', indexed_at = null
      where list_id = lid;
    end if;
  end if;

  -- (round 31) the other criteria of an exclusive list, and its passwords, hashed with the id of the
  -- list; new passwords make the members who had opened it type one again
  if vis = 'exclusive' and (pw_given or is_new) then
    select coalesce(array_agg(h order by h), '{}') into hashes
      from (select encode(sha256(convert_to(lid || ':' || v, 'UTF8')), 'hex') as h from unnest(pws) as v) z;
  elsif vis = 'exclusive' then
    hashes := coalesce(l.pass_hashes, '{}');
  else
    hashes := '{}';
  end if;
  update public.iptv_lists set
    excl_level = lvl, excl_plan = pln, search_hidden = hid, pass_hashes = hashes,
    pass_ver = case when pass_hashes is distinct from hashes then pass_ver + 1 else pass_ver end
  where list_id = lid;

  -- a private list: the members listed now (the others lose it); the new ones are told
  select coalesce(array_agg(v), '{}') into fresh from unnest(ids) as v
  where not exists (select 1 from public.iptv_list_access a where a.list_id = lid and a.member_id = v);
  delete from public.iptv_list_access a where a.list_id = lid and not (a.member_id = any (ids));
  -- a list that is no longer private: its open requests to join go
  if vis <> 'private' then delete from public.iptv_list_requests where list_id = lid and status = 'pending'; end if;
  for i in 1 .. coalesce(array_length(ids, 1), 0) loop
    insert into public.iptv_list_access (list_id, member_id, username) values (lid, ids[i], names[i])
    on conflict (list_id, member_id) do update set username = excluded.username;
  end loop;
  if coalesce(array_length(fresh, 1), 0) > 0 and to_regclass('public.notifications') is not null then
    insert into public.notifications (member_id, kind, title, body, href, from_id, from_username)
    select v, 'iptv_list', 'IPTV list shared with you', nm, './Listchannels.html?list=' || lid, m.member_id, m.username
    from unnest(fresh) as v;
    get diagnostics n = row_count;
  end if;
  return jsonb_build_object('ok', true, 'id', lid, 'created', is_new, 'notified', n);
end $$;

-- The channels of a list, read by the publisher's browser: p_rows = [{ n: name, g: group,
-- l: logo, k: live | movie | series, c: key of the channel on Listchannels.html }], sent
-- in parts of at most 2 500 from position p_start (0 = the first part: the old channels go).
-- 20 000 channels are kept at most. The last part (p_done) saves the totals of the whole
-- playlist (p_counts: { channels, groups, live, movie, series }, else counted here), its
-- fingerprint and, when the list has none yet, the guide of the playlist header.
-- -> { ok: true, indexed } | { ok: false, reason: not_found | bad_request }
create or replace function public.iptv_list_index(
  p_member text, p_id text, p_rows jsonb, p_start int default 0, p_done boolean default true,
  p_counts jsonb default null, p_epg text default '', p_sig text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.iptv_lists; st int := greatest(coalesce(p_start, 0), 0); n int := 0; cap constant int := 20000;
  k record; num jsonb := coalesce(p_counts, '{}'::jsonb);
begin
  select * into l from public.iptv_lists
  where list_id = btrim(coalesce(p_id, '')) and owner_id = btrim(coalesce(p_member, '')) and btrim(coalesce(p_member, '')) <> ''
  for update;
  if not found or public._iptvl_banned(l.owner_id) then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 2500 then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;
  if st = 0 then delete from public.iptv_list_channels where list_id = l.list_id; end if;
  insert into public.iptv_list_channels (list_id, pos, name, group_name, logo, kind, ckey)
  select l.list_id, st + (e.i - 1)::int,
         left(btrim(regexp_replace(coalesce(e.x->>'n', ''), '[[:cntrl:]]+', ' ', 'g')), 200),
         left(btrim(regexp_replace(coalesce(e.x->>'g', ''), '[[:cntrl:]]+', ' ', 'g')), 120),
         case when coalesce(e.x->>'l', '') ~* '^https?://[^[:space:]<>"`]+$' and length(e.x->>'l') <= 1000 then e.x->>'l' else '' end,
         case when e.x->>'k' in ('live', 'movie', 'series') then e.x->>'k' else 'live' end,
         left(regexp_replace(coalesce(e.x->>'c', ''), '[^A-Za-z0-9_-]', '', 'g'), 40)
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as e(x, i)
  where jsonb_typeof(e.x) = 'object' and st + (e.i - 1) < cap
    and btrim(regexp_replace(coalesce(e.x->>'n', ''), '[[:cntrl:]]+', ' ', 'g')) <> ''
  on conflict (list_id, pos) do update
    set name = excluded.name, group_name = excluded.group_name, logo = excluded.logo, kind = excluded.kind, ckey = excluded.ckey;
  get diagnostics n = row_count;
  if coalesce(p_done, true) then
    select count(*) as total, count(distinct lower(group_name)) as groups,
           count(*) filter (where kind = 'live') as live, count(*) filter (where kind = 'movie') as movie,
           count(*) filter (where kind = 'series') as series
      into k from public.iptv_list_channels where list_id = l.list_id;
    update public.iptv_lists set
      channel_count = greatest(k.total, least(greatest(coalesce((num->>'channels')::int, 0), 0), 10000000)),
      group_count = greatest(k.groups, least(greatest(coalesce((num->>'groups')::int, 0), 0), 10000000)),
      live_count = greatest(k.live, least(greatest(coalesce((num->>'live')::int, 0), 0), 10000000)),
      movie_count = greatest(k.movie, least(greatest(coalesce((num->>'movie')::int, 0), 0), 10000000)),
      series_count = greatest(k.series, least(greatest(coalesce((num->>'series')::int, 0), 0), 10000000)),
      sig = left(regexp_replace(coalesce(p_sig, ''), '[^A-Za-z0-9_-]', '', 'g'), 64),
      indexed_at = now(),
      epg_url = case when epg_url = '' and coalesce(p_epg, '') ~* '^https?://[^/?#[:space:]]+' and length(p_epg) <= 2000
                          and p_epg !~ '[[:space:]<>"`]' then p_epg else epg_url end
    where list_id = l.list_id;
  end if;
  return jsonb_build_object('ok', true, 'indexed', n);
exception when invalid_text_representation or numeric_value_out_of_range then
  return jsonb_build_object('ok', false, 'reason', 'bad_request');
end $$;

create or replace function public.iptv_list_delete(p_member text, p_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pth text;
begin
  delete from public.iptv_lists
  where list_id = btrim(coalesce(p_id, '')) and owner_id = btrim(coalesce(p_member, '')) and btrim(coalesce(p_member, '')) <> ''
  returning storage_path into pth;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'path', coalesce(pth, ''));
end $$;

-- Dashboard > IPTV > Your lists: every list of the member, the last changed first, with
-- its address and the members of a private list.
create or replace function public.iptv_lists_mine(p_member text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(public._iptvl_card(l, p_member) || jsonb_build_object(
           'description', l.description, 'url', l.m3u_url, 'path', l.storage_path, 'epg_url', l.epg_url,
           'indexed_at', l.indexed_at, 'sig', l.sig,
           'people', coalesce((
             select jsonb_agg(jsonb_build_object('id', a.member_id, 'username', coalesce(mm.username, a.username))
                              order by lower(coalesce(mm.username, a.username)))
             from public.iptv_list_access a left join public.members mm on mm.member_id = a.member_id
             where a.list_id = l.list_id), '[]'::jsonb))
         order by l.updated_at desc, l.list_id desc), '[]'::jsonb)
  from public.iptv_lists l
  where l.owner_id = btrim(coalesce(p_member, '')) and btrim(coalesce(p_member, '')) <> ''
$$;

-- ------------------------------------------------------------------ 4. finding lists
-- IPTV.html: the lists the visitor may see, the exclusive lists whose criteria they do not meet
-- (with locked: why) and the private lists their publisher did not keep out of the search
-- (locked: private, with request: '' | pending | rejected; never their channels).
--   p_q       words found in the name, the description or the publisher's username
--   p_sort    relevance | date (last changed) | views | channels | az | za
--   p_filter  '' (all) | public | exclusive | private | mine | open (only the lists the visitor may open:
--             the home page's row)
-- A list whose channels were never read shows to its publisher only.
-- -> { total, items: [cards (+ locked, request)], sort }
create or replace function public.iptv_lists_search(
  p_member text default '', p_q text default '', p_sort text default '', p_filter text default '',
  p_limit int default 24, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  me text := btrim(coalesce(p_member, '')); q text := btrim(coalesce(p_q, '')); words text[];
  srt text := lower(coalesce(p_sort, '')); flt text := lower(coalesce(p_filter, ''));
  lim int := least(greatest(coalesce(p_limit, 24), 1), 60); off int := greatest(coalesce(p_offset, 0), 0);
  total int; items jsonb; viewer text;
begin
  select coalesce(array_agg(x), '{}') into words from (
    select replace(replace(replace(lower(x), '\', '\\'), '%', '\%'), '_', '\_') as x
    from regexp_split_to_table(q, '\s+') as x where x <> '' limit 8
  ) s;
  if srt not in ('relevance', 'date', 'views', 'channels', 'az', 'za') then srt := case when q = '' then 'date' else 'relevance' end; end if;
  if flt not in ('', 'public', 'exclusive', 'private', 'mine', 'open') then flt := ''; end if;
  viewer := coalesce((public._iptvl_viewer(me)).member_id, '');
  with base as (
    select l as r
    from public.iptv_lists l
    where (flt in ('', 'open') or (flt = 'mine' and me <> '' and l.owner_id = me) or l.visibility = flt)
      and (l.indexed_at is not null or (me <> '' and l.owner_id = me))
      and not exists (
        select 1 from unnest(words) as ww(x)
        where (lower(l.name) || ' ' || lower(l.description) || ' ' || lower(l.owner_username)) not like '%' || ww.x || '%'
      )
  ), judged as (
    select b.r, public._iptvl_access(b.r, me) as why from base b
  ), seen as (
    select j.r, j.why from judged j
    where j.why = 'ok'
       or (flt <> 'open' and (
            ((j.r).visibility = 'exclusive' and j.why not in ('gone', 'private'))
         or ((j.r).visibility = 'private' and j.why = 'private' and not (j.r).search_hidden)))
  )
  select (select count(*) from seen),
         coalesce((select jsonb_agg(public._iptvl_card(z.r, me)
                     || case when z.why = 'ok' then '{}'::jsonb else jsonb_build_object('locked', z.why) end
                     || case when z.why = 'private' and viewer <> ''
                             then jsonb_build_object('request', coalesce((select rq.status from public.iptv_list_requests rq
                                    where rq.list_id = (z.r).list_id and rq.member_id = viewer order by rq.created_at desc limit 1), ''))
                             else '{}'::jsonb end
                     order by z.rn) from (
           select s.r, s.why, row_number() over (order by
             case when srt = 'relevance' then (case when lower((s.r).name) like '%' || lower(q) || '%' then 0 else 1 end) end,
             case when srt = 'views' then (s.r).views end desc,
             case when srt = 'channels' then (s.r).channel_count end desc,
             case when srt = 'az' then lower((s.r).name) end asc,
             case when srt = 'za' then lower((s.r).name) end desc,
             case when srt = 'relevance' then (s.r).views end desc,
             (s.r).updated_at desc, (s.r).list_id) as rn
           from seen s
           order by rn
           offset off limit lim
         ) z), '[]'::jsonb)
    into total, items;
  return jsonb_build_object('total', total, 'items', items, 'sort', srt);
end $$;

-- Listchannels.html?list=IPL…: the list and where its playlist is, when the visitor may
-- see it. Counts one view a day per member (or visitor address), the publisher's aside.
-- -> { ok: true, list: { card…, description, url (link) | path (upload), epg_url, sig (publisher) } }
--    { ok: false, reason: not_found | signin }
--    { ok: false, reason: private, id, name, owner, owner_id, request: '' | pending | rejected, member }
--    { ok: false, reason: followers | country | language | level | plan | password, id, name, owner,
--      owner_id, followers, countries, languages, level, plan, password, my_level, my_plan,
--      wait (seconds before a password may be tried again) }
create or replace function public.iptv_list_open(p_id text, p_member text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare l public.iptv_lists; me text := btrim(coalesce(p_member, '')); why text; who text; hdr json; ip text := '';
  m public.members; req text := ''; fails int; first_fail timestamptz;
begin
  select * into l from public.iptv_lists where list_id = btrim(coalesce(p_id, ''));
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  why := public._iptvl_access(l, me);
  if why = 'gone' then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if why = 'signin' then return jsonb_build_object('ok', false, 'reason', why); end if;
  m := public._iptvl_viewer(me);
  if why = 'private' then
    if m.member_id is not null then
      select r.status into req from public.iptv_list_requests r
       where r.list_id = l.list_id and r.member_id = m.member_id order by r.created_at desc limit 1;
    end if;
    return jsonb_build_object('ok', false, 'reason', 'private', 'id', l.list_id, 'name', l.name, 'owner_id', l.owner_id,
      'owner', coalesce((select x.username from public.members x where x.member_id = l.owner_id), l.owner_username),
      'request', coalesce(req, ''), 'member', m.member_id is not null);
  end if;
  if why <> 'ok' then
    if why = 'password' then
      select count(*), min(f.at) into fails, first_fail from public.iptv_list_pass_fails f
       where f.member_id = m.member_id and f.at > now() - interval '15 minutes';
    end if;
    return jsonb_build_object('ok', false, 'reason', why, 'id', l.list_id, 'name', l.name, 'owner_id', l.owner_id,
      'owner', coalesce((select x.username from public.members x where x.member_id = l.owner_id), l.owner_username),
      'followers', l.excl_followers, 'countries', l.excl_countries, 'languages', l.excl_languages,
      'level', coalesce(l.excl_level, 0), 'plan', coalesce(l.excl_plan, ''),
      'password', coalesce(array_length(l.pass_hashes, 1), 0) > 0,
      'my_level', case when why = 'level' then public._iptvl_level(m.member_id) end,
      'my_plan', case when why = 'plan' then public._iptvl_plan(m) end,
      'wait', case when why = 'password' and coalesce(fails, 0) >= 5
                   then greatest(1, ceil(extract(epoch from (first_fail + interval '15 minutes' - now()))))::int else 0 end);
  end if;
  if l.owner_id <> me then
    if m.member_id is not null then
      who := me;
    else
      begin
        hdr := nullif(current_setting('request.headers', true), '')::json;
        ip := coalesce(nullif(hdr->>'cf-connecting-ip', ''), nullif(btrim(split_part(coalesce(hdr->>'x-forwarded-for', ''), ',', 1)), ''), '');
      exception when others then ip := '';
      end;
      who := 'guest:' || md5(ip);
    end if;
    insert into public.iptv_list_views (list_id, viewer, day) values (l.list_id, who, current_date) on conflict do nothing;
    if found then
      update public.iptv_lists set views = views + 1 where list_id = l.list_id returning * into l;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'list', public._iptvl_card(l, me) || jsonb_build_object(
    'description', l.description,
    'url', case when l.source = 'link' then l.m3u_url else '' end,
    'path', case when l.source = 'upload' then l.storage_path else '' end,
    'epg_url', l.epg_url,
    'sig', case when l.owner_id = me then l.sig else '' end));
end $$;

-- (round 31) One of the passwords of an exclusive list. Asked once: the list then opens for the
-- member until its publisher changes the passwords. A member who does not meet the other
-- criteria is told so first (a password would not open it). 5 wrong passwords in 15 minutes
-- and the member waits.
-- -> { ok: true } | { ok: false, reason: member | not_found | no_password | criteria (+ why) |
--      wrong (+ left) | locked (+ wait seconds) | bad_request }
create or replace function public.iptv_list_unlock(p_id text, p_member text, p_password text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.iptv_lists; m public.members; why text; pw text := btrim(coalesce(p_password, '')); fails int; first_fail timestamptz;
begin
  m := public._iptvl_viewer(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  select * into l from public.iptv_lists where list_id = btrim(coalesce(p_id, ''));
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  why := public._iptvl_access(l, m.member_id);
  if why = 'gone' then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if why = 'ok' then return jsonb_build_object('ok', true, 'already', true); end if;
  if l.visibility <> 'exclusive' or coalesce(array_length(l.pass_hashes, 1), 0) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_password');
  end if;
  if why <> 'password' then return jsonb_build_object('ok', false, 'reason', 'criteria', 'why', why); end if;
  if char_length(pw) < 1 or char_length(pw) > 64 then return jsonb_build_object('ok', false, 'reason', 'bad_request'); end if;
  select count(*), min(f.at) into fails, first_fail from public.iptv_list_pass_fails f
   where f.member_id = m.member_id and f.at > now() - interval '15 minutes';
  if fails >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'locked',
      'wait', greatest(1, ceil(extract(epoch from (first_fail + interval '15 minutes' - now()))))::int);
  end if;
  if encode(sha256(convert_to(l.list_id || ':' || pw, 'UTF8')), 'hex') = any (l.pass_hashes) then
    insert into public.iptv_list_unlocks (list_id, member_id, ver) values (l.list_id, m.member_id, l.pass_ver)
    on conflict (list_id, member_id) do update set ver = excluded.ver, unlocked_at = now();
    delete from public.iptv_list_pass_fails where member_id = m.member_id and list_id = l.list_id;
    return jsonb_build_object('ok', true);
  end if;
  insert into public.iptv_list_pass_fails (list_id, member_id) values (l.list_id, m.member_id);
  if random() < 0.05 then delete from public.iptv_list_pass_fails where at < now() - interval '1 day'; end if;
  return jsonb_build_object('ok', false, 'reason', case when fails + 1 >= 5 then 'locked' else 'wrong' end,
    'left', greatest(0, 4 - fails),
    'wait', case when fails + 1 >= 5 then 900 else 0 end);
end $$;

-- (round 31) Ask the publisher of a private list to let the member in (a note of 300 characters
-- at most). The publisher hears it in the bell and answers in Dashboard > IPTV > Your lists.
-- After a refusal the member may ask again a day later.
-- -> { ok: true, status: pending } | { ok: false, reason: member | not_found | not_private |
--      already | pending | wait | blocked | limit | note }
create or replace function public.iptv_list_request(p_member text, p_id text, p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.iptv_lists; m public.members; why text; nt text := btrim(regexp_replace(coalesce(p_note, ''), '\s+', ' ', 'g'));
  last_no timestamptz;
begin
  m := public._iptvl_viewer(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  select * into l from public.iptv_lists where list_id = btrim(coalesce(p_id, '')) for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  why := public._iptvl_access(l, m.member_id);
  if why = 'gone' then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if l.visibility <> 'private' then return jsonb_build_object('ok', false, 'reason', 'not_private'); end if;
  if why = 'ok' then return jsonb_build_object('ok', false, 'reason', 'already'); end if;
  if char_length(nt) > 300 then return jsonb_build_object('ok', false, 'reason', 'note'); end if;
  if exists (select 1 from public.iptv_list_requests r where r.list_id = l.list_id and r.member_id = m.member_id and r.status = 'pending') then
    return jsonb_build_object('ok', false, 'reason', 'pending');
  end if;
  select max(r.answered_at) into last_no from public.iptv_list_requests r
   where r.list_id = l.list_id and r.member_id = m.member_id and r.status = 'rejected';
  if last_no is not null and last_no > now() - interval '1 day' then
    return jsonb_build_object('ok', false, 'reason', 'wait');
  end if;
  if exists (select 1 from public.blocks b where b.blocker_id = l.owner_id and b.blocked_id = m.member_id and b.kind = 'full') then
    return jsonb_build_object('ok', false, 'reason', 'blocked');
  end if;
  if (select count(*) from public.iptv_list_requests r where r.member_id = m.member_id and r.created_at > now() - interval '1 day') >= 20
     or (select count(*) from public.iptv_list_requests r where r.member_id = m.member_id and r.status = 'pending') >= 50 then
    return jsonb_build_object('ok', false, 'reason', 'limit');
  end if;
  insert into public.iptv_list_requests (list_id, member_id, username, note) values (l.list_id, m.member_id, m.username, nt);
  if to_regclass('public.notifications') is not null then
    insert into public.notifications (member_id, kind, title, body, href, from_id, from_username)
    values (l.owner_id, 'iptv_join', 'Request to join your IPTV list',
            left('@' || m.username || ' · ' || l.name || case when nt <> '' then ' · ' || nt else '' end, 300),
            './dashboard.html#iptv-lists', m.member_id, m.username);
  end if;
  return jsonb_build_object('ok', true, 'status', 'pending');
end $$;

-- (round 31) Dashboard > IPTV > Your lists > Requests: the requests to join the member's lists.
--   p_filter  pending | all     -> { ok: true, pending, items: [{ id, list: { id, name }, member: { id, username,
--   avatar, country }, note, status, created_at, answered_at }] } | { ok: false, reason: member }
create or replace function public.iptv_list_requests(p_member text, p_filter text default 'pending', p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare m public.members; f text := case when p_filter = 'all' then 'all' else 'pending' end;
begin
  m := public._iptvl_viewer(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  return jsonb_build_object('ok', true,
    'pending', (select count(*) from public.iptv_list_requests r join public.iptv_lists l on l.list_id = r.list_id
                 where l.owner_id = m.member_id and r.status = 'pending'),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', z.id, 'list', jsonb_build_object('id', z.list_id, 'name', z.lname, 'visibility', z.visibility),
        'member', jsonb_build_object('id', z.member_id, 'username', coalesce(z.uname, z.username), 'avatar', z.avatar,
                                     'country', z.country),
        'note', z.note, 'status', z.status, 'created_at', z.created_at, 'answered_at', z.answered_at)
        order by (z.status = 'pending') desc, z.created_at desc)
      from (select r.*, l.name as lname, l.visibility, mm.username as uname, coalesce(p.avatar_url, '') as avatar,
                   upper(coalesce(mm.country, '')) as country
              from public.iptv_list_requests r
              join public.iptv_lists l on l.list_id = r.list_id and l.owner_id = m.member_id
              left join public.members mm on mm.member_id = r.member_id
              left join public.profiles p on p.member_id = r.member_id
             where f = 'all' or r.status = 'pending'
             order by (r.status = 'pending') desc, r.created_at desc
             limit least(greatest(coalesce(p_limit, 100), 1), 300)) z), '[]'::jsonb));
end $$;

-- (round 31) The publisher accepts (the member is added to the list and told) or declines (told) a request.
-- -> { ok: true, status } | { ok: false, reason: member | not_found | state }
create or replace function public.iptv_list_request_answer(p_member text, p_id bigint, p_action text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members; r public.iptv_list_requests; l public.iptv_lists; u public.members;
begin
  m := public._iptvl_viewer(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if p_action not in ('approve', 'reject') then return jsonb_build_object('ok', false, 'reason', 'action'); end if;
  select * into r from public.iptv_list_requests where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select * into l from public.iptv_lists where list_id = r.list_id;
  if not found or l.owner_id <> m.member_id then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if r.status <> 'pending' or l.visibility <> 'private' then return jsonb_build_object('ok', false, 'reason', 'state'); end if;
  select * into u from public.members where member_id = r.member_id;
  if p_action = 'approve' then
    if u.member_id is null or public._iptvl_banned(u.member_id) then return jsonb_build_object('ok', false, 'reason', 'state'); end if;
    insert into public.iptv_list_access (list_id, member_id, username) values (l.list_id, u.member_id, u.username)
    on conflict (list_id, member_id) do update set username = excluded.username;
  end if;
  update public.iptv_list_requests set status = case when p_action = 'approve' then 'approved' else 'rejected' end,
                                       answered_at = now()
   where id = r.id;
  if to_regclass('public.notifications') is not null then
    insert into public.notifications (member_id, kind, title, body, href, from_id, from_username)
    values (r.member_id, case when p_action = 'approve' then 'iptv_join_ok' else 'iptv_join_no' end,
            case when p_action = 'approve' then 'Your request to join an IPTV list was accepted'
                 else 'Your request to join an IPTV list was declined' end,
            left(l.name, 300),
            case when p_action = 'approve' then './Listchannels.html?list=' || l.list_id else './Search.html?tab=channels' end,
            m.member_id, m.username);
  end if;
  return jsonb_build_object('ok', true, 'status', case when p_action = 'approve' then 'approved' else 'rejected' end);
end $$;

-- (round 31) Recommend (1), don't recommend (-1) or take the vote back (0): a member who may see
-- the list, not its publisher. -> { ok: true, vote, likes, dislikes } | { ok: false, reason: member | access | bad_request | own }
create or replace function public.iptv_list_vote(p_member text, p_id text, p_vote int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members; l public.iptv_lists; prev smallint;
begin
  m := public._iptvl_viewer(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if p_vote is null or p_vote not in (-1, 0, 1) then return jsonb_build_object('ok', false, 'reason', 'bad_request'); end if;
  select * into l from public.iptv_lists where list_id = btrim(coalesce(p_id, '')) for update;
  if not found or public._iptvl_access(l, m.member_id) <> 'ok' then return jsonb_build_object('ok', false, 'reason', 'access'); end if;
  if l.owner_id = m.member_id then return jsonb_build_object('ok', false, 'reason', 'own'); end if;
  if public._iptvl_blocked(m.member_id) then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  select vote into prev from public.iptv_list_votes where list_id = l.list_id and member_id = m.member_id;
  if p_vote = 0 then
    delete from public.iptv_list_votes where list_id = l.list_id and member_id = m.member_id;
  else
    insert into public.iptv_list_votes (list_id, member_id, vote) values (l.list_id, m.member_id, p_vote)
    on conflict (list_id, member_id) do update set vote = excluded.vote, created_at = now();
  end if;
  update public.iptv_lists set
    likes = greatest(0, likes - (coalesce(prev, 0) = 1)::int + (p_vote = 1)::int),
    dislikes = greatest(0, dislikes - (coalesce(prev, 0) = -1)::int + (p_vote = -1)::int)
  where list_id = l.list_id returning * into l;
  return jsonb_build_object('ok', true, 'vote', p_vote, 'likes', l.likes, 'dislikes', l.dislikes);
end $$;

-- (round 31) A share button of the list page: once per viewer (member id, or a visitor's id kept in
-- the browser), network and 10 minutes, the publisher's own aside. -> { ok, logged }
create or replace function public.iptv_list_share(p_id text, p_viewer text, p_network text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.iptv_lists; v text := left(btrim(coalesce(p_viewer, '')), 120); net text := left(lower(btrim(coalesce(p_network, ''))), 20);
begin
  if v = '' then return jsonb_build_object('ok', false, 'reason', 'bad_request'); end if;
  select * into l from public.iptv_lists where list_id = btrim(coalesce(p_id, ''));
  if not found or public._iptvl_access(l, v) <> 'ok' then return jsonb_build_object('ok', false, 'reason', 'access'); end if;
  if l.owner_id = v then return jsonb_build_object('ok', true, 'logged', 0); end if;
  if exists (select 1 from public.iptv_list_shares s where s.list_id = l.list_id and s.viewer = v and s.network = net
                                                   and s.at > now() - interval '10 minutes') then
    return jsonb_build_object('ok', true, 'logged', 0);
  end if;
  insert into public.iptv_list_shares (list_id, viewer, network) values (l.list_id, v, net);
  update public.iptv_lists set shares = shares + 1 where list_id = l.list_id;
  return jsonb_build_object('ok', true, 'logged', 1);
end $$;

-- (round 31) One watched minute of a channel of the list (the channel player, once a minute of
-- moving picture). Members only, never the publisher; the clock of channel_minute()
-- (sql/channel_views.sql) is shared: one minute every 45 seconds at most.
-- -> { ok, counted } | { ok: false, reason: member | access | too_soon | bad_request }
create or replace function public.iptv_list_minute(p_member text, p_id text, p_channel text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members; l public.iptv_lists; k text := lower(regexp_replace(btrim(coalesce(p_channel, '')), '\s+', ' ', 'g'));
begin
  m := public._iptvl_viewer(p_member);
  if m.member_id is null or lower(coalesce(m.status, 'active')) <> 'active' then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if k = '' or char_length(k) > 200 then return jsonb_build_object('ok', false, 'reason', 'bad_request'); end if;
  select * into l from public.iptv_lists where list_id = btrim(coalesce(p_id, ''));
  if not found or public._iptvl_access(l, m.member_id) <> 'ok' then return jsonb_build_object('ok', false, 'reason', 'access'); end if;
  if l.owner_id = m.member_id then return jsonb_build_object('ok', true, 'counted', false); end if;
  if to_regclass('public.channel_minute_clock') is not null then
    insert into public.channel_minute_clock as c (viewer_id, counted_at) values (m.member_id, now())
    on conflict (viewer_id) do update set counted_at = excluded.counted_at
     where c.counted_at <= now() - interval '45 seconds';
    if not found then return jsonb_build_object('ok', false, 'reason', 'too_soon'); end if;
  end if;
  insert into public.iptv_list_minutes as x (list_id, ckey, day, minutes) values (l.list_id, k, current_date, 1)
  on conflict (list_id, ckey, day) do update set minutes = x.minutes + 1;
  update public.iptv_lists set watch_minutes = watch_minutes + 1 where list_id = l.list_id;
  return jsonb_build_object('ok', true, 'counted', true);
end $$;

-- The channels of the public lists, and of the exclusive lists whose criteria the member meets
-- (never a private list); Search.html now uses site_search (sql/search.sql). Every word must be in the name
-- of the channel or of its group. A channel listed in several groups of a list shows once.
--   p_kind  '' | live | movie | series
--   p_sort  relevance | az | za | lists (the most viewed lists first)
-- -> { total, items: [{ name, group, logo, kind, key, list: { id, name, owner, owner_id,
--      visibility, channels } }], sort } ; fewer than 2 letters: { total: 0, items: [], short: true }
create or replace function public.iptv_channel_search(
  p_member text default '', p_q text default '', p_kind text default '', p_sort text default '',
  p_limit int default 30, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  me text := btrim(coalesce(p_member, '')); q text := lower(btrim(coalesce(p_q, ''))); words text[];
  knd text := lower(coalesce(p_kind, '')); srt text := lower(coalesce(p_sort, ''));
  lim int := least(greatest(coalesce(p_limit, 30), 1), 60); off int := greatest(coalesce(p_offset, 0), 0);
  total int; items jsonb;
begin
  if char_length(q) < 2 then return jsonb_build_object('total', 0, 'items', '[]'::jsonb, 'short', true); end if;
  select coalesce(array_agg(x), '{}') into words from (
    select replace(replace(replace(x, '\', '\\'), '%', '\%'), '_', '\_') as x
    from regexp_split_to_table(q, '\s+') as x where x <> '' limit 8
  ) s;
  if knd not in ('live', 'movie', 'series') then knd := ''; end if;
  if srt not in ('relevance', 'az', 'za', 'lists') then srt := 'relevance'; end if;
  with lists as (
    select l.list_id, l.name, l.owner_id, l.owner_username, l.visibility, l.channel_count, l.views
    from public.iptv_lists l
    where l.visibility in ('public', 'exclusive') and l.indexed_at is not null
      and public._iptvl_access(l, me) = 'ok'
  ), hits as (
    select distinct on (c.list_id, lower(c.name), c.kind)
           c.list_id, c.pos, c.name, c.group_name, c.logo, c.kind, c.ckey,
           x.name as list_name, x.owner_id, x.owner_username, x.visibility, x.channel_count, x.views
    from public.iptv_list_channels c
    join lists x on x.list_id = c.list_id
    where (knd = '' or c.kind = knd)
      and (lower(c.name) like '%' || words[1] || '%' or lower(c.group_name) like '%' || words[1] || '%')
      and not exists (
        select 1 from unnest(words[2:]) as ww(w)
        where lower(c.name) not like '%' || ww.w || '%' and lower(c.group_name) not like '%' || ww.w || '%'
      )
    order by c.list_id, lower(c.name), c.kind, c.pos
  )
  select (select count(*) from hits),
         coalesce((select jsonb_agg(jsonb_build_object(
             'name', z.name, 'group', z.group_name, 'logo', z.logo, 'kind', z.kind, 'key', z.ckey, 'pos', z.pos,
             'list', jsonb_build_object('id', z.list_id, 'name', z.list_name, 'owner_id', z.owner_id,
               'owner', coalesce((select m.username from public.members m where m.member_id = z.owner_id), z.owner_username),
               'visibility', z.visibility, 'channels', z.channel_count))
             order by z.rn)
           from (
             select h.*, row_number() over (order by
               case when srt = 'relevance' then (case when lower(h.name) = q then 0
                                                       when lower(h.name) like replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%' then 1
                                                       when lower(h.name) like '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%' then 2
                                                       else 3 end) end,
               case when srt = 'az' then lower(h.name) end asc,
               case when srt = 'za' then lower(h.name) end desc,
               case when srt in ('relevance', 'lists') then h.views end desc,
               lower(h.name), h.list_id, h.pos) as rn
             from hits h
             order by rn
             offset off limit lim
           ) z), '[]'::jsonb)
    into total, items;
  return jsonb_build_object('total', total, 'items', items, 'sort', srt);
end $$;

-- ------------------------------------------------------------------ 5. uploads to Storage
-- The name of an uploaded playlist: Playlist/<member id>-<20 letters or digits>.m3u (or
-- .m3u8) in the bucket IPTV, for a member who is not banned.
create or replace function public.iptv_playlist_object_ok(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(p_bucket = 'IPTV', false)
     and coalesce(p_name ~ '^Playlist/ID[0-9]{1,20}-[A-Za-z0-9]{20}\.m3u8?$', false)
     and exists (
       select 1 from public.members m
       where m.member_id = substring(p_name from '^Playlist/(ID[0-9]{1,20})-')
         and lower(btrim(coalesce(m.status, ''))) not in ('banned', 'blocked') and coalesce(m.status, '') <> 'محظور'
     )
$$;

comment on function public.iptv_playlist_object_ok(text, text) is
  'Storage policy of the uploaded IPTV lists: true for IPTV / Playlist/<member id>-<random>.m3u of a member who is not banned';

revoke all on function public.iptv_playlist_object_ok(text, text) from public;
grant execute on function public.iptv_playlist_object_ok(text, text) to anon, authenticated, service_role;

-- an upload only: no listing (select), no replacing (update), no deleting
drop policy if exists "CineAura IPTV lists: upload" on storage.objects;
create policy "CineAura IPTV lists: upload" on storage.objects
  for insert to anon, authenticated
  with check (public.iptv_playlist_object_ok(bucket_id, name));

-- ------------------------------------------------------------------ 6. Panel > Content > IPTV lists (the team)
-- The Super Admin, or a staff member with the Content section. -> who did it
create or replace function public._iptvl_staff(p_token text) returns text
language plpgsql security definer set search_path = public as $$
declare s record;
begin
  s := public._staff(p_token);
  if s.role <> 'super' and position(',content,' in ',' || replace(coalesce(s.sections, ''), ' ', '') || ',') = 0 then
    raise exception 'staff_forbidden';
  end if;
  return coalesce(nullif(s.username, ''), s.role);
end $$;

-- Every list of the site, whoever may see it.
--   p_filter  all | public | exclusive | private | suspended
--   p_q       words of the name or the description, its id, the publisher (username or member id)
--   p_sort    new (last changed) | old | views | channels
--   -> { ok: true, total, counts: { all, public, exclusive, private, suspended }, items: [ card + url, path, … ] }
create or replace function public.iptv_lists_admin(p_token text, p_filter text default 'all', p_q text default '',
  p_sort text default 'new', p_limit int default 40, p_offset int default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  who text; q text := lower(btrim(coalesce(p_q, ''))); f text := coalesce(nullif(p_filter, ''), 'all');
  srt text := coalesce(nullif(p_sort, ''), 'new');
  lim int := least(greatest(coalesce(p_limit, 40), 1), 200); off int := greatest(coalesce(p_offset, 0), 0); res jsonb;
begin
  who := public._iptvl_staff(p_token);
  with base as (
    select l, coalesce(m.username, l.owner_username) as uname
      from public.iptv_lists l left join public.members m on m.member_id = l.owner_id
     where q = '' or strpos(lower(l.name) || ' ' || lower(l.description), q) > 0 or lower(l.list_id) = q
        or lower(l.owner_id) = q or lower(coalesce(m.username, l.owner_username)) = ltrim(q, '@')
  ), pick as (
    select * from base b
     where case f when 'suspended' then (b.l).suspended_at is not null
                  when 'public' then (b.l).visibility = 'public'
                  when 'exclusive' then (b.l).visibility = 'exclusive'
                  when 'private' then (b.l).visibility = 'private'
                  else true end
  )
  select jsonb_build_object('ok', true, 'total', (select count(*) from pick),
    'counts', jsonb_build_object(
      'all', (select count(*) from base),
      'public', (select count(*) from base b where (b.l).visibility = 'public'),
      'exclusive', (select count(*) from base b where (b.l).visibility = 'exclusive'),
      'private', (select count(*) from base b where (b.l).visibility = 'private'),
      'suspended', (select count(*) from base b where (b.l).suspended_at is not null)),
    'items', coalesce((select jsonb_agg(public._iptvl_card(z.l, '') || jsonb_build_object(
        'owner', z.uname, 'url', (z.l).m3u_url, 'path', (z.l).storage_path, 'epg_url', (z.l).epg_url,
        'suspended', case when (z.l).suspended_at is not null
                          then jsonb_build_object('reason', (z.l).suspended_reason, 'at', (z.l).suspended_at, 'by', (z.l).suspended_by) end)
        order by z.ord)
      from (select pk.*, row_number() over (order by case srt when 'views' then (pk.l).views
                                                              when 'channels' then (pk.l).channel_count end desc nulls last,
                                                     case when srt = 'old' then (pk.l).updated_at end asc,
                                                     (pk.l).updated_at desc, (pk.l).list_id) as ord
              from pick pk order by ord offset off limit lim) z), '[]'::jsonb))
    into res;
  return res;
end $$;

-- Suspend (p_reason 3 to 300 characters, which the publisher reads), restore or delete a list
-- (p_reason 3 to 300 characters, told to the publisher). The publisher is told each time.
--   -> { ok: true, status: suspended | active | deleted, path } | { ok: false, reason: action | reason | not_found | state }
create or replace function public.iptv_list_moderate(p_token text, p_id text, p_action text, p_reason text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  who text; l public.iptv_lists; why text := left(btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g')), 300);
  tell boolean := to_regclass('public.notifications') is not null;
begin
  who := public._iptvl_staff(p_token);
  if p_action not in ('suspend', 'restore', 'delete') then return jsonb_build_object('ok', false, 'reason', 'action'); end if;
  if p_action <> 'restore' and length(why) < 3 then return jsonb_build_object('ok', false, 'reason', 'reason'); end if;
  select * into l from public.iptv_lists where list_id = btrim(coalesce(p_id, '')) for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if p_action = 'suspend' then
    if l.suspended_at is not null then return jsonb_build_object('ok', false, 'reason', 'state'); end if;
    update public.iptv_lists set suspended_at = now(), suspended_reason = why, suspended_by = who where list_id = l.list_id;
    if tell then
      insert into public.notifications (member_id, kind, title, body, href)
      values (l.owner_id, 'iptv_list_suspended', 'The team suspended your IPTV list', left(l.name || ' · ' || why, 300), './dashboard.html#iptv-lists');
    end if;
    return jsonb_build_object('ok', true, 'status', 'suspended');
  elsif p_action = 'restore' then
    if l.suspended_at is null then return jsonb_build_object('ok', false, 'reason', 'state'); end if;
    update public.iptv_lists set suspended_at = null, suspended_reason = '', suspended_by = '' where list_id = l.list_id;
    if tell then
      insert into public.notifications (member_id, kind, title, body, href)
      values (l.owner_id, 'iptv_list_restored', 'The team restored your IPTV list', left(l.name, 300), './dashboard.html#iptv-lists');
    end if;
    return jsonb_build_object('ok', true, 'status', 'active');
  end if;
  delete from public.iptv_lists where list_id = l.list_id;
  if tell then
    insert into public.notifications (member_id, kind, title, body, href)
    values (l.owner_id, 'iptv_list_deleted', 'The team deleted your IPTV list', left(l.name || ' · ' || why, 300), './dashboard.html#iptv-lists');
  end if;
  -- an uploaded file stays in Storage (IPTV/Playlist/…), like the files of a list its publisher deletes
  return jsonb_build_object('ok', true, 'status', 'deleted', 'path', l.storage_path);
end $$;

-- ------------------------------------------------------------------ 7. who may call what
do $$
declare f text;
begin
  foreach f in array array[
    'public._iptvl_viewer(text)', 'public._iptvl_banned(text)', 'public._iptvl_blocked(text)',
    'public._iptvl_lang(text, text)', 'public._iptvl_access(public.iptv_lists, text)',
    'public._iptvl_card(public.iptv_lists, text)', 'public._iptvl_codes(jsonb, boolean)', 'public._iptvl_staff(text)',
    'public._iptvl_level(text)', 'public._iptvl_plan(public.members)', 'public._iptvl_plan_rank(text)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.iptv_list_save(text, jsonb)',
    'public.iptv_list_index(text, text, jsonb, int, boolean, jsonb, text, text)',
    'public.iptv_list_delete(text, text)', 'public.iptv_lists_mine(text)',
    'public.iptv_lists_search(text, text, text, text, int, int)',
    'public.iptv_list_open(text, text)',
    'public.iptv_channel_search(text, text, text, text, int, int)',
    'public.iptv_lists_admin(text, text, text, text, int, int)', 'public.iptv_list_moderate(text, text, text, text)',
    'public.iptv_list_unlock(text, text, text)', 'public.iptv_list_request(text, text, text)',
    'public.iptv_list_requests(text, text, int)', 'public.iptv_list_request_answer(text, bigint, text)',
    'public.iptv_list_vote(text, text, int)', 'public.iptv_list_share(text, text, text)',
    'public.iptv_list_minute(text, text, text)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
