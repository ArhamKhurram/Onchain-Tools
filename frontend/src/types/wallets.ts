export type WalletChain = 'bsc' | 'ethereum' | 'solana';

export interface TrackedWallet {
  id: string;
  user_id: string;
  address: string;
  chain: WalletChain;
  name: string;
  emoji: string;
  profile: string;
  alerts_on_toast: boolean;
  alerts_on_feed: boolean;
  alerts_on_bubble: boolean;
  sound: string;
  created_at: string;
  updated_at: string;
}

export type TrackedWalletInsert = Pick<
  TrackedWallet,
  'address' | 'chain' | 'name' | 'emoji' | 'profile' | 'alerts_on_toast' | 'alerts_on_feed' | 'alerts_on_bubble' | 'sound'
>;

export type TrackedWalletUpdate = Partial<TrackedWalletInsert>;

export const WALLET_CHAINS: { value: WalletChain | 'all'; label: string }[] = [
  { value: 'all', label: 'All chains' },
  { value: 'ethereum', label: 'Ethereum' },
  { value: 'bsc', label: 'BSC' },
  { value: 'solana', label: 'Solana' },
];

export const CHAIN_META: Record<WalletChain, { label: string; short: string; color: string }> = {
  ethereum: { label: 'Ethereum', short: 'ETH', color: '#627eea' },
  bsc: { label: 'BSC', short: 'BSC', color: '#f0b90b' },
  solana: { label: 'Solana', short: 'SOL', color: '#9945ff' },
};

export function validateWalletAddress(address: string, chain: WalletChain): string | null {
  const trimmed = address.trim();
  if (!trimmed) return 'Address is required';
  if (chain === 'solana') {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) {
      return 'Invalid Solana address (base58, 32–44 chars)';
    }
  } else if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
    return 'Invalid EVM address (0x + 40 hex chars)';
  }
  return null;
}

export function truncateAddress(address: string, head = 6, tail = 4): string {
  if (address.length <= head + tail + 2) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}
