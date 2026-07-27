import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, apiFetch } from '../stores/appStore.helpers';
import { parseFieldIssues } from '../components/lp/policyDraft';
import {
  parseEnterCommand,
  type LpEnterCommand,
  type LpEnterFieldIssue,
  type LpEnterRequest,
} from '../components/lp/enter';

/**
 * `POST /api/lp/enter` — open a NEW LP position from the dashboard.
 *
 * Mirrors `useLpCommands`' submit half: the POST writes a queue row that a
 * separate worker process claims a few seconds later, so this hook never claims
 * anything happened on-chain. It surfaces the server's answers by kind:
 *
 *   - 400 → field `issues`, shown inline against the form inputs;
 *   - 409 → `conflict` (pool not on the saved allowlist, or a duplicate) —
 *     state, not a fault, shown prominently;
 *   - 503 → `error` (the policy could not be read), shown prominently;
 *   - 200/201 → the created command; `onSuccess` refreshes the positions feed.
 */

export interface SubmitEnterResult {
  ok: boolean;
  command: LpEnterCommand | null;
  conflict: string | null;
  issues: LpEnterFieldIssue[];
  error: string | null;
}

export interface UseLpEnterResult {
  submitting: boolean;
  error: string | null;
  conflict: string | null;
  issues: LpEnterFieldIssue[];
  /** The backend has no `/api/lp/enter` route yet. */
  unavailable: boolean;
  /** The created command, once the POST returns queued. */
  lastCommand: LpEnterCommand | null;
  submit: (request: LpEnterRequest) => Promise<SubmitEnterResult>;
  reset: () => void;
}

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

const NO_ISSUES: LpEnterFieldIssue[] = [];

export function useLpEnter(options?: { onSuccess?: () => void }): UseLpEnterResult {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [issues, setIssues] = useState<LpEnterFieldIssue[]>(NO_ISSUES);
  const [unavailable, setUnavailable] = useState(false);
  const [lastCommand, setLastCommand] = useState<LpEnterCommand | null>(null);

  const mounted = useRef(true);
  const onSuccess = options?.onSuccess;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reset = useCallback(() => {
    setError(null);
    setConflict(null);
    setIssues(NO_ISSUES);
    setLastCommand(null);
  }, []);

  const submit = useCallback(
    async (request: LpEnterRequest): Promise<SubmitEnterResult> => {
      setSubmitting(true);
      setError(null);
      setConflict(null);
      setIssues(NO_ISSUES);
      try {
        const res = await apiFetch(`${API_BASE}/lp/enter`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        });

        if (res.status === 404 || res.status === 501) {
          const message = 'This backend has no add-liquidity API yet.';
          if (mounted.current) {
            setUnavailable(true);
            setError(message);
          }
          return { ok: false, command: null, conflict: null, issues: NO_ISSUES, error: message };
        }

        const body = await readJson(res);

        // 400 — the server rejected specific fields. Surface them inline.
        if (res.status === 400) {
          const fieldIssues = parseFieldIssues(body);
          const message = fieldIssues.length > 0 ? null : messageFor(res, body);
          if (mounted.current) {
            setIssues(fieldIssues);
            if (message) setError(message);
          }
          return { ok: false, command: null, conflict: null, issues: fieldIssues, error: message };
        }

        // 409 — pool not on the saved allowlist, or a duplicate enter is pending.
        if (res.status === 409) {
          const message = messageFor(res, body);
          if (mounted.current) setConflict(message);
          return { ok: false, command: null, conflict: message, issues: NO_ISSUES, error: null };
        }

        // 503 — the policy could not be read, so nothing was queued.
        if (res.status === 503) {
          const message = messageFor(res, body);
          if (mounted.current) setError(message);
          return { ok: false, command: null, conflict: null, issues: NO_ISSUES, error: message };
        }

        if (!res.ok) {
          const message = messageFor(res, body);
          if (mounted.current) setError(message);
          return { ok: false, command: null, conflict: null, issues: NO_ISSUES, error: message };
        }

        const created = parseEnterCommand(body);
        if (mounted.current) {
          setUnavailable(false);
          setLastCommand(created);
        }
        // A queued enter changes nothing on-chain yet, but re-reading keeps the
        // page honest once the worker executes it.
        onSuccess?.();
        return { ok: true, command: created, conflict: null, issues: NO_ISSUES, error: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to queue the entry';
        if (mounted.current) setError(message);
        return { ok: false, command: null, conflict: null, issues: NO_ISSUES, error: message };
      } finally {
        if (mounted.current) setSubmitting(false);
      }
    },
    [onSuccess],
  );

  return { submitting, error, conflict, issues, unavailable, lastCommand, submit, reset };
}
