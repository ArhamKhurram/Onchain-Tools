interface ScrollFooterProps {
  label: string;
  counter: string;
  visible: boolean;
  onAction?: () => void;
}

export function ScrollFooter({ label, counter, visible, onAction }: ScrollFooterProps) {
  if (!visible) return null;

  const center = onAction ? (
    <button
      type="button"
      onClick={onAction}
      className="animate-pulse hover:opacity-100 opacity-80 transition-opacity pointer-events-auto cursor-pointer uppercase"
    >
      {label}
    </button>
  ) : (
    <span className="animate-pulse">{label}</span>
  );

  return (
    <div className="fixed bottom-0 inset-x-0 z-40 px-4 sm:px-8 py-4 flex items-center justify-between font-mono text-[10px] sm:text-xs uppercase tracking-[0.14em] text-black/70 pointer-events-none">
      <span>[ OCT ]</span>
      {center}
      <span className="tabular-nums">[ {counter} ]</span>
    </div>
  );
}
