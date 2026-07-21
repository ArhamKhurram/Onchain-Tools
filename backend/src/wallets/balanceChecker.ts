/**
 * On-chain token balance checks for user_holding_wallets (My Wallets).
 * Solana via Helius RPC; EVM via Alchemy or public RPC eth_call balanceOf.
 */

export type WalletChain = 'bsc' | 'ethereum' | 'solana' | 'base' | 'robinhood';

export type BalanceCheckChain = 'solana' | 'ethereum' | 'bsc' | 'base';

export interface TrackedWalletRow {
  id: string;
  address: string;
  chain: WalletChain;
}

export interface BalanceCheckResult {
  holds: boolean;
  walletId?: string;
  balance?: string;
  skipped?: boolean;
  reason?: string;
}

const BALANCE_OF_SELECTOR = '0x70a08231';

function formatCompact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

/** Map contract feed chain to wallet/balance-check chain. Returns null when unsupported. */
export function contractChainToWalletChain(
  contractChain: 'evm' | 'sol',
  evmChain?: string | null,
): BalanceCheckChain | null {
  if (contractChain === 'sol') return 'solana';
  const slug = (evmChain ?? '').toLowerCase();
  if (slug === 'eth' || slug === 'ethereum') return 'ethereum';
  if (slug === 'bsc' || slug === 'bnb') return 'bsc';
  if (slug === 'base') return 'base';
  return null;
}

function walletChainToBalanceChain(chain: WalletChain): BalanceCheckChain | null {
  if (chain === 'robinhood') return null;
  return chain;
}

function rpcUrlForChain(chain: BalanceCheckChain): string | null {
  const alchemy = process.env.ALCHEMY_API_KEY?.trim();
  if (alchemy) {
    const hosts: Record<BalanceCheckChain, string> = {
      ethereum: `https://eth-mainnet.g.alchemy.com/v2/${alchemy}`,
      bsc: `https://bnb-mainnet.g.alchemy.com/v2/${alchemy}`,
      base: `https://base-mainnet.g.alchemy.com/v2/${alchemy}`,
      solana: '',
    };
    if (chain !== 'solana') return hosts[chain];
  }

  const fallbacks: Record<BalanceCheckChain, string> = {
    ethereum: 'https://ethereum.publicnode.com',
    bsc: 'https://bsc.publicnode.com',
    base: 'https://base.publicnode.com',
    solana: '',
  };
  return fallbacks[chain] ?? null;
}

async function heliusRpc<T>(method: string, params: unknown[]): Promise<T | null> {
  const key = process.env.HELIUS_API_KEY?.trim();
  if (!key) return null;
  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'oct', method, params }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const json = await res.json() as { result?: T; error?: { message?: string } };
    if (json.error) {
      console.warn('[BalanceChecker] Helius error:', json.error.message);
      return null;
    }
    return json.result ?? null;
  } catch (err) {
    console.warn('[BalanceChecker] Helius request failed:', (err as Error).message);
    return null;
  }
}

async function evmBalanceOf(
  chain: Exclude<BalanceCheckChain, 'solana'>,
  tokenAddress: string,
  walletAddress: string,
): Promise<bigint | null> {
  const rpc = rpcUrlForChain(chain);
  if (!rpc) return null;

  const data = BALANCE_OF_SELECTOR + walletAddress.slice(2).toLowerCase().padStart(64, '0');
  try {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: tokenAddress, data }, 'latest'],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const json = await res.json() as { result?: string; error?: { message?: string } };
    if (json.error || !json.result || json.result === '0x') return 0n;
    return BigInt(json.result);
  } catch (err) {
    console.warn(`[BalanceChecker] EVM balanceOf failed (${chain}):`, (err as Error).message);
    return null;
  }
}

async function solanaTokenBalance(mint: string, walletAddress: string): Promise<bigint | null> {
  const result = await heliusRpc<{
    value?: { account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } }[];
  }>('getTokenAccountsByOwner', [
    walletAddress,
    { mint },
    { encoding: 'jsonParsed' },
  ]);

  if (!result?.value) return 0n;
  let total = 0n;
  for (const entry of result.value) {
    const amt = entry.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (amt) total += BigInt(amt);
  }
  return total;
}

async function walletHoldsToken(
  wallet: TrackedWalletRow,
  tokenAddress: string,
  balanceChain: BalanceCheckChain,
): Promise<{ holds: boolean; balance?: string } | null> {
  const walletBalanceChain = walletChainToBalanceChain(wallet.chain);
  if (walletBalanceChain !== balanceChain) {
    return { holds: false };
  }

  if (balanceChain === 'solana') {
    if (!process.env.HELIUS_API_KEY?.trim()) return null;
    const bal = await solanaTokenBalance(tokenAddress, wallet.address);
    if (bal === null) return null;
    return { holds: bal > 0n, balance: bal.toString() };
  }

  const bal = await evmBalanceOf(balanceChain, tokenAddress, wallet.address);
  if (bal === null) return null;
  return { holds: bal > 0n, balance: bal.toString() };
}

/**
 * Returns whether any holding wallet holds the token on the matching chain.
 * When chain is unsupported or RPC is unavailable, returns skipped=true (caller must not alert).
 */
export async function checkTokenHeldByWallets(
  tokenAddress: string,
  contractChain: 'evm' | 'sol',
  evmChain: string | null | undefined,
  wallets: TrackedWalletRow[],
): Promise<BalanceCheckResult> {
  const balanceChain = contractChainToWalletChain(contractChain, evmChain);
  if (!balanceChain) {
    return {
      holds: false,
      skipped: true,
      reason: `unsupported chain: ${contractChain}${evmChain ? `/${evmChain}` : ''}`,
    };
  }

  const relevant = wallets.filter((w) => walletChainToBalanceChain(w.chain) === balanceChain);
  if (relevant.length === 0) {
    return {
      holds: false,
      skipped: true,
      reason: `no holding wallets on ${balanceChain}`,
    };
  }

  if (balanceChain === 'solana' && !process.env.HELIUS_API_KEY?.trim()) {
    return { holds: false, skipped: true, reason: 'HELIUS_API_KEY not configured' };
  }

  for (const wallet of relevant) {
    const result = await walletHoldsToken(wallet, tokenAddress, balanceChain);
    if (!result) {
      return { holds: false, skipped: true, reason: 'balance check failed' };
    }
    if (result.holds) {
      return { holds: true, walletId: wallet.id, balance: result.balance };
    }
  }

  return { holds: false };
}

export { formatCompact };
