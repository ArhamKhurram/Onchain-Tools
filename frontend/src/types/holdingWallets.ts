import type { WalletChain } from './wallets';

export interface HoldingWallet {
  id: string;
  user_id: string;
  address: string;
  chain: WalletChain;
  label: string;
  created_at: string;
  updated_at: string;
}

export type HoldingWalletInsert = Pick<HoldingWallet, 'address' | 'chain' | 'label'>;

export type HoldingWalletUpdate = Partial<HoldingWalletInsert>;
