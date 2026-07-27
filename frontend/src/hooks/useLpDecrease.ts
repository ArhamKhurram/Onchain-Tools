import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, apiFetch } from '../stores/appStore.helpers';
import { parseFieldIssues } from '../components/lp/policyDraft';
import {
  parseDecreaseCommand,
  type LpDecreaseCommand,
  type LpDecreaseFieldIssue,
  type LpDecreaseRequest,
} from '../components/lp/decrease';

export interface SubmitDecreaseResult {
  ok: boolean;
  command: LpDecreaseCommand | null;
  conflict: string | null;
  issues: LpDecreaseFieldIssue[];
  error: string | null;
}

export interface UseLpDecreaseResult {
  submitting: boolean;
  error: string | null;
  conflict: string | null;
  issues: LpDecreaseFieldIssue[];
  unavailable: boolean;
  lastCommand: LpDecreaseCommand | null;
  submit: (tokenId: string, request: LpDecreaseRequest) => Promise<SubmitDecreaseResult>;
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

const NO_ISSUES: LpDecreaseFieldIssue[] = [];

export function useLpDecrease(options?: { onSuccess?: () => void }): UseLpDecreaseResult {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [issues, setIssues] = useState<LpDecreaseFieldIssue[]>(NO_ISSUES);
  const [unavailable, setUnavailable] = useState(false);
  const [lastCommand, setLastCommand] = useState<LpDecreaseCommand | null>(null);
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
    async (tokenId: string, request: LpDecreaseRequest): Promise<SubmitDecreaseResult> => {
      setSubmitting(true);
      setError(null);
      setConflict(null);
      setIssues(NO_ISSUES);
      try {
        const res = await apiFetch(`${API_BASE}/lp/positions/${encodeURIComponent(tokenId)}/decrease`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        });
        if (res.status === 404 || res.status === 501) {
          const message = 'This backend has no remove-liquidity API yet.';
          if (mounted.current) {
            setUnavailable(true);
            setError(message);
          }
          return { ok: false, command: null, conflict: null, issues: NO_ISSUES, error: message };
        }
        const body = await readJson(res);
        if (res.status === 400) {
          const fieldIssues = parseFieldIssues(body);
          const message = fieldIssues.length > 0 ? null : messageFor(res, body);
          if (mounted.current) {
            setIssues(fieldIssues);
            if (message) setError(message);
          }
          return { ok: false, command: null, conflict: null, issues: fieldIssues, error: message };
        }
        if (res.status === 409) {
          const message = messageFor(res, body);
          if (mounted.current) setConflict(message);
          return { ok: false, command: null, conflict: message, issues: NO_ISSUES, error: null };
        }
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
        const created = parseDecreaseCommand(body);
        if (mounted.current) {
          setUnavailable(false);
          setLastCommand(created);
        }
        onSuccess?.();
        return { ok: true, command: created, conflict: null, issues: NO_ISSUES, error: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to queue the decrease';
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
