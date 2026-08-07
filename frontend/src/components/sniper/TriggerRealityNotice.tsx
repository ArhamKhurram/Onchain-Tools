import { AlertTriangle } from 'lucide-react';

/**
 * The honesty band. It sits above the subnav on EVERY sniper tab and is not
 * dismissable — there is no localStorage "seen" key, because the whole point is
 * that an operator can never be looking at this page having forgotten where the
 * automatic path actually runs.
 *
 * The fact it states is load-bearing, not decorative: in the alpha the
 * tweet -> buy loop lives inside Slotshark, so `executeFire` is never reached on
 * the automatic path (docs/architecture/sniper.md, alpha trigger decision). Every
 * control on this page — the caps, the kill switch, the dry-run flag — lives
 * inside executeFire, and therefore binds console-fired buys ONLY. Implying
 * otherwise would be the single most dangerous thing this UI could do.
 */
export default function TriggerRealityNotice() {
  return (
    <div className="shrink-0 flex items-start gap-2.5 px-4 sm:px-6 py-2.5 border-b-2 border-black border-l-4 border-l-oct-yellow bg-oct-yellow/10">
      <AlertTriangle size={14} className="text-oct-yellow shrink-0 mt-0.5" strokeWidth={2.5} />
      <p className="font-mono text-[11px] leading-relaxed text-oct-text">
        <strong className="font-bold">Triggers live in Slotshark, not here.</strong> In this alpha OCT does not watch
        Twitter. Your Slotshark account&rsquo;s own Twitter triggers decide when an automatic buy happens, and OCT never
        sees it — configure and cap them in Slotshark&rsquo;s own dashboard. The caps, kill switch and dry-run below bind{' '}
        <strong className="font-bold">only</strong> to buys fired from this console.
      </p>
    </div>
  );
}
