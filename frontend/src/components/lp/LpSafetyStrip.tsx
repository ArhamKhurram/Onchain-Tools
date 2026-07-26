import type { ReactNode } from 'react';
import { CircleCheck, Landmark, ShieldCheck, Wallet } from 'lucide-react';
import { LP_CONFIG_VALUE, LP_MONEY_VALUE } from './styles';
import { describeDailyCapacity, formatUsdExact } from './format';

/**
 * The four facts that decide whether this system can spend anything right now:
 * which policy is live, how many pools it may touch, and the two money ceilings.
 *
 * Money tiles carry the accent rail and the display face; the configuration
 * tiles are mono. Nothing here is red-for-alarm — an allowlist of zero is the
 * shipped default and a correct state, so it is styled as calm and deliberate
 * rather than as a fault.
 */

interface TileProps {
  icon: ReactNode;
  label: string;
  value: string;
  sub?: string;
  money?: boolean;
  emphasis?: 'idle' | 'active' | 'none';
}

function Tile({ icon, label, value, sub, money = false, emphasis = 'none' }: TileProps) {
  const frame =
    money
      ? 'border-2 border-oct-accent bg-oct-surface'
      : emphasis === 'active'
        ? 'border-2 border-oct-accent bg-oct-surface'
        : 'border-2 border-oct-border bg-oct-surface';

  return (
    <div className={`${frame} px-4 py-3 flex flex-col gap-1 min-w-0`}>
      <div className="flex items-center gap-1.5 text-oct-muted">
        <span className={money ? 'text-oct-accent' : 'text-oct-muted'}>{icon}</span>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] truncate">{label}</p>
      </div>
      <p className={money ? LP_MONEY_VALUE : LP_CONFIG_VALUE}>{value}</p>
      {sub && (
        <p
          className={`font-mono text-[10px] leading-snug ${
            emphasis === 'idle' ? 'text-oct-muted' : 'text-oct-muted'
          }`}
        >
          {sub}
        </p>
      )}
    </div>
  );
}

interface LpSafetyStripProps {
  activeVersion: number | null;
  hasPolicy: boolean;
  /** Allowlist size as persisted — not the unsaved draft. */
  allowlistSize: number;
  surfacedCount: number;
  maxPositionSizeUsd: number;
  dailySpendCapUsd: number;
}

export default function LpSafetyStrip({
  activeVersion,
  hasPolicy,
  allowlistSize,
  surfacedCount,
  maxPositionSizeUsd,
  dailySpendCapUsd,
}: LpSafetyStripProps) {
  const idle = allowlistSize === 0;

  return (
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
      <Tile
        icon={<ShieldCheck size={13} strokeWidth={2} />}
        label="Active policy"
        value={hasPolicy && activeVersion !== null ? `v${activeVersion}` : 'None yet'}
        sub={
          hasPolicy
            ? 'The version the signer reads. Saving creates the next one.'
            : 'Nothing saved — the automation has no rules to read.'
        }
        emphasis={hasPolicy ? 'active' : 'none'}
      />
      <Tile
        icon={idle ? <CircleCheck size={13} strokeWidth={2} /> : <Landmark size={13} strokeWidth={2} />}
        label="Pools allowlisted"
        value={String(allowlistSize)}
        sub={
          idle
            ? `Idle by design. ${surfacedCount} surfaced, none admitted.`
            : `Admitted by hand out of ${surfacedCount} surfaced.`
        }
        emphasis={idle ? 'idle' : 'active'}
      />
      <Tile
        icon={<Wallet size={13} strokeWidth={2} />}
        label="Max per position"
        value={formatUsdExact(maxPositionSizeUsd)}
        sub="Ceiling on any single LP position."
        money
      />
      <Tile
        icon={<Wallet size={13} strokeWidth={2} />}
        label="Daily spend cap"
        value={formatUsdExact(dailySpendCapUsd)}
        sub={`${describeDailyCapacity(maxPositionSizeUsd, dailySpendCapUsd)} · mirrored on-chain`}
        money
      />
    </div>
  );
}
