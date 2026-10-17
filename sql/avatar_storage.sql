-- CineAura profile pictures in Supabase Storage
-- Run this in the Supabase SQL editor (safe to run more than once), after members.sql.
--
-- Members upload their picture from Dashboard > Settings > Profile, from the
-- Settings of their profile page and from the activation page. The browser crops
-- it to a square JPEG (512 x 512 at most) and uploads it with the public key to
--
--   bucket IPTV, folder Avatar, file <member id>.jpg      e.g. IPTV/Avatar/ID1234.jpg
--
-- with x-upsert, so a new picture replaces the old one under the same name.
-- profiles.avatar_url then holds its public link plus ?v=<time of the upload>, so
-- browsers and the Storage CDN show the new picture at once. A picture can still
-- be an image link instead (anything typed in the field).
--
-- The bucket stays public, as it is for the M3U lists: public links are read
-- without any policy. Storage refuses every upload that no policy allows, and an
-- upload with x-upsert needs INSERT, SELECT and UPDATE on storage.objects, so the
-- three policies below allow exactly that, and only for Avatar/<id>.jpg of an
-- active member: no other folder or name, no listing of other files, no delete.
--
-- NOT covered here: members sign in with the custom login, so it is the browser
-- that says which member it is (as for every other member write of the site).
-- Someone who knows a member id could replace that member's picture, the same way
-- profiles.avatar_url can be changed through the public API today.

-- The name of an avatar file: Avatar/ID<digits>.jpg of an active member.
create or replace function public.avatar_object_ok(p_bucket text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p_bucket = 'IPTV', false)
     and coalesce(p_name ~ '^Avatar/ID[0-9]{1,20}\.jpg$', false)
     and exists (
       select 1 from public.members m
        where m.member_id = substring(p_name from '^Avatar/(ID[0-9]{1,20})\.jpg$')
          and coalesce(m.status, 'active') = 'active'
     )
$$;

comment on function public.avatar_object_ok(text, text) is
  'Storage policies of the profile pictures: true for IPTV / Avatar/<member id>.jpg of an active member';

revoke all on function public.avatar_object_ok(text, text) from public;
grant execute on function public.avatar_object_ok(text, text) to anon, authenticated, service_role;

drop policy if exists "CineAura avatars: read" on storage.objects;
create policy "CineAura avatars: read" on storage.objects
  for select to anon, authenticated
  using (public.avatar_object_ok(bucket_id, name));

drop policy if exists "CineAura avatars: upload" on storage.objects;
create policy "CineAura avatars: upload" on storage.objects
  for insert to anon, authenticated
  with check (public.avatar_object_ok(bucket_id, name));

drop policy if exists "CineAura avatars: replace" on storage.objects;
create policy "CineAura avatars: replace" on storage.objects
  for update to anon, authenticated
  using (public.avatar_object_ok(bucket_id, name))
  with check (public.avatar_object_ok(bucket_id, name));
