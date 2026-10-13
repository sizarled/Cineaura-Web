-- ============================================================
-- Prize admin: add / manage / statistics tabs of the staff panel
-- Run once in the Supabase SQL editor AFTER prize_center.sql and
-- prize_modes.sql (safe to run again).
--
--   * prizes get a status (active | ended), several categories and
--     per-country windows (start mandatory, end optional)
--   * every mode keeps its own audience + requirements in prize_modes.config
--   * discount coupons (10 % .. 80 %) with expiry, usage limits and a
--     24 h block after three wrong attempts
--   * monthly / concurrent participation limits per membership tier
--   * visits (for the statistics tab) and member bans per entry
-- ============================================================

-- 1) Prize status + categories ------------------------------------------------
alter table public.prizes add column if not exists status text default 'active';   -- active | ended
alter table public.prizes add column if not exists ended_at timestamptz;
alter table public.prizes add column if not exists categories text default '';     -- "Electronics,Phones,Games"
update public.prizes set status = 'active' where status is null;

-- A prize can sit in several categories (prizes.group_id stays the first one).
create table if not exists public.prize_group_links (
  id bigint generated always as identity primary key,
  prize_id bigint not null,
  group_id bigint not null,
  unique (prize_id, group_id)
);
create index if not exists prize_group_links_group_idx on public.prize_group_links (group_id);

-- 2) Per-country windows ------------------------------------------------------
-- starts_at is mandatory for a row; ends_at is optional (null = unlimited).
create table if not exists public.prize_country_dates (
  id bigint generated always as identity primary key,
  prize_id bigint not null,
  country text not null,
  starts_at date not null,
  ends_at date,
  unique (prize_id, country)
);
create index if not exists prize_country_dates_prize_idx on public.prize_country_dates (prize_id);

-- 3) Mode configuration ---------------------------------------------------------
-- config holds what has no dedicated column, e.g.
--   gift:      { audience: {type, countries[], genders[], min_age, max_age, min_account_days, member_ids[]} }
--   challenge: { days, audience: {countries[], max_age, max_account_days, membership[]} }
--   lottery:   { opens_at, audience: {...}, require: {...} }
alter table public.prize_modes add column if not exists config jsonb default '{}'::jsonb;

-- Extra kinds of required actions (counts live in prize_mode_conditions.required).
alter table public.prize_mode_conditions drop constraint if exists prize_mode_conditions_kind_check;
alter table public.prize_mode_conditions add constraint prize_mode_conditions_kind_check
  check (kind in ('watch','share','invite','points',
                  'link_shares','watch_minutes','playlists','recommendations',
                  'comments','movies','series','follows'));

-- 4) Entries: bans and notes ----------------------------------------------------
alter table public.prize_mode_entries add column if not exists banned_until timestamptz;
alter table public.prize_mode_entries add column if not exists status_note text default '';
alter table public.prize_mode_entries add column if not exists status_by text default '';
alter table public.prize_mode_entries add column if not exists withdrawn_at timestamptz;
alter table public.prize_mode_entries add column if not exists coupon_id bigint;

-- 5) Participation limits per tier ---------------------------------------------
--   period: month      = joined during the current calendar month
--           concurrent = prizes still running (not ended, not already decided)
create table if not exists public.prize_limits (
  tier text not null,
  mode text not null,
  limit_count integer not null default 0,
  period text not null default 'month',
  primary key (tier, mode),
  constraint prize_limits_tier_check check (tier in ('Free','Silver','Gold','Diamond')),
  constraint prize_limits_mode_check check (mode in ('gift','challenge','lottery')),
  constraint prize_limits_period_check check (period in ('month','concurrent'))
);
insert into public.prize_limits (tier, mode, limit_count, period) values
  ('Free','gift',10,'month'),     ('Free','challenge',5,'concurrent'),     ('Free','lottery',1,'month'),
  ('Silver','gift',50,'month'),   ('Silver','challenge',10,'concurrent'),  ('Silver','lottery',5,'month'),
  ('Gold','gift',100,'month'),    ('Gold','challenge',50,'concurrent'),    ('Gold','lottery',10,'month'),
  ('Diamond','gift',500,'month'), ('Diamond','challenge',100,'concurrent'), ('Diamond','lottery',50,'month')
on conflict (tier, mode) do nothing;

-- 6) Discount coupons ------------------------------------------------------------
create table if not exists public.prize_codes (
  id bigint generated always as identity primary key,
  prize_id bigint not null,
  code text not null,
  percent integer not null,
  audience text not null default 'public',        -- public | exclusive | private
  countries text default '',                      -- exclusive: comma separated
  genders text default '',                        -- exclusive: male,female
  min_age integer,
  max_age integer,
  min_account_days integer,
  member_ids text default '',                     -- private: comma separated member ids
  expires_at timestamptz,
  max_uses integer,                               -- null = unlimited
  uses integer not null default 0,
  active boolean not null default true,
  created_at timestamptz default now(),
  constraint prize_codes_percent_check check (percent between 10 and 80),
  constraint prize_codes_audience_check check (audience in ('public','exclusive','private'))
);
create unique index if not exists prize_codes_unique on public.prize_codes (prize_id, upper(code));

create table if not exists public.prize_code_uses (
  id bigint generated always as identity primary key,
  code_id bigint not null,
  prize_id bigint not null,
  member_id text not null,
  points_saved integer default 0,
  created_at timestamptz default now(),
  unique (code_id, member_id)
);

-- Three wrong codes in a row block code entry for 24 hours.
create table if not exists public.prize_code_blocks (
  member_id text primary key,
  fails integer not null default 0,
  blocked_until timestamptz,
  updated_at timestamptz default now()
);

-- 7) Visits (statistics tab) ------------------------------------------------------
create table if not exists public.prize_views (
  id bigint generated always as identity primary key,
  prize_id bigint not null,
  visitor_id text default '',                     -- member id, empty for guests
  country text default '',
  created_at timestamptz default now()
);
create index if not exists prize_views_prize_idx on public.prize_views (prize_id, created_at desc);

-- 8) Open policies, same as the other site tables ---------------------------------
do $$
declare t text;
begin
  foreach t in array array['prize_group_links','prize_country_dates','prize_limits','prize_codes',
                           'prize_code_uses','prize_code_blocks','prize_views']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "open select" on public.%I', t);
    execute format('create policy "open select" on public.%I for select to anon, authenticated using (true)', t);
    execute format('drop policy if exists "open insert" on public.%I', t);
    execute format('create policy "open insert" on public.%I for insert to anon, authenticated with check (true)', t);
    execute format('drop policy if exists "open update" on public.%I', t);
    execute format('create policy "open update" on public.%I for update to anon, authenticated using (true) with check (true)', t);
    execute format('drop policy if exists "open delete" on public.%I', t);
    execute format('create policy "open delete" on public.%I for delete to anon, authenticated using (true)', t);
  end loop;
end $$;
