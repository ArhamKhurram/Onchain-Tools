import { describe, expect, it } from 'vitest';
import {
  buildSlimSweepConfig,
  canSendPushover,
  resolveMissedRunnerConfig,
  resolveNotifyVia,
} from '../src/alerts/missedRunnerPoller.js';
import { buildContractUrl } from '../src/utils/contract.js';
import type { AppConfig } from '../src/discord/types.js';

// The sweep no longer fetches the full settings JSONB per user; it assembles a
// working config from the three subtrees it consumes. These tests lock the
// decision-equivalence between that slim config and a full getConfig() merge
// for everything processUser touches.

const PUSHOVER = {
  enabled: true,
  appToken: 'app-token',
  userKey: 'user-key',
  priority: 1 as const,
  sound: 'siren' as const,
  triggers: { missedRunner: true },
  filters: { userIds: [], channelIds: [], guildIds: [] },
};

describe('buildSlimSweepConfig', () => {
  it('maps the three subtrees through to the sweep decisions', () => {
    const config = buildSlimSweepConfig({
      missed_runner: { enabled: true, minMultiplier: 2, notifyVia: 'both' },
      pushover: PUSHOVER,
      link_templates: { evmPlatform: 'gmgn', solPlatform: 'axiom' },
    });

    const mr = resolveMissedRunnerConfig(config);
    expect(mr.enabled).toBe(true);
    expect(mr.minMultiplier).toBe(2);
    // Unset fields still pick up the sweep defaults.
    expect(mr.lookbackHours).toBe(24);
    expect(mr.cooldownHours).toBe(24);
    expect(resolveNotifyVia(config, mr)).toBe('both');
    expect(canSendPushover(config)).toBe(true);
  });

  it('a user with no saved subtrees resolves exactly like the merged defaults', () => {
    const config = buildSlimSweepConfig({});
    const mr = resolveMissedRunnerConfig(config);
    expect(mr.enabled).toBe(false);
    expect(mr.minMultiplier).toBe(1.5);
    expect(resolveNotifyVia(config, mr)).toBe('toast');
    expect(canSendPushover(config)).toBe(false);
  });

  it('tolerates a missing row (user_configs has no row for the user)', () => {
    const config = buildSlimSweepConfig(null);
    expect(resolveMissedRunnerConfig(config).enabled).toBe(false);
    expect(canSendPushover(config)).toBe(false);
  });

  it('empty link templates build the same URLs as the stored defaults', () => {
    const slim = buildSlimSweepConfig({});
    // DEFAULT_SETTINGS stores gmgn/axiom platform presets; an absent subtree
    // must resolve to the same preset URLs via buildContractUrl's fallbacks.
    const defaults: AppConfig['contractLinkTemplates'] = {
      evm: 'https://gmgn.ai/base/token/{address}',
      sol: 'https://axiom.trade/t/{address}?chain=sol',
      solPlatform: 'axiom',
      evmPlatform: 'gmgn',
    };
    const evmAddr = '0xabcdef1234567890abcdef1234567890abcdef12';
    const solAddr = 'So11111111111111111111111111111111111111112';
    expect(buildContractUrl(evmAddr, slim.contractLinkTemplates, 'base')).toBe(
      buildContractUrl(evmAddr, defaults, 'base'),
    );
    expect(buildContractUrl(solAddr, slim.contractLinkTemplates)).toBe(
      buildContractUrl(solAddr, defaults),
    );
  });

  it('custom link templates saved by the user pass through untouched', () => {
    const slim = buildSlimSweepConfig({
      link_templates: {
        evm: 'https://example.com/{address}',
        sol: 'https://example.com/sol/{address}',
        evmPlatform: 'custom',
        solPlatform: 'custom',
      },
    });
    expect(
      buildContractUrl('0xabcdef1234567890abcdef1234567890abcdef12', slim.contractLinkTemplates),
    ).toBe('https://example.com/0xabcdef1234567890abcdef1234567890abcdef12');
  });
});
