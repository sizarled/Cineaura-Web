-- ============================================================
-- CineAura — Panel > Packages: the account codes, the prize codes, and the Panel functions of
-- the three packages
-- Run in the Supabase SQL editor AFTER activation.sql, account_deadline.sql, prize_secure.sql
-- and point_codes.sql (safe to run more than once).
--
-- Panel > Packages has three tabs (the Super Admin, or staff with the Packages section):
--   Accounts  account_codes      an activation or a reactivation serial: the membership it gives
--                                (Free / Silver / Gold / Diamond) and for how many months. The
--                                member types it on the activation page (activate.html):
--                                account_code_redeem(). An "activation" code is for an account
--                                that was never activated, a "reactivation" code for the others,
--                                or both. The same plan still running: the months are added to it.
--   Points    point_codes        the points a serial adds (Dashboard > Points; sql/point_codes.sql)
--   Prizes    prize_pack_codes   the points a serial takes off the points a prize asks for, in any
--                                mode with a points cost (the prize page: prize_coupon_check and
--                                prize_join of sql/prize_secure.sql call _prize_pack_check())
-- Every serial: typed by hand or drawn at random (16 characters, XXXX-XXXX-XXXX-XXXX), how many
-- times it can be used (once by default; each member once), an end date (optional), a note, and
-- who may use it: public, exclusive (membership plans, countries, site languages, account level,
-- account age) or private (the members named) — _pack_aud_ok() of sql/point_codes.sql.
-- A private code needs no serial typed: the members named get it by themselves (one use each) —
-- the membership or the points at once when the code is saved (_pack_give_private, with a bell),
-- the prize discount filled in on the prize page at their next entry that costs points
-- (prize_pack_mine).
--
-- The codes of activation.sql (one use each, made in the SQL editor) keep working: the activation
-- page sends every code to account_code_redeem(), which uses them up on the server as well.
-- Nothing here is open to the public API: the browser calls the functions (security definer).
-- ============================================================

do $$
begin
  if to_regprocedure('public._pack_aud_ok(text, jsonb, text)') is null then
    raise exception 'Run sql/point_codes.sql first (it has the audience of the codes, _pack_aud_ok).';
  end if;
end $$;

-- ------------------------------------------------------------------ 1. tables
create table if not exists public.account_codes (
  code text primary key,                              -- capitals and digits (the dashes are only shown)
  plan text not null,                                 -- the membership it gives
  months integer not null,                            -- for how long
  use_for text not null default 'both',               -- activate | reactivate | both
  max_uses integer not null default 1,                -- members who may use it (each once)
  uses integer not null default 0,
  audience text not null default 'public',            -- public | exclusive | private
  aud jsonb not null default '{}'::jsonb,             -- the criteria / the members (_pack_aud_ok)
  expires_at timestamptz,
  note text not null default '',
  made_by text not null default '',
  created_at timestamptz not null default now(),
  constraint account_codes_plan check (plan in ('Free', 'Silver', 'Gold', 'Diamond')),
  constraint account_codes_months check (months between 1 and 120),
  constraint account_codes_use check (use_for in ('activate', 'reactivate', 'both')),
  constraint account_codes_uses check (max_uses between 1 and 1000000 and uses >= 0),
  constraint account_codes_audience check (audience in ('public', 'exclusive', 'private'))
);

create table if not exists public.account_code_uses (
  id bigint generated always as identity primary key,
  code text not null,
  member_id text not null,
  plan text not null,
  months integer not null,
  mode text not null,                                 -- activate | reactivate (the account that day)
  expires_at timestamptz,                             -- the end of the membership it gave
  used_at timestamptz not null default now(),
  unique (code, member_id)
);
create index if not exists account_code_uses_member_idx on public.account_code_uses (member_id, used_at desc);

create table if not exists public.prize_pack_codes (
  code text primary key,
  points_off integer not null,                        -- taken off the points a prize asks for
  max_uses integer not null default 1,
  uses integer not null default 0,
  audience text not null default 'public',
  aud jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  note text not null default '',
  made_by text not null default '',
  created_at timestamptz not null default now(),
  constraint prize_pack_codes_points check (points_off between 1 and 100000000),
  constraint prize_pack_codes_uses check (max_uses between 1 and 1000000 and uses >= 0),
  constraint prize_pack_codes_audience check (audience in ('public', 'exclusive', 'private'))
);

create table if not exists public.prize_pack_uses (
  id bigint generated always as identity primary key,
  code text not null,
  member_id text not null,
  prize_id bigint,
  mode text not null default '',                      -- gift | challenge | lottery
  entry_id bigint,                                    -- prize_mode_entries
  points_saved integer not null default 0,            -- what it took off (never more than the cost)
  used_at timestamptz not null default now(),
  unique (code, member_id)
);
create index if not exists prize_pack_uses_member_idx on public.prize_pack_uses (member_id, used_at desc);

-- The serial is kept in one form: capitals, letters and digits only.
create or replace function public._pack_code_trg() returns trigger language plpgsql as $$
begin
  new.code := upper(regexp_replace(coalesce(new.code, ''), '[^A-Za-z0-9]', '', 'g'));
  if new.code = '' then raise exception 'A code needs letters or digits'; end if;
  return new;
end $$;
drop trigger if exists account_codes_norm on public.account_codes;
create trigger account_codes_norm before insert or update of code on public.account_codes
  for each row execute function public._pack_code_trg();
drop trigger if exists prize_pack_codes_norm on public.prize_pack_codes;
create trigger prize_pack_codes_norm before insert or update of code on public.prize_pack_codes
  for each row execute function public._pack_code_trg();

-- nobody reads or writes these through the public API
do $$
declare t text; pol record;
begin
  foreach t in array array['account_codes', 'account_code_uses', 'prize_pack_codes', 'prize_pack_uses'] loop
    execute format('alter table public.%I enable row level security', t);
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- Is a serial taken by one of the three packages?
create or replace function public._pack_taken(p_code text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.point_codes where code = p_code)
      or exists (select 1 from public.account_codes where code = p_code)
      or exists (select 1 from public.prize_pack_codes where code = p_code)
$$;

-- ------------------------------------------------------------------ 2. the activation page
-- A member types an account code (activate.html). The code gives its plan for its months (the
-- same plan still running: added to it) and the account is active.
-- A code of activation.sql (one use) is used up here too.
--   -> { ok: true, plan, months, duration, expires_at, mode, extended, legacy }
--      { ok: false, reason: member | banned | locked | invalid | not_found (left) | used | used_mine |
--        other | expired | mode (for: activate | reactivate) | audience (why: country | language |
--        level | age | membership) }
-- A membership given to a member for some months: the same plan still running gets the months
-- added to it. -> { expires_at, duration, extended }
create or replace function public._account_set_plan(p_member text, p_plan text, p_months int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m public.members; v_from timestamptz; v_end timestamptz; v_dur text;
begin
  select * into m from public.members where member_id = p_member for update;
  v_from := case when lower(btrim(coalesce(m.status, ''))) = 'active' and initcap(lower(coalesce(m.membership_type, ''))) = p_plan
                      and m.membership_expires_at > now()
                 then m.membership_expires_at else now() end;
  v_end := v_from + make_interval(months => p_months);
  v_dur := p_months::text || case when p_months = 1 then ' month' else ' months' end;
  update public.members
     set status = 'active', membership_type = p_plan, membership_duration = v_dur, membership_expires_at = v_end
   where member_id = p_member;
  -- the plan is on the profile too (as the activation page writes it)
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'profiles' and column_name = 'membership_type') then
    execute 'update public.profiles set membership_type = $1 where member_id = $2' using p_plan, p_member;
  end if;
  return jsonb_build_object('expires_at', v_end, 'duration', v_dur, 'extended', v_from > now());
end $$;

-- The membership of an account code goes to a member: one use of it, the history of the
-- activations, a bell. The caller checked the code and holds its row (account_code_redeem: the
-- serial typed; _pack_give_private: a private code, given at once to the members it names).
create or replace function public._account_code_give(p_member text, p_code text, p_mode text,
  p_ip text default '', p_auto boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c public.account_codes; v_cty text; r jsonb; v_end timestamptz;
begin
  select * into c from public.account_codes where code = p_code;
  select coalesce(country, '') into v_cty from public.members where member_id = p_member;
  r := public._account_set_plan(p_member, c.plan, c.months);
  v_end := (r->>'expires_at')::timestamptz;
  insert into public.account_code_uses (code, member_id, plan, months, mode, expires_at)
  values (c.code, p_member, c.plan, c.months, p_mode, v_end);
  update public.account_codes set uses = uses + 1 where code = c.code;
  -- the history of the activations (activation.sql), as the activation page writes it
  if to_regclass('public.activation') is not null then
    begin
      insert into public.activation (activation_code, member_id, membership_type, duration, started_at, expires_at,
                                     ip, country, used, used_at, kind)
      values (left('PK-' || c.code || '-' || p_member, 200), p_member, c.plan, r->>'duration', now(), v_end,
              left(coalesce(p_ip, ''), 64), coalesce(v_cty, ''), true, now(), p_mode);
    exception when others then null;
    end;
  end if;
  if to_regclass('public.notifications') is not null then
    insert into public.notifications (member_id, kind, title, body, href)
    values (p_member, case when p_auto then 'account_gift' else 'account_code' end,
            case when p_auto then 'Membership for you' else 'Membership activated' end,
            c.plan || ' · ' || to_char(v_end, 'YYYY-MM-DD'), './dashboard.html');
  end if;
  return jsonb_build_object('ok', true, 'plan', c.plan, 'months', c.months, 'duration', r->>'duration', 'expires_at', v_end,
                            'mode', p_mode, 'extended', coalesce((r->>'extended')::boolean, false), 'legacy', false);
end $$;

create or replace function public.account_code_redeem(p_member text, p_code text, p_ip text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.members; c public.account_codes; norm text; tries int; v_mode text; why text;
  v_act_id bigint; v_act_used boolean; v_act_member text; v_act_type text; v_act_dur text;
  v_plan text; v_months int; v_end timestamptz; v_dur text; v_legacy boolean := false; n int; r jsonb;
begin
  p_member := btrim(coalesce(p_member, ''));
  norm := public._pack_norm(p_code);
  select * into m from public.members where member_id = p_member for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if lower(btrim(coalesce(m.status, ''))) in ('banned', 'blocked') or m.status = 'محظور' then
    return jsonb_build_object('ok', false, 'reason', 'banned');
  end if;
  select count(*) into tries from public.point_code_attempts where member_id = p_member and at > now() - interval '15 minutes';
  if tries >= 8 then return jsonb_build_object('ok', false, 'reason', 'locked'); end if;
  if length(norm) < 4 or length(norm) > 64 then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  -- never activated: an activation; otherwise a reactivation (sql/account_deadline.sql keeps activated_at)
  v_mode := case when (to_jsonb(m)->>'activated_at') is null and lower(btrim(coalesce(m.status, ''))) <> 'active'
                 then 'activate' else 'reactivate' end;

  select * into c from public.account_codes where code = norm for update;
  if found then
    if exists (select 1 from public.account_code_uses u where u.code = norm and u.member_id = p_member) then
      return jsonb_build_object('ok', false, 'reason', 'used_mine');
    end if;
    if c.uses >= c.max_uses then return jsonb_build_object('ok', false, 'reason', 'used'); end if;
    if c.expires_at is not null and c.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
    if c.use_for <> 'both' and c.use_for <> v_mode then
      return jsonb_build_object('ok', false, 'reason', 'mode', 'for', c.use_for, 'mode', v_mode);
    end if;
    why := public._pack_aud_ok(c.audience, c.aud, p_member);
    if why = 'private' then
      insert into public.point_code_attempts (member_id) values (p_member);
      return jsonb_build_object('ok', false, 'reason', 'other');
    elsif why <> 'ok' then
      return jsonb_build_object('ok', false, 'reason', 'audience', 'why', why);
    end if;
    v_plan := c.plan;
    v_months := c.months;
  else
    -- a code of activation.sql
    if to_regclass('public.activation') is not null then
      select a.id, a.used, a.member_id, a.membership_type, a.duration
        into v_act_id, v_act_used, v_act_member, v_act_type, v_act_dur
        from public.activation a
       where public._pack_norm(a.activation_code) = norm
       order by a.used, a.id limit 1
       for update;
    end if;
    if v_act_id is null then
      insert into public.point_code_attempts (member_id) values (p_member);
      return jsonb_build_object('ok', false, 'reason', 'not_found', 'left', greatest(0, 7 - tries));
    end if;
    if v_act_used then
      return jsonb_build_object('ok', false, 'reason', case when v_act_member = p_member then 'used_mine' else 'used' end);
    end if;
    if coalesce(v_act_member, '') <> '' and v_act_member <> p_member then
      insert into public.point_code_attempts (member_id) values (p_member);
      return jsonb_build_object('ok', false, 'reason', 'other');
    end if;
    v_plan := initcap(lower(coalesce(nullif(btrim(v_act_type), ''), 'Free')));
    if v_plan not in ('Free', 'Silver', 'Gold', 'Diamond') then v_plan := 'Free'; end if;
    n := nullif(substring(coalesce(v_act_dur, '') from '[0-9]+'), '')::int;
    v_months := case
      when n is null then case v_plan when 'Silver' then 3 when 'Gold' then 6 when 'Diamond' then 12 else 1 end
      when v_act_dur ~* 'year' then n * 12
      when v_act_dur ~* 'week' then greatest(1, round(n * 7 / 30.0)::int)
      when v_act_dur ~* 'day' then greatest(1, ceil(n / 30.0)::int)
      else n end;
    v_months := least(greatest(v_months, 1), 120);
    v_legacy := true;
  end if;

  if not v_legacy then
    r := public._account_code_give(m.member_id, norm, v_mode, p_ip, false);
    delete from public.point_code_attempts where member_id = p_member;
    return r;
  end if;
  -- a code of activation.sql: its row is the history
  r := public._account_set_plan(m.member_id, v_plan, v_months);
  v_end := (r->>'expires_at')::timestamptz;
  v_dur := r->>'duration';
  update public.activation
     set member_id = m.member_id, membership_type = v_plan, duration = v_dur, started_at = now(), expires_at = v_end,
         ip = left(coalesce(p_ip, ''), 64), country = coalesce(m.country, ''), used = true, used_at = now(), kind = v_mode
   where id = v_act_id;
  delete from public.point_code_attempts where member_id = p_member;
  if to_regclass('public.notifications') is not null then
    insert into public.notifications (member_id, kind, title, body, href)
    values (m.member_id, 'account_code', 'Membership activated', v_plan || ' · ' || to_char(v_end, 'YYYY-MM-DD'), './dashboard.html');
  end if;
  return jsonb_build_object('ok', true, 'plan', v_plan, 'months', v_months, 'duration', v_dur, 'expires_at', v_end,
                            'mode', v_mode, 'extended', coalesce((r->>'extended')::boolean, false), 'legacy', true);
end $$;

-- ------------------------------------------------------------------ 3. the prize page
-- May this member use this prize code now? Locks it (prize_join pays in the same transaction).
--   -> { ok: true, code, points_off } | { ok: false, reason: not_found | used | used_mine | other |
--      expired | audience (why) }
create or replace function public._prize_pack_check(p_member text, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c public.prize_pack_codes; norm text := public._pack_norm(p_code); why text;
begin
  if length(norm) < 4 then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select * into c from public.prize_pack_codes where code = norm for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if exists (select 1 from public.prize_pack_uses u where u.code = norm and u.member_id = btrim(coalesce(p_member, ''))) then
    return jsonb_build_object('ok', false, 'reason', 'used_mine');
  end if;
  if c.uses >= c.max_uses then return jsonb_build_object('ok', false, 'reason', 'used'); end if;
  if c.expires_at is not null and c.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  why := public._pack_aud_ok(c.audience, c.aud, p_member);
  if why = 'private' then return jsonb_build_object('ok', false, 'reason', 'other'); end if;
  if why <> 'ok' then return jsonb_build_object('ok', false, 'reason', 'audience', 'why', why); end if;
  return jsonb_build_object('ok', true, 'code', c.code, 'points_off', c.points_off);
end $$;

-- prize_join used it: one use of the code, and what it took off.
create or replace function public._prize_pack_take(p_member text, p_code text, p_prize bigint, p_mode text, p_entry bigint, p_saved int)
returns void language plpgsql security definer set search_path = public as $$
declare norm text := public._pack_norm(p_code);
begin
  insert into public.prize_pack_uses (code, member_id, prize_id, mode, entry_id, points_saved)
  values (norm, p_member, p_prize, coalesce(p_mode, ''), p_entry, greatest(0, coalesce(p_saved, 0)));
  update public.prize_pack_codes set uses = uses + 1 where code = norm;
end $$;

-- The private prize codes of a member that are still theirs to use: the prize page fills the best
-- one in by itself (no serial to type), the member may keep it for another prize.
--   -> { ok: true, items: [ { code, points_off, expires_at } ] } (the biggest first)
create or replace function public.prize_pack_mine(p_member text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('ok', true, 'items', coalesce(jsonb_agg(jsonb_build_object(
           'code', public._pcode_fmt(c.code), 'points_off', c.points_off, 'expires_at', c.expires_at)
           order by c.points_off desc, c.created_at, c.code), '[]'::jsonb))
    from public.prize_pack_codes c
   where c.audience = 'private'
     and btrim(coalesce(p_member, '')) <> ''
     and coalesce(c.aud->'members', '[]'::jsonb) ? btrim(p_member)
     and c.uses < c.max_uses
     and (c.expires_at is null or c.expires_at > now())
     and not exists (select 1 from public.prize_pack_uses u where u.code = c.code and u.member_id = btrim(p_member))
$$;

-- A private code goes by itself to the members it names, when it is saved (pack_code_save):
--   account  the membership at once (activation or reactivation, as the account is that day)
--   points   the points at once
--   prize    a bell: the discount waits on the prize page (prize_pack_mine)
-- A member who already has it is passed over; one who cannot have it is listed with the reason:
-- member (gone) | banned | expired | used (no use left) | activated (the code is for activations
-- and the account was activated before) | not_activated (the code is for reactivations).
--   -> { given, members, skipped: [ { id, username, reason } ] }
create or replace function public._pack_give_private(p_kind text, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ca public.account_codes; cp public.point_codes; cz public.prize_pack_codes;
  v_aud text; v_aud_j jsonb; v_exp timestamptz; v_left int;
  ids text[]; x text; m public.members; v_mode text; r jsonb; why text; given int := 0; skipped jsonb := '[]'::jsonb;
begin
  if p_kind = 'account' then
    select * into ca from public.account_codes where code = p_code for update;
    if not found then return jsonb_build_object('given', 0, 'members', 0, 'skipped', '[]'::jsonb); end if;
    v_aud := ca.audience; v_aud_j := ca.aud; v_exp := ca.expires_at; v_left := ca.max_uses - ca.uses;
  elsif p_kind = 'points' then
    select * into cp from public.point_codes where code = p_code for update;
    if not found then return jsonb_build_object('given', 0, 'members', 0, 'skipped', '[]'::jsonb); end if;
    v_aud := cp.audience; v_aud_j := cp.aud; v_exp := cp.expires_at; v_left := cp.max_uses - cp.uses;
  else
    select * into cz from public.prize_pack_codes where code = p_code for update;
    if not found then return jsonb_build_object('given', 0, 'members', 0, 'skipped', '[]'::jsonb); end if;
    v_aud := cz.audience; v_aud_j := cz.aud; v_exp := cz.expires_at; v_left := cz.max_uses - cz.uses;
  end if;
  if v_aud <> 'private' then return jsonb_build_object('given', 0, 'members', 0, 'skipped', '[]'::jsonb); end if;
  ids := array(select jsonb_array_elements_text(case when jsonb_typeof(v_aud_j->'members') = 'array' then v_aud_j->'members' else '[]'::jsonb end));
  foreach x in array ids loop
    why := null;
    select * into m from public.members where member_id = x;
    if not found then
      why := 'member';
    elsif (p_kind = 'account' and exists (select 1 from public.account_code_uses u where u.code = p_code and u.member_id = x))
       or (p_kind = 'points' and exists (select 1 from public.point_code_uses u where u.code = p_code and u.member_id = x))
       or (p_kind = 'prize' and exists (select 1 from public.prize_pack_uses u where u.code = p_code and u.member_id = x)) then
      continue;
    elsif lower(btrim(coalesce(m.status, ''))) in ('banned', 'blocked') or m.status = 'محظور' then
      why := 'banned';
    elsif v_exp is not null and v_exp <= now() then
      why := 'expired';
    elsif given >= v_left then
      why := 'used';
    elsif p_kind = 'account' then
      v_mode := case when (to_jsonb(m)->>'activated_at') is null and lower(btrim(coalesce(m.status, ''))) <> 'active'
                     then 'activate' else 'reactivate' end;
      if ca.use_for <> 'both' and ca.use_for <> v_mode then
        why := case when v_mode = 'reactivate' then 'activated' else 'not_activated' end;
      else
        perform public._account_code_give(x, p_code, v_mode, '', true);
        given := given + 1;
      end if;
    elsif p_kind = 'points' then
      r := public._points_code_give(x, p_code, '', true);
      if coalesce((r->>'ok')::boolean, false) then given := given + 1; else why := coalesce(r->>'reason', 'member'); end if;
    else
      if to_regclass('public.notifications') is not null then
        insert into public.notifications (member_id, kind, title, body, href)
        values (x, 'prize_gift', 'A prize discount for you', '−' || cz.points_off::text || ' PT', './prize.html');
      end if;
      given := given + 1;
    end if;
    if why is not null then
      skipped := skipped || jsonb_build_array(jsonb_build_object('id', x, 'username', coalesce(m.username, ''), 'reason', why));
    end if;
  end loop;
  return jsonb_build_object('given', given, 'members', cardinality(ids), 'skipped', skipped);
end $$;

-- ------------------------------------------------------------------ 4. Panel > Packages
-- The codes of one package, newest first.
--   p_kind    account | points | prize
--   p_filter  unused (can still be used) | used (every use taken) | expired | all
--   p_q       a part of the serial (dashes aside), words of the note, or a member (username or id):
--             the codes they used or may use (private)
--   -> { ok, kind, total, counts: { unused, used, expired, all }, items: [ { code, value, max_uses, uses,
--        state, audience, expires_at, note, made_by, created_at, recent: [ { id, username, at } ] } ] }
create or replace function public.pack_codes_admin(p_token text, p_kind text, p_filter text default 'unused',
  p_q text default '', p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  who text; k text := lower(btrim(coalesce(p_kind, ''))); q text := lower(btrim(coalesce(p_q, ''))); qc text; qid text;
  f text := lower(coalesce(nullif(btrim(p_filter), ''), 'unused'));
  lim int := least(greatest(coalesce(p_limit, 50), 1), 200); off int := greatest(coalesce(p_offset, 0), 0); res jsonb;
begin
  who := public._pack_staff(p_token);
  if k not in ('account', 'points', 'prize') then return jsonb_build_object('ok', false, 'reason', 'kind'); end if;
  if f not in ('unused', 'used', 'expired', 'all') then f := 'unused'; end if;
  qc := public._pack_norm(q);
  if q <> '' then
    select mm.member_id into qid from public.members mm
     where lower(mm.member_id) = q or lower(mm.username) = ltrim(q, '@') limit 1;
  end if;
  with cs as (
    select c.code, jsonb_build_object('points', c.points) as val, c.max_uses,
           greatest(c.uses, case when c.used then 1 else 0 end) as uses, c.audience, c.aud, c.expires_at, c.note, c.made_by, c.created_at
      from public.point_codes c where k = 'points'
    union all
    select c.code, jsonb_build_object('plan', c.plan, 'months', c.months, 'use_for', c.use_for), c.max_uses, c.uses,
           c.audience, c.aud, c.expires_at, c.note, c.made_by, c.created_at
      from public.account_codes c where k = 'account'
    union all
    select c.code, jsonb_build_object('points_off', c.points_off), c.max_uses, c.uses,
           c.audience, c.aud, c.expires_at, c.note, c.made_by, c.created_at
      from public.prize_pack_codes c where k = 'prize'
  ), us as (
    select u.code, u.member_id, u.used_at from public.point_code_uses u where k = 'points'
    union all select u.code, u.member_id, u.used_at from public.account_code_uses u where k = 'account'
    union all select u.code, u.member_id, u.used_at from public.prize_pack_uses u where k = 'prize'
  ), base as (
    select x.*, case when x.uses >= x.max_uses then 'used'
                     when x.expires_at is not null and x.expires_at <= now() then 'expired'
                     else 'unused' end as state
      from cs x
     where q = ''
        or (length(qc) >= 3 and strpos(x.code, qc) > 0)
        or strpos(lower(x.note), q) > 0
        or (qid is not null and (exists (select 1 from us u where u.code = x.code and u.member_id = qid)
                                 or (x.audience = 'private' and coalesce(x.aud->'members', '[]'::jsonb) ? qid)))
  ), pick as (
    select * from base where f = 'all' or state = f
  )
  select jsonb_build_object('ok', true, 'kind', k, 'total', (select count(*) from pick),
    'counts', (select jsonb_build_object('all', count(*), 'unused', count(*) filter (where state = 'unused'),
                                         'used', count(*) filter (where state = 'used'),
                                         'expired', count(*) filter (where state = 'expired')) from base),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'code', public._pcode_fmt(z.code), 'value', z.val, 'max_uses', z.max_uses, 'uses', z.uses, 'state', z.state,
        'audience', public._pack_aud_out(z.audience, z.aud), 'expires_at', z.expires_at, 'note', z.note,
        'made_by', z.made_by, 'created_at', z.created_at,
        'recent', coalesce((select jsonb_agg(jsonb_build_object('id', y.member_id, 'username', coalesce(mm.username, ''), 'at', y.used_at)
                                             order by y.used_at desc)
                              from (select * from us u where u.code = z.code order by u.used_at desc limit 5) y
                              left join public.members mm on mm.member_id = y.member_id), '[]'::jsonb))
        order by z.created_at desc, z.code)
      from (select * from pick order by created_at desc, code offset off limit lim) z), '[]'::jsonb))
    into res;
  return res;
end $$;

-- A new code of one package.
--   d: { code (empty: drawn at random), max_uses (1), days (empty: no end), note, audience, aud,
--        account: plan, months, use_for (activate | reactivate | both) · points: points · prize: points_off }
--   A private code is used once by each member named (max_uses is their number) and goes to them
--   at once: auto = what _pack_give_private did.
--   -> { ok: true, item, auto } | { ok: false, reason: kind | code | taken | plan | months | use_for | points |
--      uses | days | note | audience | criteria | level | age | members (unknown) | members_many }
create or replace function public.pack_code_save(p_token text, p_kind text, d jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  who text; k text := lower(btrim(coalesce(p_kind, ''))); v jsonb := case when jsonb_typeof(d) = 'object' then d else '{}'::jsonb end;
  v_code text; v_uses int; v_days int; v_note text; v_exp timestamptz; a jsonb; tries int := 0;
  v_plan text; v_months int; v_use text; v_points int; v_auto jsonb; v_given int := 0;
begin
  who := public._pack_staff(p_token);
  if k not in ('account', 'points', 'prize') then return jsonb_build_object('ok', false, 'reason', 'kind'); end if;
  v_code := public._pack_norm(v->>'code');
  if v_code <> '' and (length(v_code) < 4 or length(v_code) > 32) then return jsonb_build_object('ok', false, 'reason', 'code'); end if;
  v_uses := coalesce(public._pack_int(v->>'max_uses'), case when btrim(coalesce(v->>'max_uses', '')) = '' then 1 end);
  -- (a private code: one use for each member named, whatever was typed)
  if (v_uses is null or v_uses < 1 or v_uses > 1000000) and lower(btrim(coalesce(v->>'audience', ''))) <> 'private' then
    return jsonb_build_object('ok', false, 'reason', 'uses');
  end if;
  if btrim(coalesce(v->>'days', '')) <> '' then
    v_days := public._pack_int(v->>'days');
    if v_days is null or v_days < 1 or v_days > 3650 then return jsonb_build_object('ok', false, 'reason', 'days'); end if;
    v_exp := now() + make_interval(days => v_days);
  end if;
  v_note := btrim(regexp_replace(coalesce(v->>'note', ''), '\s+', ' ', 'g'));
  if length(v_note) > 120 then return jsonb_build_object('ok', false, 'reason', 'note'); end if;
  if k = 'account' then
    v_plan := initcap(lower(btrim(coalesce(v->>'plan', ''))));
    if v_plan not in ('Free', 'Silver', 'Gold', 'Diamond') then return jsonb_build_object('ok', false, 'reason', 'plan'); end if;
    v_months := public._pack_int(v->>'months');
    if v_months is null or v_months < 1 or v_months > 120 then return jsonb_build_object('ok', false, 'reason', 'months'); end if;
    v_use := lower(btrim(coalesce(nullif(v->>'use_for', ''), 'both')));
    if v_use not in ('activate', 'reactivate', 'both') then return jsonb_build_object('ok', false, 'reason', 'use_for'); end if;
  else
    v_points := public._pack_int(v->>(case when k = 'points' then 'points' else 'points_off' end));
    if v_points is null or v_points < 1 or v_points > 100000000 then return jsonb_build_object('ok', false, 'reason', 'points'); end if;
  end if;
  a := public._pack_aud_clean(v->>'audience', v->'aud');
  if not coalesce((a->>'ok')::boolean, false) then return a; end if;
  -- private: each member named once, by itself (no serial to type)
  if a->>'audience' = 'private' then v_uses := jsonb_array_length(a->'aud'->'members'); end if;
  -- a serial belongs to one package only
  if v_code = '' then
    loop
      v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16));
      exit when not public._pack_taken(v_code);
      tries := tries + 1;
      if tries > 50 then raise exception 'could not draw a free serial'; end if;
    end loop;
  elsif public._pack_taken(v_code) then
    return jsonb_build_object('ok', false, 'reason', 'taken');
  end if;
  begin
    if k = 'points' then
      insert into public.point_codes (code, points, note, expires_at, made_by, max_uses, audience, aud)
      values (v_code, v_points, v_note, v_exp, who, v_uses, a->>'audience', a->'aud');
    elsif k = 'account' then
      insert into public.account_codes (code, plan, months, use_for, max_uses, audience, aud, expires_at, note, made_by)
      values (v_code, v_plan, v_months, v_use, v_uses, a->>'audience', a->'aud', v_exp, v_note, who);
    else
      insert into public.prize_pack_codes (code, points_off, max_uses, audience, aud, expires_at, note, made_by)
      values (v_code, v_points, v_uses, a->>'audience', a->'aud', v_exp, v_note, who);
    end if;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'taken');
  end;
  if a->>'audience' = 'private' then
    v_auto := public._pack_give_private(k, v_code);
    if k <> 'prize' then v_given := coalesce((v_auto->>'given')::int, 0); end if;
  end if;
  return jsonb_build_object('ok', true, 'auto', v_auto, 'item', jsonb_build_object(
    'code', public._pcode_fmt(v_code), 'kind', k,
    'value', case k when 'points' then jsonb_build_object('points', v_points)
                    when 'prize' then jsonb_build_object('points_off', v_points)
                    else jsonb_build_object('plan', v_plan, 'months', v_months, 'use_for', v_use) end,
    'max_uses', v_uses, 'uses', v_given, 'state', case when v_given >= v_uses then 'used' else 'unused' end,
    'audience', public._pack_aud_out(a->>'audience', a->'aud'),
    'expires_at', v_exp, 'note', v_note, 'made_by', who, 'created_at', now(), 'recent', '[]'::jsonb));
end $$;

-- Delete codes that can still be used (a code whose every use is taken stays: the members' history).
--   -> { ok: true, deleted }
create or replace function public.pack_codes_delete(p_token text, p_kind text, p_codes text[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare who text; k text := lower(btrim(coalesce(p_kind, ''))); n int := 0; list text[];
begin
  who := public._pack_staff(p_token);
  if k not in ('account', 'points', 'prize') then return jsonb_build_object('ok', false, 'reason', 'kind'); end if;
  select coalesce(array_agg(public._pack_norm(x)), '{}') into list from unnest(coalesce(p_codes, '{}')) x;
  if k = 'points' then
    delete from public.point_codes where not used and uses < max_uses and code = any (list);
  elsif k = 'account' then
    delete from public.account_codes where uses < max_uses and code = any (list);
  else
    delete from public.prize_pack_codes where uses < max_uses and code = any (list);
  end if;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'deleted', n);
end $$;

-- ------------------------------------------------------------------ 5. who may call what
do $$
declare f text;
begin
  foreach f in array array[
    'public._pack_code_trg()', 'public._pack_taken(text)', 'public._prize_pack_check(text, text)',
    'public._prize_pack_take(text, text, bigint, text, bigint, int)', 'public._account_set_plan(text, text, int)',
    'public._account_code_give(text, text, text, text, boolean)', 'public._pack_give_private(text, text)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.account_code_redeem(text, text, text)', 'public.pack_codes_admin(text, text, text, text, int, int)',
    'public.pack_code_save(text, text, jsonb)', 'public.pack_codes_delete(text, text, text[])',
    'public.prize_pack_mine(text)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
