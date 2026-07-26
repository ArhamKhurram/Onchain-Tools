import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, apiFetch } from '../stores/appStore.helpers';
import { parseFieldIssues } from '../components/lp/policyDraft';
import type {
  AutomationPolicy,
  AutomationPolicyPayload,
  LpPolicyResponse,
  LpStatusResponse,
  PolicyFieldIssue,
} from '../components/lp/types';

/**
 * `GET /api/lp/policy` + `GET /api/lp/status` + `PUT /api/lp/policy`.
 *
 * The signer process never accepts writes (plan §9.1) — the policy row is the
 * only channel between this page and it, so a save here is the whole interface
 * for changing what the automation is permitted to do.
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

/** A policy can come back bare or wrapped; accept either. */
function unwrapPolicy(body: unknown): AutomationPolicy | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (record.policy && typeof record.policy === 'object') return record.policy as AutomationPolicy;
  if (typeof record.version === 'number') return record as unknown as AutomationPolicy;
  return null;
}

export interface SaveResult {
  ok: boolean;
  policy: AutomationPolicy | null;
  issues: PolicyFieldIssue[];
  error: string | null;
}

export interface UseLpPolicyResult {
  policy: AutomationPolicy | null;
  versions: number[];
  status: LpStatusResponse | null;
  loading: boolean;
  /** Failed to read the policy at all. */
  error: string | null;
  /** The backend has no `/api/lp` routes — a deployment gap, not a user error. */
  unavailable: boolean;
  saving: boolean;
  saveError: string | null;
  /** Field errors from the server's 400 — authoritative over the client mirror. */
  serverIssues: PolicyFieldIssue[];
  savedAt: number | null;
  refresh: () => Promise<void>;
  save: (payload: AutomationPolicyPayload) => Promise<SaveResult>;
  clearServerIssues: () => void;
}

export function useLpPolicy(enabled = true): UseLpPolicyResult {
  const [policy, setPolicy] = useState<AutomationPolicy | null>(null);
  const [versions, setVersions] = useState<number[]>([]);
  const [status, setStatus] = useState<LpStatusResponse | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<PolicyFieldIssue[]>([]);
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
      const [policyRes, statusRes] = await Promise.all([
        apiFetch(`${API_BASE}/lp/policy`),
        apiFetch(`${API_BASE}/lp/status`),
      ]);

      if (policyRes.status === 404 || policyRes.status === 501) {
        if (!mounted.current) return;
        setUnavailable(true);
        setPolicy(null);
        setVersions([]);
        setStatus(null);
        setLoading(false);
        return;
      }

      const policyBody = await readJson(policyRes);
      if (!policyRes.ok) throw new Error(messageFor(policyRes, policyBody));

      const parsed = (policyBody ?? {}) as Partial<LpPolicyResponse>;
      if (!mounted.current) return;
      setUnavailable(false);
      setPolicy(parsed.policy ?? null);
      setVersions(Array.isArray(parsed.versions) ? [...parsed.versions].sort((a, b) => b - a) : []);

      // Status is a convenience surface — a failure there must not blank the
      // policy the operator is trying to read.
      if (statusRes.ok) {
        const statusBody = (await readJson(statusRes)) as LpStatusResponse | null;
        if (mounted.current && statusBody && typeof statusBody === 'object') setStatus(statusBody);
      } else {
        setStatus(null);
      }
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load LP policy');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (payload: AutomationPolicyPayload): Promise<SaveResult> => {
      setSaving(true);
      setSaveError(null);
      setServerIssues([]);
      try {
        const res = await apiFetch(`${API_BASE}/lp/policy`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const body = await readJson(res);

        if (!res.ok) {
          const issues = parseFieldIssues(body);
          const message = messageFor(res, body);
          if (mounted.current) {
            setServerIssues(issues);
            setSaveError(
              issues.length > 0
                ? `Rejected: ${issues.length} field${issues.length === 1 ? '' : 's'} need attention`
                : message,
            );
          }
          return { ok: false, policy: null, issues, error: message };
        }

        const created = unwrapPolicy(body);
        if (mounted.current) {
          if (created) {
            setPolicy(created);
            setVersions((prev) =>
              prev.includes(created.version) ? prev : [created.version, ...prev].sort((a, b) => b - a),
            );
            setStatus({
              hasPolicy: true,
              activeVersion: created.version,
              allowlistSize: created.allowedPools?.length ?? 0,
            });
          }
          setSavedAt(Date.now());
        }
        // Re-read so the version list and status come from the server rather
        // than from an optimistic guess.
        void refresh();
        return { ok: true, policy: created, issues: [], error: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to save policy';
        if (mounted.current) setSaveError(message);
        return { ok: false, policy: null, issues: [], error: message };
      } finally {
        if (mounted.current) setSaving(false);
      }
    },
    [refresh],
  );

  const clearServerIssues = useCallback(() => {
    setServerIssues([]);
    setSaveError(null);
  }, []);

  return {
    policy,
    versions,
    status,
    loading,
    error,
    unavailable,
    saving,
    saveError,
    serverIssues,
    savedAt,
    refresh,
    save,
    clearServerIssues,
  };
}
