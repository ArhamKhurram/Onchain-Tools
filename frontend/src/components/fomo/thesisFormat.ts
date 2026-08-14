// Pure presentation helpers for the FOMO theses board. Kept in their own module
// (no React) so they can be unit-tested in the node-env Vitest project, and so
// the board and any future thesis surface format position/PnL identically to the
// holders board.

const NETWORK_LABELS: Record<number, string> = {
  1: 'ETH',
  56: 'BSC',
  143: 'HOOD',
  8453: 'BASE',
  1399811149: 'SOL',
};

/** FOMO network id → short chain label, or the raw id when unknown. */
export function networkLabel(networkId: number): string {
  return NETWORK_LABELS[networkId] ?? String(networkId);
}

/** Compact USD magnitude ($1.2M, $999, —). Matches FomoHoldersBoard. */
export function compactUsd(value: number | null | undefined): string {
  if (value == null) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(abs / 1e3).toFixed(1)}K`;
  return `$${abs.toFixed(0)}`;
}

/** Signed compact USD (+$4.2K / -$120) for PnL. */
export function signedUsd(value: number): string {
  const sign = value >= 0 ? '+' : '-';
  return `${sign}${compactUsd(Math.abs(value))}`;
}

/** Middle-truncated address for tight rows. */
export function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
