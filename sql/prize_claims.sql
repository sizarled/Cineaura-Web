-- ============================================================
-- Prize claims: the review of every claim (Panel > Prizes > Prize claims)
-- Run in the Supabase SQL editor AFTER prize_secure.sql, because it uses the
-- panel's staff sessions and the points ledger. Safe to run more than once.
-- Install: run the current prize_secure.sql first (its prize_request_claim and
-- prize_claim_simple write the review row of every new claim and refuse a
-- blocked member), then this file. Claims sent before are added as "submitted".
--
-- A winner presses "Claim prize" once they have met the prize's conditions
-- (prize_request_claim / prize_claim_simple in prize_secure.sql). From then on the
-- claim has one of four states, shown in the panel and on the member's dashboard
-- (Dashboard > Prizes > Prize claims):
--
--   submitted  Claim submitted      the member pressed "Claim prize"
--   review     Claim under review   the team checks that the member kept to the
--                                   conditions of the prize
--   accepted   Claim accepted       no problem and no cheating: the prize is delivered
--   rejected   Claim rejected       cheating or a problem was found. The team writes
--                                   the reason (required) and takes at least one action:
--                                     - deduct points (never more than the member has)
--                                     - reset the member's points to zero
--                                     - block every prize claim for a number of days
--                                   The member loses the prize: their entry is excluded
--                                   and the winner row removed, so the place is free for
--                                   someone else. Points paid for the prize are not
--                                   given back.
--
-- A decision is only taken on a claim under review, and it is final. A block can
-- be lifted early. The member hears of every change in their notifications.
--
-- Everyone can read the table, like winners and prize_mode_entries. Nobody can
-- write it with the public key: members add rows through prize_request_claim /
-- prize_claim_simple, staff with the Prizes section change them through
-- prize_admin_claim().
-- ============================================================

-- 1) One row per claim ----------------------------------------------------------
create table if not exists public.prize_claims (
  id bigint generated always as identity primary key,
  member_id text not null,
  prize_id bigint,
  prize_title text not null default '',
  mode text not null default '',              -- gift | challenge | lottery | claim (prize without modes)
  entry_id bigint,                            -- prize_mode_entries.id (prizes with modes)
  winner_id bigint,                           -- winners.id (prizes without modes)
  points_paid integer not null default 0,
  status text not null default 'submitted',   -- submitted | review | accepted | rejected
  submitted_at timestamptz not null default now(),
  review_at timestamptz,
  review_by text not null default '',
  decided_at timestamptz,
  decided_by text not null default '',
  reason text not null default '',            -- rejected: why (shown to the member)
  penalty text not null default '',           -- '' | deduct | reset
  penalty_points integer not null default 0,  -- points actually taken
  restrict_days integer,                      -- prize claims blocked for this many days
  restricted_until timestamptz,
  lifted_at timestamptz,                      -- block lifted early by the team
  lifted_by text not null default ''
);

alter table public.prize_claims add column if not exists lifted_at timestamptz;
alter table public.prize_claims add column if not exists lifted_by text not null default '';

do $$
begin
  alter table public.prize_claims add constraint prize_claims_status_check
    check (status in ('submitted', 'review', 'accepted', 'rejected'));
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table public.prize_claims add constraint prize_claims_penalty_check
    check (penalty in ('', 'deduct', 'reset'));
exception when duplicate_object then null;
end $$;

create unique index if not exists prize_claims_entry_uq on public.prize_claims (entry_id) where entry_id is not null;
create unique index if not exists prize_claims_winner_uq on public.prize_claims (winner_id) where winner_id is not null;
create index if not exists prize_claims_member_idx on public.prize_claims (member_id, submitted_at desc);
create index if not exists prize_claims_status_idx on public.prize_claims (status, submitted_at desc);

-- 2) Claims sent before this file: they wait for a review --------------------------
insert into public.prize_claims (member_id, prize_id, prize_title, mode, entry_id, points_paid, submitted_at)
select e.member_id, e.prize_id, coalesce(p.title, ''), coalesce(e.mode, ''), e.id, coalesce(e.points_paid, 0), e.claim_requested_at
from public.prize_mode_entries e
left join public.prizes p on p.id = e.prize_id
where e.claim_requested_at is not null
  and not exists (select 1 from public.prize_claims c where c.entry_id = e.id);

insert into public.prize_claims (member_id, prize_id, prize_title, mode, winner_id, points_paid, submitted_at)
select w.member_id,
       (select p.id from public.prizes p where p.title = w.prize_title order by p.id desc limit 1),
       w.prize_title, 'claim', w.id, coalesce(w.minutes_paid, 0), w.claim_requested_at
from public.winners w
where w.claim_requested_at is not null
  and not exists (select 1 from public.prize_claims c where c.winner_id = w.id);

-- 3) Helpers ------------------------------------------------------------------------
-- End of the member's block on prize claims, or null when they may claim.
create or replace function public._claim_block(p_member text)
returns timestamptz language sql stable security definer set search_path = public as $$
  select max(restricted_until) from public.prize_claims
  where member_id = p_member and status = 'rejected' and lifted_at is null and restricted_until > now();
$$;

-- The member hears of every change of their claim (bell + Notifications page),
-- which opens Dashboard > Prizes > Prize claims. The title is shown in the
-- member's language (CineAura.noteTitle); the stored English one is for anything
-- else that reads the row.
create or replace function public._notify_claim(c public.prize_claims, p_kind text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if to_regclass('public.notifications') is null then return; end if;
  insert into public.notifications (member_id, kind, title, body, href, from_id, from_username)
  values (
    c.member_id, p_kind,
    case p_kind
      when 'prize_claim_review' then 'Your prize claim is under review'
      when 'prize_claim_accepted' then 'Your prize claim was accepted'
      when 'prize_claim_rejected' then 'Your prize claim was rejected'
      else 'You can claim prizes again'
    end,
    left(case
      when p_kind = 'prize_claim_unblocked' then ''
      when p_kind = 'prize_claim_rejected' and c.reason <> '' then c.prize_title || ' — ' || c.reason
      else c.prize_title
    end, 300),
    './dashboard.html#claims', '', ''
  );
end $$;

-- 4) Staff: review, accept, reject, lift a block ---------------------------------------
--   p_action = 'review'  submitted -> review
--              'accept'  review -> accepted
--              'reject'  review -> rejected, d = { reason, points: '' | deduct | reset, amount, days }
--              'lift'    ends the block of a rejected claim now
-- Answers { ok: true, claim, points } or { ok: false, error }.
create or replace function public.prize_admin_claim(p_token text, p_claim bigint, p_action text, d jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.staff;
  c public.prize_claims;
  who text;
  v_reason text;
  v_pen text;
  v_want int;
  v_days int;
  v_amount int := 0;
  v_avail int;
  v_until timestamptz;
  v_title text;
begin
  s := public._staff_prizes(p_token);
  who := coalesce(nullif(s.username, ''), nullif(s.member_id, ''), s.role);
  d := coalesce(d, '{}'::jsonb);
  select * into c from public.prize_claims where id = p_claim for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  if p_action = 'review' then
    if c.status <> 'submitted' then return jsonb_build_object('ok', false, 'error', 'state', 'status', c.status); end if;
    update public.prize_claims set status = 'review', review_at = now(), review_by = who
    where id = c.id returning * into c;
    perform public._notify_claim(c, 'prize_claim_review');
    return jsonb_build_object('ok', true, 'claim', to_jsonb(c));

  elsif p_action = 'accept' then
    if c.status <> 'review' then return jsonb_build_object('ok', false, 'error', 'state', 'status', c.status); end if;
    update public.prize_claims set status = 'accepted', decided_at = now(), decided_by = who
    where id = c.id returning * into c;
    perform public._notify_claim(c, 'prize_claim_accepted');
    return jsonb_build_object('ok', true, 'claim', to_jsonb(c));

  elsif p_action = 'reject' then
    if c.status <> 'review' then return jsonb_build_object('ok', false, 'error', 'state', 'status', c.status); end if;
    v_reason := btrim(coalesce(d->>'reason', ''));
    if v_reason = '' then return jsonb_build_object('ok', false, 'error', 'reason'); end if;
    if length(v_reason) > 1000 then return jsonb_build_object('ok', false, 'error', 'reason_long'); end if;
    v_pen := lower(btrim(coalesce(d->>'points', '')));
    if v_pen = 'none' then v_pen := ''; end if;
    if v_pen not in ('', 'deduct', 'reset') then return jsonb_build_object('ok', false, 'error', 'points'); end if;
    if v_pen = 'deduct' then
      if coalesce(d->>'amount', '') !~ '^\s*\d{1,9}\s*$' then return jsonb_build_object('ok', false, 'error', 'amount'); end if;
      v_want := (d->>'amount')::int;
      if v_want < 1 then return jsonb_build_object('ok', false, 'error', 'amount'); end if;
    end if;
    if coalesce(d->>'days', '') <> '' then
      if (d->>'days') !~ '^\s*\d{1,5}\s*$' then return jsonb_build_object('ok', false, 'error', 'days'); end if;
      v_days := (d->>'days')::int;
      if v_days < 1 or v_days > 3650 then return jsonb_build_object('ok', false, 'error', 'days'); end if;
    end if;
    if v_pen = '' and v_days is null then return jsonb_build_object('ok', false, 'error', 'action'); end if;

    -- points: deduct (up to the balance) or reset, written to the spending ledger
    if v_pen <> '' then
      perform 1 from public.profiles where member_id = c.member_id for update;
      v_avail := greatest(0, coalesce((public._points(c.member_id)->>'available')::int, 0));
      v_amount := case when v_pen = 'reset' then v_avail else least(v_want, v_avail) end;
      if v_amount > 0 then
        update public.profiles set points_spent = coalesce(points_spent, 0) + v_amount where member_id = c.member_id;
        insert into public.point_spends (member_id, amount, prize_title, mode)
        values (c.member_id, v_amount, c.prize_title, case when v_pen = 'reset' then 'reset' else 'penalty' end);
      end if;
    end if;
    if v_days is not null then v_until := now() + make_interval(days => v_days); end if;

    -- the member loses the prize: the place is free for someone else
    select title into v_title from public.prizes where id = c.prize_id;
    if c.entry_id is not null then
      update public.prize_mode_entries set status = 'excluded', status_note = 'claim_rejected', status_by = who
      where id = c.entry_id and status = 'winner';
      if found then
        delete from public.winners where id = (
          select w.id from public.winners w
          where w.member_id = c.member_id and w.prize_title in (c.prize_title, coalesce(v_title, c.prize_title))
          order by w.id desc limit 1);
      end if;
    elsif c.winner_id is not null then
      delete from public.winners where id = c.winner_id;
      if found and c.prize_id is not null then
        update public.prizes set winners_count = greatest(0, coalesce(winners_count, 0) - 1) where id = c.prize_id;
      end if;
    end if;

    update public.prize_claims
    set status = 'rejected', decided_at = now(), decided_by = who, reason = v_reason,
        penalty = v_pen, penalty_points = v_amount, restrict_days = v_days, restricted_until = v_until
    where id = c.id returning * into c;
    perform public._notify_claim(c, 'prize_claim_rejected');
    return jsonb_build_object('ok', true, 'claim', to_jsonb(c), 'points', v_amount);

  elsif p_action = 'lift' then
    if c.status <> 'rejected' or c.restricted_until is null or c.restricted_until <= now() or c.lifted_at is not null then
      return jsonb_build_object('ok', false, 'error', 'state', 'status', c.status);
    end if;
    update public.prize_claims set lifted_at = now(), lifted_by = who where id = c.id returning * into c;
    if public._claim_block(c.member_id) is null then perform public._notify_claim(c, 'prize_claim_unblocked'); end if;
    return jsonb_build_object('ok', true, 'claim', to_jsonb(c));
  end if;

  return jsonb_build_object('ok', false, 'error', 'action');
end $$;

-- 5) Public read, no public write ------------------------------------------------------
alter table public.prize_claims enable row level security;
do $$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'prize_claims' loop
    execute format('drop policy %I on public.prize_claims', pol.policyname);
  end loop;
end $$;
create policy prize_claims_read on public.prize_claims for select to anon, authenticated using (true);
revoke all on public.prize_claims from anon, authenticated;
grant select on public.prize_claims to anon, authenticated;

revoke all on function public._claim_block(text) from public, anon, authenticated;
revoke all on function public._notify_claim(public.prize_claims, text) from public, anon, authenticated;
revoke all on function public.prize_admin_claim(text, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.prize_admin_claim(text, bigint, text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
