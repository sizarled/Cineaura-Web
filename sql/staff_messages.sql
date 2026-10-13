-- CineAura admin messages (Panel -> Messages -> Admin messages)
-- Private chat between panel staff rows (Super Admin / Admin / Moderator).
-- Run once in the Supabase SQL editor (safe to re-run).
-- sql/panel.sql already contains these statements.

create table if not exists public.staff_messages (
  id bigint generated always as identity primary key,
  sender_staff_id bigint not null,
  sender_member_id text default '',
  sender_username text default '',
  sender_role text default '',
  receiver_staff_id bigint not null,
  receiver_member_id text default '',
  receiver_username text default '',
  receiver_role text default '',
  body text not null,
  created_at timestamptz not null default now(),
  read boolean not null default false,
  sender_deleted boolean not null default false,
  receiver_deleted boolean not null default false
);

alter table public.staff_messages add column if not exists sender_member_id text default '';
alter table public.staff_messages add column if not exists sender_username text default '';
alter table public.staff_messages add column if not exists sender_role text default '';
alter table public.staff_messages add column if not exists receiver_member_id text default '';
alter table public.staff_messages add column if not exists receiver_username text default '';
alter table public.staff_messages add column if not exists receiver_role text default '';
alter table public.staff_messages add column if not exists read boolean not null default false;
alter table public.staff_messages add column if not exists sender_deleted boolean not null default false;
alter table public.staff_messages add column if not exists receiver_deleted boolean not null default false;

create index if not exists staff_messages_sender_idx on public.staff_messages (sender_staff_id, created_at desc);
create index if not exists staff_messages_receiver_idx on public.staff_messages (receiver_staff_id, created_at desc);

alter table public.staff_messages enable row level security;

do $$
begin
  execute 'drop policy if exists "open select" on public.staff_messages';
  execute 'create policy "open select" on public.staff_messages for select to anon, authenticated using (true)';
  execute 'drop policy if exists "open insert" on public.staff_messages';
  execute 'create policy "open insert" on public.staff_messages for insert to anon, authenticated with check (true)';
  execute 'drop policy if exists "open update" on public.staff_messages';
  execute 'create policy "open update" on public.staff_messages for update to anon, authenticated using (true) with check (true)';
  execute 'drop policy if exists "open delete" on public.staff_messages';
  execute 'create policy "open delete" on public.staff_messages for delete to anon, authenticated using (true)';
end $$;
