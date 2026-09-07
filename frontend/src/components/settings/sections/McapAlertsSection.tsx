import { useCallback, useEffect, useState } from 'react';
import { Filter, RotateCcw } from 'lucide-react';
import {
  EmptyNote,
  Help,
  INPUT_CLASS,
  Kicker,
  SectionHeader,
  SectionStack,
  SettingsCard,
  StatusBox,
  apiBase,
  authedFetch,
} from '../fields';
import { cn } from '../../../lib/utils';

/**
 * Market-cap alert filters — the per-user half of the 750K crossing gates.
 *
 * WHY THIS SECTION DOES NOT USE `useSettingsForm`. Every other section reads
 * and writes `AppConfig` through the shared form and the Save button. These
 * thresholds are validated server-side against a per-field range and REJECTED
 * rather than clamped, so they need per-field error reporting that the shared
 * form has no shape for — and they are deliberately absent from the
 * `/api/config` PUT whitelist so the validating route is the only write path.
 * The section therefore owns its own state and talks to
 * `/api/mcap-cross/filters` directly, the way the Portfolio and FOMO surfaces
 * own theirs.
 *
 * DIRECTION IS IN EVERY LABEL. A tax filter is a CEILING ("don't alert me on
 * high-tax tokens") and a liquidity filter is a FLOOR; naming them "Max…" and
 * "Min…" is the only thing standing between the two, and a mislabelled filter
 * that reads correctly is worse than one that errors.
 */

interface GateConfig {
  minLiquidityUsd: number;
  minLiquidityToMcapRatio: number;
  maxTop10HolderRate: number;
  maxTaxRate: number;
  /** Null = the filter is OFF, not "zero". See the note on FIELDS below. */
  minVolume24hUsd: number | null;
  requireLpSecured: boolean;
}

type FilterKey =
  | 'minLiquidityUsd'
  | 'minLiquidityToMcapRatio'
  | 'maxTop10HolderRate'
  | 'maxTaxRate'
  | 'minVolume24hUsd';

interface FilterView {
  filters: Partial<Record<FilterKey, number>>;
  effective: GateConfig;
  defaults: GateConfig;
  shipped: GateConfig;
  targetMcapUsd: number;
}

/**
 * Field metadata. `unit` decides how the stored fraction is shown: percentages
 * are typed as percentages because nobody thinks in 0.02, and converted back at
 * the boundary — the wire format stays fractions so the server never has to
 * guess which one it received.
 */
const FIELDS: {
  key: FilterKey;
  label: string;
  unit: 'usd' | 'percent';
  step: number;
  help: string;
}[] = [
  {
    key: 'minLiquidityUsd',
    label: 'Min liquidity',
    unit: 'usd',
    step: 1000,
    help: 'Pooled USD floor. Below this a $750K market cap is a number you cannot actually sell into.',
  },
  {
    key: 'minLiquidityToMcapRatio',
    label: 'Min liquidity / market cap',
    unit: 'percent',
    step: 0.1,
    help: 'Catches the fake-mcap shape — a 900K "market cap" sitting on 4K of pooled value.',
  },
  {
    key: 'maxTop10HolderRate',
    label: 'Max top-10 holder concentration',
    unit: 'percent',
    step: 1,
    help: 'Ceiling on how much of the supply the ten biggest wallets hold. LP accounts are excluded.',
  },
  {
    key: 'maxTaxRate',
    label: 'Max buy/sell tax',
    unit: 'percent',
    step: 0.5,
    help: 'Ceiling on transfer tax, each way. BNB and Robinhood only — a transfer-tax honeypot cannot exist on Solana, so this never filters Solana alerts.',
  },
  {
    key: 'minVolume24hUsd',
    label: 'Min 24h volume',
    unit: 'usd',
    step: 10000,
    help: 'Traded USD in the last day, added up across every pool. Off unless you set it. Works on all three chains — and where no volume figure is reported the alert is skipped rather than let through, so this can never pass a token it could not measure.',
  },
];

const toDisplay = (unit: 'usd' | 'percent', value: number): string =>
  unit === 'percent' ? String(Number((value * 100).toFixed(4))) : String(value);

const toWire = (unit: 'usd' | 'percent', raw: string): number => {
  const n = Number(raw);
  return unit === 'percent' ? n / 100 : n;
};

/**
 * What a blank box inherits. `null` is not zero — it is "this gate is not
 * evaluated at all", which only `minVolume24hUsd` can be, and calling it "off"
 * is the only wording that does not imply a threshold of some value.
 */
const formatInherited = (unit: 'usd' | 'percent', value: number | null): string => {
  if (value == null) return 'off';
  return unit === 'percent'
    ? `${Number((value * 100).toFixed(4))}%`
    : `$${value.toLocaleString('en-US')}`;
};

export default function McapAlertsSection() {
  const [view, setView] = useState<FilterView | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<FilterKey, string>>>({});
  const [status, setStatus] = useState<{ tone: 'good' | 'critical'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** Re-seed the inputs from the server's answer, so a rejected edit snaps back. */
  const adopt = useCallback((next: FilterView) => {
    setView(next);
    const seeded: Partial<Record<FilterKey, string>> = {};
    for (const field of FIELDS) {
      const own = next.filters[field.key];
      if (own !== undefined) seeded[field.key] = toDisplay(field.unit, own);
    }
    setDrafts(seeded);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch(`${apiBase}/mcap-cross/filters`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as FilterView;
        if (!cancelled) adopt(data);
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adopt]);

  const save = async (body: Record<string, number | null>) => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await authedFetch(`${apiBase}/mcap-cross/filters`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus({ tone: 'critical', text: data?.error ?? `HTTP ${res.status}` });
        return;
      }
      adopt(data as FilterView);
      setStatus({ tone: 'good', text: 'Filters saved.' });
    } catch (err) {
      setStatus({ tone: 'critical', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const commit = (key: FilterKey, unit: 'usd' | 'percent') => {
    const raw = (drafts[key] ?? '').trim();
    // An emptied box is not zero — it is "go back to inheriting", which is the
    // only way to un-set an override and the reason null travels on the wire.
    if (raw === '') return void save({ [key]: null });
    const value = toWire(unit, raw);
    if (!Number.isFinite(value)) {
      setStatus({ tone: 'critical', text: 'That is not a number.' });
      return;
    }
    void save({ [key]: value });
  };

  const resetAll = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await authedFetch(`${apiBase}/mcap-cross/filters`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        setStatus({ tone: 'critical', text: data?.error ?? `HTTP ${res.status}` });
        return;
      }
      adopt(data as FilterView);
      setStatus({ tone: 'good', text: 'Back to the shipped thresholds.' });
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <SectionStack>
        <SectionHeader title="Market-cap alerts" />
        <StatusBox tone="critical">Could not load your filters: {loadError}</StatusBox>
      </SectionStack>
    );
  }

  if (!view) {
    return (
      <SectionStack>
        <SectionHeader title="Market-cap alerts" />
        <EmptyNote>Loading…</EmptyNote>
      </SectionStack>
    );
  }

  const overrideCount = Object.keys(view.filters).length;

  return (
    <SectionStack>
      <SectionHeader
        title="Market-cap alerts"
        blurb={
          <>
            Which market-cap crossings reach you. These are yours alone — nobody
            else&apos;s alerts change. Anything you leave blank inherits the
            default shown beside it.
          </>
        }
      />

      <SettingsCard
        icon={<Filter size={16} />}
        title={`Crossing target: $${view.targetMcapUsd.toLocaleString('en-US')}`}
        blurb="The level a token has to cross to be considered at all. Set by the operator and shared by everyone — the crossing is tracked once per token, not once per person."
      />

      <SettingsCard
        title="Your filters"
        blurb="Rates are entered as percentages. A blank box means you have no opinion and the default applies."
      >
        <div className="space-y-comfy">
          {FIELDS.map((field) => {
            const inherited = view.defaults[field.key];
            const isOverridden = view.filters[field.key] !== undefined;
            return (
              <div
                key={field.key}
                className="rounded-oct border border-oct-border bg-oct-surface-raised px-comfy py-cozy"
              >
                <div className="flex items-baseline justify-between gap-cozy">
                  <label
                    htmlFor={`mcap-${field.key}`}
                    className="block type-label text-oct-text mb-snug"
                  >
                    {field.label}
                  </label>
                  <Kicker className={cn(isOverridden && 'text-oct-accent')}>
                    {isOverridden ? 'yours' : `default ${formatInherited(field.unit, inherited)}`}
                  </Kicker>
                </div>
                <div className="flex items-center gap-cozy">
                  {field.unit === 'usd' && <span className="type-data text-oct-muted">$</span>}
                  <input
                    id={`mcap-${field.key}`}
                    type="number"
                    inputMode="decimal"
                    step={field.step}
                    min={0}
                    disabled={busy}
                    className={INPUT_CLASS}
                    placeholder={inherited == null ? 'off' : toDisplay(field.unit, inherited)}
                    value={drafts[field.key] ?? ''}
                    onChange={(e) =>
                      setDrafts((d) => ({ ...d, [field.key]: e.target.value }))
                    }
                    onBlur={() => commit(field.key, field.unit)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commit(field.key, field.unit);
                    }}
                  />
                  {field.unit === 'percent' && <span className="type-data text-oct-muted">%</span>}
                </div>
                <Help className="mt-snug">{field.help}</Help>
              </div>
            );
          })}
        </div>

        {status && (
          <StatusBox tone={status.tone === 'good' ? 'good' : 'critical'} className="mt-comfy">
            {status.text}
          </StatusBox>
        )}

        <div className="mt-comfy flex items-center gap-cozy">
          <button
            type="button"
            onClick={resetAll}
            disabled={busy || overrideCount === 0}
            className="oct-btn-primary inline-flex items-center gap-snug px-comfy py-snug type-label disabled:opacity-50"
          >
            <RotateCcw size={13} />
            Reset to defaults
          </button>
          <Help>
            {overrideCount === 0
              ? 'No overrides — you are on the shipped thresholds.'
              : `${overrideCount} filter${overrideCount === 1 ? '' : 's'} overridden.`}
          </Help>
        </div>
      </SettingsCard>

      <SettingsCard title="What these filters cannot do">
        <ul className="space-y-snug type-body text-oct-muted list-disc pl-5">
          <li>
            They never turn an unknown into a pass. If the security provider could
            not answer for a token — or, with a volume floor set, if no volume
            figure was reported — it is skipped rather than let through,
            regardless of what you set here.
          </li>
          <li>
            A honeypot check that was never run is still shown as unevaluated on
            the alert. No threshold suppresses that warning.
          </li>
          <li>
            LP burn/lock stays a required check and is not adjustable — switching
            it off would turn &quot;no record of this LP&quot; into &quot;this LP
            is fine&quot;.
          </li>
          <li>
            Telegram alerts still use the operator thresholds: a chat has no
            single owner whose filters would apply.
          </li>
        </ul>
      </SettingsCard>
    </SectionStack>
  );
}
