import { useState } from 'react';
import { AlertTriangle, KeyRound, ShieldCheck } from 'lucide-react';
import type { ConnectResult } from '../../hooks/usePumpConnection';

interface PumpConnectPanelProps {
  /** `connect` for a first-time link, `reconnect` when a session expired/was rejected. */
  mode: 'connect' | 'reconnect';
  onConnect: (token: string) => Promise<ConnectResult>;
}

// The connect / reconnect form for the pump.fun leaderboard.
//
// The pasted token lives ONLY in this component's local state, and only until a
// successful submit clears it. It is masked (type="password") so it does not sit
// in plain view, it is never written to the store or localStorage, and it is never
// rendered back — on success the field is emptied and the panel unmounts behind
// the leaderboard. This is the frontend half of the credential discipline; the
// hook's connect() is the other half (straight to the API, never retained).
export default function PumpConnectPanel({ mode, onConnect }: PumpConnectPanelProps) {
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reconnect = mode === 'reconnect';

  const submit = async () => {
    if (submitting || token.trim() === '') return;
    setSubmitting(true);
    setError(null);
    const result = await onConnect(token);
    setSubmitting(false);
    if (result.ok) {
      // Drop the token the instant it is accepted — it has done its one job.
      setToken('');
      setError(null);
    } else {
      setError(result.error ?? 'Could not connect your pump.fun account.');
    }
  };

  return (
    <div className="h-full min-h-0 overflow-auto bg-oct-bg">
      <div className="max-w-lg mx-auto px-4 py-8">
        <div className="brutal-card p-5">
          <div className="flex items-center gap-2.5 mb-4">
            <div className="w-9 h-9 shrink-0 border-2 border-black bg-oct-accent shadow-oct-hard-sm flex items-center justify-center">
              {reconnect ? (
                <AlertTriangle size={18} className="text-black" strokeWidth={2.5} />
              ) : (
                <KeyRound size={18} className="text-black" strokeWidth={2.5} />
              )}
            </div>
            <div className="min-w-0">
              <p className="font-mono text-[10px] tracking-[0.18em] text-oct-muted uppercase">
                [ PUMP.FUN · LEADERBOARD ]
              </p>
              <h2 className="font-display text-xl text-oct-text tracking-tight">
                {reconnect ? 'Reconnect pump.fun' : 'Connect pump.fun'}
              </h2>
            </div>
          </div>

          {reconnect && (
            <div className="mb-4 flex items-start gap-2 px-3 py-2 border-2 border-oct-flame/50 rounded-cockpit bg-oct-flame/10">
              <AlertTriangle size={14} className="text-oct-flame shrink-0 mt-0.5" strokeWidth={2.5} />
              <p className="font-mono text-[11px] leading-relaxed text-oct-text">
                Your pump.fun session expired or was rejected. Paste a fresh session token to
                keep reading the leaderboard.
              </p>
            </div>
          )}

          <p className="font-mono text-[11px] leading-relaxed text-oct-muted mb-4">
            The leaderboard is served with your own pump.fun login, so it authorizes reading the
            leaderboard <span className="text-oct-text">as you</span>. Your token is sent once to
            this server, stored encrypted, and never shown again — the console only ever sees your
            connection status, never the token itself.
          </p>

          <label className="block font-mono text-[10px] tracking-[0.12em] text-oct-muted uppercase mb-1.5">
            Session token
          </label>
          <input
            type="password"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
            placeholder="Paste your pump.fun session JWT"
            autoComplete="off"
            spellCheck={false}
            className="w-full px-3 py-2 font-mono text-[12px] bg-oct-bg border-2 border-oct-border rounded-cockpit text-oct-text placeholder:text-oct-muted/60 focus:outline-none focus:border-oct-accent"
          />

          {error && <p className="mt-2 font-mono text-[11px] text-oct-flame">{error}</p>}

          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting || token.trim() === ''}
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-cockpit text-xs font-bold uppercase tracking-wide border-2 border-black bg-oct-accent text-white shadow-oct-hard-sm hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            {submitting ? (
              <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <ShieldCheck size={14} />
            )}
            {reconnect ? 'Reconnect' : 'Connect account'}
          </button>

          <div className="mt-5 pt-4 border-t-2 border-oct-border">
            <p className="font-mono text-[10px] tracking-[0.12em] text-oct-muted uppercase mb-1.5">
              Where to find it
            </p>
            <p className="font-mono text-[11px] leading-relaxed text-oct-muted">
              Log in at pump.fun in your browser, then copy your session token from the site's
              stored credentials (browser dev tools → Application → your pump.fun login). It is a
              long-lived bearer — treat it like a password and only paste it into a console you
              trust.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
