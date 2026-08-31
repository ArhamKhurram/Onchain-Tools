import { randomUUID } from 'crypto';

export function buildAuthQuery(): { timestamp: number; client_id: string } {
  return {
    timestamp: Math.floor(Date.now() / 1000),
    client_id: randomUUID(),
  };
}
