-- ezome: Supabase sxemasi (yakuniy holat). Barcha hujjatlar bitta jadvalda: kolleksiya + id + JSON.
create table if not exists public.docs (
  col text not null, id text not null, data jsonb not null default '{}'::jsonb,
  uid text, ts bigint, updated_at timestamptz not null default now(),
  primary key (col, id),
  constraint docs_col_chk check (col in ('users','settings','products','sales','log','customers','debts','reports','paynet_orders','payments','meta','private'))
);
create index if not exists docs_col_ts on public.docs (col, ts desc);
create index if not exists docs_col_uid_ts on public.docs (col, uid, ts desc);

create or replace function public.docs_fill() returns trigger language plpgsql set search_path = '' as $$
begin
  new.ts := coalesce(nullif(new.data->>'createdAt','')::bigint, nullif(new.data->>'t','')::bigint);
  new.uid := case new.col when 'sales' then new.data->>'sellerUid' when 'log' then new.data->>'uid'
    when 'reports' then new.data->>'uid' when 'paynet_orders' then new.data->>'by' else null end;
  new.updated_at := now(); return new;
end $$;
create trigger docs_fill before insert or update on public.docs for each row execute function public.docs_fill();

create schema if not exists ezp;
grant usage on schema ezp to authenticated;
create or replace function ezp.my_role() returns text language sql stable security definer set search_path = '' as $$
  select d.data->>'role' from public.docs d where d.col = 'users' and d.id = (select auth.uid())::text
    and coalesce((d.data->>'disabled')::boolean, false) = false $$;
create or replace function ezp.is_admin() returns boolean language sql stable security definer set search_path = '' as $$ select coalesce(ezp.my_role() = 'admin', false) $$;
create or replace function ezp.is_active() returns boolean language sql stable security definer set search_path = '' as $$ select ezp.my_role() is not null $$;
revoke all on function ezp.my_role(), ezp.is_admin(), ezp.is_active() from public, anon;
grant execute on function ezp.my_role(), ezp.is_admin(), ezp.is_active() to authenticated;

alter table public.docs enable row level security;
create policy docs_select on public.docs for select to authenticated using (
  case col
    when 'users' then (select ezp.is_admin()) or id = (select auth.uid())::text
    when 'sales' then (select ezp.is_admin()) or ((select ezp.is_active()) and uid = (select auth.uid())::text)
    when 'log' then (select ezp.is_admin()) or ((select ezp.is_active()) and uid = (select auth.uid())::text)
    when 'reports' then (select ezp.is_admin()) or ((select ezp.is_active()) and uid = (select auth.uid())::text)
    when 'paynet_orders' then (select ezp.is_admin()) or ((select ezp.is_active()) and uid = (select auth.uid())::text)
    when 'payments' then (select ezp.is_admin())
    when 'private' then false
    else (select ezp.is_active()) end);
create policy docs_insert on public.docs for insert to authenticated with check (
  case col
    when 'users' then (select ezp.is_admin())
    when 'settings' then (select ezp.is_admin())
    when 'products' then (select ezp.is_admin())
    when 'sales' then (select ezp.is_active()) and uid = (select auth.uid())::text and data->'paynet' is null and data->'ok' is null
    when 'log' then (select ezp.is_active()) and uid = (select auth.uid())::text
    when 'reports' then (select ezp.is_admin()) or ((select ezp.is_active()) and uid = (select auth.uid())::text)
    when 'customers' then (select ezp.is_active())
    when 'debts' then (select ezp.is_active())
    when 'paynet_orders' then (select ezp.is_active()) and uid = (select auth.uid())::text and data->>'status' = 'pending'
    else false end);
create policy docs_update on public.docs for update to authenticated
using (case col
    when 'products' then (select ezp.is_active())
    when 'reports' then (select ezp.is_admin()) or ((select ezp.is_active()) and uid = (select auth.uid())::text)
    when 'paynet_orders' then (select ezp.is_admin()) or ((select ezp.is_active()) and uid = (select auth.uid())::text)
    when 'payments' then false when 'private' then false when 'meta' then false
    else (select ezp.is_admin()) end)
with check (case col
    when 'products' then (select ezp.is_active())
    when 'reports' then (select ezp.is_admin()) or ((select ezp.is_active()) and uid = (select auth.uid())::text)
    when 'paynet_orders' then (select ezp.is_admin()) or ((select ezp.is_active()) and uid = (select auth.uid())::text)
    when 'payments' then false when 'private' then false when 'meta' then false
    else (select ezp.is_admin()) end);
create policy docs_delete on public.docs for delete to authenticated using (
  col not in ('payments','private','meta','users') and (select ezp.is_admin()));

-- Ishchi tovarda faqat qoldiqni o'zgartiradi; Paynet buyurtmasini faqat bekor qiladi
create or replace function public.docs_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if (select auth.role()) = 'service_role' or current_user in ('postgres','supabase_admin') or ezp.is_admin() then return new; end if;
  if new.col = 'products' then
    if (new.data - 'qty' - 'sizes' - 'updatedAt') is distinct from (old.data - 'qty' - 'sizes' - 'updatedAt') then
      raise exception 'Ishchi faqat qoldiqni o''zgartira oladi' using errcode = '42501'; end if;
    if jsonb_typeof(new.data->'sizes') = 'array' and jsonb_typeof(old.data->'sizes') = 'array' and
       (select coalesce(jsonb_agg(e - 'q' order by ord), '[]') from jsonb_array_elements(new.data->'sizes') with ordinality as t(e, ord)) is distinct from
       (select coalesce(jsonb_agg(e - 'q' order by ord), '[]') from jsonb_array_elements(old.data->'sizes') with ordinality as t(e, ord)) then
      raise exception 'Ishchi o''lchamlarni o''zgartira olmaydi' using errcode = '42501'; end if;
  elsif new.col = 'paynet_orders' then
    if not (old.data->>'status' = 'pending' and new.data->>'status' = 'cancelled'
            and (new.data - 'status' - 'cancelledAt') = (old.data - 'status' - 'cancelledAt')) then
      raise exception 'Buyurtmani faqat bekor qilish mumkin' using errcode = '42501'; end if;
  elsif new.col = 'reports' then
    if old.uid is distinct from new.uid then raise exception 'Ruxsat yo''q' using errcode = '42501'; end if;
  end if;
  return new;
end $$;
create trigger docs_guard before update on public.docs for each row execute function public.docs_guard();

create or replace function public.put_doc(p_col text, p_id text, p_data jsonb) returns void language plpgsql security invoker set search_path = '' as $$
begin
  update public.docs set data = p_data where col = p_col and id = p_id;
  if not found then insert into public.docs (col, id, data) values (p_col, p_id, p_data); end if;
end $$;
create or replace function public.next_no() returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if not ezp.is_active() then raise exception 'Ruxsat yo''q' using errcode = '42501'; end if;
  insert into public.docs (col, id, data) values ('meta', 'counter', '{"no":1001}')
  on conflict (col, id) do update set data = jsonb_build_object('no', coalesce((public.docs.data->>'no')::int, 1000) + 1)
  returning (data->>'no')::int into n;
  return n;
end $$;
create or replace function public.set_counter(p_no integer) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not ezp.is_admin() then raise exception 'Ruxsat yo''q' using errcode = '42501'; end if;
  insert into public.docs (col, id, data) values ('meta', 'counter', jsonb_build_object('no', p_no))
  on conflict (col, id) do update set data = jsonb_build_object('no', greatest(p_no, coalesce((public.docs.data->>'no')::int, 0)));
end $$;
revoke all on function public.next_no(), public.set_counter(integer), public.put_doc(text, text, jsonb) from public, anon;
grant execute on function public.next_no(), public.set_counter(integer), public.put_doc(text, text, jsonb) to authenticated;
revoke all on function public.docs_fill(), public.docs_guard() from public, anon, authenticated;

alter publication supabase_realtime add table public.docs;

-- Rasmlar
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('img', 'img', true, 3145728, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = 3145728, allowed_mime_types = array['image/jpeg','image/png','image/webp'];
create policy img_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'img' and (storage.foldername(name))[1] = (select auth.uid())::text and (select ezp.is_active()));
create policy img_delete on storage.objects for delete to authenticated using (bucket_id = 'img' and (select ezp.is_admin()));
