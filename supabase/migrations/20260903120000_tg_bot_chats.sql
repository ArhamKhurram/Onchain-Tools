-- tg_bot_chats — per-chat tenancy for the OCT Telegram bot (backend/src/tgbot/).
--
-- WHY THIS TABLE EXISTS
--
-- Every other OCT ingestion path is keyed by an OCT user: you hand over a
-- Discord token or a Telegram session string and the app reads YOUR chats as
-- YOU. That credential handover is the product's single biggest activation
-- blocker ("my main problem is that you have to connect ur tg and discord — i
-- just dont rly trust"). A @BotFather bot added to a group removes it: the bot
-- holds its own token, sees only what is addressed to it, and never touches a
-- user account.
--
-- So the tenant here is A CHAT, not a user. This table is the roster of chats
-- the bot serves, and it is the only per-chat state that survives a restart.
--
-- COLUMN NOTES
--
--  * chat_id — Telegram's own id, and the primary key. Negative for groups and
--    supergroups (-100…), positive for private chats, and comfortably inside
--    bigint. Telegram never reissues one, so it is a stable natural key.
--
--  * source_user_id — WHOSE alerts this chat receives. Alerts in hosted mode
--    are per-OCT-user (WsServer.broadcastAlert carries a userId), and a group
--    chat is not an OCT user, so without this column a group would either get
--    nothing or get everyone's feed. Null means "fall back to the instance
--    default" (TG_BOT_ALERT_SOURCE_USER_ID, or 'local' in local mode); when
--    neither resolves the chat still gets commands but no alerts, which is the
--    fail-closed direction. There is no console UI writing this yet — it is the
--    seam a future "link this chat to my OCT account" flow fills in.
--
--  * settings — per-chat alert prefs, JSONB so a new toggle is a code change
--    rather than a migration. Shape lives in backend/src/tgbot/chatStore.ts
--    (TgChatSettings); an absent key reads as its default, so nobody starts
--    receiving something new because of a deploy.
--
--  * plan / entitlements — the seam for a future paid tier, deliberately left
--    in place and deliberately NOT wired to anything. Nothing in the backend
--    reads them today beyond echoing plan in /status. Adding them now means
--    feature gating can slot in without a migration on a live table; adding
--    billing is out of scope and none exists.
--
-- TRUST MODEL: service-role only. RLS is enabled with no policies, so the
-- anon/authenticated roles can read nothing — the backend's service client is
-- the only reader and writer (same posture as revival_alerts and the fomo_*
-- tables). Nothing in the console touches this table.

create table public.tg_bot_chats (
  chat_id             bigint primary key,
  chat_type           text not null,
  title               text,
  added_by_tg_user_id bigint,
  enabled             boolean not null default true,
  -- Which OCT user's alerts flow into this chat; null = instance default.
  source_user_id      uuid references auth.users(id) on delete set null,
  settings            jsonb not null default '{}'::jsonb,
  -- Future paid tier. Nothing gates on these yet — see the header note.
  plan                text not null default 'free',
  entitlements        jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- The alert fan-out's only query: every enabled chat, newest registration
-- first. A partial index keeps disabled rows out of it entirely, so the sweep
-- reads exactly the rows it will send to.
create index idx_tg_bot_chats_enabled
  on public.tg_bot_chats (created_at desc)
  where enabled;

create trigger tg_bot_chats_updated_at
  before update on public.tg_bot_chats
  for each row execute function public.update_updated_at();

alter table public.tg_bot_chats enable row level security;
-- No policies by design: backend service role only (bypasses RLS).

comment on table public.tg_bot_chats is
  'Chats the OCT Telegram bot serves. The tenant is the chat, not an OCT user — no Telegram credential is ever handed over. Service-role only.';
comment on column public.tg_bot_chats.source_user_id is
  'Whose OCT alerts this chat receives; null falls back to TG_BOT_ALERT_SOURCE_USER_ID (or ''local'' in local mode). Seam for a future chat-linking flow.';
comment on column public.tg_bot_chats.plan is
  'Future paid tier. Nothing gates on this today — left in place so feature gating needs no migration.';
comment on column public.tg_bot_chats.entitlements is
  'Future per-chat feature grants. Unread today; see plan.';
