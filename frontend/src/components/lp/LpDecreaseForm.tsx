import { useMemo, useState } from 'react';
import { Check, Loader, Minus } from 'lucide-react';
import { normalizeAddress } from './selection';
import { LP_BTN, LP_BTN_PRIMARY, LP_HELP, LP_INPUT } from './styles';
import {
  DEFAULT_SWAP_SLIPPAGE,
  decreaseIssuesByField,
  validateDecreaseForm,
  type LpDecreaseFormValues,
  type LpDecreaseMode,
  type LpDecreaseRequest,
} from './decrease';
import type { LpPositionView } from './positions';
import { useLpDecrease } from '../../hooks/useLpDecrease';

export interface LpDecreaseFormProps {
  position: LpPositionView;
  enabled: boolean;
  blocked: boolean;
  blockedReason?: string | null;
  onSubmitted: () => void;
}

export default function LpDecreaseForm({ position, enabled, blocked, blockedReason, onSubmitted }: LpDecreaseFormProps) {
  const token0 = position.token0;
  const token1 = position.token1;
  const [values, setValues] = useState<LpDecreaseFormValues>(() => ({
    tokenOutAddress: token0?.address ?? '',
    mode: 'percent',
    percent: '25',
    amount: '',
    slippagePercent: String(DEFAULT_SWAP_SLIPPAGE * 100),
  }));
  const [clientIssues, setClientIssues] = useState(decreaseIssuesByField([]));
  const [done, setDone] = useState(false);
  const decrease = useLpDecrease({ onSuccess: onSubmitted });
  const tokens = useMemo(() => {
    const list = [];
    if (token0?.address) list.push(token0);
    if (token1?.address) list.push(token1);
    return list;
  }, [token0, token1]);
  const fieldErrors = useMemo(
    () => ({ ...clientIssues, ...decreaseIssuesByField(decrease.issues) }),
    [clientIssues, decrease.issues],
  );
  const disabled = !enabled || blocked || decrease.submitting || decrease.unavailable;

  const onSubmit = () => {
    setDone(false);
    const { issues, request } = validateDecreaseForm(values, position);
    setClientIssues(decreaseIssuesByField(issues));
    if (!request) return;
    void decrease.submit(position.tokenId, request).then((result) => {
      if (result.ok) {
        setDone(true);
        setValues((prev) => ({ ...prev, amount: '' }));
      }
    });
  };

  if (done && decrease.lastCommand?.status === 'pending') {
    return (
      <div className="border-2 border-oct-yellow bg-oct-surface-raised px-3 py-2 flex items-center gap-2">
        <Check size={13} className="text-oct-yellow shrink-0" />
        <p className="font-mono text-[11px] text-oct-yellow">Remove liquidity queued — worker will withdraw and swap. Nothing signed here.</p>
      </div>
    );
  }

  return (
    <div className="border-2 border-oct-border bg-oct-surface-raised px-3 py-3 space-y-3">
      <div className="flex items-center gap-2">
        <Minus size={13} className="text-oct-accent shrink-0" />
        <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-oct-text">Remove liquidity</p>
      </div>
      <p className={LP_HELP}>Queues partial withdraw via Krystal withdraw_and_swap to one pool token.</p>
      {blocked && blockedReason && <p className="font-mono text-[11px] text-oct-yellow">{blockedReason}</p>}
      {decrease.conflict && <p className="font-mono text-[11px] text-oct-yellow">{decrease.conflict}</p>}
      {decrease.error && <p className="font-mono text-[11px] text-oct-flame">{decrease.error}</p>}
      <div className="flex flex-wrap gap-2">
        {tokens.map((token) => (
          <button
            key={token.address}
            type="button"
            disabled={disabled}
            onClick={() => setValues((prev) => ({ ...prev, tokenOutAddress: token.address }))}
            className={`${LP_BTN} px-2 py-1 text-[10px] ${
              normalizeAddress(values.tokenOutAddress) === normalizeAddress(token.address)
                ? 'border-oct-accent text-oct-accent bg-oct-accent-dim'
                : 'border-oct-border-bright text-oct-muted'
            }`}
          >
            Receive {token.symbol || token.address.slice(0, 6)}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {(['percent', 'amount'] as LpDecreaseMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            disabled={disabled}
            onClick={() => setValues((prev) => ({ ...prev, mode }))}
            className={`${LP_BTN} px-2 py-1 text-[10px] ${
              values.mode === mode ? 'border-oct-accent text-oct-accent bg-oct-accent-dim' : 'border-oct-border-bright text-oct-muted'
            }`}
          >
            By {mode}
          </button>
        ))}
      </div>
      {values.mode === 'percent' ? (
        <input
          type="text"
          disabled={disabled}
          value={values.percent}
          onChange={(e) => setValues((prev) => ({ ...prev, percent: e.target.value }))}
          className={`${LP_INPUT} w-24`}
          placeholder="25"
        />
      ) : (
        <input
          type="text"
          disabled={disabled}
          value={values.amount}
          onChange={(e) => setValues((prev) => ({ ...prev, amount: e.target.value }))}
          className={`${LP_INPUT} w-full`}
          placeholder="0.0"
        />
      )}
      <input
        type="text"
        disabled={disabled}
        value={values.slippagePercent}
        onChange={(e) => setValues((prev) => ({ ...prev, slippagePercent: e.target.value }))}
        className={`${LP_INPUT} w-24`}
      />
      <button type="button" disabled={disabled} onClick={onSubmit} className={`${LP_BTN_PRIMARY} w-full sm:w-auto`}>
        {decrease.submitting ? <><Loader size={13} className="animate-spin" /> Queueing…</> : 'Queue remove liquidity'}
      </button>
    </div>
  );
}
