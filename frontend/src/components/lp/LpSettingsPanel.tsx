import { useState } from 'react';
import LpSafeAddressField, { type LpSafeAddressFieldProps } from './LpSafeAddressField';
import { LP_BTN_GHOST, LP_PANEL, LP_PANEL_HEADER, LP_PANEL_TITLE, LP_HELP } from './styles';
import { downloadLpTaxExport } from '../../hooks/useLpTaxExport';
import { Download, Settings } from 'lucide-react';

/**
 * One-time LP page configuration — which Safe to read.
 *
 * Kept off the Positions tab on purpose: the address is set once and rarely
 * changed, and it was consuming the top third of the daily-use view.
 */

export default function LpSettingsPanel(props: LpSafeAddressFieldProps) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const handleExport = async (format: 'csv' | 'json') => {
    setExporting(true);
    setExportError(null);
    const result = await downloadLpTaxExport(format);
    if (!result.ok) setExportError(result.error ?? 'Export failed');
    setExporting(false);
  };

  return (
    <section className={LP_PANEL}>
      <div className={LP_PANEL_HEADER}>
        <div className="flex items-center gap-2 min-w-0">
          <Settings size={14} strokeWidth={2} className="text-oct-accent shrink-0" />
          <h3 className={LP_PANEL_TITLE}>Settings</h3>
        </div>
      </div>
      <LpSafeAddressField {...props} />
      <div className="px-4 py-4 border-t-2 border-oct-border space-y-3">
        <div>
          <p className="font-mono text-xs text-oct-text">Tax / accounting export</p>
          <p className={`${LP_HELP} mt-1`}>
            Download successful LP actions from the worker audit log — deposits, withdrawals, compounds,
            rebalances, and gas spent.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleExport('csv')}
            disabled={exporting || props.disabled}
            className={LP_BTN_GHOST}
          >
            <Download size={12} />
            {exporting ? 'Exporting…' : 'Download CSV'}
          </button>
          <button
            type="button"
            onClick={() => void handleExport('json')}
            disabled={exporting || props.disabled}
            className={LP_BTN_GHOST}
          >
            <Download size={12} />
            JSON
          </button>
        </div>
        {exportError && (
          <p className="font-mono text-[11px] text-oct-flame">{exportError}</p>
        )}
      </div>
    </section>
  );
}
