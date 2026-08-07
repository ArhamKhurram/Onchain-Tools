import { useCallback, useEffect, useState } from 'react';
import { sniperJson, sniperPost } from '../lib/sniperApi';
import type { FireResponse, SnipeRule } from '../types/sniper';

/**
 * What the form authors. `state` and `dryRun` are absent BY TYPE, not merely
 * unsent: the API ignores them in a create/patch body, and a draft type that
 * cannot express them means no future edit to the form can start round-tripping
 * a stale `dryRun:false` into a save. Both move only through their own calls.
 */
export type SnipeRuleDraft = Omit<SnipeRule, 'id' | 'userId' | 'state' | 'dryRun'>;

/**
 * Rules plus the four lifecycle acts that are deliberately separate from saving:
 * arm, disarm, go-live, fire. Mutators return the discriminated union rather
 * than throwing because the UI must distinguish 403 `rule_not_armed` from 409
 * `no_credential` from 422 `size_over_trigger_cap`.
 */
export function useSniperRules() {
  const [rules, setRules] = useState<SnipeRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await sniperJson<{ rules: SnipeRule[] }>('/rules');
    if (res.ok) {
      setRules(res.data.rules);
      setError(null);
    } else {
      setError(res.reason);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createRule = useCallback(
    async (draft: SnipeRuleDraft) => {
      // Always lands as state:'draft', dryRun:true — the server forces both.
      const res = await sniperJson<{ rule: SnipeRule }>('/rules', { method: 'POST', body: JSON.stringify(draft) });
      if (res.ok) await refresh();
      return res;
    },
    [refresh],
  );

  const updateRule = useCallback(
    async (id: string, draft: SnipeRuleDraft) => {
      // 409 `rule_armed` when the rule is live: disarm first. Editing caps on an
      // armed rule is deliberately two steps.
      const res = await sniperJson<{ rule: SnipeRule }>(`/rules/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(draft),
      });
      if (res.ok) await refresh();
      return res;
    },
    [refresh],
  );

  const deleteRule = useCallback(
    async (id: string) => {
      const res = await sniperJson<void>(`/rules/${id}`, { method: 'DELETE' });
      if (res.ok) await refresh();
      return res;
    },
    [refresh],
  );

  const armRule = useCallback(
    async (id: string) => {
      // The confirmation word is required by the API, and the UI additionally
      // makes the operator confirm — two independent gates, on purpose.
      const res = await sniperPost<{ rule: SnipeRule }>(`/rules/${id}/arm`, { confirm: 'ARM' });
      if (res.ok) await refresh();
      return res;
    },
    [refresh],
  );

  const disarmRule = useCallback(
    async (id: string) => {
      // Never confirmed. Nothing may stand between an operator and stopping.
      const res = await sniperPost<{ rule: SnipeRule }>(`/rules/${id}/disarm`);
      if (res.ok) await refresh();
      return res;
    },
    [refresh],
  );

  const setDryRun = useCallback(
    async (id: string, dryRun: boolean) => {
      // Going LIVE is its own confirmed call. 409 `process_dry_run` means
      // OCT_SNIPER_DRY_RUN is set and wins regardless — the UI says so rather
      // than pretending the flag took.
      const res = await sniperPost<{ rule: SnipeRule }>(
        `/rules/${id}/dry-run`,
        dryRun ? { dryRun: true } : { dryRun: false, confirm: 'GO_LIVE' },
      );
      if (res.ok) await refresh();
      return res;
    },
    [refresh],
  );

  const fireRule = useCallback(
    async (id: string) => {
      // The ONE live executeFire path in the whole system.
      const res = await sniperPost<FireResponse>(`/rules/${id}/fire`, { confirm: 'FIRE' });
      // A fire can auto-disable the rule (autoDisableAfterFire), so the table
      // must re-read state even when the fire itself aborted.
      await refresh();
      return res;
    },
    [refresh],
  );

  return { rules, loading, error, refresh, createRule, updateRule, deleteRule, armRule, disarmRule, setDryRun, fireRule };
}
