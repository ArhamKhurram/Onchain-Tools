import { useRef, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { KeyRound, Loader2, AlertCircle, Upload, ArrowRight } from 'lucide-react';

interface TokenSetupProps {
  /** Compact form for Feed page — skips full-screen shell and duplicate header. */
  embedded?: boolean;
}

export default function TokenSetup({ embedded = false }: TokenSetupProps) {
  const submitToken = useAppStore((s) => s.submitToken);
  const checkAuth = useAppStore((s) => s.checkAuth);
  const importSettings = useAppStore((s) => s.importSettings);
  const setPreviewMode = useAppStore((s) => s.setPreviewMode);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;

    setLoading(true);
    setError(null);

    const result = await submitToken(token.trim());
    if (result.success) {
      await checkAuth();
    } else {
      setError(result.error ?? 'Failed to connect. Check your token and try again.');
    }
    setLoading(false);
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (importInputRef.current) importInputRef.current.value = '';
    if (!file) return;

    setImporting(true);
    setError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const result = await importSettings(parsed);
      if (!result.success) {
        setError(result.error ?? 'Failed to import settings.');
      }
      // On success the app store flips previewMode / auth, so App unmounts this screen.
    } catch {
      setError('Could not read that file. Make sure it is a valid config.json.');
    } finally {
      setImporting(false);
    }
  };

  const form = (
    <>
      {!embedded && (
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-oct-accent-dim flex items-center justify-center mb-5">
            <KeyRound size={32} className="text-oct-accent" />
          </div>
          <h1 className="text-2xl font-bold text-oct-text mb-2">Welcome to OCT</h1>
          <p className="text-oct-muted text-sm text-center leading-relaxed">
            Enter your Discord token to get started. Your token is stored securely for your account.
          </p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="token" className={`block text-xs font-semibold uppercase tracking-wide mb-2 ${embedded ? 'text-oct-muted' : 'text-discord-text-muted'}`}>
            Discord Token
          </label>
          <input
            id="token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste your Discord token here"
            name="oct-token-field"
            autoComplete="one-time-code"
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            autoFocus={!embedded}
            disabled={loading}
            className={`w-full px-3 py-2.5 rounded text-sm focus:outline-none focus:ring-2 disabled:opacity-50 transition-shadow ${
              embedded
                ? 'bg-oct-surface-raised border border-oct-border text-oct-text placeholder:text-oct-muted focus:ring-oct-accent/40'
                : 'bg-discord-darker border border-discord-dark text-discord-text placeholder:text-discord-channel-icon focus:ring-discord-blurple/40'
            }`}
          />
        </div>

        {error && (
          <div className={`flex items-start gap-2 px-3 py-2.5 rounded text-sm ${
            embedded
              ? 'bg-oct-accent-dim border border-oct-accent/30 text-oct-accent'
              : 'bg-discord-red/10 border border-discord-red/20 text-discord-red'
          }`}>
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !token.trim()}
          className={`w-full py-2.5 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm font-medium text-white transition-colors flex items-center justify-center gap-2 ${
            embedded
              ? 'bg-oct-accent hover:bg-oct-accent-hover'
              : 'bg-discord-blurple hover:bg-discord-blurple-hover'
          }`}
        >
          {loading ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Connecting...
            </>
          ) : (
            'Connect'
          )}
        </button>
      </form>

      <p className={`text-[11px] text-center mt-6 leading-relaxed ${embedded ? 'text-oct-muted' : 'text-discord-channel-icon'}`}>
        You can also set multiple tokens separated by commas.
      </p>

      <div className="flex items-center gap-3 my-6">
        <div className={`h-px flex-1 ${embedded ? 'bg-oct-border' : 'bg-discord-dark'}`} />
        <span className={`text-[11px] uppercase tracking-wide ${embedded ? 'text-oct-muted' : 'text-discord-channel-icon'}`}>or</span>
        <div className={`h-px flex-1 ${embedded ? 'bg-oct-border' : 'bg-discord-dark'}`} />
      </div>

      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        onChange={handleImportFile}
        className="hidden"
      />

      <div className="space-y-2.5">
        <button
          type="button"
          onClick={() => importInputRef.current?.click()}
          disabled={loading || importing}
          className={`w-full py-2.5 border disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
            embedded
              ? 'bg-oct-surface-raised hover:bg-oct-surface border-oct-border text-oct-text'
              : 'bg-discord-darker hover:bg-discord-dark border-discord-dark text-discord-text'
          }`}
        >
          {importing ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Importing...
            </>
          ) : (
            <>
              <Upload size={16} />
              Import settings
            </>
          )}
        </button>

        <button
          type="button"
          onClick={() => setPreviewMode(true)}
          disabled={loading || importing}
          className={`w-full py-2.5 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
            embedded
              ? 'text-oct-muted hover:text-oct-text hover:bg-oct-surface-raised'
              : 'hover:bg-discord-darker text-discord-text-muted hover:text-discord-text'
          }`}
        >
          Continue without a token
          <ArrowRight size={16} />
        </button>
      </div>

      <p className={`text-[11px] text-center mt-4 leading-relaxed ${embedded ? 'text-oct-muted' : 'text-discord-channel-icon'}`}>
        Import your existing <span className={embedded ? 'text-oct-text' : 'text-discord-text-muted'}>config.json</span> to bring over your token, rooms and settings — or explore the app first without connecting.
      </p>
    </>
  );

  if (embedded) {
    return <div className="w-full">{form}</div>;
  }

  return (
    <div className="flex items-center justify-center h-full w-full bg-discord-dark">
      <div className="w-full max-w-md px-8">
        {form}
      </div>
    </div>
  );
}
