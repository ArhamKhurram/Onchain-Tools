import { GatewayManager } from './gatewayManager';

let manager: GatewayManager | null = null;

export const isClientGatewayMode = () => !!import.meta.env.VITE_SUPABASE_URL;

export function getClientGatewayManager(): GatewayManager | null {
  return manager;
}

export function connectClientGateway(tokens: string[]): GatewayManager {
  disconnectClientGateway();
  manager = new GatewayManager(tokens);
  manager.connect();
  return manager;
}

export function disconnectClientGateway(): void {
  if (manager) {
    manager.disconnect();
    manager = null;
  }
}
