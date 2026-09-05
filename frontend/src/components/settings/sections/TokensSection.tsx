import { Key, Plus, Trash2, Eye, EyeOff, AlertTriangle } from 'lucide-react';
import TelegramSetup from '../../TelegramSetup';
import { isHostedMode } from '../../../lib/supabase';
import { isClientGatewayMode } from '../../../discord/clientGateway';
import { cn } from '../../../lib/utils';
import {
  EmptyNote,
  FieldRow,
  INPUT_MONO_CLASS,
  RemoveButton,
  SettingsCard,
  StatusText,
} from '../fields';
import type { SettingsForm } from '../useSettingsForm';

/** Small mono badge on a token row; `critical` when the token was rejected. */
const tokenBadge = (invalid: boolean) =>
  cn(
    'inline-flex items-center gap-tight rounded-oct border px-snug py-hair type-caption font-mono font-bold uppercase tracking-wide shrink-0',
    invalid
      ? 'border-oct-critical bg-oct-critical-dim text-oct-critical'
      : 'border-oct-accent bg-oct-accent-dim text-oct-accent',
  );

export default function TokensSection({ form }: { form: SettingsForm }) {
  const { config, updateConfig, maskedTokens, addToken, removeToken, authStatus, telegramDisconnect, newToken, setNewToken, showNewToken, setShowNewToken, tokenError, setTokenError, addingToken, setAddingToken, proxyUrl, setProxyUrl, proxySaving, setProxySaving, proxySaved, setProxySaved, showTelegramSetup, setShowTelegramSetup } = form;

  const submitToken = async () => {
    if (!newToken.trim()) return;
    setAddingToken(true);
    setTokenError('');
    const result = await addToken(newToken.trim());
    if (result.success) { setNewToken(''); setShowNewToken(false); }
    else { setTokenError(result.error ?? 'Failed to add token'); }
    setAddingToken(false);
  };

  return (
    <>
      <SettingsCard
        title="Discord Tokens"
        blurb={
          <>
            Manage your Discord authentication tokens. Multiple tokens allow monitoring across different accounts.
            {isClientGatewayMode() && (
              <span className="block mt-snug text-oct-warn">
                Hosted mode: tokens are stored only in this browser and connect directly to Discord — they never touch our servers.
              </span>
            )}
          </>
        }
      >
        {maskedTokens.length > 0 ? (
          <div className="space-y-tight mb-comfy">
            {maskedTokens.map((t) => (
              <FieldRow
                key={t.index}
                className={cn(
                  'flex items-center justify-between gap-cozy',
                  t.invalid && 'border-oct-critical bg-oct-critical-dim',
                )}
              >
                <div className="flex items-center gap-cozy min-w-0">
                  <Key size={14} className={cn('shrink-0', t.invalid ? 'text-oct-critical' : 'text-oct-accent')} />
                  <span className="type-data text-oct-text tracking-wider truncate">{t.masked}</span>
                  <span className={tokenBadge(!!t.invalid)}>#{t.index + 1}</span>
                  {t.invalid && (
                    <span className={tokenBadge(true)}>
                      <AlertTriangle size={11} />
                      Invalid
                    </span>
                  )}
                </div>
                <RemoveButton onClick={() => { void removeToken(t.index); }} title="Remove token">
                  <Trash2 size={14} />
                </RemoveButton>
              </FieldRow>
            ))}
          </div>
        ) : (
          <EmptyNote className="mb-comfy">No tokens configured.</EmptyNote>
        )}

        <div className="flex gap-cozy">
          <div className="flex-1 relative">
            <input
              type={showNewToken ? 'text' : 'password'}
              value={newToken}
              onChange={(e) => { setNewToken(e.target.value); setTokenError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void submitToken(); }}
              placeholder="Paste Discord token..."
              name="oct-token-field"
              className={cn(INPUT_MONO_CLASS, 'pr-9')}
              disabled={addingToken}
              autoComplete="one-time-code"
              data-1p-ignore
              data-lpignore="true"
              data-form-type="other"
            />
            <button
              onClick={() => setShowNewToken(!showNewToken)}
              className="absolute right-cozy top-1/2 -translate-y-1/2 text-oct-muted hover:text-oct-text transition-colors duration-100"
              type="button"
              tabIndex={-1}
            >
              {showNewToken ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <button
            onClick={() => { void submitToken(); }}
            disabled={addingToken || !newToken.trim()}
            className="oct-btn-primary px-comfy py-snug text-sm"
          >
            <Plus size={16} />
          </button>
        </div>
        {tokenError && <StatusText tone="critical" className="mt-snug">{tokenError}</StatusText>}
      </SettingsCard>

      {/* Connection / Proxy (desktop only) */}
      {!isHostedMode && (
        <SettingsCard
          title="Connection"
          blurb="If Discord won't load on a VPN, route the connection through an HTTP/HTTPS proxy. Leave blank to connect directly. SOCKS proxies are not supported."
        >
          <div className="flex gap-cozy">
            <input
              type="text"
              value={proxyUrl}
              onChange={(e) => { setProxyUrl(e.target.value); setProxySaved(false); }}
              placeholder="http://user:pass@host:port"
              className={cn(INPUT_MONO_CLASS, 'flex-1')}
              disabled={proxySaving}
              spellCheck={false}
              autoComplete="off"
            />
            <button
              onClick={async () => {
                setProxySaving(true);
                setProxySaved(false);
                await updateConfig({ discordProxyUrl: proxyUrl.trim() });
                setProxySaving(false);
                setProxySaved(true);
              }}
              disabled={proxySaving || proxyUrl.trim() === (config?.discordProxyUrl ?? '')}
              className="oct-btn-primary px-comfy py-snug text-sm whitespace-nowrap"
            >
              {proxySaving ? 'Saving…' : 'Save'}
            </button>
          </div>
          {proxySaved && (
            <StatusText tone="good" className="mt-snug">
              Saved. Reconnecting Discord{proxyUrl.trim() ? ' through the proxy' : ' directly'}…
            </StatusText>
          )}
        </SettingsCard>
      )}

      {/* Telegram Section */}
      <SettingsCard
        title="Telegram"
        blurb="Connect your Telegram account to combine TG chats with Discord channels in your rooms."
      >
        {authStatus?.telegramConnected ? (
          <div className="space-y-cozy">
            <FieldRow className="flex items-center gap-cozy">
              <div className="w-2 h-2 rounded-full bg-oct-good" />
              <span className="type-body text-oct-text">Telegram connected</span>
            </FieldRow>
            <button
              onClick={() => { void telegramDisconnect(); }}
              className="oct-icon-btn px-comfy py-snug text-sm hover:border-oct-critical hover:text-oct-critical"
            >
              Disconnect Telegram
            </button>
          </div>
        ) : authStatus?.telegramConfigured ? (
          <div className="space-y-cozy">
            <FieldRow className="flex items-center gap-cozy">
              <div className="w-2 h-2 rounded-full bg-oct-warn" />
              <span className="type-body text-oct-text">Telegram configured but not connected</span>
            </FieldRow>
            <button
              onClick={() => { void telegramDisconnect(); }}
              className="oct-icon-btn px-comfy py-snug text-sm hover:border-oct-critical hover:text-oct-critical"
            >
              Remove Telegram Session
            </button>
          </div>
        ) : showTelegramSetup ? (
          <TelegramSetup onClose={() => setShowTelegramSetup(false)} />
        ) : (
          <button
            onClick={() => setShowTelegramSetup(true)}
            className="oct-btn-primary px-comfy py-snug text-sm"
          >
            Connect Telegram
          </button>
        )}
      </SettingsCard>
    </>
  );
}
