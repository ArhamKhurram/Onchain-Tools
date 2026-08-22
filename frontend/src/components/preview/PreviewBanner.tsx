import { Radio, ArrowRight } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';

// Persistent, non-dismissable bar shown across the top of the feed while the
// seeded demo is running. It keeps the "this is a demo → connect to track your
// own servers" promise in view and is the single conversion CTA out of preview.
export default function PreviewBanner() {
  const previewSeeded = useAppStore((s) => s.previewSeeded);
  const exitPreview = useAppStore((s) => s.exitPreview);

  if (!previewSeeded) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-gradient-to-r from-oct-flame to-oct-accent text-black border-b border-oct-border">
      <Radio size={15} className="shrink-0 animate-pulse-live" />
      <span className="flex-1 text-[12px] sm:text-[13px] font-mono leading-snug">
        <strong className="uppercase tracking-[0.08em]">Demo feed</strong>
        <span className="hidden sm:inline"> — these are sample calls. </span>
        <span className="sm:hidden"> · </span>
        Connect your Discord to track <strong>your</strong> servers and callers.
      </span>
      <button
        type="button"
        onClick={exitPreview}
        className="shrink-0 inline-flex items-center gap-1.5 rounded-oct-sm bg-black/85 text-white px-3 py-1.5 text-[11px] font-mono font-semibold uppercase tracking-[0.1em] hover:bg-black transition-colors"
      >
        Connect Discord
        <ArrowRight size={13} />
      </button>
    </div>
  );
}
