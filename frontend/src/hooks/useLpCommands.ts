import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, apiFetch } from '../stores/appStore.helpers';
import {
  hasCommandInFlight,
  mergeCommands,
  parseCommand,
  parseCommands,
  type LpCommand,
  type LpCommandAction,
} from '../components/lp/commands';
import { parseHistoryCommands, type LpCommandHistoryRow } from '../components/lp/format';

/**
 * `GET /api/lp/commands` + `POST /api/lp/positions/:tokenId/actions`.
 *
 * A command is an INTENT, not an outcome. The POST writes a row; a separate
 * worker process claims it a few seconds later and only then does anything
 * on-chain. This hook's whole job is to keep the page honest about which of
 * those has happened, which is why:
 *
 *   - `submit` resolves with the created command in its *queued* state and
 *     never pretends otherwise;
 *   - polling runs only while something is unsettled, and stops the moment
 *     everything has reached done/failed/skipped — a permanent 3s poll against
 *     a page nobody is acting on is just noise on the backend;
 *   - a 409 is surfaced as its own field. It is not a network error, it is the
 *     server saying "already pending" or "pool is not allowlisted", and the UI
 *     disables the button on both of those conditions ahead of time. Seeing a
 *     409 here means the client's model drifted from the server's, which is
 *     worth showing rather than swallowing.
 */

const POLL_INTERVAL_MS = 3_000;

/**
 * A command that never settles must not poll forever. Twenty minutes of 3s
 * ticks is generous for a worker that claims within seconds, and stopping is
 * safer than an open-ended loop in a tab left open overnight.
 */
const MAX_POLLS = 400;

export interface SubmitCommandResult {
  ok: boolean;
  command: LpCommand | null;
  /** The server refused because of state: already pending, or pool not allowlisted. */
  conflict: string | null;
  error: string | null;
}

export interface UseLpCommandsResult {
  commands: LpCommand[];
  loading: boolean;
  error: string | null;
  /** The backend has no commands/actions routes yet. */
  unavailable: boolean;
  /** The action whose POST is in flight — the request, not the command. */
  submitting: LpCommandAction | null;
  submitError: string | null;
  conflict: string | null;
  /** True while the poll is running because something is unsettled. */
  polling: boolean;
  submit: (tokenId: string, action: LpCommandAction, poolAddress: string) => Promise<SubmitCommandResult>;
  refresh: () => Promise<void>;
  clearSubmitFeedback: () => void;
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

/**
 * @param tokenId Scopes the read to one position. `null` reads every recent
 *   command, which is what the grid needs to mark positions with work in
 *   flight. Both shapes go to the same route; the filter is a query param.
 */
export function useLpCommands(
  tokenId: string | null,
  enabled = true,
  options?: { onSettled?: () => void },
): UseLpCommandsResult {
  const [commands, setCommands] = useState<LpCommand[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [submitting, setSubmitting] = useState<LpCommandAction | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  const requestId = useRef(0);
  const mounted = useRef(true);
  const hadInFlight = useRef(false);
  const onSettled = options?.onSettled;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const id = ++requestId.current;
    setLoading(true);
    try {
      const query = tokenId ? `?tokenId=${encodeURIComponent(tokenId)}` : '';
      const res = await apiFetch(`${API_BASE}/lp/commands${query}`);
      if (id !== requestId.current || !mounted.current) return;

      if (res.status === 404 || res.status === 501) {
        setUnavailable(true);
        setCommands([]);
        setError(null);
        return;
      }

      const body = await readJson(res);
      if (id !== requestId.current || !mounted.current) return;

      if (!res.ok) {
        setError(messageFor(res, body));
        return;
      }

      setUnavailable(false);
      setError(null);
      // Replace rather than merge: this is the server's full recent view, and a
      // merge would resurrect a row the server has since dropped.
      setCommands(parseCommands(body));
    } catch (err) {
      if (id !== requestId.current || !mounted.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load commands');
    } finally {
      if (id === requestId.current && mounted.current) setLoading(false);
    }
  }, [enabled, tokenId]);

  useEffect(() => {
    if (!enabled) {
      setCommands([]);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  // --- Poll while, and only while, something is unsettled --------------------
  const inFlight = enabled && !unavailable && hasCommandInFlight(commands);

  useEffect(() => {
    if (inFlight) {
      hadInFlight.current = true;
      return;
    }
    if (hadInFlight.current) {
      hadInFlight.current = false;
      onSettled?.();
    }
  }, [inFlight, onSettled]);

  useEffect(() => {
    if (!inFlight) return;
    let polls = 0;
    const timer = window.setInterval(() => {
      polls += 1;
      if (polls > MAX_POLLS) {
        window.clearInterval(timer);
        return;
      }
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [inFlight, refresh]);

  const submit = useCallback(
    async (
      targetTokenId: string,
      action: LpCommandAction,
      poolAddress: string,
    ): Promise<SubmitCommandResult> => {
      setSubmitting(action);
      setSubmitError(null);
      setConflict(null);
      try {
        const res = await apiFetch(
          `${API_BASE}/lp/positions/${encodeURIComponent(targetTokenId)}/actions`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, poolAddress }),
          },
        );

        if (res.status === 404 || res.status === 501) {
          const message = 'This backend has no manual-actions API yet.';
          if (mounted.current) {
            setUnavailable(true);
            setSubmitError(message);
          }
          return { ok: false, command: null, conflict: null, error: message };
        }

        const body = await readJson(res);

        if (res.status === 409) {
          const message = messageFor(res, body);
          if (mounted.current) setConflict(message);
          // Something the client believed is stale. Re-read rather than leave
          // the page arguing with the server.
          void refresh();
          return { ok: false, command: null, conflict: message, error: null };
        }

        if (!res.ok) {
          const message = messageFor(res, body);
          if (mounted.current) setSubmitError(message);
          return { ok: false, command: null, conflict: null, error: message };
        }

        const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
        const created = parseCommand(record.command ?? body);

        if (mounted.current) {
          setUnavailable(false);
          // Merge the created row in immediately so the queued state renders on
          // the same tick as the click, without waiting a poll interval to say
          // anything at all.
          if (created) setCommands((prev) => mergeCommands(prev, [created]));
          else void refresh();
        }

        return { ok: true, command: created, conflict: null, error: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to queue the action';
        if (mounted.current) setSubmitError(message);
        return { ok: false, command: null, conflict: null, error: message };
      } finally {
        if (mounted.current) setSubmitting(null);
      }
    },
    [refresh],
  );

  const clearSubmitFeedback = useCallback(() => {
    setSubmitError(null);
    setConflict(null);
  }, []);

  return {
    commands,
    loading,
    error,
    unavailable,
    submitting,
    submitError,
    conflict,
    polling: inFlight,
    submit,
    refresh,
    clearSubmitFeedback,
  };
}

export interface UseLpCommandHistoryResult {
  commands: LpCommandHistoryRow[];
  loading: boolean;
  error: string | null;
  unavailable: boolean;
  polling: boolean;
  refresh: () => Promise<void>;
}

export function useLpCommandHistory(enabled = true): UseLpCommandHistoryResult {
  const [commands, setCommands] = useState<LpCommandHistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const requestId = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const id = ++requestId.current;
    setLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/lp/commands`);
      if (id !== requestId.current || !mounted.current) return;
      if (res.status === 404 || res.status === 501) {
        setUnavailable(true);
        setCommands([]);
        setError(null);
        return;
      }
      const body = await readJson(res);
      if (id !== requestId.current || !mounted.current) return;
      if (!res.ok) {
        setError(messageFor(res, body));
        return;
      }
      setUnavailable(false);
      setError(null);
      setCommands(parseHistoryCommands(body));
    } catch (err) {
      if (id !== requestId.current || !mounted.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load commands');
    } finally {
      if (id === requestId.current && mounted.current) setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setCommands([]);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  const inFlight =
    enabled && !unavailable && commands.some((c) => c.status === 'pending' || c.status === 'claimed');

  useEffect(() => {
    if (!inFlight) return;
    let polls = 0;
    const timer = window.setInterval(() => {
      polls += 1;
      if (polls > MAX_POLLS) {
        window.clearInterval(timer);
        return;
      }
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [inFlight, refresh]);

  return { commands, loading, error, unavailable, polling: inFlight, refresh };
}
