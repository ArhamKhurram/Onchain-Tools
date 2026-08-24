import type { ContractEntry } from '../types';

/**
 * What a feed row shows for "call MC → peak MC · X" — or null when there is
 * nothing honest to show.
 *
 * The inputs are the row's own MC@call (`fdvAtCall`) and the token's global
 * peak joined in from the token_peaks store. Two honesty rules shape the
 * output, both inherited from how peaks are collected (see
 * backend/src/alerts/tokenPeakStore.ts):
 *
 * 1. Peaks are *sampled* (every ~3 min plus opportunistic observations), so
 *    every figure is an observed floor — the display language is "≥", never an
 *    exact ATH claim.
 * 2. The peak is global to the token, not to this call. A multiple is only
 *    attributed to the call when the peak observation happened at-or-after the
 *    call — a token that did its run *before* this row's call must not let the
 *    caller wear that run. Missing beats wrong: in that case the row shows
 *    nothing extra.
 */
export interface ContractPeakView {
  /** Peak market cap, compact ("104K"). Always an observed floor. */
  peakDisplay: string;
  /** peak / MC@call, when the peak is at-or-above the call MC. */
  multiple?: number;
  /** "≥10.2×" — absent when the peak sits below the MC@call. */
  multipleDisplay?: string;
  /**
   * True when the observed peak never got above the MC at call — the token
   * only bled after the call, as far as sampling saw.
   */
  belowCall: boolean;
}

export function formatCompactUsd(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

function formatMultiple(value: number): string {
  return `≥${value >= 10 ? value.toFixed(0) : value.toFixed(1)}×`;
}

export function contractPeakView(entry: ContractEntry): ContractPeakView | null {
  const callMc = entry.fdvAtCall;
  const { peakMc, peakAt } = entry;
  if (peakMc == null || !(peakMc > 0)) return null;
  if (callMc == null || !(callMc > 0)) return null;
  if (!peakAt) return null;

  // Only claim the peak for this call if it was observed at-or-after the call.
  // A peak stamped before the row's timestamp means the market cap never
  // exceeded that old high *since* this call — attributing it would credit the
  // caller with a run that predates them.
  const peakMs = new Date(peakAt).getTime();
  const callMs = new Date(entry.timestamp).getTime();
  if (!Number.isFinite(peakMs) || !Number.isFinite(callMs) || peakMs < callMs) return null;

  const view: ContractPeakView = {
    peakDisplay: formatCompactUsd(peakMc),
    belowCall: peakMc < callMc,
  };
  if (peakMc >= callMc) {
    const multiple = peakMc / callMc;
    view.multiple = multiple;
    view.multipleDisplay = formatMultiple(multiple);
  }
  return view;
}
