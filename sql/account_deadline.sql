-- ============================================================
-- Activation deadline: an account that is not activated, or not re-activated, is
-- fully banned 30 days later.
-- Run in the Supabase SQL editor AFTER members.sql, activation.sql and ban_system.sql
-- (safe to run more than once).
--
--   * Sign-up creates the account "disabled" (members.sql); the activation page
--     (activate.html) makes it "active". Not activated within 30 days of signing
--     up: fully banned (ban_reason 'not_activated').
--   * Every membership ends (members.membership_expires_at; Free lasts 1 month).
--     Not re-activated within 30 days after that date: fully banned (ban_reason
--     'not_renewed'). Re-activating moves the end date, and with it the ban date.
--   * "Fully banned" is what Panel > Accounts > Full ban does: status 'banned',
--     banned_at (purge_banned_members deletes the account 3 months later) and the
--     member's watch links (movielink / tvlink) removed.
--   * Accounts that already exist the first time this file runs get 30 days from
--     that moment, so nobody is banned on the day the rule arrives. Lifting a ban
--     in the Panel gives 30 days again. Staff accounts are never banned by it.
--
-- members.ban_due_at is the moment of the ban (null = none), kept up to date by a
-- trigger from the status, the activation and the end of the membership; pages
-- read it for the countdown. The ban itself is applied:
--   - at sign-in (login_member, below and in members.sql);
--   - by account_check(member), which the pages of a signed-in member call
--     (banner with the countdown, dashboard, activation page);
--   - for everybody with account_ban_overdue(): Panel > Accounts runs it when it
--     opens, and pg_cron can run it every hour (bottom of this file).
-- ============================================================

-- ------------------------------------------------------------------ 1. columns
do $$
declare first_run boolean;
begin
  first_run := not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'members' and column_name = 'ban_due_at');
  alter table public.members add column if not exists activated_at timestamptz;
  alter table public.members add column if not exists ban_grace_from timestamptz;
  alter table public.members add column if not exists ban_due_at timestamptz;
  alter table public.members add column if not exists ban_reason text;
  alter table public.members add column if not exists banned_at timestamptz;
  if first_run then
    -- when each existing account was activated: its last used activation code, else
    -- (an active account from before the codes) the day it signed up
    update public.members m
       set activated_at = coalesce(
             (select max(coalesce(a.used_at, a.started_at)) from public.activation a
               where a.member_id = m.member_id and a.used),
             case when lower(coalesce(m.status, '')) = 'active' then m.created_at end)
     where m.activated_at is null;
    -- the 30 days of the accounts that exist now start today
    update public.members set ban_grace_from = now() where ban_grace_from is null;
  end if;
end $$;

alter table public.members drop constraint if exists members_ban_reason_check;
alter table public.members add constraint members_ban_reason_check
  check (ban_reason is null or ban_reason in ('not_activated', 'not_renewed'));

create index if not exists members_ban_due_idx on public.members (ban_due_at) where ban_due_at is not null;

comment on column public.members.activated_at is 'When the account was last activated (disabled -> active); null = never activated';
comment on column public.members.ban_grace_from is 'The 30 days before an automatic ban never start before this (first run of account_deadline.sql, a lifted ban)';
comment on column public.members.ban_due_at is 'When the account is fully banned if it is not activated / re-activated by then (null = no date). Kept by a trigger';
comment on column public.members.ban_reason is 'Why the rule of account_deadline.sql banned the account: not_activated | not_renewed (null for a ban from the Panel)';

-- ------------------------------------------------------------------ 2. the date
-- Never activated (and not active): 30 days after signing up. Otherwise 30 days after
-- the membership ends. Neither starts before ban_grace_from. Banned: no date.
create or replace function public._account_ban_due(
  p_status text, p_created timestamptz, p_activated timestamptz, p_expires timestamptz, p_grace timestamptz)
returns timestamptz language sql immutable as $$
  select case
    when lower(coalesce(p_status, '')) in ('banned', 'blocked', 'محظور') then null
    when p_activated is null and lower(coalesce(p_status, '')) <> 'active'
      then greatest(coalesce(p_created, p_grace, '1970-01-01'::timestamptz), coalesce(p_grace, '-infinity'::timestamptz)) + interval '30 days'
    when p_expires is null then null
    else greatest(p_expires, coalesce(p_grace, '-infinity'::timestamptz)) + interval '30 days'
  end
$$;

-- What the member has to do before ban_due_at: 'activate' (never activated),
-- 'renew' (the membership has ended) or null (nothing yet).
create or replace function public._account_need(m public.members)
returns text language sql stable as $$
  select case
    when m.ban_due_at is null then null
    when m.activated_at is null and lower(coalesce(m.status, '')) <> 'active' then 'activate'
    when m.membership_expires_at is not null and m.membership_expires_at <= now() then 'renew'
    else null
  end
$$;

-- Keeps activated_at, ban_grace_from and ban_due_at. The public API can't write
-- them (or ban_reason): only this trigger and the functions below do.
create or replace function public._account_deadline_trg() returns trigger language plpgsql as $$
declare
  new_st text := lower(coalesce(new.status, ''));
  old_st text;
begin
  if tg_op = 'UPDATE' then
    old_st := lower(coalesce(old.status, ''));
    if current_user in ('anon', 'authenticated') then
      new.activated_at := old.activated_at;
      new.ban_grace_from := old.ban_grace_from;
      new.ban_reason := old.ban_reason;
    end if;
    -- activated: disabled (or banned) -> active
    if new_st = 'active' and old_st <> 'active' then
      new.activated_at := now();
    end if;
    -- a lifted ban: 30 days again, and the reason goes
    if old_st in ('banned', 'blocked', 'محظور') and new_st not in ('banned', 'blocked', 'محظور') then
      new.ban_grace_from := now();
      new.ban_reason := null;
    end if;
  else
    if current_user in ('anon', 'authenticated') then
      new.activated_at := null;
      new.ban_grace_from := null;
      new.ban_reason := null;
    end if;
    if new_st = 'active' and new.activated_at is null then
      new.activated_at := coalesce(new.created_at, now());
    end if;
  end if;
  new.ban_due_at := public._account_ban_due(new.status, new.created_at, new.activated_at,
                                            new.membership_expires_at, new.ban_grace_from);
  return new;
end $$;

drop trigger if exists members_account_deadline on public.members;
create trigger members_account_deadline before insert or update on public.members
  for each row execute function public._account_deadline_trg();

-- every existing row gets its date now
update public.members set ban_due_at = public._account_ban_due(status, created_at, activated_at, membership_expires_at, ban_grace_from)
 where ban_due_at is distinct from public._account_ban_due(status, created_at, activated_at, membership_expires_at, ban_grace_from);

-- ------------------------------------------------------------------ 3. the ban
create or replace function public._account_is_staff(p_member text)
returns boolean language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(p_member, '') = '' or to_regclass('public.staff') is null then return false; end if;
  return exists (select 1 from public.staff s where s.member_id = p_member);
end $$;

-- Bans the member if the date has passed (and they are not staff). True when it did.
create or replace function public._account_ban(p_member text)
returns boolean language plpgsql security definer set search_path = public as $$
declare m public.members; why text;
begin
  select * into m from public.members where member_id = btrim(coalesce(p_member, '')) for update;
  if not found or lower(coalesce(m.status, '')) = 'banned' or m.ban_due_at is null or m.ban_due_at > now()
     or public._account_is_staff(m.member_id) then
    return false;
  end if;
  why := case when m.activated_at is null and lower(coalesce(m.status, '')) <> 'active' then 'not_activated' else 'not_renewed' end;
  update public.members set status = 'banned', banned_at = now(), ban_reason = why where member_id = m.member_id;
  -- like Panel > Accounts > Full ban: the member's watch links go
  if to_regclass('public.movielink') is not null then
    execute 'delete from public.movielink where member_id = $1' using m.member_id;
  end if;
  if to_regclass('public.tvlink') is not null then
    execute 'delete from public.tvlink where member_id = $1' using m.member_id;
  end if;
  return true;
end $$;

-- Every account whose date has passed (Panel > Accounts, pg_cron). -> how many were banned
create or replace function public.account_ban_overdue(p_limit integer default 500)
returns integer language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0;
begin
  for r in
    select m.member_id from public.members m
     where m.ban_due_at is not null and m.ban_due_at <= now() and lower(coalesce(m.status, '')) <> 'banned'
     order by m.ban_due_at
     limit least(greatest(coalesce(p_limit, 500), 1), 5000)
  loop
    if public._account_ban(r.member_id) then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- The pages of a signed-in member: bans the account if its date has passed, then
-- says what to show.
-- -> { ok, status, need: activate | renew | null, due_at, expires_at, banned_now, ban_reason }
--    { ok: false, reason: 'not_found' }
create or replace function public.account_check(p_member text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members; now_banned boolean := false; staff boolean;
begin
  select * into m from public.members where member_id = btrim(coalesce(p_member, ''));
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  now_banned := public._account_ban(m.member_id);
  if now_banned then
    select * into m from public.members where member_id = m.member_id;
  end if;
  staff := public._account_is_staff(m.member_id);
  return jsonb_build_object(
    'ok', true,
    'status', lower(coalesce(m.status, '')),
    'need', case when staff then null else public._account_need(m) end,
    'due_at', case when staff then null else m.ban_due_at end,
    'expires_at', m.membership_expires_at,
    'banned_now', now_banned,
    'ban_reason', m.ban_reason);
end $$;

-- ------------------------------------------------------------------ 4. sign-in
-- Same body as in members.sql: an account whose date has passed is banned when it
-- signs in, and the answer says why (ban_reason).
create or replace function public.login_member(
  p_login text,
  p_password text
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  rec members%rowtype;
  now_banned boolean := false;
begin
  select * into rec
  from members
  where lower(username) = lower(trim(p_login))
     or lower(email) = lower(trim(p_login))
  limit 1;

  if not found then
    return json_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- sql/account_deadline.sql: not activated / re-activated within 30 days
  if rec.status <> 'banned' and to_regprocedure('public._account_ban(text)') is not null then
    execute 'select public._account_ban($1)' into now_banned using rec.member_id;
    if now_banned then
      select * into rec from members where member_id = rec.member_id;
    end if;
  end if;

  if rec.status = 'banned' then
    return json_build_object('ok', false, 'reason', 'banned', 'ban_reason', to_jsonb(rec) ->> 'ban_reason');
  end if;

  if rec.password is distinct from p_password then
    return json_build_object('ok', false, 'reason', 'bad_password');
  end if;

  return json_build_object(
    'ok', true,
    'reason', 'ok',
    'member', json_build_object(
      'member_id', rec.member_id,
      'full_name', rec.full_name,
      'username', rec.username,
      'email', rec.email,
      'status', rec.status,
      'country', rec.country,
      'birth_date', rec.birth_date,
      'recovery_code', rec.recovery_code,
      'created_at', rec.created_at
    )
  );
end;
$$;

-- ------------------------------------------------------------------ 5. who may call what
revoke all on function public._account_need(public.members) from public, anon, authenticated;
revoke all on function public._account_deadline_trg() from public, anon, authenticated;
revoke all on function public._account_is_staff(text) from public, anon, authenticated;
revoke all on function public._account_ban(text) from public, anon, authenticated;
revoke all on function public.account_ban_overdue(integer) from public, anon, authenticated;
revoke all on function public.account_check(text) from public, anon, authenticated;
-- the trigger runs as whoever writes the row (the Panel and the activation page write
-- with the public key), so the date function stays callable: it only does arithmetic
grant execute on function public._account_ban_due(text, timestamptz, timestamptz, timestamptz, timestamptz) to public, anon, authenticated;
grant execute on function public.account_ban_overdue(integer) to anon, authenticated;
grant execute on function public.account_check(text) to anon, authenticated;
grant execute on function public.login_member(text, text) to anon, authenticated;

-- Optional (Database > Extensions > enable pg_cron): every hour, without waiting for
-- a sign-in or Panel > Accounts.
-- select cron.schedule('account-ban-overdue', '17 * * * *', $$select public.account_ban_overdue()$$);

notify pgrst, 'reload schema';
