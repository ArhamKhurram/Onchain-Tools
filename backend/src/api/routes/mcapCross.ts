import { Router } from 'express';
import type { RouterContext } from '../context.js';
import { getUserId, safeError } from '../shared.js';
import {
  MCAP_CROSS_FILTER_BOUNDS,
  MCAP_CROSS_FILTER_KEYS,
  applyFilterPatch,
  resolveUserGateConfig,
  sanitizeStoredFilters,
  validateFilterPatch,
  type McapCrossFilterView,
} from '../../mcapCross/filters.js';
import { DEFAULT_GATE_CONFIG, resolveGateConfig, resolveTargetMcapUsd } from '../../mcapCross/gates.js';

/**
 * Per-user market-cap-crossing filters.
 *
 * ON `/api`, NOT `/sniper/v1`. The sniper control plane sits outside `/api`
 * because it SPENDS MONEY and local `/api` is wildcard-CORS with an
 * unauthenticated implicit user. Nothing here spends anything: the worst a
 * local caller can do is change which alerts that same local user sees. So this
 * belongs with the rest of the per-user settings surface, and putting it behind
 * the sniper's auth would be a category error in the other direction.
 *
 * VALIDATION IS THE POINT OF THIS FILE. The thresholds are compared against
 * live security data and a bad one silently changes what a person is warned
 * about, so the boundary REJECTS (400 with a per-field message) rather than
 * clamping. `mcapCrossFilters` is deliberately absent from the `/api/config`
 * PUT whitelist, so this router is the only write path.
 */
export function createMcapCrossRoutes(ctx: RouterContext): Router {
  const router = Router();
  const { storage } = ctx;

  function buildView(stored: ReturnType<typeof sanitizeStoredFilters>): McapCrossFilterView {
    const defaults = resolveGateConfig();
    return {
      filters: stored,
      effective: resolveUserGateConfig(stored, defaults),
      defaults,
      shipped: DEFAULT_GATE_CONFIG,
      targetMcapUsd: resolveTargetMcapUsd(),
    };
  }

  /**
   * The user's overrides plus everything needed to render them honestly: what
   * each field resolves to right now, what it would inherit if cleared, and the
   * global target it cannot change. Bounds ship with the payload so the console
   * cannot drift from the server's idea of a valid range.
   */
  router.get('/mcap-cross/filters', async (req, res) => {
    try {
      const stored = await storage.getMcapCrossFilters(getUserId(req));
      res.json({ ...buildView(sanitizeStoredFilters(stored)), bounds: MCAP_CROSS_FILTER_BOUNDS });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to load alert filters') });
    }
  });

  /**
   * PATCH semantics on a PUT verb, matching the rest of `/api`: an absent key
   * is left alone, an explicit `null` clears the override back to the operator
   * default. There is no way to store "no opinion" as a number, which is what
   * makes the precedence chain observable rather than guessed.
   */
  router.put('/mcap-cross/filters', async (req, res) => {
    try {
      const body = req.body;
      const parsed = validateFilterPatch(body);
      if (!parsed.ok) return res.status(400).json({ error: parsed.errors.join('; ') });

      const userId = getUserId(req);
      const stored = sanitizeStoredFilters(await storage.getMcapCrossFilters(userId));
      const next = applyFilterPatch(stored, body as Record<string, unknown>, parsed.value);
      const saved = await storage.setMcapCrossFilters(userId, next);

      res.json({ ...buildView(saved), bounds: MCAP_CROSS_FILTER_BOUNDS });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to save alert filters') });
    }
  });

  /** Clear every override in one call — back to the operator's baseline. */
  router.delete('/mcap-cross/filters', async (req, res) => {
    try {
      const saved = await storage.setMcapCrossFilters(getUserId(req), {});
      res.json({ ...buildView(saved), bounds: MCAP_CROSS_FILTER_BOUNDS });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to reset alert filters') });
    }
  });

  return router;
}

export { MCAP_CROSS_FILTER_KEYS };
