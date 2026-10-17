-- ============================================================
-- Member videos ("Your content" on the profile, Content.html, Search.html)
-- Run in the Supabase SQL editor AFTER profile.sql, points.sql, prize_secure.sql,
-- point_levels.sql and point_codes.sql (safe to run more than once).
--
-- What members can do
--   * Profile > Your content > Create: a video link (YouTube, Vimeo, Dailymotion,
--     Facebook, Google Drive, TikTok, an .mp4 / .webm / .m3u8 file or any page
--     that can be embedded), title, description, tags, language, age rating
--     (3+ 6+ 13+ 16+ 18+), visibility, playlist and publish time (now, in an
--     hour, a day, a week, or a date). A scheduled video stays hidden until then.
--   * Manage: every video of the member with its numbers; link, duplicate, add
--     to a playlist, delete.
--   * Statistics: the numbers of a period (now = last 60 minutes, today,
--     yesterday, this week, this month, this year).
--   * Content.html?idcontent=CT…: the player, title, description, publisher,
--     recommend / don't recommend, share, add to a playlist, comments and
--     suggestions. Content.html alone: a search box and the 50 videos with the most
--     watched minutes, recommendations or shares. Search.html finds videos.
--   * A member's page (Profile.html?@name) > Content: their videos (newest, most
--     watched, most liked, most shared) and their playlists, each one with its
--     videos, as far as the visitor may find them (content_search with p_owner,
--     content_playlists_of, content_playlist_get).
--   * Followers: the bell tells them about a new video (_content_notify) and
--     Profile > Updates lists the videos of the members they follow among the
--     other updates (content_feed).
--
-- Visibility
--   public     everyone, visitors included
--   exclusive  found by everyone; watched by signed-in members only, narrowed by
--              the publisher to followers, premium members and / or countries
--   private    only the members the publisher listed (and the publisher)
--   The age rating is checked against the member's birth date. A video rated 13+
--   (13+, 16+, 18+) also asks for a watch code (sql/code_devices.sql), for everyone:
--   content_get leaves its link out, content_unlock gives it for a valid code whose
--   age tier reaches the rating. "Remember the code" keeps the code on the device
--   (linked to it in Linked devices) so it is not asked again there.
--
-- Points (one "unit" = one watched minute, at the viewer's country tier and the
-- level of whoever earns it, like the watch links of sql/point_levels.sql):
--   * every counted minute: the viewer (a member) and the publisher;
--   * a share, a comment, a positive recommendation by a member: that member
--     and the publisher. A share or a comment earns once per member, video and
--     day; a recommendation once per member and video.
--   Nobody earns from their own videos. Points go into profiles.content_points
--   (hundredths kept, whole points count), which only these functions can change.
--
-- Every table is closed to the public API; pages read and write through the
-- functions below, which check visibility, the member, sanctions and limits.
-- Like the rest of the site (no Supabase Auth), the functions trust the member id
-- the browser sends.
-- ============================================================

-- ------------------------------------------------------------------ 1. tables
create table if not exists public.content (
  content_id text primary key,
  owner_id text not null,
  owner_username text not null default '',
  video_url text not null,
  provider text not null default 'link',
  thumb_url text not null default '',
  title text not null,
  description text not null default '',
  tags text[] not null default '{}',
  language text not null default '',
  age_rating smallint not null default 3,
  visibility text not null default 'public',
  excl_followers boolean not null default false,
  excl_premium boolean not null default false,
  excl_countries text not null default '',
  country text not null default '',
  playlist_id text,
  publish_at timestamptz not null default now(),
  notified boolean not null default false,
  created_at timestamptz not null default now(),
  views bigint not null default 0,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  likes integer not null default 0,
  dislikes integer not null default 0,
  shares integer not null default 0,
  comments integer not null default 0,
  playlists integer not null default 0,
  watch_minutes bigint not null default 0
);

do $$
begin
  alter table public.content add constraint content_age_check check (age_rating in (3, 6, 13, 16, 18));
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table public.content add constraint content_vis_check check (visibility in ('public', 'exclusive', 'private'));
exception when duplicate_object then null;
end $$;

create index if not exists content_owner_idx on public.content (owner_id, created_at desc);
create index if not exists content_publish_idx on public.content (publish_at desc);
create index if not exists content_tags_idx on public.content using gin (tags);
create index if not exists content_notify_idx on public.content (notified, publish_at) where not notified;

comment on table public.content is 'Member videos (Profile > Your content). Read and written through the content_* functions only.';
comment on column public.content.country is 'The publisher''s country when the video was published (suggestions, Region filter)';
comment on column public.content.publish_at is 'Hidden from everybody but the publisher until then';

-- private videos: who may watch
create table if not exists public.content_access (
  content_id text not null references public.content (content_id) on delete cascade,
  username text not null
);
create unique index if not exists content_access_uniq on public.content_access (content_id, lower(username));

-- impressions, clicks, views, shares and counted minutes (the statistics periods)
create table if not exists public.content_events (
  id bigint generated always as identity primary key,
  content_id text not null references public.content (content_id) on delete cascade,
  kind text not null,
  viewer text not null default '',
  network text not null default '',
  created_at timestamptz not null default now()
);
do $$
begin
  alter table public.content_events add constraint content_events_kind_check
    check (kind in ('impression', 'click', 'view', 'share', 'minute'));
exception when duplicate_object then null;
end $$;
create index if not exists content_events_content_idx on public.content_events (content_id, kind, created_at);
create index if not exists content_events_viewer_idx on public.content_events (viewer, content_id, kind, created_at);

-- recommend (+1) / don't recommend (-1)
create table if not exists public.content_votes (
  content_id text not null references public.content (content_id) on delete cascade,
  member_id text not null,
  vote smallint not null,
  credited boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (content_id, member_id)
);
do $$
begin
  alter table public.content_votes add constraint content_votes_vote_check check (vote in (-1, 1));
exception when duplicate_object then null;
end $$;

create table if not exists public.content_comments (
  id bigint generated always as identity primary key,
  content_id text not null references public.content (content_id) on delete cascade,
  member_id text not null,
  username text not null default '',
  body text not null,
  parent_id bigint references public.content_comments (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists content_comments_content_idx on public.content_comments (content_id, created_at);
create index if not exists content_comments_member_idx on public.content_comments (member_id, created_at);

create table if not exists public.content_playlists (
  playlist_id text primary key,
  owner_id text not null,
  owner_username text not null default '',
  name text not null,
  created_at timestamptz not null default now()
);
create index if not exists content_playlists_owner_idx on public.content_playlists (owner_id);

create table if not exists public.content_playlist_items (
  playlist_id text not null references public.content_playlists (playlist_id) on delete cascade,
  content_id text not null references public.content (content_id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (playlist_id, content_id)
);
create index if not exists content_playlist_items_content_idx on public.content_playlist_items (content_id, added_at);

-- which share / comment already earned points today
create table if not exists public.content_point_log (
  member_id text not null,
  content_id text not null,
  kind text not null,
  day date not null default current_date,
  primary key (member_id, content_id, kind, day)
);

-- nothing of this is open to the public API
do $$
declare t text; pol record;
begin
  foreach t in array array['content', 'content_access', 'content_events', 'content_votes', 'content_comments',
                           'content_playlists', 'content_playlist_items', 'content_point_log']
  loop
    execute format('alter table public.%I enable row level security', t);
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ------------------------------------------------------------------ 2. counters
create or replace function public._content_count_votes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    update public.content set likes = greatest(0, likes - (old.vote = 1)::int),
                              dislikes = greatest(0, dislikes - (old.vote = -1)::int)
     where content_id = old.content_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    update public.content set likes = likes + (new.vote = 1)::int, dislikes = dislikes + (new.vote = -1)::int
     where content_id = new.content_id;
  end if;
  return null;
end $$;
drop trigger if exists content_votes_count on public.content_votes;
create trigger content_votes_count after insert or update of vote or delete on public.content_votes
  for each row execute function public._content_count_votes();

create or replace function public._content_count_comments() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update public.content set comments = comments + 1 where content_id = new.content_id;
  else
    update public.content set comments = greatest(0, comments - 1) where content_id = old.content_id;
  end if;
  return null;
end $$;
drop trigger if exists content_comments_count on public.content_comments;
create trigger content_comments_count after insert or delete on public.content_comments
  for each row execute function public._content_count_comments();

create or replace function public._content_count_items() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update public.content set playlists = playlists + 1 where content_id = new.content_id;
  else
    update public.content set playlists = greatest(0, playlists - 1) where content_id = old.content_id;
  end if;
  return null;
end $$;
drop trigger if exists content_items_count on public.content_playlist_items;
create trigger content_items_count after insert or delete on public.content_playlist_items
  for each row execute function public._content_count_items();

create or replace function public._content_count_events() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.content set
    impressions = impressions + (new.kind = 'impression')::int,
    clicks = clicks + (new.kind = 'click')::int,
    views = views + (new.kind = 'view')::int,
    shares = shares + (new.kind = 'share')::int,
    watch_minutes = watch_minutes + (new.kind = 'minute')::int
  where content_id = new.content_id;
  return null;
end $$;
drop trigger if exists content_events_count on public.content_events;
create trigger content_events_count after insert on public.content_events
  for each row execute function public._content_count_events();

-- ------------------------------------------------------------------ 3. points of the videos
alter table public.profiles add column if not exists content_points numeric(18,2) not null default 0;
alter table public.profiles add column if not exists content_units bigint not null default 0;
comment on column public.profiles.content_points is 'Points earned with videos (sql/content.sql), hundredths kept. Only the server changes it.';
comment on column public.profiles.content_units is 'Counted video minutes, shares, comments and recommendations that earned points.';

create or replace function public._guard_content_points() returns trigger language plpgsql as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.content_points := 0;
      new.content_units := 0;
    else
      new.content_points := old.content_points;
      new.content_units := old.content_units;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists profiles_guard_content_points on public.profiles;
create trigger profiles_guard_content_points before insert or update on public.profiles
  for each row execute function public._guard_content_points();

-- The points formula: same body in prize_secure.sql, point_levels.sql,
-- point_codes.sql, content.sql and market.sql (the file run last leaves the same formula).
create or replace function public._points(p_member text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  pr record; earned bigint; watch bigint; vids bigint; codes bigint; mk bigint; mr bigint; sh int; pl int; rc int; cm int; lk int := 0;
  dl bigint := 0; clicks bigint; has_dl boolean;
begin
  select coalesce(p.private_minutes, 0) + coalesce(p.public_minutes, 0) as mins,
         coalesce(p.points_spent, 0) as spent,
         to_jsonb(p) ->> 'watch_points' as wp,
         to_jsonb(p) ->> 'content_points' as vp,
         to_jsonb(p) ->> 'code_points' as cp,
         to_jsonb(p) ->> 'market_points' as mp,
         to_jsonb(p) ->> 'market_ref_points' as mrp
    into pr
  from public.profiles p where p.member_id = p_member;
  if not found then return jsonb_build_object('earned', 0, 'spent', 0, 'available', 0, 'watch', 0, 'videos', 0, 'codes', 0, 'market', 0, 'market_refs', 0); end if;
  -- watch points: stored by sql/point_levels.sql (country tier x level); before that file, 1 a minute
  watch := case when pr.wp is null then pr.mins else floor(pr.wp::numeric)::bigint end;
  -- videos (sql/content.sql): minutes watched, shares, comments and positive recommendations
  vids := floor(coalesce(pr.vp, '0')::numeric)::bigint;
  -- points codes (sql/point_codes.sql)
  codes := floor(coalesce(pr.cp, '0')::numeric)::bigint;
  -- the market (sql/market.sql): sales of the member's store, and 25% of the sales made through their links
  mk := floor(coalesce(pr.mp, '0')::numeric)::bigint;
  mr := floor(coalesce(pr.mrp, '0')::numeric)::bigint;
  select count(*) into sh from public.post_events where kind = 'share' and network = 'referral' and member_id = p_member;
  select count(*) into pl from public.playlists where owner_id = p_member and visibility in ('public', 'exclusive');
  select count(*) into rc from public.posts where owner_id = p_member and kind in ('recommendation', 'reclist') and visibility in ('public', 'exclusive');
  select count(*) into cm from public.comments where member_id = p_member;
  -- watch links published: 500 links = 1 point; banned links do not count
  if to_regclass('public.movielink') is not null then
    select count(*) into lk from public.movielink where member_id = p_member and coalesce(banned, false) = false;
  end if;
  if to_regclass('public.tvlink') is not null then
    select lk + count(*) into lk from public.tvlink where member_id = p_member and coalesce(banned, false) = false;
  end if;
  -- Clicks on the member's download links: 1000 clicks = 1 point. The counter
  -- (movielink / tvlink .clicks) only exists after sql/links.sql has been run,
  -- so the term is skipped on a database that never had it.
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name in ('movielink', 'tvlink')
      and column_name in ('clicks', 'link_kind')
    group by column_name having count(*) = 2
  ) into has_dl;
  if coalesce(has_dl, false) then
    if to_regclass('public.movielink') is not null then
      execute 'select coalesce(sum(clicks), 0) from public.movielink
               where member_id = $1 and coalesce(link_kind, ''watch'') = ''download'''
        into clicks using p_member;
      dl := dl + coalesce(clicks, 0);
    end if;
    if to_regclass('public.tvlink') is not null then
      execute 'select coalesce(sum(clicks), 0) from public.tvlink
               where member_id = $1 and coalesce(link_kind, ''watch'') = ''download'''
        into clicks using p_member;
      dl := dl + coalesce(clicks, 0);
    end if;
  end if;
  earned := watch + vids + codes + mk + mr + sh / 5 + pl / 10 + rc / 50 + cm / 100 + lk / 500 + dl / 1000;
  return jsonb_build_object('earned', earned, 'spent', pr.spent, 'available', greatest(0, earned - pr.spent),
                            'watch', watch, 'videos', vids, 'codes', codes, 'market', mk, 'market_refs', mr);
end $$;

-- One unit for a member: level multiplier / minutes of the country tier, like
-- _credit_watch (sql/point_levels.sql) but into content_points. NULL for a guest id.
create or replace function public._content_credit(p_member text, p_minutes int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cp_before numeric; cp_after numeric; earned bigint; lv int; lv_after int; mult int; gain numeric(18,2);
begin
  if coalesce(p_member, '') = '' then return null; end if;
  select coalesce(content_points, 0) into cp_before from public.profiles where member_id = p_member for update;
  if not found then return null; end if;
  earned := coalesce((public._points(p_member)->>'earned')::bigint, 0);
  lv := public.points_level(earned);
  mult := public.points_multiplier(lv);
  gain := round(mult::numeric / greatest(1, coalesce(p_minutes, 50)), 2);
  update public.profiles set content_points = coalesce(content_points, 0) + gain, content_units = coalesce(content_units, 0) + 1
   where member_id = p_member
  returning content_points into cp_after;
  lv_after := public.points_level(earned - floor(cp_before)::bigint + floor(cp_after)::bigint);
  if lv_after > lv and to_regclass('public.notifications') is not null then
    insert into public.notifications (member_id, kind, title, body, href)
    values (p_member, 'points_level', 'New level',
            public.points_level_name(lv_after) || ' · ×' || public.points_multiplier(lv_after)::text,
            './dashboard.html#points');
  end if;
  return jsonb_build_object('gain', gain, 'level', lv, 'multiplier', mult, 'content_points', cp_after, 'level_after', lv_after);
end $$;

-- One unit for the member who acted (when it is a member other than the publisher)
-- and one for the publisher (when somebody else acted), at the actor's country tier.
create or replace function public._content_reward(p_owner text, p_actor text, p_country text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cc text; tier int; mins int; res jsonb; got jsonb;
begin
  cc := public._watch_country(p_country);
  tier := public.watch_tier(cc);
  mins := public.watch_tier_minutes(tier);
  res := jsonb_build_object('country', cc, 'tier', tier, 'minutes', mins);
  if coalesce(p_actor, '') <> '' and p_actor <> p_owner then
    got := public._content_credit(p_actor, mins);
    if got is not null then res := res || jsonb_build_object('viewer', got); end if;
  end if;
  if coalesce(p_owner, '') <> '' and coalesce(p_actor, '') <> p_owner then
    got := public._content_credit(p_owner, mins);
    if got is not null then res := res || jsonb_build_object('owner', jsonb_build_object('gain', got->'gain')); end if;
  end if;
  return res;
end $$;

-- ------------------------------------------------------------------ 4. who may see what
-- A signed-in member (active or disabled, never banned); NULL otherwise.
create or replace function public._content_viewer(p_member text) returns public.members
language sql stable security definer set search_path = public as $$
  select m.* from public.members m
  where m.member_id = btrim(coalesce(p_member, '')) and lower(coalesce(m.status, '')) <> 'banned'
$$;

-- Restricted by Panel > Accounts (partial ban on a feature, or a temporary ban).
create or replace function public._content_blocked(p_member text, p_feature text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare s record;
begin
  if to_regclass('public.sanctions') is null then return false; end if;
  select features, temp_until into s from public.sanctions where member_id = p_member;
  if not found then return false; end if;
  if s.temp_until is not null and s.temp_until > now() then return true; end if;
  return p_feature = any (string_to_array(replace(coalesce(s.features, ''), ' ', ''), ','));
end $$;

-- 'ok', or why the member cannot watch: scheduled | gone | private | signin |
-- followers | premium | country | age. The publisher always sees their own videos.
create or replace function public._content_access(c public.content, p_member text) returns text
language plpgsql stable security definer set search_path = public as $$
declare m public.members; yrs int;
begin
  p_member := btrim(coalesce(p_member, ''));
  if p_member <> '' and c.owner_id = p_member then return 'ok'; end if;
  if c.publish_at > now() then return 'scheduled'; end if;
  if exists (select 1 from public.members o where o.member_id = c.owner_id and lower(coalesce(o.status, '')) = 'banned') then
    return 'gone';
  end if;
  m := public._content_viewer(p_member);
  if c.visibility = 'private' then
    if m.member_id is null or not exists (
      select 1 from public.content_access a where a.content_id = c.content_id and lower(a.username) = lower(m.username)
    ) then
      return 'private';
    end if;
  elsif c.visibility = 'exclusive' then
    if m.member_id is null then return 'signin'; end if;
    if c.excl_followers and not exists (
      select 1 from public.follows f
      where f.follower_id = m.member_id and f.following_id = c.owner_id and f.status = 'accepted'
    ) then
      return 'followers';
    end if;
    if c.excl_premium and not (coalesce(m.membership_type, 'Free') in ('Silver', 'Gold', 'Diamond')
                               and (m.membership_expires_at is null or m.membership_expires_at > now())) then
      return 'premium';
    end if;
    if btrim(c.excl_countries) <> ''
       and not (upper(coalesce(m.country, '')) = any (string_to_array(upper(replace(c.excl_countries, ' ', '')), ','))) then
      return 'country';
    end if;
  end if;
  if m.member_id is not null and c.age_rating > 3 and m.birth_date is not null then
    yrs := extract(year from age(current_date, m.birth_date))::int;
    if yrs < c.age_rating then return 'age'; end if;
  end if;
  return 'ok';
end $$;

-- A video as a card (search, suggestions). The link itself is never part of it.
create or replace function public._content_card(c public.content, p_reason text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', c.content_id, 'title', c.title, 'description', left(c.description, 280),
    'thumb', c.thumb_url, 'provider', c.provider, 'tags', to_jsonb(c.tags), 'language', c.language,
    'age', c.age_rating, 'visibility', c.visibility, 'country', c.country,
    'publish_at', c.publish_at, 'created_at', c.created_at,
    'views', c.views, 'likes', c.likes, 'dislikes', c.dislikes, 'comments', c.comments, 'minutes', c.watch_minutes,
    'shares', c.shares, 'owner_id', c.owner_id, 'owner', c.owner_username,
    'owner_avatar', coalesce((select p.avatar_url from public.profiles p where p.member_id = c.owner_id), ''),
    'locked', case when coalesce(p_reason, 'ok') = 'ok' then null else p_reason end)
$$;

-- ------------------------------------------------------------------ 5. followers hear about a new video
-- A publisher's videos stay out of a follower's bell and updates when one blocked the
-- other (sql/profile.sql): the publisher fully or for their updates, the follower fully.
create or replace function public._content_feed_hidden(p_owner text, p_member text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.blocks b
    where (b.blocker_id = p_owner and b.blocked_id = p_member
           and (b.kind = 'full' or 'updates' = any (string_to_array(replace(coalesce(b.features, ''), ' ', ''), ','))))
       or (b.blocker_id = p_member and b.blocked_id = p_owner and b.kind = 'full'))
$$;

create or replace function public._content_notify(p_id text) returns int
language plpgsql security definer set search_path = public as $$
declare c public.content; n int := 0;
begin
  select * into c from public.content where content_id = p_id for update;
  if not found or c.notified or c.publish_at > now() then return 0; end if;
  update public.content set notified = true where content_id = p_id;
  if c.visibility = 'private' or to_regclass('public.notifications') is null then return 0; end if;
  -- the followers who also find it in Profile > Updates (content_feed)
  insert into public.notifications (member_id, kind, title, body, href, from_id, from_username)
  select f.follower_id, 'content', 'New video', c.title, './Content.html?idcontent=' || c.content_id, c.owner_id, c.owner_username
  from public.follows f
  where f.following_id = c.owner_id and f.status = 'accepted' and f.follower_id <> c.owner_id
    and not public._content_feed_hidden(c.owner_id, f.follower_id)
    and public._content_access(c, f.follower_id) not in ('private', 'scheduled', 'gone', 'age')
  limit 500;
  get diagnostics n = row_count;
  return n;
end $$;

-- Scheduled videos whose time has come (pg_cron when enabled, and the search page).
create or replace function public.content_notify_due() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select content_id from public.content where not notified and publish_at <= now() order by publish_at limit 20 loop
    n := n + public._content_notify(r.content_id);
  end loop;
  return n;
end $$;

-- Profile > Updates (the member's own page): the videos of the members they follow
-- (accepted follows), newest first, once published. The rules of the search apply: no
-- private video they were not given, nothing above their age, nothing of a banned
-- publisher; an exclusive video they cannot watch yet comes with its lock. A publisher
-- who blocked the member (fully, or their updates) or whom the member blocked fully is
-- left out. The next page: p_before / p_before_id = publish_at / id of the last card.
-- -> { ok: true, items: [cards], more } | { ok: false, reason: 'member' }
create or replace function public.content_feed(
  p_member text, p_limit int default 20, p_before timestamptz default null, p_before_id text default '')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare m public.members; lim int := least(greatest(coalesce(p_limit, 20), 1), 60); n int; items jsonb;
begin
  m := public._content_viewer(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  with pubs as (
    select distinct f.following_id as owner_id
    from public.follows f
    where f.follower_id = m.member_id and f.status = 'accepted' and f.following_id <> m.member_id
      and not public._content_feed_hidden(f.following_id, m.member_id)
  ), cand as (
    select c as r, public._content_access(c, m.member_id) as why
    from public.content c join pubs on pubs.owner_id = c.owner_id
    where c.publish_at <= now()
      and (p_before is null or c.publish_at < p_before
           or (c.publish_at = p_before and c.content_id < coalesce(p_before_id, '')))
  ), page as (
    select k.r, k.why, row_number() over (order by (k.r).publish_at desc, (k.r).content_id desc) as rn
    from cand k
    where k.why not in ('private', 'scheduled', 'gone', 'age')
    order by (k.r).publish_at desc, (k.r).content_id desc
    limit lim + 1
  )
  select count(*), coalesce(jsonb_agg(public._content_card(p.r, p.why) order by p.rn) filter (where p.rn <= lim), '[]'::jsonb)
    into n, items
  from page p;
  return jsonb_build_object('ok', true, 'items', items, 'more', n > lim);
end $$;

-- ------------------------------------------------------------------ 6. publishing
-- d: { url, provider, thumb, title, description, tags[], language, age, visibility,
--      followers, premium, countries, people[], playlist, playlist_name, publish_at }
-- -> { ok, id, publish_at, scheduled } | { ok: false, reason }
create or replace function public.content_create(p_member text, d jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  m public.members; cid text; url text; title text; descr text; vis text; age int; lang text; prov text; thumb text;
  tags text[]; people text[]; cty text; pub timestamptz; pid text; pname text; recent int; i int := 0; u text;
begin
  m := public._content_viewer(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if public._content_blocked(m.member_id, 'posts') then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  select count(*) into recent from public.content where owner_id = m.member_id and created_at > now() - interval '1 day';
  if recent >= 50 then return jsonb_build_object('ok', false, 'reason', 'limit'); end if;

  url := btrim(coalesce(d->>'url', ''));
  if url !~* '^https?://[^/?#[:space:]]+' or length(url) > 2000 or url ~ '[[:space:]<>"`]' then
    return jsonb_build_object('ok', false, 'reason', 'url');
  end if;
  title := btrim(regexp_replace(coalesce(d->>'title', ''), '[[:cntrl:]]', ' ', 'g'));
  if char_length(title) < 1 or char_length(title) > 150 then return jsonb_build_object('ok', false, 'reason', 'title'); end if;
  descr := btrim(coalesce(d->>'description', ''));
  if char_length(descr) > 5000 then return jsonb_build_object('ok', false, 'reason', 'description'); end if;
  prov := lower(coalesce(d->>'provider', 'link'));
  if prov not in ('youtube', 'vimeo', 'dailymotion', 'facebook', 'drive', 'tiktok', 'file', 'hls', 'link') then prov := 'link'; end if;
  thumb := btrim(coalesce(d->>'thumb', ''));
  if thumb <> '' and (thumb !~* '^https://[^/?#[:space:]]+' or length(thumb) > 1000 or thumb ~ '[[:space:]<>"`]') then thumb := ''; end if;
  -- tags: lower case, no "#", 1 to 30 characters, 12 at most
  select coalesce(array_agg(t order by n), '{}') into tags from (
    select distinct on (t) t, n from (
      select lower(btrim(regexp_replace(x, '^#+', ''))) as t, n
      from jsonb_array_elements_text(case when jsonb_typeof(d->'tags') = 'array' then d->'tags' else '[]'::jsonb end)
           with ordinality as e(x, n)
    ) s where char_length(t) between 1 and 30 order by t, n
  ) z;
  if array_length(tags, 1) > 12 then tags := tags[1:12]; end if;
  lang := btrim(coalesce(d->>'language', ''));
  if char_length(lang) > 40 then lang := left(lang, 40); end if;
  age := coalesce(nullif(d->>'age', '')::int, 3);
  if age not in (3, 6, 13, 16, 18) then return jsonb_build_object('ok', false, 'reason', 'age'); end if;
  vis := coalesce(d->>'visibility', 'public');
  if vis not in ('public', 'exclusive', 'private') then return jsonb_build_object('ok', false, 'reason', 'visibility'); end if;
  cty := upper(regexp_replace(coalesce(d->>'countries', ''), '[^A-Za-z,]', '', 'g'));
  select coalesce(array_agg(distinct x), '{}') into people from (
    select lower(btrim(regexp_replace(x, '^@+', ''))) as x
    from jsonb_array_elements_text(case when jsonb_typeof(d->'people') = 'array' then d->'people' else '[]'::jsonb end) as e(x)
  ) s where x <> '' and char_length(x) <= 60;
  if vis = 'private' and coalesce(array_length(people, 1), 0) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'people');
  end if;
  if coalesce(array_length(people, 1), 0) > 100 then return jsonb_build_object('ok', false, 'reason', 'people'); end if;
  pub := coalesce(nullif(d->>'publish_at', '')::timestamptz, now());
  if pub < now() then pub := now(); end if;
  if pub > now() + interval '1 year' then return jsonb_build_object('ok', false, 'reason', 'publish_at'); end if;

  -- the playlist: one of the member's own, or a new one by name
  pid := nullif(btrim(coalesce(d->>'playlist', '')), '');
  pname := btrim(coalesce(d->>'playlist_name', ''));
  if pid is not null and not exists (select 1 from public.content_playlists where playlist_id = pid and owner_id = m.member_id) then
    return jsonb_build_object('ok', false, 'reason', 'playlist');
  end if;
  if pid is null and pname <> '' then
    if char_length(pname) > 80 then return jsonb_build_object('ok', false, 'reason', 'playlist'); end if;
    select playlist_id into pid from public.content_playlists where owner_id = m.member_id and lower(name) = lower(pname) limit 1;
    if pid is null then
      loop
        pid := 'CPL' || lpad((floor(random() * 1e9))::bigint::text, 9, '0');
        exit when not exists (select 1 from public.content_playlists where playlist_id = pid);
      end loop;
      insert into public.content_playlists (playlist_id, owner_id, owner_username, name) values (pid, m.member_id, m.username, pname);
    end if;
  end if;

  loop
    cid := 'CT' || lpad((floor(random() * 1e10))::bigint::text, 10, '0');
    exit when not exists (select 1 from public.content where content_id = cid);
    i := i + 1;
    if i > 20 then return jsonb_build_object('ok', false, 'reason', 'busy'); end if;
  end loop;
  insert into public.content (content_id, owner_id, owner_username, video_url, provider, thumb_url, title, description,
                              tags, language, age_rating, visibility, excl_followers, excl_premium, excl_countries,
                              country, playlist_id, publish_at)
  values (cid, m.member_id, m.username, url, prov, thumb, title, descr, tags, lang, age, vis,
          vis = 'exclusive' and coalesce((d->>'followers')::boolean, false),
          vis = 'exclusive' and coalesce((d->>'premium')::boolean, false),
          case when vis = 'exclusive' then cty else '' end,
          upper(coalesce(m.country, '')), pid, pub);
  if vis = 'private' then
    foreach u in array people loop
      insert into public.content_access (content_id, username) values (cid, u) on conflict do nothing;
    end loop;
  end if;
  if pid is not null then
    insert into public.content_playlist_items (playlist_id, content_id) values (pid, cid) on conflict do nothing;
  end if;
  if pub <= now() then perform public._content_notify(cid); end if;
  return jsonb_build_object('ok', true, 'id', cid, 'publish_at', pub, 'scheduled', pub > now(), 'playlist', pid);
end $$;

-- "Publish now" of a scheduled video.
create or replace function public.content_publish_now(p_member text, p_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c public.content;
begin
  select * into c from public.content where content_id = p_id and owner_id = btrim(coalesce(p_member, '')) for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if c.publish_at > now() then
    update public.content set publish_at = now() where content_id = p_id;
  end if;
  perform public._content_notify(p_id);
  return jsonb_build_object('ok', true, 'id', p_id, 'publish_at', least(c.publish_at, now()));
end $$;

create or replace function public.content_delete(p_member text, p_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  delete from public.content where content_id = p_id and owner_id = btrim(coalesce(p_member, ''));
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- Profile > Your content > Manage: every video of the member, newest first.
create or replace function public.content_mine(p_member text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.content_id, 'title', c.title, 'description', c.description, 'url', c.video_url, 'provider', c.provider,
    'thumb', c.thumb_url, 'tags', to_jsonb(c.tags), 'language', c.language, 'age', c.age_rating,
    'visibility', c.visibility, 'followers', c.excl_followers, 'premium', c.excl_premium, 'countries', c.excl_countries,
    'country', c.country, 'publish_at', c.publish_at, 'created_at', c.created_at, 'scheduled', c.publish_at > now(),
    'views', c.views, 'impressions', c.impressions, 'clicks', c.clicks, 'likes', c.likes, 'dislikes', c.dislikes,
    'shares', c.shares, 'comments', c.comments, 'playlists_count', c.playlists, 'minutes', c.watch_minutes,
    'people', coalesce((select jsonb_agg(a.username order by a.username) from public.content_access a where a.content_id = c.content_id), '[]'::jsonb),
    'playlists', coalesce((select jsonb_agg(jsonb_build_object('id', p.playlist_id, 'name', p.name) order by p.name)
                           from public.content_playlist_items i join public.content_playlists p on p.playlist_id = i.playlist_id
                           where i.content_id = c.content_id and p.owner_id = c.owner_id), '[]'::jsonb)
  ) order by c.created_at desc), '[]'::jsonb)
  from public.content c where c.owner_id = btrim(coalesce(p_member, ''));
$$;

-- ------------------------------------------------------------------ 7. watching
-- Content.html: the video, if the viewer may watch it.
-- -> { ok: true, access: 'ok' | 'signin' | 'followers' | 'premium' | 'country' | 'age',
--      content: {..., url only when access = ok and the video is rated under 13,
--                code: true when it is rated 13+ (content_unlock gives the link)},
--      owner: {...}, my_vote, mine }
--    { ok: false, reason: not_found | private | scheduled | gone }
create or replace function public.content_get(p_id text, p_member text default '') returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c public.content; why text; o record; v int;
begin
  select * into c from public.content where content_id = btrim(coalesce(p_id, ''));
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  why := public._content_access(c, p_member);
  if why in ('private', 'scheduled', 'gone') then return jsonb_build_object('ok', false, 'reason', why); end if;
  select m.member_id, m.username, coalesce(p.display_name, '') as display_name, coalesce(p.avatar_url, '') as avatar_url,
         coalesce(p.followers, 0) as followers
    into o
  from public.members m left join public.profiles p on p.member_id = m.member_id
  where m.member_id = c.owner_id;
  select vote into v from public.content_votes where content_id = c.content_id and member_id = btrim(coalesce(p_member, ''));
  return jsonb_build_object(
    'ok', true, 'access', why, 'mine', c.owner_id = btrim(coalesce(p_member, '')),
    'content', public._content_card(c, why) || jsonb_build_object(
      'description', c.description, 'url', case when why = 'ok' and c.age_rating < 13 then c.video_url else null end,
      'code', c.age_rating >= 13,
      'shares', c.shares, 'playlists', c.playlists, 'excl_followers', c.excl_followers,
      'excl_premium', c.excl_premium, 'excl_countries', c.excl_countries),
    'owner', jsonb_build_object('id', c.owner_id, 'username', coalesce(o.username, c.owner_username),
                                'display_name', o.display_name, 'avatar_url', o.avatar_url, 'followers', o.followers),
    'my_vote', coalesce(v, 0));
end $$;

-- Content.html, a video rated 13+: its link for a watch code (sql/code_devices.sql,
-- code_use: the code's state, its age tier against the rating, one device per code).
--   p_silent  the code remembered on this device (not typed): only while it is still
--             linked to this device
--   p_link    "Remember the code" ticked: the code is linked to this device
-- -> { ok: true, url, age, linked, kept, ip, freed, ... }   (the answer of code_use)
--    { ok: false, reason: no_video | access (+ access) | setup | the refusals of
--      code_use: invalid | device | not_found (the code) | expired | disabled | banned |
--      age (+ age_rating) | other_device (+ device_tail) | unlinked }
create or replace function public.content_unlock(
  p_id text, p_member text default '', p_code text default '', p_mac text default '',
  p_name text default '', p_ip text default '', p_silent boolean default false, p_link boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.content; why text; res jsonb;
begin
  select * into c from public.content where content_id = btrim(coalesce(p_id, ''));
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_video'); end if;
  why := public._content_access(c, p_member);
  if why <> 'ok' then return jsonb_build_object('ok', false, 'reason', 'access', 'access', why); end if;
  if c.age_rating < 13 then
    return jsonb_build_object('ok', true, 'url', c.video_url, 'age', c.age_rating, 'code', false);
  end if;
  if to_regprocedure('public.code_use(text, text, text, text, integer, boolean, text, boolean)') is null then
    return jsonb_build_object('ok', false, 'reason', 'setup');
  end if;
  res := public.code_use(btrim(coalesce(p_code, '')), p_mac, coalesce(p_name, ''), coalesce(p_ip, ''),
                         c.age_rating::int, coalesce(p_silent, false), 'web', coalesce(p_link, false));
  if not coalesce((res ->> 'ok')::boolean, false) then
    return res;
  end if;
  return res || jsonb_build_object('url', c.video_url, 'age', c.age_rating, 'code', true);
end $$;

-- Search.html and the search box of Content.html.
--   p_sort: relevance | views | recs | date | az | za, and for the 50 videos of
--           Content.html: minutes (watched minutes) | shares (recs = most recommended)
--   p_lang (language), p_country (region of the video), p_age (3 6 13 16 18), p_owner (username), p_tag
-- Public and exclusive videos, and the private ones the member was given; never
-- scheduled ones, those of banned publishers, or a rating above a member's age.
create or replace function public.content_search(
  p_member text default '', p_q text default '', p_sort text default '', p_lang text default '',
  p_country text default '', p_age int default null, p_owner text default '', p_tag text default '',
  p_limit int default 24, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  words text[]; w text; q text := btrim(coalesce(p_q, '')); lim int := least(greatest(coalesce(p_limit, 24), 1), 60);
  off int := greatest(coalesce(p_offset, 0), 0); total int; items jsonb; srt text := lower(coalesce(p_sort, ''));
begin
  select coalesce(array_agg(x), '{}') into words from (
    select replace(replace(replace(lower(x), '\', '\\'), '%', '\%'), '_', '\_') as x
    from regexp_split_to_table(q, '\s+') as x where x <> '' limit 8
  ) s;
  if srt not in ('relevance', 'views', 'recs', 'date', 'az', 'za', 'minutes', 'shares') then srt := case when q = '' then 'date' else 'relevance' end; end if;
  with base as (
    select c as r, public._content_access(c, p_member) as why
    from public.content c
    where (c.publish_at <= now())
      and (coalesce(p_lang, '') = '' or c.language = p_lang)
      and (coalesce(p_country, '') = '' or c.country = upper(p_country))
      and (p_age is null or c.age_rating = p_age)
      and (coalesce(p_owner, '') = '' or lower(c.owner_username) = lower(btrim(regexp_replace(p_owner, '^@+', ''))))
      and (coalesce(p_tag, '') = '' or lower(btrim(regexp_replace(p_tag, '^#+', ''))) = any (c.tags))
      and not exists (
        select 1 from unnest(words) as ww(x)
        where (lower(c.title) || ' ' || lower(c.description) || ' ' || lower(array_to_string(c.tags, ' ')) || ' ' || lower(c.owner_username))
              not like '%' || ww.x || '%'
      )
  ), seen as (
    select * from base where why not in ('private', 'scheduled', 'gone', 'age')
  )
  select (select count(*) from seen),
         coalesce((select jsonb_agg(public._content_card(s2.r, s2.why) order by s2.rn) from (
           select s.r, s.why, row_number() over (order by
             case when srt = 'relevance' then (case when lower((s.r).title) like '%' || lower(q) || '%' then 0 else 1 end) end,
             case when srt = 'views' then (s.r).views end desc,
             case when srt = 'recs' then (s.r).likes end desc,
             case when srt = 'recs' then (s.r).likes - (s.r).dislikes end desc,
             case when srt = 'minutes' then (s.r).watch_minutes end desc,
             case when srt = 'shares' then (s.r).shares end desc,
             case when srt = 'az' then lower((s.r).title) end asc,
             case when srt = 'za' then lower((s.r).title) end desc,
             case when srt in ('relevance', 'minutes', 'shares') then (s.r).views end desc,
             (s.r).publish_at desc, (s.r).content_id) as rn
           from seen s
           order by rn
           offset off limit lim
         ) s2), '[]'::jsonb)
    into total, items;
  return jsonb_build_object('total', total, 'items', items, 'sort', srt);
end $$;

-- Content.html, the side column. First the videos under the same tags AND in the
-- same language (the publisher's own ones first); when no video matches both, the
-- videos of the same country. Each group is ordered by how many of the criteria
-- (shared tags, language, publisher) a video matches; the rest of the list is
-- filled with the next group, so the column is never empty while there are videos.
create or replace function public.content_suggest(p_id text, p_member text default '', p_limit int default 12)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c public.content; lim int := least(greatest(coalesce(p_limit, 12), 1), 30); items jsonb;
begin
  select * into c from public.content where content_id = btrim(coalesce(p_id, ''));
  if not found then return '[]'::jsonb; end if;
  with cand as (
    select x as r, public._content_access(x, p_member) as why,
           (select count(*) from unnest(x.tags) t where t = any (c.tags))::int as shared,
           (x.language <> '' and x.language = c.language) as same_lang,
           (x.owner_id = c.owner_id) as same_user,
           (x.country <> '' and x.country = c.country) as same_country,
           x.views, x.publish_at
    from public.content x
    where x.content_id <> c.content_id and x.publish_at <= now()
  ), scored as (
    select k.*, (k.shared > 0 and k.same_lang) as pool_a,
           ((k.shared > 0)::int + k.same_lang::int + k.same_user::int) as matched
    from cand k
    where k.why not in ('private', 'scheduled', 'gone', 'age')
  ), tiered as (
    select s.*,
           case when s.pool_a then 0
                when s.same_country then 1
                when s.matched > 0 then 2
                else 3 end as tier
    from scored s
  ), picked as (
    select * from tiered
    order by tier, matched desc, shared desc, same_user desc, views desc, publish_at desc
    limit lim
  )
  select coalesce(jsonb_agg(public._content_card(p.r, p.why) || jsonb_build_object(
           'match', jsonb_build_object('tags', p.shared, 'language', p.same_lang, 'user', p.same_user,
                                       'country', p.same_country, 'tier', p.tier))
         order by p.tier, p.matched desc, p.shared desc, p.same_user desc, p.views desc, p.publish_at desc), '[]'::jsonb)
    into items
  from picked p;
  return items;
end $$;

-- Impressions (a card seen in a list), clicks on those cards, views (the page of
-- the video) and shares. Counted once per viewer and video every 30 minutes
-- (clicks: 2 minutes, shares: 10 minutes per network). A share by a member earns
-- points once a day per video (sql header). At most 60 videos per call.
-- -> { ok, logged, points? }
create or replace function public.content_track(p_ids text[], p_kind text, p_viewer text, p_network text default '', p_country text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v text := btrim(coalesce(p_viewer, '')); k text := lower(coalesce(p_kind, '')); net text := left(lower(btrim(coalesce(p_network, ''))), 20);
  win interval; cid text; c public.content; n int := 0; why text; m public.members; pts jsonb := null;
begin
  if k not in ('impression', 'click', 'view', 'share') or v = '' or length(v) > 120 then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;
  win := case k when 'click' then interval '2 minutes' when 'share' then interval '10 minutes' else interval '30 minutes' end;
  foreach cid in array coalesce(p_ids[1:60], '{}') loop
    select * into c from public.content where content_id = cid;
    continue when not found;
    why := public._content_access(c, v);
    continue when why in ('private', 'scheduled', 'gone');
    continue when k in ('view', 'share') and why <> 'ok';
    continue when c.owner_id = v;  -- the publisher's own visits are not counted
    continue when exists (
      select 1 from public.content_events e
      where e.content_id = cid and e.kind = k and e.viewer = v and e.created_at > now() - win
        and (k <> 'share' or e.network = net)
    );
    insert into public.content_events (content_id, kind, viewer, network) values (cid, k, v, case when k = 'share' then net else '' end);
    n := n + 1;
    if k = 'share' then
      m := public._content_viewer(v);
      if m.member_id is not null then
        insert into public.content_point_log (member_id, content_id, kind) values (m.member_id, cid, 'share') on conflict do nothing;
        if found then pts := public._content_reward(c.owner_id, m.member_id, p_country); end if;
      end if;
    end if;
  end loop;
  if k = 'impression' and random() < 0.2 then perform public.content_notify_due(); end if;
  return jsonb_build_object('ok', true, 'logged', n) || case when pts is null then '{}'::jsonb else jsonb_build_object('points', pts) end;
end $$;

-- One counted minute of a video (Content.html calls it once a minute while it plays).
-- Shares the 45-second clock of watch_minute() (sql/point_levels.sql), so two pages
-- playing at once still earn one minute at a time.
-- -> { ok, country, tier, minutes, viewer?: {gain…}, owner?: {gain} } | { ok: false, reason }
create or replace function public.content_minute(p_id text, p_viewer text, p_country text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v text := btrim(coalesce(p_viewer, '')); c public.content; m public.members; res jsonb;
begin
  if v = '' or length(v) > 120 then return jsonb_build_object('ok', false, 'reason', 'bad_request'); end if;
  select * into c from public.content where content_id = btrim(coalesce(p_id, ''));
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if public._content_access(c, v) <> 'ok' then return jsonb_build_object('ok', false, 'reason', 'access'); end if;
  insert into public.watch_point_clock as k (viewer_id, credited_at) values (v, now())
  on conflict (viewer_id) do update set credited_at = excluded.credited_at
   where k.credited_at <= now() - interval '45 seconds';
  if not found then return jsonb_build_object('ok', false, 'reason', 'too_soon'); end if;
  if c.owner_id <> v then
    insert into public.content_events (content_id, kind, viewer) values (c.content_id, 'minute', v);
  end if;
  m := public._content_viewer(v);
  res := public._content_reward(c.owner_id, coalesce(m.member_id, ''), p_country);
  return jsonb_build_object('ok', true) || res;
end $$;

-- Recommend (1), don't recommend (-1) or take the vote back (0).
-- The first positive recommendation of a member for a video earns points.
create or replace function public.content_vote(p_member text, p_id text, p_vote int, p_country text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members; c public.content; prev record; pts jsonb := null; first_up boolean := false;
begin
  m := public._content_viewer(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if public._content_blocked(m.member_id, 'posts') then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  select * into c from public.content where content_id = btrim(coalesce(p_id, ''));
  if not found or public._content_access(c, m.member_id) <> 'ok' then return jsonb_build_object('ok', false, 'reason', 'access'); end if;
  if p_vote not in (-1, 0, 1) then return jsonb_build_object('ok', false, 'reason', 'bad_request'); end if;
  select vote, credited into prev from public.content_votes where content_id = c.content_id and member_id = m.member_id for update;
  if p_vote = 0 then
    delete from public.content_votes where content_id = c.content_id and member_id = m.member_id;
  elsif prev.vote is null then
    first_up := p_vote = 1;
    insert into public.content_votes (content_id, member_id, vote, credited) values (c.content_id, m.member_id, p_vote, p_vote = 1);
  else
    first_up := p_vote = 1 and not prev.credited;
    update public.content_votes set vote = p_vote, updated_at = now(), credited = credited or p_vote = 1
     where content_id = c.content_id and member_id = m.member_id;
  end if;
  if first_up and c.owner_id <> m.member_id then
    pts := public._content_reward(c.owner_id, m.member_id, p_country);
  end if;
  select likes, dislikes into c.likes, c.dislikes from public.content where content_id = c.content_id;
  return jsonb_build_object('ok', true, 'vote', p_vote, 'likes', c.likes, 'dislikes', c.dislikes)
         || case when pts is null then '{}'::jsonb else jsonb_build_object('points', pts) end;
end $$;

-- ------------------------------------------------------------------ 8. comments
create or replace function public.content_comments_list(p_id text, p_member text default '', p_limit int default 200)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c public.content; me text := btrim(coalesce(p_member, ''));
begin
  select * into c from public.content where content_id = btrim(coalesce(p_id, ''));
  if not found or public._content_access(c, me) <> 'ok' then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', k.id, 'member_id', k.member_id, 'username', k.username, 'body', k.body, 'parent_id', k.parent_id,
      'created_at', k.created_at, 'avatar_url', coalesce(p.avatar_url, ''),
      'can_delete', me <> '' and (k.member_id = me or c.owner_id = me),
      'is_owner', k.member_id = c.owner_id)
      order by k.created_at)
    from (select * from public.content_comments where content_id = c.content_id
          order by created_at desc limit least(greatest(coalesce(p_limit, 200), 1), 500)) k
    left join public.profiles p on p.member_id = k.member_id), '[]'::jsonb);
end $$;

-- A comment earns points once per member, video and day; the publisher hears about it.
create or replace function public.content_comment_add(p_member text, p_id text, p_body text, p_parent bigint default null, p_country text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members; c public.content; b text := btrim(coalesce(p_body, '')); recent int; row_id bigint; pts jsonb := null;
begin
  m := public._content_viewer(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if public._content_blocked(m.member_id, 'comments') then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  select * into c from public.content where content_id = btrim(coalesce(p_id, ''));
  if not found or public._content_access(c, m.member_id) <> 'ok' then return jsonb_build_object('ok', false, 'reason', 'access'); end if;
  if char_length(b) < 1 or char_length(b) > 2000 then return jsonb_build_object('ok', false, 'reason', 'length'); end if;
  if p_parent is not null and not exists (select 1 from public.content_comments where id = p_parent and content_id = c.content_id) then
    return jsonb_build_object('ok', false, 'reason', 'parent');
  end if;
  select count(*) into recent from public.content_comments where member_id = m.member_id and created_at > now() - interval '1 minute';
  if recent >= 6 then return jsonb_build_object('ok', false, 'reason', 'slow'); end if;
  insert into public.content_comments (content_id, member_id, username, body, parent_id)
  values (c.content_id, m.member_id, m.username, b, p_parent) returning id into row_id;
  if c.owner_id <> m.member_id then
    insert into public.content_point_log (member_id, content_id, kind) values (m.member_id, c.content_id, 'comment') on conflict do nothing;
    if found then pts := public._content_reward(c.owner_id, m.member_id, p_country); end if;
    if to_regclass('public.notifications') is not null then
      insert into public.notifications (member_id, kind, title, body, href, from_id, from_username)
      values (c.owner_id, 'content_comment', 'New comment', '@' || m.username || ': ' || left(b, 120),
              './Content.html?idcontent=' || c.content_id || '#comments', m.member_id, m.username);
    end if;
  end if;
  return jsonb_build_object('ok', true, 'id', row_id)
         || case when pts is null then '{}'::jsonb else jsonb_build_object('points', pts) end;
end $$;

-- The author of a comment, or the publisher of the video, can delete it.
create or replace function public.content_comment_delete(p_member text, p_comment bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me text := btrim(coalesce(p_member, ''));
begin
  delete from public.content_comments k
  using public.content c
  where k.id = p_comment and c.content_id = k.content_id and me <> '' and (k.member_id = me or c.owner_id = me);
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- ------------------------------------------------------------------ 9. playlists
-- The member's playlists; with p_content, whether that video is in each one.
create or replace function public.content_playlists_mine(p_member text, p_content text default '')
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.playlist_id, 'name', p.name, 'created_at', p.created_at,
    'count', (select count(*) from public.content_playlist_items i where i.playlist_id = p.playlist_id),
    'has', exists (select 1 from public.content_playlist_items i where i.playlist_id = p.playlist_id and i.content_id = btrim(coalesce(p_content, ''))))
    order by lower(p.name)), '[]'::jsonb)
  from public.content_playlists p where p.owner_id = btrim(coalesce(p_member, ''));
$$;

-- Add a video the member can watch to one of their playlists, or to a new one (p_name).
create or replace function public.content_playlist_add(p_member text, p_content text, p_playlist text default '', p_name text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members; c public.content; pid text := nullif(btrim(coalesce(p_playlist, '')), ''); nm text := btrim(coalesce(p_name, ''));
begin
  m := public._content_viewer(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  select * into c from public.content where content_id = btrim(coalesce(p_content, ''));
  if not found or public._content_access(c, m.member_id) <> 'ok' then return jsonb_build_object('ok', false, 'reason', 'access'); end if;
  if pid is null then
    if char_length(nm) < 1 or char_length(nm) > 80 then return jsonb_build_object('ok', false, 'reason', 'name'); end if;
    select playlist_id into pid from public.content_playlists where owner_id = m.member_id and lower(name) = lower(nm) limit 1;
    if pid is null then
      if (select count(*) from public.content_playlists where owner_id = m.member_id) >= 200 then
        return jsonb_build_object('ok', false, 'reason', 'limit');
      end if;
      loop
        pid := 'CPL' || lpad((floor(random() * 1e9))::bigint::text, 9, '0');
        exit when not exists (select 1 from public.content_playlists where playlist_id = pid);
      end loop;
      insert into public.content_playlists (playlist_id, owner_id, owner_username, name) values (pid, m.member_id, m.username, nm);
    end if;
  elsif not exists (select 1 from public.content_playlists where playlist_id = pid and owner_id = m.member_id) then
    return jsonb_build_object('ok', false, 'reason', 'playlist');
  end if;
  insert into public.content_playlist_items (playlist_id, content_id) values (pid, c.content_id) on conflict do nothing;
  return jsonb_build_object('ok', true, 'playlist', pid, 'added', found,
                            'name', (select name from public.content_playlists where playlist_id = pid));
end $$;

create or replace function public.content_playlist_remove(p_member text, p_content text, p_playlist text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  delete from public.content_playlist_items i
  using public.content_playlists p
  where i.playlist_id = p.playlist_id and p.playlist_id = p_playlist and p.owner_id = btrim(coalesce(p_member, ''))
    and i.content_id = p_content;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- A member's page > Content > Playlists: the playlists of p_owner (a member id). The
-- owner sees every one of them, empty ones too; anybody else only those holding at
-- least one video they may find (the rules of the search: published videos only, the
-- owner's too), counted for them. The picture is the one of the first of those
-- videos; the newest addition comes first.
-- -> [{ id, name, created_at, updated_at, count, thumb, first, mine }]
create or replace function public.content_playlists_of(p_owner text, p_member text default '')
returns jsonb language sql stable security definer set search_path = public as $$
  with lists as (
    select p.playlist_id, p.name, p.created_at, (p.owner_id = btrim(coalesce(p_member, ''))) as mine
    from public.content_playlists p
    join public.members o on o.member_id = p.owner_id and lower(coalesce(o.status, '')) <> 'banned'
    where p.owner_id = btrim(coalesce(p_owner, ''))
  ), seen as (
    select i.playlist_id, i.added_at, c.content_id, c.thumb_url,
           row_number() over (partition by i.playlist_id order by i.added_at, c.content_id) as pos
    from public.content_playlist_items i
    join lists l on l.playlist_id = i.playlist_id
    join public.content c on c.content_id = i.content_id
    where c.publish_at <= now() and public._content_access(c, p_member) not in ('private', 'scheduled', 'gone', 'age')
  ), agg as (
    select s.playlist_id, count(*) as n, max(s.added_at) as updated_at,
           max(s.content_id) filter (where s.pos = 1) as first,
           coalesce(max(s.thumb_url) filter (where s.pos = 1), '') as thumb
    from seen s group by s.playlist_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.playlist_id, 'name', l.name, 'created_at', l.created_at,
           'updated_at', coalesce(a.updated_at, l.created_at), 'count', coalesce(a.n, 0),
           'thumb', coalesce(a.thumb, ''), 'first', a.first, 'mine', l.mine)
         order by coalesce(a.updated_at, l.created_at) desc, lower(l.name), l.playlist_id), '[]'::jsonb)
  from lists l left join agg a on a.playlist_id = l.playlist_id
  where l.mine or coalesce(a.n, 0) > 0;
$$;

-- One playlist (a member's page > Content > Playlists): the videos of it the viewer may
-- find (published ones, as in the search), in the order they were added. Not found for
-- anybody but its owner when it holds none of those (and for everybody when its owner
-- is banned).
-- -> { ok: true, playlist: { id, name, owner_id, owner, created_at, updated_at, count, mine },
--      items: [cards + added_at], total }
--    { ok: false, reason: 'not_found' }
create or replace function public.content_playlist_get(
  p_playlist text, p_member text default '', p_limit int default 60, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  p public.content_playlists; is_mine boolean; total int; upd timestamptz; items jsonb;
  lim int := least(greatest(coalesce(p_limit, 60), 1), 100); off int := greatest(coalesce(p_offset, 0), 0);
begin
  select * into p from public.content_playlists where playlist_id = btrim(coalesce(p_playlist, ''));
  if not found or exists (
    select 1 from public.members o where o.member_id = p.owner_id and lower(coalesce(o.status, '')) = 'banned'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  is_mine := p.owner_id = btrim(coalesce(p_member, ''));
  with seen as (
    select c as r, public._content_access(c, p_member) as why, i.added_at
    from public.content_playlist_items i join public.content c on c.content_id = i.content_id
    where i.playlist_id = p.playlist_id and c.publish_at <= now()
  ), ok as (
    select * from seen where why not in ('private', 'scheduled', 'gone', 'age')
  )
  select (select count(*) from ok), (select max(added_at) from ok),
         coalesce((select jsonb_agg(public._content_card(z.r, z.why) || jsonb_build_object('added_at', z.added_at)
                                    order by z.added_at, (z.r).content_id)
                   from (select * from ok order by added_at, (r).content_id offset off limit lim) z), '[]'::jsonb)
    into total, upd, items;
  if total = 0 and not is_mine then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'items', items, 'total', total,
    'playlist', jsonb_build_object(
      'id', p.playlist_id, 'name', p.name, 'owner_id', p.owner_id,
      'owner', coalesce((select m.username from public.members m where m.member_id = p.owner_id), p.owner_username),
      'created_at', p.created_at, 'updated_at', coalesce(upd, p.created_at), 'count', total, 'mine', is_mine));
end $$;

-- ------------------------------------------------------------------ 10. tags and statistics
-- Tags already used (Create > Tags): the most used first, matching p_q.
create or replace function public.content_tags(p_q text default '', p_member text default '', p_limit int default 20)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('tag', t, 'count', n) order by n desc, t), '[]'::jsonb)
  from (
    select t, count(*) as n
    from public.content c, unnest(c.tags) as t
    where (c.owner_id = btrim(coalesce(p_member, '')) or (c.visibility in ('public', 'exclusive') and c.publish_at <= now()))
      and (btrim(coalesce(p_q, '')) = '' or t like '%' || replace(replace(replace(lower(btrim(regexp_replace(p_q, '^#+', ''))), '\', '\\'), '%', '\%'), '_', '\_') || '%')
    group by t
    order by count(*) desc, t
    limit least(greatest(coalesce(p_limit, 20), 1), 50)
  ) s;
$$;

-- Profile > Your content > Statistics: what happened to each video of the member
-- between p_from and p_to (null = since the beginning / until now).
create or replace function public.content_stats(p_member text, p_from timestamptz default null, p_to timestamptz default null)
returns jsonb language sql stable security definer set search_path = public as $$
  with mine as (
    select * from public.content where owner_id = btrim(coalesce(p_member, ''))
  ), ev as (
    select e.content_id,
           count(*) filter (where e.kind = 'impression') as impressions,
           count(*) filter (where e.kind = 'click') as clicks,
           count(*) filter (where e.kind = 'view') as views,
           count(*) filter (where e.kind = 'share') as shares,
           count(*) filter (where e.kind = 'minute') as minutes
    from public.content_events e join mine on mine.content_id = e.content_id
    where (p_from is null or e.created_at >= p_from) and (p_to is null or e.created_at < p_to)
    group by e.content_id
  ), vo as (
    select v.content_id, count(*) filter (where v.vote = 1) as likes, count(*) filter (where v.vote = -1) as dislikes
    from public.content_votes v join mine on mine.content_id = v.content_id
    where (p_from is null or v.updated_at >= p_from) and (p_to is null or v.updated_at < p_to)
    group by v.content_id
  ), co as (
    select k.content_id, count(*) as comments
    from public.content_comments k join mine on mine.content_id = k.content_id
    where (p_from is null or k.created_at >= p_from) and (p_to is null or k.created_at < p_to)
    group by k.content_id
  ), pl as (
    select i.content_id, count(*) as playlists
    from public.content_playlist_items i join mine on mine.content_id = i.content_id
    where (p_from is null or i.added_at >= p_from) and (p_to is null or i.added_at < p_to)
    group by i.content_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.content_id, 'title', m.title, 'thumb', m.thumb_url, 'provider', m.provider, 'url', m.video_url,
    'created_at', m.created_at, 'publish_at', m.publish_at, 'visibility', m.visibility,
    'impressions', coalesce(ev.impressions, 0), 'clicks', coalesce(ev.clicks, 0), 'views', coalesce(ev.views, 0),
    'shares', coalesce(ev.shares, 0), 'minutes', coalesce(ev.minutes, 0),
    'likes', coalesce(vo.likes, 0), 'dislikes', coalesce(vo.dislikes, 0),
    'comments', coalesce(co.comments, 0), 'playlists', coalesce(pl.playlists, 0))
    order by coalesce(ev.views, 0) desc, m.created_at desc), '[]'::jsonb)
  from mine m
  left join ev on ev.content_id = m.content_id
  left join vo on vo.content_id = m.content_id
  left join co on co.content_id = m.content_id
  left join pl on pl.content_id = m.content_id;
$$;

-- ------------------------------------------------------------------ 11. scheduled notifications (optional pg_cron)
do $$
begin
  begin
    create extension if not exists pg_cron;
    perform cron.unschedule('content_notify_due') where exists (select 1 from cron.job where jobname = 'content_notify_due');
    perform cron.schedule('content_notify_due', '*/5 * * * *', 'select public.content_notify_due()');
  exception when others then
    raise notice 'pg_cron is not enabled: followers hear about a scheduled video when the search page is next used.';
  end;
end $$;

-- ------------------------------------------------------------------ 12. who may call what
do $$
declare f text;
begin
  foreach f in array array[
    'public._content_count_votes()', 'public._content_count_comments()', 'public._content_count_items()',
    'public._content_count_events()', 'public._guard_content_points()', 'public._points(text)',
    'public._content_credit(text, int)', 'public._content_reward(text, text, text)',
    'public._content_viewer(text)', 'public._content_blocked(text, text)',
    'public._content_access(public.content, text)', 'public._content_card(public.content, text)',
    'public._content_feed_hidden(text, text)', 'public._content_notify(text)', 'public.content_notify_due()']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.content_create(text, jsonb)', 'public.content_publish_now(text, text)', 'public.content_delete(text, text)',
    'public.content_mine(text)', 'public.content_get(text, text)',
    'public.content_unlock(text, text, text, text, text, text, boolean, boolean)',
    'public.content_search(text, text, text, text, text, int, text, text, int, int)',
    'public.content_suggest(text, text, int)', 'public.content_track(text[], text, text, text, text)',
    'public.content_minute(text, text, text)', 'public.content_vote(text, text, int, text)',
    'public.content_comments_list(text, text, int)', 'public.content_comment_add(text, text, text, bigint, text)',
    'public.content_comment_delete(text, bigint)', 'public.content_playlists_mine(text, text)',
    'public.content_playlist_add(text, text, text, text)', 'public.content_playlist_remove(text, text, text)',
    'public.content_playlists_of(text, text)', 'public.content_playlist_get(text, text, int, int)',
    'public.content_feed(text, int, timestamptz, text)',
    'public.content_tags(text, text, int)', 'public.content_stats(text, timestamptz, timestamptz)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
