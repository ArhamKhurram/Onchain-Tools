import { useEffect, useState } from 'react';
import { RefreshCw, Users, Radio, UserPlus, ShieldAlert } from 'lucide-react';
import { apiFetch } from '../stores/appStore.helpers';

interface AdminStats {
  mode: 'local' | 'hosted';
  signups: { total: number | null; last7d: number | null; last24h: number | null };
  live: { connections: number; users: number; anonymousConnections: number };
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
      const res = await apiFetch('/admin/stats');
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
