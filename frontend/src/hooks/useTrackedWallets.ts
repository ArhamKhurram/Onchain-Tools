import { useWalletCrud } from './useWalletCrud';
import type { TrackedWallet, TrackedWalletInsert, TrackedWalletUpdate } from '../types/wallets';

export function useTrackedWallets(userId: string | undefined) {
  return useWalletCrud<TrackedWallet, TrackedWalletInsert, TrackedWalletUpdate>('user_tracked_wallets', userId);
}
