import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { RevivalAlertEntry, RevivalOutcomePatch } from '@oct/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.OCT_DATA_DIR || process.env.TRENCHCORD_DATA_DIR || join(__dirname, '../../data');
const LOG_PATH = join(DATA_DIR, 'revival-alerts.json');

/**
 * Local-mode retention. Revival alerts are rare (a handful over days), so 200
 * rows is months of history; the whole array is rewritten on every save, same
 * as contracts.json.
 */
const MAX_ENTRIES = 200;

/**
 * JSON file-backed revival alert log for local (single-user) mode — the
 * sibling of ContractLog. Rows carry their own outcome state (peak fields)
 * so the 24h outcome tracker can resume across restarts.
 */
class RevivalAlertLog {
  private entries: RevivalAlertEntry[] = [];

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(LOG_PATH)) {
        this.entries = JSON.parse(readFileSync(LOG_PATH, 'utf-8'));
      }
    } catch (err) {
      console.error('[RevivalAlertLog] Failed to load:', err);
      this.entries = [];
    }
  }

  private save(): void {
    try {
      writeFileSync(LOG_PATH, JSON.stringify(this.entries, null, 2), 'utf-8');
    } catch (err) {
      console.error('[RevivalAlertLog] Failed to save:', err);
    }
  }

  log(entry: RevivalAlertEntry): RevivalAlertEntry {
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.length = MAX_ENTRIES;
    }
    this.save();
    return entry;
  }

  list(limit = 100): RevivalAlertEntry[] {
    return this.entries.slice(0, limit);
  }

  updateOutcome(alertId: string, patch: RevivalOutcomePatch): boolean {
    const entry = this.entries.find((e) => e.id === alertId);
    if (!entry) return false;
    Object.assign(entry, patch);
    this.save();
    return true;
  }
}

export const revivalAlertLog = new RevivalAlertLog();
