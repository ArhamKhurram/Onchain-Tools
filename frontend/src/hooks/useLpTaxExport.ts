import { API_BASE, apiFetch } from '../stores/appStore.helpers';

export type LpTaxExportFormat = 'csv' | 'json';

export interface LpTaxExportResult {
  ok: boolean;
  error?: string;
}

async function readExportError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    if (body && typeof body.error === 'string') return body.error;
  } catch {
    // fall through
  }
  return `Export failed (${res.status})`;
}

/** Download the LP audit ledger as CSV or JSON (`GET /api/lp/export.csv` or `.json`). */
export async function downloadLpTaxExport(format: LpTaxExportFormat): Promise<LpTaxExportResult> {
  const ext = format === 'csv' ? 'csv' : 'json';
  const res = await apiFetch(`${API_BASE}/lp/export.${ext}`);
  if (!res.ok) {
    return { ok: false, error: await readExportError(res) };
  }

  const blob =
    format === 'csv'
      ? new Blob([await res.text()], { type: 'text/csv;charset=utf-8' })
      : new Blob([JSON.stringify(await res.json(), null, 2)], { type: 'application/json' });

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `lp-activity.${ext}`;
  anchor.click();
  URL.revokeObjectURL(url);
  return { ok: true };
}
