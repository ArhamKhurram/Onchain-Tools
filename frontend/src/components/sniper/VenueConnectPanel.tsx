import { useState } from 'react';
import { ExternalLink, Eye, EyeOff } from 'lucide-react';
import ConfirmModal from '../ConfirmModal';
import { isHostedMode } from '../../lib/supabase';
import { truncateAddress } from '../../types/wallets';
import type { SniperStatus } from '../../types/sniper';
import type { useSniperVenues } from '../../hooks/useSniperVenues';

const FIELD = 'oct-input w-full px-3 py-2 text-sm font-mono disabled:opacity-60';
const LABEL = 'block oct-label text-oct-muted mb-1.5 uppercase tracking-wide';

interface VenueConnectPanelProps {
  venues: ReturnType<typeof useSniperVenues>;
  status: SniperStatus | null;
}

/** Where trigger configuration actually lives, stated once and linked out. */
function TriggerConfigNote() {
  return (
    <div className="oct-card p-4 space-y-2">
      <p className="oct-eyebrow">Trigger configuration</p>
      <p className="text-xs text-oct-muted leading-relaxed">
        Twitter triggers are created, capped and disabled inside Slotshark, not here. OCT is not told when one fires, so
        nothing on this page can list, bound or stop them. There is no OCT-side trigger API to build against — this
        codebase knows exactly one Slotshark endpoint, the one it buys through.
      </p>
      <a
        href="https://slotshark.com"
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-center gap-1.5 font-mono text-xs text-oct-accent hover:underline"
      >
        Open Slotshark&rsquo;s dashboard <ExternalLink size={12} />
      </a>
    </div>
  );
}

/** Local mode: the credential is two env vars and the backend must not edit its own .env. */
function LocalVenueNote({ status }: { status: SniperStatus | null }) {
  return (
    <div className="oct-card p-4 space-y-3">
      <p className="oct-eyebrow">Local mode</p>
      <p className="text-xs text-oct-muted leading-relaxed">
        The venue token is read from <span className="font-mono text-oct-text">SLOTSHARK_API_TOKEN</span> in{' '}
        <span className="font-mono text-oct-text">backend/.env</span>, and the region from{' '}
        <span className="font-mono text-oct-text">SLOTSHARK_REGION</span> (<span className="font-mono">us</span> or{' '}
        <span className="font-mono">eu</span>; anything else falls back to <span className="font-mono">us</span>).
        Connecting locally means editing that file and restarting the backend — there is deliberately no way for the
        console to write it.
      </p>
      <div className="font-mono text-xs space-y-1">
        <div>
          token:{' '}
          <span className={status?.venue.connected ? 'text-oct-green' : 'text-oct-muted'}>
            {status?.venue.connected ? 'set' : 'not set'}
          </span>
        </div>
        <div>
          region: <span className="text-oct-text">{status?.venue.region ?? 'us (default)'}</span>
        </div>
      </div>
    </div>
  );
}

export default function VenueConnectPanel({ venues, status }: VenueConnectPanelProps) {
  // The secret lives HERE and nowhere else: a local useState, cleared in the
  // finally of submit. Never appStore, never localStorage, never a URL, never a
  // prop that outlives this component, and never sent to the OCT backend — the
  // RPC writes it straight into Supabase Vault from the user's own client.
  const [secret, setSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [walletAddress, setWalletAddress] = useState('');
  const [region, setRegion] = useState('us');
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const existing = venues.credentials.find((c) => c.venue === 'slotshark') ?? null;

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!secret.trim()) {
      setFormError('Paste the venue API token.');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await venues.connect(secret.trim(), { walletAddress, region, label });
      if (!res.ok) setFormError(res.error);
    } finally {
      // Cleared whether the write succeeded or not — a failed connect must not
      // leave the token sitting in a React tree.
      setSecret('');
      setShowSecret(false);
      setSubmitting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(false);
    await venues.disconnect();
  };

  if (!isHostedMode) {
    return (
      <div className="h-full overflow-auto p-4 sm:p-6 space-y-4 bg-oct-bg">
        <LocalVenueNote status={status} />
        <TriggerConfigNote />
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-4 sm:p-6 space-y-4 bg-oct-bg">
      <div className="oct-card p-4 space-y-3">
        <p className="oct-eyebrow">Slotshark</p>

        {venues.error && <p className="font-mono text-xs text-oct-flame">{venues.error}</p>}

        {existing ? (
          <div className="font-mono text-xs space-y-1">
            <div>
              status: <span className="text-oct-green">connected</span>
            </div>
            <div>
              wallet:{' '}
              <span className="text-oct-text">
                {existing.wallet_address ? truncateAddress(existing.wallet_address) : '—'}
              </span>
            </div>
            <div>
              region: <span className="text-oct-text">{existing.region ?? 'us (default)'}</span>
            </div>
            <div>
              label: <span className="text-oct-text">{existing.label ?? '—'}</span>
            </div>
            <div>
              updated: <span className="text-oct-text">{new Date(existing.updated_at).toLocaleString()}</span>
            </div>
          </div>
        ) : (
          <p className="text-xs text-oct-muted">No venue connected. A live fire will refuse with no_credential.</p>
        )}

        <p className="text-xs text-oct-muted leading-relaxed">
          The token goes from this browser straight into Supabase Vault — it never reaches the OCT backend at connect
          time, and the backend reads it only at the instant it is about to send a buy. It cannot be read back, not even
          by you: there is no reveal, no copy and no fingerprint here because none is possible by design. Rotating means
          pasting a new token; disconnecting deletes both the metadata row and the vault secret.
        </p>
      </div>

      <form onSubmit={handleConnect} className="oct-card p-4 space-y-3">
        <p className="oct-eyebrow">
          {existing ? 'Rotate token' : 'Connect'}
        </p>

        <div>
          <label htmlFor="sniper-venue-secret" className={LABEL}>
            API token
          </label>
          <div className="relative">
            <input
              id="sniper-venue-secret"
              type={showSecret ? 'text' : 'password'}
              value={secret}
              onChange={(e) => {
                setSecret(e.target.value);
                setFormError(null);
              }}
              placeholder="Paste Slotshark API token…"
              name="oct-venue-field"
              autoComplete="one-time-code"
              data-1p-ignore
              data-lpignore="true"
              data-form-type="other"
              disabled={submitting}
              className={`${FIELD} pr-9`}
            />
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setShowSecret((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-oct-muted hover:text-oct-text transition-colors"
            >
              {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="sniper-venue-region" className={LABEL}>
              Region
            </label>
            <select id="sniper-venue-region" value={region} onChange={(e) => setRegion(e.target.value)} className={FIELD}>
              <option value="us">us</option>
              <option value="eu">eu</option>
            </select>
          </div>
          <div>
            <label htmlFor="sniper-venue-label" className={LABEL}>
              Label <span className="normal-case text-oct-muted/70">(optional)</span>
            </label>
            <input
              id="sniper-venue-label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Main account"
              className={FIELD}
            />
          </div>
        </div>

        <div>
          <label htmlFor="sniper-venue-wallet" className={LABEL}>
            Venue wallet address <span className="normal-case text-oct-muted/70">(optional)</span>
          </label>
          <input
            id="sniper-venue-wallet"
            type="text"
            value={walletAddress}
            onChange={(e) => setWalletAddress(e.target.value)}
            placeholder="Base58 address…"
            className={FIELD}
          />
        </div>

        {formError && (
          <p className="text-sm text-oct-flame bg-oct-flame/10 border border-oct-flame/50 rounded-oct px-3 py-2 font-mono">
            {formError}
          </p>
        )}

        <div className="flex justify-end gap-2">
          {existing && (
            <button
              type="button"
              onClick={() => setDisconnecting(true)}
              disabled={submitting}
              className="oct-icon-btn px-4 py-2 text-sm"
            >
              Disconnect
            </button>
          )}
          <button type="submit" disabled={submitting} className="oct-btn-primary px-4 py-2 text-sm">
            {submitting ? 'Saving…' : existing ? 'Rotate' : 'Connect'}
          </button>
        </div>
      </form>

      <TriggerConfigNote />

      <ConfirmModal
        open={disconnecting}
        title="Disconnect Slotshark?"
        message={
          'This deletes the stored token and its metadata. Live fires from this console will refuse with no_credential. ' +
          'It does not stop Slotshark’s own Twitter triggers — disable those in Slotshark or defund the wallet.'
        }
        confirmLabel="Disconnect"
        onConfirm={() => void handleDisconnect()}
        onCancel={() => setDisconnecting(false)}
      />
    </div>
  );
}
