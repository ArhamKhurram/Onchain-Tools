import { useEffect, useState } from 'react';
import { RefreshCw, Users, Radio, UserPlus, ShieldAlert } from 'lucide-react';
import { apiFetch, API_BASE } from '../stores/appStore.helpers';

interface AdminStats {
  mode: 'local' | 'hosted';
  signups: { total: number | null; last7d: number | null; last24h: number | null };
  live: { connections: number; users: number; anonymousConnections: number };
  funnel: {
    signedUp: number | null;
    addedDiscordToken: number | null;
    createdRoom: number | null;
    detectedContract: number | null;
    trackedWallet: number | null;
    addedTelegram: number | null;
  };
  gatingConfigured: boolean;
  generatedAt: string;
}

/** Operator-only. The API 404s for everyone else, so there is no nav entry. */
export default function AdminPage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      // Must be absolute via API_BASE: apiFetch only attaches the bearer token,
      // it does not prefix the API origin. A bare path resolves against the
      // Vercel-hosted frontend, which 404s without ever reaching the backend.
      const res = await apiFetch(`${API_BASE}/admin/stats`);
      if (res.status === 404) {
        // Deliberately indistinguishable from a missing route — see requireAdmin.
        setError('Not found.');
        setStats(null);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStats(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
      setStats(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000); // live figures go stale fast
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `null` means "could not source", which is not the same as zero.
  const num = (v: number | null | undefined) =>
    v === null || v === undefined ? '—' : v.toLocaleString('en-US');

  return (
    <div className="h-full overflow-y-auto bg-oct-bg">
      <section className="bg-oct-flame text-black px-6 sm:px-10 py-8 sm:py-10 border-b-2 border-black">
        <div className="max-w-5xl mx-auto flex items-end justify-between gap-4">
          <div>
            <p className="font-mono text-xs tracking-[0.2em] mb-3">[ ADMIN ]</p>
            <h1 className="font-display text-[clamp(2rem,6vw,3.5rem)] leading-[0.95] tracking-tight">
              OPERATOR STATS
            </h1>
          </div>
          <button
            type="button"
            onClick={load}
            className="shrink-0 inline-flex items-center gap-2 border-2 border-black bg-black text-oct-flame font-mono text-xs uppercase tracking-[0.15em] px-3 py-2"
            title="Refresh"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
            Refresh
          </button>
        </div>
      </section>

      <section className="px-6 sm:px-10 py-8 sm:py-10">
        <div className="max-w-5xl mx-auto">
          {error && (
            <div className="border-2 border-oct-flame bg-oct-flame/15 p-5 mb-8">
              <p className="font-mono text-xs uppercase tracking-[0.15em] text-oct-flame mb-2">
                Unavailable
              </p>
              <p className="text-sm text-oct-muted">{error}</p>
            </div>
          )}

          {stats && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                <Stat icon={<Radio size={16} />} label="Online now" value={num(stats.live.users)} hint="distinct accounts" accent />
                <Stat icon={<Users size={16} />} label="Connections" value={num(stats.live.connections)} hint="open sockets" />
                <Stat icon={<UserPlus size={16} />} label="Signups" value={num(stats.signups.total)} hint="all time" />
                <Stat icon={<UserPlus size={16} />} label="New · 7d" value={num(stats.signups.last7d)} hint={`${num(stats.signups.last24h)} in 24h`} />
              </div>

              <Funnel stats={stats} />

              {stats.signups.total === null && (
                <p className="font-mono text-[11px] text-oct-muted mt-6 leading-relaxed">
                  Signup figures need a Supabase service-role key
                  (<span className="text-oct-text">SUPABASE_SERVICE_ROLE_KEY</span>). Dashes mean
                  the number could not be sourced — not zero.
                </p>
              )}

              {!stats.gatingConfigured && stats.mode === 'hosted' && (
                <div className="border-2 border-oct-yellow bg-oct-yellow/15 p-4 mt-6 flex gap-3 items-start">
                  <ShieldAlert size={16} className="text-oct-yellow shrink-0 mt-0.5" />
                  <p className="font-mono text-[11px] leading-relaxed text-oct-muted">
                    <span className="text-oct-yellow font-bold uppercase tracking-wider">No allow-list.</span>{' '}
                    OCT_ADMIN_IDS is empty, so this surface is closed to everyone. Set it to your
                    Discord ID or Supabase UUID.
                  </p>
                </div>
              )}

              <div className="mt-8 font-mono text-[11px] text-oct-muted flex flex-wrap gap-x-6 gap-y-1">
                <span>MODE <span className="text-oct-text">{stats.mode.toUpperCase()}</span></span>
                <span>ANON SOCKETS <span className="text-oct-text">{num(stats.live.anonymousConnections)}</span></span>
                <span>UPDATED <span className="text-oct-text">{new Date(stats.generatedAt).toLocaleTimeString()}</span></span>
                <span className="text-oct-border-bright">auto-refresh 15s</span>
              </div>
            </>
          )}

          {!stats && !error && loading && (
            <p className="font-mono text-xs text-oct-muted">Loading…</p>
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * Activation funnel. The bar is width-scaled against signups, and each row
 * carries its conversion off the PREVIOUS stage — the drop between steps is
 * what identifies where people stall, which the absolute counts obscure.
 */
function Funnel({ stats }: { stats: AdminStats }) {
  const base = stats.funnel.signedUp;
  const steps: { label: string; value: number | null; note: string }[] = [
    { label: 'Signed up', value: stats.funnel.signedUp, note: 'created an account' },
    { label: 'Added Discord token', value: stats.funnel.addedDiscordToken, note: 'the big drop-off point' },
    { label: 'Created a room', value: stats.funnel.createdRoom, note: 'configured a feed' },
    { label: 'Saw a contract', value: stats.funnel.detectedContract, note: 'got real value' },
    { label: 'Tracked a wallet', value: stats.funnel.trackedWallet, note: 'went beyond the feed' },
    { label: 'Added Telegram', value: stats.funnel.addedTelegram, note: 'second source' },
  ];

  if (base === null) return null;

  return (
    <div className="mt-10">
      <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-oct-muted mb-4">
        [ ACTIVATION FUNNEL ]
      </p>
      <div className="border-2 border-oct-border bg-oct-surface">
        {steps.map((s, i) => {
          const prev = i === 0 ? null : steps[i - 1].value;
          const pctOfBase = s.value !== null && base > 0 ? (s.value / base) * 100 : 0;
          // Conversion off the previous stage — the number that localises a drop.
          const conv = s.value !== null && prev !== null && prev > 0 ? (s.value / prev) * 100 : null;
          const bad = conv !== null && conv < 50;

          return (
            <div key={s.label} className="border-b-2 border-oct-border last:border-b-0 px-5 py-4">
              <div className="flex items-baseline justify-between gap-4 mb-2">
                <span className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-oct-text">
                  {s.label}
                </span>
                <span className="flex items-baseline gap-3 shrink-0">
                  {conv !== null && (
                    <span className={`font-mono text-[11px] ${bad ? 'text-oct-accent' : 'text-oct-muted'}`}>
                      {conv.toFixed(0)}% of prev
                    </span>
                  )}
                  <span className="font-mono text-2xl font-bold tabular-nums text-oct-text">
                    {s.value === null ? '—' : s.value.toLocaleString('en-US')}
                  </span>
                </span>
              </div>
              <div className="h-2 bg-oct-bg border-2 border-oct-border">
                <div
                  className={bad ? 'h-full bg-oct-accent' : 'h-full bg-oct-green'}
                  style={{ width: `${Math.min(100, pctOfBase)}%` }}
                />
              </div>
              <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-oct-muted mt-2">{s.note}</p>
            </div>
          );
        })}
      </div>
      <p className="font-mono text-[10px] text-oct-muted mt-3 leading-relaxed">
        Counts are distinct accounts that ever reached a stage, not a strict cohort —
        someone who added a token then deleted it still counts. Stages after the first
        are not guaranteed sequential.
      </p>
    </div>
  );
}

function Stat({
  icon, label, value, hint, accent,
}: {
  icon: React.ReactNode; label: string; value: string; hint?: string; accent?: boolean;
}) {
  return (
    <div className={`border-2 p-5 shadow-oct-hard-sm ${accent ? 'border-oct-accent bg-oct-accent-dim' : 'border-oct-border bg-oct-surface'}`}>
      <div className={`flex items-center gap-2 mb-3 ${accent ? 'text-oct-accent' : 'text-oct-muted'}`}>
        {icon}
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.15em]">{label}</span>
      </div>
      <div className="font-mono text-4xl font-bold tabular-nums text-oct-text">{value}</div>
      {hint && <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-oct-muted mt-2">{hint}</div>}
    </div>
  );
}
