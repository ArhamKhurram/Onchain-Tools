import { Trophy, Radio, Zap, LayoutGrid, Rocket, Wifi, PieChart } from 'lucide-react';
import type { UpdateSlide, UpdateSlideVariant } from '../../data/updates';

function RadarMock() {
  return (
    <div className="w-full max-w-[280px] mx-auto space-y-1.5 opacity-90">
      <div className="flex gap-1 text-[8px] font-mono uppercase text-oct-muted">
        <span className="text-oct-accent">Latest ↓</span>
        <span>Mentions</span>
        <span>Callers</span>
      </div>
      {['$PEPE', '$WIF', '$BONK'].map((t, i) => (
        <div
          key={t}
          className={`flex items-center gap-2 px-2 py-1.5 rounded border ${
            i === 0 ? 'border-oct-accent/60 bg-oct-accent/10' : 'border-oct-border/40 bg-oct-surface/50'
          }`}
        >
          <span className="font-mono text-[10px] text-oct-text font-bold">{t}</span>
          <span className="ml-auto font-mono text-[9px] text-oct-muted">{3 - i}m</span>
        </div>
      ))}
    </div>
  );
}

function FomoMock() {
  return (
    <div className="w-full max-w-[260px] mx-auto space-y-2">
      {['0xAvast', 'gake', 'trader_x'].map((h, i) => (
        <div key={h} className="flex items-center justify-between px-3 py-2 rounded border border-oct-border/50 bg-oct-surface/60">
          <span className="font-mono text-[10px] text-oct-text">@{h}</span>
          <span className={`text-[9px] font-mono ${i === 0 ? 'text-green-400' : 'text-oct-muted'}`}>
            {i === 0 ? '+$91K' : '·'}
          </span>
        </div>
      ))}
    </div>
  );
}

function ConvergenceMock() {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-center gap-2">
        <div className="px-2 py-1 rounded border border-oct-border bg-oct-surface text-[9px] font-mono">Feed call</div>
        <Zap size={14} className="text-oct-accent" />
        <div className="px-2 py-1 rounded border border-oct-accent/50 bg-oct-accent/10 text-[9px] font-mono text-oct-accent">
          FOMO buy
        </div>
      </div>
      <div className="font-mono text-lg font-bold text-oct-text">$TOKEN</div>
    </div>
  );
}

function PortfolioMock() {
  return (
    <div className="w-full max-w-[280px] mx-auto space-y-2">
      <div className="grid grid-cols-3 gap-1.5">
        {[
          { label: 'Realized', val: '+$4.2K' },
          { label: 'Win rate', val: '62%' },
          { label: 'Holdings', val: '$18K' },
        ].map(({ label, val }) => (
          <div key={label} className="px-2 py-1.5 rounded border border-oct-border/50 bg-oct-surface/60 text-center">
            <div className="text-[8px] font-mono uppercase text-oct-muted">{label}</div>
            <div className="text-[10px] font-mono font-bold text-oct-text">{val}</div>
          </div>
        ))}
      </div>
      <div className="flex gap-1 text-[8px] font-mono text-oct-muted justify-center">
        <span className="px-1 border border-black/40 text-oct-accent">ETH</span>
        <span className="px-1 border border-black/40">BASE</span>
        <span className="px-1 border border-black/40">BSC</span>
      </div>
    </div>
  );
}

function FeedMock() {
  return (
    <div className="w-full max-w-[280px] mx-auto px-3 py-2 rounded border border-oct-border/50 bg-oct-surface/60">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm font-bold text-oct-text">$TICKER</span>
        <span className="text-[9px] font-mono text-oct-live">$1.2M MC</span>
      </div>
      <div className="mt-1 text-[9px] font-mono text-oct-muted truncate">7xK…pump · Rick enriched</div>
    </div>
  );
}

const VARIANT_ICON: Record<UpdateSlideVariant, typeof Rocket> = {
  radar: LayoutGrid,
  fomo: Trophy,
  convergence: Zap,
  feed: Radio,
  landing: Rocket,
  gateway: Wifi,
  portfolio: PieChart,
  default: Rocket,
};

export function SlideHero({ slide }: { slide: UpdateSlide }) {
  if (slide.image) {
    return (
      <img
        src={slide.image}
        alt=""
        className="w-full h-full object-cover object-top opacity-90"
      />
    );
  }

  const Icon = VARIANT_ICON[slide.variant ?? 'default'];

  return (
    <div className="relative w-full h-full flex flex-col items-center justify-center p-6 bg-gradient-to-b from-oct-surface via-oct-bg to-black overflow-hidden">
      <div
        className="absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            'radial-gradient(circle at 50% 30%, var(--oct-accent, #ff3b3b) 0%, transparent 55%)',
        }}
      />
      <div className="relative z-10 w-full">
        {slide.variant === 'radar' && <RadarMock />}
        {slide.variant === 'fomo' && <FomoMock />}
        {slide.variant === 'convergence' && <ConvergenceMock />}
        {slide.variant === 'feed' && <FeedMock />}
        {slide.variant === 'portfolio' && <PortfolioMock />}
        {(slide.variant === 'landing' || slide.variant === 'gateway' || slide.variant === 'default' || !slide.variant) && (
          <Icon size={48} className="mx-auto text-oct-accent/80" strokeWidth={1.25} />
        )}
      </div>
    </div>
  );
}
