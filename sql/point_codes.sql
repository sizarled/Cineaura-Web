-- ============================================================
-- Points codes (package serials) and the Patreon links
-- Run in the Supabase SQL editor AFTER points.sql, prize_secure.sql and
-- point_levels.sql (safe to run more than once).
--
-- A points code is the serial of a points package, sold on Patreon for example.
-- Dashboard > Points > "Earn points" asks for it: the points stored with the
-- code are added to the member's balance.
--
--   Make codes in Panel > Packages > Points (the Super Admin, or staff with the Packages
--   section; the Panel functions are in sql/packages.sql): a serial typed by hand or drawn at
--   random, the points, how many times it can be used (once by default, each member once) and
--   who may use it:
--     public     anybody
--     exclusive  the members who meet every criterion set: membership plans, countries, site
--                languages, account level (LV0 … LV Max), account age (days since signing up)
--     private    the members named (member ids or usernames): they get the points at once, when
--                the code is saved, without typing the serial (one use each)
--   (section 6: _pack_aud_ok(), shared with the account and prize codes of sql/packages.sql)
--   In the SQL editor (10 codes of 500 points each, once each, for anybody):
--     select * from public.point_codes_generate(10, 500, 'Patreon - 500 points');
--   or add serials of your own:
--     insert into public.point_codes (code, points, note) values ('GOLD-2026-0001', 1000, 'Patreon');
--   Optional: expires_at (no longer accepted after that date), max_uses, audience and aud.
--
-- Codes are compared without spaces, dashes or case ("gold 2026-0001" is the code
-- GOLD20260001). The codes table cannot be read through the public API: a code is
-- checked and used only by points_code_redeem(), inside one locked transaction, so a
-- code is never used more often than allowed (point_code_uses: who used it, once per
-- member). Eight wrong codes in 15 minutes stop the form for that member for 15 minutes.
--
-- The points of a code go into profiles.code_points, which only these functions
-- can change, and count like every other earned point: they are in the balance
-- that buys prizes and in the account level (LV).
--
-- The Patreon links of the site (Dashboard > Points > "Buy points", and the
-- premium codes of the activation page) are set in Panel > Settings; only the
-- Super Admin and staff with the Settings section can change them.
-- ============================================================

-- ------------------------------------------------------------------ 1. the codes
create table if not exists public.point_codes (
  code text primary key,
  points integer not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  member_id text,                 -- set before use: only this member; after use: who used it
  used boolean not null default false,
  used_at timestamptz,
  country text not null default ''
);
alter table public.point_codes add column if not exists note text not null default '';
alter table public.point_codes add column if not exists expires_at timestamptz;
alter table public.point_codes add column if not exists country text not null default '';
alter table public.point_codes add column if not exists made_by text not null default '';   -- Panel > Packages: who made it
-- Panel > Packages: how many times a code can be used (each member once) and who may use it
alter table public.point_codes add column if not exists max_uses integer not null default 1;
alter table public.point_codes add column if not exists uses integer not null default 0;
alter table public.point_codes add column if not exists audience text not null default 'public';   -- public | exclusive | private
alter table public.point_codes add column if not exists aud jsonb not null default '{}'::jsonb;     -- the criteria / the members (_pack_aud_ok)

do $$
begin
  alter table public.point_codes add constraint point_codes_points_check check (points > 0 and points <= 100000000);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.point_codes add constraint point_codes_uses_check check (max_uses between 1 and 1000000 and uses >= 0);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table public.point_codes add constraint point_codes_audience_check check (audience in ('public', 'exclusive', 'private'));
exception when duplicate_object then null;
end $$;

comment on table public.point_codes is 'Points packages: one serial = a number of points, max_uses members (each once) (Dashboard > Points > Earn points).';
comment on column public.point_codes.code is 'The serial, kept in capitals without spaces or dashes';
comment on column public.point_codes.member_id is 'A code used once: the member who used it (point_code_uses has every use).';
comment on column public.point_codes.audience is 'public | exclusive (aud: memberships, countries, languages, min/max_level, min/max_days) | private (aud.members)';

-- The serial is kept in one form: capitals, letters and digits only.
create or replace function public._point_code_norm() returns trigger language plpgsql as $$
begin
  new.code := upper(regexp_replace(coalesce(new.code, ''), '[^A-Za-z0-9]', '', 'g'));
  if new.code = '' then
    raise exception 'A points code needs letters or digits';
  end if;
  return new;
end $$;
drop trigger if exists point_codes_norm on public.point_codes;
create trigger point_codes_norm before insert or update of code on public.point_codes
  for each row execute function public._point_code_norm();
update public.point_codes set code = code where code <> upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g'));

create index if not exists point_codes_member_idx on public.point_codes (member_id, used_at desc);

-- Wrong codes, per member (8 in 15 minutes stop the form for 15 minutes).
create table if not exists public.point_code_attempts (
  id bigint generated always as identity primary key,
  member_id text not null,
  at timestamptz not null default now()
);
create index if not exists point_code_attempts_member_idx on public.point_code_attempts (member_id, at);

-- Who used each code, once per member. The rows stay when a code is deleted (the member's history).
create table if not exists public.point_code_uses (
  id bigint generated always as identity primary key,
  code text not null,
  member_id text not null,
  points integer not null default 0,
  country text not null default '',
  used_at timestamptz not null default now(),
  unique (code, member_id)
);
create index if not exists point_code_uses_member_idx on public.point_code_uses (member_id, used_at desc);
-- the codes used before this table: one row each
insert into public.point_code_uses (code, member_id, points, country, used_at)
select c.code, c.member_id, c.points, coalesce(c.country, ''), coalesce(c.used_at, c.created_at)
  from public.point_codes c
 where c.used and coalesce(c.member_id, '') <> ''
on conflict (code, member_id) do nothing;
update public.point_codes set uses = 1 where used and uses = 0;
-- a code kept for one member before its first use (member_id): a private code of that member
update public.point_codes
   set audience = 'private', aud = jsonb_build_object('members', jsonb_build_array(member_id)), member_id = null
 where not used and coalesce(member_id, '') <> '' and audience = 'public';

-- nobody reads or writes these through the public API
alter table public.point_codes enable row level security;
alter table public.point_code_attempts enable row level security;
alter table public.point_code_uses enable row level security;
do $$
declare pol record;
begin
  for pol in select policyname, tablename from pg_policies
             where schemaname = 'public' and tablename in ('point_codes', 'point_code_attempts', 'point_code_uses') loop
    execute format('drop policy %I on public.%I', pol.policyname, pol.tablename);
  end loop;
end $$;
revoke all on public.point_codes from anon, authenticated;
revoke all on public.point_code_attempts from anon, authenticated;
revoke all on public.point_code_uses from anon, authenticated;

-- ------------------------------------------------------------------ 2. the balance
alter table public.profiles add column if not exists code_points bigint not null default 0;
alter table public.profiles add column if not exists code_count integer not null default 0;
comment on column public.profiles.code_points is 'Points added with points codes (points_code_redeem). Only the server changes it.';
comment on column public.profiles.code_count is 'How many points codes the member used.';

create or replace function public._guard_code_points() returns trigger language plpgsql as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.code_points := 0;
      new.code_count := 0;
    else
      new.code_points := old.code_points;
      new.code_count := old.code_count;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists profiles_guard_code_points on public.profiles;
create trigger profiles_guard_code_points before insert or update on public.profiles
  for each row execute function public._guard_code_points();

-- ------------------------------------------------------------------ 3. the points formula
-- Same body in prize_secure.sql, point_levels.sql, point_codes.sql, content.sql and market.sql
-- (kept identical, so the file run last always leaves the same formula). Every
-- column is read through to_jsonb(), so a database that never ran one of those
-- files simply has 0 for its source.
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
  -- the market (sql/market.sql): sales of the member's store (less the share commissions they pay), and the commissions of the sales made through their share links
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

-- ------------------------------------------------------------------ 4. using a code
-- Dashboard > Points > Earn points.
--   -> { ok: true, points, code_points, earned, level, level_name, multiplier, level_up }
--      { ok: false, reason: member | banned | locked | invalid | not_found | used | used_mine | other |
--        expired | audience (why: membership | country | language | level | age) }
--   used: every use is taken; used_mine: this member used it already; other: a private code of others.
-- The points of a code go to a member: one use of it, the balance, the bells. The caller checked
-- the code and holds its row (points_code_redeem: the serial typed; _pack_give_private of
-- sql/packages.sql: a private code, given at once to the members it names).
create or replace function public._points_code_give(p_member text, p_code text, p_country text default '', p_auto boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c public.point_codes; v_user text; before_earned bigint; after_earned bigint; lv_before int; lv_after int; total bigint; cty text := '';
begin
  select * into c from public.point_codes where code = p_code;
  select username into v_user from public.members where member_id = p_member;
  -- the balance lives on the profile row (created here for a member who never opened a page that makes it)
  insert into public.profiles (member_id, username) values (p_member, coalesce(v_user, '')) on conflict do nothing;
  perform 1 from public.profiles where member_id = p_member for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'member');
  end if;
  before_earned := coalesce((public._points(p_member)->>'earned')::bigint, 0);
  if to_regprocedure('public._watch_country(text)') is not null then cty := coalesce(public._watch_country(p_country), ''); end if;
  insert into public.point_code_uses (code, member_id, points, country) values (c.code, p_member, c.points, cty);
  -- the expressions read the row before the change: the last use marks it used
  update public.point_codes
     set uses = uses + 1, used = (uses + 1 >= max_uses), used_at = now(),
         member_id = case when max_uses = 1 then p_member else member_id end,
         country = case when max_uses = 1 then cty else country end
   where code = c.code;
  update public.profiles
     set code_points = coalesce(code_points, 0) + c.points, code_count = coalesce(code_count, 0) + 1
   where member_id = p_member
  returning code_points into total;
  after_earned := before_earned + c.points;
  lv_before := public.points_level(before_earned);
  lv_after := public.points_level(after_earned);
  if to_regclass('public.notifications') is not null then
    insert into public.notifications (member_id, kind, title, body, href)
    values (p_member, case when p_auto then 'points_gift' else 'points_code' end,
            case when p_auto then 'Points for you' else 'Points added' end, '+' || c.points::text, './dashboard.html#points');
    if lv_after > lv_before then
      insert into public.notifications (member_id, kind, title, body, href)
      values (p_member, 'points_level', 'New level',
              public.points_level_name(lv_after) || ' · ×' || public.points_multiplier(lv_after)::text,
              './dashboard.html#points');
    end if;
  end if;
  return jsonb_build_object('ok', true, 'points', c.points, 'code_points', total, 'earned', after_earned,
                            'level', lv_after, 'level_name', public.points_level_name(lv_after),
                            'multiplier', public.points_multiplier(lv_after), 'level_up', lv_after > lv_before);
end $$;

create or replace function public.points_code_redeem(p_member text, p_code text, p_country text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m record; c public.point_codes; norm text; tries int; why text; res jsonb;
begin
  p_member := btrim(coalesce(p_member, ''));
  norm := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  select member_id, username, status into m from public.members where member_id = p_member;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'member');
  end if;
  if lower(coalesce(m.status, '')) = 'banned' then
    return jsonb_build_object('ok', false, 'reason', 'banned');
  end if;
  select count(*) into tries from public.point_code_attempts where member_id = p_member and at > now() - interval '15 minutes';
  if tries >= 8 then
    return jsonb_build_object('ok', false, 'reason', 'locked');
  end if;
  if length(norm) < 4 or length(norm) > 64 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  select * into c from public.point_codes where code = norm for update;
  if not found then
    insert into public.point_code_attempts (member_id) values (p_member);
    return jsonb_build_object('ok', false, 'reason', 'not_found', 'left', greatest(0, 7 - tries));
  end if;
  if exists (select 1 from public.point_code_uses u where u.code = norm and u.member_id = p_member)
     or (c.used and c.member_id = p_member) then
    return jsonb_build_object('ok', false, 'reason', 'used_mine');
  end if;
  if c.used or c.uses >= c.max_uses then
    return jsonb_build_object('ok', false, 'reason', 'used');
  end if;
  -- a code kept for one member the old way (member_id set before its use)
  if coalesce(c.member_id, '') <> '' and c.member_id <> p_member then
    insert into public.point_code_attempts (member_id) values (p_member);
    return jsonb_build_object('ok', false, 'reason', 'other');
  end if;
  if c.expires_at is not null and c.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  why := public._pack_aud_ok(c.audience, c.aud, p_member);
  if why = 'private' then
    insert into public.point_code_attempts (member_id) values (p_member);
    return jsonb_build_object('ok', false, 'reason', 'other');
  elsif why <> 'ok' then
    return jsonb_build_object('ok', false, 'reason', 'audience', 'why', why);
  end if;
  res := public._points_code_give(p_member, norm, p_country, false);
  if coalesce((res->>'ok')::boolean, false) then
    delete from public.point_code_attempts where member_id = p_member;
  end if;
  return res;
end $$;

-- The codes a member used, newest first (the serial is shown shortened).
create or replace function public.points_code_history(p_member text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'code', case when length(u.code) > 8 then left(u.code, 4) || '…' || right(u.code, 4) else u.code end,
           'points', u.points, 'note', coalesce(c.note, ''), 'used_at', u.used_at)
         order by u.used_at desc), '[]'::jsonb)
  from (select * from public.point_code_uses
        where member_id = btrim(coalesce(p_member, ''))
        order by used_at desc limit 100) u
  left join public.point_codes c on c.code = u.code;
$$;

-- SQL editor only: make p_count new codes of p_points points each.
-- Returns the serials as XXXX-XXXX-XXXX-XXXX (the dashes are optional when they are typed).
create or replace function public.point_codes_generate(p_count int, p_points int, p_note text default '', p_days int default null)
returns table (code text, points int, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare i int := 0; raw text; tries int := 0; exp timestamptz;
begin
  if coalesce(p_count, 0) < 1 or p_count > 1000 then raise exception 'p_count: 1 to 1000 codes'; end if;
  if coalesce(p_points, 0) < 1 then raise exception 'p_points must be at least 1'; end if;
  exp := case when p_days is null then null else now() + make_interval(days => p_days) end;
  while i < p_count loop
    raw := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16));
    begin
      insert into public.point_codes (code, points, note, expires_at) values (raw, p_points, coalesce(p_note, ''), exp);
      i := i + 1;
      code := substr(raw, 1, 4) || '-' || substr(raw, 5, 4) || '-' || substr(raw, 9, 4) || '-' || substr(raw, 13, 4);
      points := p_points;
      expires_at := exp;
      return next;
    exception when unique_violation then
      tries := tries + 1;
      if tries > 50 then raise exception 'could not make unique codes'; end if;
    end;
  end loop;
end $$;

-- ------------------------------------------------------------------ 5. Patreon links (Panel > Settings)
create table if not exists public.site_links (
  key text primary key,
  url text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);
do $$
begin
  alter table public.site_links add constraint site_links_key_check check (key in ('patreon_points', 'patreon_plans'));
exception when duplicate_object then null;
end $$;
insert into public.site_links (key) values ('patreon_points'), ('patreon_plans') on conflict (key) do nothing;

alter table public.site_links enable row level security;
do $$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'site_links' loop
    execute format('drop policy %I on public.site_links', pol.policyname);
  end loop;
end $$;
create policy site_links_read on public.site_links for select to anon, authenticated using (true);
revoke all on public.site_links from anon, authenticated;
grant select on public.site_links to anon, authenticated;

-- p_url = '' puts the default back (https://www.patreon.com/).
create or replace function public.staff_site_link_save(p_token text, p_key text, p_url text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  s public.staff;
  u text := btrim(coalesce(p_url, ''));
  r public.site_links;
begin
  s := public._staff(p_token);
  if s.role <> 'super' and position(',settings,' in ',' || replace(coalesce(s.sections, ''), ' ', '') || ',') = 0 then
    raise exception 'staff_forbidden';
  end if;
  if p_key is null or p_key not in ('patreon_points', 'patreon_plans') then
    return jsonb_build_object('ok', false, 'error', 'bad_key');
  end if;
  if u <> '' and (length(u) > 1000 or u ~ '[[:space:]<>"''`]' or u !~* '^https://[^/?#]+') then
    return jsonb_build_object('ok', false, 'error', 'bad_url');
  end if;
  insert into public.site_links as l (key, url, updated_at, updated_by)
  values (p_key, u, now(), coalesce(nullif(s.username, ''), s.role))
  on conflict (key) do update set url = excluded.url, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  returning l.* into r;
  return jsonb_build_object('ok', true, 'row', to_jsonb(r));
end $$;

-- ------------------------------------------------------------------ 6. packages: who may use a code
-- Shared by the three packages of Panel > Packages: the points codes (this file), the account
-- codes and the prize codes (sql/packages.sql, which also has the Panel functions).
--   audience   public     anybody
--              exclusive  the members who meet every criterion of aud:
--                           memberships  ["Free", "Silver", "Gold", "Diamond"] (any of them)
--                           countries    ["MA", "FR" …] (members.country)
--                           languages    ["en", "ar", "fr", "de", "es", "nl", "it"]: the site language
--                                        saved on the profile, else the language of the country
--                           min_level / max_level   0 … 10 (LV0 … LV Max, sql/point_levels.sql)
--                           min_days / max_days     the age of the account in days (since signing up)
--              private    the members of aud.members (member ids): an account or points code is
--                         given to them at once (sql/packages.sql, _pack_give_private); a prize
--                         code waits on the prize page, filled in by itself
-- The round-27 Panel functions of this section (one form for many codes) gave way to Panel > Packages.
drop function if exists public.point_codes_admin(text, text, text, int, int);
drop function if exists public.point_codes_admin_make(text, int, int, text, int, text);
drop function if exists public.point_codes_admin_delete(text, text[]);
drop function if exists public._pcode_staff(text);

-- The Super Admin, or a staff member with the Packages section. -> who did it
create or replace function public._pack_staff(p_token text) returns text
language plpgsql security definer set search_path = public as $$
declare s public.staff; secs text;
begin
  s := public._staff(p_token);
  secs := ',' || replace(coalesce(s.sections, ''), ' ', '') || ',';
  if s.role <> 'super' and position(',packages,' in secs) = 0 and position(',points,' in secs) = 0 then
    raise exception 'staff_forbidden';
  end if;
  return coalesce(nullif(s.username, ''), s.role);
end $$;

-- A serial in one form: capitals, letters and digits only.
create or replace function public._pack_norm(p_code text) returns text language sql immutable as $$
  select upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

-- 16 characters are shown as XXXX-XXXX-XXXX-XXXX.
create or replace function public._pcode_fmt(p_code text) returns text language sql immutable as $$
  select case when length(p_code) = 16 and p_code ~ '^[A-Z0-9]+$'
              then substr(p_code, 1, 4) || '-' || substr(p_code, 5, 4) || '-' || substr(p_code, 9, 4) || '-' || substr(p_code, 13, 4)
              else p_code end
$$;

create or replace function public._pack_int(p text) returns int language sql immutable as $$
  select case when btrim(coalesce(p, '')) ~ '^-?[0-9]{1,9}$' then btrim(p)::int end
$$;

-- The site language of a member: the one saved on the profile, else the language of the
-- country (as js/prefs.js), else English.
create or replace function public._pack_lang(p_member text, p_country text) returns text
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

-- The account level of a member (0 = LV0 … 10 = LV Max).
create or replace function public._pack_level(p_member text) returns int
language plpgsql stable security definer set search_path = public as $$
begin
  if to_regprocedure('public.points_level(bigint)') is null then return 0; end if;
  return public.points_level(coalesce((public._points(p_member)->>'earned')::bigint, 0));
end $$;

-- May this member use a code with this audience? -> 'ok', or why not: member | private |
-- membership | country | language | level | age
create or replace function public._pack_aud_ok(p_audience text, p_aud jsonb, p_member text) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  m public.members; a jsonb := case when jsonb_typeof(p_aud) = 'object' then p_aud else '{}'::jsonb end;
  lv int; days int; lo int; hi int;
begin
  if coalesce(p_audience, 'public') = 'public' then return 'ok'; end if;
  select * into m from public.members where member_id = btrim(coalesce(p_member, ''));
  if not found then return 'member'; end if;
  if p_audience = 'private' then
    if exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(a->'members') = 'array' then a->'members' else '[]'::jsonb end) x
                where x = m.member_id) then
      return 'ok';
    end if;
    return 'private';
  end if;
  if jsonb_typeof(a->'memberships') = 'array' and jsonb_array_length(a->'memberships') > 0
     and not exists (select 1 from jsonb_array_elements_text(a->'memberships') x
                      where lower(x) = lower(coalesce(nullif(btrim(m.membership_type), ''), 'Free'))) then
    return 'membership';
  end if;
  if jsonb_typeof(a->'countries') = 'array' and jsonb_array_length(a->'countries') > 0
     and not exists (select 1 from jsonb_array_elements_text(a->'countries') x where upper(x) = upper(btrim(coalesce(m.country, '')))) then
    return 'country';
  end if;
  if jsonb_typeof(a->'languages') = 'array' and jsonb_array_length(a->'languages') > 0
     and not exists (select 1 from jsonb_array_elements_text(a->'languages') x where lower(x) = public._pack_lang(m.member_id, m.country)) then
    return 'language';
  end if;
  lo := public._pack_int(a->>'min_level');
  hi := public._pack_int(a->>'max_level');
  if lo is not null or hi is not null then
    lv := public._pack_level(m.member_id);
    if (lo is not null and lv < lo) or (hi is not null and lv > hi) then return 'level'; end if;
  end if;
  lo := public._pack_int(a->>'min_days');
  hi := public._pack_int(a->>'max_days');
  if lo is not null or hi is not null then
    days := floor(extract(epoch from (now() - coalesce(m.created_at, now()))) / 86400)::int;
    if (lo is not null and days < lo) or (hi is not null and days > hi) then return 'age'; end if;
  end if;
  return 'ok';
end $$;

-- The audience of a new code, checked and in one form (Panel > Packages).
--   p_aud: { memberships[], countries[], languages[], min_level, max_level, min_days, max_days }
--          (exclusive) or { members: [ids or usernames] } (private)
--   -> { ok: true, audience, aud } | { ok: false, reason: audience | criteria | level | age |
--      members (unknown: the names nobody has) | members_many }
create or replace function public._pack_aud_clean(p_audience text, p_aud jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  a jsonb := case when jsonb_typeof(p_aud) = 'object' then p_aud else '{}'::jsonb end;
  v_aud text := lower(btrim(coalesce(p_audience, 'public')));
  plans text[]; ctys text[]; langs text[]; ids text[] := '{}'; bad text[] := '{}';
  x text; v_mid text; lo int; hi int; d_lo int; d_hi int;
begin
  if v_aud not in ('public', 'exclusive', 'private') then return jsonb_build_object('ok', false, 'reason', 'audience'); end if;
  if v_aud = 'public' then return jsonb_build_object('ok', true, 'audience', 'public', 'aud', '{}'::jsonb); end if;
  if v_aud = 'private' then
    -- in the order given; a member named twice counts once
    for x in select btrim(v) from jsonb_array_elements_text(case when jsonb_typeof(a->'members') = 'array' then a->'members' else '[]'::jsonb end) v
              where btrim(v) <> '' loop
      v_mid := null;
      select member_id into v_mid from public.members
       where member_id = x or lower(username) = lower(ltrim(x, '@'))
       order by (member_id = x) desc limit 1;
      if v_mid is null then
        if not x = any (bad) then bad := bad || x; end if;
      elsif not v_mid = any (ids) then
        ids := ids || v_mid;
      end if;
    end loop;
    if cardinality(bad) > 0 or cardinality(ids) = 0 then
      return jsonb_build_object('ok', false, 'reason', 'members', 'unknown', to_jsonb(bad));
    end if;
    if cardinality(ids) > 500 then return jsonb_build_object('ok', false, 'reason', 'members_many'); end if;
    return jsonb_build_object('ok', true, 'audience', 'private', 'aud', jsonb_build_object('members', to_jsonb(ids)));
  end if;
  select coalesce(array_agg(distinct initcap(lower(btrim(v)))) filter (where initcap(lower(btrim(v))) in ('Free', 'Silver', 'Gold', 'Diamond')), '{}')
    into plans from jsonb_array_elements_text(case when jsonb_typeof(a->'memberships') = 'array' then a->'memberships' else '[]'::jsonb end) v;
  select coalesce(array_agg(distinct upper(btrim(v))) filter (where upper(btrim(v)) ~ '^[A-Z]{2}$'), '{}')
    into ctys from jsonb_array_elements_text(case when jsonb_typeof(a->'countries') = 'array' then a->'countries' else '[]'::jsonb end) v;
  select coalesce(array_agg(distinct lower(btrim(v))) filter (where lower(btrim(v)) in ('en', 'ar', 'fr', 'de', 'es', 'nl', 'it')), '{}')
    into langs from jsonb_array_elements_text(case when jsonb_typeof(a->'languages') = 'array' then a->'languages' else '[]'::jsonb end) v;
  lo := public._pack_int(a->>'min_level');
  hi := public._pack_int(a->>'max_level');
  d_lo := public._pack_int(a->>'min_days');
  d_hi := public._pack_int(a->>'max_days');
  if (lo is not null and (lo < 0 or lo > 10)) or (hi is not null and (hi < 0 or hi > 10)) or lo > hi then
    return jsonb_build_object('ok', false, 'reason', 'level');
  end if;
  if (d_lo is not null and (d_lo < 0 or d_lo > 36500)) or (d_hi is not null and (d_hi < 0 or d_hi > 36500)) or d_lo > d_hi then
    return jsonb_build_object('ok', false, 'reason', 'age');
  end if;
  if cardinality(plans) = 0 and cardinality(ctys) = 0 and cardinality(langs) = 0
     and lo is null and hi is null and d_lo is null and d_hi is null then
    return jsonb_build_object('ok', false, 'reason', 'criteria');
  end if;
  return jsonb_build_object('ok', true, 'audience', 'exclusive', 'aud', jsonb_strip_nulls(jsonb_build_object(
    'memberships', case when cardinality(plans) > 0 then to_jsonb(plans) end,
    'countries', case when cardinality(ctys) > 0 then to_jsonb(ctys) end,
    'languages', case when cardinality(langs) > 0 then to_jsonb(langs) end,
    'min_level', lo, 'max_level', hi, 'min_days', d_lo, 'max_days', d_hi)));
end $$;

-- The audience for the Panel: the criteria, or the members named (with their usernames).
create or replace function public._pack_aud_out(p_audience text, p_aud jsonb) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('type', coalesce(p_audience, 'public')) || case
    when p_audience = 'private' then jsonb_build_object('members', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.v, 'username', coalesce(mm.username, '')) order by x.ord)
        from jsonb_array_elements_text(case when jsonb_typeof(p_aud->'members') = 'array' then p_aud->'members' else '[]'::jsonb end)
             with ordinality as x(v, ord)
        left join public.members mm on mm.member_id = x.v), '[]'::jsonb))
    when p_audience = 'exclusive' then coalesce(p_aud, '{}'::jsonb) - 'members'
    else '{}'::jsonb end
$$;

-- ------------------------------------------------------------------ 7. who may call what
revoke all on function public._points(text) from public, anon, authenticated;
revoke all on function public._point_code_norm() from public, anon, authenticated;
revoke all on function public._guard_code_points() from public, anon, authenticated;
revoke all on function public.point_codes_generate(int, int, text, int) from public, anon, authenticated;
revoke all on function public.points_code_redeem(text, text, text) from public, anon, authenticated;
revoke all on function public.points_code_history(text) from public, anon, authenticated;
revoke all on function public.staff_site_link_save(text, text, text) from public, anon, authenticated;
grant execute on function public.points_code_redeem(text, text, text) to anon, authenticated;
grant execute on function public.points_code_history(text) to anon, authenticated;
grant execute on function public.staff_site_link_save(text, text, text) to anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'public._pack_staff(text)', 'public._pack_norm(text)', 'public._pcode_fmt(text)', 'public._pack_int(text)',
    'public._pack_lang(text, text)', 'public._pack_level(text)', 'public._pack_aud_ok(text, jsonb, text)',
    'public._pack_aud_clean(text, jsonb)', 'public._pack_aud_out(text, jsonb)',
    'public._points_code_give(text, text, text, boolean)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
