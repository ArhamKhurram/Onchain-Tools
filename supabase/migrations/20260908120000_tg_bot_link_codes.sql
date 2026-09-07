-- tg_bot_link_codes — the short-lived credential that binds a Telegram chat to
-- an OCT account (backend/src/tgbot/linkCodes.ts).
--
-- UNAPPLIED AS SHIPPED. Apply it to prod (vmlxyqzjdaegkfylxfka) before the
-- linking flow can work in hosted mode; local/desktop mode holds codes in
-- process memory and needs nothing here. Until it is applied, minting answers
-- "could not generate a link code" and redeeming answers "linking is
-- unavailable" — no silent half-binding either way.
--
-- WHY A TABLE AND NOT A MAP. `tg_bot_chats.source_user_id` shipped with the
-- roster and its own comment called it "the seam a future 'link this chat to my
-- OCT account' flow fills in". This is that flow's transient half. It lives in
-- the database rather than in process memory so the mint (an authenticated
-- console request) and the redeem (a Telegram message) do not have to land on
-- the same Railway replica, and so a deploy mid-flow does not eat somebody's
-- code.
--
-- WHAT A ROW IS. A ten-minute, single-use bearer credential for ONE OCT
-- account. Therefore:
--
--  * code_hash is the PRIMARY KEY and it is a SHA-256 HEX DIGEST, never the
--    code. Reading this table gives you nothing you can redeem — you would
--    need the preimage, and the plaintext exists only in the one HTTP response
--    that minted it.
--
--  * consumed_at is what makes it single-use, and it is enforced by the
--    UPDATE … WHERE consumed_at IS NULL … RETURNING in SupabaseLinkCodeBackend
--    rather than by a read-then-write. Two people redeeming the same code in
--    the same second are serialized by Postgres and exactly one wins.
--
--  * expires_at is checked in the same statement. An expired row is not an
--    error to clean up before it is safe; it is already unredeemable.
--
--  * user_id cascades on delete: a deleted account's outstanding codes must not
--    outlive it, or a redemption would bind a chat to nothing.
--
-- RETENTION. Rows are tiny and self-expiring; nothing reads a consumed or
-- expired one. Sweep them whenever convenient:
--   delete from public.tg_bot_link_codes where expires_at < now() - interval '1 day';
--
-- TRUST MODEL: service-role only, same as tg_bot_chats. RLS is on with NO
-- policies, so anon and authenticated can read nothing — which matters more
-- here than anywhere else in the schema, because a readable row plus a weak
-- hash would be a way to bind somebody else's chat.

create table public.tg_bot_link_codes (
  -- SHA-256 hex of the canonical code. Never the code itself.
  code_hash   text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  -- Null until redeemed. The single-use guarantee is a conditional UPDATE on
  -- this column, not an application-side check.
  consumed_at timestamptz
);

-- The minting budget's only query: "how many has this account made lately?".
create index idx_tg_bot_link_codes_user_created
  on public.tg_bot_link_codes (user_id, created_at desc);

-- Supports the retention sweep. Redemption goes straight to the primary key.
create index idx_tg_bot_link_codes_expires
  on public.tg_bot_link_codes (expires_at);

alter table public.tg_bot_link_codes enable row level security;
-- No policies by design: backend service role only (bypasses RLS).

comment on table public.tg_bot_link_codes is
  'Short-lived single-use codes that bind a Telegram chat to an OCT account. Only the SHA-256 of each code is stored. Service-role only.';
comment on column public.tg_bot_link_codes.code_hash is
  'SHA-256 hex of the canonical code. The plaintext exists only in the response that minted it and is never logged.';
comment on column public.tg_bot_link_codes.consumed_at is
  'Set by the redeeming UPDATE. Single use is enforced by that statement''s WHERE consumed_at IS NULL, not by an application check.';
