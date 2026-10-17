-- CineAura — pictures uploaded from the device (Supabase Storage, bucket IPTV)
-- Run this in the Supabase SQL editor (safe to run more than once), after prize_secure.sql.
-- sql/market.sql uses it too, so run it before market.sql.
--
-- Every picture field of the site takes an image link, or a picture picked on the device.
-- The browser makes the picture smaller (JPEG) and uploads it with the public key, named
-- after the id of what it shows:
--
--   prizes (Panel > Prizes)          IPTV/Prizes/Previews/<prize id>.jpg
--                                    more than one picture: <prize id>-1.jpg, <prize id>-2.jpg …
--   prize groups (Panel > Prizes)    IPTV/Prizes/Grpoups/<group id>.jpg
--   products (Market.html)           IPTV/Market/Product/<product id>.jpg, <product id>-1.jpg …
--   store logos (Market.html)        IPTV/Market/Logo/<store id>.jpg
--   store covers (Market.html)       IPTV/Market/Cover/<store id>.jpg
--
-- (profile pictures keep their own policies: sql/avatar_storage.sql.)
--
-- Upload tickets: Storage refuses every upload that no policy allows. The policies below
-- allow a file only while it has a ticket: the server writes one for the exact file name
-- when a staff member (prize_admin_upload, checked with the Panel session) or the owner of
-- the product or store (market_upload, sql/market.sql) asks for it, valid for 15 minutes.
-- The upload is sent with x-upsert, so a new picture replaces the old one under the same
-- name; that needs INSERT, SELECT and UPDATE on storage.objects — the three policies allow
-- exactly that, for ticketed names only: no other file, no listing, no delete. The bucket
-- stays public, so the pictures are read without any policy. The link saved with the prize
-- / product / store ends with ?v=<time of the upload>, so browsers and the CDN show a new
-- picture at once.

-- ------------------------------------------------------------------ 1. tickets
create table if not exists public.upload_tickets (
  path text primary key,                     -- name inside the bucket: Prizes/Previews/12.jpg
  bucket text not null default 'IPTV',
  member_id text not null default '',        -- who asked (a member), or
  staff_id bigint,                           -- a staff member (Panel)
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists upload_tickets_expires_idx on public.upload_tickets (expires_at);
comment on table public.upload_tickets is
  'Pictures the browser may upload to Storage right now (sql/image_uploads.sql). Written by the server only.';
alter table public.upload_tickets enable row level security;
revoke all on public.upload_tickets from anon, authenticated;

-- Writes (or renews) the ticket of one file and forgets the tickets of yesterday.
create or replace function public._upload_ticket(p_path text, p_member text, p_staff bigint, p_minutes int default 15)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.upload_tickets where expires_at < now() - interval '1 day';
  insert into public.upload_tickets (path, bucket, member_id, staff_id, expires_at)
  values (p_path, 'IPTV', coalesce(p_member, ''), p_staff, now() + make_interval(mins => greatest(1, least(coalesce(p_minutes, 15), 60))))
  on conflict (path) do update
    set member_id = excluded.member_id, staff_id = excluded.staff_id, expires_at = excluded.expires_at, created_at = now();
end $$;

-- Storage policies: true while the file has a valid ticket.
create or replace function public.upload_ticket_ok(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(p_bucket = 'IPTV', false)
     and exists (select 1 from public.upload_tickets t
                 where t.path = p_name and t.bucket = p_bucket and t.expires_at > now())
$$;
comment on function public.upload_ticket_ok(text, text) is
  'Storage policies of the uploaded pictures: true while IPTV/<name> has a valid upload ticket (sql/image_uploads.sql)';

revoke all on function public._upload_ticket(text, text, bigint, int) from public, anon, authenticated;
revoke all on function public.upload_ticket_ok(text, text) from public;
grant execute on function public.upload_ticket_ok(text, text) to anon, authenticated, service_role;

drop policy if exists "CineAura pictures: read" on storage.objects;
create policy "CineAura pictures: read" on storage.objects
  for select to anon, authenticated
  using (public.upload_ticket_ok(bucket_id, name));

drop policy if exists "CineAura pictures: upload" on storage.objects;
create policy "CineAura pictures: upload" on storage.objects
  for insert to anon, authenticated
  with check (public.upload_ticket_ok(bucket_id, name));

drop policy if exists "CineAura pictures: replace" on storage.objects;
create policy "CineAura pictures: replace" on storage.objects
  for update to anon, authenticated
  using (public.upload_ticket_ok(bucket_id, name))
  with check (public.upload_ticket_ok(bucket_id, name));

-- A picture link saved with a prize, a group, a product or a store: http(s) only.
create or replace function public._image_url_ok(p_url text)
returns boolean language sql immutable as $$
  select coalesce(p_url ~* '^https?://[^\s<>"'']+$' and length(p_url) <= 1000, false)
$$;

-- ------------------------------------------------------------------ 2. prizes (Panel > Prizes)
-- The browser asks for the names it is going to upload, after the prize / group is saved:
--   kind 'prize': p_names = {'12', '12-1', '12-2'}   → Prizes/Previews/12.jpg …
--   kind 'group': p_names = {'7'}                     → Prizes/Grpoups/7.jpg
--   -> { ok: true, paths: [...] } | { ok: false, error: not_found | names }
create or replace function public.prize_admin_upload(p_token text, p_kind text, p_id bigint, p_names text[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.staff; nm text; paths text[] := '{}'; folder text;
begin
  s := public._staff_prizes(p_token);
  if p_kind = 'prize' then
    if not exists (select 1 from public.prizes where id = p_id) then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    folder := 'Prizes/Previews/';
  elsif p_kind = 'group' then
    if not exists (select 1 from public.prize_groups where id = p_id) then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    folder := 'Prizes/Grpoups/';
  else
    return jsonb_build_object('ok', false, 'error', 'kind');
  end if;
  if p_names is null or cardinality(p_names) = 0 or cardinality(p_names) > 12 then
    return jsonb_build_object('ok', false, 'error', 'names');
  end if;
  foreach nm in array p_names loop
    if nm is null or (p_kind = 'group' and nm <> p_id::text)
       or (p_kind = 'prize' and nm !~ ('^' || p_id::text || '(-[1-9][0-9]?)?$')) then
      return jsonb_build_object('ok', false, 'error', 'names');
    end if;
    perform public._upload_ticket(folder || nm || '.jpg', '', s.id);
    paths := paths || (folder || nm || '.jpg');
  end loop;
  return jsonb_build_object('ok', true, 'paths', to_jsonb(paths));
end $$;

-- The pictures of a prize once its uploads are done (links and uploaded files, in order).
--   -> { ok: true } | { ok: false, error: not_found | images }
create or replace function public.prize_admin_images(p_token text, p_id bigint, p_images jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare imgs text[];
begin
  perform public._staff_prizes(p_token);
  if not exists (select 1 from public.prizes where id = p_id) then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if jsonb_typeof(coalesce(p_images, '[]'::jsonb)) <> 'array' then return jsonb_build_object('ok', false, 'error', 'images'); end if;
  select coalesce(array_agg(btrim(x) order by n), '{}') into imgs
    from jsonb_array_elements_text(coalesce(p_images, '[]'::jsonb)) with ordinality as e(x, n)
   where btrim(x) <> '';
  if cardinality(imgs) > 20 or exists (select 1 from unnest(imgs) u where not public._image_url_ok(u)) then
    return jsonb_build_object('ok', false, 'error', 'images');
  end if;
  update public.prizes set prize_image = coalesce(imgs[1], ''), images = coalesce(array_to_string(imgs, E'\n'), '') where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- The picture of a prize group (an image link, or the uploaded Prizes/Grpoups/<id>.jpg).
-- The prizes of the group show it too (prizes.group_thumb).
--   -> { ok: true } | { ok: false, error: not_found | image }
create or replace function public.prize_admin_group_image(p_token text, p_id bigint, p_thumb text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v text := btrim(coalesce(p_thumb, ''));
begin
  perform public._staff_prizes(p_token);
  if not exists (select 1 from public.prize_groups where id = p_id) then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v <> '' and not public._image_url_ok(v) then return jsonb_build_object('ok', false, 'error', 'image'); end if;
  update public.prize_groups set thumb = v where id = p_id;
  update public.prizes set group_thumb = v where group_id = p_id;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.prize_admin_upload(text, text, bigint, text[]) from public;
revoke all on function public.prize_admin_images(text, bigint, jsonb) from public;
revoke all on function public.prize_admin_group_image(text, bigint, text) from public;
revoke all on function public._image_url_ok(text) from public, anon, authenticated;
grant execute on function public.prize_admin_upload(text, text, bigint, text[]) to anon, authenticated;
grant execute on function public.prize_admin_images(text, bigint, jsonb) to anon, authenticated;
grant execute on function public.prize_admin_group_image(text, bigint, text) to anon, authenticated;

notify pgrst, 'reload schema';
