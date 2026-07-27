import { Info } from 'lucide-react';

/** Compact `(i)` affordance — mechanism prose lives in the tooltip, not inline. */
export default function LpInfoTip({ text, label = 'More information' }: { text: string; label?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={text}
      className="inline-flex items-center justify-center shrink-0 text-oct-muted hover:text-oct-text transition-colors"
    >
      <Info size={12} strokeWidth={2} />
    </button>
  );
}
