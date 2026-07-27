import LpSafeAddressField, { type LpSafeAddressFieldProps } from './LpSafeAddressField';
import { LP_PANEL, LP_PANEL_HEADER, LP_PANEL_TITLE } from './styles';
import { Settings } from 'lucide-react';

/**
 * One-time LP page configuration — which Safe to read.
 *
 * Kept off the Positions tab on purpose: the address is set once and rarely
 * changed, and it was consuming the top third of the daily-use view.
 */

export default function LpSettingsPanel(props: LpSafeAddressFieldProps) {
  return (
    <section className={LP_PANEL}>
      <div className={LP_PANEL_HEADER}>
        <div className="flex items-center gap-2 min-w-0">
          <Settings size={14} strokeWidth={2} className="text-oct-accent shrink-0" />
          <h3 className={LP_PANEL_TITLE}>Settings</h3>
        </div>
      </div>
      <LpSafeAddressField {...props} />
    </section>
  );
}
