-- CineAura Comment table
-- Run in the Supabase SQL editor.

create table if not exists public.comments (
  id bigint generated always as identity primary key,
  idtmdb integer not null,
  "type" text not null,
  username text not null,
  member_id text default '',
  "comment" text not null,
  comment_type text not null default 'comment',
  parent_id bigint,
  comment_id text,
  parent_comment_id text,
  created_at timestamptz not null default now(),
  constraint comments_type_check check ("type" in ('movie', 'tv')),
  constraint comments_kind_check check (comment_type in ('comment', 'reply'))
);

alter table public.comments add column if not exists comment_id text;
alter table public.comments add column if not exists parent_comment_id text;
create unique index if not exists comments_comment_id_idx on public.comments (comment_id);

comment on table public.comments is 'Comment: title comments and replies';
comment on column public.comments.idtmdb is 'TMDB movie or series id';
comment on column public.comments.type is 'movie or tv';
comment on column public.comments.comment_type is 'comment or reply';
comment on column public.comments.parent_id is 'Legacy numeric parent row id';
comment on column public.comments.comment_id is 'Public id: C + digits for comments, R + digits for replies';
comment on column public.comments.parent_comment_id is 'comment_id of the post being replied to';

create index if not exists comments_title_idx on public.comments (idtmdb, "type", created_at);

alter table public.comments enable row level security;

drop policy if exists "Comment select" on public.comments;
create policy "Comment select" on public.comments for select to anon, authenticated using (true);
drop policy if exists "Comment insert" on public.comments;
create policy "Comment insert" on public.comments for insert to anon, authenticated with check (true);
drop policy if exists "Comment update" on public.comments;
create policy "Comment update" on public.comments for update to anon, authenticated using (true) with check (true);
drop policy if exists "Comment delete" on public.comments;
create policy "Comment delete" on public.comments for delete to anon, authenticated using (true);
