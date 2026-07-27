export type LpAlertKind = 'rebalance_fired' | 'action_failed' | 'out_of_range' | 'gas_threshold';

export interface LpAlertPayload {
  kind: LpAlertKind;
  timestamp: number;
  tokenId: string | null;
  poolAddress?: string;
  action?: string;
  reason: string;
  txHash?: string | null;
  gasSpentUsd?: number;
  outOfRangeMinutes?: number;
}
