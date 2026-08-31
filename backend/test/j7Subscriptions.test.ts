// Guards the j7 subscription REST helpers — in particular that the list parser
// pulls the identifier out of j7's OBJECT rows (pump=`username`, fomo=`handle`),
// the exact shape a live /list returned that the first cut dropped by filtering
// for strings. Transport is mocked; no network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addPumpTarget,
  listPumpTargets,
  listFomoTargets,
} from '../src/j7/subscriptions.js';

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('j7 subscriptions — list parsing', () => {
  it('extracts pump usernames from j7 object rows', async () => {
    mockFetch(200, {
      pump_users: [
        { wallet: '6DQAGJT7…QqqP', username: 'cupsey', display_name: 'cupsey', followers: 13920 },
        { wallet: '2fg5QD1e…rx6f', username: 'cupseyyyyy' },
      ],
      limit: 50,
    });
    const res = await listPumpTargets('jwt');
    expect(res.targets).toEqual(['cupsey', 'cupseyyyyy']);
    expect(res.limit).toBe(50);
  });

  it('extracts fomo handles from j7 object rows', async () => {
    mockFetch(200, {
      fomo_users: [
        { fomo_user_id: '36adb85a-…', handle: 'unipcs', display_name: 'Unipcs' },
        { fomo_user_id: '37c08349-…', handle: 'cented', display_name: 'SureNuttyJay' },
      ],
      limit: 50,
    });
    const res = await listFomoTargets('jwt');
    expect(res.targets).toEqual(['unipcs', 'cented']);
  });

  it('tolerates a flattened string array and an empty list', async () => {
    mockFetch(200, { pump_users: ['cupsey', ''], limit: 50 });
    expect((await listPumpTargets('jwt')).targets).toEqual(['cupsey']);
    mockFetch(200, { pump_users: [], limit: 50 });
    expect((await listPumpTargets('jwt')).targets).toEqual([]);
  });

  it('throws a plain Error on a non-2xx add', async () => {
    mockFetch(400, { error: 'Internal server error' });
    await expect(addPumpTarget('jwt', 'nope')).rejects.toThrow(/HTTP 400/);
  });
});
