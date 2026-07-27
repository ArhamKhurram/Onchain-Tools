import { describe, expect, it } from 'vitest';
import {
  ERC20_APPROVE_SELECTOR,
  MAX_UINT256,
  buildErc20Approve,
  isApprovableToken,
  ROBINHOOD_WETH,
} from '../src/calldata/erc20Approve.js';

describe('erc20Approve', () => {
  const safe = '0x2461b1cf2686c3d24e1492219e447c10fe762c64';

  it('builds approve(MAX) calldata to the token contract', () => {
    const tx = buildErc20Approve(
      { chainId: 4663, safe, builtAt: 1 },
      ROBINHOOD_WETH,
      '0xb4acbc082b5e7ded571c98ee4257778a9d784b36',
    );
    expect(tx.to).toBe(ROBINHOOD_WETH);
    expect(tx.value).toBe(0n);
    expect(tx.meta.kind).toBe('erc20_approve');
    expect(tx.meta.selector).toBe(ERC20_APPROVE_SELECTOR);
    expect(tx.data.startsWith(ERC20_APPROVE_SELECTOR)).toBe(true);
  });

  it('recognizes allowlisted zap input tokens case-insensitively', () => {
    expect(isApprovableToken(ROBINHOOD_WETH, [ROBINHOOD_WETH])).toBe(true);
    expect(
      isApprovableToken(ROBINHOOD_WETH.toUpperCase() as typeof ROBINHOOD_WETH, [ROBINHOOD_WETH]),
    ).toBe(true);
    expect(isApprovableToken('0x0000000000000000000000000000000000000001', [ROBINHOOD_WETH])).toBe(
      false,
    );
  });

  it('uses MAX_UINT256 by default', () => {
    const tx = buildErc20Approve(
      { chainId: 4663, safe, builtAt: 1 },
      ROBINHOOD_WETH,
      '0xb4acbc082b5e7ded571c98ee4257778a9d784b36',
    );
    const info = tx.meta.txInfo as { amount: string };
    expect(info.amount).toBe(MAX_UINT256.toString());
  });
});
