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
--   * Search.html > Channels: the channels of the public lists, and of the exclusive
--     lists whose criteria the member meets.
--
-- Visibility
--   public     everyone, visitors included
--   exclusive  signed-in members only, who meet EVERY criterion the publisher ticked:
--              followers of the publisher, one of the countries, one of the languages
--              (the site language saved on the member's profile; when none is saved,
--              the language of their country)
--   private    only the members the publisher listed by username or member id; they
--              are told in the bell
--   The publisher always sees their own lists. Nothing of a banned publisher is shown.
--   Visitors (not signed in) never see an exclusive or a private list.
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

-- one view per member (or visitor address) and day
create table if not exists public.iptv_list_views (
  list_id text not null references public.iptv_lists (list_id) on delete cascade,
  viewer text not null,
  day date not null default current_date,
  primary key (list_id, viewer, day)
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
  foreach t in array array['iptv_lists', 'iptv_list_access', 'iptv_list_channels', 'iptv_list_views']
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

-- 'ok', or why the member may not see the list: gone | private | signin | followers |
-- country | language. The publisher always sees their own lists.
create or replace function public._iptvl_access(l public.iptv_lists, p_member text) returns text
language plpgsql stable security definer set search_path = public as $$
declare m public.members;
begin
  p_member := btrim(coalesce(p_member, ''));
  if p_member <> '' and l.owner_id = p_member then return 'ok'; end if;
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
  return 'ok';
end $$;

-- A list as a card (IPTV.html, the dashboard). Its address is never part of it.
create or replace function public._iptvl_card(l public.iptv_lists, p_member text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', l.list_id, 'name', l.name, 'description', left(l.description, 300),
    'visibility', l.visibility, 'followers', l.excl_followers,
    'countries', l.excl_countries, 'languages', l.excl_languages,
    'channels', l.channel_count, 'groups', l.group_count,
    'live', l.live_count, 'movies', l.movie_count, 'series', l.series_count,
    'views', l.views, 'source', l.source, 'epg', l.epg_url <> '',
    'created_at', l.created_at, 'updated_at', l.updated_at, 'ready', l.indexed_at is not null,
    'owner_id', l.owner_id,
    'owner', coalesce((select m.username from public.members m where m.member_id = l.owner_id), l.owner_username),
    'owner_avatar', coalesce((select p.avatar_url from public.profiles p where p.member_id = l.owner_id), ''),
    'mine', l.owner_id = btrim(coalesce(p_member, '')))
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
--      followers, countries, languages (exclusive), people[] (private: usernames or ids) }
-- -> { ok: true, id, created, notified }
--    { ok: false, reason: member | blocked | bad_request | not_found | limit | name |
--      description | source | url | path | file | visibility | criteria | people (+ bad[]) | busy }
create or replace function public.iptv_list_save(p_member text, d jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  m public.members; l public.iptv_lists; lid text := nullif(btrim(coalesce(d->>'id', '')), '');
  is_new boolean; nm text; descr text; src text; url text := ''; pth text := ''; epg text; vis text;
  fol boolean := false; ctys text[] := '{}'; langs text[] := '{}'; people text[] := '{}';
  bad text[] := '{}'; ids text[] := '{}'; names text[] := '{}'; fresh text[] := '{}';
  x text; mid text; uname text; i int := 0; n int := 0;
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

  if vis = 'exclusive' then
    fol := lower(coalesce(d->>'followers', '')) in ('true', '1', 'yes', 'on');
    select coalesce(array_agg(c), '{}') into ctys from unnest(public._iptvl_codes(d->'countries', true)) as c where c ~ '^[A-Z]{2}$';
    select coalesce(array_agg(c), '{}') into langs from unnest(public._iptvl_codes(d->'languages', false)) as c
      where c in ('en', 'ar', 'fr', 'de', 'es', 'nl', 'it');
    if coalesce(array_length(ctys, 1), 0) > 60 then return jsonb_build_object('ok', false, 'reason', 'criteria'); end if;
    if not fol and coalesce(array_length(ctys, 1), 0) = 0 and coalesce(array_length(langs, 1), 0) = 0 then
      return jsonb_build_object('ok', false, 'reason', 'criteria');
    end if;
  end if;

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

  -- a private list: the members listed now (the others lose it); the new ones are told
  select coalesce(array_agg(v), '{}') into fresh from unnest(ids) as v
  where not exists (select 1 from public.iptv_list_access a where a.list_id = lid and a.member_id = v);
  delete from public.iptv_list_access a where a.list_id = lid and not (a.member_id = any (ids));
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
-- IPTV.html: the lists the visitor may see.
--   p_q       words found in the name, the description or the publisher's username
--   p_sort    relevance | date (last changed) | views | channels | az | za
--   p_filter  '' (all) | public | exclusive | private | mine
-- A list whose channels were never read shows to its publisher only.
-- -> { total, items: [cards], sort }
create or replace function public.iptv_lists_search(
  p_member text default '', p_q text default '', p_sort text default '', p_filter text default '',
  p_limit int default 24, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  me text := btrim(coalesce(p_member, '')); q text := btrim(coalesce(p_q, '')); words text[];
  srt text := lower(coalesce(p_sort, '')); flt text := lower(coalesce(p_filter, ''));
  lim int := least(greatest(coalesce(p_limit, 24), 1), 60); off int := greatest(coalesce(p_offset, 0), 0);
  total int; items jsonb;
begin
  select coalesce(array_agg(x), '{}') into words from (
    select replace(replace(replace(lower(x), '\', '\\'), '%', '\%'), '_', '\_') as x
    from regexp_split_to_table(q, '\s+') as x where x <> '' limit 8
  ) s;
  if srt not in ('relevance', 'date', 'views', 'channels', 'az', 'za') then srt := case when q = '' then 'date' else 'relevance' end; end if;
  if flt not in ('', 'public', 'exclusive', 'private', 'mine') then flt := ''; end if;
  with base as (
    select l as r
    from public.iptv_lists l
    where (flt = '' or (flt = 'mine' and me <> '' and l.owner_id = me) or l.visibility = flt)
      and (l.indexed_at is not null or (me <> '' and l.owner_id = me))
      and not exists (
        select 1 from unnest(words) as ww(x)
        where (lower(l.name) || ' ' || lower(l.description) || ' ' || lower(l.owner_username)) not like '%' || ww.x || '%'
      )
  ), seen as (
    select b.r from base b where public._iptvl_access(b.r, me) = 'ok'
  )
  select (select count(*) from seen),
         coalesce((select jsonb_agg(public._iptvl_card(z.r, me) order by z.rn) from (
           select s.r, row_number() over (order by
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
--    { ok: false, reason: not_found | private | signin }
--    { ok: false, reason: followers | country | language, owner, owner_id, followers, countries, languages }
create or replace function public.iptv_list_open(p_id text, p_member text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare l public.iptv_lists; me text := btrim(coalesce(p_member, '')); why text; who text; hdr json; ip text := '';
begin
  select * into l from public.iptv_lists where list_id = btrim(coalesce(p_id, ''));
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  why := public._iptvl_access(l, me);
  if why = 'gone' then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if why in ('private', 'signin') then return jsonb_build_object('ok', false, 'reason', why); end if;
  if why <> 'ok' then
    return jsonb_build_object('ok', false, 'reason', why, 'owner_id', l.owner_id,
      'owner', coalesce((select m.username from public.members m where m.member_id = l.owner_id), l.owner_username),
      'followers', l.excl_followers, 'countries', l.excl_countries, 'languages', l.excl_languages);
  end if;
  if l.owner_id <> me then
    if (public._iptvl_viewer(me)).member_id is not null then
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

-- Search.html > Channels: the channels of the public lists, and of the exclusive lists
-- whose criteria the member meets (never a private list). Every word must be in the name
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

-- ------------------------------------------------------------------ 6. who may call what
do $$
declare f text;
begin
  foreach f in array array[
    'public._iptvl_viewer(text)', 'public._iptvl_banned(text)', 'public._iptvl_blocked(text)',
    'public._iptvl_lang(text, text)', 'public._iptvl_access(public.iptv_lists, text)',
    'public._iptvl_card(public.iptv_lists, text)', 'public._iptvl_codes(jsonb, boolean)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.iptv_list_save(text, jsonb)',
    'public.iptv_list_index(text, text, jsonb, int, boolean, jsonb, text, text)',
    'public.iptv_list_delete(text, text)', 'public.iptv_lists_mine(text)',
    'public.iptv_lists_search(text, text, text, text, int, int)',
    'public.iptv_list_open(text, text)',
    'public.iptv_channel_search(text, text, text, text, int, int)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
