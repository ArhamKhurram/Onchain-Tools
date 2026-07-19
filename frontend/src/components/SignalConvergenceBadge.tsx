import { Zap } from 'lucide-react';
import type { FomoTrade } from '../types/fomo';

interface Props {
  trade: FomoTrade;
  windowMinutes?: number;
}

export default function SignalConvergenceBadge({ trade, windowMinutes = 30 }: Props) {
  const trader = trade.displayName || (trade.fomoHandle ? `@${trade.fomoHandle}` : 'Tracked trader');
  const token = trade.tokenSymbol || 'token';
  const tip = `${trader} bought ${token} within ${windowMinutes}m of this contract call`;

  return (
    <span
      title={tip}
      className="shrink-0 inline-flex items-center gap-0.5 text-[9px] font-mono uppercase px-1.5 py-0.5 rounded-cockpit bg-oct-green/15 text-oct-green"
    >
      <Zap size={10} strokeWidth={2.5} />
      converge
    </span>
  );
}
