import { describe, expect, it } from 'vitest';
import { formatLpAlert, toDiscordWebhookBody } from '../src/alerts/format.js';
import { OutOfRangeTracker } from '../src/alerts/outOfRange.js';

const base = (over = {}) => ({
  kind: 'rebalance_fired' as const,
  timestamp: 1,
  tokenId: '395774',
  reason: 'test',
  ...over,
});

describe('formatLpAlert', () => {
  it('formats rebalance alerts', () => {
    const formatted = formatLpAlert(base({ action: 'rebalance', txHash: '0xabc' }));
    expect(formatted.title).toBe('LP rebalance executed');
    expect(formatted.body).toContain('rebalance');
  });

  it('formats failure alerts', () => {
    expect(formatLpAlert(base({ kind: 'action_failed', action: 'enter' })).title).toBe('LP action failed');
  });

  it('formats out-of-range alerts', () => {
    expect(formatLpAlert(base({ kind: 'out_of_range', outOfRangeMinutes: 45 })).body).toContain('45 min');
  });

  it('formats gas alerts', () => {
    expect(formatLpAlert(base({ kind: 'gas_threshold', gasSpentUsd: 1.23 })).body).toContain('$1.2300');
  });
});

describe('toDiscordWebhookBody', () => {
  it('wraps embed', () => {
    expect(toDiscordWebhookBody(base()).embeds).toHaveLength(1);
  });
});

describe('OutOfRangeTracker', () => {
  it('fires once per episode', () => {
    const tracker = new OutOfRangeTracker();
    const pos = (status: 'in_range' | 'out_of_range') =>
      ({ tokenId: '1', status, pool: { address: '0x1234567890123456789012345678901234567890' } }) as any;
    tracker.observe(pos('out_of_range'), 0);
    expect(tracker.shouldAlert('1', 31, 30)).toBe(true);
    tracker.markAlerted('1');
    expect(tracker.shouldAlert('1', 60, 30)).toBe(false);
  });
});
