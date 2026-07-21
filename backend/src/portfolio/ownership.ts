import { getFomoServiceClient } from '../fomo/store.js';
import { isHostedMode } from '../storage/index.js';
import type { OctWalletChain } from './gmgnWallet.js';

/**
 * Verify the requested address belongs to one of the user's My Wallets on any of
 * the given OCT chains. For EVM wallets we pass all EVM OCT chains so a wallet
 * saved under (say) `base` can be viewed aggregated across eth/base/bsc.
 */
export async function userOwnsHoldingWallet(
  userId: string,
  octChains: OctWalletChain[],
  address: string,
  isSolana: boolean,
): Promise<boolean> {
  if (!isHostedMode()) return true;
  if (octChains.length === 0) return false;

  const client = getFomoServiceClient();
  if (!client) return false;

  const normalized = isSolana ? address.trim() : address.trim().toLowerCase();
  const { data, error } = await client
    .from('user_holding_wallets')
    .select('id')
    .eq('user_id', userId)
    .in('chain', octChains)
    .ilike('address', normalized)
    .limit(1);

  if (error) {
    console.error('[Portfolio] ownership check failed:', error.message);
    return false;
  }

  return Array.isArray(data) && data.length > 0;
}
