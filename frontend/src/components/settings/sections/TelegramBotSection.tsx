import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, Copy, Check, KeyRound } from 'lucide-react';
import {
  Help,
  SectionHeader,
  SectionStack,
  SettingsCard,
  StatusBox,
  apiBase,
  authedFetch,
} from '../fields';

/**
 * Linking a Telegram chat to this OCT account.
 *
 * WHAT THIS SECTION IS FOR. The bot's chat roster has always carried a
 * `source_user_id` — "whose alerts does this chat receive" — and nothing ever
 * wrote it, so every chat's panel permanently read "no alert source bound yet"
 * and per-user filters could not apply to any chat. This is the write: the
 * console proves the ACCOUNT, the Telegram message proves the CHAT, and the
 * code is what carries the first proof to the second.
 *
 * THE CODE IS A CREDENTIAL AND IS TREATED LIKE ONE. It is minted for the
 * authenticated user and nobody else, it is shown exactly once (there is no
 * endpoint that reads it back — only its hash is stored), it works once, and it
 * expires in minutes. The countdown is not decoration: it is the honest
 * statement of how long the thing on screen is dangerous for.
 *
 * WHY IT OWNS ITS STATE, like McapAlertsSection. Nothing here is part of
 * `AppConfig`, there is no Save button to hang it off, and the one action is a
 * POST whose response is deliberately not persisted anywhere in the client.
 */

interface Minted {
  code: string;
  expiresAt: number;
  account: string | null;
}

function remaining(expiresAt: number, now: number): string {
  const ms = Math.max(0, expiresAt - now);
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export default function TelegramBotSection() {
  const [minted, setMinted] = useState<Minted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const copyTimer = useRef<number | null>(null);

  // One second tick, and only while a code is live — an idle settings tab
  // should not hold a timer forever.
  useEffect(() => {
    if (!minted) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [minted]);

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const expired = minted !== null && minted.expiresAt <= now;

  const generate = useCallback(async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await authedFetch(`${apiBase}/tgbot/link-code`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? `HTTP ${res.status}`);
        setMinted(null);
        return;
      }
      setNow(Date.now());
      setMinted({ code: data.code, expiresAt: data.expiresAt, account: data.account ?? null });
    } catch (err) {
      setError((err as Error).message);
      setMinted(null);
    } finally {
      setBusy(false);
    }
  }, []);

  const copy = useCallback(async () => {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(`/link ${minted.code}`);
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // A blocked clipboard is not an error worth a banner — the code is on
      // screen and can be typed. Eight characters is the reason it is eight.
    }
  }, [minted]);

  return (
    <SectionStack>
      <SectionHeader
        title="Telegram bot"
        blurb={
          <>
            Link a Telegram chat to this OCT account so the bot delivers{' '}
            <em>your</em> alerts there, filtered by <em>your</em> thresholds. No
            Telegram credential is handed over in either direction — the bot
            carries its own token and reads only what is addressed to it.
          </>
        }
      />

      <SettingsCard
        icon={<Send size={16} />}
        title="Link a chat"
        blurb="Generate a code, then send it to the bot from the chat you want linked. In a group only an admin can complete the link, because it decides what the whole room receives."
      >
        <ol className="space-y-snug type-body text-oct-muted list-decimal pl-5">
          <li>Generate a code below.</li>
          <li>
            In Telegram, run <code className="type-data text-oct-text">/start</code> in the chat if
            you have not already.
          </li>
          <li>
            Send <code className="type-data text-oct-text">/link &lt;code&gt;</code> in that chat.
          </li>
        </ol>

        <div className="mt-comfy flex items-center gap-cozy">
          <button
            type="button"
            onClick={generate}
            disabled={busy}
            className="oct-btn-primary inline-flex items-center gap-snug px-comfy py-snug type-label disabled:opacity-50"
          >
            <KeyRound size={13} />
            {minted ? 'Generate a new code' : 'Generate a link code'}
          </button>
          {minted?.account && <Help>This account is {minted.account} in the bot.</Help>}
        </div>

        {error && (
          <StatusBox tone="critical" className="mt-comfy">
            {error}
          </StatusBox>
        )}

        {minted && (
          <div className="mt-comfy rounded-oct border border-oct-border bg-oct-surface-raised px-comfy py-cozy">
            <div className="flex items-center justify-between gap-comfy flex-wrap">
              <span
                className="type-data text-oct-text tracking-[0.28em] select-all"
                style={{ fontSize: '1.4rem' }}
              >
                {minted.code}
              </span>
              <div className="flex items-center gap-cozy">
                <span className={expired ? 'type-data text-oct-critical' : 'type-data text-oct-muted'}>
                  {expired ? 'expired' : `expires in ${remaining(minted.expiresAt, now)}`}
                </span>
                <button
                  type="button"
                  onClick={copy}
                  disabled={expired}
                  className="oct-icon-btn p-snug disabled:opacity-40"
                  title="Copy the /link command"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </div>
            <Help className="mt-snug">
              {expired
                ? 'Generate a new one — an expired code cannot be redeemed.'
                : 'Treat this like a password until it is used. It works once, for one chat, and anyone who reads it before you send it can link their own chat to this account instead.'}
            </Help>
          </div>
        )}
      </SettingsCard>

      <SettingsCard title="What a link does, and does not, do">
        <ul className="space-y-snug type-body text-oct-muted list-disc pl-5">
          <li>
            The linked chat receives <em>this account&apos;s</em> alerts, narrowed by the
            market-cap filters on the Market-Cap Alerts page. Nothing is subscribed by
            linking — the chat still has to turn classes on from the bot&apos;s panel.
          </li>
          <li>
            Admins of a linked group can edit those filters from Telegram
            (<code className="type-data text-oct-text">/filters</code>), and that changes them
            everywhere, including here. Link groups you control.
          </li>
          <li>
            The bot shows the account as a short fingerprint, never an email or a
            name — a group panel is readable by everyone in the room.
          </li>
          <li>
            Undo it from Telegram with <code className="type-data text-oct-text">/unlink</code>.
            The chat falls back to whatever the instance default is, and its
            subscriptions and mutes are untouched.
          </li>
        </ul>
      </SettingsCard>
    </SectionStack>
  );
}
