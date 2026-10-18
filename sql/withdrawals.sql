-- ============================================================
-- CineAura — Withdrawals: points exchanged for real money
--   Dashboard > Withdraw (the member) and Panel > Withdrawals (the team)
-- Run in the Supabase SQL editor AFTER points.sql, prize_secure.sql, point_levels.sql and
-- market.sql, and BEFORE panel_admin.sql (safe to run again).
--
-- Who may withdraw — both conditions:
--   1. the account level is LV3 or higher (1,000 points earned: sql/point_levels.sql);
--   2. the account is old enough for its membership (counted from signing up):
--        Free 12 months · Silver 6 months · Gold 3 months · Diamond 1 month
--      A paid membership counts while it runs; once it has ended the account waits like a Free one.
--   And the account is active: activated, not banned, no temporary ban.
--
-- The money goes by bank transfer (the account holder, the bank, the IBAN or account number, the
-- SWIFT / BIC, the country) or through a money transfer agency such as Western Union (the agency,
-- the receiver's full name as on their ID, the country, the city, the phone).
-- Panel > Withdrawals > Settings: the value of a point (points for 1 unit of the currency; 100 =
-- one point is one cent, as the Market shows), the currency, the least and the most points of a
-- request, the methods (the agencies by name) with their fees, and a note for the members.
--
-- A request:
--   * needs the account password (sha256, as signing in); 5 wrong ones lock requests for 15 minutes;
--   * one at a time (pending or processing);
--   * holds its points at once (profiles.points_spent, point_spends mode 'withdraw'); they come back
--     when the member cancels it while it is pending, or when the team rejects it (unless the team
--     keeps them: fraud) — a point_spends row with a negative amount, mode 'withdraw_refund';
--   * keeps the value of its day (rate, currency, fee) and a copy of the payment details;
--   * the details can be remembered for the next time (withdraw_methods): the member then sees them
--     masked (MA64 •••• 1234) and uses them again without typing them; only the team reads them in full.
-- The team — the Super Admin, or staff with the Withdrawals section — approves a request (processing),
-- marks it as sent with the reference of the transfer (the MTCN of Western Union…), or rejects it with
-- a reason. Every step rings the member's bell. The level counts the points EARNED, so a withdrawal
-- never lowers it.
--
-- Ids: WDR + 10 digits.
-- ============================================================

-- ------------------------------------------------------------------ 1. the settings
create table if not exists public.withdraw_settings (
  id integer primary key default 1,
  enabled boolean not null default true,              -- members may send requests
  rate integer not null default 100,                  -- points for 1 unit of the currency (100: 1 point = 1 cent)
  currency text not null default 'USD',
  min_points integer not null default 1000,           -- the least points of a request
  max_points integer not null default 0,              -- the most (0: no most)
  bank_on boolean not null default true,              -- bank transfers
  bank_fee numeric(10,2) not null default 0,          -- taken from the amount, in the currency
  agencies text[] not null default array['Western Union', 'MoneyGram', 'Ria'],
  agency_fee numeric(10,2) not null default 0,
  note text not null default '',                      -- for the members (how long a transfer takes…)
  updated_by text not null default '',
  updated_at timestamptz not null default now(),
  constraint withdraw_settings_one check (id = 1),
  constraint withdraw_settings_rate check (rate between 1 and 1000000),
  constraint withdraw_settings_currency check (currency ~ '^[A-Z]{3}$'),
  constraint withdraw_settings_min check (min_points between 1 and 100000000),
  constraint withdraw_settings_max check (max_points = 0 or max_points >= min_points),
  constraint withdraw_settings_fees check (bank_fee >= 0 and agency_fee >= 0),
  constraint withdraw_settings_note check (char_length(note) <= 500)
);
insert into public.withdraw_settings (id) values (1) on conflict (id) do nothing;

-- ------------------------------------------------------------------ 2. the requests
create table if not exists public.withdrawals (
  id text primary key,                                -- WDR + 10 digits
  member_id text not null,
  points integer not null,
  rate integer not null,                              -- the value of a point on that day
  currency text not null,
  amount numeric(12,2) not null,                      -- points / rate
  fee numeric(12,2) not null default 0,
  net numeric(12,2) not null,                         -- what the member receives: amount - fee
  method text not null,                               -- bank | agency
  agency text not null default '',                    -- Western Union…
  details jsonb not null default '{}'::jsonb,         -- a copy of the payment details
  status text not null default 'pending',             -- pending | processing | paid | rejected | cancelled
  reason text not null default '',                    -- rejected: why (the member reads it)
  reference text not null default '',                 -- paid: the reference of the transfer (MTCN…)
  note text not null default '',                      -- paid: a word for the member
  refunded boolean not null default false,            -- rejected / cancelled: the points came back
  checks jsonb not null default '{}'::jsonb,          -- the conditions on that day (level, plan, age)
  created_at timestamptz not null default now(),
  decided_at timestamptz,                             -- approved / rejected
  decided_by text not null default '',
  paid_at timestamptz,
  paid_by text not null default '',
  cancelled_at timestamptz,
  constraint withdrawals_points check (points > 0),
  constraint withdrawals_method check (method in ('bank', 'agency')),
  constraint withdrawals_status check (status in ('pending', 'processing', 'paid', 'rejected', 'cancelled'))
);
create index if not exists withdrawals_member_idx on public.withdrawals (member_id, created_at desc);
create index if not exists withdrawals_status_idx on public.withdrawals (status, created_at);
-- one request at a time
create unique index if not exists withdrawals_one_open on public.withdrawals (member_id) where status in ('pending', 'processing');

-- The payment details a member asked to remember, one row per method.
create table if not exists public.withdraw_methods (
  member_id text not null,
  method text not null,
  details jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (member_id, method),
  constraint withdraw_methods_method check (method in ('bank', 'agency'))
);

-- Wrong passwords typed in the request form (5 in 15 minutes lock it).
create table if not exists public.withdraw_fails (
  id bigint generated always as identity primary key,
  member_id text not null,
  at timestamptz not null default now()
);
create index if not exists withdraw_fails_member_idx on public.withdraw_fails (member_id, at desc);

-- nothing of this is open to the public API: the functions below read and write it
do $$
declare t text; pol record;
begin
  foreach t in array array['withdraw_settings', 'withdrawals', 'withdraw_methods', 'withdraw_fails'] loop
    execute format('alter table public.%I enable row level security', t);
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ------------------------------------------------------------------ 3. helpers
-- The Super Admin, or a staff member with the Withdrawals section. -> who did it
create or replace function public._wd_staff(p_token text) returns text
language plpgsql security definer set search_path = public as $$
declare s public.staff; secs text;
begin
  s := public._staff(p_token);
  secs := ',' || replace(coalesce(s.sections, ''), ' ', '') || ',';
  if s.role <> 'super' and position(',withdrawals,' in secs) = 0 then raise exception 'staff_forbidden'; end if;
  return coalesce(nullif(s.username, ''), s.role);
end $$;

create or replace function public._wd_int(p text) returns int language sql immutable as $$
  select case when btrim(coalesce(p, '')) ~ '^-?[0-9]{1,9}$' then btrim(p)::int end
$$;

-- One line of text: spaces collapsed.
create or replace function public._wd_line(p text) returns text language sql immutable as $$
  select btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g'))
$$;

-- A name: 2 to 80 characters, at least 2 of them letters (any alphabet: not a space, a digit or a sign).
create or replace function public._wd_name_ok(p text) returns boolean language sql immutable as $$
  select length(p) between 2 and 80
     and length(regexp_replace(p, '[[:space:][:digit:][:punct:]]', '', 'g')) >= 2
$$;

-- The membership that counts: a paid one while it runs, else Free.
create or replace function public._wd_plan(m public.members) returns text language sql stable as $$
  select case when initcap(lower(btrim(coalesce(m.membership_type, '')))) in ('Silver', 'Gold', 'Diamond')
                   and (m.membership_expires_at is null or m.membership_expires_at > now())
              then initcap(lower(btrim(m.membership_type))) else 'Free' end
$$;

-- The age (in months) each membership needs: Free 12, Silver 6, Gold 3, Diamond 1.
create or replace function public._wd_months(p_plan text) returns int language sql immutable as $$
  select case p_plan when 'Diamond' then 1 when 'Gold' then 3 when 'Silver' then 6 else 12 end
$$;

-- An IBAN (2 letters, 2 digits, 11 to 30 letters or digits): true when its check digits are right,
-- false when they are wrong; null when the number is not an IBAN (an account number, a RIB…).
create or replace function public._wd_iban_ok(p text) returns boolean language plpgsql immutable as $$
declare s text; r int := 0; ch text; v text; i int; j int;
begin
  s := upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'));
  if s !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' then return null; end if;
  s := substr(s, 5) || substr(s, 1, 4);
  for i in 1 .. length(s) loop
    ch := substr(s, i, 1);
    v := case when ch ~ '[0-9]' then ch else (ascii(ch) - 55)::text end;
    for j in 1 .. length(v) loop
      r := (r * 10 + substr(v, j, 1)::int) % 97;
    end loop;
  end loop;
  return r = 1;
end $$;

-- Do two names name the same person? Every word (2 letters or more) of one is in the other,
-- in any order ("Bob A. Stone" = "Stone Bob"). For the team only: it is shown, never enforced.
create or replace function public._wd_name_match(a text, b text) returns boolean language sql immutable as $$
  with x as (
    select array(select distinct w from regexp_split_to_table(lower(coalesce(a, '')), '[[:space:][:punct:]]+') w where length(w) > 1) as wa,
           array(select distinct w from regexp_split_to_table(lower(coalesce(b, '')), '[[:space:][:punct:]]+') w where length(w) > 1) as wb)
  select cardinality(wa) > 0 and cardinality(wb) > 0 and (wa <@ wb or wb <@ wa) from x
$$;

-- The payment details of a request, checked and in one form.
--   bank:   { holder, bank, account (IBAN or account number), swift (optional), country }
--   agency: { agency (one of the settings), name (as on the ID), country, city, phone }
--   -> { ok: true, details } | { ok: false, reason: holder | bank | account | iban | swift | country |
--      agency | name | city | phone }
create or replace function public._wd_clean(p_method text, d jsonb, s public.withdraw_settings) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  x jsonb := case when jsonb_typeof(d) = 'object' then d else '{}'::jsonb end;
  v_holder text; v_bank text; v_acct text; v_iban boolean; v_swift text; v_cc text; v_agency text; v_name text;
  v_city text; v_phone text; digits text;
begin
  v_cc := upper(btrim(coalesce(x->>'country', '')));
  if p_method = 'bank' then
    v_holder := public._wd_line(x->>'holder');
    if not public._wd_name_ok(v_holder) then return jsonb_build_object('ok', false, 'reason', 'holder'); end if;
    v_bank := public._wd_line(x->>'bank');
    if length(v_bank) < 2 or length(v_bank) > 80 then return jsonb_build_object('ok', false, 'reason', 'bank'); end if;
    v_acct := upper(regexp_replace(coalesce(x->>'account', ''), '[^A-Za-z0-9]', '', 'g'));
    if length(v_acct) < 6 or length(v_acct) > 34 or btrim(coalesce(x->>'account', '')) !~ '^[A-Za-z0-9 .-]+$' then
      return jsonb_build_object('ok', false, 'reason', 'account');
    end if;
    v_iban := public._wd_iban_ok(v_acct);
    if v_iban is false then return jsonb_build_object('ok', false, 'reason', 'iban'); end if;
    v_swift := upper(regexp_replace(coalesce(x->>'swift', ''), '[^A-Za-z0-9]', '', 'g'));
    if v_swift <> '' and v_swift !~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$' then
      return jsonb_build_object('ok', false, 'reason', 'swift');
    end if;
    if v_cc !~ '^[A-Z]{2}$' then return jsonb_build_object('ok', false, 'reason', 'country'); end if;
    return jsonb_build_object('ok', true, 'details', jsonb_build_object(
      'holder', v_holder, 'bank', v_bank, 'account', v_acct, 'iban', coalesce(v_iban, false), 'swift', v_swift, 'country', v_cc));
  end if;
  -- a money transfer agency: one of the agencies of the settings, written as the settings write it
  select a into v_agency from unnest(s.agencies) a where lower(a) = lower(public._wd_line(x->>'agency')) limit 1;
  if v_agency is null then return jsonb_build_object('ok', false, 'reason', 'agency'); end if;
  v_name := public._wd_line(x->>'name');
  if not public._wd_name_ok(v_name) then return jsonb_build_object('ok', false, 'reason', 'name'); end if;
  if v_cc !~ '^[A-Z]{2}$' then return jsonb_build_object('ok', false, 'reason', 'country'); end if;
  v_city := public._wd_line(x->>'city');
  if length(v_city) < 2 or length(v_city) > 80 then return jsonb_build_object('ok', false, 'reason', 'city'); end if;
  v_phone := public._wd_line(x->>'phone');
  digits := regexp_replace(v_phone, '[^0-9]', '', 'g');
  if v_phone !~ '^\+?[0-9 ().-]{6,24}$' or length(digits) < 6 or length(digits) > 15 then
    return jsonb_build_object('ok', false, 'reason', 'phone');
  end if;
  return jsonb_build_object('ok', true, 'details', jsonb_build_object(
    'agency', v_agency, 'name', v_name, 'country', v_cc, 'city', v_city, 'phone', v_phone));
end $$;

-- The details as the member sees them again: the account number and the phone masked.
create or replace function public._wd_mask(p_method text, d jsonb) returns jsonb language sql immutable as $$
  select case
    when d is null then null
    when p_method = 'bank' then (d - 'account') || jsonb_build_object('account',
      case when length(coalesce(d->>'account', '')) > 8 then left(d->>'account', 4) || ' •••• ' || right(d->>'account', 4)
           else '•••• ' || right(coalesce(d->>'account', ''), 2) end)
    else (d - 'phone') || jsonb_build_object('phone',
      case when length(coalesce(d->>'phone', '')) > 6 then left(d->>'phone', 4) || ' ••• ' || right(d->>'phone', 2)
           else '•••' end)
  end
$$;

-- Where a member stands (Dashboard > Withdraw, and each request):
--   { ok (may withdraw), account: ok | disabled | banned | blocked, blocked_until,
--     level, level_name, need_level, level_ok, earned, need_earned,
--     plan (the one that counts), plan_type, plan_ended, months, created_at, eligible_at, age_days, age_ok,
--     available, spent }
create or replace function public._wd_check(m public.members) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  pts jsonb; earned bigint; lv int := 0; v_plan text; v_months int; due timestamptz; acct text := 'ok'; temp_to timestamptz;
  st text := lower(btrim(coalesce(m.status, '')));
begin
  pts := public._points(m.member_id);
  earned := coalesce((pts->>'earned')::bigint, 0);
  if to_regprocedure('public.points_level(bigint)') is not null then lv := public.points_level(earned); end if;
  v_plan := public._wd_plan(m);
  v_months := public._wd_months(v_plan);
  due := coalesce(m.created_at, now()) + make_interval(months => v_months);
  if st = 'banned' then
    acct := 'banned';
  elsif st <> 'active' then
    acct := 'disabled';
  elsif to_regclass('public.sanctions') is not null then
    execute 'select temp_until from public.sanctions where member_id = $1' into temp_to using m.member_id;
    if temp_to is not null and temp_to > now() then acct := 'blocked'; end if;
  end if;
  return jsonb_build_object(
    'ok', acct = 'ok' and lv >= 3 and due <= now(),
    'account', acct, 'blocked_until', case when acct = 'blocked' then temp_to end,
    'level', lv, 'level_name', case when lv >= 10 then 'LV Max' else 'LV' || lv end,
    'need_level', 3, 'level_ok', lv >= 3, 'earned', earned, 'need_earned', 1000,
    'plan', v_plan, 'plan_type', coalesce(initcap(lower(nullif(btrim(m.membership_type), ''))), 'Free'),
    'plan_ended', v_plan = 'Free' and initcap(lower(btrim(coalesce(m.membership_type, '')))) in ('Silver', 'Gold', 'Diamond'),
    'months', v_months, 'created_at', m.created_at, 'eligible_at', due,
    'age_days', greatest(0, floor(extract(epoch from (now() - coalesce(m.created_at, now()))) / 86400))::int,
    'age_ok', due <= now(),
    'available', coalesce((pts->>'available')::bigint, 0), 'spent', coalesce((pts->>'spent')::bigint, 0));
end $$;

-- What members may read of the settings.
create or replace function public._wd_settings_json(s public.withdraw_settings) returns jsonb language sql stable as $$
  select jsonb_build_object('enabled', s.enabled, 'rate', s.rate, 'currency', s.currency, 'min_points', s.min_points,
    'max_points', s.max_points, 'bank', s.bank_on, 'bank_fee', s.bank_fee, 'agencies', to_jsonb(s.agencies),
    'agency_fee', s.agency_fee, 'note', s.note)
$$;

-- A request: masked for the member, in full for the team (p_full).
create or replace function public._wd_json(w public.withdrawals, p_full boolean) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', w.id, 'points', w.points, 'rate', w.rate, 'currency', w.currency, 'amount', w.amount, 'fee', w.fee, 'net', w.net,
    'method', w.method, 'agency', w.agency, 'status', w.status, 'reason', w.reason, 'reference', w.reference, 'note', w.note,
    'refunded', w.refunded, 'created_at', w.created_at, 'decided_at', w.decided_at, 'paid_at', w.paid_at,
    'cancelled_at', w.cancelled_at,
    'details', case when p_full then w.details else public._wd_mask(w.method, w.details) end)
  || case when p_full then jsonb_build_object('decided_by', w.decided_by, 'paid_by', w.paid_by, 'checks', w.checks) else '{}'::jsonb end
$$;

-- The member's bell (the title is shown in the reader's language by js/common.js, from the kind).
create or replace function public._wd_notify(p_to text, p_kind text, p_title text, p_body text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if to_regclass('public.notifications') is null then return; end if;
  insert into public.notifications (member_id, kind, title, body, href, from_id, from_username)
  values (p_to, p_kind, p_title, left(coalesce(p_body, ''), 300), './dashboard.html#withdraw', '', 'CineAura');
end $$;

-- The points of a request back in the member's balance.
create or replace function public._wd_refund(w public.withdrawals) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set points_spent = greatest(0, coalesce(points_spent, 0) - w.points) where member_id = w.member_id;
  insert into public.point_spends (member_id, amount, prize_title, mode) values (w.member_id, -w.points, w.id, 'withdraw_refund');
end $$;

-- The numbers of the team: waiting, points held, sent (in the currency of the settings).
create or replace function public._wd_stats() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'pending', count(*) filter (where w.status = 'pending'),
    'processing', count(*) filter (where w.status = 'processing'),
    'held', coalesce(sum(w.points) filter (where w.status in ('pending', 'processing')), 0),
    'to_send', coalesce(sum(w.net) filter (where w.status in ('pending', 'processing') and w.currency = s.currency), 0),
    'paid', count(*) filter (where w.status = 'paid'),
    'paid_net', coalesce(sum(w.net) filter (where w.status = 'paid' and w.currency = s.currency), 0),
    'paid_30d', count(*) filter (where w.status = 'paid' and w.paid_at > now() - interval '30 days'),
    'paid_30d_net', coalesce(sum(w.net) filter (where w.status = 'paid' and w.paid_at > now() - interval '30 days' and w.currency = s.currency), 0),
    'currency', s.currency)
  from public.withdraw_settings s left join public.withdrawals w on true
  where s.id = 1
  group by s.currency
$$;

-- ------------------------------------------------------------------ 4. the member
-- The settings members may read (the value of a point in the Market too). -> { enabled, rate, currency, … }
create or replace function public.withdraw_info() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select public._wd_settings_json(s) from public.withdraw_settings s where s.id = 1), '{}'::jsonb)
$$;

-- Dashboard > Withdraw.
--   -> { ok: true, settings, check, plans: { Free: 12, … }, open, saved: { bank, agency } (masked), history,
--        totals } | { ok: false, reason: member }
create or replace function public.withdraw_me(p_member text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m public.members; s public.withdraw_settings;
begin
  select * into m from public.members where member_id = btrim(coalesce(p_member, ''));
  if not found then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  select * into s from public.withdraw_settings where id = 1;
  return jsonb_build_object('ok', true,
    'settings', public._wd_settings_json(s),
    'check', public._wd_check(m),
    'plans', jsonb_build_object('Free', 12, 'Silver', 6, 'Gold', 3, 'Diamond', 1),
    'open', (select public._wd_json(w, false) from public.withdrawals w
              where w.member_id = m.member_id and w.status in ('pending', 'processing') order by w.created_at desc limit 1),
    'saved', jsonb_build_object(
      'bank', (select public._wd_mask('bank', x.details) || jsonb_build_object('updated_at', x.updated_at)
                 from public.withdraw_methods x where x.member_id = m.member_id and x.method = 'bank'),
      'agency', (select public._wd_mask('agency', x.details) || jsonb_build_object('updated_at', x.updated_at)
                   from public.withdraw_methods x where x.member_id = m.member_id and x.method = 'agency')),
    'history', coalesce((select jsonb_agg(public._wd_json(w, false) order by w.created_at desc)
                           from (select * from public.withdrawals where member_id = m.member_id order by created_at desc limit 50) w), '[]'::jsonb),
    'totals', (select jsonb_build_object('requests', count(*), 'paid', count(*) filter (where status = 'paid'),
                                         'paid_points', coalesce(sum(points) filter (where status = 'paid'), 0))
                 from public.withdrawals where member_id = m.member_id));
end $$;

-- Send a request.
--   p_password  sha256 of the account password (as login_member)
--   p_points    how many points (the settings: at least min_points, at most max_points)
--   p_method    bank | agency
--   p_details   the details (_wd_clean), or { saved: true } for the ones remembered for this method
--   p_save      remember these details for the next time (false: forget the ones remembered)
--   -> { ok: true, id, points, amount, fee, net, currency, status }
--    | { ok: false, reason: member | disabled | banned | blocked (until) | locked (minutes) | password (left) |
--        closed | level (level, need) | age (eligible_at, plan, months) | open (id) | method | saved |
--        holder | bank | account | iban | swift | country | agency | name | city | phone |
--        min (min) | max (max) | net (amount, fee) | balance (have) }
create or replace function public.withdraw_request(p_member text, p_password text, p_points int, p_method text,
  p_details jsonb default '{}'::jsonb, p_save boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.members; s public.withdraw_settings; chk jsonb; n_fails int; first_fail timestamptz; d jsonb; clean jsonb;
  v_method text; v_saved boolean; v_amount numeric(12,2); v_fee numeric(12,2); v_net numeric(12,2); pts jsonb; wid text;
  open_id text;
begin
  select * into m from public.members where member_id = btrim(coalesce(p_member, ''));
  if not found then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  -- the account first: a banned or restricted account learns nothing more
  chk := public._wd_check(m);
  if chk->>'account' <> 'ok' then
    return jsonb_build_object('ok', false, 'reason', chk->>'account', 'until', chk->'blocked_until');
  end if;
  -- 5 wrong passwords within 15 minutes lock the form until the first of them is 15 minutes old
  select count(*), min(at) into n_fails, first_fail
    from (select at from public.withdraw_fails where member_id = m.member_id and at > now() - interval '15 minutes'
           order by at desc limit 5) f;
  if n_fails >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'locked',
      'minutes', greatest(1, ceil(extract(epoch from (first_fail + interval '15 minutes' - now())) / 60))::int);
  end if;
  -- the stored password is the sha256 the browser sends (an account of before that keeps it as typed)
  if coalesce(p_password, '') = '' or not (m.password = p_password or (m.password !~ '^[0-9a-f]{64}$'
       and encode(sha256(convert_to(coalesce(m.password, ''), 'UTF8')), 'hex') = lower(p_password))) then
    insert into public.withdraw_fails (member_id) values (m.member_id);
    return jsonb_build_object('ok', false, 'reason', 'password', 'left', greatest(0, 4 - n_fails));
  end if;
  delete from public.withdraw_fails where member_id = m.member_id;

  select * into s from public.withdraw_settings where id = 1;
  if not found or not s.enabled then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  if not (chk->>'level_ok')::boolean then
    return jsonb_build_object('ok', false, 'reason', 'level', 'level', (chk->>'level')::int, 'need', 3);
  end if;
  if not (chk->>'age_ok')::boolean then
    return jsonb_build_object('ok', false, 'reason', 'age', 'eligible_at', chk->'eligible_at', 'plan', chk->>'plan',
                              'months', (chk->>'months')::int);
  end if;

  v_method := lower(btrim(coalesce(p_method, '')));
  if v_method not in ('bank', 'agency') or (v_method = 'bank' and not s.bank_on)
     or (v_method = 'agency' and coalesce(cardinality(s.agencies), 0) = 0) then
    return jsonb_build_object('ok', false, 'reason', 'method');
  end if;
  d := case when jsonb_typeof(p_details) = 'object' then p_details else '{}'::jsonb end;
  v_saved := lower(coalesce(d->>'saved', '')) in ('true', '1', 'yes');
  if v_saved then
    select x.details into d from public.withdraw_methods x where x.member_id = m.member_id and x.method = v_method;
    if not found then return jsonb_build_object('ok', false, 'reason', 'saved'); end if;
  end if;
  clean := public._wd_clean(v_method, d, s);
  if not (clean->>'ok')::boolean then return clean; end if;

  if p_points is null or p_points < s.min_points then
    return jsonb_build_object('ok', false, 'reason', 'min', 'min', s.min_points);
  end if;
  if s.max_points > 0 and p_points > s.max_points then
    return jsonb_build_object('ok', false, 'reason', 'max', 'max', s.max_points);
  end if;
  v_amount := round(p_points::numeric / s.rate, 2);
  v_fee := case when v_method = 'bank' then s.bank_fee else s.agency_fee end;
  v_net := v_amount - v_fee;
  if v_net < 0.01 then
    return jsonb_build_object('ok', false, 'reason', 'net', 'amount', v_amount, 'fee', v_fee);
  end if;

  -- the balance and the one open request, under the lock of the profile row (every spend takes it)
  perform 1 from public.profiles where member_id = m.member_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'balance', 'have', 0); end if;
  select id into open_id from public.withdrawals where member_id = m.member_id and status in ('pending', 'processing') limit 1;
  if open_id is not null then return jsonb_build_object('ok', false, 'reason', 'open', 'id', open_id); end if;
  pts := public._points(m.member_id);
  if coalesce((pts->>'available')::bigint, 0) < p_points then
    return jsonb_build_object('ok', false, 'reason', 'balance', 'have', coalesce((pts->>'available')::bigint, 0));
  end if;

  loop
    wid := 'WDR' || lpad(floor(random() * 1e10)::bigint::text, 10, '0');
    exit when not exists (select 1 from public.withdrawals where id = wid);
  end loop;
  insert into public.withdrawals (id, member_id, points, rate, currency, amount, fee, net, method, agency, details, checks)
  values (wid, m.member_id, p_points, s.rate, s.currency, v_amount, v_fee, v_net, v_method,
          case when v_method = 'agency' then clean->'details'->>'agency' else '' end, clean->'details',
          jsonb_build_object('level', (chk->>'level')::int, 'plan', chk->>'plan', 'months', (chk->>'months')::int,
                             'age_days', (chk->>'age_days')::int, 'available', coalesce((pts->>'available')::bigint, 0)));
  update public.profiles set points_spent = coalesce(points_spent, 0) + p_points where member_id = m.member_id;
  insert into public.point_spends (member_id, amount, prize_title, mode) values (m.member_id, p_points, wid, 'withdraw');
  -- the details for the next time (the ones remembered stay as they are when they were used)
  if not v_saved then
    if coalesce(p_save, true) then
      insert into public.withdraw_methods (member_id, method, details, updated_at)
      values (m.member_id, v_method, clean->'details', now())
      on conflict (member_id, method) do update set details = excluded.details, updated_at = now();
    else
      delete from public.withdraw_methods where member_id = m.member_id and method = v_method;
    end if;
  end if;
  perform public._wd_notify(m.member_id, 'withdraw_new', 'Withdrawal request received', wid || ' · ' || v_net::text || ' ' || s.currency);
  return jsonb_build_object('ok', true, 'id', wid, 'points', p_points, 'amount', v_amount, 'fee', v_fee, 'net', v_net,
                            'currency', s.currency, 'status', 'pending');
end $$;

-- Cancel a request while it is pending: the points come back.
--   -> { ok: true, points } | { ok: false, reason: not_found | state (status) }
create or replace function public.withdraw_cancel(p_member text, p_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare w public.withdrawals;
begin
  select * into w from public.withdrawals
   where id = btrim(coalesce(p_id, '')) and member_id = btrim(coalesce(p_member, '')) for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if w.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'state', 'status', w.status); end if;
  update public.withdrawals set status = 'cancelled', cancelled_at = now(), refunded = true where id = w.id;
  perform public._wd_refund(w);
  return jsonb_build_object('ok', true, 'points', w.points);
end $$;

-- Forget the details remembered for a method. -> { ok: true, removed }
create or replace function public.withdraw_forget(p_member text, p_method text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from public.withdraw_methods where member_id = btrim(coalesce(p_member, '')) and method = lower(btrim(coalesce(p_method, '')));
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'removed', n > 0);
end $$;

-- ------------------------------------------------------------------ 5. the team (Panel > Withdrawals)
-- A request for the team: the details in full, the member, where the member stands today, and
-- whether the name of the payment is the name of the account.
create or replace function public._wd_admin_json(w public.withdrawals) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m public.members; payee text;
begin
  select * into m from public.members where member_id = w.member_id;
  payee := case when w.method = 'bank' then w.details->>'holder' else w.details->>'name' end;
  return public._wd_json(w, true) || jsonb_build_object(
    'member', case when m.member_id is null then jsonb_build_object('id', w.member_id) else jsonb_build_object(
      'id', m.member_id, 'username', m.username, 'full_name', m.full_name, 'country', m.country, 'status', m.status,
      'created_at', m.created_at,
      'avatar', coalesce((select p.avatar_url from public.profiles p where p.member_id = m.member_id), '')) end,
    'now', case when m.member_id is null then null else
      (select jsonb_build_object('ok', c->'ok', 'account', c->'account', 'level', c->'level', 'level_name', c->'level_name',
                                 'plan', c->'plan', 'months', c->'months', 'age_days', c->'age_days', 'available', c->'available')
         from (select public._wd_check(m) as c) z) end,
    'name_match', public._wd_name_match(payee, m.full_name));
end $$;

-- The requests. p_filter: pending | processing | open (both) | paid | rejected | cancelled | all;
-- p_q: a request id, a member id, a username or a name. The waiting ones oldest first.
--   -> { ok: true, items, total, counts: { pending, processing, open, paid, rejected, cancelled, all }, stats }
create or replace function public.withdraw_admin_list(p_token text, p_filter text default 'pending', p_q text default '',
  p_limit int default 30, p_offset int default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  who text; f text := lower(coalesce(nullif(btrim(p_filter), ''), 'pending')); q text := btrim(coalesce(p_q, ''));
  lim int := least(greatest(coalesce(p_limit, 30), 1), 100); off int := greatest(coalesce(p_offset, 0), 0);
  items jsonb; total bigint; counts jsonb;
begin
  who := public._wd_staff(p_token);
  if f not in ('pending', 'processing', 'open', 'paid', 'rejected', 'cancelled', 'all') then f := 'pending'; end if;
  with hit as (
    select w.* from public.withdrawals w left join public.members m on m.member_id = w.member_id
     where (q = '' or w.id ilike '%' || q || '%' or w.member_id = q or m.username ilike '%' || ltrim(q, '@') || '%'
            or m.full_name ilike '%' || q || '%' or w.details->>'holder' ilike '%' || q || '%'
            or w.details->>'name' ilike '%' || q || '%' or w.reference ilike '%' || q || '%')
  )
  select jsonb_build_object(
      'pending', count(*) filter (where status = 'pending'), 'processing', count(*) filter (where status = 'processing'),
      'open', count(*) filter (where status in ('pending', 'processing')), 'paid', count(*) filter (where status = 'paid'),
      'rejected', count(*) filter (where status = 'rejected'), 'cancelled', count(*) filter (where status = 'cancelled'),
      'all', count(*)),
    count(*) filter (where f = 'all' or status = f or (f = 'open' and status in ('pending', 'processing'))),
    coalesce((select jsonb_agg(public._wd_admin_json(x) order by
                case when f in ('pending', 'processing', 'open') then extract(epoch from x.created_at) else -extract(epoch from x.created_at) end)
              from (select h.* from hit h
                     where f = 'all' or h.status = f or (f = 'open' and h.status in ('pending', 'processing'))
                     order by case when f in ('pending', 'processing', 'open') then extract(epoch from h.created_at) else -extract(epoch from h.created_at) end
                     limit lim offset off) x), '[]'::jsonb)
    into counts, total, items
  from hit;
  return jsonb_build_object('ok', true, 'items', items, 'total', total, 'counts', counts, 'stats', public._wd_stats());
end $$;

-- What the team does with a request:
--   approve   pending -> processing (the transfer is on its way)
--   pay       pending | processing -> paid; p_reference (3 to 80 characters: the MTCN, the bank reference)
--             and p_reason as a word for the member (optional, 300)
--   reject    pending | processing -> rejected; p_reason (3 to 300) is shown to the member; p_refund: the
--             points come back (true, the default) or stay spent (fraud)
--   -> { ok: true, id, status } | { ok: false, reason: action | not_found | state (status) | reference | reason }
create or replace function public.withdraw_admin_action(p_token text, p_id text, p_action text, p_reason text default '',
  p_reference text default '', p_refund boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  who text; w public.withdrawals; act text := lower(btrim(coalesce(p_action, '')));
  v_reason text := btrim(coalesce(p_reason, '')); v_ref text := public._wd_line(p_reference); v_back boolean := coalesce(p_refund, true);
  money text;
begin
  who := public._wd_staff(p_token);
  if act not in ('approve', 'pay', 'reject') then return jsonb_build_object('ok', false, 'reason', 'action'); end if;
  select * into w from public.withdrawals where id = btrim(coalesce(p_id, '')) for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  money := w.id || ' · ' || w.net::text || ' ' || w.currency;
  if act = 'approve' then
    if w.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'state', 'status', w.status); end if;
    update public.withdrawals set status = 'processing', decided_at = now(), decided_by = who where id = w.id;
    perform public._wd_notify(w.member_id, 'withdraw_processing', 'Withdrawal approved', money);
    return jsonb_build_object('ok', true, 'id', w.id, 'status', 'processing');
  end if;
  if w.status not in ('pending', 'processing') then
    return jsonb_build_object('ok', false, 'reason', 'state', 'status', w.status);
  end if;
  if act = 'pay' then
    if length(v_ref) < 3 or length(v_ref) > 80 then return jsonb_build_object('ok', false, 'reason', 'reference'); end if;
    if length(v_reason) > 300 then return jsonb_build_object('ok', false, 'reason', 'reason'); end if;
    update public.withdrawals
       set status = 'paid', reference = v_ref, note = v_reason, paid_at = now(), paid_by = who,
           decided_at = coalesce(decided_at, now()), decided_by = case when decided_by = '' then who else decided_by end
     where id = w.id;
    perform public._wd_notify(w.member_id, 'withdraw_paid', 'Money sent', money || ' · ' || v_ref);
    return jsonb_build_object('ok', true, 'id', w.id, 'status', 'paid');
  end if;
  -- reject
  if length(v_reason) < 3 or length(v_reason) > 300 then return jsonb_build_object('ok', false, 'reason', 'reason'); end if;
  update public.withdrawals set status = 'rejected', reason = v_reason, refunded = v_back, decided_at = now(), decided_by = who
   where id = w.id;
  if v_back then perform public._wd_refund(w); end if;
  perform public._wd_notify(w.member_id, 'withdraw_rejected', 'Withdrawal rejected', money || ' · ' || v_reason);
  return jsonb_build_object('ok', true, 'id', w.id, 'status', 'rejected', 'refunded', v_back);
end $$;

-- Panel > Withdrawals > Settings. -> { ok: true, settings (+ updated_by, updated_at), stats }
create or replace function public.withdraw_admin_settings(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare who text; s public.withdraw_settings;
begin
  who := public._wd_staff(p_token);
  select * into s from public.withdraw_settings where id = 1;
  return jsonb_build_object('ok', true,
    'settings', public._wd_settings_json(s) || jsonb_build_object('updated_by', s.updated_by, 'updated_at', s.updated_at),
    'stats', public._wd_stats());
end $$;

-- d = { enabled, rate (1 to 1,000,000 points for 1 unit), currency (ISO: USD, EUR, MAD…), min_points
-- (1 to 100,000,000), max_points (0: no most; else at least min_points), bank (on / off), bank_fee,
-- agencies [names, 2 to 40 characters, 10 at most], agency_fee (0 to 100,000, cents), note (500) }
--   -> withdraw_admin_settings() | { ok: false, reason: rate | currency | min | max | fee | agencies | methods | note }
create or replace function public.withdraw_admin_settings_save(p_token text, d jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  who text; x jsonb := case when jsonb_typeof(d) = 'object' then d else '{}'::jsonb end; s public.withdraw_settings;
  v_rate int; v_cur text; v_min int; v_max int; v_bank boolean; v_bfee numeric; v_afee numeric; v_ag text[] := '{}';
  v_note text; v_on boolean; a text; fee_re text := '^[0-9]{1,6}([.][0-9]{1,2})?$';
  truthy text[] := array['true', '1', 'yes', 'on'];
begin
  who := public._wd_staff(p_token);
  select * into s from public.withdraw_settings where id = 1 for update;
  v_on := case when x ? 'enabled' then lower(coalesce(x->>'enabled', '')) = any (truthy) else s.enabled end;
  v_rate := case when x ? 'rate' then coalesce(public._wd_int(x->>'rate'), -1) else s.rate end;
  if v_rate < 1 or v_rate > 1000000 then return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  v_cur := upper(btrim(coalesce(x->>'currency', s.currency)));
  if v_cur !~ '^[A-Z]{3}$' then return jsonb_build_object('ok', false, 'reason', 'currency'); end if;
  v_min := case when x ? 'min_points' then coalesce(public._wd_int(x->>'min_points'), -1) else s.min_points end;
  if v_min < 1 or v_min > 100000000 then return jsonb_build_object('ok', false, 'reason', 'min'); end if;
  v_max := case when not x ? 'max_points' then s.max_points
                when btrim(coalesce(x->>'max_points', '')) = '' then 0
                else coalesce(public._wd_int(x->>'max_points'), -1) end;
  if v_max < 0 or v_max > 1000000000 or (v_max > 0 and v_max < v_min) then return jsonb_build_object('ok', false, 'reason', 'max'); end if;
  v_bank := case when x ? 'bank' then lower(coalesce(x->>'bank', '')) = any (truthy) else s.bank_on end;
  if x ? 'bank_fee' and btrim(coalesce(x->>'bank_fee', '')) !~ fee_re then return jsonb_build_object('ok', false, 'reason', 'fee'); end if;
  if x ? 'agency_fee' and btrim(coalesce(x->>'agency_fee', '')) !~ fee_re then return jsonb_build_object('ok', false, 'reason', 'fee'); end if;
  v_bfee := coalesce(nullif(btrim(coalesce(x->>'bank_fee', '')), '')::numeric, s.bank_fee);
  v_afee := coalesce(nullif(btrim(coalesce(x->>'agency_fee', '')), '')::numeric, s.agency_fee);
  if v_bfee > 100000 or v_afee > 100000 then return jsonb_build_object('ok', false, 'reason', 'fee'); end if;
  if x ? 'agencies' then
    if jsonb_typeof(x->'agencies') <> 'array' then return jsonb_build_object('ok', false, 'reason', 'agencies'); end if;
    for a in select public._wd_line(v) from jsonb_array_elements_text(x->'agencies') v loop
      if a = '' then continue; end if;
      if length(a) < 2 or length(a) > 40 then return jsonb_build_object('ok', false, 'reason', 'agencies'); end if;
      if not exists (select 1 from unnest(v_ag) y where lower(y) = lower(a)) then v_ag := v_ag || a; end if;
    end loop;
    if cardinality(v_ag) > 10 then return jsonb_build_object('ok', false, 'reason', 'agencies'); end if;
  else
    v_ag := s.agencies;
  end if;
  if v_on and not v_bank and coalesce(cardinality(v_ag), 0) = 0 then return jsonb_build_object('ok', false, 'reason', 'methods'); end if;
  v_note := btrim(coalesce(x->>'note', s.note));
  if length(v_note) > 500 then return jsonb_build_object('ok', false, 'reason', 'note'); end if;
  update public.withdraw_settings
     set enabled = v_on, rate = v_rate, currency = v_cur, min_points = v_min, max_points = v_max, bank_on = v_bank,
         bank_fee = round(v_bfee, 2), agencies = v_ag, agency_fee = round(v_afee, 2), note = v_note,
         updated_by = who, updated_at = now()
   where id = 1;
  return public.withdraw_admin_settings(p_token);
end $$;

-- ------------------------------------------------------------------ 6. who may call what
do $$
declare f text;
begin
  foreach f in array array[
    'public._wd_staff(text)', 'public._wd_int(text)', 'public._wd_line(text)', 'public._wd_name_ok(text)',
    'public._wd_plan(public.members)', 'public._wd_months(text)', 'public._wd_iban_ok(text)', 'public._wd_name_match(text, text)',
    'public._wd_clean(text, jsonb, public.withdraw_settings)', 'public._wd_mask(text, jsonb)', 'public._wd_check(public.members)',
    'public._wd_settings_json(public.withdraw_settings)', 'public._wd_json(public.withdrawals, boolean)',
    'public._wd_notify(text, text, text, text)', 'public._wd_refund(public.withdrawals)', 'public._wd_stats()',
    'public._wd_admin_json(public.withdrawals)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.withdraw_info()', 'public.withdraw_me(text)', 'public.withdraw_request(text, text, int, text, jsonb, boolean)',
    'public.withdraw_cancel(text, text)', 'public.withdraw_forget(text, text)',
    'public.withdraw_admin_list(text, text, text, int, int)', 'public.withdraw_admin_action(text, text, text, text, text, boolean)',
    'public.withdraw_admin_settings(text)', 'public.withdraw_admin_settings_save(text, jsonb)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
