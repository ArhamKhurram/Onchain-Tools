import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, apiFetch } from '../stores/appStore.helpers';
import { parseFieldIssues } from '../components/lp/policyDraft';
import type { LpSettings, LpSettingsPatch } from '../components/lp/positions';
import type { PolicyFieldIssue } from '../components/lp/types';

/**
 * `GET /api/lp/settings` + `PUT /api/lp/settings`.
 *
 * Holds the Safe address the positions view reads from. Deliberately separate
 * from the policy: the policy says what the automation may *do*, this says which
 * account it is looking at. Saving one must never version the other.
 */

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function messageFor(res: Response, body: unknown): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.error === 'string') return record.error;
    if (typeof record.message === 'string') return record.message;
  }
  return `Request failed (${res.status})`;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function parseSettings(body: unknown): LpSettings {
  const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const nested =
    record.settings && typeof record.settings === 'object'
      ? (record.settings as Record<string, unknown>)
      : record;
  return {
    safeAddress: str(nested.safeAddress),
    moduleAddress: str(nested.moduleAddress),
    updatedAt: str(nested.updatedAt),
  };
}

export interface LpSettingsSaveResult {
  ok: boolean;
  settings: LpSettings | null;
  issues: PolicyFieldIssue[];
  error: string | null;
}

export interface UseLpSettingsResult {
  settings: LpSettings | null;
  loading: boolean;
  error: string | null;
  /** The backend has no `/api/lp/settings` route yet. */
  unavailable: boolean;
  saving: boolean;
  saveError: string | null;
  /** Field errors from the server's 400 — authoritative over the client mirror. */
  issues: PolicyFieldIssue[];
  savedAt: number | null;
  refresh: () => Promise<void>;
  save: (patch: LpSettingsPatch) => Promise<LpSettingsSaveResult>;
  clearIssues: () => void;
}

export function useLpSettings(enabled = true): UseLpSettingsResult {
  const [settings, setSettings] = useState<LpSettings | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [issues, setIssues] = useState<PolicyFieldIssue[]>([]);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/lp/settings`);
      if (res.status === 404 || res.status === 501) {
        if (!mounted.current) return;
        setUnavailable(true);
        setSettings(null);
        setLoading(false);
        return;
      }
      const body = await readJson(res);
      if (!res.ok) throw new Error(messageFor(res, body));
      if (!mounted.current) return;
      setUnavailable(false);
      setSettings(parseSettings(body));
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load LP settings');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(async (patch: LpSettingsPatch): Promise<LpSettingsSaveResult> => {
    setSaving(true);
    setSaveError(null);
    setIssues([]);
    try {
      const res = await apiFetch(`${API_BASE}/lp/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = await readJson(res);

      if (!res.ok) {
        const parsed = parseFieldIssues(body);
        const message = messageFor(res, body);
        if (mounted.current) {
          setIssues(parsed);
          setSaveError(message);
        }
        return { ok: false, settings: null, issues: parsed, error: message };
      }

      const stored = parseSettings(body);
      if (mounted.current) {
        setSettings(stored);
        setSavedAt(Date.now());
      }
      return { ok: true, settings: stored, issues: [], error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save LP settings';
      if (mounted.current) setSaveError(message);
      return { ok: false, settings: null, issues: [], error: message };
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, []);

  const clearIssues = useCallback(() => {
    setIssues([]);
    setSaveError(null);
  }, []);

  return {
    settings,
    loading,
    error,
    unavailable,
    saving,
    saveError,
    issues,
    savedAt,
    refresh,
    save,
    clearIssues,
  };
}
