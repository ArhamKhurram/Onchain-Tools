import type { LpAlertKind, LpAlertPayload } from './types.js';

export interface FormattedLpAlert {
  title: string;
  body: string;
  color: number;
}

const TITLES: Record<LpAlertKind, string> = {
  rebalance_fired: 'LP rebalance executed',
  action_failed: 'LP action failed',
  out_of_range: 'LP position out of range',
  gas_threshold: 'LP gas spend threshold',
};

const COLORS: Record<LpAlertKind, number> = {
  rebalance_fired: 0x3b82f6,
  action_failed: 0xef4444,
  out_of_range: 0xf59e0b,
  gas_threshold: 0xeab308,
};

export function formatLpAlert(payload: LpAlertPayload): FormattedLpAlert {
  const lines = [`**Position:** ${payload.tokenId ?? 'new position'}`];
  if (payload.poolAddress) {
    lines.push(`**Pool:** \`${payload.poolAddress.slice(0, 6)}…${payload.poolAddress.slice(-4)}\``);
  }
  if (payload.action) lines.push(`**Action:** ${payload.action}`);
  lines.push(`**Detail:** ${payload.reason}`);
  if (payload.outOfRangeMinutes !== undefined) {
    lines.push(`**Out of range for:** ${payload.outOfRangeMinutes} min`);
  }
  if (payload.gasSpentUsd !== undefined) {
    lines.push(`**Gas spent:** $${payload.gasSpentUsd.toFixed(4)}`);
  }
  if (payload.txHash) lines.push(`**Tx:** \`${payload.txHash}\``);
  return { title: TITLES[payload.kind], body: lines.join('\n'), color: COLORS[payload.kind] };
}

export function toDiscordWebhookBody(payload: LpAlertPayload) {
  const formatted = formatLpAlert(payload);
  return { embeds: [{ title: formatted.title, description: formatted.body, color: formatted.color }] };
}
