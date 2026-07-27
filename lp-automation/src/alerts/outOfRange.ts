import type { LpPosition } from '../types.js';

export class OutOfRangeTracker {
  private readonly episodes = new Map<string, { sinceMs: number; alerted: boolean }>();

  observe(position: LpPosition, now: number): number | null {
    if (position.status !== 'out_of_range') {
      this.episodes.delete(position.tokenId);
      return null;
    }
    let episode = this.episodes.get(position.tokenId);
    if (!episode) {
      episode = { sinceMs: now, alerted: false };
      this.episodes.set(position.tokenId, episode);
    }
    return Math.max(0, Math.floor((now - episode.sinceMs) / 60_000));
  }

  shouldAlert(tokenId: string, minutes: number, thresholdMinutes: number): boolean {
    if (thresholdMinutes <= 0) return false;
    const episode = this.episodes.get(tokenId);
    return episode !== undefined && !episode.alerted && minutes >= thresholdMinutes;
  }

  markAlerted(tokenId: string): void {
    const episode = this.episodes.get(tokenId);
    if (episode) episode.alerted = true;
  }
}
