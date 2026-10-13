-- CineAura posts: attribute watched minutes to the post they were opened from.
-- Watch links shared in a post use /watch.html?movie=ID&post=POST_ID, the watch
-- page stores the post id on every view row, and profile search ranks results
-- by recommendation points (up = +1, down = -1), then by these watched minutes.
-- Run once in the Supabase SQL editor (safe to re-run).
alter table public.views add column if not exists post_id text default '';
create index if not exists views_post_idx on public.views (post_id);
