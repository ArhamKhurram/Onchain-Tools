import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createConfigSlice } from '../src/stores/slices/configSlice';
import type { AppConfig } from '../src/types';

// updateConfig used to fire a bare PUT per call and publish whichever response
// happened to resolve last. A colour-picker gesture produces several calls in
// quick succession, so an older response could land after a newer one and roll
// the colour back — "it doesn't properly update the colours I set". These
// tests pin the fixed contract: optimistic merge, serialized PUTs, latest-wins
// publishing.

interface PendingRequest {
  url: string;
  body: Record<string, unknown> | null;
  resolve: (r: Response) => void;
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeStore(initialConfig: Partial<AppConfig>) {
  let state: Record<string, any> = {};
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  const get = () => state;
  const slice = createConfigSlice(set as any, get as any, {} as any);
  state = { ...slice, config: initialConfig as AppConfig, _layoutHydrated: true };
  return {
    state: () => state as { config: AppConfig } & typeof slice,
    updateConfig: (data: Parameters<typeof slice.updateConfig>[0]) =>
      state.updateConfig(data) as Promise<void>,
  };
}

describe('configSlice updateConfig ordering', () => {
  let pending: PendingRequest[];

  beforeEach(() => {
    pending = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (url: any, init?: any) =>
          new Promise<Response>((resolve) => {
            pending.push({
              url: String(url),
              body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
              resolve,
            });
          }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('applies the patch optimistically before the round trip completes', async () => {
    const store = makeStore({ guildColors: { g1: '#111111' }, chattingEnabled: true } as Partial<AppConfig>);

    void store.updateConfig({ guildColors: { g1: '#222222' } });

    expect(store.state().config.guildColors).toEqual({ g1: '#222222' });
    // Untouched keys survive the merge.
    expect(store.state().config.chattingEnabled).toBe(true);
  });

  it('serializes PUTs: the second request waits for the first response', async () => {
    const store = makeStore({ guildColors: {} } as Partial<AppConfig>);

    const a = store.updateConfig({ guildColors: { g1: '#aaaaaa' } });
    const b = store.updateConfig({ guildColors: { g1: '#bbbbbb' } });
    await tick();

    expect(pending).toHaveLength(1);
    expect(pending[0].body).toEqual({ guildColors: { g1: '#aaaaaa' } });

    pending[0].resolve(jsonResponse({ guildColors: { g1: '#aaaaaa' } }));
    await a;
    await tick();

    expect(pending).toHaveLength(2);
    expect(pending[1].body).toEqual({ guildColors: { g1: '#bbbbbb' } });

    pending[1].resolve(jsonResponse({ guildColors: { g1: '#bbbbbb' } }));
    await b;
  });

  it('an older response never overwrites a newer optimistic edit', async () => {
    const store = makeStore({ guildColors: { g1: '#111111' } } as Partial<AppConfig>);

    const a = store.updateConfig({ guildColors: { g1: '#aaaaaa' } });
    const b = store.updateConfig({ guildColors: { g1: '#bbbbbb' } });
    await tick();

    // A's server snapshot arrives while B is still pending: it must NOT be
    // published, or the pane would repaint with the intermediate colour.
    pending[0].resolve(jsonResponse({ guildColors: { g1: '#aaaaaa' } }));
    await a;
    expect(store.state().config.guildColors).toEqual({ g1: '#bbbbbb' });

    await tick();
    pending[1].resolve(jsonResponse({ guildColors: { g1: '#bbbbbb' } }));
    await b;
    expect(store.state().config.guildColors).toEqual({ g1: '#bbbbbb' });
  });

  it('the newest response is published once it lands', async () => {
    const store = makeStore({ guildColors: {} } as Partial<AppConfig>);

    const a = store.updateConfig({ guildColors: { g1: '#cccccc' } });
    await tick();
    // Server may normalise/augment; the newest response is the truth.
    pending[0].resolve(jsonResponse({ guildColors: { g1: '#cccccc' }, chattingEnabled: false }));
    await a;

    expect(store.state().config.guildColors).toEqual({ g1: '#cccccc' });
    expect((store.state().config as AppConfig).chattingEnabled).toBe(false);
  });
});
