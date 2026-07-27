import type { Logger } from '../lifecycle/types.js';
import { toDiscordWebhookBody } from './format.js';
import type { LpAlertPayload } from './types.js';

export interface AlertDispatchConfig {
  webhookUrl: string | null;
}

export interface AlertDispatcher {
  send(payload: LpAlertPayload): Promise<void>;
}

export function createDisabledAlertDispatcher(): AlertDispatcher {
  return { send: async () => {} };
}

export function createWebhookAlertDispatcher(
  config: AlertDispatchConfig,
  logger: Logger,
): AlertDispatcher {
  const url = config.webhookUrl?.trim() ?? '';
  if (!url) return createDisabledAlertDispatcher();
  return {
    async send(payload) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(toDiscordWebhookBody(payload)),
        });
        if (!res.ok) {
          logger.warn('lp-alerts: webhook delivery failed', {
            status: res.status,
            kind: payload.kind,
            tokenId: payload.tokenId,
          });
        }
      } catch (error) {
        logger.warn('lp-alerts: webhook request failed', {
          kind: payload.kind,
          tokenId: payload.tokenId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
