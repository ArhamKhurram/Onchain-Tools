import { describe, it, expect } from 'vitest';
import { resolveAuthStatus } from '../src/stores/authStatusResolve';

const gateway = {
  clientGatewayMode: true,
  hasLocalTokens: true,
  gatewayPresent: true,
};

describe('resolveAuthStatus — client-gateway mode', () => {
  // The regression: a failed /auth/status used to null out authStatus, so the
  // Feed fell back to "Connect Discord" right after the token was saved and only
  // a page refresh recovered it.
  it('stays configured when the server call fails', () => {
    const s = resolveAuthStatus({ ...gateway, serverStatus: null });
    expect(s?.configured).toBe(true);
    expect(s?.clientGateway).toBe(true);
  });

  it('stays configured when the server reports not configured', () => {
    // Expected in hosted mode: the server never sees the browser-held token.
    const s = resolveAuthStatus({ ...gateway, serverStatus: { configured: false, connected: false } });
    expect(s?.configured).toBe(true);
  });

  it('is not configured when there is no local token', () => {
    const s = resolveAuthStatus({ ...gateway, hasLocalTokens: false, serverStatus: null });
    expect(s?.configured).toBe(false);
    expect(s?.connected).toBe(false);
  });

  it('is configured but not connected before the gateway comes up', () => {
    const s = resolveAuthStatus({ ...gateway, gatewayPresent: false, serverStatus: null });
    expect(s?.configured).toBe(true);
    expect(s?.connected).toBe(false);
  });

  it('preserves unrelated server fields', () => {
    const s = resolveAuthStatus({
      ...gateway,
      serverStatus: { configured: false, connected: false, telegramConfigured: true } as never,
    });
    expect((s as Record<string, unknown>).telegramConfigured).toBe(true);
    expect(s?.configured).toBe(true);
  });
});

describe('resolveAuthStatus — server-token mode', () => {
  const server = { clientGatewayMode: false, hasLocalTokens: false, gatewayPresent: false };

  it('trusts the server', () => {
    const s = resolveAuthStatus({ ...server, serverStatus: { configured: true, connected: true } });
    expect(s?.configured).toBe(true);
  });

  it('reports unknown when the call failed — the server IS authoritative here', () => {
    expect(resolveAuthStatus({ ...server, serverStatus: null })).toBeNull();
  });

  it('ignores stray local tokens when not in gateway mode', () => {
    const s = resolveAuthStatus({
      ...server,
      hasLocalTokens: true,
      serverStatus: { configured: false, connected: false },
    });
    expect(s?.configured).toBe(false);
  });
});
