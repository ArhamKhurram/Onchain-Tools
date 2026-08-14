/**
 * JSON file-backed price-alert store for local (single-user) mode — the
 * sibling of ContractLog / RevivalAlertLog / JournalLog. One file
 * (`price-alerts.json`); the whole document is rewritten on every save, the
 * same tradeoff the other local stores make.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { PriceAlert, PriceAlertStatus } from '@oct/shared';
import type { PriceAlertInput, PriceAlertObservationPatch } from '../storage/interface.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.OCT_DATA_DIR || process.env.TRENCHCORD_DATA_DIR || join(__dirname, '../../data');
const LOG_PATH = join(DATA_DIR, 'price-alerts.json');

/**
 * These are hand-typed by one operator, so the ceiling is generous and exists
 * only to stop an accidental script from growing the file without bound.
 */
const MAX_ALERTS = 1_000;

interface PriceAlertDocument {
  alerts: PriceAlert[];
}

class PriceAlertLog {
  private doc: PriceAlertDocument = { alerts: [] };

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(LOG_PATH)) {
        const parsed = JSON.parse(readFileSync(LOG_PATH, 'utf-8')) as Partial<PriceAlertDocument>;
        this.doc = { alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [] };
      }
    } catch (err) {
      console.error('[PriceAlertLog] Failed to load:', err);
      this.doc = { alerts: [] };
    }
  }

  private save(): void {
    try {
      writeFileSync(LOG_PATH, JSON.stringify(this.doc, null, 2), 'utf-8');
    } catch (err) {
      console.error('[PriceAlertLog] Failed to save:', err);
    }
  }

  list(status?: PriceAlertStatus): PriceAlert[] {
    const rows = status ? this.doc.alerts.filter((a) => a.status === status) : [...this.doc.alerts];
    return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  create(input: PriceAlertInput): PriceAlert {
    const alert: PriceAlert = {
      id: randomUUID(),
      chain: input.chain,
      mint: input.mint,
      symbol: input.symbol,
      direction: input.direction,
      targetUsd: input.targetUsd,
      metric: input.metric,
      status: 'armed',
      note: input.note,
      // NULL on purpose: the poller's first observation records the baseline,
      // so an alert armed on a token already past its target cannot fire
      // instantly. See priceAlerts/crossing.ts.
      lastSeenUsd: null,
      lastSeenAt: null,
      firedAt: null,
      firedValueUsd: null,
      createdAt: new Date().toISOString(),
    };
    this.doc.alerts.push(alert);
    if (this.doc.alerts.length > MAX_ALERTS) {
      this.doc.alerts = this.doc.alerts.slice(this.doc.alerts.length - MAX_ALERTS);
    }
    this.save();
    return alert;
  }

  remove(alertId: string): boolean {
    const before = this.doc.alerts.length;
    this.doc.alerts = this.doc.alerts.filter((a) => a.id !== alertId);
    if (this.doc.alerts.length === before) return false;
    this.save();
    return true;
  }

  applyObservation(alertId: string, patch: PriceAlertObservationPatch): void {
    const alert = this.doc.alerts.find((a) => a.id === alertId);
    if (!alert) return;
    alert.lastSeenUsd = patch.lastSeenUsd;
    alert.lastSeenAt = patch.lastSeenAt;
    if (patch.symbol != null) alert.symbol = patch.symbol;
    if (patch.status) alert.status = patch.status;
    if (patch.firedAt) alert.firedAt = patch.firedAt;
    if (patch.firedValueUsd != null) alert.firedValueUsd = patch.firedValueUsd;
    this.save();
  }
}

export const priceAlertLog = new PriceAlertLog();
