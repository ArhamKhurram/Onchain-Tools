interface ScrollFooterProps {
  label: string;
  visible: boolean;
  onAction?: () => void;
  /** Bottom section: centered CTA only — avoids overlapping disclaimer text */
  compact?: boolean;
}

export function ScrollFooter({ label, visible, onAction, compact = false }: ScrollFooterProps) {
  if (!visible) return null;

  if (compact) {
    return (
      <div className="fixed bottom-0 inset-x-0 z-40 px-4 sm:px-8 py-5 flex justify-center pointer-events-none bg-gradient-to-t from-oct-flame via-oct-flame/95 to-transparent pt-10">
        {onAction ? (
          <button
            type="button"
            onClick={onAction}
            className="font-mono text-[10px] sm:text-xs uppercase tracking-[0.14em] text-black hover:text-black/90 transition-colors pointer-events-auto cursor-pointer border-2 border-black px-4 py-2 bg-oct-flame/90 backdrop-blur-sm"
          >
            {label}
          </button>
        ) : (
          <span className="font-mono text-[10px] sm:text-xs uppercase tracking-[0.14em] text-black animate-pulse">
            {label}
          </span>
        )}
      </div>
    );
  }

  const center = onAction ? (
    <button
      type="button"
      onClick={onAction}
      className="animate-pulse hover:opacity-100 opacity-90 transition-opacity pointer-events-auto cursor-pointer uppercase text-black"
    >
      {label}
    </button>
  ) : (
    <span className="animate-pulse text-black">{label}</span>
  );

  return (
    <div className="fixed bottom-0 inset-x-0 z-40 px-4 sm:px-8 py-4 flex items-center justify-between font-mono text-[10px] sm:text-xs uppercase tracking-[0.14em] text-black pointer-events-none">
      <span className="hidden sm:inline">[ OCT ]</span>
      <span className="sm:hidden" aria-hidden />
      {center}
      <span className="hidden sm:inline tabular-nums opacity-0 select-none" aria-hidden>
        [ · ]
      </span>
    </div>
  );
}
