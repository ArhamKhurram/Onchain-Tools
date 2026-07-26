import { History } from 'lucide-react';
import { LP_PANEL, LP_PANEL_HEADER, LP_PANEL_TITLE } from './styles';

/**
 * Versions are never mutated in place. Editing produces a new version, so an
 * open position can always be resolved back to the exact rules it was opened
 * under — which also means saving here does not retroactively change anything
 * already in the market. That sentence is the reason this panel exists at all.
 */
export default function LpVersionHistory({
  versions,
  activeVersion,
  loading,
}: {
  versions: number[];
  activeVersion: number | null;
  loading: boolean;
}) {
  // The active version is folded in even if the versions list did not include
  // it — the one version that must never be missing from this panel is the one
  // currently deciding what happens to money.
  const ordered = Array.from(new Set(activeVersion === null ? versions : [...versions, activeVersion])).sort(
    (a, b) => b - a,
  );
  const nextVersion = (ordered[0] ?? 0) + 1;

  return (
    <section className={LP_PANEL}>
      <div className={LP_PANEL_HEADER}>
        <div className="flex items-center gap-2 min-w-0">
          <History size={14} strokeWidth={2} className="text-oct-accent shrink-0" />
          <h3 className={LP_PANEL_TITLE}>Version history</h3>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-oct-muted">
          next save → v{nextVersion}
        </span>
      </div>

      <div className="px-4 py-3">
        <p className="font-mono text-[11px] text-oct-muted leading-relaxed mb-3">
          Every save writes a new version; none is ever edited in place. Positions already open keep the version they
          were opened under — saving changes what happens next, never what is already in the market.
        </p>

        {loading && ordered.length === 0 && (
          <div className="h-8 border-2 border-oct-border bg-oct-surface-raised animate-pulse" />
        )}

        {!loading && ordered.length === 0 && (
          <p className="font-mono text-[11px] text-oct-muted">
            No version saved yet. The first save creates v1 — the genesis policy.
          </p>
        )}

        {ordered.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {ordered.map((version) => {
              const active = version === activeVersion;
              return (
                <li
                  key={version}
                  title={active ? 'The version the signer reads right now' : 'Superseded — kept for audit'}
                  className={`font-mono text-[11px] tabular-nums border-2 px-2 py-1 ${
                    active
                      ? 'border-oct-accent text-oct-accent bg-oct-accent-dim font-semibold'
                      : 'border-oct-border text-oct-muted'
                  }`}
                >
                  v{version}
                  {active && <span className="ml-1.5 text-[9px] uppercase tracking-[0.1em]">active</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
