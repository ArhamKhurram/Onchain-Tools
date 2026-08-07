import { normalizeContractAddress } from '@oct/shared';
import type { Alert } from '../types';

/**
 * Short-window dedupe for "Contract scan" toasts.
 *
 * One call reaches the console as several messages: the caller posts the bare
 * address, then a scanner bot (Rick) replies with an embed carrying the same
 * token — historically in EIP-55 checksummed form, which made the two look
 * unrelated to anything comparing raw strings. Both are genuine detections in
 * their own right, so the feed keeps both rows; only the toast collapses.
 *
 * Addresses are compared canonically, which is chain-aware:
 * `normalizeContractAddress` folds EVM hex to lowercase and leaves
 * case-sensitive base58 Solana mints untouched.
 */
export const CONTRACT_ALERT_DEDUPE_MS = 30_000;

/** address+channel → timestamp of the last toast shown for it. */
export type ContractAlertSeen = Record<string, number>;

/**
 * Dedupe identity of a contract-scan alert, or null when the alert is not a
 * contract scan (or carries no address) and must never be suppressed.
 */
export function contractAlertKey(alert: Alert): string | null {
  if (alert.type !== 'contract_address') return null;
  const address = alert.message.contractAddresses?.[0];
  if (!address) return null;
  return `${normalizeContractAddress(address)}@${alert.message.channelId}`;
}

export interface ContractAlertDedupeResult {
  /** True when an equivalent toast fired inside the window — drop this one. */
  duplicate: boolean;
  /** Next seen-map: pruned of expired keys, stamped with this alert's. */
  seen: ContractAlertSeen;
}

/**
 * Pure dedupe step. Callers keep the returned `seen` map and pass it back in.
 */
export function dedupeContractAlert(
  alert: Alert,
  seen: ContractAlertSeen,
  now: number,
  windowMs: number = CONTRACT_ALERT_DEDUPE_MS,
): ContractAlertDedupeResult {
  const key = contractAlertKey(alert);
  if (!key) return { duplicate: false, seen };

  // Prune first so the map cannot grow without bound across a long session.
  const next: ContractAlertSeen = {};
  for (const [k, at] of Object.entries(seen)) {
    if (now - at < windowMs) next[k] = at;
  }

  const last = next[key];
  const duplicate = last !== undefined && now - last < windowMs;
  // Stamp only the toast that actually showed: a suppressed one must not push
  // the window forward, or a token called on a loop would go silent for good.
  if (!duplicate) next[key] = now;

  return { duplicate, seen: next };
}
