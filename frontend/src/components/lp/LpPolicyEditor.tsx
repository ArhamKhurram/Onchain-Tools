import type { ReactNode } from 'react';
import { Coins, Filter, Repeat, Scale, Timer } from 'lucide-react';
import LpNumberField from './LpNumberField';
import LpPolicyToggle from './LpPolicyToggle';
import LpSegmentedField from './LpSegmentedField';
import { LP_PANEL, LP_PANEL_HEADER, LP_PANEL_TITLE, LP_READOUT } from './styles';
import {
  describeCapital,
  describeCompound,
  describeRangeStrategy,
  describeRebalance,
  describeSurfacing,
  describeSwitching,
} from './explain';
import { LP_CHAIN_LABELS, ROBINHOOD_CHAIN_ID } from './types';
import type { RangeStrategy } from './types';
import type { PolicyDraft } from './policyDraft';

const RANGE_STRATEGY_OPTIONS: ReadonlyArray<{ value: RangeStrategy; label: string }> = [
  { value: 'narrow', label: 'Narrow' },
  { value: 'wide', label: 'Wide' },
  { value: 'full', label: 'Full range' },
];

/**
 * The policy form. Every field of `AutomationPolicy` except `version` (assigned
 * by the server) and `allowedPools` (ticked in the pool picker, because a list
 * of addresses typed into a text box is not a control surface anyone should
 * trust with money).
 *
 * Help text is lifted from the reasoning in `lp-automation/src/policy/defaults.ts`
 * — the defaults were argued for, and the argument is more useful to an operator
 * than the field name is.
 */

interface GroupProps {
  icon: ReactNode;
  title: string;
  blurb: string;
  readout: string;
  children: ReactNode;
}

function Group({ icon, title, blurb, readout, children }: GroupProps) {
  return (
    <section className={LP_PANEL}>
      <div className={LP_PANEL_HEADER}>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-oct-accent shrink-0">{icon}</span>
          <h3 className={LP_PANEL_TITLE}>{title}</h3>
        </div>
      </div>
      <div className="px-4 py-4 space-y-4">
        <p className="font-mono text-[11px] text-oct-muted leading-relaxed">{blurb}</p>
        {children}
        <p className={LP_READOUT}>{readout}</p>
      </div>
    </section>
  );
}

interface LpPolicyEditorProps {
  draft: PolicyDraft;
  onChange: (next: PolicyDraft) => void;
  errors: Record<string, string>;
  disabled?: boolean;
}

export default function LpPolicyEditor({ draft, onChange, errors, disabled = false }: LpPolicyEditorProps) {
  const setTop = (key: 'maxPositionSizeUsd' | 'dailySpendCapUsd') => (value: string) =>
    onChange({ ...draft, [key]: value });

  const setCriteria = (key: keyof PolicyDraft['poolSelectionCriteria']) => (value: string) =>
    onChange({ ...draft, poolSelectionCriteria: { ...draft.poolSelectionCriteria, [key]: value } });

  const setCompound = (key: keyof PolicyDraft['compoundTrigger']) => (value: string) =>
    onChange({ ...draft, compoundTrigger: { ...draft.compoundTrigger, [key]: value } });

  const setCompoundEnabled = (enabled: boolean) =>
    onChange({ ...draft, compoundTrigger: { ...draft.compoundTrigger, enabled } });

  const setRebalance = (key: 'rangeExitPercent') => (value: string) =>
    onChange({ ...draft, rebalanceTrigger: { ...draft.rebalanceTrigger, [key]: value } });

  const setRebalanceEnabled = (enabled: boolean) =>
    onChange({ ...draft, rebalanceTrigger: { ...draft.rebalanceTrigger, enabled } });

  const setRangeStrategy = (value: RangeStrategy) =>
    onChange({ ...draft, rebalanceTrigger: { ...draft.rebalanceTrigger, rangeStrategy: value } });

  const setBuffer = (key: keyof PolicyDraft['switchingBuffer']) => (value: string) =>
    onChange({ ...draft, switchingBuffer: { ...draft.switchingBuffer, [key]: value } });

  return (
    <div className="space-y-4">
      <Group
        icon={<Coins size={14} strokeWidth={2} />}
        title="Capital limits"
        blurb="The only two numbers on this page that cap how much can be lost. Both are set deliberately small — raising them takes seconds, walking back a realized loss does not."
        readout={describeCapital(draft)}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <LpNumberField
            label="Max position size"
            field="maxPositionSizeUsd"
            value={draft.maxPositionSizeUsd}
            onChange={setTop('maxPositionSizeUsd')}
            money
            defaultHint="default $250"
            error={errors.maxPositionSizeUsd}
            disabled={disabled}
            help="Ceiling on a single LP position. Small enough that a total loss of one position is tuition rather than an event — and on a chain this young it is also the main lever on your own slippage."
          />
          <LpNumberField
            label="Daily spend cap"
            field="dailySpendCapUsd"
            value={draft.dailySpendCapUsd}
            onChange={setTop('dailySpendCapUsd')}
            money
            defaultHint="default $500"
            error={errors.dailySpendCapUsd}
            disabled={disabled}
            help="Most the automation may deploy in a rolling 24h. This value alone enforces nothing — the binding limit is the same cap written into the on-chain Module. It exists so the off-chain side refuses first, cheaply, instead of learning the limit from a reverted transaction."
          />
        </div>
      </Group>

      <Group
        icon={<Filter size={14} strokeWidth={2} />}
        title="Pool selection criteria"
        blurb="These filters decide what appears in the candidate table. They never admit a pool — that takes an explicit tick in the allowlist."
        readout={describeSurfacing(draft)}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <LpNumberField
            label="Min TVL"
            field="poolSelectionCriteria.minTvlUsd"
            value={draft.poolSelectionCriteria.minTvlUsd}
            onChange={setCriteria('minTvlUsd')}
            money
            defaultHint="default $250,000"
            error={errors['poolSelectionCriteria.minTvlUsd']}
            disabled={disabled}
            help="Pools holding less than this never reach the table. Sparse results on a four-week-old chain are a real signal about the chain, not a broken filter — three pools beats thirty."
          />
          <LpNumberField
            label="Min 24h volume"
            field="poolSelectionCriteria.min24hVolumeUsd"
            value={draft.poolSelectionCriteria.min24hVolumeUsd}
            onChange={setCriteria('min24hVolumeUsd')}
            money
            defaultHint="default $50,000"
            error={errors['poolSelectionCriteria.min24hVolumeUsd']}
            disabled={disabled}
            help="Fees are paid out of volume. A pool with deep TVL and no trading pays nothing while still carrying full impermanent-loss exposure."
          />
          <LpNumberField
            label="Max IL risk score"
            field="poolSelectionCriteria.maxIlRiskScore"
            value={draft.poolSelectionCriteria.maxIlRiskScore}
            onChange={setCriteria('maxIlRiskScore')}
            unit="0–100"
            defaultHint="default 40"
            error={errors['poolSelectionCriteria.maxIlRiskScore']}
            disabled={disabled}
            help="Higher is riskier. 40 keeps to the calmer half while the scoring model itself is still being decided. A pool with no computed score fails this check — unknown is not treated as safe."
          />
          <div className="border-2 border-oct-border bg-oct-bg px-3 py-2.5">
            <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-oct-text font-semibold mb-1.5">
              Chain
            </p>
            <p className="font-mono text-sm text-oct-text">
              {LP_CHAIN_LABELS[draft.chain]}{' '}
              <span className="text-oct-muted">· id {ROBINHOOD_CHAIN_ID}</span>
            </p>
            <p className="font-mono text-[11px] text-oct-muted leading-relaxed mt-1.5">
              Fixed for phase 1. The on-chain Module's destination allowlist is chain-specific, so a
              policy naming another chain could only ever fail on-chain.
            </p>
          </div>
        </div>
      </Group>

      <Group
        icon={<Repeat size={14} strokeWidth={2} />}
        title="Compound trigger"
        blurb="When to claim fees and put them back to work. Whichever condition fires first wins."
        readout={describeCompound(draft)}
      >
        <LpPolicyToggle
          label="Auto-compound"
          enabled={draft.compoundTrigger.enabled}
          onChange={setCompoundEnabled}
          disabled={disabled}
          help="When on, the worker compounds fees on its own when the thresholds below are met. When off, only manual compound commands fire."
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <LpNumberField
            label="Min fees vs gas"
            field="compoundTrigger.minFeesVsGasRatio"
            value={draft.compoundTrigger.minFeesVsGasRatio}
            onChange={setCompound('minFeesVsGasRatio')}
            unit="× gas"
            defaultHint="default 3.0×"
            error={errors['compoundTrigger.minFeesVsGasRatio']}
            disabled={disabled}
            help="Compound only once claimable fees are worth this multiple of the gas cost to claim them. At 2× a gas spike between the decision and the broadcast can turn a marginal compound into a net loss; 3× leaves headroom. Anything below 1.0 is rejected — it spends more than it collects."
          />
          <LpNumberField
            label="Max interval (hours)"
            field="compoundTrigger.maxIntervalHours"
            value={draft.compoundTrigger.maxIntervalHours}
            onChange={setCompound('maxIntervalHours')}
            unit="hours"
            defaultHint="default 24h"
            error={errors['compoundTrigger.maxIntervalHours']}
            disabled={disabled}
            help="Backstop only — not a schedule. Auto-compound normally fires when unclaimed fees exceed the gas ratio above. Max interval means: even if fees are tiny, claim and reinvest at least once every N hours so nothing sits unclaimed forever. Setting this too low wastes gas on compounds the ratio would never justify."
          />
        </div>
      </Group>

      <Group
        icon={<Scale size={14} strokeWidth={2} />}
        title="Rebalance trigger"
        blurb="How far price may wander outside a position's range before the range is moved to follow it, and where the new range is placed when it is."
        readout={describeRebalance(draft)}
      >
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <LpPolicyToggle
            label="Auto-rebalance"
            enabled={draft.rebalanceTrigger.enabled}
            onChange={setRebalanceEnabled}
            disabled={disabled}
            help="When on, the worker re-centers the range on its own when price leaves by the threshold below. When off, only manual rebalance commands fire."
          />
          <p className="font-mono text-[11px] text-oct-muted sm:text-right shrink-0">
            Range strategy:{' '}
            <span className="text-oct-text font-semibold capitalize">{draft.rebalanceTrigger.rangeStrategy}</span>
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <LpNumberField
            label="Range exit threshold"
            field="rebalanceTrigger.rangeExitPercent"
            value={draft.rebalanceTrigger.rangeExitPercent}
            onChange={setRebalance('rangeExitPercent')}
            unit="%"
            defaultHint="default 5%"
            error={errors['rebalanceTrigger.rangeExitPercent']}
            disabled={disabled}
            help="Tighter than about 5% and ordinary volatility rebalances the position repeatedly, paying gas each time to chase price. Wider leaves the position out of range — earning nothing — for longer."
          />
        </div>
        <LpSegmentedField
          label="Range strategy"
          field="rebalanceTrigger.rangeStrategy"
          value={draft.rebalanceTrigger.rangeStrategy}
          onChange={setRangeStrategy}
          options={RANGE_STRATEGY_OPTIONS}
          defaultHint="default narrow"
          error={errors['rebalanceTrigger.rangeStrategy']}
          disabled={disabled}
          help="Where the new range is placed on every rebalance. Set once here — it drives both automatic rebalances and the manual Rebalance button, with no per-action dialog."
        />
        <p className={LP_READOUT}>{describeRangeStrategy(draft)}</p>
      </Group>

      <Group
        icon={<Timer size={14} strokeWidth={2} />}
        title="Switching buffer"
        blurb="Both conditions must hold before capital leaves one pool for another. A momentary one-tick advantage must never trigger a move."
        readout={describeSwitching(draft)}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <LpNumberField
            label="Min efficiency delta"
            field="switchingBuffer.minEfficiencyDeltaPercent"
            value={draft.switchingBuffer.minEfficiencyDeltaPercent}
            onChange={setBuffer('minEfficiencyDeltaPercent')}
            unit="pp APR"
            defaultHint="default 5pp"
            error={errors['switchingBuffer.minEfficiencyDeltaPercent']}
            disabled={disabled}
            help="Percentage points of annualized net efficiency the rival pool must be ahead by. The candidate has to be meaningfully better, not noise-better — the round trip costs real gas and slippage on both legs."
          />
          <LpNumberField
            label="Sustained for"
            field="switchingBuffer.sustainedDurationMinutes"
            value={draft.switchingBuffer.sustainedDurationMinutes}
            onChange={setBuffer('sustainedDurationMinutes')}
            unit="minutes"
            defaultHint="default 60 min"
            error={errors['switchingBuffer.sustainedDurationMinutes']}
            disabled={disabled}
            help="How long that advantage must hold continuously. This is the half of the buffer that kills a transient crossover: an hour is long enough that a single block's worth of APR noise cannot survive it."
          />
        </div>
      </Group>
    </div>
  );
}
