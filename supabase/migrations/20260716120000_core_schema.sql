-- onchain-tools core schema (multi-tenant, RLS-isolated)
-- Adapted from Trenchcord hosted mode. Option B: highlighted_users and
-- keywords are normalized into their own user-scoped tables (instead of
-- rooms.highlighted_users[] / rooms.keyword_patterns JSONB).

-- ---------------------------------------------------------------------------
-- updated_at trigger helper
-- ---------------------------------------------------------------------------
create or replace function public.update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- user_configs: misc per-user settings JSONB (mirrors AppConfig minus tokens,
-- rooms, highlighted users and keywords which are now their own tables)
-- ---------------------------------------------------------------------------
create table public.user_configs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

-- ---------------------------------------------------------------------------
-- discord_tokens: AES-256-GCM encrypted at rest (scheme unchanged)
-- ---------------------------------------------------------------------------
create table public.discord_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  encrypted_token text not null,   -- base64 ciphertext
  token_iv text not null,          -- base64 16-byte IV
  token_tag text not null,         -- base64 16-byte GCM auth tag
  token_mask text not null,        -- masked value for UI
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index idx_discord_tokens_user on public.discord_tokens(user_id);

-- ---------------------------------------------------------------------------
-- rooms (highlighted users + keywords normalized out into their own tables)
-- ---------------------------------------------------------------------------
create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  color text,
  filtered_users text[] not null default '{}',    -- low-churn, kept inline
  filter_enabled boolean not null default false,
  highlight_mode text not null default 'background',
  position int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_rooms_user on public.rooms(user_id);

-- ---------------------------------------------------------------------------
-- room_channels (source column included from the start)
-- ---------------------------------------------------------------------------
create table public.room_channels (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,  -- denormalized for RLS
  source text not null default 'discord',
  guild_id text,
  channel_id text not null,
  guild_name text,
  channel_name text,
  disable_embeds boolean not null default false
);
create index idx_room_channels_room on public.room_channels(room_id);
create index idx_room_channels_user on public.room_channels(user_id);
create index idx_room_channels_channel on public.room_channels(channel_id);
create index idx_room_channels_source on public.room_channels(source);

-- ---------------------------------------------------------------------------
-- highlighted_users (NEW normalized table). room_id null = global highlight.
-- ---------------------------------------------------------------------------
create table public.highlighted_users (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  room_id uuid references public.rooms(id) on delete cascade,   -- null = global
  match_type text not null default 'user_id' check (match_type in ('user_id','username')),
  value text not null,          -- discord user id, or username without leading @
  color text,
  created_at timestamptz not null default now(),
  unique (user_id, room_id, match_type, value)
);
create index idx_highlighted_users_user on public.highlighted_users(user_id);
create index idx_highlighted_users_room on public.highlighted_users(room_id);

-- ---------------------------------------------------------------------------
-- keywords (NEW normalized table). room_id null = global keyword.
-- ---------------------------------------------------------------------------
create table public.keywords (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  room_id uuid references public.rooms(id) on delete cascade,   -- null = global
  pattern text not null,
  match_mode text not null default 'includes' check (match_mode in ('includes','exact','regex')),
  label text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, room_id, pattern, match_mode)
);
create index idx_keywords_user on public.keywords(user_id);
create index idx_keywords_room on public.keywords(room_id);

-- ---------------------------------------------------------------------------
-- contracts (unchanged from Trenchcord; RAG/calls feature builds on this later)
-- ---------------------------------------------------------------------------
create table public.contracts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  address text not null,
  chain text not null,
  evm_chain text,
  author_id text not null,
  author_name text not null,
  channel_id text not null,
  channel_name text not null,
  guild_id text,
  guild_name text,
  room_ids text[] not null default '{}',
  message_id text not null,
  timestamp timestamptz not null,
  first_seen boolean not null default false,
  created_at timestamptz not null default now()
);
create index idx_contracts_user on public.contracts(user_id);
create index idx_contracts_address on public.contracts(address);
create index idx_contracts_timestamp on public.contracts(user_id, timestamp desc);

-- ---------------------------------------------------------------------------
-- user_sounds (Supabase Storage references)
-- ---------------------------------------------------------------------------
create table public.user_sounds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sound_type text not null,
  channel_id text,
  storage_path text not null,
  created_at timestamptz not null default now()
);
create index idx_user_sounds_user on public.user_sounds(user_id);

-- ---------------------------------------------------------------------------
-- Row Level Security: every tenant table scoped to auth.uid() = user_id
-- ---------------------------------------------------------------------------
alter table public.user_configs      enable row level security;
alter table public.discord_tokens    enable row level security;
alter table public.rooms             enable row level security;
alter table public.room_channels     enable row level security;
alter table public.highlighted_users enable row level security;
alter table public.keywords          enable row level security;
alter table public.contracts         enable row level security;
alter table public.user_sounds       enable row level security;

create policy "Users manage own config" on public.user_configs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage own tokens" on public.discord_tokens
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage own rooms" on public.rooms
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage own room channels" on public.room_channels
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage own highlighted users" on public.highlighted_users
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage own keywords" on public.keywords
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage own contracts" on public.contracts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage own sounds" on public.user_sounds
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create trigger user_configs_updated_at before update on public.user_configs
  for each row execute function public.update_updated_at();
create trigger rooms_updated_at before update on public.rooms
  for each row execute function public.update_updated_at();
