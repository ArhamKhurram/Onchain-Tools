import { useWalletCrud } from './useWalletCrud';
import type { HoldingWallet, HoldingWalletInsert, HoldingWalletUpdate } from '../types/holdingWallets';

export function useHoldingWallets(userId: string | undefined) {
  return useWalletCrud<HoldingWallet, HoldingWalletInsert, HoldingWalletUpdate>('user_holding_wallets', userId);
}
