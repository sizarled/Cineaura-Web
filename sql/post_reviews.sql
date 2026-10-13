-- CineAura posts: reviews, rich TMDB items and display options.
-- Run once in the Supabase SQL editor (safe to re-run).
--
-- * posts.kind accepts 'review' (title + text + pros + cons about one title).
-- * posts.display stores what a recommendation / list / review shows:
--   comma-separated 'info' (year, genre, story), 'cast' and 'trailer'.
-- * post_items keeps a TMDB snapshot (year, genres, story, cast, trailer) so
--   cards still render if TMDB is unreachable; live TMDB data in the viewer's
--   language is preferred when available.

alter table public.posts drop constraint if exists posts_kind_check;
alter table public.posts add constraint posts_kind_check
  check (kind in ('playlist', 'recommendation', 'reclist', 'account', 'review'));

alter table public.posts add column if not exists display text default 'info,cast,trailer';
alter table public.posts add column if not exists pros text default '';
alter table public.posts add column if not exists cons text default '';

alter table public.post_items add column if not exists year text default '';
alter table public.post_items add column if not exists genres text default '';
alter table public.post_items add column if not exists overview text default '';
alter table public.post_items add column if not exists cast_json text default '[]';
alter table public.post_items add column if not exists trailer_key text default '';
alter table public.post_items add column if not exists backdrop_path text default '';

create index if not exists post_items_post_idx on public.post_items (post_id);

-- Ask PostgREST to pick up the new columns right away.
notify pgrst, 'reload schema';
