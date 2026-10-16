-- ============================================================
-- Prize security + server-side logic
-- Run once in the Supabase SQL editor AFTER profile.sql, panel.sql,
-- prize_center.sql, prize_modes.sql, prize_admin.sql and points.sql (safe to run again).
--
-- What it does
--   1. Staff passwords are re-hashed with bcrypt (salted). Panel login now goes
--      through staff_login(), which returns a session token. The staff table can
--      no longer be written by the public API and its password column is hidden.
--   2. Every prize WRITE (create / edit / end / delete / winners / bans / limits /
--      categories / coupons) is a staff RPC that checks the token and runs in ONE
--      transaction, so a failure never leaves half a prize behind.
--   3. Joining a prize, applying a coupon, withdrawing and claiming a challenge are
--      member RPCs. Window, audience, caps, tier limits, coupon rules and the points
--      balance are checked on the server, inside one locked transaction, so two
--      simultaneous clicks can no longer spend the same points twice.
--   4. profiles.points_spent can only be changed by those functions.
--   5. Coupons, coupon attempts and raw visits are no longer readable by the public.
--   6. Lottery draws run on the server (pg_cron if the extension is enabled).
--   7. Indexes + a statistics function so the panel no longer downloads whole tables.
--
-- ORDER: always run this file LAST, and run it again after re-running panel.sql,
-- prize_center.sql, prize_modes.sql or prize_admin.sql (those files re-create the old
-- open policies that this file removes). Make sure profile.sql is installed for notifications.
-- The review of prize claims (Panel > Prizes > Prize claims) lives in prize_claims.sql,
-- which is run after this file; re-running this file keeps it working.
--
-- NOT covered here (needs Supabase Auth, a separate migration): member identity.
-- Members still sign in with the custom login, so the member RPCs trust the member id
-- the browser sends. Also members.password / recovery_code and the watch-minute
-- counters are still readable / writable through the public API.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

-- Prize winners can request fulfillment once they are selected.
alter table public.prize_mode_entries add column if not exists claim_requested_at timestamptz;
alter table public.winners add column if not exists claim_requested_at timestamptz;

-- ------------------------------------------------------------------ 1. staff
create table if not exists public.staff_sessions (
  token text primary key,
  staff_id bigint not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists staff_sessions_staff_idx on public.staff_sessions (staff_id);
alter table public.staff_sessions enable row level security;   -- no policy = no public access

create table if not exists public.staff_login_attempts (
  id bigint generated always as identity primary key,
  role text not null,
  at timestamptz not null default now()
);
alter table public.staff_login_attempts enable row level security;

-- The default Super Admin password is printed in sql/panel.sql. Change it right after this runs.
do $$
begin
  if exists (select 1 from public.staff where password = 'b3eb15e7a998f18c33c6d8f98217ce53daafca25e74869f19c7b523c6f43d75c') then
    raise warning 'The default Super Admin password from panel.sql is still active. Sign in to the panel and change it NOW (Settings > password).';
  end if;
end $$;

-- One-shot: wrap the old unsalted sha256 hashes with bcrypt.
update public.staff
set password = extensions.crypt(password, extensions.gen_salt('bf', 10))
where password ~ '^[0-9a-f]{64}$';

create or replace function public._staff(p_token text)
returns public.staff language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff;
begin
  select st.* into s
  from public.staff st join public.staff_sessions ss on ss.staff_id = st.id
  where ss.token = p_token and ss.expires_at > now();
  if not found then raise exception 'staff_auth'; end if;
  return s;
end $$;

create or replace function public._staff_prizes(p_token text)
returns public.staff language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff;
begin
  s := public._staff(p_token);
  if s.role <> 'super' and position(',prizes,' in ',' || coalesce(s.sections, '') || ',') = 0 then
    raise exception 'staff_forbidden';
  end if;
  return s;
end $$;

create or replace function public._staff_json(s public.staff)
returns jsonb language sql immutable as $$
  select jsonb_build_object('id', s.id, 'role', s.role, 'member_id', coalesce(s.member_id, ''),
                            'username', coalesce(s.username, ''), 'sections', coalesce(s.sections, ''));
$$;

-- p_hash = sha256(password) computed by the browser, exactly like before.
create or replace function public.staff_login(p_role text, p_hash text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff; tok text; recent int;
begin
  p_role := lower(coalesce(p_role, ''));
  delete from public.staff_login_attempts where at < now() - interval '1 day';
  select count(*) into recent from public.staff_login_attempts where role = p_role and at > now() - interval '15 minutes';
  if recent >= 8 then return jsonb_build_object('ok', false, 'error', 'locked'); end if;
  select st.* into s from public.staff st
  where st.role = p_role and st.password = extensions.crypt(coalesce(p_hash, ''), st.password)
  limit 1;
  if not found then
    insert into public.staff_login_attempts (role) values (p_role);
    return jsonb_build_object('ok', false, 'error', 'bad_credentials');
  end if;
  tok := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.staff_sessions (token, staff_id, expires_at) values (tok, s.id, now() + interval '7 days');
  delete from public.staff_sessions where expires_at < now();
  return jsonb_build_object('ok', true, 'token', tok, 'staff', public._staff_json(s));
end $$;

create or replace function public.staff_session(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff;
begin
  begin s := public._staff(p_token); exception when others then return null; end;
  return public._staff_json(s);
end $$;

create or replace function public.staff_logout(p_token text)
returns void language sql security definer set search_path = public as $$
  delete from public.staff_sessions where token = p_token;
$$;

-- First start only: creates the Super Admin when none exists yet.
create or replace function public.staff_setup_super(p_member text, p_username text, p_hash text, p_sections text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff; tok text;
begin
  if exists (select 1 from public.staff where role = 'super') then
    return jsonb_build_object('ok', false, 'error', 'exists');
  end if;
  if coalesce(p_hash, '') !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false, 'error', 'bad_hash'); end if;
  insert into public.staff (role, member_id, username, password, sections)
  values ('super', coalesce(p_member, ''), coalesce(nullif(p_username, ''), 'Super Admin'),
          extensions.crypt(p_hash, extensions.gen_salt('bf', 10)), coalesce(p_sections, ''))
  returning * into s;
  tok := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.staff_sessions (token, staff_id, expires_at) values (tok, s.id, now() + interval '7 days');
  return jsonb_build_object('ok', true, 'token', tok, 'staff', public._staff_json(s));
end $$;

create or replace function public.staff_add(p_token text, p_member text, p_role text, p_hash text, p_sections text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff; m record;
begin
  s := public._staff(p_token);
  if s.role <> 'super' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_role not in ('admin', 'moderator') then return jsonb_build_object('ok', false, 'error', 'bad_role'); end if;
  if coalesce(p_hash, '') !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false, 'error', 'bad_hash'); end if;
  select member_id, username into m from public.members where member_id = p_member;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_member'); end if;
  if exists (select 1 from public.staff where member_id = m.member_id and role = 'super') then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  insert into public.staff (role, member_id, username, password, sections)
  values (p_role, m.member_id, m.username, extensions.crypt(p_hash, extensions.gen_salt('bf', 10)), coalesce(p_sections, ''));
  return jsonb_build_object('ok', true);
exception when unique_violation then return jsonb_build_object('ok', false, 'error', 'duplicate');
end $$;

create or replace function public.staff_set_sections(p_token text, p_id bigint, p_sections text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff;
begin
  s := public._staff(p_token);
  if s.role <> 'super' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  update public.staff set sections = coalesce(p_sections, '') where id = p_id and role <> 'super';
  return jsonb_build_object('ok', found);
end $$;

create or replace function public.staff_remove(p_token text, p_id bigint)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff;
begin
  s := public._staff(p_token);
  if s.role <> 'super' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  delete from public.staff where id = p_id and role <> 'super';
  delete from public.staff_sessions where staff_id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.staff_set_password(p_token text, p_hash text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff;
begin
  s := public._staff(p_token);
  if coalesce(p_hash, '') !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false, 'error', 'bad_hash'); end if;
  update public.staff set password = extensions.crypt(p_hash, extensions.gen_salt('bf', 10)) where id = s.id;
  delete from public.staff_sessions where staff_id = s.id and token <> p_token;  -- other devices sign out
  return jsonb_build_object('ok', true);
end $$;

-- ------------------------------------------------------------------ 2. rule helpers
create or replace function public._tier_idx(t text) returns int language sql immutable as $$
  select coalesce(array_position(array['free','silver','gold','diamond'], lower(coalesce(nullif(t, ''), 'free'))), 1);
$$;

-- audience = {type, countries[], genders[], min_age, max_age, min_account_days, max_account_days, membership, member_ids[]}
create or replace function public._aud_ok(aud jsonb, m public.members)
returns boolean language plpgsql stable set search_path = public as $$
declare t text; yrs int; days int;
begin
  if aud is null or aud = '{}'::jsonb then return true; end if;
  t := lower(coalesce(aud->>'type', 'public'));
  if t = 'public' then return true; end if;
  if t = 'private' then
    return exists (select 1 from jsonb_array_elements_text(coalesce(aud->'member_ids', '[]'::jsonb)) x
                   where lower(trim(x)) = lower(m.member_id));
  end if;
  if jsonb_array_length(coalesce(aud->'countries', '[]'::jsonb)) > 0 and not exists (
       select 1 from jsonb_array_elements_text(aud->'countries') x where lower(trim(x)) = lower(coalesce(m.country, ''))) then
    return false;
  end if;
  if jsonb_array_length(coalesce(aud->'genders', '[]'::jsonb)) > 0 and not exists (
       select 1 from jsonb_array_elements_text(aud->'genders') x where lower(trim(x)) = lower(coalesce(m.gender, ''))) then
    return false;
  end if;
  yrs := case when m.birth_date is null then null else date_part('year', age(current_date, m.birth_date))::int end;
  days := (current_date - m.created_at::date);
  if nullif(aud->>'min_age', '') is not null and (yrs is null or yrs < (aud->>'min_age')::int) then return false; end if;
  if nullif(aud->>'max_age', '') is not null and (yrs is null or yrs > (aud->>'max_age')::int) then return false; end if;
  if nullif(aud->>'min_account_days', '') is not null and days < (aud->>'min_account_days')::int then return false; end if;
  if nullif(aud->>'max_account_days', '') is not null and days > (aud->>'max_account_days')::int then return false; end if;
  if nullif(aud->>'membership', '') is not null and public._tier_idx(m.membership_type) < public._tier_idx(aud->>'membership') then return false; end if;
  return true;
end $$;

create or replace function public._csv_arr(v text) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(trim(x)) filter (where trim(x) <> ''), '[]'::jsonb) from unnest(string_to_array(coalesce(v, ''), ',')) x;
$$;

create or replace function public._code_aud(c public.prize_codes) returns jsonb language sql immutable as $$
  select jsonb_build_object('type', c.audience, 'countries', public._csv_arr(c.countries), 'genders', public._csv_arr(c.genders),
    'min_age', c.min_age, 'max_age', c.max_age, 'min_account_days', c.min_account_days, 'member_ids', public._csv_arr(c.member_ids));
$$;

-- Window of a mode for one country (a country row wins over the mode / prize dates).
create or replace function public._window(p public.prizes, md public.prize_modes, c text, out s date, out e date)
language plpgsql stable set search_path = public as $$
declare r record;
begin
  select starts_at, ends_at into r from public.prize_country_dates where prize_id = p.id and lower(country) = lower(coalesce(c, '')) limit 1;
  if found then s := r.starts_at; e := r.ends_at; return; end if;
  s := coalesce(md.starts_at, p.starts_at);
  e := case when coalesce(md.unlimited_time, false) then null else coalesce(md.ends_at, p.ends_at) end;
end $$;

-- Insert in-app notifications without exposing writes to the browser.
create or replace function public._notify_prize_staff(p_prize_id bigint, p_member text, p_kind text)
returns int language plpgsql security definer set search_path = public as $$
declare p public.prizes; m public.members; n int := 0; note_title text;
begin
  if to_regclass('public.notifications') is null then return 0; end if;
  select * into p from public.prizes where id = p_prize_id;
  if not found then return 0; end if;
  select * into m from public.members where member_id = p_member;
  if not found then return 0; end if;
  note_title := case when p_kind = 'prize_win' then 'Prize winner' else 'Prize claim request' end;
  -- a claim opens Panel > Prizes > Prize claims (sql/prize_claims.sql)
  insert into public.notifications (member_id, kind, title, body, href, from_id, from_username)
  select s.member_id, p_kind, note_title,
         coalesce(nullif(m.username, ''), p_member) || ' · ' || p.title,
         case when p_kind = 'prize_claim' then './Panel.html?section=prizes&tab=claims' else './Panel.html?section=prizes' end,
         p_member, coalesce(m.username, '')
  from public.staff s
  where s.role in ('super', 'admin', 'moderator')
    and coalesce(s.member_id, '') <> ''
    and s.member_id <> p_member;
  get diagnostics n = row_count;
  return n;
end $$;

-- Notify active members who can see at least one mode of a newly published prize.
create or replace function public._notify_new_prize(p_prize_id bigint)
returns int language plpgsql security definer set search_path = public as $$
declare p public.prizes; n int := 0;
begin
  if to_regclass('public.notifications') is null then return 0; end if;
  select * into p from public.prizes where id = p_prize_id;
  if not found then return 0; end if;
  if coalesce(p.status, 'active') = 'ended' then return 0; end if;
  insert into public.notifications (member_id, kind, title, body, href, from_id, from_username)
  select m.member_id, 'prize_new', 'New prize available', p.title,
         './Prize.html?GroupPrize=' || coalesce(p.group_id, 0)::text || '&Prize=' || p.id::text,
         '', ''
  from public.members m
  where coalesce(m.member_id, '') <> '' and lower(coalesce(m.status, '')) = 'active'
    and not exists (select 1 from public.prize_groups g where g.id = p.group_id and g.visible = false)
    and exists (
      select 1 from public.prize_modes pm
      where pm.prize_id = p.id and public._aud_ok(pm.config->'audience', m)
    )
    and (
      coalesce(p.visibility, 'public') <> 'private'
      or exists (
        select 1 from unnest(regexp_split_to_array(lower(coalesce(p.allowed_usernames, '')), '[,;]+')) as allowed(name)
        where trim(allowed.name) in (lower(m.member_id), lower(coalesce(m.username, '')))
      )
    );
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public._notify_prize_staff(bigint, text, text) from public, anon, authenticated;
revoke all on function public._notify_new_prize(bigint) from public, anon, authenticated;

create or replace function public._points(p_member text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  pr record; earned bigint; watch bigint; sh int; pl int; rc int; cm int; lk int := 0;
  dl bigint := 0; clicks bigint; has_dl boolean;
begin
  select coalesce(p.private_minutes, 0) + coalesce(p.public_minutes, 0) as mins,
         coalesce(p.points_spent, 0) as spent,
         to_jsonb(p) ->> 'watch_points' as wp
    into pr
  from public.profiles p where p.member_id = p_member;
  if not found then return jsonb_build_object('earned', 0, 'spent', 0, 'available', 0, 'watch', 0); end if;
  -- watch points: stored by sql/point_levels.sql (country tier x level); before that file, 1 a minute
  watch := case when pr.wp is null then pr.mins else floor(pr.wp::numeric)::bigint end;
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
  earned := watch + sh / 5 + pl / 10 + rc / 50 + cm / 100 + lk / 500 + dl / 1000;
  return jsonb_build_object('earned', earned, 'spent', pr.spent, 'available', greatest(0, earned - pr.spent), 'watch', watch);
end $$;

-- Locks the profile row, checks the balance, spends and writes the spending ledger
-- (point_spends: which prize, which mode). Caller must be a SECURITY DEFINER function.
create or replace function public._spend_prize(p_member text, p_amount int, p_prize text, p_mode text) returns boolean
language plpgsql security definer set search_path = public as $$
declare pts jsonb;
begin
  if p_amount <= 0 then return true; end if;
  perform 1 from public.profiles where member_id = p_member for update;
  if not found then return false; end if;
  pts := public._points(p_member);
  if (pts->>'available')::bigint < p_amount then return false; end if;
  update public.profiles set points_spent = coalesce(points_spent, 0) + p_amount where member_id = p_member;
  insert into public.point_spends (member_id, amount, prize_title, mode) values (p_member, p_amount, coalesce(p_prize, ''), coalesce(p_mode, ''));
  return true;
end $$;

-- Spend without a prize name (kept for older callers).
create or replace function public._spend(p_member text, p_amount int) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  return public._spend_prize(p_member, p_amount, '', '');
end $$;

-- Only the server functions may change the spending ledger.
create or replace function public._guard_points() returns trigger language plpgsql as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.points_spent := 0;
    elsif new.points_spent is distinct from old.points_spent then
      raise exception 'points_spent is managed by the server';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists profiles_guard_points on public.profiles;
create trigger profiles_guard_points before insert or update on public.profiles
  for each row execute function public._guard_points();

-- Activity of a member since a date (progress of the challenge / lottery requirements).
create or replace function public._activity(p_member text, p_since timestamptz) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'link_shares', (select count(*) from public.post_events where kind = 'share' and network = 'referral' and member_id = p_member and created_at >= p_since),
    'playlists', (select count(*) from public.playlists where owner_id = p_member and visibility in ('public', 'exclusive') and created_at >= p_since),
    'recommendations', (select count(*) from public.posts where owner_id = p_member and kind in ('recommendation', 'reclist') and visibility in ('public', 'exclusive') and created_at >= p_since),
    'comments', (select count(*) from public.comments where member_id = p_member and created_at >= p_since),
    'follows', (select count(*) from public.person_follows where member_id = p_member and created_at >= p_since),
    'watch_minutes', (select coalesce(sum(minutes), 0) from public.views where viewer_id = p_member and started_at >= p_since),
    'movies', (select count(distinct tmdb_id) from public.hestory where visitor_id = p_member and media_type = 'movie' and visited_at >= p_since),
    'series', (select count(distinct tmdb_id) from public.hestory where visitor_id = p_member and media_type = 'tv' and visited_at >= p_since)
  );
$$;

create or replace function public._draw(p_mode_id bigint) returns int
language plpgsql security definer set search_path = public as $$
declare md public.prize_modes; pz public.prizes; n int := 0; r record;
begin
  select * into md from public.prize_modes where id = p_mode_id for update;
  if not found then return 0; end if;
  if exists (select 1 from public.prize_mode_entries where mode_id = md.id and status = 'winner') then return 0; end if;
  select * into pz from public.prizes where id = md.prize_id;
  for r in
    select id, member_id from public.prize_mode_entries
    where mode_id = md.id and status = 'competitor' and (banned_until is null or banned_until <= now())
    order by random() limit greatest(1, coalesce(md.winners_needed, 1))
  loop
    update public.prize_mode_entries set status = 'winner', lottery_wins = coalesce(lottery_wins, 0) + 1 where id = r.id;
    insert into public.winners (prize_title, member_id, minutes_paid, group_name, ends_at)
    values (pz.title, r.member_id, coalesce(md.points_cost, 0), coalesce(pz.group_name, ''), null);
    perform public._notify_prize_staff(pz.id, r.member_id, 'prize_win');
    n := n + 1;
  end loop;
  return n;
end $$;

-- ------------------------------------------------------------------ 3. member RPCs
create or replace function public.prize_coupon_check(p_member text, p_prize bigint, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b public.prize_code_blocks; c public.prize_codes; m public.members; valid boolean := false; f int;
begin
  select * into m from public.members where member_id = p_member;
  if not found then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  select * into b from public.prize_code_blocks where member_id = p_member for update;
  if found and b.blocked_until is not null and b.blocked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'blocked', 'hours', greatest(1, ceil(extract(epoch from (b.blocked_until - now())) / 3600)::int));
  end if;
  select * into c from public.prize_codes where prize_id = p_prize and lower(code) = lower(trim(coalesce(p_code, ''))) limit 1;
  if found and c.active and (c.expires_at is null or c.expires_at > now())
     and (c.max_uses is null or c.uses < c.max_uses)
     and public._aud_ok(public._code_aud(c), m)
     and not exists (select 1 from public.prize_code_uses where code_id = c.id and member_id = p_member) then
    valid := true;
  end if;
  if valid then
    insert into public.prize_code_blocks (member_id, fails, blocked_until) values (p_member, 0, null)
    on conflict (member_id) do update set fails = 0, blocked_until = null, updated_at = now();
    return jsonb_build_object('ok', true, 'id', c.id, 'code', c.code, 'percent', c.percent);
  end if;
  f := coalesce(b.fails, 0) + 1;
  if f >= 3 then
    insert into public.prize_code_blocks (member_id, fails, blocked_until) values (p_member, 0, now() + interval '24 hours')
    on conflict (member_id) do update set fails = 0, blocked_until = now() + interval '24 hours', updated_at = now();
    return jsonb_build_object('ok', false, 'error', 'blocked', 'hours', 24);
  end if;
  insert into public.prize_code_blocks (member_id, fails, blocked_until) values (p_member, f, null)
  on conflict (member_id) do update set fails = f, blocked_until = null, updated_at = now();
  return jsonb_build_object('ok', false, 'error', 'invalid', 'left', 3 - f);
end $$;

create or replace function public.prize_join(p_member text, p_prize bigint, p_mode text, p_code text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.members; pz public.prizes; md public.prize_modes; c public.prize_codes;
  w record; today date := current_date; cost int; base int; cap int; taken int;
  lim int; per text; used int; entry_id bigint; st text; drawn boolean := false; names text[];
begin
  if p_mode not in ('gift', 'challenge', 'lottery') then return jsonb_build_object('ok', false, 'error', 'mode'); end if;
  -- Serialise every join of the same member (also guards the balance).
  perform 1 from public.profiles where member_id = p_member for update;
  select * into m from public.members where member_id = p_member;
  if not found or m.status <> 'active' then return jsonb_build_object('ok', false, 'error', 'inactive'); end if;
  select * into pz from public.prizes where id = p_prize;
  if not found or coalesce(pz.status, 'active') = 'ended' then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  select * into md from public.prize_modes where prize_id = p_prize and mode = p_mode for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'mode'); end if;

  -- legacy prize-wide visibility
  if coalesce(pz.visibility, 'public') = 'private' then
    names := regexp_split_to_array(lower(coalesce(pz.allowed_usernames, '')), '[,;]+');
    if not exists (
      select 1 from unnest(names) as allowed(name)
      where trim(allowed.name) in (lower(m.member_id), lower(m.username))
    ) then return jsonb_build_object('ok', false, 'error', 'audience'); end if;
  elsif coalesce(pz.visibility, 'public') = 'exclusive' then
    if coalesce(pz.countries, '') <> '' and not exists (
      select 1 from unnest(regexp_split_to_array(lower(pz.countries), '[,;]+')) as allowed(name)
      where trim(allowed.name) = lower(coalesce(m.country, ''))
    ) then return jsonb_build_object('ok', false, 'error', 'audience'); end if;
    if pz.min_age is not null and (m.birth_date is null or date_part('year', age(today, m.birth_date)) < pz.min_age) then return jsonb_build_object('ok', false, 'error', 'audience'); end if;
    if pz.max_age is not null and (m.birth_date is null or date_part('year', age(today, m.birth_date)) > pz.max_age) then return jsonb_build_object('ok', false, 'error', 'audience'); end if;
    if pz.watched_tmdb is not null and coalesce(pz.watched_type, '') <> '' and not exists (
      select 1 from public.hestory h
      where h.visitor_id = p_member and h.tmdb_id = pz.watched_tmdb and h.media_type = pz.watched_type
    ) then return jsonb_build_object('ok', false, 'error', 'audience'); end if;
  end if;

  select * into w from public._window(pz, md, m.country);
  if w.s is not null and w.s > today then return jsonb_build_object('ok', false, 'error', 'not_started'); end if;
  if p_mode <> 'lottery' and w.e is not null and w.e < today then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  if not public._aud_ok(md.config->'audience', m) then return jsonb_build_object('ok', false, 'error', 'audience'); end if;
  if coalesce(pz.minutes_required, 0) > coalesce((select coalesce(private_minutes, 0) + coalesce(public_minutes, 0) from public.profiles where member_id = p_member), 0) then
    return jsonb_build_object('ok', false, 'error', 'incomplete');
  end if;
  if exists (select 1 from public.prize_mode_entries where mode_id = md.id and member_id = p_member) then
    return jsonb_build_object('ok', false, 'error', 'already');
  end if;

  cap := case when p_mode = 'lottery' then md.winners_needed else md.quantity end;
  select count(*) into taken from public.prize_mode_entries where mode_id = md.id and status = 'winner';
  if cap is not null and taken >= cap then return jsonb_build_object('ok', false, 'error', 'sold_out'); end if;

  select limit_count, period into lim, per from public.prize_limits
  where tier = initcap(coalesce(nullif(m.membership_type, ''), 'Free')) and mode = p_mode;
  if lim is not null then
    if per = 'month' then
      select count(*) into used from public.prize_mode_entries
      where member_id = p_member and mode = p_mode and status not in ('withdrawn', 'excluded') and created_at >= date_trunc('month', now());
    else
      select count(*) into used from public.prize_mode_entries e join public.prizes x on x.id = e.prize_id
      where e.member_id = p_member and e.mode = p_mode and e.status = 'competitor' and coalesce(x.status, 'active') <> 'ended';
    end if;
    if used >= lim then return jsonb_build_object('ok', false, 'error', 'quota', 'cap', lim, 'period', per); end if;
  end if;

  base := coalesce(md.points_cost, 0);
  cost := base;
  if p_code is not null and trim(p_code) <> '' and p_mode = 'gift' then
    select * into c from public.prize_codes where prize_id = p_prize and lower(code) = lower(trim(p_code)) for update;
    if not found or not c.active or (c.expires_at is not null and c.expires_at <= now())
       or (c.max_uses is not null and c.uses >= c.max_uses) or not public._aud_ok(public._code_aud(c), m)
       or exists (select 1 from public.prize_code_uses where code_id = c.id and member_id = p_member) then
      return jsonb_build_object('ok', false, 'error', 'coupon');
    end if;
    cost := greatest(0, ceil(base * (100 - c.percent) / 100.0)::int);
  end if;

  if not public._spend_prize(p_member, cost, pz.title, p_mode) then return jsonb_build_object('ok', false, 'error', 'points', 'need', cost); end if;

  st := case when p_mode = 'gift' then 'winner' else 'competitor' end;
  insert into public.prize_mode_entries (prize_id, mode_id, member_id, mode, points_paid, status, lottery_wins, lottery_plays, coupon_id)
  values (p_prize, md.id, p_member, p_mode, cost, st, 0, case when p_mode = 'lottery' then 1 else 0 end, c.id)
  returning id into entry_id;
  insert into public.prize_entries (prize_id, member_id) values (p_prize, p_member) on conflict do nothing;

  if c.id is not null then
    insert into public.prize_code_uses (code_id, prize_id, member_id, points_saved) values (c.id, p_prize, p_member, base - cost);
    update public.prize_codes set uses = uses + 1 where id = c.id;
  end if;
  if p_mode = 'gift' then
    insert into public.winners (prize_title, member_id, minutes_paid, group_name, ends_at)
    values (pz.title, p_member, cost, coalesce(pz.group_name, ''), w.e);
    update public.prizes set winners_count = coalesce(winners_count, 0) + 1 where id = p_prize;
    perform public._notify_prize_staff(pz.id, p_member, 'prize_win');
  end if;
  if p_mode = 'lottery' and md.draw_at is not null
     and (select count(*) from public.prize_mode_entries where mode_id = md.id) >= md.draw_at
     and (nullif(md.config->>'draw_on', '') is null or (md.config->>'draw_on')::date <= today) then
    drawn := public._draw(md.id) > 0;
  end if;
  return jsonb_build_object('ok', true, 'entry_id', entry_id, 'status', st, 'cost', cost, 'drawn', drawn);
end $$;

create or replace function public.prize_withdraw(p_member text, p_entry bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  update public.prize_mode_entries set status = 'withdrawn', withdrawn_at = now()
  where id = p_entry and member_id = p_member and status = 'competitor' and mode <> 'gift';
  return jsonb_build_object('ok', found);
end $$;

-- A selected winner can ask the team to arrange prize fulfillment. Locking the
-- entry makes this idempotent: repeated clicks produce only one staff alert.
-- With sql/prize_claims.sql installed, the claim also gets its review row
-- (Panel > Prizes > Prize claims), and a member whose earlier claim was rejected
-- with a block cannot claim until the block ends.
create or replace function public.prize_request_claim(p_member text, p_entry bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.prize_mode_entries; blocked timestamptz; claims boolean := to_regclass('public.prize_claims') is not null;
begin
  select * into e from public.prize_mode_entries
  where id = p_entry and member_id = p_member for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_winner'); end if;
  if e.status <> 'winner' then return jsonb_build_object('ok', false, 'error', 'not_winner'); end if;
  if e.claim_requested_at is not null then
    return jsonb_build_object('ok', true, 'already', true, 'requested_at', e.claim_requested_at);
  end if;
  if claims then
    select max(restricted_until) into blocked from public.prize_claims
    where member_id = p_member and status = 'rejected' and lifted_at is null and restricted_until > now();
    if blocked is not null then return jsonb_build_object('ok', false, 'error', 'claim_restricted', 'until', blocked); end if;
  end if;
  update public.prize_mode_entries set claim_requested_at = now() where id = e.id;
  if claims then
    insert into public.prize_claims (member_id, prize_id, prize_title, mode, entry_id, points_paid)
    select p_member, e.prize_id, coalesce((select title from public.prizes where id = e.prize_id), ''),
           coalesce(e.mode, ''), e.id, coalesce(e.points_paid, 0)
    on conflict do nothing;
  end if;
  perform public._notify_prize_staff(e.prize_id, p_member, 'prize_claim');
  return jsonb_build_object('ok', true, 'already', false);
end $$;

-- Challenge: the first members who finish every requirement in time win.
create or replace function public.prize_claim_challenge(p_member text, p_entry bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.prize_mode_entries; md public.prize_modes; pz public.prizes; act jsonb; c record; got numeric; taken int; days int; pts jsonb;
begin
  select * into e from public.prize_mode_entries where id = p_entry and member_id = p_member for update;
  if not found or e.mode <> 'challenge' or e.status <> 'competitor' or (e.banned_until is not null and e.banned_until > now()) then
    return jsonb_build_object('ok', false, 'error', 'not_competing');
  end if;
  select * into md from public.prize_modes where id = e.mode_id for update;
  select * into pz from public.prizes where id = e.prize_id;
  if coalesce(pz.status, 'active') = 'ended' then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  days := nullif(md.config->>'days', '')::int;
  if days is not null and now() > e.created_at + make_interval(days => days) then return jsonb_build_object('ok', false, 'error', 'time_up'); end if;
  if not exists (select 1 from public.prize_mode_conditions where mode_id = md.id) then return jsonb_build_object('ok', false, 'error', 'no_conditions'); end if;
  act := public._activity(p_member, e.created_at);
  for c in select * from public.prize_mode_conditions where mode_id = md.id loop
    if c.kind = 'watch' then
      got := (select count(*) from public.hestory where visitor_id = p_member and tmdb_id = c.tmdb_id and media_type = coalesce(c.media_type, 'movie'));
    elsif c.kind = 'points' then
      pts := public._points(p_member);
      got := (select coalesce(private_minutes, 0) + coalesce(public_minutes, 0) from public.profiles where member_id = p_member);
    elsif c.kind in ('share', 'invite') then
      got := coalesce((select progress from public.prize_mode_progress where entry_id = e.id and condition_id = c.id), 0);
    else
      got := coalesce((act->>c.kind)::numeric, 0);
    end if;
    if got < greatest(1, c.required) then return jsonb_build_object('ok', false, 'error', 'incomplete'); end if;
  end loop;
  select count(*) into taken from public.prize_mode_entries where mode_id = md.id and status = 'winner';
  if md.quantity is not null and taken >= md.quantity then return jsonb_build_object('ok', false, 'error', 'sold_out'); end if;
  update public.prize_mode_entries set status = 'winner' where id = e.id;
  insert into public.winners (prize_title, member_id, minutes_paid, group_name, ends_at)
  values (pz.title, p_member, coalesce(e.points_paid, 0), coalesce(pz.group_name, ''), md.ends_at);
  perform public._notify_prize_staff(pz.id, p_member, 'prize_win');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.prize_log_visit(p_prize bigint, p_visitor text, p_country text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.prizes where id = p_prize) then return; end if;
  if coalesce(p_visitor, '') <> '' and exists (
       select 1 from public.prize_views where prize_id = p_prize and visitor_id = p_visitor and created_at > now() - interval '30 minutes') then
    return;
  end if;
  insert into public.prize_views (prize_id, visitor_id, country) values (p_prize, coalesce(p_visitor, ''), coalesce(p_country, ''));
end $$;

-- Free "follow this prize" subscription of prizes without modes (the old page button).
create or replace function public.prize_subscribe_plain(p_member text, p_prize bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pz public.prizes;
begin
  if not exists (select 1 from public.members where member_id = p_member and status = 'active') then
    return jsonb_build_object('ok', false, 'error', 'inactive');
  end if;
  select * into pz from public.prizes where id = p_prize;
  if not found or coalesce(pz.status, 'active') = 'ended' then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  insert into public.prize_entries (prize_id, member_id) values (p_prize, p_member) on conflict do nothing;
  return jsonb_build_object('ok', true, 'already', not found);
end $$;

-- Prizes that have no subscription modes (dashboard "claim"). Prizes with modes are joined with prize_join.
-- With sql/prize_claims.sql installed: a blocked member cannot claim, a prize whose claim
-- was rejected cannot be claimed again, and every claim gets its review row.
create or replace function public.prize_claim_simple(p_member text, p_prize bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.members;
  pz public.prizes;
  pr public.profiles;
  today date := current_date;
  yrs int;
  wid bigint;
  blocked timestamptz;
  claims boolean := to_regclass('public.prize_claims') is not null;
begin
  select * into pr from public.profiles where member_id = p_member for update;
  select * into m from public.members where member_id = p_member;
  if not found or m.status <> 'active' then return jsonb_build_object('ok', false, 'error', 'inactive'); end if;
  if claims then
    select max(restricted_until) into blocked from public.prize_claims
    where member_id = p_member and status = 'rejected' and lifted_at is null and restricted_until > now();
    if blocked is not null then return jsonb_build_object('ok', false, 'error', 'claim_restricted', 'until', blocked); end if;
    if exists (select 1 from public.prize_claims where member_id = p_member and prize_id = p_prize and status = 'rejected') then
      return jsonb_build_object('ok', false, 'error', 'claim_rejected');
    end if;
  end if;
  select * into pz from public.prizes where id = p_prize for update;
  if not found or coalesce(pz.status, 'active') = 'ended' then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  if exists (select 1 from public.prize_modes where prize_id = p_prize) then return jsonb_build_object('ok', false, 'error', 'use_modes'); end if;
  if exists (select 1 from public.winners where member_id = p_member and prize_title = pz.title) then
    return jsonb_build_object('ok', false, 'error', 'already');
  end if;
  if pz.starts_at is not null and pz.starts_at > today then return jsonb_build_object('ok', false, 'error', 'not_started'); end if;
  if not coalesce(pz.unlimited_time, false) and pz.ends_at is not null and pz.ends_at < today then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  if pz.quantity is not null and coalesce(pz.winners_count, 0) >= pz.quantity then return jsonb_build_object('ok', false, 'error', 'sold_out'); end if;

  if coalesce(pz.visibility, 'public') = 'private' and not exists (
    select 1 from unnest(regexp_split_to_array(lower(coalesce(pz.allowed_usernames, '')), '[,;]+')) as allowed(name)
    where trim(allowed.name) in (lower(m.member_id), lower(m.username))
  ) then
    return jsonb_build_object('ok', false, 'error', 'audience');
  elsif coalesce(pz.visibility, 'public') = 'exclusive' then
    if coalesce(pz.countries, '') <> '' and not exists (
      select 1 from unnest(regexp_split_to_array(lower(pz.countries), '[,;]+')) as allowed(name)
      where trim(allowed.name) = lower(coalesce(m.country, ''))
    ) then return jsonb_build_object('ok', false, 'error', 'audience'); end if;
    yrs := case when m.birth_date is null then null else date_part('year', age(today, m.birth_date))::int end;
    if pz.min_age is not null and (yrs is null or yrs < pz.min_age) then return jsonb_build_object('ok', false, 'error', 'audience'); end if;
    if pz.max_age is not null and (yrs is null or yrs > pz.max_age) then return jsonb_build_object('ok', false, 'error', 'audience'); end if;
    if pz.watched_tmdb is not null and coalesce(pz.watched_type, '') <> '' and not exists (
      select 1 from public.hestory h
      where h.visitor_id = p_member and h.tmdb_id = pz.watched_tmdb and h.media_type = pz.watched_type
    ) then return jsonb_build_object('ok', false, 'error', 'audience'); end if;
  end if;

  if coalesce(pr.private_minutes, 0) + coalesce(pr.public_minutes, 0) < greatest(0, coalesce(pz.minutes_required, 0)) then
    return jsonb_build_object('ok', false, 'error', 'incomplete');
  end if;
  if not public._spend_prize(p_member, coalesce(pz.minutes_required, 0), pz.title, 'claim') then
    return jsonb_build_object('ok', false, 'error', 'points', 'need', pz.minutes_required);
  end if;
  insert into public.winners (prize_title, member_id, minutes_paid, group_name, claim_requested_at)
  values (pz.title, p_member, coalesce(pz.minutes_required, 0), coalesce(pz.group_name, ''), now())
  returning id into wid;
  update public.prizes set winners_count = coalesce(winners_count, 0) + 1 where id = p_prize;
  if claims then
    insert into public.prize_claims (member_id, prize_id, prize_title, mode, winner_id, points_paid)
    values (p_member, p_prize, pz.title, 'claim', wid, coalesce(pz.minutes_required, 0))
    on conflict do nothing;
  end if;
  perform public._notify_prize_staff(pz.id, p_member, 'prize_claim');
  return jsonb_build_object('ok', true, 'cost', coalesce(pz.minutes_required, 0));
end $$;

-- ------------------------------------------------------------------ 4. staff prize RPCs
-- Whole prize (details, categories, dates, modes, requirements, coupons) in one transaction.
create or replace function public.prize_admin_save(p_token text, p_id bigint, d jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.staff; pid bigint; k text; mo jsonb; enabled text[] := '{}'; cur public.prize_modes; mid bigint;
  gids bigint[] := '{}'; gid bigint; nm text; first_g public.prize_groups;
  allpriv boolean := true; ids text[] := '{}'; imgs text[]; start_d date; end_d date;
  minpts int; r jsonb; cnd public.prize_mode_conditions; keep bigint[]; code text; pct int; aud text; cid bigint;
begin
  s := public._staff_prizes(p_token);
  if coalesce(trim(d->>'title'), '') = '' or coalesce(trim(d->>'description'), '') = '' then raise exception 'title'; end if;
  if jsonb_array_length(coalesce(d->'categories', '[]'::jsonb)) = 0 then raise exception 'category'; end if;
  if nullif(d->>'start', '') is null then raise exception 'start'; end if;
  start_d := (d->>'start')::date; end_d := nullif(d->>'end', '')::date;
  if end_d is not null and end_d < start_d then raise exception 'end_before_start'; end if;
  for k in select jsonb_object_keys(coalesce(d->'modes', '{}'::jsonb)) loop
    if k not in ('gift', 'challenge', 'lottery') then raise exception 'mode'; end if;
    enabled := enabled || k;
  end loop;
  if cardinality(enabled) = 0 then raise exception 'mode'; end if;

  -- per-mode validation
  if 'gift' = any (enabled) then
    mo := d->'modes'->'gift';
    if coalesce((mo->>'quantity')::int, 0) < 1 or coalesce((mo->>'points_cost')::int, 0) < 1 then raise exception 'gift'; end if;
  end if;
  if 'challenge' = any (enabled) then
    mo := d->'modes'->'challenge';
    if coalesce((mo->>'quantity')::int, 0) < 1 or coalesce((mo->>'days')::int, 0) < 1 or (mo->>'points_cost') is null or (mo->>'points_cost')::int < 0 then raise exception 'challenge'; end if;
  end if;
  if 'lottery' = any (enabled) then
    mo := d->'modes'->'lottery';
    if (mo->>'points_cost') is null or (mo->>'points_cost')::int < 0 or coalesce((mo->>'draw_at')::int, 0) < 1
       or coalesce((mo->>'winners_needed')::int, 0) < 1 or nullif(mo->>'opens_at', '') is null then raise exception 'lottery'; end if;
  end if;
  for r in select * from jsonb_array_elements(coalesce(d->'codes', '[]'::jsonb)) loop
    code := r->>'code'; pct := (r->>'percent')::int;
    if code !~ '^[A-Za-z0-9_-]{3,32}$' then raise exception 'code'; end if;
    if pct is null or pct < 10 or pct > 80 then raise exception 'percent'; end if;
  end loop;

  -- categories
  for nm in select trim(x) from jsonb_array_elements_text(d->'categories') x where trim(x) <> '' loop
    select id into gid from public.prize_groups where lower(name) = lower(nm) limit 1;
    if gid is null then insert into public.prize_groups (name, visible) values (nm, true) returning id into gid; end if;
    if not gid = any (gids) then gids := gids || gid; end if;
  end loop;
  select * into first_g from public.prize_groups where id = gids[1];

  select array_agg(x) into imgs from jsonb_array_elements_text(coalesce(d->'images', '[]'::jsonb)) x;
  select min((d->'modes'->x->>'points_cost')::int) into minpts from unnest(enabled) x;
  for k in select unnest(enabled) loop
    allpriv := allpriv and coalesce(d->'modes'->k->'audience'->>'type', '') = 'private';
    if coalesce(d->'modes'->k->'audience'->>'type', '') = 'private' then
      select ids || array_agg(x) into ids from jsonb_array_elements_text(coalesce(d->'modes'->k->'audience'->'member_ids', '[]'::jsonb)) x;
    end if;
  end loop;

  if p_id is null then
    insert into public.prizes (title, description, status) values (trim(d->>'title'), d->>'description', 'active') returning id into pid;
  else
    pid := p_id;
    if not exists (select 1 from public.prizes where id = pid) then raise exception 'not_found'; end if;
  end if;
  update public.prizes set
    title = trim(d->>'title'), description = d->>'description',
    group_id = gids[1], group_name = coalesce(first_g.name, 'General'), group_thumb = coalesce(first_g.thumb, ''),
    categories = (select string_agg(trim(x), ',') from jsonb_array_elements_text(d->'categories') x where trim(x) <> ''),
    prize_image = coalesce(imgs[1], ''), images = coalesce(array_to_string(imgs, E'\n'), ''), video_url = coalesce(d->>'video', ''),
    starts_at = start_d, ends_at = end_d, unlimited_time = (end_d is null),
    minutes_required = minpts,
    quantity = coalesce((d->'modes'->'gift'->>'quantity')::int, (d->'modes'->'challenge'->>'quantity')::int),
    winners_needed = coalesce((d->'modes'->'lottery'->>'winners_needed')::int, 1),
    subscribers_needed = (d->'modes'->'lottery'->>'draw_at')::int,
    visibility = case when allpriv then 'private' else 'public' end,
    allowed_usernames = case when allpriv then coalesce(array_to_string(ids, ','), '') else '' end
  where id = pid;

  -- modes
  foreach k in array array['gift', 'challenge', 'lottery'] loop
    select * into cur from public.prize_modes where prize_id = pid and mode = k;
    if not k = any (enabled) then
      if found then
        if exists (select 1 from public.prize_mode_entries where mode_id = cur.id) then raise exception 'mode_has_entries:%', k; end if;
        delete from public.prize_mode_progress where condition_id in (select id from public.prize_mode_conditions where mode_id = cur.id);
        delete from public.prize_mode_conditions where mode_id = cur.id;
        delete from public.prize_modes where id = cur.id;
      end if;
      continue;
    end if;
    mo := d->'modes'->k;
    if not found then
      insert into public.prize_modes (prize_id, mode, points_cost) values (pid, k, 0) returning id into mid;
    else mid := cur.id; end if;
    if k = 'gift' then
      update public.prize_modes set points_cost = (mo->>'points_cost')::int, starts_at = start_d, ends_at = end_d, unlimited_time = (end_d is null),
        quantity = (mo->>'quantity')::int, winners_needed = null, draw_at = null, sort_order = 0, config = jsonb_build_object('audience', mo->'audience') where id = mid;
    elsif k = 'challenge' then
      update public.prize_modes set points_cost = (mo->>'points_cost')::int, starts_at = start_d, ends_at = end_d, unlimited_time = (end_d is null),
        quantity = (mo->>'quantity')::int, winners_needed = null, draw_at = null, sort_order = 1,
        config = jsonb_build_object('days', (mo->>'days')::int, 'audience', mo->'audience') where id = mid;
    else
      update public.prize_modes set points_cost = (mo->>'points_cost')::int, starts_at = (mo->>'opens_at')::date, ends_at = null, unlimited_time = true,
        quantity = null, winners_needed = (mo->>'winners_needed')::int, draw_at = (mo->>'draw_at')::int, sort_order = 2,
        config = jsonb_build_object('opens_at', mo->>'opens_at', 'draw_on', nullif(mo->>'draw_on', ''), 'audience', mo->'audience') where id = mid;
    end if;

    -- requirements: keep unchanged rows (and their progress), change / add / drop the rest
    keep := '{}';
    for r in select * from jsonb_array_elements(coalesce(d->'conds', '[]'::jsonb)) where value->>'mode' = k loop
      select * into cnd from public.prize_mode_conditions
      where mode_id = mid and kind = r->>'kind' and coalesce(media_type, '') = coalesce(r->>'media_type', '') and coalesce(tmdb_id, 0) = coalesce((r->>'tmdb_id')::int, 0);
      if found then
        update public.prize_mode_conditions set required = (r->>'required')::int where id = cnd.id;
        keep := keep || cnd.id;
      else
        insert into public.prize_mode_conditions (mode_id, kind, media_type, tmdb_id, required)
        values (mid, r->>'kind', nullif(r->>'media_type', ''), (r->>'tmdb_id')::int, (r->>'required')::int) returning id into cid;
        keep := keep || cid;
      end if;
    end loop;
    delete from public.prize_mode_progress where condition_id in (select id from public.prize_mode_conditions where mode_id = mid and not id = any (keep));
    delete from public.prize_mode_conditions where mode_id = mid and not id = any (keep);
  end loop;

  delete from public.prize_group_links where prize_id = pid;
  insert into public.prize_group_links (prize_id, group_id) select pid, unnest(gids);
  delete from public.prize_country_dates where prize_id = pid;
  for r in select * from jsonb_array_elements(coalesce(d->'dates', '[]'::jsonb)) loop
    if coalesce(r->>'country', '') = '' or nullif(r->>'starts_at', '') is null then raise exception 'country_date'; end if;
    insert into public.prize_country_dates (prize_id, country, starts_at, ends_at)
    values (pid, r->>'country', (r->>'starts_at')::date, nullif(r->>'ends_at', '')::date);
  end loop;

  -- coupons
  keep := '{}';
  for r in select * from jsonb_array_elements(coalesce(d->'codes', '[]'::jsonb)) loop
    if nullif(r->>'id', '') is not null then keep := keep || (r->>'id')::bigint; end if;
  end loop;
  delete from public.prize_code_uses where code_id in (select id from public.prize_codes where prize_id = pid and not id = any (keep));
  delete from public.prize_codes where prize_id = pid and not id = any (keep);
  for r in select * from jsonb_array_elements(coalesce(d->'codes', '[]'::jsonb)) loop
    if nullif(r->>'id', '') is not null then
      update public.prize_codes set code = r->>'code', percent = (r->>'percent')::int, audience = r->>'audience', countries = coalesce(r->>'countries', ''),
        genders = coalesce(r->>'genders', ''), min_age = (r->>'min_age')::int, max_age = (r->>'max_age')::int,
        min_account_days = (r->>'min_account_days')::int, member_ids = coalesce(r->>'member_ids', ''),
        expires_at = nullif(r->>'expires_at', '')::timestamptz, max_uses = (r->>'max_uses')::int
      where id = (r->>'id')::bigint and prize_id = pid;
    else
      insert into public.prize_codes (prize_id, code, percent, audience, countries, genders, min_age, max_age, min_account_days, member_ids, expires_at, max_uses)
      values (pid, r->>'code', (r->>'percent')::int, r->>'audience', coalesce(r->>'countries', ''), coalesce(r->>'genders', ''),
              (r->>'min_age')::int, (r->>'max_age')::int, (r->>'min_account_days')::int, coalesce(r->>'member_ids', ''),
              nullif(r->>'expires_at', '')::timestamptz, (r->>'max_uses')::int);
    end if;
  end loop;
  if p_id is null then perform public._notify_new_prize(pid); end if;
  return jsonb_build_object('ok', true, 'id', pid);
exception
  when unique_violation then return jsonb_build_object('ok', false, 'error', 'duplicate');
  when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end $$;

create or replace function public.prize_admin_end(p_token text, p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public._staff_prizes(p_token);
  update public.prizes set status = 'ended', ended_at = now() where id = p_id;
  return jsonb_build_object('ok', found);
end $$;

create or replace function public.prize_admin_delete(p_token text, p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pz public.prizes;
begin
  perform public._staff_prizes(p_token);
  select * into pz from public.prizes where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if coalesce(pz.status, 'active') <> 'ended' then return jsonb_build_object('ok', false, 'error', 'not_ended'); end if;
  delete from public.prize_mode_progress where condition_id in (select c.id from public.prize_mode_conditions c join public.prize_modes m on m.id = c.mode_id where m.prize_id = p_id);
  delete from public.prize_mode_conditions where mode_id in (select id from public.prize_modes where prize_id = p_id);
  delete from public.prize_code_uses where prize_id = p_id;
  delete from public.prize_codes where prize_id = p_id;
  delete from public.prize_views where prize_id = p_id;
  delete from public.prize_country_dates where prize_id = p_id;
  delete from public.prize_group_links where prize_id = p_id;
  delete from public.prize_mode_entries where prize_id = p_id;
  delete from public.prize_modes where prize_id = p_id;
  delete from public.prize_entries where prize_id = p_id;
  delete from public.prizes where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.prize_admin_entry(p_token text, p_entry bigint, p_action text, p_days int, p_by text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.prize_mode_entries; pz public.prizes;
begin
  perform public._staff_prizes(p_token);
  select * into e from public.prize_mode_entries where id = p_entry for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select * into pz from public.prizes where id = e.prize_id;
  if p_action = 'winner' then
    update public.prize_mode_entries set status = 'winner', banned_until = null, status_by = coalesce(p_by, '') where id = e.id;
    if not exists (select 1 from public.winners where prize_title = pz.title and member_id = e.member_id) then
      insert into public.winners (prize_title, member_id, minutes_paid, group_name, ends_at) values (pz.title, e.member_id, coalesce(e.points_paid, 0), coalesce(pz.group_name, ''), pz.ends_at);
    end if;
    if lower(coalesce(e.status, '')) <> 'winner' then perform public._notify_prize_staff(pz.id, e.member_id, 'prize_win'); end if;
  elsif p_action in ('excluded', 'competitor') then
    update public.prize_mode_entries set status = p_action, banned_until = case when p_action = 'competitor' then null else banned_until end, status_by = coalesce(p_by, '') where id = e.id;
    delete from public.winners where prize_title = pz.title and member_id = e.member_id;
  elsif p_action = 'unban' then
    update public.prize_mode_entries set banned_until = null, status_by = coalesce(p_by, '') where id = e.id;
  elsif p_action = 'ban' then
    if coalesce(p_days, 0) < 1 or p_days > 3650 then return jsonb_build_object('ok', false, 'error', 'days'); end if;
    update public.prize_mode_entries set banned_until = now() + make_interval(days => p_days), status_by = coalesce(p_by, '') where id = e.id;
  else
    return jsonb_build_object('ok', false, 'error', 'action');
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.prize_admin_limits(p_token text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  perform public._staff_prizes(p_token);
  for r in select * from jsonb_array_elements(p_rows) loop
    update public.prize_limits set limit_count = greatest(0, (r->>'limit_count')::int) where tier = r->>'tier' and mode = r->>'mode';
  end loop;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.prize_admin_group(p_token text, p_op text, p_id bigint, p_name text, p_thumb text, p_visible boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public._staff_prizes(p_token);
  if p_op = 'add' then
    if coalesce(trim(p_name), '') = '' then return jsonb_build_object('ok', false, 'error', 'name'); end if;
    insert into public.prize_groups (name, thumb, visible) values (trim(p_name), coalesce(p_thumb, ''), true);
  elsif p_op = 'visible' then
    update public.prize_groups set visible = coalesce(p_visible, true) where id = p_id;
  elsif p_op = 'delete' then
    update public.prizes set group_id = null where group_id = p_id;
    delete from public.prize_group_links where group_id = p_id;
    delete from public.prize_groups where id = p_id;
  else
    return jsonb_build_object('ok', false, 'error', 'op');
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.prize_admin_codes(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public._staff_prizes(p_token);
  return coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from public.prize_codes c), '[]'::jsonb);
end $$;

-- Counts for the manage list (so the panel does not download every entry).
create or replace function public.prize_admin_overview(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public._staff_prizes(p_token);
  return coalesce((select jsonb_agg(jsonb_build_object('prize_id', prize_id, 'entries', n, 'winners', w))
                   from (select prize_id, count(*) n, count(*) filter (where status = 'winner') w from public.prize_mode_entries group by prize_id) x), '[]'::jsonb);
end $$;

create or replace function public.prize_admin_stats(p_token text, p_from date, p_to date, p_prize bigint, p_mode text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare res jsonb;
begin
  perform public._staff_prizes(p_token);
  with pz as (
    select id, title from public.prizes
    where (p_prize is null or id = p_prize)
      and (p_mode is null or exists (select 1 from public.prize_modes m where m.prize_id = prizes.id and m.mode = p_mode))
  ), v as (
    select * from public.prize_views where prize_id in (select id from pz)
      and (p_from is null or created_at::date >= p_from) and (p_to is null or created_at::date <= p_to)
  ), e as (
    select * from public.prize_mode_entries where prize_id in (select id from pz) and (p_mode is null or mode = p_mode)
  ), j as (
    select * from e where (p_from is null or created_at::date >= p_from) and (p_to is null or created_at::date <= p_to)
  ), wd as (
    select * from e where status = 'withdrawn'
      and (p_from is null or coalesce(withdrawn_at, created_at)::date >= p_from) and (p_to is null or coalesce(withdrawn_at, created_at)::date <= p_to)
  )
  select jsonb_build_object(
    'visits', (select count(*) from v),
    'visitors', (select count(distinct visitor_id) from v where visitor_id <> ''),
    'joined', (select count(*) from j),
    'withdrawn', (select count(*) from wd),
    'winners', (select count(*) from j where status = 'winner'),
    'per_prize', coalesce((select jsonb_agg(jsonb_build_object('id', pz.id, 'title', pz.title,
        'visits', (select count(*) from v where v.prize_id = pz.id),
        'visitors', (select count(distinct visitor_id) from v where v.prize_id = pz.id and visitor_id <> ''),
        'joined', (select count(*) from j where j.prize_id = pz.id),
        'withdrawn', (select count(*) from wd where wd.prize_id = pz.id),
        'winners', (select count(*) from j where j.prize_id = pz.id and j.status = 'winner')) order by pz.id desc) from pz), '[]'::jsonb),
    'per_day', coalesce((select jsonb_agg(jsonb_build_object('d', d, 'visits', vv, 'joined', jj) order by d)
        from (select d, sum(vv) vv, sum(jj) jj from (
                select created_at::date d, count(*) vv, 0 jj from v group by 1
                union all select created_at::date, 0, count(*) from j group by 1) u group by d order by d desc limit 62) z), '[]'::jsonb)
  ) into res;
  return res;
end $$;

-- ------------------------------------------------------------------ 5. scheduled
create or replace function public.prize_run_scheduled() returns int
language plpgsql security definer set search_path = public as $$
declare md record; n int := 0;
begin
  for md in
    select m.id from public.prize_modes m join public.prizes p on p.id = m.prize_id
    where m.mode = 'lottery' and coalesce(p.status, 'active') <> 'ended' and m.draw_at is not null
      and (select count(*) from public.prize_mode_entries e where e.mode_id = m.id) >= m.draw_at
      and (nullif(m.config->>'draw_on', '') is null or (m.config->>'draw_on')::date <= current_date)
      and not exists (select 1 from public.prize_mode_entries e where e.mode_id = m.id and e.status = 'winner')
  loop
    n := n + public._draw(md.id);
  end loop;
  return n;
end $$;

do $$
begin
  begin
    create extension if not exists pg_cron;
    perform cron.unschedule('prize_run_scheduled') where exists (select 1 from cron.job where jobname = 'prize_run_scheduled');
    perform cron.schedule('prize_run_scheduled', '*/10 * * * *', 'select public.prize_run_scheduled()');
  exception when others then
    raise notice 'pg_cron is not enabled: lotteries are still drawn when the last member joins. Enable pg_cron to draw on the draw date.';
  end;
end $$;

-- ------------------------------------------------------------------ 6. indexes
create index if not exists prize_mode_entries_mode_status_idx on public.prize_mode_entries (mode_id, status);
create index if not exists prize_mode_entries_member_status_idx on public.prize_mode_entries (member_id, status, created_at);
create index if not exists prize_mode_entries_created_idx on public.prize_mode_entries (created_at);
create index if not exists prize_views_created_idx on public.prize_views (created_at);
create index if not exists prize_codes_prize_idx on public.prize_codes (prize_id);

-- ------------------------------------------------------------------ 7. lock the tables
do $$
declare t text; pol record;
begin
  -- public read, no public write
  foreach t in array array['prizes','prize_groups','prize_group_links','prize_modes','prize_mode_conditions','prize_country_dates',
                           'prize_limits','prize_mode_entries','prize_mode_progress','prize_entries','winners']
  loop
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL') loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
  end loop;
  -- secret / server-only
  foreach t in array array['prize_codes','prize_code_uses','prize_code_blocks','prize_views','staff_sessions','staff_login_attempts']
  loop
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
  -- staff: readable without the password column, never writable
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'staff' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL') loop
    execute format('drop policy %I on public.staff', pol.policyname);
  end loop;
  revoke all on public.staff from anon, authenticated;
  grant select (id, role, member_id, username, sections, created_at) on public.staff to anon, authenticated;
end $$;

-- ------------------------------------------------------------------ 8. who may call what
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like '\_%' or p.proname in ('prize_run_scheduled'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in (
             'staff_login','staff_session','staff_logout','staff_setup_super','staff_add','staff_set_sections','staff_remove','staff_set_password',
             'prize_coupon_check','prize_join','prize_subscribe_plain','prize_withdraw','prize_request_claim','prize_claim_challenge','prize_log_visit','prize_claim_simple',
             'prize_admin_save','prize_admin_end','prize_admin_delete','prize_admin_entry','prize_admin_limits','prize_admin_group',
             'prize_admin_codes','prize_admin_overview','prize_admin_stats')
  loop
    execute format('grant execute on function %s to anon, authenticated', f.sig);
  end loop;
end $$;

revoke all on function public._notify_prize_staff(bigint, text, text) from public, anon, authenticated;
revoke all on function public._notify_new_prize(bigint) from public, anon, authenticated;

notify pgrst, 'reload schema';
