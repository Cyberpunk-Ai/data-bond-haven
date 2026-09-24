-- Real developer API: hashed keys, request log for rate limiting, signed webhooks with a delivery queue.
alter table public.api_keys add column if not exists last4 text not null default '';
alter table public.api_keys add column if not exists rate_limit_per_minute integer not null default 60;
create unique index if not exists api_keys_hash_idx on public.api_keys (key_hash);

-- Clients may read/revoke their keys but never write the hash directly.
drop policy if exists "api keys owner all" on public.api_keys;
create policy "api keys owner read" on public.api_keys for select to authenticated
  using (user_id in (select id from public.profiles where auth_user_id = auth.uid()));
create policy "api keys owner delete" on public.api_keys for delete to authenticated
  using (user_id in (select id from public.profiles where auth_user_id = auth.uid()));
create policy "api keys owner revoke" on public.api_keys for update to authenticated
  using (user_id in (select id from public.profiles where auth_user_id = auth.uid()))
  with check (user_id in (select id from public.profiles where auth_user_id = auth.uid()));

create table if not exists public.api_requests (
  id bigint generated always as identity primary key,
  key_id uuid not null references public.api_keys(id) on delete cascade,
  path text not null,
  status integer not null,
  created_at timestamptz not null default now()
);
create index if not exists api_requests_key_time_idx on public.api_requests (key_id, created_at desc);
grant select on public.api_requests to authenticated;
grant all on public.api_requests to service_role;
alter table public.api_requests enable row level security;
create policy "api requests owner read" on public.api_requests for select to authenticated
  using (key_id in (select k.id from public.api_keys k join public.profiles p on p.id = k.user_id where p.auth_user_id = auth.uid()));

alter table public.webhooks add column if not exists secret text not null default encode(gen_random_bytes(24), 'hex');
alter table public.webhooks add column if not exists description text not null default '';

create table if not exists public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  webhook_id uuid not null references public.webhooks(id) on delete cascade,
  event text not null,
  payload jsonb not null,
  status text not null default 'pending', -- pending | delivered | failed
  attempts integer not null default 0,
  response_status integer,
  next_attempt_at timestamptz not null default now(),
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists webhook_deliveries_due_idx on public.webhook_deliveries (status, next_attempt_at);
grant select on public.webhook_deliveries to authenticated;
grant all on public.webhook_deliveries to service_role;
alter table public.webhook_deliveries enable row level security;
create policy "deliveries owner read" on public.webhook_deliveries for select to authenticated
  using (webhook_id in (select w.id from public.webhooks w join public.profiles p on p.id = w.user_id where p.auth_user_id = auth.uid()));

-- Enqueue an event for every active webhook of a profile that subscribed to it.
create or replace function public.enqueue_webhook_event(_profile uuid, _event text, _payload jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.webhook_deliveries (webhook_id, event, payload)
  select w.id, _event, jsonb_build_object('event', _event, 'created_at', now(), 'data', _payload)
  from public.webhooks w
  where w.user_id = _profile and w.active
    and (w.events ? _event or w.events ? '*' or jsonb_array_length(w.events) = 0);
$$;
revoke execute on function public.enqueue_webhook_event(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.trg_post_webhook() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.enqueue_webhook_event(new.user_id, 'post.created',
    jsonb_build_object('id', new.id, 'content', new.content, 'created_at', new.created_at));
  return new;
end $$;
drop trigger if exists t_post_webhook on public.posts;
create trigger t_post_webhook after insert on public.posts for each row execute function public.trg_post_webhook();

create or replace function public.trg_follow_webhook() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.enqueue_webhook_event(new.target_id, 'follower.new',
    jsonb_build_object('follower_id', new.follower_id, 'created_at', now()));
  return new;
end $$;
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='follows' and column_name='target_id') then
    drop trigger if exists t_follow_webhook on public.follows;
    create trigger t_follow_webhook after insert on public.follows for each row execute function public.trg_follow_webhook();
  end if;
end $$;
