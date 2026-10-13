-- CineAura messages: presence, per-user conversation delete, indexes.
-- Run once in the Supabase SQL editor (safe to re-run).
alter table public.profiles add column if not exists last_seen timestamptz;
alter table public.messages add column if not exists sender_deleted boolean not null default false;
alter table public.messages add column if not exists receiver_deleted boolean not null default false;
create index if not exists messages_sender_idx on public.messages (sender_id);
create index if not exists messages_receiver_idx on public.messages (receiver_id);
create index if not exists profiles_last_seen_idx on public.profiles (last_seen);
