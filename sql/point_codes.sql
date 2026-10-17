-- ============================================================
-- Points codes (package serials) and the Patreon links
-- Run in the Supabase SQL editor AFTER points.sql, prize_secure.sql and
-- point_levels.sql (safe to run more than once).
--
-- A points code is the serial of a points package, sold on Patreon for example.
-- Dashboard > Points > "Earn points" asks for it: the points stored with the
-- code are added to the member's balance, once, and the code is used up.
--
--   Make codes in the SQL editor (10 codes of 500 points each):
--     select * from public.point_codes_generate(10, 500, 'Patreon - 500 points');
--   or add serials of your own:
--     insert into public.point_codes (code, points, note) values ('GOLD-2026-0001', 1000, 'Patreon');
--   Optional: expires_at (no longer accepted after that date) and member_id set
--   before use (only that member can use the code).
--
-- Codes are compared without spaces, dashes or case ("gold 2026-0001" is the code
-- GOLD20260001). The codes table cannot be read through the public API: a code is
-- checked and used up only by points_code_redeem(), inside one locked transaction,
-- so the same code can never be used twice. Eight wrong codes in 15 minutes stop
-- the form for that member for 15 minutes.
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

do $$
begin
  alter table public.point_codes add constraint point_codes_points_check check (points > 0 and points <= 100000000);
exception when duplicate_object then null;
end $$;

comment on table public.point_codes is 'Points packages: one serial = a number of points, used once (Dashboard > Points > Earn points).';
comment on column public.point_codes.code is 'The serial, kept in capitals without spaces or dashes';
comment on column public.point_codes.member_id is 'Before use: only this member may use it (optional). After use: the member who used it.';

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

-- nobody reads or writes these through the public API
alter table public.point_codes enable row level security;
alter table public.point_code_attempts enable row level security;
do $$
declare pol record;
begin
  for pol in select policyname, tablename from pg_policies
             where schemaname = 'public' and tablename in ('point_codes', 'point_code_attempts') loop
    execute format('drop policy %I on public.%I', pol.policyname, pol.tablename);
  end loop;
end $$;
revoke all on public.point_codes from anon, authenticated;
revoke all on public.point_code_attempts from anon, authenticated;

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
--      { ok: false, reason: member | banned | locked | invalid | not_found | used | used_mine | other | expired }
create or replace function public.points_code_redeem(p_member text, p_code text, p_country text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m record; c record; norm text; tries int; before_earned bigint; after_earned bigint;
  lv_before int; lv_after int; total bigint;
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
  if c.used then
    return jsonb_build_object('ok', false, 'reason', case when c.member_id = p_member then 'used_mine' else 'used' end);
  end if;
  if coalesce(c.member_id, '') <> '' and c.member_id <> p_member then
    insert into public.point_code_attempts (member_id) values (p_member);
    return jsonb_build_object('ok', false, 'reason', 'other');
  end if;
  if c.expires_at is not null and c.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  -- the balance lives on the profile row (created here for a member who never opened a page that makes it)
  insert into public.profiles (member_id, username) values (p_member, m.username) on conflict do nothing;
  perform 1 from public.profiles where member_id = p_member for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'member');
  end if;
  before_earned := coalesce((public._points(p_member)->>'earned')::bigint, 0);
  update public.point_codes
     set used = true, member_id = p_member, used_at = now(),
         country = case when to_regprocedure('public._watch_country(text)') is not null
                        then public._watch_country(p_country) else '' end
   where code = norm;
  update public.profiles
     set code_points = coalesce(code_points, 0) + c.points, code_count = coalesce(code_count, 0) + 1
   where member_id = p_member
  returning code_points into total;
  delete from public.point_code_attempts where member_id = p_member;
  after_earned := before_earned + c.points;
  lv_before := public.points_level(before_earned);
  lv_after := public.points_level(after_earned);
  if to_regclass('public.notifications') is not null then
    insert into public.notifications (member_id, kind, title, body, href)
    values (p_member, 'points_code', 'Points added', '+' || c.points::text, './dashboard.html#points');
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

-- The codes a member used, newest first (the serial is shown shortened).
create or replace function public.points_code_history(p_member text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'code', case when length(c.code) > 8 then left(c.code, 4) || '…' || right(c.code, 4) else c.code end,
           'points', c.points, 'note', c.note, 'used_at', c.used_at)
         order by c.used_at desc), '[]'::jsonb)
  from (select * from public.point_codes
        where member_id = btrim(coalesce(p_member, '')) and used
        order by used_at desc limit 100) c;
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

-- ------------------------------------------------------------------ 6. who may call what
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

notify pgrst, 'reload schema';
