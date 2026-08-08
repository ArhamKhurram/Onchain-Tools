// The Slotshark Twitter Sniper config serializers.
//
// Every case here is a documented vendor trap or a documented silent failure.
// Two of them cost money rather than a 400 — the ca_scanner solAmount omission
// (buys size at 0 SOL and never fill) and the PATCH array replacement (a
// three-handle patch discards the other forty-seven) — so they get the most
// coverage.

import { describe, it, expect } from 'vitest';
import {
  buildFullBody,
  buildPatchBody,
  normalizeHandle,
  type CaScannerSnipeParams,
  type EngagementParams,
  type FollowUnfollowParams,
  type MentionParams,
  type TwitterConfigBody,
  type TwitterConfigInput,
  type TwitterConfigPatch,
  type TwitterConfigReason,
  type TwitterConfigResult,
} from '../src/sniper/venue/slotsharkTwitterConfig';

const MINT = 'So11111111111111111111111111111111111111112';

const reasonOf = (r: TwitterConfigResult<TwitterConfigBody>): TwitterConfigReason | null =>
  r.ok ? null : r.reason;

/** The body, or a failure that fails the test loudly instead of silently. */
function bodyOf(r: TwitterConfigResult<TwitterConfigBody>): TwitterConfigBody {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}${r.detail ? `: ${r.detail}` : ''}`);
  return r.value;
}

const paramsOf = (r: TwitterConfigResult<TwitterConfigBody>): Record<string, unknown> =>
  bodyOf(r).params as Record<string, unknown>;

function scanner(over: Partial<Extract<TwitterConfigInput, { mode: 'ca_scanner' }>> = {}): TwitterConfigInput {
  return {
    mode: 'ca_scanner',
    name: 'scanner',
    params: {
      targetHandles: ['elon'],
      triggers: { mainTweet: true, retweet: false, quote: false, reply: false },
    },
    snipeParams: { solAmount: 0.5 },
    ...over,
  } as TwitterConfigInput;
}

function mention(over: Partial<MentionParams> = {}): TwitterConfigInput {
  return {
    mode: 'mention',
    name: 'mention',
    params: {
      targetHandle: 'elon',
      targetTriggers: { tweet: true, retweet: false, reply: false, quote: false, bioUpdate: false },
      tokenAddress: MINT,
      sizing: { kind: 'buy', amount: 0.5 },
      ...over,
    },
  };
}

function engagement(over: Partial<EngagementParams> = {}): TwitterConfigInput {
  return {
    mode: 'engagement',
    name: 'engagement',
    params: {
      targetHandle: 'elon',
      targetActions: { reply: true, retweet: false, quote: false },
      tokenAddress: MINT,
      sizing: { kind: 'buy', amount: 0.5 },
      ...over,
    },
  };
}

function followUnfollow(over: Partial<FollowUnfollowParams> = {}): TwitterConfigInput {
  return {
    mode: 'follow_unfollow',
    name: 'fu',
    params: {
      followerHandles: ['elon'],
      followedHandles: ['jack'],
      fireOnFollow: true,
      fireOnUnfollow: false,
      tokenAddress: MINT,
      sizing: { kind: 'buy', amount: 0.5 },
      ...over,
    },
  };
}

// ---------------------------------------------------------------------------

describe('the singular/plural keyword split', () => {
  it('writes PLURAL keywordsInclude/Exclude for ca_scanner', () => {
    const p = paramsOf(
      buildFullBody(
        scanner({
          params: {
            targetHandles: ['elon'],
            triggers: { mainTweet: true, retweet: false, quote: false, reply: false },
            keywordsInclude: ['doge'],
            keywordsExclude: ['rug'],
          },
        }),
      ),
    );
    expect(p.keywordsInclude).toEqual(['doge']);
    expect(p.keywordsExclude).toEqual(['rug']);
    expect(p.keywordInclude).toBeUndefined();
    expect(p.keywordExclude).toBeUndefined();
  });

  it('writes PLURAL for mention too', () => {
    const p = paramsOf(buildFullBody(mention({ keywordsInclude: ['doge'] })));
    expect(p.keywordsInclude).toEqual(['doge']);
    expect(p.keywordInclude).toBeUndefined();
  });

  it('writes SINGULAR keywordInclude/Exclude for engagement, and only engagement', () => {
    // This is the documented trap: engagement alone spells them singular, and
    // sending the plural form to it is a 400. A shared field-writer would send
    // one spelling to all five modes.
    const p = paramsOf(buildFullBody(engagement({ keywordInclude: ['doge'], keywordExclude: ['rug'] })));
    expect(p.keywordInclude).toEqual(['doge']);
    expect(p.keywordExclude).toEqual(['rug']);
    expect(p.keywordsInclude).toBeUndefined();
    expect(p.keywordsExclude).toBeUndefined();
  });

  it('keeps the split on the PATCH path as well', () => {
    const engagementPatch = buildPatchBody({
      mode: 'engagement',
      params: { keywordInclude: { replaceAll: ['doge'] } },
    });
    const scannerPatch = buildPatchBody({
      mode: 'ca_scanner',
      params: { keywordsInclude: { replaceAll: ['doge'] } },
    });
    expect((bodyOf(engagementPatch).params as Record<string, unknown>).keywordInclude).toEqual(['doge']);
    expect((bodyOf(scannerPatch).params as Record<string, unknown>).keywordsInclude).toEqual(['doge']);
  });

  it('refuses an empty keyword rather than dropping it', () => {
    // '' matches every tweet: as an include it disables the filter the operator
    // thought they set, as an exclude it silences the config. Both are silent.
    expect(reasonOf(buildFullBody(mention({ keywordsInclude: ['doge', '  '] })))).toBe('invalid_keyword');
  });

  it('omits an empty keyword list on create but SENDS it on patch', () => {
    // On create an empty list says nothing. On patch it is the only way to say
    // "clear the filter", and omitting it would make the request a silent no-op.
    expect(paramsOf(buildFullBody(mention({ keywordsInclude: [] }))).keywordsInclude).toBeUndefined();
    const patched = buildPatchBody({ mode: 'mention', params: { keywordsInclude: { replaceAll: [] } } });
    expect((bodyOf(patched).params as Record<string, unknown>).keywordsInclude).toEqual([]);
  });
});

describe('amount vs sellPercent exclusivity', () => {
  it('sends amount alone for a buy', () => {
    const p = paramsOf(buildFullBody(mention({ sizing: { kind: 'buy', amount: 0.5 } })));
    expect(p.amount).toBe(0.5);
    expect(p.sellPercent).toBeUndefined();
  });

  it('sends sellPercent alone for a sell', () => {
    const p = paramsOf(buildFullBody(mention({ sizing: { kind: 'sell', sellPercent: 50 } })));
    expect(p.sellPercent).toBe(50);
    expect(p.amount).toBeUndefined();
  });

  it('lets follow_unfollow carry BOTH — the one documented exception', () => {
    // amount fires on follow, sellPercent on unfollow.
    const p = paramsOf(
      buildFullBody(followUnfollow({ sizing: { kind: 'both', amount: 0.5, sellPercent: 100 } })),
    );
    expect(p.amount).toBe(0.5);
    expect(p.sellPercent).toBe(100);
  });

  it('rejects a non-positive amount', () => {
    expect(reasonOf(buildFullBody(mention({ sizing: { kind: 'buy', amount: 0 } })))).toBe('invalid_amount');
  });

  it('rejects a sellPercent outside 0-100', () => {
    expect(reasonOf(buildFullBody(mention({ sizing: { kind: 'sell', sellPercent: 101 } })))).toBe(
      'invalid_sell_percent',
    );
  });

  it('never lets a patch reintroduce the both-at-once body', () => {
    // The one-level merge can ADD a key but cannot remove one, so patching
    // `amount` onto a config carrying `sellPercent` produces the 400. Sizing is
    // therefore absent from every patch type — and because each params writer
    // emits from an allow-list, an untyped caller cannot smuggle it through
    // either: the keys are dropped, the patch collapses to nothing, and it is
    // refused rather than sent as a silent no-op.
    const both = { mode: 'mention', params: { amount: 1, sellPercent: 50 } } as unknown as TwitterConfigPatch;
    expect(reasonOf(buildPatchBody(both))).toBe('empty_patch');

    // Alongside a real edit the sizing keys still never reach the wire.
    const withName = {
      mode: 'mention',
      name: 'renamed',
      params: { amount: 1 },
    } as unknown as TwitterConfigPatch;
    expect(bodyOf(buildPatchBody(withName))).toEqual({ name: 'renamed' });
  });

  it('refuses a snipeParams.solAmount on a mode that sizes from params', () => {
    // Two sizing fields with no documented precedence. Refusing costs a save;
    // accepting risks buying the wrong size on every fire.
    const input = { ...mention(), snipeParams: { solAmount: 5 } } as TwitterConfigInput;
    expect(reasonOf(buildFullBody(input))).toBe('sol_amount_not_allowed');
  });
});

describe('the ca_scanner solAmount requirement', () => {
  it('accepts a scanner that declares its size', () => {
    expect(bodyOf(buildFullBody(scanner())).snipeParams).toEqual({ solAmount: 0.5 });
  });

  it('refuses a scanner with no solAmount', () => {
    // Without it every buy sizes at 0 SOL and silently never fills — no error,
    // no fill, no trace. This has to be a hard local refusal, not a hope.
    const input = { ...scanner(), snipeParams: {} } as unknown as TwitterConfigInput;
    expect(reasonOf(buildFullBody(input))).toBe('ca_scanner_requires_sol_amount');
  });

  it('refuses a scanner with no snipeParams at all', () => {
    const input = { ...scanner(), snipeParams: undefined } as unknown as TwitterConfigInput;
    expect(reasonOf(buildFullBody(input))).toBe('ca_scanner_requires_sol_amount');
  });

  it('refuses a scanner whose solAmount is zero', () => {
    const sp = { solAmount: 0 } as CaScannerSnipeParams;
    expect(reasonOf(buildFullBody(scanner({ snipeParams: sp })))).toBe('invalid_snipe_params');
  });

  it('carries no tokenAddress — the mint is discovered at fire time', () => {
    expect(paramsOf(buildFullBody(scanner())).tokenAddress).toBeUndefined();
  });
});

describe('handle normalization', () => {
  it('strips a leading @, lowercases and trims', () => {
    expect(normalizeHandle('  @ElonMusk ')).toBe('elonmusk');
  });

  it('accepts underscores and digits, the full legal alphabet', () => {
    expect(normalizeHandle('a_1')).toBe('a_1');
  });

  it('refuses anything that is not 1-15 legal characters', () => {
    for (const bad of ['', '@', 'a'.repeat(16), 'has space', 'has-dash', '@@elon', 'x.com/elon']) {
      expect(normalizeHandle(bad)).toBeNull();
    }
  });

  it('normalizes every handle in a list', () => {
    const p = paramsOf(
      buildFullBody(
        scanner({
          params: {
            targetHandles: ['@Elon', 'JACK'],
            triggers: { mainTweet: true, retweet: false, quote: false, reply: false },
          },
        }),
      ),
    );
    expect(p.targetHandles).toEqual(['elon', 'jack']);
  });

  it('deduplicates AFTER normalizing, because normalizing creates duplicates', () => {
    const p = paramsOf(
      buildFullBody(
        scanner({
          params: {
            targetHandles: ['@Elon', 'elon', 'ELON'],
            triggers: { mainTweet: true, retweet: false, quote: false, reply: false },
          },
        }),
      ),
    );
    expect(p.targetHandles).toEqual(['elon']);
  });

  it('refuses one bad handle rather than silently tracking the rest', () => {
    // A dropped handle is a caller who thinks they are watching an account they
    // are not. Refusing the save is the visible failure.
    const input = scanner({
      params: {
        targetHandles: ['elon', 'not a handle'],
        triggers: { mainTweet: true, retweet: false, quote: false, reply: false },
      },
    });
    expect(reasonOf(buildFullBody(input))).toBe('invalid_handle');
  });

  it('enforces the documented 1-50 bound on the deduplicated list', () => {
    const many = Array.from({ length: 51 }, (_, i) => `handle${i}`);
    const triggers = { mainTweet: true, retweet: false, quote: false, reply: false };
    expect(reasonOf(buildFullBody(scanner({ params: { targetHandles: many, triggers } })))).toBe(
      'too_many_handles',
    );
    expect(reasonOf(buildFullBody(scanner({ params: { targetHandles: [], triggers } })))).toBe('no_handles');
  });

  it('normalizes both handle lists on follow_unfollow', () => {
    const p = paramsOf(buildFullBody(followUnfollow({ followerHandles: ['@A'], followedHandles: ['@B'] })));
    expect(p.followerHandles).toEqual(['a']);
    expect(p.followedHandles).toEqual(['b']);
  });

  it('normalizes reactedToHandles on engagement', () => {
    const p = paramsOf(
      buildFullBody(engagement({ scope: { kind: 'reactedTo', reactedToHandles: ['@Jack'] } })),
    );
    expect(p.reactedToHandles).toEqual(['jack']);
    expect(p.targetTweetId).toBeUndefined();
  });
});

describe('PATCH array-replacement semantics', () => {
  it('replaces the whole handle list, and says so in the type', () => {
    // The vendor merges params one level deep but REPLACES arrays. Sending two
    // of five handles leaves the config tracking two. `replaceAll` is the word
    // a caller has to type to do that.
    const body = bodyOf(
      buildPatchBody({ mode: 'ca_scanner', params: { targetHandles: { replaceAll: ['@Elon', 'jack'] } } }),
    );
    expect((body.params as Record<string, unknown>).targetHandles).toEqual(['elon', 'jack']);
  });

  it('replaces the whole limitSells ladder', () => {
    const body = bodyOf(
      buildPatchBody({
        mode: 'ca_scanner',
        snipeParams: { limitSells: { replaceAll: [{ type: 'pnl', sellPercent: 50, value: -30 }] } },
      }),
    );
    expect((body.snipeParams as Record<string, unknown>).limitSells).toEqual([
      { type: 'pnl', sellPercent: 50, value: -30 },
    ]);
  });

  it('sends an empty replaceAll for limitSells — that is how a ladder is cleared', () => {
    const body = bodyOf(
      buildPatchBody({ mode: 'ca_scanner', snipeParams: { limitSells: { replaceAll: [] } } }),
    );
    expect((body.snipeParams as Record<string, unknown>).limitSells).toEqual([]);
  });

  it('leaves an array untouched when the patch omits it', () => {
    const body = bodyOf(buildPatchBody({ mode: 'ca_scanner', snipeParams: { slippage: 5 } }));
    expect((body.snipeParams as Record<string, unknown>).limitSells).toBeUndefined();
    expect((body.snipeParams as Record<string, unknown>).slippage).toBe(5);
  });

  it('never emits modeType, because the mode cannot be changed after create', () => {
    const body = bodyOf(buildPatchBody({ mode: 'pfp_update', name: 'renamed' }));
    expect(body.modeType).toBeUndefined();
    expect(body).toEqual({ name: 'renamed' });
  });

  it('refuses a patch that would send an empty body', () => {
    // The vendor would answer 200 having changed nothing — the one outcome an
    // operator cannot tell apart from a successful edit.
    expect(reasonOf(buildPatchBody({ mode: 'mention' }))).toBe('empty_patch');
    expect(reasonOf(buildPatchBody({ mode: 'mention', params: {} }))).toBe('empty_patch');
  });

  it('still enforces the handle bounds on a replacement', () => {
    expect(
      reasonOf(buildPatchBody({ mode: 'ca_scanner', params: { targetHandles: { replaceAll: [] } } })),
    ).toBe('no_handles');
  });

  it('demands the fireOnFollow/fireOnUnfollow pair together', () => {
    // Half the pair is uncheckable: fireOnFollow:false patched onto a config
    // whose fireOnUnfollow is already false leaves it firing on nothing.
    expect(
      reasonOf(buildPatchBody({ mode: 'follow_unfollow', params: { fireOnFollow: false } })),
    ).toBe('no_trigger_selected');
    expect(
      reasonOf(
        buildPatchBody({
          mode: 'follow_unfollow',
          params: { fireOnFollow: false, fireOnUnfollow: false },
        }),
      ),
    ).toBe('no_trigger_selected');
  });
});

describe('trigger selections that would never fire', () => {
  it('requires ca_scanner mainTweet OR retweet', () => {
    const input = scanner({
      params: {
        targetHandles: ['elon'],
        triggers: { mainTweet: false, retweet: false, quote: true, reply: true },
      },
    });
    expect(reasonOf(buildFullBody(input))).toBe('no_trigger_selected');
  });

  it('requires at least one mention trigger', () => {
    const input = mention({
      targetTriggers: { tweet: false, retweet: false, reply: false, quote: false, bioUpdate: false },
    });
    expect(reasonOf(buildFullBody(input))).toBe('no_trigger_selected');
  });

  it('requires at least one engagement action', () => {
    const input = engagement({ targetActions: { reply: false, retweet: false, quote: false } });
    expect(reasonOf(buildFullBody(input))).toBe('no_trigger_selected');
  });

  it('requires follow_unfollow to fire on something', () => {
    expect(reasonOf(buildFullBody(followUnfollow({ fireOnFollow: false, fireOnUnfollow: false })))).toBe(
      'no_trigger_selected',
    );
  });
});

describe('snipeParams', () => {
  it('keeps fees, slippage and ladders inside snipeParams, never at the top level', () => {
    const body = bodyOf(
      buildFullBody(
        scanner({
          snipeParams: {
            solAmount: 1,
            slippage: 5,
            tip: 0.001,
            sellTip: 0.002,
            limitSells: [{ type: 'time', sellPercent: 100, value: 300 }],
          },
        }),
      ),
    );
    expect(Object.keys(body).sort()).toEqual(['modeType', 'name', 'params', 'snipeParams']);
    const sp = body.snipeParams as Record<string, unknown>;
    expect(sp.tip).toBe(0.001);
    expect(sp.sellTip).toBe(0.002);
  });

  it('drops unknown keys instead of forwarding them', () => {
    // The body is assembled from an allow-list; a caller's stray key cannot
    // ride along and become a 400 nobody can explain.
    const sp = { solAmount: 1, nonsense: true } as unknown as CaScannerSnipeParams;
    expect(bodyOf(buildFullBody(scanner({ snipeParams: sp }))).snipeParams).toEqual({ solAmount: 1 });
  });

  it('caps slippage at 100%, matching the executor', () => {
    // Above 100% is not a tolerance, it is the absence of one — the same
    // reasoning as toVenueSlippagePercent on the money path.
    const sp = { solAmount: 1, slippage: 500 } as CaScannerSnipeParams;
    expect(reasonOf(buildFullBody(scanner({ snipeParams: sp })))).toBe('invalid_snipe_params');
  });

  it('bounds migrationBuffer to 0-5000 bps and requires an integer', () => {
    const over = { solAmount: 1, migrationBuffer: 5001 } as CaScannerSnipeParams;
    const fractional = { solAmount: 1, migrationBuffer: 10.5 } as CaScannerSnipeParams;
    expect(reasonOf(buildFullBody(scanner({ snipeParams: over })))).toBe('invalid_snipe_params');
    expect(reasonOf(buildFullBody(scanner({ snipeParams: fractional })))).toBe('invalid_snipe_params');
  });

  it('refuses a window whose floor is above its ceiling', () => {
    // Matches nothing, which reads as a dead config rather than a bad filter.
    const sp = { solAmount: 1, minMarketCap: 100_000, maxMarketCap: 1_000 } as CaScannerSnipeParams;
    expect(reasonOf(buildFullBody(scanner({ snipeParams: sp })))).toBe('invalid_snipe_params');
  });
});

describe('limitSells — the unit-polymorphic value', () => {
  const withRungs = (limitSells: unknown) =>
    buildFullBody(scanner({ snipeParams: { solAmount: 1, limitSells } as CaScannerSnipeParams }));

  it('accepts a NEGATIVE pnl value: that is the stop-loss case', () => {
    expect(reasonOf(withRungs([{ type: 'pnl', sellPercent: 100, value: -40 }]))).toBeNull();
  });

  it('refuses a non-positive time value, which fires instantly or never', () => {
    expect(reasonOf(withRungs([{ type: 'time', sellPercent: 100, value: 0 }]))).toBe('invalid_limit_sell');
    expect(reasonOf(withRungs([{ type: 'time', sellPercent: 100, value: -5 }]))).toBe('invalid_limit_sell');
  });

  it('bounds a rung sellPercent to the documented 1-100', () => {
    expect(reasonOf(withRungs([{ type: 'pnl', sellPercent: 0, value: 50 }]))).toBe('invalid_limit_sell');
    expect(reasonOf(withRungs([{ type: 'pnl', sellPercent: 101, value: 50 }]))).toBe('invalid_limit_sell');
  });

  it('carries the optional per-rung execution overrides through', () => {
    const body = bodyOf(
      withRungs([{ type: 'time', sellPercent: 50, value: 60, tip: 0.001, antimev: true, retries: false }]),
    );
    expect((body.snipeParams as Record<string, unknown>).limitSells).toEqual([
      { type: 'time', sellPercent: 50, value: 60, tip: 0.001, antimev: true, retries: false },
    ]);
  });
});

describe('top-level optional fields', () => {
  it('omits maxBuyCount when the caller omits it — omitted means UNLIMITED', () => {
    expect(bodyOf(buildFullBody(scanner())).maxBuyCount).toBeUndefined();
  });

  it('requires maxBuyCount to be an integer >= 1', () => {
    expect(reasonOf(buildFullBody(scanner({ maxBuyCount: 0 })))).toBe('invalid_max_buy_count');
    expect(reasonOf(buildFullBody(scanner({ maxBuyCount: 1.5 })))).toBe('invalid_max_buy_count');
    expect(bodyOf(buildFullBody(scanner({ maxBuyCount: 3 }))).maxBuyCount).toBe(3);
  });

  it('refuses an EMPTY allowedPlatforms rather than letting it mean "all"', () => {
    // The vendor rejects it, and omitting the field is what means "all" — so an
    // empty selection silently becoming every platform is the failure to avoid.
    expect(reasonOf(buildFullBody(scanner({ allowedPlatforms: [] })))).toBe('invalid_platforms');
    expect(bodyOf(buildFullBody(scanner())).allowedPlatforms).toBeUndefined();
  });

  it('deduplicates allowedPlatforms and keeps the documented set', () => {
    expect(bodyOf(buildFullBody(scanner({ allowedPlatforms: ['pumpfun', 'pumpfun', 'raydium'] }))).allowedPlatforms)
      .toEqual(['pumpfun', 'raydium']);
  });

  it('refuses a taskTiming window that ends before it starts', () => {
    expect(reasonOf(buildFullBody(scanner({ taskTiming: { startMs: 2_000, endMs: 1_000 } })))).toBe(
      'invalid_task_timing',
    );
    expect(reasonOf(buildFullBody(scanner({ taskTiming: { startMs: 0, endMs: 1_000 } })))).toBe(
      'invalid_task_timing',
    );
  });
});

describe('name and token address', () => {
  it('trims and bounds the name to 1-40 characters', () => {
    expect(bodyOf(buildFullBody(scanner({ name: '  scanner  ' }))).name).toBe('scanner');
    expect(reasonOf(buildFullBody(scanner({ name: '   ' })))).toBe('invalid_name');
    expect(reasonOf(buildFullBody(scanner({ name: 'x'.repeat(41) })))).toBe('invalid_name');
  });

  it('refuses a tokenAddress that is not a Solana mint', () => {
    expect(reasonOf(buildFullBody(mention({ tokenAddress: 'not-a-mint' })))).toBe('invalid_token_address');
    // Base58 excludes 0, O, I and l; an address carrying one is a typo.
    expect(reasonOf(buildFullBody(mention({ tokenAddress: `0${MINT.slice(1)}` })))).toBe(
      'invalid_token_address',
    );
  });

  it('validates a tokenAddress on the patch path too', () => {
    expect(reasonOf(buildPatchBody({ mode: 'mention', params: { tokenAddress: 'nope' } }))).toBe(
      'invalid_token_address',
    );
  });
});

describe('engagement scope', () => {
  it('sends a numeric targetTweetId alone', () => {
    const p = paramsOf(buildFullBody(engagement({ scope: { kind: 'tweet', targetTweetId: '1234567890' } })));
    expect(p.targetTweetId).toBe('1234567890');
    expect(p.reactedToHandles).toBeUndefined();
  });

  it('refuses a targetTweetId that is not an id', () => {
    // A pasted URL here scopes the config to nothing and it silently never fires.
    expect(
      reasonOf(
        buildFullBody(engagement({ scope: { kind: 'tweet', targetTweetId: 'x.com/elon/status/1' } })),
      ),
    ).toBe('engagement_scope_ambiguous');
  });

  it('omits both when no scope is given', () => {
    const p = paramsOf(buildFullBody(engagement()));
    expect(p.targetTweetId).toBeUndefined();
    expect(p.reactedToHandles).toBeUndefined();
  });
});
