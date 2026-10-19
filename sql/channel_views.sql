-- ============================================================
-- Most watched channels: the row of channel cards in the IPTV section of the
-- home page ("Most watched channels").
-- Run in the Supabase SQL editor after dashboard.sql (tables iptv and
-- listchannels) and members.sql. Safe to run more than once.
--
-- channel_views keeps one row per member, channel and day: a member who watches
-- the same channel ten times in a day counts once. The channel player writes it
-- (after 15 seconds of picture on a live channel) through channel_view_add(),
-- which checks that the member exists and may watch that channel. Nobody reads
-- the rows with the public key: channel_top() gives only the totals, so what a
-- member watches stays private.
--
-- A channel is known by its name (lower case, single spaces): the same channel
-- in several groups or packages counts as one. It is "free" when one of its
-- packages has a free account in Panel > IPTV, and "premium" when only premium
-- accounts carry it. Packages that are not registered in Panel > IPTV are left
-- out.
-- ============================================================

-- "  beIN SPORTS  1 " -> "bein sports 1"
create or replace function public.channel_key(p_name text)
returns text language sql immutable parallel safe as $$
  select lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'))
$$;

create table if not exists public.channel_views (
  id bigint generated always as identity primary key,
  channel_key text not null,
  package_name text not null default '',
  channel_name text not null default '',
  viewer_id text not null,
  viewed_on date not null default current_date,
  viewed_at timestamptz not null default now()
);

comment on table public.channel_views is
  'Live channels watched by members: one row per member, channel and day (home page > Most watched channels)';
comment on column public.channel_views.channel_key is 'public.channel_key(channel name): the channel in every package and group';

create unique index if not exists channel_views_once_a_day on public.channel_views (viewer_id, channel_key, viewed_on);
create index if not exists channel_views_day_idx on public.channel_views (viewed_on, channel_key);
-- finds every row of a channel, whatever its package or group
create index if not exists listchannels_key_idx on public.listchannels (public.channel_key(channel_name));

-- private: only the two functions below touch the rows
alter table public.channel_views enable row level security;
do $$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'channel_views' loop
    execute format('drop policy %I on public.channel_views', pol.policyname);
  end loop;
end $$;
revoke all on public.channel_views from anon, authenticated;

-- The channel player: p_member has watched p_channel of p_package for a while.
-- Counted once per member, channel and day. Returns {ok, counted} or
-- {ok: false, error: bad_request | unknown_member | unknown_channel | no_access}.
create or replace function public.channel_view_add(p_member text, p_package text, p_channel text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  mid text;
  uname text;
  k text := public.channel_key(p_channel);
  counted boolean;
begin
  if btrim(coalesce(p_member, '')) = '' or k = '' or coalesce(p_package, '') = ''
     or length(p_channel) > 200 or length(p_package) > 200 then
    return jsonb_build_object('ok', false, 'error', 'bad_request');
  end if;
  select m.member_id, m.username into mid, uname
  from public.members m
  where m.member_id = btrim(p_member) and coalesce(m.status, 'active') = 'active';
  if mid is null then
    return jsonb_build_object('ok', false, 'error', 'unknown_member');
  end if;
  if not exists (
    select 1 from public.listchannels l
    where l.package_name = p_package and l.channel_name = p_channel
      and lower(coalesce(l.channel_type, 'live')) not in ('movie', 'series')
  ) then
    return jsonb_build_object('ok', false, 'error', 'unknown_channel');
  end if;
  -- the same rule as the channel list: a free account of the package, or a
  -- premium one given to this member (owner_id = member id, or the username)
  if not exists (
    select 1 from public.iptv i
    where i.name = p_package
      and (lower(btrim(coalesce(i.type, ''))) = 'free'
           or ltrim(lower(btrim(coalesce(i.owner_id, ''))), '@') in (lower(mid), lower(coalesce(uname, ''))))
  ) then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;
  insert into public.channel_views (channel_key, package_name, channel_name, viewer_id)
  values (k, p_package, p_channel, mid)
  on conflict (viewer_id, channel_key, viewed_on) do nothing;
  counted := found;
  if counted and random() < 0.02 then
    delete from public.channel_views where viewed_on < current_date - 400; -- the ranking looks back a year at most
  end if;
  return jsonb_build_object('ok', true, 'counted', counted);
end $$;

-- The home page row: the p_limit (1-50) channels watched most over the last
-- p_days (1-365) days, then - while fewer have been watched - channels with a
-- logo from the free and premium packages, in turn. One entry per channel:
--   key, id, name, group, logo, package   the row to show (a free one when
--                                         there is one: the card opens it on
--                                         Listchannels.html?free=1&channel=id)
--   free     true when a free package carries it (a premium card leads to
--            Dashboard > IPTV instead)
--   views    member-days in the period (0 for the filling)
create or replace function public.channel_top(p_limit integer default 20, p_days integer default 30)
returns jsonb language sql stable security definer set search_path = public as $$
  with
  lim as (
    select greatest(1, least(coalesce(p_limit, 20), 50)) as n,
           greatest(1, least(coalesce(p_days, 30), 365)) as d
  ),
  packs as (
    select i.name, bool_or(lower(btrim(coalesce(i.type, ''))) = 'free') as free
    from public.iptv i
    where coalesce(i.name, '') <> ''
    group by i.name
  ),
  -- the most watched names of the period (a few spare ones, in case a channel
  -- has left every package since)
  watched as (
    select v.channel_key as k, count(*)::int as views, max(v.viewed_at) as last_at
    from public.channel_views v
    where v.viewed_on > current_date - (select d from lim)
    group by v.channel_key
    order by 2 desc, 3 desc, 1
    limit (select n * 4 from lim)
  ),
  top as (
    select w.*
    from watched w
    where exists (
      select 1 from public.listchannels l join packs p on p.name = l.package_name
      where public.channel_key(l.channel_name) = w.k
        and lower(coalesce(l.channel_type, 'live')) not in ('movie', 'series')
    )
    order by w.views desc, w.last_at desc, w.k
    limit (select n from lim)
  ),
  -- the first channels of the packages, in playlist order: with a logo, and any
  cand as (
    select c.id, c.logo, c.free, public.channel_key(c.channel_name) as k
    from (
      (select l.id, l.channel_name, true as logo, true as free
       from public.listchannels l
       where l.package_name = any (array(select name from packs where free)) and coalesce(l.logo_url, '') <> ''
         and lower(coalesce(l.channel_type, 'live')) not in ('movie', 'series')
       order by l.id limit 150)
      union all
      (select l.id, l.channel_name, coalesce(l.logo_url, '') <> '', true
       from public.listchannels l
       where l.package_name = any (array(select name from packs where free))
         and lower(coalesce(l.channel_type, 'live')) not in ('movie', 'series')
       order by l.id limit 150)
      union all
      (select l.id, l.channel_name, true, false
       from public.listchannels l
       where l.package_name = any (array(select name from packs where not free)) and coalesce(l.logo_url, '') <> ''
         and lower(coalesce(l.channel_type, 'live')) not in ('movie', 'series')
       order by l.id limit 150)
      union all
      (select l.id, l.channel_name, coalesce(l.logo_url, '') <> '', false
       from public.listchannels l
       where l.package_name = any (array(select name from packs where not free))
         and lower(coalesce(l.channel_type, 'live')) not in ('movie', 'series')
       order by l.id limit 150)
    ) c
    where (select count(*) from top) < (select n from lim)
  ),
  fill as (
    select u.k, row_number() over (partition by u.free order by u.logo desc, u.id) as rn, u.free
    from (
      select distinct on (k) * from cand
      where k <> '' and k not in (select k from top)
      order by k, free desc, logo desc, id
    ) u
  ),
  picked as (
    select k, views, row_number() over (order by views desc, last_at desc, k) as pos
    from top
    union all
    select k, 0, (select count(*) from top) + row_number() over (order by rn, free desc)
    from fill
  ),
  rows as (
    select pk.k, pk.pos, pk.views, l.id, l.package_name, l.channel_name, l.group_name,
           coalesce(l.logo_url, '') as logo_url, p.free
    from picked pk
    join public.listchannels l on public.channel_key(l.channel_name) = pk.k
    join packs p on p.name = l.package_name
    where pk.pos <= (select n from lim)
      and lower(coalesce(l.channel_type, 'live')) not in ('movie', 'series')
  ),
  items as (
    select r.pos, jsonb_build_object(
      'key', r.k,
      'id', (array_agg(r.id order by r.free desc, (r.logo_url <> '') desc, r.id))[1],
      'name', (array_agg(r.channel_name order by r.free desc, (r.logo_url <> '') desc, r.id))[1],
      'group', (array_agg(coalesce(r.group_name, '') order by r.free desc, (r.logo_url <> '') desc, r.id))[1],
      'package', (array_agg(r.package_name order by r.free desc, (r.logo_url <> '') desc, r.id))[1],
      'logo', (array_agg(r.logo_url order by (r.logo_url <> '') desc, r.free desc, r.id))[1],
      'free', bool_or(r.free),
      'views', r.views
    ) as item
    from rows r
    group by r.k, r.pos, r.views
  )
  select coalesce(jsonb_agg(item order by pos), '[]'::jsonb) from items
$$;

-- ------------------------------------------------------------------ (round 31) watched minutes
-- The ranking points of Search.html > Channels count the minutes members watch a channel. The
-- channel player calls channel_minute() once a minute of moving picture on CineAura's own lists
-- (the free and the premium list, the packages of Panel > IPTV), and iptv_list_minute()
-- (sql/iptv_lists.sql) on a list a member published. One clock per member for both: one minute
-- every 45 seconds at most, so two players open at once still count one minute at a time.
create table if not exists public.channel_minutes (
  channel_key text not null,
  day date not null default current_date,
  minutes integer not null default 0,
  primary key (channel_key, day)
);
comment on table public.channel_minutes is 'Minutes members watched each channel of CineAura''s own lists, per day (Search.html ranking points)';

create table if not exists public.channel_minute_clock (
  viewer_id text primary key,
  counted_at timestamptz not null default now()
);

alter table public.channel_minutes enable row level security;
alter table public.channel_minute_clock enable row level security;
revoke all on public.channel_minutes from anon, authenticated;
revoke all on public.channel_minute_clock from anon, authenticated;

-- One watched minute of p_channel (its name) for an active member.
-- -> { ok: true, counted: true } | { ok: false, error: bad_request | unknown_member | too_soon }
create or replace function public.channel_minute(p_member text, p_channel text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare mid text; k text := public.channel_key(p_channel);
begin
  if btrim(coalesce(p_member, '')) = '' or k = '' or length(p_channel) > 200 then
    return jsonb_build_object('ok', false, 'error', 'bad_request');
  end if;
  select m.member_id into mid from public.members m
   where m.member_id = btrim(p_member) and coalesce(m.status, 'active') = 'active';
  if mid is null then return jsonb_build_object('ok', false, 'error', 'unknown_member'); end if;
  insert into public.channel_minute_clock as c (viewer_id, counted_at) values (mid, now())
  on conflict (viewer_id) do update set counted_at = excluded.counted_at
   where c.counted_at <= now() - interval '45 seconds';
  if not found then return jsonb_build_object('ok', false, 'error', 'too_soon'); end if;
  insert into public.channel_minutes as x (channel_key, day, minutes) values (k, current_date, 1)
  on conflict (channel_key, day) do update set minutes = x.minutes + 1;
  return jsonb_build_object('ok', true, 'counted', true);
end $$;

-- The numbers of the ranking points of CineAura's channels (Search.html > Channels): for each
-- channel name (3 000 at most), the minutes watched and the valid reports (a report of the
-- channel the team marked resolved in Panel > Reports > Channels).
--   -> { "<channel key>": { minutes, reports }, … } (only the channels with a number)
create or replace function public.channel_ranks(p_names text[])
returns jsonb language sql stable security definer set search_path = public as $$
  with keys as (
    select distinct public.channel_key(n) as k from unnest(coalesce(p_names[1:3000], '{}')) as n
    where public.channel_key(n) <> ''
  ), mins as (
    select x.channel_key as k, sum(x.minutes)::bigint as minutes
      from public.channel_minutes x join keys on keys.k = x.channel_key group by x.channel_key
  ), reps as (
    select public.channel_key(r.channel_name) as k, count(*)::bigint as reports
      from public.channel_reports r
     where r.status = 'resolved' and public.channel_key(r.channel_name) in (select k from keys)
     group by 1
  )
  select coalesce(jsonb_object_agg(keys.k, jsonb_build_object('minutes', coalesce(mins.minutes, 0), 'reports', coalesce(reps.reports, 0))), '{}'::jsonb)
  from keys left join mins on mins.k = keys.k left join reps on reps.k = keys.k
  where mins.k is not null or reps.k is not null
$$;

revoke all on function public.channel_view_add(text, text, text) from public, anon, authenticated;
grant execute on function public.channel_view_add(text, text, text) to anon, authenticated;
revoke all on function public.channel_top(integer, integer) from public, anon, authenticated;
grant execute on function public.channel_top(integer, integer) to anon, authenticated;
revoke all on function public.channel_minute(text, text) from public, anon, authenticated;
grant execute on function public.channel_minute(text, text) to anon, authenticated;
revoke all on function public.channel_ranks(text[]) from public, anon, authenticated;
grant execute on function public.channel_ranks(text[]) to anon, authenticated;

notify pgrst, 'reload schema';
