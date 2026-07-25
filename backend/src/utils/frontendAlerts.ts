import type { WsServer } from '../ws/server.js';
import type { AppConfig, FrontendMessage } from '../discord/types.js';

/** In-app toast alerts for highlighted users and contract detections. */
export function broadcastFrontendAlerts(
  wsServer: WsServer,
  userId: string,
  msg: FrontendMessage,
  config: AppConfig,
): void {
  if (msg.isHighlighted) {
    wsServer.broadcastAlert(
      {
        type: 'highlighted_user',
        message: msg,
        reason: msg.hasContractAddress
          ? `Contract from ${msg.author.displayName}`
          : `Highlighted user: ${msg.author.displayName}`,
      },
      userId,
    );
    return;
  }

  if (msg.hasContractAddress && config.contractDetection) {
    const addr = msg.contractAddresses[0] ?? 'address';
    const short = addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
    wsServer.broadcastAlert(
      {
        type: 'contract_address',
        message: msg,
        reason: `Contract scan: ${short} · ${msg.channelName}`,
      },
      userId,
    );
  }
}
