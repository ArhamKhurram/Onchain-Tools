interface OctLogoProps {
  size?: 'sm' | 'md' | 'lg';
  showSubtitle?: boolean;
  className?: string;
}

const sizeMap = {
  sm: { box: 'w-6 h-6 text-xs', title: 'text-base', subtitle: 'text-[9px]' },
  md: { box: 'w-8 h-8 text-sm', title: 'text-lg', subtitle: 'text-[10px]' },
  lg: { box: 'w-20 h-20 sm:w-24 sm:h-24 text-2xl sm:text-3xl', title: 'text-4xl sm:text-6xl lg:text-7xl', subtitle: 'text-xs sm:text-sm' },
};

export function OctLogo({ size = 'md', showSubtitle = false, className = '' }: OctLogoProps) {
  const s = sizeMap[size];

  if (size === 'lg') {
    return (
      <div className={`flex flex-col items-center gap-3 ${className}`}>
        <div
          className={`${s.box} rounded-2xl bg-oct-surface border border-oct-accent/30 flex items-center justify-center font-bold text-oct-accent shadow-oct-glow`}
        >
          OCT
        </div>
        {showSubtitle && (
          <span className={`${s.subtitle} uppercase tracking-[0.2em] text-oct-muted font-medium`}>
            Onchain Tools
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div
        className={`${s.box} rounded-md bg-oct-surface border border-oct-accent/30 flex items-center justify-center font-bold text-oct-accent shrink-0`}
      >
        OCT
      </div>
      <div className="flex flex-col leading-none">
        <span className={`${s.title} font-bold text-oct-text tracking-tight`}>OCT</span>
        {showSubtitle && (
          <span className={`${s.subtitle} uppercase tracking-widest text-oct-muted font-medium mt-0.5`}>
            Onchain Tools
          </span>
        )}
      </div>
    </div>
  );
}
