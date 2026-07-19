interface OctLogoProps {
  size?: 'sm' | 'md' | 'lg';
  showSubtitle?: boolean;
  className?: string;
}

const sizeMap = {
  sm: { box: 'w-6 h-6 text-[10px]', title: 'text-base', subtitle: 'text-[9px]' },
  md: { box: 'w-8 h-8 text-xs', title: 'text-lg', subtitle: 'text-[10px]' },
  lg: { box: 'w-16 h-16 text-xl sm:text-2xl', title: 'text-3xl sm:text-4xl', subtitle: 'text-xs sm:text-sm' },
};

/** Canonical OCT wordmark — red/black neobrutalist badge. */
export default function OctLogo({ size = 'md', showSubtitle = false, className = '' }: OctLogoProps) {
  const s = sizeMap[size];

  if (size === 'lg') {
    return (
      <div className={`flex flex-col items-center gap-3 ${className}`}>
        <div
          className={`${s.box} rounded-cockpit bg-oct-accent border-2 border-black flex items-center justify-center font-extrabold text-white shadow-oct-hard`}
        >
          OCT
        </div>
        {showSubtitle && (
          <span className={`${s.subtitle} uppercase tracking-[0.2em] text-oct-muted font-bold`}>
            Onchain Tools
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div
        className={`${s.box} rounded-cockpit bg-oct-accent border-2 border-black flex items-center justify-center font-extrabold text-white shadow-oct-hard-sm shrink-0`}
      >
        OCT
      </div>
      <div className="flex flex-col leading-none">
        <span className={`${s.title} font-extrabold text-oct-text tracking-tight`}>OCT</span>
        {showSubtitle && (
          <span className={`${s.subtitle} uppercase tracking-widest text-oct-muted font-bold mt-0.5`}>
            Onchain Tools
          </span>
        )}
      </div>
    </div>
  );
}
