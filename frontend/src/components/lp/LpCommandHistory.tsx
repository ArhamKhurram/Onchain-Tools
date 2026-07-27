import { ExternalLink, RefreshCw, Terminal } from 'lucide-react';
import { shortTxHash } from './commands';
import {
  formatCommandTimestamp,
  HISTORY_ACTION_LABELS,
  RECEIPT_STATUS_LABELS,
  shortAddress,
  type LpCommandHistoryRow,
  type LpCommandReceiptStatus,
} from './format';
import { LP_BTN_GHOST, LP_PANEL, LP_PANEL_HEADER, LP_PANEL_TITLE } from './styles';
import { useLpCommandHistory } from '../../hooks/useLpCommands';

const RECEIPT_CHIP: Record<LpCommandReceiptStatus, string> = {
  pending: 'border-oct-border text-oct-muted',
  running: 'border-oct-accent text-oct-accent',
  done: 'border-oct-green text-oct-green',
  failed: 'border-oct-flame text-oct-flame',
  reverted: 'border-oct-flame text-oct-flame',
  skipped: 'border-oct-yellow text-oct-yellow',
};

function HistoryRow({ command }: { command: LpCommandHistoryRow }) {
  const hash = shortTxHash(command.txHash);

  return (
    <tr className="border-t-2 border-oct-border align-top">
      <td className="px-3 py-2.5 font-mono text-[11px]">
        {HISTORY_ACTION_LABELS[command.action] ?? command.action}
      </td>
      <td className="px-3 py-2.5 font-mono text-[11px] text-oct-muted">
        {command.tokenId ? `#${command.tokenId}` : 'new position'}
        {command.poolAddress && (
          <span className="block text-[10px] mt-0.5">{shortAddress(command.poolAddress)}</span>
        )}
      </td>
      <td className="px-3 py-2.5">
        <span
          className={`font-mono text-[10px] uppercase border-2 px-1.5 py-0.5 ${RECEIPT_CHIP[command.receiptStatus]}`}
        >
          {RECEIPT_STATUS_LABELS[command.receiptStatus]}
        </span>
      </td>
      <td className="px-3 py-2.5 font-mono text-[10px] tabular-nums">
        <span className="block">{formatCommandTimestamp(command.requestedAt)}</span>
        {command.completedAt && (
          <span className="block">→ {formatCommandTimestamp(command.completedAt)}</span>
        )}
      </td>
      <td className="px-3 py-2.5 font-mono text-[10px]">
        {hash && command.txExplorerUrl ? (
          <a
            href={command.txExplorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-oct-accent hover:underline inline-flex items-center gap-1"
          >
            {hash}
            <ExternalLink size={10} />
          </a>
        ) : (
          hash ?? '—'
        )}
      </td>
      <td className="px-3 py-2.5 font-mono text-[10px] text-oct-flame max-w-[14rem] break-words">
        {command.error ?? '—'}
      </td>
    </tr>
  );
}

export default function LpCommandHistory({ enabled }: { enabled: boolean }) {
  const { commands, loading, error, unavailable, polling, refresh } = useLpCommandHistory(enabled);

  return (
    <section className={LP_PANEL}>
      <div className={LP_PANEL_HEADER}>
        <div className="flex items-center gap-2">
          <Terminal size={14} className="text-oct-accent" />
          <h3 className={LP_PANEL_TITLE}>Command history</h3>
          {polling && <span className="font-mono text-[9px] text-oct-accent animate-pulse">live</span>}
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading || unavailable}
          className={LP_BTN_GHOST}
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Reload
        </button>
      </div>

      <div className="px-4 py-3">
        <p className="font-mono text-[11px] text-oct-muted mb-3">
          Every manual action the worker has processed. Receipt status reads Done or Reverted only after
          on-chain confirmation.
        </p>

        {unavailable && (
          <p className="font-mono text-[11px] text-oct-yellow">Command history API not available.</p>
        )}
        {error && !unavailable && <p className="font-mono text-[11px] text-oct-flame">{error}</p>}

        {commands.length > 0 && (
          <div className="overflow-x-auto border-2 border-oct-border">
            <table className="w-full min-w-[44rem] border-collapse">
              <thead>
                <tr className="bg-oct-surface-raised">
                  {['Action', 'Position', 'Receipt', 'Requested', 'Transaction', 'Error'].map((heading) => (
                    <th
                      key={heading}
                      className="px-3 py-2 text-left font-mono text-[9px] uppercase text-oct-muted font-semibold"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {commands.map((command) => (
                  <HistoryRow key={command.id} command={command} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && !unavailable && commands.length === 0 && (
          <p className="font-mono text-[11px] text-oct-muted">No commands yet.</p>
        )}
      </div>
    </section>
  );
}
