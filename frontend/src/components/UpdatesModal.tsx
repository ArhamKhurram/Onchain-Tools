import { useCallback, useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { useUpdatesUiStore } from '../stores/updatesUiStore';
import { UPDATE_SLIDES, type UpdateSlide } from '../data/updates';
import { SlideHero } from './updates/SlideHero';
import { getSeenIds, markSeen } from '../utils/announcements';

export default function UpdatesModal() {
  const manualOpen = useUpdatesUiStore((s) => s.manualOpen);
  const closeChangelog = useUpdatesUiStore((s) => s.closeChangelog);
  const config = useAppStore((s) => s.config);
  const updateConfig = useAppStore((s) => s.updateConfig);
  const configExpected = useAppStore((s) => !!(s.authStatus?.configured || s.previewMode));

  const [index, setIndex] = useState(0);
  const [sessionDismissed, setSessionDismissed] = useState(false);

  const seenSet = useMemo(
    () => new Set<string>([...getSeenIds(), ...(config?.seenAnnouncements ?? [])]),
    [config?.seenAnnouncements],
  );

  const unseenSlides = useMemo(
    () => UPDATE_SLIDES.filter((s) => !seenSet.has(s.id)),
    [seenSet],
  );

  const slides: UpdateSlide[] = manualOpen ? UPDATE_SLIDES : unseenSlides;
  const visible = manualOpen ? manualOpen : !sessionDismissed && unseenSlides.length > 0;

  useEffect(() => {
    if (visible) setIndex(0);
  }, [visible, manualOpen, unseenSlides.length]);

  const persistSeen = useCallback(
    (ids: string[]) => {
      for (const id of ids) markSeen(id);
      if (config) {
        const next = Array.from(new Set([...(config.seenAnnouncements ?? []), ...ids]));
        void updateConfig({ seenAnnouncements: next });
      }
    },
    [config, updateConfig],
  );

  const close = useCallback(() => {
    closeChangelog();
    if (!manualOpen) setSessionDismissed(true);
  }, [manualOpen, closeChangelog]);

  const gotIt = useCallback(() => {
    const current = slides[index];
    if (!manualOpen && current) persistSeen([current.id]);

    if (index < slides.length - 1) {
      setIndex((i) => i + 1);
      return;
    }
    close();
  }, [slides, index, manualOpen, persistSeen, close]);

  if (configExpected && !config && !manualOpen) return null;
  if (!visible || slides.length === 0) return null;

  const current = slides[index];
  const hasPrev = index > 0;

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/75 backdrop-blur-md">
      <div
        className="relative w-full max-w-md flex flex-col rounded-2xl border border-oct-border-bright/80 bg-[#141414] shadow-2xl overflow-hidden"
        role="dialog"
        aria-labelledby="oct-update-title"
        aria-modal="true"
      >
        <button
          type="button"
          onClick={close}
          className="absolute top-3 right-3 z-20 p-1.5 rounded-full text-white/40 hover:text-white hover:bg-white/10 transition-colors"
          aria-label="Close"
        >
          <X size={18} />
        </button>

        <div className="relative h-[220px] sm:h-[260px] shrink-0 border-b border-white/5 overflow-hidden">
          <SlideHero slide={current} />
        </div>

        <div className="shrink-0 px-6 pt-6 pb-2 text-center">
          <h2 id="oct-update-title" className="text-xl font-bold text-white tracking-tight">
            {current.title}
          </h2>
          <p className="mt-2 text-sm text-white/55 leading-relaxed max-w-sm mx-auto">
            {current.description}
          </p>
        </div>

        {slides.length > 1 && (
          <div className="shrink-0 flex items-center justify-center gap-2 py-4">
            {slides.map((s, i) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setIndex(i)}
                className={`rounded-full transition-all ${
                  i === index ? 'w-2 h-2 bg-white' : 'w-1.5 h-1.5 bg-white/25 hover:bg-white/40'
                }`}
                aria-label={`Slide ${i + 1} of ${slides.length}`}
              />
            ))}
          </div>
        )}

        <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-4 border-t border-white/5 bg-black/30">
          <button
            type="button"
            disabled={!hasPrev}
            onClick={() => setIndex((i) => i - 1)}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white/50 hover:text-white hover:bg-white/5 disabled:opacity-25 disabled:pointer-events-none transition-colors"
          >
            Back
          </button>
          <button
            type="button"
            onClick={gotIt}
            className="px-5 py-2 rounded-lg text-sm font-semibold text-oct-accent border border-oct-accent/80 hover:bg-oct-accent/10 transition-colors"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
