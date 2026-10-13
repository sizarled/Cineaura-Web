-- CineAura post analytics: impressions, link clicks and successful referral sign-ups per post.
-- Recommendations (up) and "don't recommend" (down) already live in
-- public.post_votes, and watched minutes in public.views (post_id), so this
-- table only holds the events nothing else records. A share is credited only
-- by the registration trigger after a new member signs up through a shared link.
-- Run once in the Supabase SQL editor (safe to re-run).

create table if not exists public.post_events (
  id bigint generated always as identity primary key,
  post_id text not null,
  owner_id text default '',
  kind text not null,
  network text default '',
  member_id text default '',
  username text default '',
  created_at timestamptz not null default now(),
  constraint post_events_kind_check check (kind in ('impression', 'click', 'share'))
);

comment on table public.post_events is 'Per-post analytics: impressions, post-link clicks, and completed sign-ups attributed to shared links';
comment on column public.post_events.kind is 'impression | click | share; share rows are successful referrals, not share-button clicks';
comment on column public.post_events.network is 'referral for a new registration attributed to a shared link; other values are legacy share actions';
comment on column public.post_events.member_id is 'For referral rows, the member whose shared post link led to registration; empty for signed-out impressions/clicks';

create index if not exists post_events_post_idx on public.post_events (post_id, kind, created_at desc);
create index if not exists post_events_owner_idx on public.post_events (owner_id, created_at desc);
create index if not exists post_events_referral_member_idx
  on public.post_events (member_id, created_at desc) where kind = 'share' and network = 'referral';

alter table public.post_events enable row level security;

do $$
declare t text := 'post_events';
begin
  execute format('drop policy if exists "open select" on public.%I', t);
  execute format('create policy "open select" on public.%I for select to anon, authenticated using (true)', t);
  execute format('drop policy if exists "open insert" on public.%I', t);
  -- Only the SECURITY DEFINER registration trigger may create conversions.
  execute format('create policy "open insert" on public.%I for insert to anon, authenticated with check (kind <> ''share'')', t);
  execute format('drop policy if exists "open update" on public.%I', t);
  execute format('create policy "open update" on public.%I for update to anon, authenticated using (kind <> ''share'') with check (kind <> ''share'')', t);
  execute format('drop policy if exists "open delete" on public.%I', t);
  execute format('create policy "open delete" on public.%I for delete to anon, authenticated using (kind <> ''share'')', t);
end $$;

-- Ask PostgREST to pick up the new table right away.
notify pgrst, 'reload schema';
