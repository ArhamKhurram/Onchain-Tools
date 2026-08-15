// The notify_discord missing-column discrimination
// (backend/src/pumpfun/calloutStore.ts).
//
// 20260816120000_pump_tracked_callers_notify_discord.sql is applied BY HAND, so
// the code that reads and writes `notify_discord` reaches prod before the column
// does. Every read/write therefore retries once with the column stripped — and
// the predicate that decides whether to do that is the entire safety property.
//
// THE TRAP THIS FILE GUARDS (same one documented in
// storage/supabase/contractsRepo.ts): PostgREST reports a missing COLUMN with
// the SAME "schema cache" wording it uses for a missing TABLE. A broad
// /schema cache/ check would therefore swallow a genuinely missing
// pump_tracked_callers table, retry the write without one harmless column, fail
// again for the real reason, and leave the operator with silent data loss and
// no signal. The predicate must key on the column NAME.

import { describe, expect, it } from 'vitest';
import { isMissingNotifyDiscordError } from '../src/pumpfun/calloutStore.js';

describe('isMissingNotifyDiscordError', () => {
  it('matches the PostgREST missing-column message for a write', () => {
    expect(
      isMissingNotifyDiscordError({
        message: "Could not find the 'notify_discord' column of 'pump_tracked_callers' in the schema cache",
      }),
    ).toBe(true);
  });

  it('matches the missing-column message for a select', () => {
    expect(
      isMissingNotifyDiscordError({
        message: 'column pump_tracked_callers.notify_discord does not exist',
      }),
    ).toBe(true);
  });

  it('matches either word order (name first or wording first)', () => {
    expect(isMissingNotifyDiscordError({ message: 'notify_discord does not exist' })).toBe(true);
    expect(isMissingNotifyDiscordError({ message: 'schema cache is missing notify_discord' })).toBe(true);
  });

  it('is case-insensitive, as PostgREST wording is not stable', () => {
    expect(isMissingNotifyDiscordError({ message: "Could Not Find The 'NOTIFY_DISCORD' Column In The Schema Cache" })).toBe(true);
  });

  // --- The hazard ---------------------------------------------------------

  it('does NOT match a missing TABLE, despite the identical "schema cache" wording', () => {
    expect(
      isMissingNotifyDiscordError({
        message: "Could not find the table 'public.pump_tracked_callers' in the schema cache",
      }),
    ).toBe(false);
  });

  it('does NOT match a different missing column', () => {
    expect(
      isMissingNotifyDiscordError({
        message: "Could not find the 'notify_pushover' column of 'pump_tracked_callers' in the schema cache",
      }),
    ).toBe(false);
  });

  it('does NOT match unrelated failures that must surface', () => {
    for (const message of [
      'duplicate key value violates unique constraint "pump_tracked_callers_user_id_caller_address_key"',
      'new row violates row-level security policy for table "pump_tracked_callers"',
      'JWT expired',
      'fetch failed',
      '',
    ]) {
      expect(isMissingNotifyDiscordError({ message })).toBe(false);
    }
  });

  it('treats a null/undefined/message-less error as not-tolerable', () => {
    expect(isMissingNotifyDiscordError(null)).toBe(false);
    expect(isMissingNotifyDiscordError(undefined)).toBe(false);
    expect(isMissingNotifyDiscordError({})).toBe(false);
  });
});
