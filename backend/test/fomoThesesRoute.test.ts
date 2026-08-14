import { describe, it, expect } from 'vitest';
import { createFomoRouter } from '../src/fomo/routes';
import type { WsServer } from '../src/ws/server';

// The theses view lives on the FOMO router; guard that it is actually mounted
// (mirrors /hodlers/top) so a rename never silently 404s the console tab.
function registeredRoutes(router: ReturnType<typeof createFomoRouter>): Array<{ path: string; methods: string[] }> {
  // Express Router keeps registered routes on its internal `stack`.
  const stack = (router as unknown as { stack: any[] }).stack;
  return stack
    .filter((layer) => layer?.route)
    .map((layer) => ({
      path: layer.route.path as string,
      methods: Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]),
    }));
}

describe('createFomoRouter — theses route', () => {
  const router = createFomoRouter({} as unknown as WsServer);
  const routes = registeredRoutes(router);

  it('registers GET /token/:address/theses', () => {
    const match = routes.find((r) => r.path === '/token/:address/theses');
    expect(match, 'theses route should be registered').toBeDefined();
    expect(match!.methods).toContain('get');
  });

  it('keeps the sibling /hodlers/top route it mirrors', () => {
    expect(routes.some((r) => r.path === '/hodlers/top')).toBe(true);
  });
});
