interface ScrollRailProps {
  count: number;
  activeIndex: number;
  onSelect: (index: number) => void;
  visible: boolean;
  /** Light dots for dark sections */
  light?: boolean;
}

export function ScrollRail({ count, activeIndex, onSelect, visible, light = false }: ScrollRailProps) {
  if (!visible) return null;

  return (
    <div className="fixed right-4 sm:right-6 top-1/2 -translate-y-1/2 z-40 flex flex-col gap-2">
      {Array.from({ length: count }).map((_, i) => (
        <button
          key={i}
          type="button"
          aria-label={`Go to section ${i + 1}`}
          onClick={() => onSelect(i)}
          className={`w-2 h-2 rounded-full transition-all duration-300 ${
            i === activeIndex
              ? light ? 'bg-white scale-125' : 'bg-black scale-125'
              : light ? 'bg-white/30 hover:bg-white/60' : 'bg-black/25 hover:bg-black/50'
          }`}
        />
      ))}
    </div>
  );
}
