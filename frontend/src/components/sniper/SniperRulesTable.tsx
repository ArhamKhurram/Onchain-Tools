import { useState } from 'react';
import { Crosshair, Plus } from 'lucide-react';
import ConfirmModal from '../ConfirmModal';
import ConsoleEmptyState from '../console/ConsoleEmptyState';
import SniperRuleFormModal from './SniperRuleFormModal';
import SniperFireModal from './SniperFireModal';
import SniperBadge from './SniperBadge';
import {
  describeValidationReason,
  type SnipeRule,
  type SniperFeeSettings,
  type SniperWallet,
} from '../../types/sniper';
import type { useSniperRules } from '../../hooks/useSniperRules';
import { cn } from '../../lib/utils';

const TH = 'px-comfy py-snug font-semibold';
const TD = 'px-comfy py-snug';
const ROW_BTN =
  'px-cozy py-hair rounded-oct-sm type-caption font-mono font-bold uppercase border border-oct-border text-oct-muted hover:text-oct-text hover:border-oct-border-bright transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
// The fire button is the one ACTION on the row, so it alone wears the accent
// — outlined, filling on hover. Every status colour on this row is semantic
// (good / warn / critical), so nothing else can be mistaken for it.
const FIRE_BTN =
  'px-cozy py-hair rounded-oct-sm type-caption font-mono font-bold uppercase border border-oct-accent text-oct-accent hover:bg-oct-accent hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-oct-accent';

interface SniperRulesTableProps {
  rules: ReturnType<typeof useSniperRules>;
  wallets: SniperWallet[];
  /**
   * Account-level tip + priority fee, inherited by every rule that does not
   * override it. Threaded into the form and the fire modal so both previews
   * show the fees the server will actually reserve.
   */
  fees: SniperFeeSettings;
  processDryRun: boolean;
  /** Kill switch state — a fire is pointless while it is on, so the button says so. */
  killed: boolean;
}

function StateBadge({ state }: { state: SnipeRule['state'] }) {
  // Only `armed` gets its own styling; `draft` and `disabled` share the muted
  // look. Armed is `warn`, not the accent: it means "may be fired live", which
  // is a caution, not a brand moment.
  return <SniperBadge tone={state === 'armed' ? 'warn' : 'neutral'}>{state}</SniperBadge>;
}

export default function SniperRulesTable({ rules, wallets, fees, processDryRun, killed }: SniperRulesTableProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SnipeRule | null>(null);
  const [arming, setArming] = useState<SnipeRule | null>(null);
  const [goingLive, setGoingLive] = useState<SnipeRule | null>(null);
  const [deleting, setDeleting] = useState<SnipeRule | null>(null);
  const [firing, setFiring] = useState<SnipeRule | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const doArm = async () => {
    if (!arming) return;
    const res = await rules.armRule(arming.id);
    setArming(null);
    // Arm runs the full validateRule server-side and refuses with the exact
    // reason. Showing that reason verbatim (plus plain words) is the whole point
    // — "couldn't arm" would leave the operator guessing which field is wrong.
    //
    // These are VALIDATION reasons, not abort reasons. Sending them through
    // describeAbortReason fell through to `default` for 20 of the 22 cases, so
    // a rule saved without a wallet showed a bare `no_wallets` in a truncated
    // header label, and arm looked like a button that did nothing.
    if (!res.ok) setNotice(res.detail ? `${res.reason} — ${res.detail}` : describeValidationReason(res.reason));
    else setNotice(null);
  };

  const doGoLive = async () => {
    if (!goingLive) return;
    const res = await rules.setDryRun(goingLive.id, false);
    setGoingLive(null);
    if (!res.ok) {
      setNotice(
        res.reason === 'process_dry_run'
          ? 'OCT_SNIPER_DRY_RUN is set on the backend. It overrides every rule flag, so no rule can go live until it is cleared.'
          : describeValidationReason(res.reason),
      );
    } else setNotice(null);
  };

  const doDelete = async () => {
    if (!deleting) return;
    const res = await rules.deleteRule(deleting.id);
    setDeleting(null);
    if (!res.ok) {
      setNotice(
        res.reason === 'rule_armed'
          ? 'Disarm the rule before deleting it.'
          : describeValidationReason(res.reason),
      );
    }
  };

  if (!rules.loading && rules.rules.length === 0) {
    return (
      <>
        <ConsoleEmptyState
          icon={Crosshair}
          eyebrow="[ SNIPER · RULES ]"
          title="No snipe rules"
          description="A rule is a saved buy: which mint, how much, from which wallets, behind which caps. It is born as a dry-run draft and fires only when you press the button."
          actionLabel="NEW RULE"
          onActionClick={openAdd}
        />
        <SniperRuleFormModal
          open={formOpen}
          mode="add"
          wallets={wallets}
          fees={fees}
          onClose={() => setFormOpen(false)}
          onSubmit={rules.createRule}
        />
      </>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0 bg-oct-bg overflow-hidden">
      <div className="oct-headerbar shrink-0 flex items-center gap-comfy px-roomy py-cozy">
        <span className="oct-eyebrow">view: rules</span>
        <div className="flex-1" />
        <span className="type-data text-oct-muted">{rules.rules.length} rules</span>
        <button
          type="button"
          onClick={openAdd}
          className="oct-icon-btn flex items-center gap-snug px-cozy py-snug type-label uppercase"
        >
          <Plus size={12} />
          new rule
        </button>
      </div>

      {/*
        Full width, wrapping, and dismissible. This used to be a truncated
        11px label wedged into the toolbar above, which is how "arm" could
        refuse three times in a row and read as a dead button.
      */}
      {notice && (
        <div className="shrink-0 flex items-start gap-cozy px-roomy py-cozy border-b border-oct-border border-l-4 border-l-oct-critical bg-oct-critical-dim">
          <span className="flex-1 font-mono text-xs leading-relaxed text-oct-critical">{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="shrink-0 type-caption font-mono uppercase text-oct-muted hover:text-oct-text"
          >
            dismiss
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto overscroll-contain" style={{ overflowAnchor: 'none' }}>
        <table className="w-full text-left border-collapse min-w-[1000px]">
          <thead className="oct-thead sticky top-0 z-10">
            <tr className="type-caption font-mono uppercase tracking-wider text-oct-muted">
              <th className={TH}>Name</th>
              <th className={TH}>State</th>
              <th className={TH}>Mode</th>
              <th className={TH}>Mint</th>
              <th className={`${TH} text-right`}>Size</th>
              <th className={`${TH} text-right`}>Wallets</th>
              <th className={`${TH} text-right`}>Per fire</th>
              <th className={`${TH} text-right`}>Per trigger</th>
              <th className={`${TH} text-right`}>Slippage</th>
              <th className={TH} />
            </tr>
          </thead>
          <tbody>
            {rules.rules.map((r) => {
              // The process flag overrides the rule flag, so a rule is only
              // really live when neither says dry-run.
              const live = !processDryRun && !r.dryRun;
              const armedLive = live && r.state === 'armed';
              return (
                <tr
                  key={r.id}
                  // "Which of these spends real money" has to be readable at a
                  // glance, not by reading two columns and combining them. Amber,
                  // because armed-and-live is the caution state of this table.
                  className={cn(
                    'border-b border-oct-border/50 oct-row-hover',
                    armedLive && 'border-l-2 border-l-oct-warn bg-oct-warn-dim',
                  )}
                >
                  <td className={`${TD} type-body text-oct-text`}>{r.name}</td>
                  <td className={TD}>
                    <StateBadge state={r.state} />
                  </td>
                  <td className={TD}>
                    <SniperBadge tone={live ? 'warnSolid' : 'good'}>{live ? 'live' : 'dry'}</SniperBadge>
                  </td>
                  <td className={`${TD} type-data text-oct-text`} title={r.mint ?? undefined}>
                    {r.mint ? `${r.mint.slice(0, 6)}…${r.mint.slice(-4)}` : '—'}
                  </td>
                  <td className={`${TD} type-data text-oct-text text-right`}>
                    {r.sizeTotal} {r.sizeUnit}
                  </td>
                  <td className={`${TD} type-data text-oct-muted text-right`}>{r.walletIds.length}</td>
                  <td className={`${TD} type-data text-oct-text text-right`}>{r.perFireCap}</td>
                  <td className={`${TD} type-data text-oct-text text-right`}>{r.perTriggerCap}</td>
                  <td className={`${TD} type-data text-oct-muted text-right`}>{r.slippageBps}</td>
                  <td className={TD}>
                    <div className="flex items-center justify-end gap-snug flex-wrap">
                      {r.state === 'armed' ? (
                        <button type="button" onClick={() => void rules.disarmRule(r.id)} className={ROW_BTN}>
                          disarm
                        </button>
                      ) : (
                        <button type="button" onClick={() => setArming(r)} className={ROW_BTN}>
                          arm
                        </button>
                      )}
                      {r.dryRun ? (
                        <button type="button" onClick={() => setGoingLive(r)} className={ROW_BTN}>
                          go live
                        </button>
                      ) : (
                        <button type="button" onClick={() => void rules.setDryRun(r.id, true)} className={ROW_BTN}>
                          back to dry
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setFiring(r)}
                        disabled={killed}
                        title={killed ? 'The kill switch is on — console fires are blocked.' : undefined}
                        className={FIRE_BTN}
                      >
                        fire
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(r);
                          setFormOpen(true);
                        }}
                        disabled={r.state === 'armed'}
                        title={r.state === 'armed' ? 'Disarm before editing.' : undefined}
                        className={ROW_BTN}
                      >
                        edit
                      </button>
                      <button type="button" onClick={() => setDeleting(r)} className={ROW_BTN}>
                        delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <SniperRuleFormModal
        open={formOpen}
        mode={editing ? 'edit' : 'add'}
        rule={editing}
        wallets={wallets}
        fees={fees}
        onClose={() => setFormOpen(false)}
        onSubmit={(draft) => (editing ? rules.updateRule(editing.id, draft) : rules.createRule(draft))}
      />

      <SniperFireModal
        open={!!firing}
        rule={firing}
        wallets={wallets}
        fees={fees}
        processDryRun={processDryRun}
        onClose={() => setFiring(null)}
        onFire={rules.fireRule}
      />

      <ConfirmModal
        open={!!arming}
        title="Arm this rule?"
        message={
          'Armed means one thing and only one thing: this rule may be fired LIVE by the fire button. It does not make ' +
          'OCT watch anything — the automatic path still runs inside Slotshark.'
        }
        confirmLabel="Arm"
        onConfirm={() => void doArm()}
        onCancel={() => setArming(null)}
      />

      <ConfirmModal
        open={!!goingLive}
        title="Take this rule off dry run?"
        message={
          'A fire from this rule will then spend real funds from its wallets, up to its caps. This is a separate act ' +
          'from arming and from editing — nothing else changes it.'
        }
        confirmLabel="Go live"
        onConfirm={() => void doGoLive()}
        onCancel={() => setGoingLive(null)}
      />

      <ConfirmModal
        open={!!deleting}
        title="Delete this rule?"
        message="Its fire history survives — every row of money it moved stays in the log with the rule reference nulled out."
        confirmLabel="Delete"
        onConfirm={() => void doDelete()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
