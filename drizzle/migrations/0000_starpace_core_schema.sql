-- ============ enums ============
create type public.app_role as enum ('user','moderator','admin');

-- ============ core identity ============
create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete cascade,
  username text not null unique,
  display_name text not null,
  avatar_url text,
  bio text not null default '',
  location text not null default '',
  website text not null default '',
  plan text not null default 'free',
  status text not null default 'active',
  verified boolean not null default false,
  followers integer not null default 0,
  following integer not null default 0,
  warning_count integer not null default 0,
  last_active timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

create or replace function public.current_profile_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.profiles where auth_user_id = auth.uid()
$$;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role(auth.uid(),'admin') or public.has_role(auth.uid(),'moderator')
$$;

create or replace function public.owns_profile(_profile_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = _profile_id and p.auth_user_id = auth.uid())
$$;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ============ content ============
create table public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  content text not null,
  media_url text,
  image_gradient text,
  poll jsonb,
  tags jsonb not null default '[]'::jsonb,
  like_count integer not null default 0,
  comment_count integer not null default 0,
  repost_count integer not null default 0,
  view_count integer not null default 0,
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create index posts_created_idx on public.posts (created_at desc);
create index posts_user_idx on public.posts (user_id);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);
create index comments_post_idx on public.comments (post_id);

create table public.likes (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table public.reposts (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table public.bookmarks (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table public.poll_votes (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  option_id text not null,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table public.post_impressions (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index post_impressions_post_idx on public.post_impressions (post_id);

create table public.follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  target_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, target_id)
);

create table public.stories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null default 'text',
  text text,
  caption text,
  media_url text,
  gradient text,
  mood text,
  location text,
  stickers jsonb not null default '[]'::jsonb,
  likes_count integer not null default 0,
  view_count integer not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);
create index stories_expires_idx on public.stories (expires_at desc);

create table public.story_likes (
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (story_id, user_id)
);

-- ============ spaces ============
create table public.spaces (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  topic text not null default '',
  gradient text not null default 'from-violet-500 to-fuchsia-500',
  live boolean not null default false,
  recorded boolean not null default false,
  recording_url text,
  listeners integer not null default 0,
  duration text,
  starts_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.space_participants (
  space_id uuid not null references public.spaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'listener',
  is_muted boolean not null default true,
  is_speaking boolean not null default false,
  hand_raised boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (space_id, user_id)
);

create table public.space_messages (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);
create index space_messages_space_idx on public.space_messages (space_id, created_at);

-- ============ messaging ============
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_a uuid not null references public.profiles(id) on delete cascade,
  user_b uuid not null references public.profiles(id) on delete cascade,
  preview text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_a, user_b)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  media_url text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index messages_conversation_idx on public.messages (conversation_id, created_at);

create table public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create table public.calls (
  id uuid primary key default gen_random_uuid(),
  caller_id uuid not null references public.profiles(id) on delete cascade,
  callee_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null default 'audio',
  status text not null default 'ringing',
  duration_seconds integer not null default 0,
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  type text not null,
  body text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index notifications_recipient_idx on public.notifications (recipient_id, created_at desc);

-- ============ monetization ============
create table public.monetization_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  tips_enabled boolean not null default true,
  subscriptions_enabled boolean not null default false,
  min_tip numeric not null default 1,
  payout_method text not null default 'paystack',
  bank_details jsonb not null default '{}'::jsonb,
  crypto_details jsonb not null default '{}'::jsonb,
  paystack_details jsonb not null default '{}'::jsonb,
  stripe_details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tips (
  id uuid primary key default gen_random_uuid(),
  from_user_id uuid not null references public.profiles(id) on delete cascade,
  to_user_id uuid not null references public.profiles(id) on delete cascade,
  post_id uuid references public.posts(id) on delete set null,
  amount numeric not null,
  currency text not null default 'NGN',
  message text not null default '',
  created_at timestamptz not null default now()
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  reference text not null unique,
  provider text not null default 'paystack',
  plan text not null,
  billing_cycle text not null default 'monthly',
  amount numeric not null,
  currency text not null default 'NGN',
  status text not null default 'pending',
  email text,
  authorization_url text,
  raw jsonb not null default '{}'::jsonb,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.payouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount numeric not null,
  currency text not null default 'NGN',
  method text not null default 'paystack',
  status text not null default 'pending',
  destination text,
  reference text,
  recipient_code text,
  transfer_code text,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.subscriptions (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  plan text not null default 'free',
  status text not null default 'active',
  provider text not null default 'paystack',
  billing_cycle text not null default 'monthly',
  provider_customer_id text,
  provider_subscription_id text,
  payment_method jsonb not null default '{}'::jsonb,
  ai_drafts_used integer not null default 0,
  ai_usage_date date not null default current_date,
  renews_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============ preferences / branding ============
create table public.user_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  theme text not null default 'dark',
  accent text not null default 'violet',
  reduce_motion boolean not null default false,
  larger_text boolean not null default false,
  prefs jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.feed_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  prefs jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.branding_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  theme text not null default 'aurora',
  tagline text not null default '',
  post_aura boolean not null default false,
  updated_at timestamptz not null default now()
);

-- ============ moderation / admin ============
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reporter_name text not null default '',
  target_type text not null,
  target_id text not null,
  target_preview text,
  author_id uuid references public.profiles(id) on delete set null,
  author_name text,
  reason text not null,
  details text not null default '',
  status text not null default 'pending',
  action_taken text,
  created_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  actor_name text not null default '',
  actor_role text not null default '',
  action text not null,
  target_type text not null default '',
  target_id text not null default '',
  details text not null default '',
  severity text not null default 'info',
  ip_address text not null default '',
  created_at timestamptz not null default now()
);
create index audit_logs_created_idx on public.audit_logs (created_at desc);

create table public.system_settings (
  id integer primary key default 1,
  maintenance_mode boolean not null default false,
  registration_enabled boolean not null default true,
  stories_enabled boolean not null default true,
  spaces_audio_enabled boolean not null default true,
  ai_generation_enabled boolean not null default true,
  auto_mod_strictness text not null default 'medium',
  max_upload_size_mb integer not null default 25,
  rate_limit_requests_per_min integer not null default 120,
  announcement_banner jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint system_settings_singleton check (id = 1)
);
insert into public.system_settings (id) values (1);

-- ============ support ============
create table public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  subject text not null,
  body text not null default '',
  category text not null default 'general',
  priority text not null default 'normal',
  status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.support_ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  body text not null,
  from_support boolean not null default false,
  created_at timestamptz not null default now()
);

-- ============ developer / workspaces ============
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  prefix text not null,
  key_hash text not null,
  scopes jsonb not null default '[]'::jsonb,
  call_count integer not null default 0,
  revoked boolean not null default false,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.webhooks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  url text not null,
  events jsonb not null default '[]'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  logo_emoji text not null default 'x',
  plan text not null default 'free',
  seats_total integer not null default 3,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  email text not null,
  name text not null default '',
  role text not null default 'member',
  status text not null default 'invited',
  created_at timestamptz not null default now()
);

create or replace function public.is_workspace_member(_workspace_id uuid, _profile_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.workspaces w where w.id = _workspace_id and w.owner_id = _profile_id
  ) or exists (
    select 1 from public.workspace_members m where m.workspace_id = _workspace_id and m.user_id = _profile_id
  )
$$;

-- ============ updated_at triggers ============
create trigger t_profiles_updated before update on public.profiles for each row execute function public.set_updated_at();
create trigger t_conversations_updated before update on public.conversations for each row execute function public.set_updated_at();
create trigger t_payments_updated before update on public.payments for each row execute function public.set_updated_at();
create trigger t_payouts_updated before update on public.payouts for each row execute function public.set_updated_at();
create trigger t_subscriptions_updated before update on public.subscriptions for each row execute function public.set_updated_at();
create trigger t_monetization_updated before update on public.monetization_settings for each row execute function public.set_updated_at();
create trigger t_workspaces_updated before update on public.workspaces for each row execute function public.set_updated_at();
create trigger t_tickets_updated before update on public.support_tickets for each row execute function public.set_updated_at();

-- ============ profile auto-provision ============
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare base text; candidate text; n integer := 0;
begin
  base := lower(regexp_replace(coalesce(new.raw_user_meta_data->>'username', split_part(new.email,'@',1), 'user'), '[^a-z0-9_]', '', 'g'));
  if base = '' then base := 'user'; end if;
  candidate := base;
  while exists (select 1 from public.profiles where username = candidate) loop
    n := n + 1; candidate := base || n::text;
  end loop;
  insert into public.profiles (auth_user_id, username, display_name, avatar_url)
  values (new.id, candidate,
          coalesce(new.raw_user_meta_data->>'display_name', new.raw_user_meta_data->>'full_name', candidate),
          new.raw_user_meta_data->>'avatar_url');
  insert into public.user_roles (user_id, role) values (new.id, 'user') on conflict do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();