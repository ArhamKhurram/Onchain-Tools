import type { AuthStatus } from '../types';

/**
 * Decide the auth status to store, given what the server said (if anything) and
 * what is true locally.
 *
 * Extracted as a pure function because the rule is subtle and was wrong: in
 * client-gateway mode the Discord token lives in the browser and never reaches
 * the server (ADR-002), so whether Discord is *configured* is a purely local
 * fact. A failed `/auth/status` says nothing about it.
 *
 * The bug this encodes against: on a failed status call the store used to reset
 * `authStatus` to null, which dropped the console back to "Connect Discord" even
 * though the token was in localStorage and the gateway was live. Only a refresh
 * recovered it.
 */
export function resolveAuthStatus(params: {
  /** Parsed body of /auth/status, or null when the call failed or was not ok. */
  serverStatus: AuthStatus | null;
  /** True when the browser-side Discord gateway is the active transport. */
  clientGatewayMode: boolean;
  /** Whether any Discord token is present in browser storage. */
  hasLocalTokens: boolean;
  /** Whether a browser gateway manager instance currently exists. */
  gatewayPresent: boolean;
}): AuthStatus | null {
  const { serverStatus, clientGatewayMode, hasLocalTokens, gatewayPresent } = params;

  if (clientGatewayMode) {
    // Local truth wins, with or without a server response.
    const configured = hasLocalTokens;
    return {
      ...(serverStatus ?? {}),
      clientGateway: true,
      configured,
      connected: configured && gatewayPresent,
    };
  }

  // Server-token mode: the server is authoritative, so a failed call really does
  // mean "unknown".
  return serverStatus;
}
