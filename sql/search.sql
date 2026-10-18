-- ============================================================
-- Search.html: one search for the whole site, in tabs, ranked by "ranking points"
-- Run in the Supabase SQL editor AFTER content.sql, iptv_lists.sql, channel_views.sql,
-- market.sql and withdrawals.sql, and BEFORE panel_admin.sql (safe to run more than once).
--
-- The tabs and what each one finds (site_search):
--   videos    video     the members' videos (sql/content.sql)
--             playlist  their playlists of videos
--             rec       recommendations of a video (posts that hold one, see below)
--             review    reviews of a video
--   movies    rec, review, playlist (the members' playlists of movies); the films themselves
--             come from TMDB in the browser, ranked by their TMDB rating (trending without words)
--   series    rec, review, playlist (of series); the series from TMDB, the same way
--   channels  free      the channels of the free packages of Panel > IPTV (the browser adds the
--                       free list IPTV-Free.m3u)
--             site      CineAura's lists: the free packages (the browser adds the free and the
--                       premium list)
--             member    the channels of the members' public and exclusive lists (an exclusive
--                       one shows with its lock: it opens for the members who meet its criteria
--                       and type one of its passwords when it has some)
--             list      the members' lists: public, exclusive (with the lock), private (with a
--                       "Request to join" button, never its channels) unless the publisher kept
--                       it out of the search
--   profiles  profile   members
--             post      their posts (playlists, IPTV accounts, reviews)
--             rec       their recommendations
--   market    product, category, rec (purchase recommendations), review, list (purchase lists)
--   prizes    prize, challenge, lottery, group
-- Nobody finds what they may not see: the rules of each page apply (private, exclusive,
-- suspended, banned members, age ratings, blocks).
--
-- When (the date it was added, in the visitor's time zone, p_opts.tz):
--   '' (all time) | today | yesterday | week (since Monday) | month | year
-- Sort: rank (the default: ranking points) | new | old | az | za
--
-- Ranking points (every result carries them, with what they count):
--   videos, playlists, channels, IPTV lists (and the recommendations, reviews and posts, which
--   have the same numbers):
--     + 60 a watched minute          - 60 a valid report
--     + 30 a recommendation or a re-recommendation
--     - 30 a "don't recommend" (or again)
--     +  1 a comment                 +  1 a share of its link outside the site
--     A video: its watched minutes, its recommend / don't recommend, the recommendation posts that
--     hold it (each one a recommendation, their recommend / don't the re-recommendations),
--     comments, shares and the reports the team found valid. A playlist: the numbers of the videos
--     it holds and its own valid reports. A playlist of movies or series: the minutes watched
--     from it, the recommend / don't, comments and shares of its posts. A channel of CineAura:
--     its watched minutes and its valid reports (Panel > Reports > Channels: resolved). An IPTV
--     list: the minutes watched of its channels, its recommend / don't, the shares of its link,
--     its valid reports; one of its channels: its own minutes with the numbers of its list.
--   profiles: + 30 a follower
--   products: + 60 a piece sold, + 30 a recommendation (again too), + 30 a good point and - 30 a
--     bad point of its reviews, + 1 a review, + 1 a sale through a share link, - 60 a valid report
--   categories: + 60 a piece sold of their products, + 1 a product
--   purchase recommendations: + 30 each time recommended again; purchase lists: + 30 each time
--     recommended again, + 1 a product; market reviews: + 60 a received purchase, + 1 a point written
--   prizes: + 30 a participant, + 1 a visit; challenges and lotteries: + 30 a participant of that
--     mode; prize groups: + 30 a participant of their prizes, + 1 a prize
--
-- Reports (content_reports): the Report button of a video, a playlist, an IPTV list and a post
-- (content_report). Panel > Reports > Content: the team marks a report valid (it then counts
-- against the ranking points) or dismisses it (content_reports_admin, content_reports_set).
--
-- Posts can hold members' videos (post_items.media_type = 'video', content_id = CT…): the
-- recommendations and reviews of a video (Content.html > Recommend / Write a review).
--
-- Like the rest of the site (no Supabase Auth), the functions trust the member id the browser sends.
-- ============================================================

-- ------------------------------------------------------------------ 1. posts that hold a video
alter table public.post_items add column if not exists content_id text not null default '';
create index if not exists post_items_content_idx on public.post_items (content_id) where content_id <> '';
create index if not exists post_items_post_idx on public.post_items (post_id);
create index if not exists post_votes_post_idx on public.post_votes (post_id);
create index if not exists post_comments_post_idx on public.post_comments (post_id);
comment on column public.post_items.content_id is 'A member''s video (CT…) when media_type = video (tmdb_id 0)';

-- ------------------------------------------------------------------ 2. reports
create table if not exists public.content_reports (
  id bigint generated always as identity primary key,
  kind text not null,                                 -- video | playlist | iptv_list | post
  target_id text not null,                            -- CT… | CPL… / IDP… | IPL… | P…
  owner_id text not null default '',                  -- who published it
  reporter_id text not null,
  reporter_name text not null default '',
  reason text not null default 'other',
  note text not null default '',
  status text not null default 'open',                -- open | valid | dismissed
  handled_by text not null default '',
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  constraint content_reports_kind check (kind in ('video', 'playlist', 'iptv_list', 'post')),
  constraint content_reports_reason check (reason in ('spam', 'misleading', 'offensive', 'violent', 'copyright', 'broken', 'other')),
  constraint content_reports_status check (status in ('open', 'valid', 'dismissed')),
  constraint content_reports_note check (char_length(note) <= 500)
);
create index if not exists content_reports_target_idx on public.content_reports (kind, target_id, status);
create index if not exists content_reports_status_idx on public.content_reports (status, created_at desc);
create index if not exists content_reports_reporter_idx on public.content_reports (reporter_id, created_at desc);
-- one open report per member and item
create unique index if not exists content_reports_one_open on public.content_reports (reporter_id, kind, target_id) where status = 'open';
comment on table public.content_reports is 'Reports on videos, playlists, IPTV lists and posts (Panel > Reports > Content). A valid one costs 60 ranking points.';

alter table public.content_reports enable row level security;
do $$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'content_reports' loop
    execute format('drop policy %I on public.content_reports', pol.policyname);
  end loop;
end $$;
revoke all on public.content_reports from anon, authenticated;

-- ------------------------------------------------------------------ 3. helpers
-- The ranking points of the videos, playlists, channels and IPTV lists.
create or replace function public._srch_pts(p_min bigint, p_rep bigint, p_rec bigint, p_rerec bigint,
                                            p_unrec bigint, p_reunrec bigint, p_com bigint, p_sh bigint)
returns bigint language sql immutable as $$
  select 60 * coalesce(p_min, 0) - 60 * coalesce(p_rep, 0)
       + 30 * (coalesce(p_rec, 0) + coalesce(p_rerec, 0)) - 30 * (coalesce(p_unrec, 0) + coalesce(p_reunrec, 0))
       + coalesce(p_com, 0) + coalesce(p_sh, 0)
$$;

-- ... and what they count, for the result card
create or replace function public._srch_rank(p_min bigint, p_rep bigint, p_rec bigint, p_rerec bigint,
                                             p_unrec bigint, p_reunrec bigint, p_com bigint, p_sh bigint)
returns jsonb language sql immutable as $$
  select jsonb_build_object('points', public._srch_pts(p_min, p_rep, p_rec, p_rerec, p_unrec, p_reunrec, p_com, p_sh),
    'minutes', coalesce(p_min, 0), 'reports', coalesce(p_rep, 0), 'recs', coalesce(p_rec, 0), 'rerecs', coalesce(p_rerec, 0),
    'unrecs', coalesce(p_unrec, 0), 'reunrecs', coalesce(p_reunrec, 0), 'comments', coalesce(p_com, 0), 'shares', coalesce(p_sh, 0))
$$;

-- "the  Big   buck" -> {the, big, buck}: lower case, ready for LIKE (8 words at most)
create or replace function public._srch_words(p_q text) returns text[]
language sql immutable as $$
  select coalesce(array_agg(x), '{}') from (
    select replace(replace(replace(lower(x), '\', '\\'), '%', '\%'), '_', '\_') as x
    from regexp_split_to_table(left(btrim(coalesce(p_q, '')), 200), '\s+') as x where x <> '' limit 8
  ) s
$$;

-- every word somewhere in the text (already lower case)
create or replace function public._srch_match(p_hay text, p_words text[]) returns boolean
language sql immutable as $$
  select not exists (select 1 from unnest(coalesce(p_words, '{}')) as w where coalesce(p_hay, '') not like '%' || w || '%')
$$;

-- The period of "When", in the visitor's time zone (UTC when it is not a known zone).
create or replace function public._srch_since(p_when text, p_tz text, out t0 timestamptz, out t1 timestamptz)
language plpgsql stable as $$
declare tz text := 'UTC'; today timestamptz;
begin
  if coalesce(p_tz, '') ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$' then
    begin
      perform now() at time zone p_tz;
      tz := p_tz;
    exception when others then tz := 'UTC';
    end;
  end if;
  today := date_trunc('day', now() at time zone tz) at time zone tz;
  t0 := case p_when
          when 'today' then today
          when 'yesterday' then today - interval '1 day'
          when 'week' then date_trunc('week', now() at time zone tz) at time zone tz
          when 'month' then date_trunc('month', now() at time zone tz) at time zone tz
          when 'year' then date_trunc('year', now() at time zone tz) at time zone tz
        end;
  t1 := case when p_when = 'yesterday' then today end;
end $$;

create or replace function public._srch_in(p_at timestamptz, p_t0 timestamptz, p_t1 timestamptz) returns boolean
language sql immutable as $$
  select (p_t0 is null or p_at >= p_t0) and (p_t1 is null or p_at < p_t1)
$$;

-- TMDB ids written in a post's "watched titles" (numbers, or themoviedb.org links)
create or replace function public._srch_tmdb_ids(p text) returns int[]
language sql immutable as $$
  select coalesce(array_agg(distinct v::int), '{}') from (
    select coalesce(substring(x from 'themoviedb\.org/(?:movie|tv|person)/([0-9]{1,9})'),
                    substring(x from '^\s*([0-9]{1,9})\s*$')) as v
    from regexp_split_to_table(coalesce(p, ''), '[\n,;]+') as x
  ) s where v is not null
$$;

-- May the viewer see this post? The rules of the profile wall (js/profile.js): public; private
-- for the usernames it was given to; exclusive for signed-in members (followers only, ages,
-- languages, countries, titles they watched). Never when its author blocked them fully.
create or replace function public._srch_post_sees(p public.posts, p_viewer text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare m public.members; yrs int; langs text[]; ctys text[]; mylang text; need int[];
begin
  p_viewer := btrim(coalesce(p_viewer, ''));
  if p_viewer <> '' and p.owner_id = p_viewer then return true; end if;
  if exists (select 1 from public.members o where o.member_id = p.owner_id and lower(coalesce(o.status, '')) = 'banned') then
    return false;
  end if;
  if p_viewer <> '' and exists (select 1 from public.blocks b where b.blocker_id = p.owner_id and b.blocked_id = p_viewer and b.kind = 'full') then
    return false;
  end if;
  if coalesce(p.visibility, 'public') = 'public' then return true; end if;
  m := public._content_viewer(p_viewer);
  if m.member_id is null then return false; end if;
  if p.visibility = 'private' then
    return exists (select 1 from public.post_access a
                    where a.post_id = p.post_id and lower(btrim(a.username)) in (lower(m.username), lower(m.member_id)));
  end if;
  if coalesce(p.require_followers, false) and not exists (
    select 1 from public.follows f where f.follower_id = m.member_id and f.following_id = p.owner_id and f.status = 'accepted') then
    return false;
  end if;
  if m.birth_date is not null then
    yrs := extract(year from age(current_date, m.birth_date))::int;
    if coalesce(p.min_age, 0) > 0 and yrs < p.min_age then return false; end if;
    if coalesce(p.max_age, 0) > 0 and yrs > p.max_age then return false; end if;
  end if;
  select coalesce(array_agg(lower(btrim(x))), '{}') into langs
    from regexp_split_to_table(coalesce(p.languages, ''), '[,;]+') as x where btrim(x) <> '';
  if coalesce(array_length(langs, 1), 0) > 0 and not ('all' = any (langs)) then
    select lower(btrim(coalesce(pr.language, ''))) into mylang from public.profiles pr where pr.member_id = m.member_id;
    if coalesce(mylang, '') <> '' and not (mylang = any (langs)) then return false; end if;
  end if;
  select coalesce(array_agg(lower(btrim(x))), '{}') into ctys
    from regexp_split_to_table(coalesce(p.countries, ''), '[,;]+') as x where btrim(x) <> '';
  if coalesce(array_length(ctys, 1), 0) > 0 and not (lower(coalesce(m.country, '')) = any (ctys)) then return false; end if;
  need := public._srch_tmdb_ids(p.watched_tmdb) || public._srch_tmdb_ids(p.titles);
  if coalesce(array_length(need, 1), 0) > 0 and exists (
    select 1 from unnest(need) as n(id)
    where not exists (select 1 from public.views w where w.viewer_id = m.member_id and w.tmdb_id = n.id)
      and not exists (select 1 from public.hestory h where h.visitor_id = m.member_id and h.tmdb_id = n.id)) then
    return false;
  end if;
  return true;
end $$;

-- May the viewer see this playlist of movies / series? The rules of Playlist.html.
create or replace function public._srch_mpl_sees(pl public.playlists, p_viewer text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare m public.members; vis text := lower(coalesce(pl.visibility, 'private')); ctys text[]; yrs int;
begin
  p_viewer := btrim(coalesce(p_viewer, ''));
  if p_viewer <> '' and pl.owner_id = p_viewer then return true; end if;
  if exists (select 1 from public.members o where o.member_id = pl.owner_id and lower(coalesce(o.status, '')) = 'banned') then
    return false;
  end if;
  if p_viewer <> '' and exists (select 1 from public.blocks b where b.blocker_id = pl.owner_id and b.blocked_id = p_viewer
                                  and (b.kind = 'full' or 'playlists' = any (string_to_array(replace(coalesce(b.features, ''), ' ', ''), ',')))) then
    return false;
  end if;
  if vis = 'public' then return true; end if;
  m := public._content_viewer(p_viewer);
  if m.member_id is null then return false; end if;
  if vis = 'private' then
    return exists (select 1 from public.playlist_access a
                    where a.playlist_id = pl.playlist_id and lower(btrim(a.username)) in (lower(m.username), lower(m.member_id)));
  end if;
  if vis <> 'exclusive' then return false; end if;
  select coalesce(array_agg(lower(btrim(x))), '{}') into ctys
    from regexp_split_to_table(coalesce(pl.countries, ''), '[,;]+') as x where btrim(x) <> '';
  if coalesce(array_length(ctys, 1), 0) > 0 and not (lower(coalesce(m.country, '')) = any (ctys)) then return false; end if;
  if coalesce(pl.gender, 'any') not in ('', 'any') and coalesce(m.gender, '') <> pl.gender then return false; end if;
  if coalesce(pl.max_age, 0) > 0 and m.birth_date is not null then
    yrs := extract(year from current_date)::int - extract(year from m.birth_date)::int;
    if yrs > pl.max_age then return false; end if;
  end if;
  return true;
end $$;

-- ------------------------------------------------------------------ 4. what each tab finds
-- Every finder returns (id, at, title, pts, rank, why): the id of the result, when it was added,
-- its name (A to Z), its ranking points, what they count, and 'ok' or its lock.

-- videos > video
create or replace function public._srch_video(p_viewer text, p_words text[], p_t0 timestamptz, p_t1 timestamptz, p_opts jsonb)
returns table (id text, at timestamptz, title text, pts bigint, rank jsonb, why text)
language sql stable security definer set search_path = public as $$
  with cand as (
    select c, public._content_access(c, p_viewer) as why
      from public.content c
     where c.publish_at <= now() and public._srch_in(c.publish_at, p_t0, p_t1)
       and (coalesce(p_opts->>'lang', '') = '' or c.language = p_opts->>'lang')
       and (coalesce(p_opts->>'region', '') = '' or c.country = upper(p_opts->>'region'))
       and (coalesce(p_opts->>'age', '') = '' or c.age_rating::text = p_opts->>'age')
       and (coalesce(p_opts->>'owner', '') = '' or lower(c.owner_username) = lower(ltrim(btrim(p_opts->>'owner'), '@')))
       and (coalesce(p_opts->>'tag', '') = '' or lower(ltrim(btrim(p_opts->>'tag'), '#')) = any (c.tags))
       and public._srch_match(lower(c.title || ' ' || c.description || ' ' || array_to_string(c.tags, ' ') || ' ' || c.owner_username), p_words)
  ), seen as (
    select * from cand where why not in ('private', 'scheduled', 'gone', 'age')
  )
  select (s.c).content_id, (s.c).publish_at, (s.c).title,
         public._srch_pts((s.c).watch_minutes, rr.n, (s.c).likes + rp.posts, rp.up, (s.c).dislikes, rp.down, (s.c).comments, (s.c).shares),
         public._srch_rank((s.c).watch_minutes, rr.n, (s.c).likes + rp.posts, rp.up, (s.c).dislikes, rp.down, (s.c).comments, (s.c).shares),
         s.why
    from seen s
    left join lateral (
      select count(distinct p.post_id) as posts,
             count(v.member_id) filter (where v.vote = 'up') as up, count(v.member_id) filter (where v.vote = 'down') as down
        from public.post_items i
        join public.posts p on p.post_id = i.post_id and p.kind in ('recommendation', 'reclist')
        left join public.post_votes v on v.post_id = p.post_id
       where i.content_id = (s.c).content_id
    ) rp on true
    left join lateral (
      select count(*) as n from public.content_reports r
       where r.kind = 'video' and r.target_id = (s.c).content_id and r.status = 'valid'
    ) rr on true
$$;

-- videos > playlist: the playlists holding at least one video the viewer may find
create or replace function public._srch_cplaylist(p_viewer text, p_words text[], p_t0 timestamptz, p_t1 timestamptz)
returns table (id text, at timestamptz, title text, pts bigint, rank jsonb, why text)
language sql stable security definer set search_path = public as $$
  with pl as (
    select p.playlist_id, p.name, p.created_at
      from public.content_playlists p
      join public.members m on m.member_id = p.owner_id and lower(coalesce(m.status, '')) <> 'banned'
     where p.suspended_at is null and public._srch_in(p.created_at, p_t0, p_t1)
       and public._srch_match(lower(p.name || ' ' || coalesce(m.username, p.owner_username)), p_words)
  ), vids as (
    select i.playlist_id, c.content_id, c.watch_minutes, c.likes, c.dislikes, c.comments, c.shares
      from public.content_playlist_items i
      join pl on pl.playlist_id = i.playlist_id
      join public.content c on c.content_id = i.content_id
     where c.publish_at <= now() and public._content_access(c, p_viewer) not in ('private', 'scheduled', 'gone', 'age')
  ), agg as (
    select v.playlist_id, sum(v.watch_minutes)::bigint as mins, sum(v.likes)::bigint as l, sum(v.dislikes)::bigint as d,
           sum(v.comments)::bigint as cm, sum(v.shares)::bigint as sh,
           (select count(*) from public.content_reports r
             where r.kind = 'video' and r.status = 'valid' and r.target_id = any (array_agg(v.content_id))) as vrep
      from vids v group by v.playlist_id
  )
  select pl.playlist_id, pl.created_at, pl.name,
         public._srch_pts(a.mins, a.vrep + pr.n, a.l, 0, a.d, 0, a.cm, a.sh),
         public._srch_rank(a.mins, a.vrep + pr.n, a.l, 0, a.d, 0, a.cm, a.sh), 'ok'
    from pl join agg a on a.playlist_id = pl.playlist_id
    left join lateral (
      select count(*) as n from public.content_reports r where r.kind = 'playlist' and r.target_id = pl.playlist_id and r.status = 'valid'
    ) pr on true
$$;

-- posts: p_kinds (recommendation, reclist, review, playlist, account), holding an item of p_media
-- ('' any, video, movie, tv)
create or replace function public._srch_posts(p_viewer text, p_words text[], p_t0 timestamptz, p_t1 timestamptz,
                                              p_kinds text[], p_media text)
returns table (id text, at timestamptz, title text, pts bigint, rank jsonb, why text)
language sql stable security definer set search_path = public as $$
  with cand as (
    select p from public.posts p
     where p.kind = any (p_kinds) and public._srch_in(p.created_at, p_t0, p_t1)
       and (coalesce(p_media, '') = '' or exists (select 1 from public.post_items i where i.post_id = p.post_id and i.media_type = p_media))
       and public._srch_match(lower(p.title || ' ' || coalesce(p.body, '') || ' ' || p.owner_username || ' '
                                    || coalesce((select string_agg(i.title, ' ') from public.post_items i where i.post_id = p.post_id), '')), p_words)
  ), seen as (
    select c.p from cand c where public._srch_post_sees(c.p, p_viewer)
  )
  select (s.p).post_id, (s.p).created_at, (s.p).title,
         public._srch_pts(pm.n, pr.n, pv.up, 0, pv.down, 0, pc.n, ps.n),
         public._srch_rank(pm.n, pr.n, pv.up, 0, pv.down, 0, pc.n, ps.n), 'ok'
    from seen s
    left join lateral (select count(*) filter (where v.vote = 'up') as up, count(*) filter (where v.vote = 'down') as down
                         from public.post_votes v where v.post_id = (s.p).post_id) pv on true
    left join lateral (select count(*) as n from public.post_comments k where k.post_id = (s.p).post_id) pc on true
    left join lateral (select coalesce(sum(w.minutes), 0)::bigint as n from public.views w where w.post_id = (s.p).post_id) pm on true
    left join lateral (select count(*) as n from public.post_events e where e.post_id = (s.p).post_id and e.kind = 'share') ps on true
    left join lateral (select count(*) as n from public.content_reports r
                        where r.kind = 'post' and r.target_id = (s.p).post_id and r.status = 'valid') pr on true
$$;

-- movies / series > playlist: the members' playlists of p_media (movie | tv) with at least one title
create or replace function public._srch_mplaylist(p_viewer text, p_words text[], p_t0 timestamptz, p_t1 timestamptz, p_media text)
returns table (id text, at timestamptz, title text, pts bigint, rank jsonb, why text)
language sql stable security definer set search_path = public as $$
  with cand as (
    select pl from public.playlists pl
     where pl.media_type = p_media and public._srch_in(pl.created_at, p_t0, p_t1)
       and exists (select 1 from public.playlist_items i where i.playlist_id = pl.playlist_id)
       and public._srch_match(lower(pl.name || ' ' || coalesce(pl.description, '') || ' ' || pl.owner_username || ' '
                                    || coalesce((select string_agg(i.title, ' ') from public.playlist_items i where i.playlist_id = pl.playlist_id), '')), p_words)
  ), seen as (
    select c.pl from cand c where public._srch_mpl_sees(c.pl, p_viewer)
  )
  select (s.pl).playlist_id, (s.pl).created_at, (s.pl).name,
         public._srch_pts((s.pl).watch_minutes, pr.n, pp.up, 0, pp.down, 0, pp.comments, pp.shares),
         public._srch_rank(coalesce((s.pl).watch_minutes, 0), pr.n, pp.up, 0, pp.down, 0, pp.comments, pp.shares), 'ok'
    from seen s
    left join lateral (
      select coalesce(sum((select count(*) from public.post_votes v where v.post_id = p.post_id and v.vote = 'up')), 0)::bigint as up,
             coalesce(sum((select count(*) from public.post_votes v where v.post_id = p.post_id and v.vote = 'down')), 0)::bigint as down,
             coalesce(sum((select count(*) from public.post_comments k where k.post_id = p.post_id)), 0)::bigint as comments,
             coalesce(sum((select count(*) from public.post_events e where e.post_id = p.post_id and e.kind = 'share')), 0)::bigint as shares
        from public.posts p where p.kind = 'playlist' and p.playlist_id = (s.pl).playlist_id
    ) pp on true
    left join lateral (select count(*) as n from public.content_reports r
                        where r.kind = 'playlist' and r.target_id = (s.pl).playlist_id and r.status = 'valid') pr on true
$$;

-- channels > free: the channels of the free packages of Panel > IPTV (one per name and type);
-- the date of a channel is the day its package was added
create or replace function public._srch_free(p_viewer text, p_words text[], p_t0 timestamptz, p_t1 timestamptz, p_opts jsonb)
returns table (id text, at timestamptz, title text, pts bigint, rank jsonb, why text)
language sql stable security definer set search_path = public as $$
  with packs as (
    select i.name, min(coalesce(i.created_at, now())) as at from public.iptv i
     where lower(btrim(coalesce(i.type, ''))) = 'free' and coalesce(i.name, '') <> ''
     group by i.name
  ), rows as (
    select distinct on (public.channel_key(l.channel_name), coalesce(l.channel_type, 'live'))
           l.id, l.channel_name, public.channel_key(l.channel_name) as k, pk.at
      from public.listchannels l join packs pk on pk.name = l.package_name
     where public._srch_in(pk.at, p_t0, p_t1)
       and (coalesce(p_opts->>'kind', '') = '' or coalesce(l.channel_type, 'live') = p_opts->>'kind')
       and public._srch_match(lower(l.channel_name || ' ' || coalesce(l.group_name, '')), p_words)
     order by public.channel_key(l.channel_name), coalesce(l.channel_type, 'live'), (coalesce(l.logo_url, '') <> '') desc, l.id
  )
  select r.id::text, r.at, r.channel_name,
         public._srch_pts(cm.n, cr.n, 0, 0, 0, 0, 0, 0), public._srch_rank(cm.n, cr.n, 0, 0, 0, 0, 0, 0), 'ok'
    from rows r
    left join lateral (select coalesce(sum(x.minutes), 0)::bigint as n from public.channel_minutes x where x.channel_key = r.k) cm on true
    left join lateral (select count(*) as n from public.channel_reports c
                        where c.status = 'resolved' and public.channel_key(c.channel_name) = r.k) cr on true
$$;

-- channels > site: CineAura's packages (the free ones of Panel > IPTV)
create or replace function public._srch_site(p_viewer text, p_words text[], p_t0 timestamptz, p_t1 timestamptz)
returns table (id text, at timestamptz, title text, pts bigint, rank jsonb, why text)
language sql stable security definer set search_path = public as $$
  with packs as (
    select i.name, min(coalesce(i.created_at, now())) as at from public.iptv i
     where lower(btrim(coalesce(i.type, ''))) = 'free' and coalesce(i.name, '') <> ''
     group by i.name
  )
  select pk.name, pk.at, pk.name,
         public._srch_pts(cm.n, cr.n, 0, 0, 0, 0, 0, 0), public._srch_rank(cm.n, cr.n, 0, 0, 0, 0, 0, 0), 'ok'
    from packs pk
    left join lateral (select coalesce(sum(x.minutes), 0)::bigint as n from public.channel_minutes x
                        where x.channel_key in (select public.channel_key(l.channel_name) from public.listchannels l where l.package_name = pk.name)) cm on true
    left join lateral (select count(*) as n from public.channel_reports c where c.status = 'resolved' and c.package_name = pk.name) cr on true
   where public._srch_in(pk.at, p_t0, p_t1)
     and (coalesce(array_length(p_words, 1), 0) = 0
          or public._srch_match(lower(pk.name), p_words)
          or exists (select 1 from public.listchannels l where l.package_name = pk.name
                      and public._srch_match(lower(l.channel_name || ' ' || coalesce(l.group_name, '')), p_words)))
$$;

-- channels > member: the channels of the members' public and exclusive lists (one per name and
-- type in a list); an exclusive list the viewer cannot open yet gives its lock
create or replace function public._srch_mchannels(p_viewer text, p_words text[], p_t0 timestamptz, p_t1 timestamptz, p_opts jsonb)
returns table (id text, at timestamptz, title text, pts bigint, rank jsonb, why text)
language sql stable security definer set search_path = public as $$
  with lists as (
    select l.list_id, l.name, l.created_at, l.likes, l.dislikes, l.shares, public._iptvl_access(l, p_viewer) as why
      from public.iptv_lists l
     where l.visibility in ('public', 'exclusive') and l.indexed_at is not null and public._srch_in(l.created_at, p_t0, p_t1)
  ), open_lists as (
    select * from lists where why not in ('gone', 'private')
  ), hits as (
    select distinct on (c.list_id, lower(c.name), c.kind)
           c.list_id, c.pos, c.name, public.channel_key(c.name) as k, x.created_at, x.name as lname, x.likes, x.dislikes, x.shares, x.why
      from public.iptv_list_channels c join open_lists x on x.list_id = c.list_id
     where (coalesce(p_opts->>'kind', '') = '' or c.kind = p_opts->>'kind')
       and public._srch_match(lower(c.name || ' ' || c.group_name), p_words)
     order by c.list_id, lower(c.name), c.kind, c.pos
  )
  select h.list_id || ':' || h.pos, h.created_at, h.name,
         public._srch_pts(cm.n, lr.n + cr.n, h.likes, 0, h.dislikes, 0, 0, h.shares),
         public._srch_rank(cm.n, lr.n + cr.n, h.likes, 0, h.dislikes, 0, 0, h.shares), h.why
    from hits h
    left join lateral (select coalesce(sum(m.minutes), 0)::bigint as n from public.iptv_list_minutes m
                        where m.list_id = h.list_id and m.ckey = h.k) cm on true
    left join lateral (select count(*) as n from public.content_reports r
                        where r.kind = 'iptv_list' and r.target_id = h.list_id and r.status = 'valid') lr on true
    left join lateral (select count(*) as n from public.channel_reports c
                        where c.status = 'resolved' and c.package_name = h.lname and public.channel_key(c.channel_name) = h.k) cr on true
$$;

-- channels > list: the members' lists — public, exclusive (with the lock), private (the ones the
-- viewer may open, and the others with "Request to join" unless kept out of the search)
create or replace function public._srch_mlists(p_viewer text, p_words text[], p_t0 timestamptz, p_t1 timestamptz)
returns table (id text, at timestamptz, title text, pts bigint, rank jsonb, why text)
language sql stable security definer set search_path = public as $$
  with cand as (
    select l, public._iptvl_access(l, p_viewer) as why
      from public.iptv_lists l
     where (l.indexed_at is not null or l.owner_id = btrim(coalesce(p_viewer, ''))) and public._srch_in(l.created_at, p_t0, p_t1)
       and public._srch_match(lower(l.name || ' ' || l.description || ' ' || l.owner_username), p_words)
  ), seen as (
    select * from cand c
     where c.why = 'ok'
        or ((c.l).visibility = 'exclusive' and c.why not in ('gone', 'private'))
        or ((c.l).visibility = 'private' and c.why = 'private' and not (c.l).search_hidden)
  )
  select (s.l).list_id, (s.l).created_at, (s.l).name,
         public._srch_pts((s.l).watch_minutes, lr.n + cr.n, (s.l).likes, 0, (s.l).dislikes, 0, 0, (s.l).shares),
         public._srch_rank((s.l).watch_minutes, lr.n + cr.n, (s.l).likes, 0, (s.l).dislikes, 0, 0, (s.l).shares), s.why
    from seen s
    left join lateral (select count(*) as n from public.content_reports r
                        where r.kind = 'iptv_list' and r.target_id = (s.l).list_id and r.status = 'valid') lr on true
    left join lateral (select count(*) as n from public.channel_reports c
                        where c.status = 'resolved' and c.package_name = (s.l).name) cr on true
$$;

-- profiles > profile: active members (not one who blocked the viewer fully)
create or replace function public._srch_profiles(p_viewer text, p_words text[], p_t0 timestamptz, p_t1 timestamptz)
returns table (id text, at timestamptz, title text, pts bigint, rank jsonb, why text)
language sql stable security definer set search_path = public as $$
  select m.member_id, m.created_at, m.username, 30 * f.n,
         jsonb_build_object('points', 30 * f.n, 'followers', f.n), 'ok'
    from public.members m
    left join public.profiles p on p.member_id = m.member_id
    left join lateral (select count(*)::bigint as n from public.follows x
                        where x.following_id = m.member_id and x.status = 'accepted') f on true
   where lower(coalesce(m.status, '')) = 'active' and public._srch_in(m.created_at, p_t0, p_t1)
     and public._srch_match(lower(m.username || ' ' || coalesce(p.display_name, '')), p_words)
     and not exists (select 1 from public.blocks b where b.blocker_id = m.member_id
                       and b.blocked_id = btrim(coalesce(p_viewer, '')) and b.kind = 'full')
$$;

-- market > product (on sale: an open store, in stock)
create or replace function public._srch_products(p_viewer text, p_words text[], p_t0 timestamptz, p_t1 timestamptz)
returns table (id text, at timestamptz, title text, pts bigint, rank jsonb, why text)
language sql stable security definer set search_path = public as $$
  with cand as (
    select p.id, p.title, p.created_at, p.pros, p.cons
      from public.market_products p
      join public.market_stores s on s.id = p.store_id
      join public.members mm on mm.member_id = s.owner_id and lower(btrim(coalesce(mm.status, ''))) = 'active'
     where p.status = 'active' and p.stock > 0 and s.is_open and not s.suspended
       and public._srch_in(p.created_at, p_t0, p_t1)
       and public._srch_match(lower(p.title || ' ' || p.description || ' ' || s.name || ' '
                                    || coalesce((select string_agg(c.name, ' ') from public.market_product_categories pc
                                                   join public.market_categories c on c.id = pc.category_id where pc.product_id = p.id), '')), p_words)
  ), num as (
    select c.*,
           (select coalesce(sum(o.qty), 0) from public.market_orders o
             where o.product_id = c.id and o.status in ('sold', 'shipped', 'delivered', 'return_requested'))::bigint as sold,
           (select count(*) from public.market_orders o
             where o.product_id = c.id and o.referrer_id is not null and o.status in ('sold', 'shipped', 'delivered', 'return_requested'))::bigint as via,
           (select count(*) from public.market_recs r where r.product_id = c.id)::bigint as recs,
           (select count(*) from public.market_reviews r where r.product_id = c.id and r.suspended_at is null)::bigint as reviews,
           (select count(*) from public.market_reports r where r.kind = 'product' and r.target_id = c.id and r.status = 'resolved')::bigint as reports
      from cand c
  )
  select n.id, n.created_at, n.title,
         60 * n.sold + 30 * n.recs + 30 * n.pros - 30 * n.cons + n.reviews + n.via - 60 * n.reports,
         jsonb_build_object('points', 60 * n.sold + 30 * n.recs + 30 * n.pros - 30 * n.cons + n.reviews + n.via - 60 * n.reports,
                            'sold', n.sold, 'recs', n.recs, 'pros', n.pros, 'cons', n.cons, 'reviews', n.reviews,
                            'shares', n.via, 'reports', n.reports), 'ok'
    from num n
$$;

-- market > category (with products on sale)
create or replace function public._srch_categories(p_viewer text, p_words text[], p_t0 timestamptz, p_t1 timestamptz)
returns table (id text, at timestamptz, title text, pts bigint, rank jsonb, why text)
language sql stable security definer set search_path = public as $$
  with cand as (
    select c.id, c.name, c.created_at,
           count(distinct p.id)::bigint as products,
           coalesce((select sum(o.qty) from public.market_orders o
                      join public.market_product_categories pc2 on pc2.product_id = o.product_id and pc2.category_id = c.id
                     where o.status in ('sold', 'shipped', 'delivered', 'return_requested')), 0)::bigint as sold
      from public.market_categories c
      join public.market_product_categories pc on pc.category_id = c.id
      join public.market_products p on p.id = pc.product_id and p.status = 'active'
      join public.market_stores s on s.id = p.store_id and not s.suspended
      join public.members mm on mm.member_id = s.owner_id and lower(btrim(coalesce(mm.status, ''))) = 'active'
     where public._srch_in(c.created_at, p_t0, p_t1) and public._srch_match(lower(c.name), p_words)
     group by c.id, c.name, c.created_at
  )
  select c.id, c.created_at, c.name, 60 * c.sold + c.products,
         jsonb_build_object('points', 60 * c.sold + c.products, 'sold', c.sold, 'products', c.products), 'ok'
    from cand c
$$;

-- market > rec (purchase recommendations the viewer may read, of a product on sale or of a list)
create or replace function public._srch_mrecs(p_viewer text, p_words text[], p_t0 timestamptz, p_t1 timestamptz)
returns table (id text, at timestamptz, title text, pts bigint, rank jsonb, why text)
language sql stable security definer set search_path = public as $$
  with cand as (
    select r.id, r.created_at, coalesce(p.title, l.name, '') as title
      from public.market_recs r
      join public.members mm on mm.member_id = r.member_id
      left join public.market_products p on r.kind = 'product' and p.id = r.product_id
      left join public.market_lists l on r.kind = 'list' and l.id = r.list_id
     where r.suspended_at is null and public._srch_in(r.created_at, p_t0, p_t1)
       and public._mkt_sees(r.member_id, r.visibility, r.excl_followers, r.excl_premium, r.excl_countries, r.allowed, p_viewer)
       and case when r.kind = 'product' then p.status = 'active'
                else l.suspended_at is null
                     and public._mkt_sees(l.member_id, l.visibility, l.excl_followers, l.excl_premium, l.excl_countries, l.allowed, p_viewer) end
       and public._srch_match(lower(r.note || ' ' || coalesce(p.title, '') || ' ' || coalesce(l.name, '') || ' ' || mm.username), p_words)
  )
  select c.id, c.created_at, c.title, 30 * a.n, jsonb_build_object('points', 30 * a.n, 'again', a.n), 'ok'
    from cand c
    left join lateral (select count(*)::bigint as n from public.market_recs x where x.parent_id = c.id) a on true
$$;

-- market > review (reviews the viewer may read, of a product on sale)
create or replace function public._srch_mreviews(p_viewer text, p_words text[], p_t0 timestamptz, p_t1 timestamptz)
returns table (id text, at timestamptz, title text, pts bigint, rank jsonb, why text)
language sql stable security definer set search_path = public as $$
  select 'RV' || r.id::text, r.created_at, p.title,
         60 * (r.order_id is not null)::int + jsonb_array_length(r.pros) + jsonb_array_length(r.cons),
         jsonb_build_object('points', 60 * (r.order_id is not null)::int + jsonb_array_length(r.pros) + jsonb_array_length(r.cons),
                            'verified', (r.order_id is not null)::int, 'written', jsonb_array_length(r.pros) + jsonb_array_length(r.cons)), 'ok'
    from public.market_reviews r
    join public.market_products p on p.id = r.product_id and p.status = 'active'
    join public.members mm on mm.member_id = r.member_id
   where r.suspended_at is null and public._srch_in(r.created_at, p_t0, p_t1)
     and public._mkt_sees(r.member_id, r.visibility, r.excl_followers, r.excl_premium, r.excl_countries, r.allowed, p_viewer)
     and public._srch_match(lower(r.pros::text || ' ' || r.cons::text || ' ' || p.title || ' ' || mm.username), p_words)
$$;

-- market > list (purchase lists the viewer may see, with products on sale)
create or replace function public._srch_mklists(p_viewer text, p_words text[], p_t0 timestamptz, p_t1 timestamptz)
returns table (id text, at timestamptz, title text, pts bigint, rank jsonb, why text)
language sql stable security definer set search_path = public as $$
  with cand as (
    select l.id, l.name, l.created_at,
           (select count(*) from public.market_list_items i join public.market_products p on p.id = i.product_id and p.status = 'active'
             where i.list_id = l.id)::bigint as products,
           (select count(*) from public.market_recs x where x.kind = 'list' and x.list_id = l.id)::bigint as again
      from public.market_lists l
      join public.members mm on mm.member_id = l.member_id
     where l.suspended_at is null and public._srch_in(l.created_at, p_t0, p_t1)
       and public._mkt_sees(l.member_id, l.visibility, l.excl_followers, l.excl_premium, l.excl_countries, l.allowed, p_viewer)
       and public._srch_match(lower(l.name || ' ' || l.description || ' ' || mm.username || ' '
                                    || coalesce((select string_agg(p.title, ' ') from public.market_list_items i
                                                   join public.market_products p on p.id = i.product_id where i.list_id = l.id), '')), p_words)
  )
  select c.id, c.created_at, c.name, 30 * c.again + c.products,
         jsonb_build_object('points', 30 * c.again + c.products, 'again', c.again, 'products', c.products), 'ok'
    from cand c where c.products > 0
$$;

-- prizes > prize | challenge | lottery (p_mode ''): the prizes of the groups shown on the Prizes page
create or replace function public._srch_prizes(p_viewer text, p_words text[], p_t0 timestamptz, p_t1 timestamptz, p_mode text)
returns table (id text, at timestamptz, title text, pts bigint, rank jsonb, why text)
language sql stable security definer set search_path = public as $$
  with cand as (
    select p.id, p.title, coalesce(p.created_at, now()) as created_at,
           (select pm.id from public.prize_modes pm where pm.prize_id = p.id and pm.mode = p_mode limit 1) as mode_id
      from public.prizes p
      left join public.prize_groups g on g.id = p.group_id
     where coalesce(g.visible, true) and public._srch_in(coalesce(p.created_at, now()), p_t0, p_t1)
       and (coalesce(p_mode, '') = '' or exists (select 1 from public.prize_modes pm where pm.prize_id = p.id and pm.mode = p_mode))
       and public._srch_match(lower(p.title || ' ' || coalesce(p.description, '') || ' ' || coalesce(g.name, '') || ' '
                                    || coalesce(p.group_name, '') || ' ' || coalesce(p.categories, '')), p_words)
  ), num as (
    select c.*,
           case when coalesce(p_mode, '') = ''
                then (select count(distinct x.member_id) from (
                        select e.member_id from public.prize_entries e where e.prize_id = c.id
                        union select e.member_id from public.prize_mode_entries e where e.prize_id = c.id and e.status <> 'withdrawn') x)
                else (select count(*) from public.prize_mode_entries e where e.mode_id = c.mode_id and e.status <> 'withdrawn') end::bigint as people,
           case when coalesce(p_mode, '') = '' then (select count(*) from public.prize_views v where v.prize_id = c.id) else 0 end::bigint as visits
      from cand c
  )
  select n.id::text, n.created_at, n.title, 30 * n.people + n.visits,
         jsonb_build_object('points', 30 * n.people + n.visits, 'participants', n.people, 'visits', n.visits), 'ok'
    from num n
$$;

-- prizes > group
create or replace function public._srch_pgroups(p_viewer text, p_words text[], p_t0 timestamptz, p_t1 timestamptz)
returns table (id text, at timestamptz, title text, pts bigint, rank jsonb, why text)
language sql stable security definer set search_path = public as $$
  with cand as (
    select g.id, g.name, coalesce(g.created_at, now()) as created_at,
           (select count(*) from public.prizes p where p.group_id = g.id)::bigint as prizes,
           (select count(distinct x.member_id) from (
              select e.member_id from public.prize_entries e join public.prizes p on p.id = e.prize_id where p.group_id = g.id
              union select e.member_id from public.prize_mode_entries e join public.prizes p on p.id = e.prize_id
                     where p.group_id = g.id and e.status <> 'withdrawn') x)::bigint as people
      from public.prize_groups g
     where coalesce(g.visible, true) and public._srch_in(coalesce(g.created_at, now()), p_t0, p_t1)
       and public._srch_match(lower(g.name), p_words)
  )
  select c.id::text, c.created_at, c.name, 30 * c.people + c.prizes,
         jsonb_build_object('points', 30 * c.people + c.prizes, 'participants', c.people, 'prizes', c.prizes), 'ok'
    from cand c where c.prizes > 0
$$;

-- ------------------------------------------------------------------ 5. the result cards
create or replace function public._srch_post_json(p public.posts, p_viewer text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p.post_id, 'kind', p.kind, 'title', p.title, 'body', left(coalesce(p.body, ''), 400),
    'visibility', p.visibility, 'created_at', p.created_at, 'owner_id', p.owner_id,
    'owner', coalesce((select m.username from public.members m where m.member_id = p.owner_id), p.owner_username),
    'owner_avatar', coalesce((select pr.avatar_url from public.profiles pr where pr.member_id = p.owner_id), ''),
    'playlist_id', nullif(coalesce(p.playlist_id, ''), ''),
    'pros', coalesce(p.pros, ''), 'cons', coalesce(p.cons, ''),
    'items', coalesce((select jsonb_agg(jsonb_build_object('media_type', i.media_type, 'tmdb_id', i.tmdb_id,
                                                           'content_id', nullif(i.content_id, ''), 'title', i.title,
                                                           'poster_path', i.poster_path, 'year', i.year, 'rating', i.rating) order by i.id)
                         from (select * from public.post_items x where x.post_id = p.post_id order by x.id limit 6) i), '[]'::jsonb),
    'item_count', (select count(*) from public.post_items x where x.post_id = p.post_id),
    'up', (select count(*) from public.post_votes v where v.post_id = p.post_id and v.vote = 'up'),
    'down', (select count(*) from public.post_votes v where v.post_id = p.post_id and v.vote = 'down'),
    'comments', (select count(*) from public.post_comments k where k.post_id = p.post_id),
    'my_vote', coalesce((select v.vote from public.post_votes v where v.post_id = p.post_id and v.member_id = btrim(coalesce(p_viewer, ''))), ''),
    'mine', p.owner_id = btrim(coalesce(p_viewer, '')))
$$;

create or replace function public._srch_prize_json(p public.prizes, p_mode text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p.id, 'title', p.title, 'description', left(coalesce(p.description, ''), 280),
    'image', coalesce(nullif(btrim(split_part(coalesce(p.images, ''), E'\n', 1)), ''), nullif(p.prize_image, ''), ''),
    'group', (select jsonb_build_object('id', g.id, 'name', g.name, 'thumb', coalesce(g.thumb, '')) from public.prize_groups g where g.id = p.group_id),
    'starts_at', p.starts_at, 'ends_at', p.ends_at, 'created_at', p.created_at,
    'status', case when lower(coalesce(p.status, 'active')) = 'ended' or (p.ends_at is not null and p.ends_at < current_date) then 'ended'
                   when p.starts_at is not null and p.starts_at > current_date then 'upcoming' else 'open' end,
    'winners', coalesce(p.winners_count, 0), 'winners_needed', p.winners_needed, 'minutes', coalesce(p.minutes_required, 0),
    'focus', nullif(coalesce(p_mode, ''), ''),
    'modes', coalesce((select jsonb_agg(jsonb_build_object(
                 'mode', pm.mode, 'cost', pm.points_cost, 'starts_at', pm.starts_at, 'ends_at', pm.ends_at,
                 'unlimited', coalesce(pm.unlimited_time, false), 'quantity', pm.quantity, 'winners', pm.winners_needed,
                 'draw_at', pm.draw_at,
                 'participants', (select count(*) from public.prize_mode_entries e where e.mode_id = pm.id and e.status <> 'withdrawn'),
                 'conditions', (select count(*) from public.prize_mode_conditions c where c.mode_id = pm.id))
               order by pm.sort_order, pm.id) from public.prize_modes pm where pm.prize_id = p.id), '[]'::jsonb))
$$;

-- p_type, p_id, p_why (the lock) -> the card of a result
create or replace function public._srch_card(p_tab text, p_type text, p_id text, p_why text, p_viewer text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare res jsonb; v_list text; v_pos int;
begin
  if p_tab = 'videos' and p_type = 'video' then
    select public._content_card(c, p_why) into res from public.content c where c.content_id = p_id;
  elsif p_tab = 'videos' and p_type = 'playlist' then
    select jsonb_build_object('id', p.playlist_id, 'name', p.name, 'created_at', p.created_at, 'owner_id', p.owner_id,
             'owner', coalesce(m.username, p.owner_username), 'owner_avatar', coalesce(pr.avatar_url, ''),
             'count', v.n, 'thumb', coalesce(v.thumb, ''), 'first', v.first)
      into res
      from public.content_playlists p
      left join public.members m on m.member_id = p.owner_id
      left join public.profiles pr on pr.member_id = p.owner_id
      left join lateral (
        select count(*) as n, (array_agg(c.thumb_url order by i.added_at, c.content_id))[1] as thumb,
               (array_agg(c.content_id order by i.added_at, c.content_id))[1] as first
          from public.content_playlist_items i join public.content c on c.content_id = i.content_id
         where i.playlist_id = p.playlist_id and c.publish_at <= now()
           and public._content_access(c, p_viewer) not in ('private', 'scheduled', 'gone', 'age')
      ) v on true
     where p.playlist_id = p_id;
  elsif p_type in ('rec', 'review', 'post') and p_tab in ('videos', 'movies', 'series', 'profiles') then
    select public._srch_post_json(p, p_viewer) into res from public.posts p where p.post_id = p_id;
  elsif p_tab in ('movies', 'series') and p_type = 'playlist' then
    select jsonb_build_object('id', pl.playlist_id, 'name', pl.name, 'description', left(coalesce(pl.description, ''), 280),
             'created_at', pl.created_at, 'owner_id', pl.owner_id, 'owner', coalesce(m.username, pl.owner_username),
             'owner_avatar', coalesce(pr.avatar_url, ''), 'media_type', pl.media_type, 'visibility', pl.visibility,
             'viewers', coalesce(pl.viewers, 0),
             'count', (select count(*) from public.playlist_items i where i.playlist_id = pl.playlist_id),
             'posters', coalesce((select jsonb_agg(z.poster_path) from (select i.poster_path from public.playlist_items i
                                   where i.playlist_id = pl.playlist_id and coalesce(i.poster_path, '') <> ''
                                   order by i.added_at desc limit 4) z), '[]'::jsonb))
      into res
      from public.playlists pl
      left join public.members m on m.member_id = pl.owner_id
      left join public.profiles pr on pr.member_id = pl.owner_id
     where pl.playlist_id = p_id;
  elsif p_tab = 'channels' and p_type = 'free' then
    select jsonb_build_object('id', l.id, 'name', l.channel_name, 'group', coalesce(l.group_name, ''), 'logo', coalesce(l.logo_url, ''),
             'kind', coalesce(l.channel_type, 'live'), 'package', l.package_name, 'key', public.channel_key(l.channel_name))
      into res from public.listchannels l where l.id::text = p_id;
  elsif p_tab = 'channels' and p_type = 'site' then
    select jsonb_build_object('id', p_id, 'name', p_id, 'kind', 'package', 'free', true,
             'channels', count(*), 'live', count(*) filter (where coalesce(l.channel_type, 'live') = 'live'),
             'movies', count(*) filter (where l.channel_type = 'movie'), 'series', count(*) filter (where l.channel_type = 'series'),
             'groups', count(distinct lower(coalesce(l.group_name, ''))))
      into res from public.listchannels l where l.package_name = p_id;
  elsif p_tab = 'channels' and p_type = 'member' then
    v_list := split_part(p_id, ':', 1);
    v_pos := nullif(split_part(p_id, ':', 2), '')::int;
    select jsonb_build_object('id', p_id, 'name', c.name, 'group', c.group_name, 'logo', c.logo, 'kind', c.kind, 'key', c.ckey, 'pos', c.pos,
             'list', jsonb_build_object('id', l.list_id, 'name', l.name, 'owner_id', l.owner_id,
                       'owner', coalesce(m.username, l.owner_username), 'visibility', l.visibility, 'channels', l.channel_count,
                       'followers', l.excl_followers, 'countries', l.excl_countries, 'languages', l.excl_languages,
                       'level', l.excl_level, 'plan', l.excl_plan, 'password', coalesce(array_length(l.pass_hashes, 1), 0) > 0))
      into res
      from public.iptv_list_channels c join public.iptv_lists l on l.list_id = c.list_id
      left join public.members m on m.member_id = l.owner_id
     where c.list_id = v_list and c.pos = v_pos;
  elsif p_tab = 'channels' and p_type = 'list' then
    select public._iptvl_card(l, p_viewer)
           || case when p_why = 'private' then jsonb_build_object('request', coalesce((select r.status from public.iptv_list_requests r
                     where r.list_id = l.list_id and r.member_id = btrim(coalesce(p_viewer, '')) order by r.created_at desc limit 1), ''))
                   else '{}'::jsonb end
      into res from public.iptv_lists l where l.list_id = p_id;
  elsif p_tab = 'profiles' and p_type = 'profile' then
    select jsonb_build_object('id', m.member_id, 'username', m.username, 'display_name', coalesce(pr.display_name, ''),
             'avatar', coalesce(pr.avatar_url, ''), 'bio', left(coalesce(pr.bio, ''), 200),
             'country', case when coalesce(pr.show_country, true) then upper(coalesce(m.country, '')) else '' end,
             'created_at', m.created_at,
             'followers', (select count(*) from public.follows f where f.following_id = m.member_id and f.status = 'accepted'),
             'following', (select count(*) from public.follows f where f.follower_id = m.member_id and f.status = 'accepted'),
             'videos', (select count(*) from public.content c where c.owner_id = m.member_id and c.visibility = 'public'
                          and c.publish_at <= now() and c.suspended_at is null),
             'posts', (select count(*) from public.posts p where p.owner_id = m.member_id and coalesce(p.visibility, 'public') = 'public'),
             'level', public._iptvl_level(m.member_id),
             'follow', coalesce((select f.status from public.follows f where f.follower_id = btrim(coalesce(p_viewer, ''))
                                   and f.following_id = m.member_id), ''),
             'me', m.member_id = btrim(coalesce(p_viewer, '')))
      into res
      from public.members m left join public.profiles pr on pr.member_id = m.member_id
     where m.member_id = p_id;
  elsif p_tab = 'market' and p_type = 'product' then
    select public._mkt_card(p) into res from public.market_products p where p.id = p_id;
  elsif p_tab = 'market' and p_type = 'category' then
    select jsonb_build_object('id', c.id, 'name', c.name, 'created_at', c.created_at,
             'products', (select count(*) from public.market_product_categories pc
                            join public.market_products p on p.id = pc.product_id and p.status = 'active' where pc.category_id = c.id),
             'images', coalesce((select jsonb_agg(z.img) from (
                          select p2.images->>0 as img from public.market_product_categories pc2
                            join public.market_products p2 on p2.id = pc2.product_id and p2.status = 'active' and jsonb_array_length(p2.images) > 0
                           where pc2.category_id = c.id order by p2.sales desc, p2.created_at desc limit 4) z), '[]'::jsonb))
      into res from public.market_categories c where c.id = p_id;
  elsif p_tab = 'market' and p_type = 'rec' then
    select public._mkt_rec_json(r, p_viewer) into res from public.market_recs r where r.id = p_id;
  elsif p_tab = 'market' and p_type = 'review' then
    select public._mkt_review_json(r, p_viewer) into res from public.market_reviews r where r.id = substr(p_id, 3)::bigint;
  elsif p_tab = 'market' and p_type = 'list' then
    select public._mkt_list_json(l, p_viewer) into res from public.market_lists l where l.id = p_id;
  elsif p_tab = 'prizes' and p_type in ('prize', 'challenge', 'lottery') then
    select public._srch_prize_json(p, case when p_type = 'prize' then '' else p_type end) into res from public.prizes p where p.id::text = p_id;
  elsif p_tab = 'prizes' and p_type = 'group' then
    select jsonb_build_object('id', g.id, 'name', g.name, 'thumb', coalesce(g.thumb, ''), 'created_at', g.created_at,
             'prizes', (select count(*) from public.prizes p where p.group_id = g.id),
             'open', (select count(*) from public.prizes p where p.group_id = g.id and lower(coalesce(p.status, 'active')) <> 'ended'
                        and (p.ends_at is null or p.ends_at >= current_date)))
      into res from public.prize_groups g where g.id::text = p_id;
  end if;
  return res;
end $$;

-- ------------------------------------------------------------------ 6. the search
create or replace function public._srch_types(p_tab text) returns text[]
language sql immutable as $$
  select case p_tab
    when 'videos' then array['video', 'playlist', 'rec', 'review']
    when 'movies' then array['rec', 'review', 'playlist']
    when 'series' then array['rec', 'review', 'playlist']
    when 'channels' then array['free', 'site', 'member', 'list']
    when 'profiles' then array['profile', 'post', 'rec']
    when 'market' then array['product', 'category', 'rec', 'review', 'list']
    when 'prizes' then array['prize', 'challenge', 'lottery', 'group']
    else '{}'::text[] end
$$;

create or replace function public._srch_hits(p_tab text, p_type text, p_viewer text, p_words text[],
                                             p_t0 timestamptz, p_t1 timestamptz, p_opts jsonb)
returns table (id text, at timestamptz, title text, pts bigint, rank jsonb, why text)
language plpgsql stable security definer set search_path = public as $$
declare media text := case p_tab when 'videos' then 'video' when 'movies' then 'movie' when 'series' then 'tv' else '' end;
begin
  if p_tab = 'videos' and p_type = 'video' then return query select * from public._srch_video(p_viewer, p_words, p_t0, p_t1, p_opts);
  elsif p_tab = 'videos' and p_type = 'playlist' then return query select * from public._srch_cplaylist(p_viewer, p_words, p_t0, p_t1);
  elsif p_tab in ('videos', 'movies', 'series', 'profiles') and p_type = 'rec' then
    return query select * from public._srch_posts(p_viewer, p_words, p_t0, p_t1, array['recommendation', 'reclist'], media);
  elsif p_tab in ('videos', 'movies', 'series') and p_type = 'review' then
    return query select * from public._srch_posts(p_viewer, p_words, p_t0, p_t1, array['review'], media);
  elsif p_tab in ('movies', 'series') and p_type = 'playlist' then
    return query select * from public._srch_mplaylist(p_viewer, p_words, p_t0, p_t1, media);
  elsif p_tab = 'channels' and p_type = 'free' then return query select * from public._srch_free(p_viewer, p_words, p_t0, p_t1, p_opts);
  elsif p_tab = 'channels' and p_type = 'site' then return query select * from public._srch_site(p_viewer, p_words, p_t0, p_t1);
  elsif p_tab = 'channels' and p_type = 'member' then return query select * from public._srch_mchannels(p_viewer, p_words, p_t0, p_t1, p_opts);
  elsif p_tab = 'channels' and p_type = 'list' then return query select * from public._srch_mlists(p_viewer, p_words, p_t0, p_t1);
  elsif p_tab = 'profiles' and p_type = 'profile' then return query select * from public._srch_profiles(p_viewer, p_words, p_t0, p_t1);
  elsif p_tab = 'profiles' and p_type = 'post' then
    return query select * from public._srch_posts(p_viewer, p_words, p_t0, p_t1, array['playlist', 'account', 'review'], '');
  elsif p_tab = 'market' and p_type = 'product' then return query select * from public._srch_products(p_viewer, p_words, p_t0, p_t1);
  elsif p_tab = 'market' and p_type = 'category' then return query select * from public._srch_categories(p_viewer, p_words, p_t0, p_t1);
  elsif p_tab = 'market' and p_type = 'rec' then return query select * from public._srch_mrecs(p_viewer, p_words, p_t0, p_t1);
  elsif p_tab = 'market' and p_type = 'review' then return query select * from public._srch_mreviews(p_viewer, p_words, p_t0, p_t1);
  elsif p_tab = 'market' and p_type = 'list' then return query select * from public._srch_mklists(p_viewer, p_words, p_t0, p_t1);
  elsif p_tab = 'prizes' and p_type = 'prize' then return query select * from public._srch_prizes(p_viewer, p_words, p_t0, p_t1, '');
  elsif p_tab = 'prizes' and p_type in ('challenge', 'lottery') then
    return query select * from public._srch_prizes(p_viewer, p_words, p_t0, p_t1, p_type);
  elsif p_tab = 'prizes' and p_type = 'group' then return query select * from public._srch_pgroups(p_viewer, p_words, p_t0, p_t1);
  end if;
end $$;

-- Search.html.
--   p_tab   videos | movies | series | channels | profiles | market | prizes
--   p_type  '' (all: the first p_limit results of every kind of the tab) or one kind (see the header)
--   p_when  '' | today | yesterday | week | month | year      p_sort  rank | new | old | az | za
--   p_opts  { tz, lang, region, age, tag, owner (videos), kind: live | movie | series (channels) }
-- -> one kind: { ok: true, tab, type, when, sort, total, items: [card + { type, at, rank, locked }] }
--    all:      { ok: true, tab, type: '', when, sort, total, sections: [{ type, total, items }] }
--    { ok: false, reason: tab | type }
create or replace function public.site_search(
  p_member text default '', p_tab text default 'videos', p_type text default '', p_q text default '',
  p_when text default '', p_sort text default '', p_limit int default 24, p_offset int default 0,
  p_opts jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  viewer text; tab text := lower(coalesce(p_tab, '')); typ text := lower(coalesce(p_type, ''));
  wh text := lower(coalesce(p_when, '')); srt text := lower(coalesce(p_sort, ''));
  lim int := least(greatest(coalesce(p_limit, 24), 1), 60); off int := greatest(coalesce(p_offset, 0), 0);
  words text[]; t0 timestamptz; t1 timestamptz; opts jsonb := coalesce(p_opts, '{}'::jsonb);
  types text[]; k text; n bigint; items jsonb; sections jsonb := '[]'::jsonb; total bigint := 0;
begin
  types := public._srch_types(tab);
  if coalesce(array_length(types, 1), 0) = 0 then return jsonb_build_object('ok', false, 'reason', 'tab'); end if;
  if typ <> '' and not (typ = any (types)) then return jsonb_build_object('ok', false, 'reason', 'type'); end if;
  if wh not in ('', 'today', 'yesterday', 'week', 'month', 'year') then wh := ''; end if;
  if srt not in ('rank', 'new', 'old', 'az', 'za') then srt := 'rank'; end if;
  if jsonb_typeof(opts) <> 'object' then opts := '{}'::jsonb; end if;
  viewer := coalesce((public._content_viewer(p_member)).member_id, '');
  words := public._srch_words(p_q);
  select s.t0, s.t1 into t0, t1 from public._srch_since(wh, opts->>'tz') s;
  if typ = '' then lim := least(lim, 12); off := 0; end if;
  foreach k in array case when typ = '' then types else array[typ] end loop
    with h as (
      select * from public._srch_hits(tab, k, viewer, words, t0, t1, opts)
    ), r as (
      select h.*, row_number() over (order by
               case when srt = 'rank' then h.pts end desc nulls last,
               case when srt = 'old' then h.at end asc,
               case when srt = 'az' then lower(h.title) end asc,
               case when srt = 'za' then lower(h.title) end desc,
               h.at desc nulls last, h.id) as rn
        from h
    )
    select (select count(*) from h),
           coalesce((select jsonb_agg(coalesce(public._srch_card(tab, k, r.id, r.why, viewer), jsonb_build_object('id', r.id))
                                      || jsonb_build_object('type', k, 'at', r.at, 'rank', r.rank,
                                                            'locked', case when r.why = 'ok' then null else r.why end)
                                      order by r.rn)
                       from r where r.rn > off and r.rn <= off + lim), '[]'::jsonb)
      into n, items;
    total := total + n;
    sections := sections || jsonb_build_array(jsonb_build_object('type', k, 'total', n, 'items', items));
  end loop;
  if typ = '' then
    return jsonb_build_object('ok', true, 'tab', tab, 'type', '', 'when', wh, 'sort', srt, 'total', total, 'sections', sections);
  end if;
  return jsonb_build_object('ok', true, 'tab', tab, 'type', typ, 'when', wh, 'sort', srt, 'total', total,
                            'items', sections->0->'items');
end $$;

-- ------------------------------------------------------------------ 7. reporting
-- The Report button of a video (CT…), a playlist (CPL… of videos, IDP… of movies / series), an
-- IPTV list (IPL…) and a post (P…): a member who may see it, not its publisher, one open report
-- per member and item, 20 an hour at most.
--   p_reason  spam | misleading | offensive | violent | copyright | broken | other ; p_note 500 characters at most
-- -> { ok: true, id } | { ok: false, reason: member | kind | not_found | own | already | limit | reason | note }
create or replace function public.content_report(p_member text, p_kind text, p_id text, p_reason text, p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.members; v_id text := btrim(coalesce(p_id, '')); owner text; nt text := btrim(coalesce(p_note, '')); rid bigint;
  c public.content; l public.iptv_lists; p public.posts; pl public.playlists;
begin
  m := public._content_viewer(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if p_kind not in ('video', 'playlist', 'iptv_list', 'post') then return jsonb_build_object('ok', false, 'reason', 'kind'); end if;
  if coalesce(p_reason, '') not in ('spam', 'misleading', 'offensive', 'violent', 'copyright', 'broken', 'other') then
    return jsonb_build_object('ok', false, 'reason', 'reason');
  end if;
  if char_length(nt) > 500 then return jsonb_build_object('ok', false, 'reason', 'note'); end if;
  if p_kind = 'video' then
    select * into c from public.content where content_id = v_id;
    if found and public._content_access(c, m.member_id) not in ('private', 'scheduled', 'gone') then owner := c.owner_id; end if;
  elsif p_kind = 'playlist' and v_id like 'CPL%' then
    select p2.owner_id into owner from public.content_playlists p2
     where p2.playlist_id = v_id and (p2.suspended_at is null or p2.owner_id = m.member_id);
  elsif p_kind = 'playlist' then
    select * into pl from public.playlists where playlist_id = v_id;
    if found and public._srch_mpl_sees(pl, m.member_id) then owner := pl.owner_id; end if;
  elsif p_kind = 'iptv_list' then
    select * into l from public.iptv_lists where list_id = v_id;
    if found and public._iptvl_access(l, m.member_id) <> 'gone' then owner := l.owner_id; end if;
  else
    select * into p from public.posts where post_id = v_id;
    if found and public._srch_post_sees(p, m.member_id) then owner := p.owner_id; end if;
  end if;
  if owner is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if owner = m.member_id then return jsonb_build_object('ok', false, 'reason', 'own'); end if;
  if exists (select 1 from public.content_reports r where r.reporter_id = m.member_id and r.kind = p_kind
               and r.target_id = v_id and r.status = 'open') then
    return jsonb_build_object('ok', false, 'reason', 'already');
  end if;
  if (select count(*) from public.content_reports r where r.reporter_id = m.member_id and r.created_at > now() - interval '1 hour') >= 20 then
    return jsonb_build_object('ok', false, 'reason', 'limit');
  end if;
  insert into public.content_reports (kind, target_id, owner_id, reporter_id, reporter_name, reason, note)
  values (p_kind, v_id, owner, m.member_id, m.username, p_reason, nt) returning id into rid;
  return jsonb_build_object('ok', true, 'id', rid);
end $$;

-- Has the member an open report on it? (the Report button says "Reported")
create or replace function public.content_reported(p_member text, p_kind text, p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.content_reports r where r.reporter_id = btrim(coalesce(p_member, ''))
                   and r.kind = p_kind and r.target_id = btrim(coalesce(p_id, '')) and r.status = 'open')
$$;

-- ------------------------------------------------------------------ 8. Panel > Reports > Content (the team)
-- The Super Admin, or a staff member with the Reports or the Content section.
create or replace function public._srch_staff(p_token text) returns text
language plpgsql security definer set search_path = public as $$
declare s record; secs text;
begin
  s := public._staff(p_token);
  secs := ',' || replace(coalesce(s.sections, ''), ' ', '') || ',';
  if s.role <> 'super' and position(',reports,' in secs) = 0 and position(',content,' in secs) = 0 then
    raise exception 'staff_forbidden';
  end if;
  return coalesce(nullif(s.username, ''), s.role);
end $$;

-- What a report is about: its title, address, publisher, picture, and whether it is still there
create or replace function public._srch_report_target(p_kind text, p_id text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare res jsonb;
begin
  if p_kind = 'video' then
    select jsonb_build_object('title', c.title, 'href', './Content.html?idcontent=' || c.content_id, 'thumb', c.thumb_url,
             'suspended', c.suspended_at is not null, 'owner', jsonb_build_object('id', c.owner_id, 'username', c.owner_username))
      into res from public.content c where c.content_id = p_id;
  elsif p_kind = 'playlist' and p_id like 'CPL%' then
    select jsonb_build_object('title', p.name, 'href', './Profile.html?@' || coalesce(m.username, p.owner_username) || '#playlist/' || p.playlist_id,
             'thumb', '', 'suspended', p.suspended_at is not null,
             'owner', jsonb_build_object('id', p.owner_id, 'username', coalesce(m.username, p.owner_username)))
      into res from public.content_playlists p left join public.members m on m.member_id = p.owner_id where p.playlist_id = p_id;
  elsif p_kind = 'playlist' then
    select jsonb_build_object('title', p.name, 'href', './Playlist.html?ID=' || p.playlist_id, 'thumb', '', 'suspended', false,
             'owner', jsonb_build_object('id', p.owner_id, 'username', p.owner_username))
      into res from public.playlists p where p.playlist_id = p_id;
  elsif p_kind = 'iptv_list' then
    select jsonb_build_object('title', l.name, 'href', './Listchannels.html?list=' || l.list_id, 'thumb', '',
             'suspended', l.suspended_at is not null,
             'owner', jsonb_build_object('id', l.owner_id, 'username', coalesce(m.username, l.owner_username)))
      into res from public.iptv_lists l left join public.members m on m.member_id = l.owner_id where l.list_id = p_id;
  else
    select jsonb_build_object('title', p.title, 'href', './Profile.html?post=' || p.post_id, 'thumb', '', 'suspended', false,
             'owner', jsonb_build_object('id', p.owner_id, 'username', p.owner_username), 'kind', p.kind)
      into res from public.posts p where p.post_id = p_id;
  end if;
  return res;
end $$;

-- p_filter open | closed | all, p_kind '' | video | playlist | iptv_list | post
-- -> { ok: true, counts: { open, valid, dismissed }, items: [{ id, kind, target_id, target, reporter: { id, username },
--      reason, note, status, handled_by, handled_at, created_at }] }
create or replace function public.content_reports_admin(p_token text, p_filter text default 'open', p_kind text default '',
                                                        p_limit int default 400)
returns jsonb language plpgsql security definer set search_path = public as $$
declare who text; f text := case when p_filter in ('closed', 'all') then p_filter else 'open' end; k text := coalesce(p_kind, '');
begin
  who := public._srch_staff(p_token);
  return jsonb_build_object('ok', true,
    'counts', (select jsonb_build_object('open', count(*) filter (where r.status = 'open'),
                                         'valid', count(*) filter (where r.status = 'valid'),
                                         'dismissed', count(*) filter (where r.status = 'dismissed'))
                 from public.content_reports r where k = '' or r.kind = k),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'kind', r.kind, 'target_id', r.target_id, 'target', public._srch_report_target(r.kind, r.target_id),
        'reporter', jsonb_build_object('id', r.reporter_id, 'username', coalesce(m.username, r.reporter_name)),
        'reason', r.reason, 'note', r.note, 'status', r.status, 'handled_by', r.handled_by, 'handled_at', r.handled_at,
        'created_at', r.created_at) order by r.created_at desc)
      from (select * from public.content_reports x
             where (k = '' or x.kind = k)
               and case f when 'open' then x.status = 'open' when 'closed' then x.status <> 'open' else true end
             order by x.created_at desc limit least(greatest(coalesce(p_limit, 400), 1), 1000)) r
      left join public.members m on m.member_id = r.reporter_id), '[]'::jsonb));
end $$;

-- p_status valid | dismissed | open (again). -> { ok: true, n }
create or replace function public.content_reports_set(p_token text, p_ids bigint[], p_status text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare who text; n int;
begin
  who := public._srch_staff(p_token);
  if p_status not in ('valid', 'dismissed', 'open') then return jsonb_build_object('ok', false, 'reason', 'status'); end if;
  update public.content_reports
     set status = p_status,
         handled_by = case when p_status = 'open' then '' else who end,
         handled_at = case when p_status = 'open' then null else now() end
   where id = any (coalesce(p_ids, '{}')) and status <> p_status
     and not (p_status = 'open' and exists (select 1 from public.content_reports o where o.status = 'open' and o.id <> content_reports.id
                                             and o.reporter_id = content_reports.reporter_id and o.kind = content_reports.kind
                                             and o.target_id = content_reports.target_id));
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'n', n);
end $$;

create or replace function public.content_reports_delete(p_token text, p_ids bigint[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare who text; n int;
begin
  who := public._srch_staff(p_token);
  delete from public.content_reports where id = any (coalesce(p_ids, '{}'));
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'n', n);
end $$;

-- the open reports (the badge of Panel > Reports); 0 for an account without the section
create or replace function public.content_reports_count(p_token text) returns int
language plpgsql security definer set search_path = public as $$
begin
  perform public._srch_staff(p_token);
  return (select count(*) from public.content_reports where status = 'open');
exception when others then
  return 0;
end $$;

-- ------------------------------------------------------------------ 9. who may call what
do $$
declare f text;
begin
  foreach f in array array[
    'public._srch_pts(bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint)',
    'public._srch_rank(bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint)',
    'public._srch_words(text)', 'public._srch_match(text, text[])', 'public._srch_since(text, text)',
    'public._srch_in(timestamptz, timestamptz, timestamptz)', 'public._srch_tmdb_ids(text)',
    'public._srch_post_sees(public.posts, text)', 'public._srch_mpl_sees(public.playlists, text)',
    'public._srch_video(text, text[], timestamptz, timestamptz, jsonb)',
    'public._srch_cplaylist(text, text[], timestamptz, timestamptz)',
    'public._srch_posts(text, text[], timestamptz, timestamptz, text[], text)',
    'public._srch_mplaylist(text, text[], timestamptz, timestamptz, text)',
    'public._srch_free(text, text[], timestamptz, timestamptz, jsonb)',
    'public._srch_site(text, text[], timestamptz, timestamptz)',
    'public._srch_mchannels(text, text[], timestamptz, timestamptz, jsonb)',
    'public._srch_mlists(text, text[], timestamptz, timestamptz)',
    'public._srch_profiles(text, text[], timestamptz, timestamptz)',
    'public._srch_products(text, text[], timestamptz, timestamptz)',
    'public._srch_categories(text, text[], timestamptz, timestamptz)',
    'public._srch_mrecs(text, text[], timestamptz, timestamptz)',
    'public._srch_mreviews(text, text[], timestamptz, timestamptz)',
    'public._srch_mklists(text, text[], timestamptz, timestamptz)',
    'public._srch_prizes(text, text[], timestamptz, timestamptz, text)',
    'public._srch_pgroups(text, text[], timestamptz, timestamptz)',
    'public._srch_post_json(public.posts, text)', 'public._srch_prize_json(public.prizes, text)',
    'public._srch_card(text, text, text, text, text)', 'public._srch_types(text)',
    'public._srch_hits(text, text, text, text[], timestamptz, timestamptz, jsonb)',
    'public._srch_staff(text)', 'public._srch_report_target(text, text)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.site_search(text, text, text, text, text, text, int, int, jsonb)',
    'public.content_report(text, text, text, text, text)', 'public.content_reported(text, text, text)',
    'public.content_reports_admin(text, text, text, int)', 'public.content_reports_set(text, bigint[], text)',
    'public.content_reports_delete(text, bigint[])', 'public.content_reports_count(text)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
