-- Telegram support (kept for future integration; same AES-256-GCM scheme).

-- Encrypted Telegram API credentials (one row per user)
create table public.telegram_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  encrypted_api_id text not null,
  api_id_iv text not null,
  api_id_tag text not null,
  encrypted_api_hash text not null,
  api_hash_iv text not null,
  api_hash_tag text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);
create index idx_telegram_credentials_user on public.telegram_credentials(user_id);

-- Encrypted Telegram session strings (one row per session, like discord_tokens)
create table public.telegram_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  encrypted_session text not null,
  session_iv text not null,
  session_tag text not null,
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index idx_telegram_sessions_user on public.telegram_sessions(user_id);

alter table public.telegram_credentials enable row level security;
alter table public.telegram_sessions    enable row level security;

create policy "Users manage own telegram credentials" on public.telegram_credentials
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage own telegram sessions" on public.telegram_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create trigger telegram_credentials_updated_at before update on public.telegram_credentials
  for each row execute function public.update_updated_at();
