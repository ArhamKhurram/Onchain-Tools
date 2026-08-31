import { Router } from 'express';
import { tryParseTokenEnrichment, buildRickReplyContext, type TokenEnrichment } from '../../utils/rickEmbedParser.js';
import { resolveFallbackTarget, recordFallbackFdv } from '../../utils/dexFallback.js';
import { enrichToken, getTokenSnapshot, persistEnrichment } from '../../utils/tokenSnapshot.js';
import { getPeakDetails, type TokenPeakDetail } from '../../alerts/tokenPeakStore.js';
import { recordScannedContract, scoringExclusions } from '../../callers/callerStatsRecorder.js';
import type { ContractEnrichmentPatch } from '../../utils/contractLog.js';
import type { RouterContext } from '../context.js';
import { getUserId, safeError } from '../shared.js';

// The market fields a fresh TokenEnrichment contributes to both the persisted
// contract patch and the echoed `enrichment` response. `enrichedAt` is stamped
// at build time so each caller records its own fetch moment. The global
// first-call fields are Rick-only, so those callers spread them in on top.
function enrichmentToPatch(e: TokenEnrichment): ContractEnrichmentPatch {
  return {
    tokenName: e.tokenName,
    tokenSymbol: e.tokenSymbol,
    tokenPair: e.tokenPair,
    description: e.description,
    fdvAtCall: e.fdvAtCall,
    fdvAtCallDisplay: e.fdvAtCallDisplay,
    liquidityUsd: e.liquidityUsd,
    liquidityDisplay: e.liquidityDisplay,
    volumeUsd: e.volumeUsd,
    volumeDisplay: e.volumeDisplay,
    priceUsd: e.priceUsd,
    tokenAge: e.tokenAge,
    evmChain: e.evmChain,
    enrichmentSource: e.enrichmentSource,
    enrichedAt: new Date().toISOString(),
  };
}

// Contract logging + enrichment (token snapshot, Rick embeds, DexScreener fallback).
export function createContractsRoutes(ctx: RouterContext): Router {
  const router = Router();
  const { wsServer, storage } = ctx;

  router.get('/tokens/:chain/:address/snapshot', async (req, res) => {
    try {
      const { chain, address } = req.params;
      if (!chain || !address) {
        return res.status(400).json({ error: 'chain and address are required.' });
      }
      const snapshot = await getTokenSnapshot(chain, address);
      if (!snapshot) return res.json({ found: false });

      if (req.userId && (snapshot.symbol || snapshot.name)) {
        try {
          const updated = await storage.enrichContract(req.userId, address, {
            tokenSymbol: snapshot.symbol,
            tokenName: snapshot.name,
            tokenPair: snapshot.pair,
            enrichmentSource: snapshot.source,
            enrichedAt: snapshot.enrichedAt,
            evmChain: snapshot.evmChain,
          });
          if (updated) wsServer.broadcastContractEnrichment(updated, req.userId);
        } catch (err) {
          console.error('[API] snapshot contract patch failed:', (err as Error).message);
        }
      }

      res.json({ found: true, ...snapshot });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to fetch token snapshot') });
    }
  });

  router.get('/contracts', async (req, res) => {
    try {
      const userId = getUserId(req);
      const limit = parseInt(req.query.limit as string) || 100;
      const since = req.query.since as string | undefined;
      const entries = await storage.getContracts(userId, limit, since);
      // Join the global token peaks in at read time (never persisted on the
      // row): the feed shows call MC → peak MC without a second fetch. A peak
      // read failure must never blank the feed — the rows just go out bare.
      const peaks = await getPeakDetails(entries.map((e) => e.address)).catch((err) => {
        console.error('[API] contract peak join failed:', (err as Error).message);
        return new Map<string, TokenPeakDetail>();
      });
      res.json(
        entries.map((e) => {
          const peak = peaks.get(e.address.toLowerCase());
          return peak ? { ...e, peakMc: peak.peakMc, peakAt: peak.peakAt } : e;
        }),
      );
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to fetch contracts') });
    }
  });

  router.post('/contracts', async (req, res) => {
    try {
      const userId = getUserId(req);
      const entry = req.body;
      if (!entry?.address || !entry?.messageId || !entry?.channelId || !entry?.timestamp) {
        return res.status(400).json({ error: 'Invalid contract entry.' });
      }
      const logged = await storage.logContract(userId, entry);
      wsServer.broadcastContract(logged, userId);
      // In hosted mode the Discord gateway runs in the browser, so THIS is the
      // ingest path for most scans — the durable caller record has to be
      // written here too, not only in index.ts. Fire-and-forget: ranking never
      // delays or fails a scan.
      try {
        const config = await storage.getConfig(userId).catch(() => null);
        recordScannedContract(userId, logged, { exclude: scoringExclusions(config) });
      } catch (err) {
        console.error('[API] caller stat write failed:', (err as Error).message);
      }

      const address: string = entry.address;
      const channelId: string = entry.channelId;
      const messageId: string = entry.messageId;
      const evmChain: string | undefined = entry.evmChain;
      setTimeout(async () => {
        try {
          const hit = await resolveFallbackTarget(storage, userId, address, messageId);
          if (!hit) return;
          const enrichment = await enrichToken(address, hit.evmChain ?? evmChain);
          // Report the outcome either way: a fetch that comes back without an
          // MC is what stops the next mention of an unpriceable address
          // re-asking.
          recordFallbackFdv(address, enrichment?.fdvAtCall);
          if (!enrichment) return;
          const updated = await storage.enrichContract(userId, enrichment.address, enrichmentToPatch(enrichment), { channelId, messageId });
          if (updated) {
            wsServer.broadcastContractEnrichment(updated, userId);
            void persistEnrichment(enrichment, enrichment.evmChain ?? hit.evmChain ?? evmChain);
            if (enrichment.evmChain) {
              const chained = await storage.updateEvmChain(userId, enrichment.address, enrichment.evmChain);
              if (chained) wsServer.broadcastChainUpdate(enrichment.address, enrichment.evmChain, userId);
            }
          }
        } catch (err) {
          console.error('[API] Dex fallback failed:', (err as Error).message);
        }
      }, 8_000);

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to log contract') });
    }
  });

  router.post('/contracts/rick-enrich', async (req, res) => {
    try {
      const userId = getUserId(req);
      const { channelId, embeds, content, authorUsername, referencedMessage, timestamp } = req.body ?? {};
      if (!channelId) {
        return res.status(400).json({ error: 'channelId is required.' });
      }

      const rickReply = buildRickReplyContext(referencedMessage, req.body?.messageReference);
      const enrichment = tryParseTokenEnrichment({
        embeds,
        content,
        authorUsername,
        addressOverride: rickReply.addressOverride,
        callerName: rickReply.callerName,
        messageTimestamp: typeof timestamp === 'string' ? timestamp : undefined,
      });
      if (!enrichment?.address) {
        return res.json({ applied: false });
      }

      const updated = await storage.enrichContract(userId, enrichment.address, {
        ...enrichmentToPatch(enrichment),
        firstCallerName: enrichment.firstCallerName,
        firstCallMcapUsd: enrichment.firstCallMcapUsd,
        firstCallAt: enrichment.firstCallAt,
      }, { channelId, messageId: rickReply.messageId });

      if (updated) {
        wsServer.broadcastContractEnrichment(updated, userId);
        void persistEnrichment(enrichment, enrichment.evmChain);
        if (enrichment.evmChain) {
          const chained = await storage.updateEvmChain(userId, enrichment.address, enrichment.evmChain);
          if (chained) wsServer.broadcastChainUpdate(enrichment.address, enrichment.evmChain, userId);
        }
        return res.json({ applied: true, entry: updated });
      }

      res.json({
        applied: true,
        enrichment: {
          address: enrichment.address,
          ...enrichmentToPatch(enrichment),
          firstCallerName: enrichment.firstCallerName,
          firstCallMcapUsd: enrichment.firstCallMcapUsd,
          firstCallAt: enrichment.firstCallAt,
        },
      });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to apply Rick enrichment') });
    }
  });

  router.post('/contracts/dex-enrich', async (req, res) => {
    try {
      const userId = getUserId(req);
      const { address, channelId, messageId } = req.body ?? {};
      if (!address || !channelId) {
        return res.status(400).json({ error: 'address and channelId are required.' });
      }

      const recent = await storage.getContracts(userId, 20);
      const hit = recent.find((c) => {
        if (c.address.toLowerCase() !== String(address).toLowerCase()) return false;
        if (messageId) return c.messageId === messageId;
        return c.channelId === channelId;
      });
      const enrichment = await enrichToken(address, hit?.evmChain);
      if (!enrichment) {
        return res.json({ applied: false });
      }

      const updated = await storage.enrichContract(userId, enrichment.address, enrichmentToPatch(enrichment), { channelId, messageId });

      if (updated) {
        wsServer.broadcastContractEnrichment(updated, userId);
        void persistEnrichment(enrichment, enrichment.evmChain);
        if (enrichment.evmChain) {
          const chained = await storage.updateEvmChain(userId, enrichment.address, enrichment.evmChain);
          if (chained) wsServer.broadcastChainUpdate(enrichment.address, enrichment.evmChain, userId);
        }
        return res.json({ applied: true, entry: updated });
      }

      res.json({
        applied: true,
        enrichment: {
          address: enrichment.address,
          ...enrichmentToPatch(enrichment),
        },
      });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to enrich contract from DexScreener') });
    }
  });

  router.delete('/contracts', async (req, res) => {
    const userId = getUserId(req);
    await storage.deleteAllContracts(userId);
    res.json({ success: true });
  });

  router.delete('/contracts/:messageId/:address', async (req, res) => {
    const userId = getUserId(req);
    const deleted = await storage.deleteContract(userId, req.params.messageId, req.params.address);
    if (!deleted) return res.status(404).json({ error: 'Contract not found' });
    res.json({ success: true });
  });

  return router;
}
