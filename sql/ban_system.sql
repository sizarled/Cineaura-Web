-- CineAura ban system: ban date + automatic deletion of fully banned accounts after 3 months.
-- Run once in the Supabase SQL editor (safe to re-run).
alter table public.members add column if not exists banned_at timestamptz;

-- Accounts already banned start their 3-month countdown now.
update public.members
set banned_at = now()
where banned_at is null and (lower(status) in ('banned', 'blocked') or status = 'محظور');

create or replace function public.purge_banned_members(retention interval default interval '3 months')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
  c record;
  n integer := 0;
begin
  for m in
    select member_id from public.members
    where (lower(status) in ('banned', 'blocked') or status = 'محظور')
      and banned_at is not null
      and banned_at < now() - retention
      and member_id not in (select member_id from public.staff where coalesce(member_id, '') <> '')
  loop
    -- playlist items belong to the member's playlists
    begin
      delete from public.playlist_items
      where playlist_id in (select playlist_id from public.playlists where owner_id = m.member_id);
    exception when others then null;
    end;

    -- remove the member's rows from every table that references them
    for c in
      select col.table_name, col.column_name
      from information_schema.columns col
      join information_schema.tables tb
        on tb.table_schema = col.table_schema and tb.table_name = col.table_name and tb.table_type = 'BASE TABLE'
      where col.table_schema = 'public'
        and col.table_name not in ('members', 'staff', 'panel_messages', 'panel_replies', 'panel_settings')
        and col.column_name in ('member_id', 'owner_id', 'sender_id', 'receiver_id', 'follower_id', 'following_id',
                                'blocker_id', 'blocked_id', 'viewer_id', 'visitor_id', 'reporter_id', 'actor_id', 'from_id')
    loop
      begin
        execute format('delete from public.%I where %I::text = $1', c.table_name, c.column_name) using m.member_id;
      exception when others then null;
      end;
    end loop;

    delete from public.members where member_id = m.member_id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

grant execute on function public.purge_banned_members(interval) to anon, authenticated;

-- Optional (Database > Extensions > enable pg_cron), runs the cleanup every day at 03:00:
-- select cron.schedule('purge-banned-members', '0 3 * * *', $$select public.purge_banned_members()$$);
